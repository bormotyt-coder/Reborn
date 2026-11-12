// ═══════════════════════════════════════════════════════════════════════════
// reBorn Workout Engine
// Pure logic (no DOM, no network, no app globals) so it is instant, works
// offline, and can be unit-tested in node. Loaded before app.js; exposes
// `WoEngine` on window (and module.exports under node).
//
// What it does
//   • Exercise library with metadata + mind-muscle-connection cues
//   • Slot-based session templates for the Push / Pull / Arms & Shoulders / Legs
//     rotation, filled by a novelty-weighted selector so variety is ENFORCED in
//     code instead of being requested in a prompt
//   • 16-session training blocks (Volume → Strength → Pump → Deload): rep ranges,
//     sets, rest and intensity techniques change as the block advances
//   • "Anchor" lifts are held for the block (so they can actually progress);
//     accessories rotate every session
//   • Double-progression targets per exercise from logged history
//   • Recovery-aware volume / exercise-selection and a rotating cardio finisher
// ═══════════════════════════════════════════════════════════════════════════
(function (root) {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────────
  const SPLIT_CYCLE = ['Push', 'Pull', 'Arms & Shoulders', 'Legs'];
  const SPLIT_MUSCLES = {
    'Push':             ['Chest', 'Shoulders', 'Triceps'],
    'Pull':             ['Back', 'Biceps', 'Rear Delts'],
    'Arms & Shoulders': ['Shoulders', 'Biceps', 'Triceps'],
    'Legs':             ['Quads', 'Hamstrings', 'Glutes', 'Calves'],
  };
  const SESSIONS_PER_WEEK = 4;           // one lap of the rotation = one "week"
  const BLOCK_SESSIONS = 16;             // four weeks per block

  // Movement patterns → muscle (used for slot filtering, balance and reasons).
  const PAT_MUSCLE = {
    pf: 'Chest', pi: 'Chest', fly: 'Chest', pd: 'Chest',
    vp: 'Back', hr: 'Back', po: 'Back',
    rd: 'Rear Delts',
    ohp: 'Shoulders', lat: 'Shoulders',
    bl: 'Biceps', bs: 'Biceps',
    to: 'Triceps', tp: 'Triceps', tc: 'Triceps',
    sq: 'Quads', lp: 'Quads', lg: 'Quads', le: 'Quads',
    hg: 'Hamstrings', hc: 'Hamstrings',
    gt: 'Glutes', gb: 'Glutes', ga: 'Glutes',
    ca: 'Calves',
    tr: 'Back',
    cx: 'Core', cf: 'Core', cr: 'Core', cl: 'Core',
  };
  const PAT_LABEL = {
    pf: 'flat press', pi: 'incline press', fly: 'chest fly', pd: 'dip',
    vp: 'vertical pull', hr: 'row', po: 'lat isolation',
    rd: 'rear-delt', ohp: 'overhead press', lat: 'lateral raise',
    bl: 'lengthened curl', bs: 'curl', to: 'overhead triceps', tp: 'pushdown', tc: 'triceps press',
    tr: 'trap', sq: 'squat', lp: 'leg press', lg: 'single-leg', le: 'quad isolation',
    hg: 'hinge', hc: 'leg curl', gt: 'hip thrust', gb: 'glute hinge', ga: 'abduction', ca: 'calf',
    cx: 'anti-extension', cf: 'flexion', cr: 'anti-rotation', cl: 'lateral core',
  };

  // ── Exercise library ─────────────────────────────────────────────────────
  // [name, pattern, role(c=compound|i=isolation), equip, systemic-cost(1-3),
  //  lengthened(0|1), cue, extras]
  // Names are chosen so app.js's keyword→icon map resolves to the right art.
  const RAW = [
    // ── Chest ──
    ['Barbell Bench Press', 'pf', 'c', 'bb', 3, 0, 'Pull your shoulder blades together and drive them into the bench, touch low on the chest, then press yourself away from the bar — the pecs, not the front delts, should take the load.'],
    ['Dumbbell Bench Press', 'pf', 'c', 'db', 2, 1, 'Sink the dumbbells until you feel a deep stretch across the pecs, then drive your elbows toward each other as if closing a book.'],
    ['Smith Flat Bench Press', 'pf', 'c', 'smith', 2, 0, 'The fixed path lets you chase failure safely — shoulder blades pinned, lower to the lower chest and squeeze the pecs to press.'],
    ['Machine Chest Press', 'pf', 'c', 'mach', 1, 0, 'Handles at mid-chest height, shoulder blades pinned to the pad — squeeze your pecs together to push and don\'t let the shoulders roll forward.'],
    ['Incline Barbell Bench Press', 'pi', 'c', 'bb', 3, 0, 'Bar to the upper chest with vertical forearms; think about pushing your biceps toward each other to keep tension on the upper pecs.'],
    ['Incline Dumbbell Press', 'pi', 'c', 'db', 2, 1, 'Feel the stretch across the upper chest at the bottom, then drive up and slightly in, squeezing the upper pecs together at the top.'],
    ['Smith Incline Press', 'pi', 'c', 'smith', 2, 0, 'Pin your shoulder blades back and push through the upper chest — the guided bar lets you train to true failure.'],
    ['Machine Incline Press', 'pi', 'c', 'mach', 1, 0, 'Elbows slightly tucked, press up and in — feel the top of your chest shorten as the handles meet.'],
    ['Chest Dip (Lean Forward)', 'pd', 'c', 'bw', 2, 1, 'Lean your torso forward and flare the elbows slightly — sink until the pecs are stretched, then drive down and squeeze the chest to rise.', { bw: 1 }],
    ['Low-to-High Cable Fly', 'fly', 'i', 'cable', 1, 1, 'Pulleys low, sweep your hands up toward your face — feel the stretch across the pecs at the bottom, then squeeze like you\'re hugging a barrel.'],
    ['High-to-Low Cable Fly', 'fly', 'i', 'cable', 1, 0, 'Soft elbows, sweep down and across to your hips — squeeze the lower chest fibres together at the bottom.'],
    ['Pec Deck Fly', 'fly', 'i', 'mach', 1, 1, 'Sit tall with your chest proud and lead with your elbows, not your hands — feel the pecs squeeze together at the midline.'],
    ['Svend Press', 'fly', 'i', 'other', 1, 0, 'Squeeze the plates together as hard as you can through the whole rep — that constant tension lights up the inner chest.'],
    ['Decline Barbell Bench Press', 'pf', 'c', 'bb', 3, 0, 'Set a slight decline and touch the bar to your lower chest — shoulder blades pinned, squeeze the lower pecs to drive it up. The shorter range lets you load it heavy.'],
    ['Decline Dumbbell Press', 'pf', 'c', 'db', 2, 0, 'Lower the dumbbells beside your lower chest with elbows at about 45° and press up and in — feel the lower pecs shorten at the top.'],
    ['Dumbbell Floor Press', 'pf', 'c', 'db', 2, 0, 'Lower until your triceps touch the floor, pause for a beat, then press — the dead stop keeps the pecs and triceps honest and the shoulders safe.'],
    ['Standing Cable Chest Press', 'pf', 'c', 'cable', 1, 0, 'Stagger your stance and press forward and slightly in — the cable never lets up, so squeeze the pecs together at lockout.'],
    ['Plate-Loaded Chest Press', 'pf', 'c', 'mach', 1, 1, 'Set the handles low enough for a deep pec stretch, then drive through the chest — independent arms let you chase failure safely.'],
    ['Deficit Push-Up', 'pf', 'c', 'bw', 1, 1, 'Hands on plates or handles so your chest drops below them — control the deep stretch, then push the floor away and squeeze the pecs.', { bw: 1 }],
    ['Reverse-Grip Bench Press', 'pi', 'c', 'bb', 3, 0, 'Underhand grip with elbows tucked — lower to the lower chest and press up and back, feeling the upper pecs (and biceps) share the load.'],
    ['Seated Cable Fly', 'fly', 'i', 'cable', 1, 1, 'Chest tall against the pad with soft elbows — take a wide arc until the pecs are stretched, then bring the handles together in front of your sternum.'],
    ['Incline Dumbbell Fly', 'fly', 'i', 'db', 1, 1, 'Soft elbows and a wide arc — lower until the upper pecs are stretched, then hug the dumbbells up and stop where the tension fades.'],
    ['Dumbbell Fly', 'fly', 'i', 'db', 1, 1, 'Think of hugging a barrel: open until you feel a deep chest stretch (not a shoulder strain), then squeeze the pecs to sweep the dumbbells together.'],

    // ── Back ──
    ['Pull-Up', 'vp', 'c', 'bw', 2, 1, 'Think elbows to back pockets — drive your chest to the bar and feel your lats, not your biceps, doing the pulling.', { bw: 1 }],
    ['Chin-Up', 'vp', 'c', 'bw', 2, 1, 'Lead with the chest and pull your elbows down to your ribs — lats and biceps share the load; control the descent into a full hang.', { bw: 1 }],
    ['Wide-Grip Lat Pulldown', 'vp', 'c', 'cable', 1, 1, 'Lean back slightly and drive your elbows down into your back pockets — feel the lats spreading wide like wings.'],
    ['Neutral-Grip Pulldown', 'vp', 'c', 'cable', 1, 1, 'Pull the handles toward your upper chest with elbows tight to your sides — stretch fully at the top and squeeze the lats at the bottom.'],
    ['Single-Arm Lat Pulldown', 'vp', 'c', 'cable', 1, 1, 'Reach long at the top to stretch the lat, then drive your elbow into your hip — feel one side of your back at a time.'],
    ['Barbell Bent-Over Row', 'hr', 'c', 'bb', 3, 0, 'Hinge to a flat back, then drive your elbows toward your hips — feel the lats and mid-back pull the bar to your lower ribs.'],
    ['Chest-Supported T-Bar Row', 'hr', 'c', 'mach', 2, 0, 'Chest glued to the pad so only your back can work — pull your elbows back and squeeze the shoulder blades together.'],
    ['Seated Cable Row', 'hr', 'c', 'cable', 1, 1, 'Start by pulling your shoulder blades together, then drive your elbows back — mid-back and rhomboids should fire before your arms bend.'],
    ['Single-Arm Dumbbell Row', 'hr', 'c', 'db', 2, 1, 'Let the lat stretch at the bottom, then drive your elbow to your hip — pull with the elbow, not the hand.'],
    ['Meadows Row', 'hr', 'c', 'bb', 2, 1, 'Stagger your stance and row the bar\'s end to your hip — feel the deep lat stretch at the bottom and the contraction at the top.'],
    ['Plate-Loaded Machine Row', 'hr', 'c', 'mach', 1, 0, 'Chest on the pad, pull your elbows behind your torso — squeeze your shoulder blades together at the end of every rep.'],
    ['Chest-Supported Dumbbell Row', 'hr', 'c', 'db', 1, 0, 'Lie chest-down on an incline bench so momentum is impossible — row your elbows toward the ceiling and pinch the shoulder blades.'],
    ['Cable Pullover (Straight-Arm)', 'po', 'i', 'cable', 1, 1, 'Arms nearly straight, sweep the bar to your thighs — feel your lats stretch overhead and squeeze down through the armpits.'],
    ['Dumbbell Pullover', 'po', 'i', 'db', 1, 1, 'Lie across a bench and lower the dumbbell behind your head with soft elbows — feel the lats stretch, then pull it back over your chest.'],
    ['Kneeling Cable Lat Prayer', 'po', 'i', 'cable', 1, 1, 'Hinge forward with straight arms and sweep the rope to your thighs — keep the ribs down and feel the lats, not the triceps.'],
    ['Underhand Lat Pulldown', 'vp', 'c', 'cable', 1, 1, 'Shoulder-width underhand grip — lean back slightly and pull your elbows down into your hips, feeling the lower lats and biceps squeeze.'],
    ['Close-Grip V-Bar Pulldown', 'vp', 'c', 'cable', 1, 1, 'Stretch fully overhead, then drive the elbows down and back past your ribs — squeeze the lats like you are pulling them into your back pockets.'],
    ['Neutral-Grip Pull-Up', 'vp', 'c', 'bw', 2, 1, 'Palms facing each other — pull your elbows to your ribs and your chest up to the handles, feeling the lats work through a full hang.', { bw: 1 }],
    ['Wide-Grip Pull-Up', 'vp', 'c', 'bw', 2, 1, 'Hands just outside shoulder width — start by pulling the shoulder blades down, then drive the elbows down and in so the lats, not the arms, do the work.', { bw: 1 }],
    ['Plate-Loaded Pulldown Machine', 'vp', 'c', 'mach', 1, 1, 'Independent arms let each lat work separately — reach long for the stretch and drive both elbows down toward your hips.'],
    ['Pendlay Row', 'hr', 'c', 'bb', 3, 0, 'The bar starts dead on the floor every rep with a flat back — explode it to your lower chest and feel the lats and upper back fire together.'],
    ['Underhand Barbell Row', 'hr', 'c', 'bb', 3, 0, 'Underhand grip and a flat back — pull the bar to your belly button and drive the elbows past your torso to hit the lower lats.'],
    ['Seal Row', 'hr', 'c', 'bb', 2, 1, 'Lie flat on a high bench so momentum is impossible — let the lats stretch at the bottom, then row to your ribs and squeeze the shoulder blades.'],
    ['Iso-Lateral High Row', 'hr', 'c', 'mach', 1, 1, 'Chest on the pad, reach forward for the lat stretch, then pull each elbow down and back — feel the upper back and lats, not the biceps.'],
    ['Wide-Grip Seated Cable Row', 'hr', 'c', 'cable', 1, 0, 'Pull the bar to your upper abdomen with the elbows flared — feel the rear delts and mid-traps squeeze your shoulder blades together.'],
    ['Single-Arm Cable Row', 'hr', 'c', 'cable', 1, 1, 'Rotate slightly as you reach for a deep lat stretch, then drive your elbow to your hip — the cable keeps tension for the whole rep.'],
    ['Machine Chest-Supported Row', 'hr', 'c', 'mach', 1, 0, 'Pad against your chest so only the back can work — pull your elbows behind you and hold the squeeze for a beat.'],
    ['Standing T-Bar Row', 'hr', 'c', 'bb', 3, 0, 'Hinge with a flat back and a neutral grip — row the handle to your lower chest and drive the elbows back to thicken the lats and mid-back.'],
    ['Rack Pull', 'hr', 'c', 'bb', 3, 0, 'Bar at knee height, chest proud and lats tight — drive your hips through and shrug at the top, feeling the upper back and traps lock it out.'],
    ['Inverted Row', 'hr', 'c', 'bw', 1, 0, 'Body rigid under a bar — pull your chest to it and squeeze the shoulder blades together; walk your feet forward to make it harder.', { bw: 1 }],
    ['Barbell Shrug', 'tr', 'i', 'bb', 1, 0, 'Straight up and down — no rolling — and hold the top for a second; feel the upper traps squeeze toward your ears.'],
    ['Dumbbell Shrug', 'tr', 'i', 'db', 1, 0, 'Arms heavy at your sides, shrug straight up and pause — think about touching your shoulders to your ears while keeping your neck long.'],
    ['Cable Shrug', 'tr', 'i', 'cable', 1, 1, 'Low pulleys keep constant tension — let the traps stretch down, then shrug up and slightly back and squeeze at the top.'],
    ['Prone Y-Raise', 'tr', 'i', 'db', 1, 1, 'Chest on an incline bench, thumbs up, raise the arms into a Y — feel the lower traps between your shoulder blades pull the arms up.'],

    // ── Rear delts ──
    ['Reverse Pec Deck', 'rd', 'i', 'mach', 1, 0, 'Lead with your elbows and think about pushing your hands apart — feel the back of your shoulders, not your traps, doing the work.'],
    ['Face Pull (Rope)', 'rd', 'i', 'cable', 1, 0, 'Pull the rope toward your forehead and rotate your thumbs behind you — rear delts and external rotators should burn.'],
    ['Cable Rear Delt Fly', 'rd', 'i', 'cable', 1, 1, 'Cross the cables and sweep out wide with soft elbows — feel the rear delts stretch across your body, then squeeze.'],
    ['Incline Bench Rear Delt Raise', 'rd', 'i', 'db', 1, 1, 'Chest on the incline bench, pinkies up — raise out to the sides and feel the back of the shoulder, not the upper back.'],
    ['Seated Dumbbell Rear Delt Raise', 'rd', 'i', 'db', 1, 0, 'Fold forward over your thighs and raise the dumbbells wide with the elbows leading — feel the back of the shoulder, not the traps.'],
    ['Bent-Over Dumbbell Rear Delt Fly', 'rd', 'i', 'db', 1, 0, 'Hinge to flat with the arms hanging, then sweep the dumbbells out wide — lead with the elbows and pinch the rear delts at the top.'],
    ['Prone Incline Dumbbell Rear Delt Row', 'rd', 'i', 'db', 1, 1, 'Chest on a 45° bench, row the dumbbells with the elbows flared wide — the rear delts and mid-back do the work.'],
    ['Band Pull-Apart', 'rd', 'i', 'other', 1, 0, 'Arms straight, pull the band apart to your chest and squeeze the shoulder blades — slow on the return and keep your ribs down.'],

    // ── Shoulders ──
    ['Barbell Overhead Press', 'ohp', 'c', 'bb', 3, 0, 'Squeeze your glutes and brace your abs, press straight up and shrug at lockout — front and side delts drive the bar.'],
    ['Seated Dumbbell Shoulder Press', 'ohp', 'c', 'db', 2, 1, 'Lower until the dumbbells are at ear level and feel the delts stretch, then press up and slightly in.'],
    ['Machine Shoulder Press', 'ohp', 'c', 'mach', 1, 0, 'Back flat against the pad, press through your delts and stop just short of lockout to keep tension on the muscle.'],
    ['Smith Machine Overhead Press', 'ohp', 'c', 'smith', 2, 0, 'Sit tall with the bar path just in front of your face — press through the delts and keep your ribs down.'],
    ['Arnold Press', 'ohp', 'c', 'db', 2, 1, 'Rotate your palms as you press — feel all three heads of the delt work through the full arc.'],
    ['Dumbbell Lateral Raise', 'lat', 'i', 'db', 1, 0, 'Lead with your elbows and think about pouring water from a jug at the top — feel the side delts burn, not the traps.'],
    ['Cable Lateral Raise', 'lat', 'i', 'cable', 1, 1, 'The cable keeps tension at the bottom — raise your elbow out to the side and feel the side delt stretch and contract through the whole range.'],
    ['Lean-Away Cable Lateral Raise', 'lat', 'i', 'cable', 1, 1, 'Hold the upright and lean away — the longer lever loads the side delt in its most stretched position.'],
    ['Machine Lateral Raise', 'lat', 'i', 'mach', 1, 0, 'Push with your elbows against the pads, shoulders down away from your ears — the side delts do all the lifting.'],
    ['Cable Y-Raise', 'lat', 'i', 'cable', 1, 1, 'Raise your arms into a Y — thumbs up, shoulder blades down — and feel the delts and lower traps working together.'],
    ['Seated Barbell Overhead Press', 'ohp', 'c', 'bb', 3, 0, 'Back supported and abs braced — press the bar in a straight line overhead and feel the delts drive it to lockout.'],
    ['Standing Dumbbell Shoulder Press', 'ohp', 'c', 'db', 2, 0, 'Dumbbells at ear height with your ribs down — press up and slightly together, squeezing the delts at lockout.'],
    ['Single-Arm Dumbbell Shoulder Press', 'ohp', 'c', 'db', 2, 0, 'One arm at a time lets you brace harder — press straight up and feel the delt on that side drive it.'],
    ['Plate-Loaded Shoulder Press', 'ohp', 'c', 'mach', 1, 0, 'Independent arms on a fixed path — press up and slightly in, stopping just short of lockout so the delts never rest.'],
    ['Half-Kneeling Landmine Press', 'ohp', 'c', 'other', 2, 0, 'Brace tall on one knee and press the bar up and forward along its arc — feel the front delt and serratus drive it without shoulder pinch.'],
    ['Seated Dumbbell Lateral Raise', 'lat', 'i', 'db', 1, 0, 'Seated to remove swing — raise your elbows out to the side until the arms are parallel and feel the side delts burn.'],
    ['Bent-Arm Lateral Raise', 'lat', 'i', 'db', 1, 0, 'Elbows bent about 90° — lead with the elbows to shoulder height; the shorter lever makes the side delts fire harder.'],
    ['Prone Incline Lateral Raise', 'lat', 'i', 'db', 1, 1, 'Chest on an incline bench, raise the arms out to the side — the delts work at their stretched position with no momentum to cheat with.'],
    ['Single-Arm Cable Lateral Raise (Behind the Back)', 'lat', 'i', 'cable', 1, 1, 'Start with the cable crossing behind your body for a deep stretch — raise your elbow out and up and feel the side delt from stretch to squeeze.'],

    // ── Biceps ──
    ['Incline Dumbbell Curl', 'bl', 'i', 'db', 1, 1, 'Let your arms hang behind your torso for a deep biceps stretch, then curl without swinging and squeeze the peak hard.'],
    ['Bayesian Cable Curl', 'bl', 'i', 'cable', 1, 1, 'Face away from the cable with your arm behind you — the long-head stretch is intense, so curl up and squeeze.'],
    ['EZ-Bar Preacher Curl', 'bl', 'i', 'bb', 1, 1, 'Arms flat on the pad, lower until the biceps are fully stretched, then curl without letting the elbows lift.'],
    ['Incline Hammer Curl', 'bl', 'i', 'db', 1, 1, 'Arms hanging behind the torso on an incline bench, neutral grip — feel the long head and brachialis stretch, then curl without swinging.'],
    ['Lying Cable Curl', 'bl', 'i', 'cable', 1, 1, 'Lie back with the cable pulling from behind your head — the biceps are stretched under load; curl up and squeeze.'],
    ['Spider Curl', 'bs', 'i', 'db', 1, 0, 'Chest on the incline bench with arms dangling — the biceps are fully shortened at the top, so hold the squeeze for a beat.'],
    ['Machine Preacher Curl', 'bs', 'i', 'mach', 1, 0, 'Armpits snug on the pad — curl up and squeeze, then lower under control without dropping into the bottom.'],
    ['EZ-Bar Curl', 'bs', 'i', 'bb', 1, 0, 'Elbows pinned to your sides, curl and squeeze at the top — control the negative for a full two seconds.'],
    ['Hammer Curl', 'bs', 'i', 'db', 1, 0, 'Neutral grip, curl slightly across the body — feel the brachialis and outer biceps work while the elbows stay still.'],
    ['Cable Hammer Curl (Rope)', 'bs', 'i', 'cable', 1, 0, 'Constant cable tension — keep elbows pinned and pull the rope apart at the top.'],
    ['Cable Curl (Straight Bar)', 'bs', 'i', 'cable', 1, 0, 'Curl up, squeeze for a beat, and lower slowly without ever letting the cable go slack.'],
    ['Standing Alternating Dumbbell Curl', 'bs', 'i', 'db', 1, 0, 'Turn your palm up as you curl and squeeze the biceps at the top — elbow pinned, lowering slowly so every rep is strict.'],
    ['Barbell Curl (Straight Bar)', 'bs', 'i', 'bb', 1, 0, 'Elbows pinned just ahead of your ribs — curl without swinging, squeeze for a beat at the top and lower for two seconds.'],
    ['Cross-Body Hammer Curl', 'bs', 'i', 'db', 1, 0, 'Curl the dumbbell across your chest toward the opposite shoulder — feel the brachialis and outer biceps work.'],
    ['Zottman Curl', 'bs', 'i', 'db', 1, 0, 'Curl up with palms up, rotate to palms down and lower slowly — the biceps lift it and the forearms control the way down.'],
    ['Concentration Curl', 'bs', 'i', 'db', 1, 0, 'Elbow braced against your inner thigh — curl and twist your pinky up at the top for a hard peak squeeze.'],
    ['Reverse Curl (EZ-Bar)', 'bs', 'i', 'bb', 1, 0, 'Overhand grip with the elbows pinned — curl and feel the forearms and brachialis (the muscle that adds arm thickness) work.'],
    ['Drag Curl', 'bs', 'i', 'bb', 1, 0, 'Drag the bar up your torso with the elbows travelling back — it takes the shoulders out and keeps the biceps loaded.'],
    ['Double-Biceps Cable Curl', 'bs', 'i', 'cable', 1, 0, 'Arms out to the sides like a double-biceps pose — curl the handles toward your head and squeeze hard at the peak.'],
    ['Single-Arm Dumbbell Preacher Curl', 'bl', 'i', 'db', 1, 1, 'Upper arm flat on the pad — lower until the biceps are fully stretched, then curl without letting the elbow lift.'],

    // ── Triceps ──
    ['Overhead Cable Triceps Extension', 'to', 'i', 'cable', 1, 1, 'Set the pulley LOW (it grows more triceps than a high pulley) — elbows by your ears, let the rope stretch the long head behind you, then extend fully and squeeze.'],
    ['Overhead Dumbbell Triceps Extension', 'to', 'i', 'db', 1, 1, 'Lower the dumbbell deep behind your head until the triceps are stretched, then extend without flaring the elbows.'],
    ['EZ-Bar Skullcrusher', 'to', 'i', 'bb', 1, 1, 'Lower toward your forehead or just behind it for extra stretch — elbows fixed, extend by squeezing the triceps.'],
    ['Dumbbell Skullcrusher', 'to', 'i', 'db', 1, 1, 'Lower the dumbbells beside your head with elbows fixed — feel the long head stretch, then extend and squeeze.'],
    ['Single-Arm Overhead Cable Triceps Extension', 'to', 'i', 'cable', 1, 1, 'One arm at a time, elbow by your ear — get a deep stretch behind your head, then extend and squeeze.'],
    ['Rope Pushdown', 'tp', 'i', 'cable', 1, 0, 'Elbows pinned to your ribs — pull the rope apart at the bottom and squeeze the triceps hard.'],
    ['Straight-Bar Pushdown', 'tp', 'i', 'cable', 1, 0, 'Keep your elbows glued to your sides and drive the bar down with your triceps until your arms lock out.'],
    ['Cross-Body Cable Pushdown', 'tp', 'i', 'cable', 1, 0, 'Single-arm, pushing down and across your body — the angle keeps the lateral head under constant tension.'],
    ['V-Bar Pushdown', 'tp', 'i', 'cable', 1, 0, 'Elbows pinned, push down and slightly out — squeeze the triceps hard at lockout.'],
    ['Single-Arm Cable Pushdown', 'tp', 'i', 'cable', 1, 0, 'Pin the elbow to your side and drive the handle down — feel one triceps working at a time.'],
    ['JM Press', 'tc', 'c', 'bb', 2, 1, 'Lower the bar toward your chin with elbows tucked — half bench, half skullcrusher: the triceps load, not the shoulders.'],
    ['Close-Grip Bench Press', 'tc', 'c', 'bb', 3, 0, 'Hands just inside shoulder width, elbows tucked — press by squeezing the triceps, not by flaring.'],
    ['Tricep Dip (Upright)', 'tc', 'c', 'bw', 2, 1, 'Stay upright with elbows back and in — drive up by locking out the triceps and squeezing at the top.', { bw: 1 }],
    ['Machine Triceps Dip', 'tc', 'c', 'mach', 1, 0, 'Elbows tucked, press down through your triceps and fully lock out — squeeze at the bottom of every rep.'],
    ['Overhead EZ-Bar Triceps Extension', 'to', 'i', 'bb', 1, 1, 'Elbows pointing up and in — lower the bar behind your head until the long head is stretched, then extend without letting the elbows flare.'],
    ['Cable Skullcrusher', 'to', 'i', 'cable', 1, 1, 'Lie back with the cable pulling over your head — lower toward your forehead, feel the long-head stretch and extend with the triceps.'],
    ['Seated Triceps Extension Machine', 'tp', 'i', 'mach', 1, 0, 'Elbows tucked on the pads — extend fully and squeeze the triceps hard at lockout, then control the return.'],
    ['Reverse-Grip Pushdown', 'tp', 'i', 'cable', 1, 0, 'Underhand grip with the elbows pinned — push down and feel the medial head squeeze as you lock out.'],
    ['Cable Triceps Kickback', 'tp', 'i', 'cable', 1, 0, 'Hinge forward with the elbow pinned high — extend fully and squeeze; the cable keeps tension where dumbbells fade.'],
    ['Dumbbell Triceps Kickback', 'tp', 'i', 'db', 1, 0, 'Upper arm parallel to the floor and still — extend and squeeze the triceps at the top without swinging.'],
    ['Diamond Push-Up', 'tc', 'c', 'bw', 1, 0, 'Hands close under your chest with the elbows tracking back — press up by squeezing the triceps and finish with a full lockout.', { bw: 1 }],
    ['Smith Close-Grip Bench Press', 'tc', 'c', 'smith', 2, 0, 'Hands just inside shoulder width and elbows tucked — the fixed bar lets you grind the triceps to failure safely.'],
    ['Bench Dip', 'tc', 'c', 'bw', 1, 0, 'Hips close to the bench and elbows pointing back — lower only as far as your shoulders are comfortable and press up through the triceps.', { bw: 1 }],

    // ── Quads ──
    ['Barbell Back Squat', 'sq', 'c', 'bb', 3, 0, 'Push the floor away and drive through your whole foot — feel your quads and glutes power you out of the hole.'],
    ['Front Squat', 'sq', 'c', 'bb', 3, 1, 'Elbows high and chest tall — the upright torso forces your quads to do the work out of the hole.'],
    ['Hack Squat Machine', 'sq', 'c', 'mach', 2, 1, 'Feet low on the platform, sink deep until the quads stretch, then drive up through the whole foot.'],
    ['Smith Machine Squat (Heels Elevated)', 'sq', 'c', 'smith', 2, 1, 'Feet slightly forward and heels on plates — sit straight down and feel your quads load through a deep range.'],
    ['Heel-Elevated Goblet Squat', 'sq', 'c', 'db', 1, 1, 'Elbows between your knees, sit straight down with heels raised — feel the quads stretch and then drive you back up.'],
    ['Leg Press', 'lp', 'c', 'mach', 1, 1, 'Feet low and shoulder-width, lower until your knees are deep and drive through the whole foot — quads, not lower back.'],
    ['Wide-Stance Leg Press', 'lp', 'c', 'mach', 1, 1, 'Feet high and wide, toes out — push the platform away through your heels and feel the glutes and inner thighs stretch and fire.'],
    ['Bulgarian Split Squat', 'lg', 'c', 'db', 2, 1, 'Torso slightly forward with the front foot flat — sink until the front quad and glute are stretched, then drive through the front heel.'],
    ['Walking Lunge', 'lg', 'c', 'db', 2, 0, 'Long stride, torso upright, push through the front heel — the front quad and glute do the work.'],
    ['Reverse Lunge', 'lg', 'c', 'db', 2, 0, 'Step back and keep your weight on the front heel — feel the front quad and glute drive you back up.'],
    ['Forward-Lean Step-Up', 'lg', 'c', 'db', 2, 0, 'Whole foot on the box and a slight forward lean — drive through the heel and don\'t push off the back leg.'],
    ['Leg Extension', 'le', 'i', 'mach', 1, 1, 'Squeeze your quads at the top for a full second, then lower slowly and feel the stretch at the bottom.'],
    ['Single-Leg Extension', 'le', 'i', 'mach', 1, 1, 'One leg at a time — squeeze the quad at the top for a full second and lower slowly into the stretch.'],
    ['Pendulum Squat', 'sq', 'c', 'mach', 2, 1, 'The arc lets you sink deep with constant quad tension — drive through your whole foot and feel the quads stretch at the bottom.'],
    ['Belt Squat', 'sq', 'c', 'mach', 1, 1, 'The load hangs from your hips so your spine is free — sit deep with an upright torso and feel only quads and glutes working.'],
    ['V-Squat Machine', 'sq', 'c', 'mach', 2, 1, 'Back against the pad, feet shoulder-width — lower to a deep knee bend and drive up through the mid-foot, feeling the quads work.'],
    ['Goblet Squat', 'sq', 'c', 'db', 1, 1, 'Hold the weight at your chest with the elbows inside your knees — sit between your legs and feel the quads drive you up tall.'],
    ['Narrow-Stance Leg Press', 'lp', 'c', 'mach', 1, 1, 'Feet low and close — lower until the knees are deeply bent and drive through the whole foot, feeling the outer quads.'],
    ['Single-Leg Leg Press', 'lp', 'c', 'mach', 1, 1, 'One leg at a time to expose imbalances — lower deep under control and drive through the mid-foot without letting the hips rotate.'],
    ['Deficit Reverse Lunge', 'lg', 'c', 'db', 2, 1, 'Front foot on a small step so the knee travels deeper — feel the front quad and glute stretch, then drive through the front heel.'],
    ['Curtsy Lunge', 'lg', 'c', 'db', 2, 0, 'Step back and across behind you with the weight on the front heel — the glute and outer quad of the front leg drive you up.'],
    ['Static Dumbbell Split Squat', 'lg', 'c', 'db', 2, 1, 'Stay in a staggered stance and lower straight down — feel the front quad and glute stretch and fire with no hopping.'],
    ['Smith Machine Split Squat', 'lg', 'c', 'smith', 2, 1, 'The fixed path takes balance out of it — sink until the front thigh is parallel and drive through the front heel.'],
    ['Lateral Lunge', 'lg', 'c', 'db', 2, 0, 'Step wide and sit back into one hip — feel the glute and adductor stretch, then drive back to standing through the heel.'],
    ['Reverse Nordic Curl', 'le', 'i', 'bw', 2, 1, 'Kneel and lean back with a straight line from knee to shoulder — feel the quads stretch hard under your body weight, then pull back up.', { bw: 1 }],

    // ── Hamstrings ──
    ['Barbell Romanian Deadlift', 'hg', 'c', 'bb', 2, 1, 'Push your hips back until you feel a deep hamstring stretch, then drive them forward — keep the bar dragging against your thighs.'],
    ['Dumbbell Romanian Deadlift', 'hg', 'c', 'db', 2, 1, 'Soft knees, hips back, dumbbells sliding down your legs — stop where the hamstrings are fully stretched, then squeeze the glutes up.'],
    ['Single-Leg Romanian Deadlift', 'hg', 'c', 'db', 2, 1, 'Hinge on one leg and reach long — feel the standing hamstring stretch, then squeeze the glute to stand tall.'],
    ['Smith Machine RDL', 'hg', 'c', 'smith', 2, 1, 'Hips back with the bar close to your legs — feel the hamstrings load at the bottom and squeeze the glutes to lock out.'],
    ['Conventional Deadlift', 'hg', 'c', 'bb', 3, 0, 'Push the floor away, keep the bar against your legs and drive your hips through — hamstrings and glutes lock it out.'],
    ['Sumo Deadlift', 'hg', 'c', 'bb', 3, 0, 'Spread the floor with your feet and keep your chest up — drive your knees out and squeeze the glutes at lockout.'],
    ['Seated Leg Curl', 'hc', 'i', 'mach', 1, 1, 'Hips pinned in the most lengthened position — curl by squeezing the hamstrings and control the stretch back.'],
    ['Lying Leg Curl', 'hc', 'i', 'mach', 1, 0, 'Hips down on the pad, curl toward your glutes — squeeze at the top and lower slowly.'],
    ['Single-Leg Seated Leg Curl', 'hc', 'i', 'mach', 1, 1, 'One leg at a time in the lengthened position — curl by squeezing the hamstring and take three seconds to return.'],
    ['Single-Leg Lying Leg Curl', 'hc', 'i', 'mach', 1, 0, 'Hips glued to the pad, curl one leg toward your glute — squeeze at the top and lower slowly.'],
    ['Stiff-Leg Deadlift', 'hg', 'c', 'bb', 2, 1, 'Legs nearly straight with the hips back — feel the whole hamstring stretch as the bar slides down your legs, then drive the hips forward.'],
    ['Good Morning', 'hg', 'c', 'bb', 3, 1, 'Bar on your back with soft knees — hinge until the hamstrings are taut and your back is flat, then squeeze the glutes to stand tall.'],
    ['B-Stance Romanian Deadlift', 'hg', 'c', 'db', 2, 1, 'Back foot as a kickstand with most weight on the front leg — hinge until the front hamstring is stretched, then squeeze the glute to stand.'],
    ['Trap Bar Deadlift', 'hg', 'c', 'bb', 3, 0, 'Chest up, push the floor away with an upright torso — drive the hips through and feel the quads, glutes and hamstrings lock it out together.'],
    ['Nordic Hamstring Curl', 'hc', 'i', 'bw', 2, 1, 'Kneel with your ankles anchored and lower your torso as slowly as you can — resist with the hamstrings, then push off the floor to come back up.', { bw: 1 }],
    ['Glute-Ham Raise', 'hc', 'i', 'mach', 2, 1, 'Hips locked at the pad, lower with a straight spine until the hamstrings are stretched — curl back up with hamstrings and glutes.', { bw: 1 }],
    ['Standing Single-Leg Curl', 'hc', 'i', 'mach', 1, 0, 'Hips pressed into the pad, curl the heel to your glute and squeeze — take two seconds to lower.'],
    ['Slider Leg Curl', 'hc', 'i', 'bw', 1, 0, 'Bridge up, slide your heels out slowly and curl back in — the hamstrings control the stretch and squeeze at the top.', { bw: 1 }],
    ['Stability Ball Leg Curl', 'hc', 'i', 'bw', 1, 0, 'Hips high in a bridge, roll the ball out and back — keep the hips up so the hamstrings and glutes stay loaded.', { bw: 1 }],

    // ── Glutes ──
    ['Barbell Hip Thrust', 'gt', 'c', 'bb', 2, 0, 'Chin tucked, ribs down — drive through your heels and squeeze your glutes hard at the top for a full second.'],
    ['Smith Machine Hip Thrust', 'gt', 'c', 'smith', 2, 0, 'Feet flat and shins vertical at the top — drive the hips up and lock them with a hard glute squeeze.'],
    ['Single-Leg Hip Thrust', 'gt', 'c', 'bw', 2, 0, 'Upper back on the bench, one foot planted — drive the hip up and squeeze the glute at the top without rotating.', { bw: 1 }],
    ['45° Back Extension (Glute Focus)', 'gb', 'i', 'mach', 1, 1, 'Round your upper back slightly and hinge from the hips — squeeze your glutes to rise rather than arching the lower back.', { bw: 1 }],
    ['Cable Pull-Through', 'gb', 'i', 'cable', 1, 1, 'Hinge back until you feel the hamstring stretch, then snap your hips forward and squeeze the glutes.'],
    ['Hip Abduction Machine (Lean Forward)', 'ga', 'i', 'mach', 1, 0, 'Lean forward slightly and push out with the glute — feel the outer glutes burn at the end range.'],
    ['Cable Glute Kickback', 'ga', 'i', 'cable', 1, 0, 'Slight hinge and a soft knee — kick back by squeezing the glute, not by arching the lower back.'],
    ['Machine Hip Thrust', 'gt', 'c', 'mach', 1, 0, 'Chin tucked and ribs down — drive through the heels and squeeze the glutes at the top for a full second; the machine makes heavy loading simple.'],
    ['Barbell Glute Bridge', 'gt', 'c', 'bb', 2, 0, 'Shoulders on the floor and knees at 90° — drive the hips up and squeeze the glutes hard at lockout.'],
    ['Dumbbell Hip Thrust', 'gt', 'c', 'db', 2, 0, 'Upper back on the bench with the dumbbell on your hips — drive up and lock out with a hard glute squeeze.'],
    ['Reverse Hyperextension', 'gb', 'i', 'mach', 1, 1, 'Hips on the pad, swing the legs up with a glute squeeze — control the stretch down with no lower-back arch.'],
    ['Kettlebell Swing', 'gb', 'c', 'other', 2, 0, 'Hinge back and snap the hips forward — the glutes and hamstrings drive the bell and the arms just hang on.'],
    ['Seated Hip Abduction Machine', 'ga', 'i', 'mach', 1, 0, 'Lean forward slightly and push the pads apart with your glutes — feel the outer glutes burn and control the return.'],
    ['Cable Hip Abduction', 'ga', 'i', 'cable', 1, 0, 'Stand tall and take the leg out to the side with a soft knee — keep your hips square and squeeze the outer glute at the top.'],

    // ── Calves ──
    ['Standing Calf Raise', 'ca', 'i', 'mach', 1, 1, 'Full stretch at the bottom with a one-second pause, then rise as high as you can — feel your calves, not your toes.'],
    ['Seated Calf Raise', 'ca', 'i', 'mach', 1, 1, 'Bent knee shifts the load to the soleus — pause at the stretch, rise slowly and squeeze at the top.'],
    ['Smith Machine Calf Raise', 'ca', 'i', 'smith', 1, 1, 'Balls of the feet on a plate — drop the heels for a deep stretch, pause, then press up onto your toes.'],
    ['Single-Leg Dumbbell Calf Raise', 'ca', 'i', 'db', 1, 1, 'Hold a wall for balance — sink into a deep heel stretch and rise straight up, squeezing the calf at the top.', { bw: 1 }],
    ['Donkey Calf Raise', 'ca', 'i', 'mach', 1, 1, 'Hips hinged forward for a huge calf stretch — pause at the bottom, then rise as high as you can onto your toes.'],
    ['Leg Press Calf Raise', 'ca', 'i', 'mach', 1, 1, 'Legs straight with the balls of your feet on the platform — sink for a deep stretch, pause, then press up powerfully through the big toe.'],
    ['Single-Leg Calf Raise (Step)', 'ca', 'i', 'bw', 1, 1, 'Heel off a step — drop for a full stretch, pause, then rise as high as possible and squeeze.', { bw: 1 }],
    ['Tibialis Raise', 'ca', 'i', 'bw', 1, 0, 'Back against a wall with your heels out — pull your toes toward your shins and squeeze; strong shins protect the knees and ankles.', { bw: 1 }],

    // ── Core (prescribed individually) ──
    ['Plank', 'cx', 'i', 'bw', 1, 0, 'Keep a straight line from head to heels — squeeze your glutes and pull your belly button toward your spine.', { core: 1, bw: 1, unit: 'sec', reps: '30-45s', sets: 3, rest: 30 }],
    ['Side Plank', 'cl', 'i', 'bw', 1, 0, 'Stack your feet, lift your hips and keep a straight line — feel the obliques hold you up.', { core: 1, bw: 1, unit: 'sec', reps: '20-30s each', sets: 3, rest: 30 }],
    ['Hollow Body Hold', 'cx', 'i', 'bw', 1, 0, 'Press your lower back into the floor, arms overhead and legs extended — make a banana shape and breathe.', { core: 1, bw: 1, unit: 'sec', reps: '20-30s', sets: 3, rest: 30 }],
    ['Dead Bug', 'cx', 'i', 'bw', 1, 0, 'Press your lower back into the floor and move opposite arm and leg slowly — your abs should never let the back arch.', { core: 1, bw: 1, reps: '10 each side', sets: 3, rest: 30 }],
    ['Ab Wheel Rollout', 'cx', 'i', 'bw', 1, 0, 'Brace your core, roll out only as far as you can control, then pull back with your abs — not your hips.', { core: 1, bw: 1, reps: '8-10', sets: 3, rest: 45 }],
    ['Hanging Leg Raise', 'cf', 'i', 'bw', 1, 0, 'No swinging — curl your pelvis up and raise the legs to parallel or higher, lower slowly.', { core: 1, bw: 1, reps: '10-12', sets: 3, rest: 45 }],
    ['Hanging Knee Raise', 'cf', 'i', 'bw', 1, 0, 'Curl your pelvis toward your ribs and bring the knees to your chest — feel the lower abs, not the hip flexors.', { core: 1, bw: 1, reps: '12-15', sets: 3, rest: 45 }],
    ['Cable Crunch', 'cf', 'i', 'cable', 1, 1, 'Curl your spine bringing elbows toward knees — squeeze the abs hard at the bottom and don\'t sit back onto your hips.', { core: 1, reps: '12-15', sets: 3, rest: 45 }],
    ['Pallof Press', 'cr', 'i', 'cable', 1, 0, 'Press straight out and resist the rotation — feel your obliques working to keep you square.', { core: 1, reps: '10 each side', sets: 3, rest: 30 }],
    ['Russian Twist', 'cr', 'i', 'bw', 1, 0, 'Lean back slightly and rotate from the ribcage, not the arms — keep your feet up for extra challenge.', { core: 1, bw: 1, reps: '15 each side', sets: 3, rest: 30 }],
    ['Reverse Crunch', 'cf', 'i', 'bw', 1, 0, 'Curl your hips off the bench toward your ribs — feel the lower abs lift the pelvis, then lower slowly without swinging.', { core: 1, bw: 1, reps: '12-15', sets: 3, rest: 45 }],
    ['Vertical Leg Raise (Captain Chair)', 'cf', 'i', 'bw', 1, 0, 'Forearms on the pads with your back flat — curl the pelvis up as the knees come to your chest, feeling the abs and not the hip flexors.', { core: 1, bw: 1, reps: '10-15', sets: 3, rest: 45 }],
    ['Toes-to-Bar', 'cf', 'i', 'bw', 2, 0, 'Hang tight and curl your pelvis up as the toes drive to the bar — control the descent to keep tension through the abs.', { core: 1, bw: 1, reps: '6-10', sets: 3, rest: 60 }],
    ['Bicycle Crunch', 'cr', 'i', 'bw', 1, 0, 'Shoulder blades off the floor, slow elbow-to-knee rotations — feel the obliques twist while the abs stay braced.', { core: 1, bw: 1, reps: '15 each side', sets: 3, rest: 30 }],
    ['Cable Woodchop', 'cr', 'i', 'cable', 1, 0, 'Rotate from the ribcage, not the arms — pull diagonally across your body, pivoting the back foot, and feel the obliques drive it.', { core: 1, reps: '10 each side', sets: 3, rest: 30 }],
    ['Bird Dog', 'cr', 'i', 'bw', 1, 0, 'Extend the opposite arm and leg while keeping your hips square — pause at the top and keep the spine perfectly still.', { core: 1, bw: 1, reps: '10 each side', sets: 3, rest: 30 }],
    ['Copenhagen Plank', 'cl', 'i', 'bw', 2, 0, 'Top foot on a bench, body in a straight line — lift the hips and hold; the inner thigh and obliques work hard to keep you up.', { core: 1, bw: 1, unit: 'sec', reps: '15-25s each', sets: 3, rest: 45 }],
    ['Stability Ball Rollout', 'cx', 'i', 'other', 1, 0, 'Forearms on the ball, roll out only as far as you can keep the ribs down — feel the abs brace against the extension.', { core: 1, bw: 1, reps: '10-12', sets: 3, rest: 45 }],
    ['L-Sit Hold', 'cf', 'i', 'bw', 2, 0, 'Press down tall through your hands and lift the legs straight out — squeeze the abs and quads for the whole hold.', { core: 1, bw: 1, unit: 'sec', reps: '10-20s', sets: 3, rest: 45 }],
  ];

  // ── Evidence weighting ───────────────────────────────────────────────────
  // A gentle selection nudge (+6 / -8 on a ~100-point scale), never a hard rule — variety
  // still dominates. "Backed" = ranks at or near the top in published EMG work, hypertrophy
  // trials or widely-cited coach tier lists (Nippard / Cavaliere quad, glute, chest, back and
  // biceps rankings; ACE shoulder EMG; Maeo et al. on lengthened-position triceps/hamstring
  // training; Escamilla et al. ab EMG; barbell-shrug and prone-Y trap EMG). Most of that
  // evidence is EMG or opinion rather than long-term growth data, hence the small weight.
  const BACKED = [
    // chest
    'Barbell Bench Press', 'Incline Dumbbell Press', 'Dumbbell Bench Press', 'Machine Chest Press', 'Plate-Loaded Chest Press',
    'Pec Deck Fly', 'Seated Cable Fly', 'Low-to-High Cable Fly',
    // back
    'Pull-Up', 'Chin-Up', 'Wide-Grip Lat Pulldown', 'Chest-Supported T-Bar Row', 'Machine Chest-Supported Row', 'Seated Cable Row',
    'Barbell Bent-Over Row', 'Single-Arm Dumbbell Row', 'Barbell Shrug', 'Prone Y-Raise',
    // shoulders
    'Seated Dumbbell Shoulder Press', 'Dumbbell Lateral Raise', 'Cable Lateral Raise', 'Seated Dumbbell Rear Delt Raise',
    'Reverse Pec Deck', 'Cable Rear Delt Fly',
    // arms
    'Bayesian Cable Curl', 'EZ-Bar Preacher Curl', 'Incline Dumbbell Curl', 'Hammer Curl', 'Standing Alternating Dumbbell Curl',
    'Overhead Cable Triceps Extension', 'Overhead Dumbbell Triceps Extension', 'EZ-Bar Skullcrusher', 'Rope Pushdown',
    // legs
    'Hack Squat Machine', 'Pendulum Squat', 'Barbell Back Squat', 'Smith Machine Squat (Heels Elevated)', 'Leg Extension',
    'Bulgarian Split Squat', 'Walking Lunge', 'Barbell Romanian Deadlift', 'Seated Leg Curl', 'Nordic Hamstring Curl',
    'Barbell Hip Thrust', 'Machine Hip Thrust', 'Standing Calf Raise', 'Seated Calf Raise', 'Donkey Calf Raise',
    // core
    'Hanging Leg Raise', 'Vertical Leg Raise (Captain Chair)', 'Ab Wheel Rollout', 'Reverse Crunch', 'Cable Crunch',
  ];
  // Weak overload potential or consistently ranked in the bottom tiers.
  const WEAKER = [
    'Cable Glute Kickback', 'Dumbbell Triceps Kickback', 'Bench Dip', 'Russian Twist', 'Svend Press', 'Inverted Row',
  ];
  const BACKED_SET = new Set(BACKED), WEAKER_SET = new Set(WEAKER);

  // Anything that can't be coaxed into a rep-range progression (loaded on bodyweight).
  const LIB = RAW.map(r => {
    const o = r[7] || {};
    const e = {
      name: r[0], pat: r[1], role: r[2], equip: r[3], cost: r[4], len: !!r[5], cue: r[6],
      muscle: PAT_MUSCLE[r[1]], bw: !!o.bw, core: !!o.core, unit: o.unit || 'reps',
      top: BACKED_SET.has(r[0]), low: WEAKER_SET.has(r[0]),
      reps: o.reps || null, sets: o.sets || null, rest: o.rest || null,
    };
    if (e.reps) { const rg = parseRange(e.reps); e.lo = rg[0]; e.hi = rg[1]; }
    e.key = canon(e.name);
    return e;
  });
  const BY_KEY = new Map(LIB.map(e => [e.key, e]));

  // ── Small utils ──────────────────────────────────────────────────────────
  function canon(name) {
    return String(name || '').toLowerCase()
      .replace(/\bdb\b/g, 'dumbbell').replace(/\bbb\b/g, 'barbell')
      .replace(/\bez[\s-]?bar\b/g, 'ez-bar')
      .replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function parseRange(str) {
    const m = String(str || '').match(/(\d+)\s*[-–]\s*(\d+)/);
    if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
    const s = String(str || '').match(/(\d+)/);
    return s ? [parseInt(s[1], 10), parseInt(s[1], 10)] : null;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function roundW(w) {
    if (!(w > 0)) return 0;
    return w < 20 ? Math.round(w * 2) / 2 : Math.round(w / 2.5) * 2.5;
  }
  function incFor(w, e) {
    if (w < 20) return 1;
    if (w >= 100 && e && e.equip === 'mach') return 5;
    return 2.5;
  }
  function byName(name) { return BY_KEY.get(canon(name)) || null; }

  // Map a completed session to one of the four rotation categories. Prefers the
  // explicit splitCategory (new sessions); infers for legacy history.
  function classifySplit(s) {
    if (!s) return null;
    if (s.splitCategory && SPLIT_CYCLE.includes(s.splitCategory)) return s.splitCategory;
    const m = (s.muscleGroups || []).map(x => String(x).toLowerCase());
    const has = rx => m.some(x => rx.test(x));
    if (has(/quad|hamstring|glute|calf|calves|\bleg/)) return 'Legs';
    if (has(/chest/)) return 'Push';
    if (has(/\bback\b|\blats?\b/)) return 'Pull';
    if (has(/shoulder|bicep|tricep|delt|\barms?\b/)) return 'Arms & Shoulders';
    const n = String(s.splitName || '').toLowerCase();
    if (n.includes('push')) return 'Push';
    if (n.includes('pull')) return 'Pull';
    if (n.includes('leg')) return 'Legs';
    if (n.includes('arm') || n.includes('shoulder')) return 'Arms & Shoulders';
    return null;
  }
  function nextSplit(history) {
    const last = history && history.length ? history[history.length - 1] : null;
    const cat = classifySplit(last);
    if (!cat) return SPLIT_CYCLE[0];
    return SPLIT_CYCLE[(SPLIT_CYCLE.indexOf(cat) + 1) % SPLIT_CYCLE.length];
  }

  // ── Periodisation ────────────────────────────────────────────────────────
  // A block is 16 sessions (4 laps of the rotation). The rep zone is constant for
  // the three working weeks so held anchors can genuinely progress (add a rep →
  // add load), then week 4 is a deload. Each new block moves to the next zone
  // (Volume → Strength → Pump) and picks new anchors — that's the big variety
  // reset — while accessories rotate every single session.
  const PHASES = [
    { name: 'Volume',   blurb: 'moderate loads, controlled reps, leave ~2 in the tank',
      comp: { sets: 4, lo: 8,  hi: 10, rest: 120 }, iso: { sets: 3, lo: 10, hi: 12, rest: 75 }, tech: 1 },
    { name: 'Strength', blurb: 'heavier compounds with longer rests — push the load',
      comp: { sets: 4, lo: 5,  hi: 7,  rest: 180 }, iso: { sets: 3, lo: 8,  hi: 10, rest: 90 }, tech: 0 },
    { name: 'Pump',     blurb: 'higher reps and intensity techniques — chase the burn',
      comp: { sets: 3, lo: 10, hi: 12, rest: 90 },  iso: { sets: 3, lo: 12, hi: 15, rest: 60 }, tech: 3 },
  ];

  // no = block number (1-based), week = 0..3
  function blockObj(no, week) {
    const phase = (no - 1) % PHASES.length;
    const P = PHASES[phase];
    const deload = week === 3;
    return {
      no, week, phase, phaseName: P.name, deload,
      name: deload ? 'Deload' : P.name,
      blurb: deload ? 'lighter loads and fewer sets — recover so the next block hits harder' : P.blurb,
      comp: deload ? Object.assign({}, P.comp, { sets: Math.max(2, Math.round(P.comp.sets / 2)) }) : P.comp,
      iso: deload ? Object.assign({}, P.iso, { sets: 2 }) : P.iso,
      tech: deload ? 0 : P.tech,
    };
  }
  function blockInfo(sessionCount) {
    const n = Math.max(0, sessionCount | 0);
    const pos = n % BLOCK_SESSIONS;
    const B = blockObj(Math.floor(n / BLOCK_SESSIONS) + 1, Math.floor(pos / SESSIONS_PER_WEEK));
    B.pos = pos; B.sessionInBlock = pos + 1;
    return B;
  }
  // Rebuild a block from the compact form saved on a plan/session (week is 1-based there).
  function restoreBlock(saved) {
    if (!saved) return null;
    const B = blockObj(saved.no || 1, clamp((saved.week || 1) - 1, 0, 3));
    B.sessionInBlock = saved.pos; B.pos = (saved.pos || 1) - 1;
    return B;
  }

  // Recovery tiers (WHOOP-style %). Unknown is treated as "moderate".
  function tierOf(rec) {
    const r = (rec === null || rec === undefined || rec === '' || isNaN(rec)) ? null : Number(rec);
    if (r === null) return { key: 'mod', label: 'No recovery entered', note: 'assuming moderate, normal volume', n: 7, max3: 1, assumed: true, rec: null };
    if (r >= 67) return { key: 'high', label: 'Great recovery', note: 'full send today', n: r >= 80 ? 8 : 7, max3: 2, rec: r };
    if (r >= 50) return { key: 'mod', label: 'Solid recovery', note: 'normal volume', n: 7, max3: 1, rec: r };
    if (r >= 34) return { key: 'low', label: 'Lowish recovery', note: 'lighter loads and no max-effort lifts', n: 6, max3: 0, rec: r };
    return { key: 'rest', label: 'Poor recovery', note: 'technique and stretched-range work only', n: 5, max3: 0, rec: r };
  }

  const TECH_NOTES = {
    'rest-pause': 'Last set: go to ~1 rep shy of failure, rack it, rest 15–20 s, then grind out 3–5 more reps.',
    'drop set': 'Last set: go to failure, drop the weight ~25 %, and keep going to failure again — no rest.',
    'myo-reps': 'Activation set to ~2 reps shy of failure, then 4–5 mini-sets of 3–5 reps with only 10–15 s rest.',
    'lengthened partials': 'After your last full rep, keep going with partial reps in the bottom (stretched) half until you can\'t.',
  };
  function techPool(e) {
    if (e.equip === 'cable' || e.equip === 'mach') return ['rest-pause', 'drop set', 'myo-reps', 'lengthened partials'];
    if (e.equip === 'db') return ['drop set', 'lengthened partials', 'rest-pause'];
    return ['drop set', 'lengthened partials'];
  }

  // ── Session templates ────────────────────────────────────────────────────
  // p = keep-priority when trimming for low recovery (lower = more essential).
  // anchor = held for the whole block so it can progress.  len = prefer lengthened.
  // diff = prefer a pattern not already in the session.  warm = suggest warm-ups.
  const SLOTS = {
    'Push': [
      { id: 'P1', pats: ['pf', 'pi'], role: 'c', anchor: true, warm: true, p: 1 },
      { id: 'P2', pats: ['ohp'], role: 'c', anchor: true, warm: true, p: 2 },
      { id: 'P3', pats: ['pi', 'pf', 'pd'], role: 'c', diff: true, p: 3 },
      { id: 'P4', pats: ['fly'], role: 'i', len: true, p: 4 },
      { id: 'P5', pats: ['lat'], role: 'i', len: true, p: 5 },
      { id: 'P6', pats: ['to'], role: 'i', len: true, p: 6 },
      { id: 'P7', pats: ['tp'], role: 'i', p: 7 },
      { id: 'P8', pats: ['lat', 'fly'], role: 'i', p: 9, bonus: true },
    ],
    'Pull': [
      { id: 'L1', pats: ['vp'], role: 'c', anchor: true, p: 1 },
      { id: 'L2', pats: ['hr'], role: 'c', anchor: true, warm: true, p: 2 },
      { id: 'L3', pats: ['hr', 'vp'], role: 'c', diff: true, p: 3 },
      { id: 'L4', pats: ['rd'], role: 'i', p: 4 },
      { id: 'L5', pats: ['po', 'tr'], role: 'i', len: true, p: 5 },
      { id: 'L6', pats: ['bl'], role: 'i', len: true, p: 6 },
      { id: 'L7', pats: ['bs'], role: 'i', p: 7 },
      { id: 'L8', pats: ['tr', 'bl', 'bs'], role: 'i', p: 9, bonus: true },
    ],
    'Arms & Shoulders': [
      { id: 'A1', pats: ['ohp'], role: 'c', anchor: true, warm: true, p: 1 },
      { id: 'A2', pats: ['lat'], role: 'i', len: true, p: 2 },
      { id: 'A3', pats: ['tc'], role: 'c', anchor: true, p: 3 },
      { id: 'A4', pats: ['bl'], role: 'i', len: true, p: 4 },
      { id: 'A5', pats: ['rd'], role: 'i', p: 5 },
      { id: 'A6', pats: ['to'], role: 'i', len: true, p: 6 },
      { id: 'A7', pats: ['bs'], role: 'i', p: 7 },
      { id: 'A8', pats: ['tp'], role: 'i', p: 8 },
    ],
    'Legs': [
      { id: 'G1', pats: ['sq'], role: 'c', anchor: true, warm: true, p: 1 },
      { id: 'G2', pats: ['hg'], role: 'c', anchor: true, warm: true, p: 2 },
      { id: 'G3', pats: ['lp', 'lg'], role: 'c', p: 3 },
      { id: 'G4', pats: ['hc'], role: 'i', len: true, p: 4 },
      { id: 'G5', pats: ['gt', 'gb', 'ga'], p: 5 },
      { id: 'G6', pats: ['le'], role: 'i', p: 6 },
      { id: 'G7', pats: ['ca'], role: 'i', len: true, p: 7 },
      { id: 'G8', pats: ['lg', 'ga', 'gb'], p: 9, bonus: true },
    ],
  };
  const CORE_SLOT = { id: 'CORE', pats: ['cx', 'cf', 'cr', 'cl'], role: 'i', core: true, p: 99 };
  function slotById(split, id) {
    if (id === 'CORE') return CORE_SLOT;
    return (SLOTS[split] || []).find(s => s.id === id) || null;
  }

  // ── History index ────────────────────────────────────────────────────────
  // One pass over history → everything the selector & progression need.
  function sessionSets(ex) {
    const out = [];
    (ex.sets || []).forEach(s => {
      if (!s || !s.done) return;
      const reps = parseFloat(s.reps);
      if (!(reps > 0)) return;
      const w = parseFloat(s.weight);
      out.push({ w: w > 0 ? w : 0, r: reps });
    });
    return out;
  }

  function buildIndex(history, now) {
    const hist = history || [];
    const n = hist.length;
    const byNm = new Map();       // canon name → { daysAgo, sessAgo, exps[] }
    const recent6 = new Map();
    const lastBySplit = {};
    const cardioKeys = [];
    const blockStart = n - (n % BLOCK_SESSIONS);
    let lastSessionDaysAgo = null;

    for (let i = n - 1; i >= 0; i--) {
      const s = hist[i];
      if (!s) continue;
      const sessAgo = n - 1 - i;
      const t = Date.parse(s.date);
      const daysAgo = isFinite(t) ? Math.max(0, (now - t) / 864e5) : 999;
      if (lastSessionDaysAgo === null) lastSessionDaysAgo = daysAgo;
      const cat = classifySplit(s);
      if (cat && !lastBySplit[cat]) lastBySplit[cat] = { s, i, inBlock: i >= blockStart };
      if (cardioKeys.length < 3 && s.cardio && s.cardio.machine) cardioKeys.push(cardioKey(s.cardio));
      (s.exercises || []).forEach(ex => {
        const nm = canon(ex.swappedTo || ex.name);
        if (!nm) return;
        let e = byNm.get(nm);
        if (!e) { e = { daysAgo, sessAgo, exps: [] }; byNm.set(nm, e); }
        if (sessAgo < 6) recent6.set(nm, (recent6.get(nm) || 0) + 1);
        // Deload weeks are deliberately light — never use them as a baseline.
        if (e.exps.length < 3 && !(s.block && s.block.deload)) {
          const sets = sessionSets(ex);
          if (sets.length) {
            const W = Math.max(...sets.map(x => x.w));
            const top = sets.filter(x => x.w >= W * 0.95);
            e.exps.push({
              daysAgo, sets, W, topReps: top.map(x => x.r),
              range: parseRange(ex.reps), tech: ex.intensityTechnique || null,
              date: s.date,
            });
          }
        }
        if (!e.techs) e.techs = [];
        if (e.techs.length < 4 && ex.intensityTechnique && ex.intensityTechnique !== 'straight sets') e.techs.push(ex.intensityTechnique);
      });
    }
    return { byName: byNm, recent6, lastBySplit, cardioKeys, n, blockStart, lastSessionDaysAgo };
  }

  // ── Progression ──────────────────────────────────────────────────────────
  // Double progression with block-aware re-basing. Returns per-set targets.
  function progress(e, exps, B) {
    const { lo, hi, sets, deload } = B;
    if (!exps || !exps.length) return { kind: 'new', targets: null };
    const L = exps[0], P = exps[1];

    // Timed holds: add ~5 s per exposure.
    if (e.unit === 'sec') {
      const targets = [];
      for (let i = 0; i < sets; i++) {
        const prev = L.topReps[i] != null ? L.topReps[i] : L.topReps[L.topReps.length - 1];
        targets.push({ w: 0, r: clamp(Math.round(prev) + 5, lo, hi + 15) });
      }
      return { kind: 'rep', targets, last: L };
    }

    const W = L.W;
    const topReps = L.topReps;
    const minTop = Math.min(...topReps);
    const avgTop = mean(topReps);
    const repsFor = i => (topReps[i] != null ? topReps[i] : topReps[topReps.length - 1]);

    // Bodyweight core: reps only (range creeps up past the top instead of adding load).
    if (e.core && e.bw && W === 0) {
      const targets = [];
      for (let i = 0; i < sets; i++) targets.push({ w: 0, r: clamp(Math.round(repsFor(i)) + 1, lo, hi + 4) });
      return { kind: 'rep', targets, last: L };
    }

    let w = W, kind = 'hold', rep = i => lo;

    if (deload) {
      w = roundW(W * 0.9);
      const r = Math.round((lo + hi) / 2);
      rep = () => r; kind = 'deload';
    } else {
      const sameRange = !L.range || (Math.abs(L.range[0] - lo) <= 1 && Math.abs(L.range[1] - hi) <= 2);
      if (!sameRange) {
        // New block / different rep zone: same effort, different reps (Epley ratio).
        w = W > 0 ? roundW(W * (1 + avgTop / 30) / (1 + lo / 30)) : 0;
        kind = w > W ? 'shift-up' : w < W ? 'shift-down' : 'hold';
      } else if (minTop >= hi) {
        w = W > 0 ? roundW(W + incFor(W, e)) : (e.bw ? 2.5 : 0);
        kind = 'up';
      } else if (minTop >= lo) {
        rep = i => clamp(Math.round(repsFor(i)) + 1, lo, hi); kind = 'rep';
      } else {
        const prevMissed = P && P.W >= W * 0.95 && P.topReps.length && Math.min(...P.topReps) < lo &&
          (!P.range || (Math.abs(P.range[0] - lo) <= 1));
        if (prevMissed) { w = roundW(W * 0.92); kind = 'reset'; }
        else kind = 'hold';
      }
      // A layoff means time away from TRAINING, not from this one exercise — with a big
      // library a lift can sit out for weeks while you train every day without losing strength.
      const away = B.lastDaysAgo != null ? B.lastDaysAgo : L.daysAgo;
      if (away > 21 && kind !== 'shift-up' && kind !== 'shift-down' && w > 0) {
        w = roundW(w * (away > 42 ? 0.9 : 0.95)); kind = 'return';
      }
    }
    const targets = [];
    for (let i = 0; i < sets; i++) targets.push({ w, r: rep(i) });
    return { kind, targets, last: L };
  }

  function fmtDate(iso) {
    const t = Date.parse(iso);
    if (!isFinite(t)) return '';
    const d = new Date(t);
    return d.getDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  }
  function lastText(e, L) {
    if (!L) return '';
    const unit = e.unit === 'sec' ? 's' : '';
    const reps = L.sets.map(s => Math.round(s.r) + unit).join(', ');
    const wtxt = L.W > 0 ? L.W + 'kg × ' : '';
    return 'Last: ' + wtxt + reps + (L.date ? ' · ' + fmtDate(L.date) : '');
  }
  function warmupText(w) {
    if (!(w >= 40)) return null;
    const steps = [[0.5, 8], [0.7, 5], [0.85, 3]];
    return 'Warm-up: ' + steps.map(([f, r]) => Math.max(20, roundW(w * f)) + '×' + r).join(' · ');
  }

  // ── Exercise builder ─────────────────────────────────────────────────────
  function prescribe(e, ctx, slot) {
    const B = ctx.block, T = ctx.tier;
    if (e.core) {
      return { sets: B.deload ? 2 : e.sets, lo: e.lo, hi: e.hi, rest: e.rest };
    }
    const P = Object.assign({}, B[e.role === 'c' ? 'comp' : 'iso']);
    if (!B.deload) {
      if (T.key === 'low') {
        if (e.role === 'c') { P.sets = Math.max(2, P.sets - 1); P.lo += 2; P.hi += 2; }
      } else if (T.key === 'rest') {
        P.sets = 3; P.lo = 12; P.hi = 15; P.rest = Math.min(P.rest, 75);
      } else if (T.key === 'high' && slot && slot.anchor && slot.warm && B.phaseName === 'Strength' && e.role === 'c') {
        P.sets += 1;
      }
    }
    return P;
  }

  function buildExercise(e, slot, ctx) {
    const P = prescribe(e, ctx, slot);
    const info = ctx.idx.byName.get(e.key);
    const prog = progress(e, info ? info.exps : [], { lo: P.lo, hi: P.hi, sets: P.sets, deload: ctx.block.deload, lastDaysAgo: ctx.idx.lastSessionDaysAgo });
    const first = prog.targets ? prog.targets[0] : null;
    const reps = e.core ? e.reps : (P.lo + '-' + P.hi);
    return {
      name: e.name, libKey: e.key, slot: slot ? slot.id : null, anchor: !!(slot && slot.anchor),
      muscle: e.muscle, role: e.role === 'c' ? 'compound' : 'isolation', equip: e.equip, pat: e.pat,
      cue: e.cue, len: e.len, bw: e.bw, unit: e.unit,
      intensityTechnique: 'straight sets', techNote: null,
      sets: P.sets, reps, repLo: P.lo, repHi: P.hi, rest: P.rest,
      lastWeight: prog.last && prog.last.W > 0 ? prog.last.W : null,
      suggestedWeight: first && first.w > 0 ? first.w : null,
      targets: prog.targets, progression: prog.kind,
      lastText: prog.last ? lastText(e, prog.last) : '',
      isNew: prog.kind === 'new',
      warmup: slot && slot.warm && first ? warmupText(first.w) : null,
      isAutoCore: !!e.core,
      alternatives: [],
    };
  }

  // ── Selection ────────────────────────────────────────────────────────────
  function scoreCand(e, slot, st, ctx, jitter) {
    const info = ctx.idx.byName.get(e.key);
    let s = 0;
    if (!info) s += 34; else s += Math.min(info.daysAgo, 56) * 0.55;
    s -= 14 * (ctx.idx.recent6.get(e.key) || 0);
    if (info && info.sessAgo < 2) s -= 26;
    if (slot.len && e.len) s += 12;
    if (slot.anchor && (e.cost >= 2 || e.top)) s += 10;   // anchors should be real, progressable lifts
    if (e.top) s += 6; else if (e.low) s -= 8;            // gentle evidence nudge (see BACKED / WEAKER)
    if (slot.diff && st.pats.has(e.pat)) s -= 30;
    const eq = st.equip[e.equip] || 0;
    if (eq >= 3) s -= 8; else if (eq === 2) s -= 3;
    if (ctx.tier.key === 'low' || ctx.tier.key === 'rest') s += (e.cost === 1 ? 6 : 0) - (e.cost === 3 ? 20 : 0);
    return s + jitter * 16;
  }

  function pool(slot) {
    return LIB.filter(e => slot.pats.includes(e.pat) && (!slot.role || e.role === slot.role) && (!!slot.core === !!e.core));
  }

  function pickFor(slot, st, ctx, avoidNames, opts) {
    opts = opts || {};
    const allowed = e => !st.names.has(e.key) && !(ctx.exclude && ctx.exclude.has(e.key)) &&
      !(e.cost === 3 && st.cost3 >= ctx.tier.max3);
    let cands = pool(slot).filter(allowed);
    if (avoidNames && avoidNames.size) {
      const fresh = cands.filter(e => !avoidNames.has(e.key));
      if (fresh.length) cands = fresh;
    }
    if (!cands.length) cands = pool(slot).filter(e => !st.names.has(e.key));   // last-resort relax
    if (!cands.length) return null;
    const rng = ctx.rng;
    const scored = cands.map(e => ({ e, s: scoreCand(e, slot, st, ctx, opts.noJitter ? 0.5 : rng()) }))
      .sort((a, b) => b.s - a.s);
    return opts.ranked ? scored.map(x => x.e) : scored[0].e;
  }

  function takeInto(st, e) {
    st.names.add(e.key);
    st.pats.add(e.pat);
    st.equip[e.equip] = (st.equip[e.equip] || 0) + 1;
    if (e.cost === 3) st.cost3++;
  }

  function trimSlots(slots, n) {
    const keep = new Set(slots.slice().sort((a, b) => a.p - b.p || slots.indexOf(a) - slots.indexOf(b)).slice(0, n).map(s => s.id));
    return slots.filter(s => keep.has(s.id));
  }

  function newCtx(input) {
    const now = input.now || Date.now();
    const history = input.history || [];
    const seed = input.seed != null ? input.seed : Math.floor(Math.random() * 2 ** 31);
    const ctx = {
      now, history, seed,
      rng: input.rng || mulberry32(seed),
      idx: buildIndex(history, now),
      block: blockInfo(history.length),
      tier: tierOf(input.recovery),
      prefs: input.prefs || {},
      exclude: input.exclude ? new Set([...input.exclude].map(canon)) : new Set(),
    };
    return ctx;
  }

  // ── Cardio finisher ──────────────────────────────────────────────────────
  function cardioKey(c) {
    if (c && c.key) return c.key;
    const m = String((c && c.machine) || '').toLowerCase();
    if (/tread|walk|run/.test(m)) return 'treadmill';
    if (/stair/.test(m)) return 'stairs';
    if (/bike|cycl/.test(m)) return 'bike';
    if (/row/.test(m)) return 'rower';
    if (/ellip/.test(m)) return 'elliptical';
    return m || 'other';
  }

  function pickCardio(ctx, split) {
    const rng = ctx.rng, T = ctx.tier, B = ctx.block;
    const durBy = { high: [20, 25], mod: [15, 20], low: [12, 15], rest: [10, 12] };
    let [dLo, dHi] = durBy[T.key];
    if (B.deload) { dLo = 10; dHi = 15; }
    const pickInt = (a, b, step) => a + Math.floor(rng() * (((b - a) / step) + 1)) * step;
    const dur = pickInt(dLo, dHi, 5);
    const recent = ctx.idx.cardioKeys.slice(0, 2);
    const hiitOK = T.rec != null && T.rec >= 80 && !B.deload && split !== 'Legs';

    if (hiitOK && rng() < 0.4) {
      const hiit = [
        { key: 'bike', machine: 'Bike Sprints', slug: 'bike-upright', d: 12, specs: [['12', 'min'], ['8×20s', 'all-out'], ['40s', 'easy']], rationale: 'Recovery is high — short, sharp sprints build conditioning without much muscle cost.' },
        { key: 'treadmill', machine: 'Treadmill Hill Intervals', slug: 'treadmill', d: 15, specs: [['15', 'min'], ['6×45s', '9 km/h · 4%'], ['90s', 'walk']], rationale: 'Recovery is high — hill intervals give a big fat-burn bump in 15 minutes.' },
        { key: 'rower', machine: 'Rower Intervals', slug: 'rower-machine', d: 14, specs: [['14', 'min'], ['8×250m', 'hard'], ['60s', 'easy']], rationale: 'Recovery is high — full-body intervals to finish.' },
      ].filter(c => !recent.includes(c.key));
      const c = hiit[Math.floor(rng() * hiit.length)];
      if (c) return finishCardio(c, c.d, c.specs);
    }

    const steady = [
      { key: 'treadmill', machine: 'Treadmill — Incline Walk', slug: 'treadmill' },
      { key: 'stairs', machine: 'Stairmaster', slug: 'stairmaster' },
      { key: 'bike', machine: 'Upright Bike', slug: 'bike-upright' },
      { key: 'rower', machine: 'Rowing Machine', slug: 'rower-machine' },
      { key: 'elliptical', machine: 'Elliptical', slug: 'elliptical' },
    ].filter(c => !recent.includes(c.key));
    const c = steady[Math.floor(rng() * steady.length)] || steady[0];
    const easy = T.key === 'low' || T.key === 'rest';
    let specs, extra = {};
    if (c.key === 'treadmill') {
      const sp = easy ? 5 : pickInt(55, 65, 5) / 10, inc = easy ? pickInt(4, 8, 2) : pickInt(8, 12, 2);
      specs = [[String(dur), 'min'], [String(sp), 'km/h'], [inc + '%', 'incline']];
      extra = { speed: sp, unit: 'km/h', incline: inc };
    } else if (c.key === 'stairs') {
      const lv = easy ? pickInt(4, 6, 1) : pickInt(6, 9, 1);
      specs = [[String(dur), 'min'], [String(lv), 'level'], ['steady', 'pace']];
      extra = { speed: lv, unit: 'level', incline: 0 };
    } else if (c.key === 'bike') {
      const lv = easy ? pickInt(4, 6, 1) : pickInt(6, 9, 1);
      specs = [[String(dur), 'min'], ['Lv ' + lv, 'resistance'], ['80–90', 'rpm']];
      extra = { speed: lv, unit: 'level', incline: 0 };
    } else if (c.key === 'rower') {
      specs = [[String(Math.min(dur, 15)), 'min'], ['2:15–2:30', '/500m'], ['20–24', 'spm']];
      extra = { speed: 0, unit: 'pace', incline: 0 };
    } else {
      const lv = easy ? pickInt(5, 7, 1) : pickInt(7, 10, 1);
      specs = [[String(dur), 'min'], ['Lv ' + lv, 'resistance'], ['steady', 'pace']];
      extra = { speed: lv, unit: 'level', incline: 0 };
    }
    return finishCardio(Object.assign({ rationale: easy ? 'Easy zone-2 flow — keeps fat-burn up without draining recovery.' : 'Steady-state zone 2 while fasted — burns fat without cutting into muscle-building recovery.' }, c, extra),
      parseInt(specs[0][0], 10), specs);
  }
  function finishCardio(c, dur, specs) {
    return Object.assign({
      machine: c.machine, key: c.key, iconSlug: c.slug, duration: dur,
      speed: c.speed != null ? c.speed : '', unit: c.unit || '', incline: c.incline != null ? c.incline : 0,
      rationale: c.rationale || '',
      specs: specs.map(s => ({ v: s[0], l: s[1] })),
    });
  }

  // ── Plan generation ──────────────────────────────────────────────────────
  function generate(input) {
    const ctx = newCtx(input);
    const split = input.split && SPLIT_CYCLE.includes(input.split) ? input.split : nextSplit(ctx.history);
    const { block: B, tier: T, idx } = ctx;

    let slots = SLOTS[split];
    const target = B.deload ? Math.min(T.n, 6) : T.n;
    slots = trimSlots(slots, target);

    // Anchors from earlier this block (balanced variety mode only).
    const persist = {};
    const lastSame = idx.lastBySplit[split];
    if (ctx.prefs.variety !== 'max' && lastSame && lastSame.inBlock) {
      (lastSame.s.exercises || []).forEach(ex => {
        if (ex.slot && ex.anchor) persist[ex.slot] = canon(ex.swappedTo || ex.name);
      });
    }
    const avoid = new Set();     // exercises from the previous session of this split
    if (lastSame) (lastSame.s.exercises || []).forEach(ex => avoid.add(canon(ex.swappedTo || ex.name)));

    const st = { names: new Set(), pats: new Set(), equip: {}, cost3: 0 };
    const chosen = {};
    const heldSlots = new Set();

    // 1) anchors first (held or fresh), 2) everything else in priority order.
    const order = slots.slice().sort((a, b) => (b.anchor ? 1 : 0) - (a.anchor ? 1 : 0) || a.p - b.p);
    order.forEach(slot => {
      let e = null;
      if (slot.anchor && persist[slot.id]) {
        const held = BY_KEY.get(persist[slot.id]);
        if (held && slot.pats.includes(held.pat) && !st.names.has(held.key) && !(held.cost === 3 && st.cost3 >= T.max3) && !ctx.exclude.has(held.key)) {
          e = held; heldSlots.add(slot.id);
        }
      }
      if (!e) e = pickFor(slot, st, ctx, avoid);
      if (!e) return;
      takeInto(st, e);
      chosen[slot.id] = e;
    });

    // Core finisher (always included; rotates by novelty).
    const coreSlot = CORE_SLOT;
    const coreAvoid = new Set();
    if (lastSame) (lastSame.s.exercises || []).forEach(ex => coreAvoid.add(canon(ex.swappedTo || ex.name)));
    const coreE = pickFor(coreSlot, st, ctx, coreAvoid);

    const exercises = slots.filter(s => chosen[s.id]).map(s => {
      const ex = buildExercise(chosen[s.id], s, ctx);
      ex.held = heldSlots.has(s.id);
      return ex;
    });
    if (coreE) { takeInto(st, coreE); exercises.push(buildExercise(coreE, coreSlot, ctx)); }

    assignTechniques(exercises, ctx, st);

    // Alternatives (same slot pool, ranked, not already in the plan).
    exercises.forEach(ex => {
      const slot = slotById(split, ex.slot);
      if (!slot) return;
      const used = new Set(exercises.map(x => x.libKey));
      const ranked = pickFor(slot, { names: used, pats: new Set(), equip: {}, cost3: 0 }, ctx, new Set(), { ranked: true, noJitter: true });
      ex.alternatives = (ranked || []).slice(0, 4).map(e => e.name);
    });

    const cardio = pickCardio(ctx, split);
    const stats = summarise(exercises, avoid);

    return {
      engine: 2, seed: ctx.seed,
      splitName: split + ' — ' + B.name,
      splitCategory: split,
      muscleGroups: SPLIT_MUSCLES[split].slice(),
      block: { no: B.no, week: B.week + 1, name: B.name, phase: B.phase, phaseName: B.phaseName, blurb: B.blurb, pos: B.sessionInBlock, deload: B.deload },
      tier: { key: T.key, label: T.label, rec: T.rec },
      coachNote: coachNote(split, B, T, exercises, stats),
      exercises, cardio, stats, rejected: [],
    };
  }

  function summarise(exercises, avoid) {
    const real = exercises.filter(e => !e.isAutoCore);
    const fresh = real.filter(e => !avoid.has(e.libKey)).length;
    return {
      total: real.length,
      newToSplit: fresh,
      neverDone: real.filter(e => e.isNew).length,
      progressing: real.filter(e => e.progression === 'up' || e.progression === 'shift-up').length,
    };
  }

  function coachNote(split, B, T, exercises, stats) {
    const bits = [];
    bits.push((B.deload ? 'Deload week' : B.phaseName + ' block · week ' + (B.week + 1) + '/4') + ' — ' + B.blurb + '.');
    bits.push(T.rec != null ? 'Recovery ' + T.rec + '% — ' + T.note + '.' : 'No recovery entered — ' + T.note + '.');
    const up = exercises.filter(e => e.progression === 'up' && !e.isAutoCore).slice(0, 2);
    if (up.length) bits.push('Time to add load: ' + up.map(e => e.name + ' → ' + e.targets[0].w + 'kg').join(', ') + '.');
    else if (stats.total && stats.neverDone === stats.total) bits.push('Everything here is new to you — start light (about 2 reps in reserve) to find working weights.');
    else if (stats.total) bits.push(stats.newToSplit + ' of ' + stats.total + ' lifts are fresh since your last ' + split + ' day' + (stats.neverDone ? ' (' + stats.neverDone + ' brand new)' : '') + '.');
    return bits.join(' ');
  }

  function assignTechniques(exercises, ctx, st) {
    const B = ctx.block, T = ctx.tier;
    let k = B.tech;
    if (T.key === 'rest') k = 2;
    else if (T.key === 'low') k = Math.min(k, 1);
    if (!k || B.deload) return;
    const isos = exercises.filter(e => e.role === 'isolation' && !e.isAutoCore);
    isos.slice(-k).forEach(ex => {
      const lib = BY_KEY.get(ex.libKey);
      if (!lib) return;
      let pool = techPool(lib);
      if (T.key === 'rest') pool = lib.len ? ['lengthened partials'] : [];
      if (!pool.length) return;
      const info = ctx.idx.byName.get(ex.libKey);
      const used = (info && info.techs) || [];
      // least-recently-used technique for this exercise, ties random
      const ranked = pool.map(t => ({ t, s: (used.indexOf(t) === -1 ? 99 : used.indexOf(t)) + ctx.rng() })).sort((a, b) => b.s - a.s);
      ex.intensityTechnique = ranked[0].t;
      ex.techNote = TECH_NOTES[ranked[0].t];
    });
  }

  // ── Single-exercise operations (preview swap, tracker swap, add-ons) ─────
  // Replace plan.exercises[i] with a fresh pick for the same slot.
  function swapOne(plan, i, input) {
    const ctx = newCtx(input);
    const old = plan.exercises[i];
    if (!old) return null;
    const split = plan.splitCategory;
    const slot = slotById(split, old.slot);
    if (!slot) return null;
    const rejected = new Set((plan.rejected || []).map(canon));
    rejected.add(old.libKey || canon(old.name));
    const st = { names: new Set(plan.exercises.map(e => e.libKey || canon(e.name))), pats: new Set(), equip: {}, cost3: 0 };
    plan.exercises.forEach((e, j) => {
      if (j === i) return;
      st.pats.add(e.pat);
      st.equip[e.equip] = (st.equip[e.equip] || 0) + 1;
      if ((byName(e.name) || {}).cost === 3) st.cost3++;
    });
    ctx.exclude = new Set([...ctx.exclude, ...rejected]);
    const e = pickFor(slot, st, ctx, new Set());
    if (!e) return null;
    const built = buildExercise(e, slot, ctx);
    built.held = false;
    // carry the technique slot over if the old one had one and the new one supports it
    if (old.intensityTechnique && old.intensityTechnique !== 'straight sets' && built.role === 'isolation') {
      const lib = BY_KEY.get(built.libKey);
      const t = techPool(lib)[0];
      built.intensityTechnique = t; built.techNote = TECH_NOTES[t];
    }
    const used = new Set(plan.exercises.map(x => x.libKey));
    used.add(built.libKey);
    const ranked = pickFor(slot, { names: used, pats: new Set(), equip: {}, cost3: 0 }, ctx, new Set(), { ranked: true, noJitter: true });
    built.alternatives = (ranked || []).slice(0, 4).map(x => x.name);
    plan.rejected = (plan.rejected || []).concat(old.name);
    plan.exercises[i] = built;
    plan.stats = summarise(plan.exercises, new Set());
    return built;
  }

  // Build prescription + targets for a specific named exercise (tracker swap / add).
  function exerciseFor(name, input) {
    const e = byName(name);
    if (!e) return null;
    const ctx = newCtx(input);
    // keep the session's block rather than recomputing from history length
    if (input.block) ctx.block = restoreBlock(input.block);
    const slot = input.split ? slotById(input.split, input.slot) : null;
    return buildExercise(e, slot, ctx);
  }

  // Targets for a named exercise at an explicit sets/reps prescription (saved routines).
  function targetsFor(name, o) {
    const e = byName(name);
    if (!e) return null;
    const idx = buildIndex(o.history || [], o.now || Date.now());
    const info = idx.byName.get(e.key);
    const rg = parseRange(o.reps) || [8, 12];
    const prog = progress(e, info ? info.exps : [], { lo: rg[0], hi: rg[1], sets: o.sets || 3, deload: false, lastDaysAgo: idx.lastSessionDaysAgo });
    return { targets: prog.targets, kind: prog.kind, isNew: prog.kind === 'new', lastText: prog.last ? lastText(e, prog.last) : '' };
  }

  // Alternatives for an in-progress session exercise (same slot, not already used).
  function alternativesFor(split, slotId, usedNames, input) {
    const slot = slotById(split, slotId);
    if (!slot) return [];
    const ctx = newCtx(input);
    const used = new Set((usedNames || []).map(canon));
    const ranked = pickFor(slot, { names: used, pats: new Set(), equip: {}, cost3: 0 }, ctx, new Set(), { ranked: true, noJitter: true });
    return (ranked || []).slice(0, 4).map(e => e.name);
  }

  // Add-on suggestions for the tracker: the least-covered muscles of today's split.
  function suggestExtras(session, input) {
    const split = session.splitCategory && SLOTS[session.splitCategory] ? session.splitCategory : classifySplit(session);
    if (!split) return [];
    const ctx = newCtx(input);
    if (session.block) ctx.block = restoreBlock(session.block);
    const have = new Set((session.exercises || []).map(ex => canon(ex.swappedTo || ex.name)));
    const volume = {};
    (session.exercises || []).forEach(ex => {
      const lib = byName(ex.swappedTo || ex.name);
      const m = lib ? lib.muscle : null;
      if (m) volume[m] = (volume[m] || 0) + ((ex.sets && ex.sets.length) || 0);
    });
    // Candidate slots = isolation slots of today's split, least-covered muscle first.
    const slots = SLOTS[split].filter(s => s.role === 'i' || !s.role).map(s => ({ s, m: PAT_MUSCLE[s.pats[0]] }));
    slots.sort((a, b) => (volume[a.m] || 0) - (volume[b.m] || 0));
    const out = [], seenM = new Set();
    // First pass: one per muscle (least-covered first). Second pass fills any gaps.
    for (const pass of [0, 1]) {
      for (const { s, m } of slots) {
        if (out.length >= 3) break;
        if (pass === 0 && seenM.has(m)) continue;
        const st = { names: new Set(have), pats: new Set(), equip: {}, cost3: 0 };
        const e = pickFor(Object.assign({}, s, { role: 'i' }), st, ctx, new Set());
        if (!e || have.has(e.key)) continue;
        seenM.add(m);
        have.add(e.key);
        const built = buildExercise(e, s, ctx);
        const sets = volume[m] || 0;
        built.reason = m + ' only has ' + sets + ' set' + (sets === 1 ? '' : 's') + ' in today\'s plan — ' +
          (e.len ? 'this ' + PAT_LABEL[e.pat] + ' loads it in the stretched position, ' : 'this ' + PAT_LABEL[e.pat] + ' ') +
          'for extra volume at a low recovery cost.';
        out.push(built);
      }
    }
    return out;
  }

  const api = {
    LIB, SPLIT_CYCLE, SPLIT_MUSCLES, PHASES, TECH_NOTES, PAT_MUSCLE, SLOTS, EVIDENCE: { backed: BACKED, weaker: WEAKER },
    BLOCK_SESSIONS, SESSIONS_PER_WEEK,
    generate, swapOne, exerciseFor, targetsFor, alternativesFor, suggestExtras,
    blockInfo, restoreBlock, tierOf, nextSplit, classifySplit, byName, canon, parseRange, roundW, progress, buildIndex,
  };
  root.WoEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
