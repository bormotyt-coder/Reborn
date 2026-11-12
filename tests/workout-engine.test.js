// Run with:  node tests/workout-engine.test.js
// No dependencies. Simulates months of training against the engine and asserts
// the properties that make the generator useful: enforced variety, held anchors,
// double progression, deloads, recovery gating, cardio rotation and speed.
'use strict';
const assert = require('assert');
const E = require('../workout-engine.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + (e.stack || e).split('\n').slice(0, 4).join('\n    ')); process.exitCode = 1; }
}

const DAY = 864e5;
const T0 = Date.UTC(2026, 0, 5, 7);
const SPLIT_OK = {
  'Push': ['Chest', 'Shoulders', 'Triceps', 'Core'],
  'Pull': ['Back', 'Biceps', 'Rear Delts', 'Core'],
  'Arms & Shoulders': ['Shoulders', 'Biceps', 'Triceps', 'Rear Delts', 'Core'],
  'Legs': ['Quads', 'Hamstrings', 'Glutes', 'Calves', 'Core'],
};

// Deterministic PRNG for the simulated lifter.
function rngOf(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; };

// Turn a plan into a completed history session, like the tracker would.
function performSession(plan, i, perf, startW) {
  return {
    id: i, date: new Date(T0 + i * DAY).toISOString(),
    splitName: plan.splitName, splitCategory: plan.splitCategory, muscleGroups: plan.muscleGroups,
    cardio: plan.cardio, block: plan.block,
    exercises: plan.exercises.map(ex => ({
      name: ex.name, swappedTo: null, slot: ex.slot, anchor: ex.anchor, reps: ex.reps,
      intensityTechnique: ex.intensityTechnique,
      sets: Array.from({ length: ex.sets }, (_, si) => {
        const t = ex.targets && ex.targets[si];
        const w = t ? t.w : (ex.bw ? 0 : startW);
        const base = t ? t.r : ex.repHi;
        const roll = perf();
        const r = roll < 0.65 ? base : roll < 0.85 ? base + 1 : Math.max(1, base - 1);
        return { weight: String(w), reps: String(r), done: true };
      }),
    })),
  };
}

function simulate(sessions, opts) {
  opts = opts || {};
  const perf = opts.perf || rngOf(opts.seed || 7);
  const recRng = rngOf((opts.seed || 7) + 99);
  const hist = [], plans = [];
  for (let i = 0; i < sessions; i++) {
    const rec = opts.recovery != null ? opts.recovery : Math.round(40 + recRng() * 50);
    const plan = E.generate({
      history: hist, recovery: rec, prefs: opts.prefs, now: T0 + i * DAY + 3600e3,
      seed: (opts.seed || 7) * 1000 + i,
    });
    plans.push(plan);
    hist.push(performSession(plan, i, perf, 40));
  }
  return { hist, plans };
}

console.log('\nLibrary');
test('every exercise has muscle, cue and a unique key', () => {
  const keys = new Set();
  E.LIB.forEach(e => {
    assert(e.muscle, e.name + ' missing muscle');
    assert(e.cue && e.cue.length > 30, e.name + ' needs a real cue');
    assert(!keys.has(e.key), 'duplicate ' + e.name); keys.add(e.key);
  });
});
test('every slot has at least 3 candidates (so variety is possible)', () => {
  Object.entries(E.SLOTS).forEach(([split, slots]) => slots.forEach(s => {
    const n = E.LIB.filter(e => s.pats.includes(e.pat) && (!s.role || e.role === s.role) && !e.core).length;
    assert(n >= 3, split + ' ' + s.id + ' only has ' + n);
  }));
});

console.log('\nPlan structure');
test('plans never duplicate an exercise and stay on-split', () => {
  const { plans } = simulate(64);
  plans.forEach((p, i) => {
    const names = p.exercises.map(e => e.name);
    assert.strictEqual(new Set(names).size, names.length, 'dupes in plan ' + i);
    p.exercises.forEach(e => assert(SPLIT_OK[p.splitCategory].includes(e.muscle), e.name + ' (' + e.muscle + ') off-split on ' + p.splitCategory));
    assert.deepStrictEqual(p.muscleGroups, E.SPLIT_MUSCLES[p.splitCategory]);
    assert(p.exercises[p.exercises.length - 1].isAutoCore, 'core finisher missing');
  });
});
test('rotation follows Push → Pull → Arms & Shoulders → Legs', () => {
  const { plans } = simulate(12, { recovery: 70 });
  const want = ['Push', 'Pull', 'Arms & Shoulders', 'Legs'];
  plans.forEach((p, i) => assert.strictEqual(p.splitCategory, want[i % 4]));
});

console.log('\nVariety (the boredom fix)');
test('≥50% of lifts differ from the last same-split session — every time, any recovery', () => {
  [3, 11, 42].forEach(seed => {
    const { plans } = simulate(64, { seed });
    const lastBySplit = {};
    plans.forEach((p, i) => {
      const prev = lastBySplit[p.splitCategory];
      if (prev) {
        const prevNames = new Set(prev.exercises.map(e => e.libKey));
        const real = p.exercises.filter(e => !e.isAutoCore);
        const fresh = real.filter(e => !prevNames.has(e.libKey)).length;
        assert(fresh / real.length >= 0.5, 'seed ' + seed + ' session ' + i + ' only ' + fresh + '/' + real.length + ' fresh');
      }
      lastBySplit[p.splitCategory] = p;
    });
  });
});
test('core finisher never repeats the previous session\'s core move', () => {
  const { plans } = simulate(40, { recovery: 70 });
  const lastBySplit = {};
  plans.forEach(p => {
    const core = p.exercises[p.exercises.length - 1].name;
    if (lastBySplit[p.splitCategory]) assert.notStrictEqual(core, lastBySplit[p.splitCategory]);
    lastBySplit[p.splitCategory] = core;
  });
});
test('across 16 sessions the lifter sees lots of different exercises', () => {
  const { plans } = simulate(16, { recovery: 70 });
  const all = new Set(); plans.forEach(p => p.exercises.forEach(e => all.add(e.name)));
  assert(all.size >= 45, 'only ' + all.size + ' distinct exercises in a block');
});

console.log('\nAnchors & blocks');
test('anchor lifts are held for the whole 16-session block, then change', () => {
  const { plans } = simulate(48, { recovery: 70 });
  const anchors = (p) => p.exercises.filter(e => e.anchor).map(e => e.slot + ':' + e.name);
  for (let b = 0; b < 3; b++) {
    for (let k = 0; k < 4; k++) {
      const first = anchors(plans[b * 16 + k]);
      for (let w = 1; w < 4; w++) assert.deepStrictEqual(anchors(plans[b * 16 + w * 4 + k]), first, 'block ' + b + ' split ' + k + ' week ' + w);
    }
  }
  // consecutive blocks should rotate the anchors
  let changed = 0, total = 0;
  for (let k = 0; k < 4; k++) {
    const a = anchors(plans[k]), c = anchors(plans[16 + k]);
    a.forEach((x, j) => { total++; if (x !== c[j]) changed++; });
  }
  assert(changed / total >= 0.7, 'only ' + changed + '/' + total + ' anchors rotated');
});
test('"max variety" mode rotates anchors every session', () => {
  const { plans } = simulate(16, { recovery: 70, prefs: { variety: 'max' } });
  for (let k = 0; k < 4; k++) {
    const names = [0, 1, 2, 3].map(w => plans[w * 4 + k].exercises.filter(e => e.anchor).map(e => e.name).join('|'));
    assert(new Set(names).size >= 3, 'max variety kept repeating anchors: ' + names.join(' / '));
  }
});
test('rep zone is constant through a block, then moves on (Volume → Strength → Pump → Volume)', () => {
  const { plans } = simulate(64, { recovery: 70 });
  const zone = i => plans[i].exercises.find(e => e.role === 'compound').reps;
  const expect = ['8-10', '5-7', '10-12', '8-10'];
  for (let b = 0; b < 4; b++) for (let k = 0; k < 16; k++) assert.strictEqual(zone(b * 16 + k), expect[b], 'block ' + (b + 1) + ' session ' + k);
  assert.deepStrictEqual([0, 16, 32, 48].map(i => plans[i].block.phaseName), ['Volume', 'Strength', 'Pump', 'Volume']);
  assert.strictEqual(plans[12].block.deload, true);
  assert.strictEqual(plans[11].block.deload, false);
});
test('deload week has clearly less volume and no intensity techniques', () => {
  const { plans } = simulate(48, { recovery: 70 });
  const vol = p => p.exercises.reduce((a, e) => a + e.sets, 0);
  [0, 16, 32].forEach(b => {
    assert(vol(plans[b + 12]) <= vol(plans[b + 8]) * 0.7, 'block ' + b + ' deload volume ' + vol(plans[b + 12]) + ' vs ' + vol(plans[b + 8]));
    plans.slice(b + 12, b + 16).forEach(p => assert(p.exercises.every(e => e.intensityTechnique === 'straight sets')));
  });
});
test('Pump block applies intensity techniques (with instructions); Strength block does not', () => {
  const { plans } = simulate(48, { recovery: 70 });
  const techs = p => p.exercises.filter(e => e.intensityTechnique !== 'straight sets').length;
  assert(techs(plans[32 + 4]) >= 2, 'pump block should use techniques');
  assert.strictEqual(techs(plans[16 + 4]), 0);
  plans[36].exercises.filter(e => e.intensityTechnique !== 'straight sets').forEach(e => assert(e.techNote));
});
test('held anchors never regress week-to-week inside a block, and the deload is lighter', () => {
  const e1 = ex => ex.targets[0].w * (1 + ex.targets[0].r / 30);
  [9, 21, 33].forEach(seed => {
    const { plans } = simulate(16, { recovery: 70, seed });
    for (let k = 0; k < 4; k++) {
      plans[4 + k].exercises.filter(e => e.anchor && !e.bw).forEach(a2 => {   // bodyweight lifts have no load to compare
        const a3 = plans[8 + k].exercises.find(e => e.name === a2.name);
        const a4 = plans[12 + k].exercises.find(e => e.name === a2.name);
        assert(a3 && a4, 'anchor should be held through weeks 2-4');
        assert(e1(a3) >= e1(a2) * 0.99, 'seed ' + seed + ': ' + a2.name + ' prescription regressed week 2 → 3');
        assert(e1(a4) < e1(a3) * 0.97, a2.name + ' deload should be lighter');
      });
    }
  });
});
test('a lifter who beats every target is asked for more each week (double progression is live)', () => {
  const e1 = ex => ex.targets[0].w * (1 + ex.targets[0].r / 30);
  const { plans } = simulate(16, { recovery: 70, perf: () => 0.7 });       // always target + 1 rep
  let n = 0;
  for (let k = 0; k < 4; k++) {
    plans[4 + k].exercises.filter(e => e.anchor && !e.bw).forEach(a2 => {
      const a3 = plans[8 + k].exercises.find(e => e.name === a2.name);
      assert(e1(a3) > e1(a2), a2.name + ' should step up in week 3 (' + e1(a2).toFixed(1) + ' → ' + e1(a3).toFixed(1) + ')');
      n++;
    });
  }
  assert(n >= 4);
});
test('deload weeks are never used as the baseline for the next prescription', () => {
  const mk = (deload, w) => ({ id: w, date: new Date(T0).toISOString(), splitCategory: 'Push', muscleGroups: ['Chest'], block: { no: 1, week: deload ? 4 : 3, deload },
    exercises: [{ name: 'Barbell Bench Press', slot: 'P1', anchor: true, reps: '8-10', sets: [1, 2, 3].map(() => ({ weight: String(w), reps: '9', done: true })) }] });
  const hist = [mk(false, 100), mk(true, 90)];
  const x = E.exerciseFor('Barbell Bench Press', { history: hist, recovery: 70, now: T0 + 6 * DAY, split: 'Push', slot: 'P1' });
  assert(x.targets[0].w >= 100, 'baseline should be the 100kg working week, got ' + x.targets[0].w);
});

console.log('\nProgression');
const ex = (name) => E.byName(name);
const mkExp = (W, reps, range, daysAgo) => ({ daysAgo: daysAgo || 3, sets: reps.map(r => ({ w: W, r })), W, topReps: reps, range, date: new Date(T0).toISOString() });
test('hit the top of the range on every set → add load, restart at the bottom', () => {
  const p = E.progress(ex('Barbell Bench Press'), [mkExp(80, [10, 10, 10, 10], [8, 10])], { lo: 8, hi: 10, sets: 4 });
  assert.strictEqual(p.kind, 'up'); assert.deepStrictEqual(p.targets[0], { w: 82.5, r: 8 }); assert.strictEqual(p.targets.length, 4);
});
test('inside the range → same weight, +1 rep per set (capped at the top)', () => {
  const p = E.progress(ex('Barbell Bench Press'), [mkExp(80, [10, 9, 8], [8, 10])], { lo: 8, hi: 10, sets: 3 });
  assert.strictEqual(p.kind, 'rep'); assert.deepStrictEqual(p.targets.map(t => t.r), [10, 10, 9]); assert(p.targets.every(t => t.w === 80));
});
test('missed the bottom of the range once → hold; twice → drop ~8%', () => {
  const once = E.progress(ex('Barbell Bench Press'), [mkExp(80, [7, 6, 6], [8, 10])], { lo: 8, hi: 10, sets: 3 });
  assert.strictEqual(once.kind, 'hold'); assert.strictEqual(once.targets[0].w, 80);
  const twice = E.progress(ex('Barbell Bench Press'), [mkExp(80, [7, 6, 6], [8, 10]), mkExp(80, [7, 7, 6], [8, 10])], { lo: 8, hi: 10, sets: 3 });
  assert.strictEqual(twice.kind, 'reset'); assert.strictEqual(twice.targets[0].w, 72.5);
});
test('block shift re-bases weight by effort, not by hope (Volume → Strength)', () => {
  const p = E.progress(ex('Barbell Bench Press'), [mkExp(80, [10, 10, 9], [8, 10])], { lo: 5, hi: 7, sets: 4 });
  assert.strictEqual(p.kind, 'shift-up'); assert(p.targets[0].w >= 87.5 && p.targets[0].w <= 92.5, 'got ' + p.targets[0].w); assert.strictEqual(p.targets[0].r, 5);
  const back = E.progress(ex('Barbell Bench Press'), [mkExp(90, [7, 7, 6, 6], [5, 7])], { lo: 10, hi: 12, sets: 3 });
  assert.strictEqual(back.kind, 'shift-down'); assert(back.targets[0].w < 90 && back.targets[0].w >= 80, 'got ' + back.targets[0].w);
});
test('deload trims load ~10%; long layoff eases back in', () => {
  const d = E.progress(ex('Barbell Bench Press'), [mkExp(100, [8, 8], [8, 10])], { lo: 8, hi: 10, sets: 2, deload: true });
  assert.strictEqual(d.targets[0].w, 90);
  const l = E.progress(ex('Barbell Bench Press'), [mkExp(100, [9, 9, 9], [8, 10], 40)], { lo: 8, hi: 10, sets: 3 });
  assert.strictEqual(l.kind, 'return'); assert(l.targets[0].w < 100);
});
test('timed holds add seconds; bodyweight core adds reps', () => {
  const plank = E.progress(ex('Plank'), [mkExp(0, [30, 35, 30], [30, 45])], { lo: 30, hi: 45, sets: 3 });
  assert.deepStrictEqual(plank.targets.map(t => t.r), [35, 40, 35]);
  const raise = E.progress(ex('Hanging Leg Raise'), [mkExp(0, [12, 12, 11], [10, 12])], { lo: 10, hi: 12, sets: 3 });
  assert.deepStrictEqual(raise.targets.map(t => t.r), [13, 13, 12]);
});
test('never-done exercise → no fabricated weight, flagged as new', () => {
  const p = E.progress(ex('Barbell Bench Press'), [], { lo: 8, hi: 10, sets: 3 });
  assert.strictEqual(p.kind, 'new'); assert.strictEqual(p.targets, null);
});
test('strength is preserved across thousands of prescriptions (no systematic e1RM erosion)', () => {
  // Compare each lift's e1RM with its previous (non-deload) exposure, whatever rep zone either was in.
  const ratios = [];
  [1, 2, 3].forEach(seed => {
    const perf = rngOf(seed), last = {};
    const hist = [];
    for (let i = 0; i < 80; i++) {
      const plan = E.generate({ history: hist, recovery: 70, now: T0 + i * DAY + 3600e3, seed: seed * 1000 + i });
      const sess = performSession(plan, i, perf, 40);
      hist.push(sess);
      plan.exercises.forEach((ex, k) => {
        if (ex.bw || ex.isAutoCore || !ex.targets || plan.block.deload) return;
        const sets = sess.exercises[k].sets;
        const e1 = sets.reduce((m, x) => m + (+x.weight) * (1 + (+x.reps) / 30), 0) / sets.length;
        if (last[ex.name]) ratios.push({ r: e1 / last[ex.name], kind: ex.progression });
        last[ex.name] = e1;
      });
    }
  });
  const mean = ratios.reduce((a, x) => a + x.r, 0) / ratios.length;
  const bigDrops = ratios.filter(x => x.r < 0.93);
  assert(ratios.length > 400);
  assert(mean >= 0.995, 'mean e1RM ratio ' + mean.toFixed(3));
  assert(bigDrops.length / ratios.length <= 0.03, (bigDrops.length / ratios.length * 100).toFixed(1) + '% big drops');
  bigDrops.forEach(x => assert(['return', 'reset'].includes(x.kind), 'unexpected big drop on a "' + x.kind + '" step'));
});
test('plan targets: first-set prefill, warm-ups on heavy anchors, "last" text', () => {
  const hist = [{ id: 1, date: new Date(T0).toISOString(), splitCategory: 'Push', muscleGroups: ['Chest'], exercises: [
    { name: 'Barbell Bench Press', slot: 'P1', anchor: true, reps: '8-10', sets: [1, 2, 3, 4].map(() => ({ weight: '80', reps: '10', done: true })) }] }];
  let found = null;
  for (let seed = 1; seed < 200 && !found; seed++) {
    const p = E.generate({ split: 'Push', history: hist, recovery: 75, seed, now: T0 + 2 * DAY });
    // the engine avoids repeating last session's lifts, so look at the block-shifted exercise directly
    found = p;
  }
  const direct = E.exerciseFor('Barbell Bench Press', { history: hist, recovery: 75, now: T0 + 2 * DAY, split: 'Push', slot: 'P1' });
  assert(/^Last: 80kg × 10, 10, 10, 10/.test(direct.lastText), direct.lastText);
  assert.strictEqual(direct.targets[0].w, 82.5);
  assert(/^Warm-up: /.test(direct.warmup), direct.warmup);
});

console.log('\nRecovery gating');
test('poor recovery → short, light session with no max-effort lifts and no HIIT', () => {
  const { plans } = simulate(32, { recovery: 25 });
  plans.forEach(p => {
    assert(p.exercises.length <= 6, 'too many exercises: ' + p.exercises.length);
    p.exercises.forEach(e => assert(E.byName(e.name).cost < 3, e.name + ' is max-effort'));
    assert(p.cardio.duration <= 15 && !/Sprint|Interval/.test(p.cardio.machine));
  });
});
test('low recovery (34–49) drops max-effort lifts and trims compound sets', () => {
  const { plans } = simulate(16, { recovery: 45 });
  plans.forEach(p => p.exercises.forEach(e => assert(E.byName(e.name).cost < 3, e.name)));
});
test('great recovery (≥80) gets the bonus slot and may get HIIT', () => {
  const { plans } = simulate(32, { recovery: 90 });
  assert(plans.every(p => p.exercises.length === 9 || p.block.deload), 'expected 8 slots + core');
  assert(plans.some(p => /Sprint|Interval/.test(p.cardio.machine)), 'HIIT never offered at 90% recovery');
});
test('no recovery entered → treated as moderate, and says so', () => {
  const p = E.generate({ split: 'Pull', history: [], recovery: null, seed: 1 });
  assert.strictEqual(p.tier.key, 'mod'); assert(/No recovery entered/.test(p.coachNote));
});

console.log('\nCardio');
test('finisher rotates machine (never the same two sessions running)', () => {
  const { plans } = simulate(40, { recovery: 60 });
  for (let i = 1; i < plans.length; i++) assert.notStrictEqual(plans[i].cardio.key, plans[i - 1].cardio.key, 'session ' + i);
  assert(new Set(plans.map(p => p.cardio.key)).size >= 4);
});
test('cardio object is renderable by the legacy fields too', () => {
  const { plans } = simulate(10);
  plans.forEach(p => { const c = p.cardio; assert(c.machine && c.duration > 0 && Array.isArray(c.specs) && c.specs.length === 3); });
});

console.log('\nOperations');
test('swapOne returns a fresh, non-duplicate lift for the same slot and remembers rejects', () => {
  const { hist } = simulate(8, { recovery: 70 });
  const input = { history: hist, recovery: 70, now: T0 + 9 * DAY };
  const plan = E.generate(Object.assign({ seed: 3 }, input));
  const i = plan.exercises.findIndex(e => e.slot === 'P5');           // lateral-raise slot: 7 options
  const old = plan.exercises[i];
  const seen = new Set([old.name]);
  for (let k = 0; k < 4; k++) {
    const n = E.swapOne(plan, i, Object.assign({ seed: 50 + k }, input));
    assert(n && n.slot === old.slot, 'swap returned ' + (n && n.name));
    assert(!seen.has(n.name), 'repeated ' + n.name + ' after ' + [...seen].join(', '));
    seen.add(n.name);
    assert.strictEqual(new Set(plan.exercises.map(e => e.name)).size, plan.exercises.length);
  }
  assert.strictEqual(plan.rejected.length, 4);
});
test('swapOne never hands back the lift it is replacing, even when the pool is exhausted', () => {
  const plan = E.generate({ split: 'Push', history: [], recovery: 70, seed: 8 });
  const i = plan.exercises.findIndex(e => e.slot === 'P4');           // 4-option fly slot
  for (let k = 0; k < 10; k++) {
    const before = plan.exercises[i].name;
    const n = E.swapOne(plan, i, { history: [], recovery: 70, seed: k });
    if (n) assert.notStrictEqual(n.name, before);
    assert.strictEqual(new Set(plan.exercises.map(e => e.name)).size, plan.exercises.length);
  }
});
test('suggestExtras: ≤3 new lifts for the least-covered muscles, with reasons', () => {
  const plan = E.generate({ split: 'Push', history: [], recovery: 70, seed: 2 });
  const session = { splitCategory: 'Push', block: plan.block, exercises: plan.exercises.map(e => ({ name: e.name, sets: Array(e.sets).fill({}) })) };
  const extras = E.suggestExtras(session, { history: [], recovery: 70 });
  assert(extras.length >= 1 && extras.length <= 3);
  const have = new Set(session.exercises.map(e => e.name));
  extras.forEach(x => { assert(!have.has(x.name)); assert(x.reason && x.sets > 0); });
});
test('legacy (pre-engine, AI-era) history is understood: names normalise, no crash', () => {
  const legacy = [
    { date: '2026-01-02T08:00:00Z', splitName: 'Push — Heavy Chest', muscleGroups: ['Chest', 'Shoulders', 'Triceps'], exercises: [
      { name: 'Incline DB Press', sets: [{ weight: '30', reps: '10', done: true }] },
      { name: 'Cable Lateral Raise', swappedTo: 'Dumbbell Lateral Raise', sets: [{ weight: '10', reps: '12', done: true }] }] },
    { date: '2026-01-03T08:00:00Z', splitName: 'Legs', muscleGroups: ['Quads', 'Hamstrings'], exercises: [] },
  ];
  assert.strictEqual(E.nextSplit(legacy), 'Arms & Shoulders'.replace('Arms & Shoulders', 'Push'));
  const p = E.generate({ split: 'Push', history: legacy, recovery: 70, seed: 4, now: Date.parse('2026-01-06') });
  assert(!p.exercises.some(e => e.name === 'Incline Dumbbell Press'), 'should avoid last push day\'s incline DB press');
  assert.strictEqual(E.classifySplit({ muscleGroups: ['Lateral Delts', 'Biceps'] }), 'Arms & Shoulders', '"lateral" must not read as "lat" → Pull');
});

console.log('\nPerformance');
test('generates in well under a frame even with a year of history', () => {
  const { hist } = simulate(200, { recovery: 70 });
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 50; i++) E.generate({ history: hist, recovery: 70, now: T0 + 201 * DAY, seed: i });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 50;
  console.log('    avg generate(): ' + ms.toFixed(2) + ' ms with ' + hist.length + ' sessions');
  assert(ms < 16, 'too slow: ' + ms + 'ms');
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ' — FAILURES ABOVE' : ''));
