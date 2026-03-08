
const PROXY='https://reborn-proxy.bormotyt.workers.dev';
const TARGETS={cal:2340,p:128,c:200,f:65};
const BASELINE={weight:89.1,bf:25.1,fatMass:22.4};
const GOAL_BF=20.1;
const CIRC=232.5;
const CUPS=8;
const ML_PER_CUP=250;
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
const DOWS=['Su','Mo','Tu','We','Th','Fr','Sa'];
const KEY='rb5';

const SNAP_CFG=[
  {label:'Wake Up',sub:'Log sleep and recovery from this morning.',fields:[
    {id:'sleep',label:'Sleep',ph:'5:42',step:'',inputType:'sleep'},
    {id:'recovery',label:'Recovery %',ph:'e.g. 72',step:'1'},
  ]},
  {label:'1 PM',sub:'Log your mid-day Whoop stats.',fields:[
    {id:'strain',label:'Strain so far',ph:'e.g. 8.2',step:'0.1'},
    {id:'burned',label:'Cals Burned',ph:'e.g. 1200',step:'10'},
    {id:'steps',label:'Steps',ph:'e.g. 4500',step:'100'},
  ]},
  {label:'10 PM',sub:'Log your final Whoop stats for the day.',fields:[
    {id:'strain',label:'Final Strain',ph:'e.g. 14.5',step:'0.1'},
    {id:'burned',label:'Total Burned',ph:'e.g. 2800',step:'10'},
    {id:'steps',label:'Total Steps',ph:'e.g. 9200',step:'100'},
  ]},
];

const todayKey=()=>new Date().toISOString().slice(0,10);
const load=(k,d)=>{try{return JSON.parse(localStorage.getItem(k))??d}catch{return d}};
const save=(k,v)=>localStorage.setItem(k,JSON.stringify(v));
const gv=id=>document.getElementById(id);

const DEFAULT_QA=[
  {id:'ghost-pre',  name:'GHOST Pre',      emoji:'⚡',calories:5,  protein:0, carbs:1,fat:0},
  {id:'ghost-whey', name:'GHOST Whey',     emoji:'🥛',calories:110,protein:25,carbs:3,fat:1},
  {id:'banana',     name:'Banana',         emoji:'🍌',calories:89, protein:1, carbs:23,fat:0},
  {id:'date',       name:'Date',           emoji:'🟤',calories:20, protein:0, carbs:5, fat:0},
  {id:'egg',        name:'Hard Boiled Egg',emoji:'🥚',calories:78, protein:6, carbs:1, fat:5},
  {id:'nada',       name:'NADA Yogurt',    emoji:'🫙',calories:130,protein:30,carbs:9, fat:0},
];

// STATE
let meals      =load(`${KEY}_meals_${todayKey()}`,[]);
let whoopSnaps =load(`${KEY}_whoopsnaps_${todayKey()}`,[null,null,null]);
let cups       =parseInt(localStorage.getItem(`${KEY}_cups_${todayKey()}`)||'0');
let entries    =load(`${KEY}_entries`,[]);
let quickItems =load(`${KEY}_quickitems`,DEFAULT_QA);
let calViewDate=new Date();
let calSelKey  =todayKey();
let mealB64    =null;
let ingredients=[];
let activeTab  =0;

// BOOT
const _n=new Date();
gv('hdr-date').innerHTML=_n.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})+'<br>'+_n.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
gv('coach-date').textContent=_n.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
renderAll();
initWelcomeCard();

function renderAll(){
  renderWhoopCard();renderSummary();renderRings();
  renderCups();renderFoodList();renderQuickAdd();
  renderProgress();buildCalendar();updateCoachStats();
  // refresh smart subtitle with latest stats
  const sub=gv('wc-sub');if(sub)sub.textContent=getSmartSub();
}

// NAV
function showPage(id,btn){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nb').forEach(b=>b.classList.remove('active'));
  gv('pg-'+id).classList.add('active');btn.classList.add('active');
  gv('pg-'+id).scrollTop=0;
  if(id==='calendar')buildCalendar();
  if(id==='coach')updateCoachStats();
}

// ── WHOOP 3-SNAPSHOT ──
function selectWhoopTab(i){
  activeTab=i;
  document.querySelectorAll('.wh-tab').forEach((t,j)=>t.classList.toggle('active',j===i));
  renderWhoopSnap();
}
function renderWhoopCard(){
  whoopSnaps.forEach((s,i)=>{const t=gv(`wh-tab-${i}`);if(t)t.classList.toggle('has-data',s!==null);});
  renderWhoopSnap();
}
function renderWhoopSnap(){
  const snap=whoopSnaps[activeTab];
  const el=gv('wh-snap-display');
  if(!snap){el.innerHTML=`<div class="wh-empty">No data yet. Tap <strong>+ Log Snapshot</strong> to add ${SNAP_CFG[activeTab].label} data.</div>`;return;}
  const cfg=SNAP_CFG[activeTab];
  const items=cfg.fields.map(f=>{
    const v=snap[f.id];if(v==null)return'';
    let d;
    if(f.id==='steps') d=Number(v).toLocaleString();
    else if(f.id==='recovery') d=v+'%';
    else if(f.id==='sleep'){
      const hh=Math.floor(v), mm=Math.round((v-hh)*60);
      d=hh+'h '+(mm>0?mm+'m':'');
    } else d=v;
    return`<div class="wh-s"><div class="wh-v">${d}</div><div class="wh-l">${f.label}</div></div>`;
  }).filter(Boolean);
  const cols=items.length<=2?'wh-grid-2':'wh-grid-3';
  el.innerHTML=`<div class="wh-grid ${cols}">${items.join('')}</div>`;
}
function openWhoopModal(){
  const cfg=SNAP_CFG[activeTab];
  const snap=whoopSnaps[activeTab]||{};
  gv('whoop-modal-title').textContent=`WHOOP · ${cfg.label}`;
  gv('whoop-modal-sub').textContent=cfg.sub;
  let html='';
  for(let i=0;i<cfg.fields.length;i+=2){
    html+='<div class="frow">';
    for(let j=i;j<Math.min(i+2,cfg.fields.length);j++){
      const f=cfg.fields[j];
      if(f.inputType==='sleep'){
        const dec=snap[f.id];
        const hhmm=dec!=null?Math.floor(dec)+':'+(Math.round((dec-Math.floor(dec))*60)+'').padStart(2,'0'):'';
        html+=`<div><label class="flbl">${f.label} <span style="color:var(--muted);font-size:10px">(h:mm)</span></label><input type="text" id="wf-${f.id}" placeholder="${f.ph}" value="${hhmm}" inputmode="decimal"/></div>`;
      } else {
        html+=`<div><label class="flbl">${f.label}</label><input type="number" id="wf-${f.id}" placeholder="${f.ph}" step="${f.step}" value="${snap[f.id]??''}"/></div>`;
      }
    }
    html+='</div>';
  }
  if(activeTab===0||activeTab===2){
    const g=snap.goal||'cut';
    html+=`<div class="frow"><div><label class="flbl">Goal</label><select id="wf-goal"><option value="cut"${g==='cut'?' selected':''}>Cut (−400 kcal)</option><option value="maintain"${g==='maintain'?' selected':''}>Maintain</option><option value="bulk"${g==='bulk'?' selected':''}>Bulk (+300 kcal)</option></select></div></div>`;
  }
  gv('whoop-modal-fields').innerHTML=html;
  gv('whoop-modal').classList.add('open');
}
function closeWhoopModal(){gv('whoop-modal').classList.remove('open');}
function saveWhoop(){
  const cfg=SNAP_CFG[activeTab];
  const snap={};
  cfg.fields.forEach(f=>{
    const el=gv(`wf-${f.id}`);
    if(!el||el.value==='')return;
    if(f.inputType==='sleep'){
      // parse h:mm -> decimal hours
      const v=el.value.trim();
      if(v.includes(':')){
        const [hh,mm]=v.split(':');
        snap[f.id]=Math.round((parseInt(hh||0)+parseInt(mm||0)/60)*100)/100;
      } else {
        snap[f.id]=parseFloat(v)||0;
      }
    } else {
      snap[f.id]=f.id==='steps'?parseInt(el.value):parseFloat(el.value);
    }
  });
  const ge=gv('wf-goal');if(ge)snap.goal=ge.value;
  whoopSnaps[activeTab]=snap;
  save(`${KEY}_whoopsnaps_${todayKey()}`,whoopSnaps);
  closeWhoopModal();renderAll();
}
function getCalTarget(){
  for(let i=2;i>=0;i--){
    const s=whoopSnaps[i];
    if(s&&s.burned){
      const g=s.goal||(whoopSnaps[0]&&whoopSnaps[0].goal)||'cut';
      let t=s.burned;
      if(g==='cut')t-=400;if(g==='bulk')t+=300;
      return Math.max(1500,Math.round(t));
    }
  }
  return TARGETS.cal;
}

// SUMMARY
function getTotals(arr){return(arr||meals).reduce((a,m)=>({cal:a.cal+m.calories,p:a.p+m.protein,c:a.c+m.carbs,f:a.f+m.fat}),{cal:0,p:0,c:0,f:0});}
function renderSummary(){
  const t=getTotals();
  gv('cal-num').innerHTML=Math.round(t.cal)+'<sup>kcal</sup>';
  const tgt=getCalTarget(),rem=Math.round(tgt-t.cal),pct=t.cal/tgt;
  const rEl=gv('cal-rem');
  rEl.textContent=rem>=0?rem+' left':Math.abs(rem)+' over';
  rEl.className='cal-rem'+(rem<0?' over':pct>0.85?' good':'');
  gv('cal-tlbl').textContent='of '+tgt.toLocaleString()+' kcal target';
  const bar=gv('cal-bar');
  bar.style.width=Math.min(pct*100,100)+'%';
  bar.className='pbar-f'+(t.cal>tgt?' over':pct>0.85?' warn':'');
}

// RINGS
function renderRings(){
  const t=getTotals();
  setRing('rp','rp-v','rp-pct',t.p,TARGETS.p,'g');
  setRing('rc','rc-v','rc-pct',t.c,TARGETS.c,'g');
  setRing('rf','rf-v','rf-pct',t.f,TARGETS.f,'g');
}
function setRing(id,vid,pid,cur,tgt,unit){
  const pct=Math.min(cur/tgt,1);
  gv(id).style.strokeDashoffset=CIRC-pct*CIRC;
  gv(vid).textContent=Math.round(cur)+unit;
  gv(pid).textContent=Math.round(pct*100)+'%';
}

// CUPS
function renderCups(){
  const grid=gv('cups-grid');grid.innerHTML='';
  for(let i=0;i<CUPS;i++){
    const btn=document.createElement('button');
    btn.className='cup-btn'+(i<cups?' filled':'');
    btn.innerHTML=i<cups?'💧':'○';
    btn.addEventListener('click',()=>{cups=i<cups?i:i+1;localStorage.setItem(`${KEY}_cups_${todayKey()}`,cups);renderCups();});
    grid.appendChild(btn);
  }
  gv('water-cups').textContent=cups;
  gv('water-ml-display').textContent=(cups*ML_PER_CUP).toLocaleString();
  gv('water-bar').style.width=Math.min((cups/CUPS)*100,100)+'%';
}
function resetWater(){cups=0;localStorage.setItem(`${KEY}_cups_${todayKey()}`,0);renderCups();}

// QUICK ADD
function renderQuickAdd(){
  const el=gv('qa-scroll');
  el.innerHTML='';
  for(const item of quickItems){
    const div=document.createElement('div');
    div.className='qa-item';
    div.innerHTML=`<div class="qa-icon">${item.emoji}</div><div class="qa-name">${item.name}</div><div class="qa-kcal">${item.calories} kcal</div><button class="qa-del" title="Remove">✕</button>`;
    div.querySelector('.qa-del').addEventListener('click',(e)=>{
      e.stopPropagation();
      deleteQAItem(item.id);
    });
    div.addEventListener('click',()=>quickLog(item.id));
    el.appendChild(div);
  }
  const addBtn=document.createElement('div');
  addBtn.className='qa-add';
  addBtn.innerHTML=`<div style="font-size:20px">＋</div><div style="font-size:9px">Add</div>`;
  addBtn.addEventListener('click',openQAModal);
  el.appendChild(addBtn);
}
function deleteQAItem(id){
  if(!confirm('Remove this item from Quick Add?'))return;
  quickItems=quickItems.filter(i=>i.id!==id);
  save(`${KEY}_quickitems`,quickItems);
  renderQuickAdd();
}
let _quickLock=false;
function quickLog(id){
  if(_quickLock)return;
  const item=quickItems.find(i=>i.id===id);if(!item)return;
  _quickLock=true;
  meals.push({name:item.name,emoji:item.emoji,calories:item.calories,protein:item.protein,carbs:item.carbs,fat:item.fat,thumb:null});
  save(`${KEY}_meals_${todayKey()}`,meals);
  renderAll();
  setTimeout(()=>{ _quickLock=false; },600);
}
function openQAModal(){['qa-name-in','qa-emoji-in','qa-cal-in','qa-p-in','qa-c-in','qa-f-in'].forEach(id=>gv(id).value='');gv('qa-loading').classList.remove('show');gv('qa-modal').classList.add('open');}
function closeQAModal(){gv('qa-modal').classList.remove('open');}
async function aiLookupQA(){
  const name=gv('qa-name-in').value.trim();if(!name){alert('Enter a name first.');return;}
  gv('qa-loading').classList.add('show');
  try{
    const res=await fetch(PROXY,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:300,
        system:'Return ONLY valid JSON, no markdown: {"emoji":"single emoji","calories":number,"protein":number,"carbs":number,"fat":number}',
        messages:[{role:'user',content:`Nutrition facts for: ${name}. Use official label if branded.`}]})});
    const data=await res.json();
    const p=JSON.parse(data.content.map(b=>b.text||'').join('').replace(/```json|```/g,'').trim());
    if(p.emoji)gv('qa-emoji-in').value=p.emoji;
    if(p.calories)gv('qa-cal-in').value=p.calories;
    if(p.protein)gv('qa-p-in').value=p.protein;
    if(p.carbs)gv('qa-c-in').value=p.carbs;
    if(p.fat)gv('qa-f-in').value=p.fat;
  }catch(e){alert('Lookup failed.');}
  finally{gv('qa-loading').classList.remove('show');}
}
function saveQAItem(){
  const name=gv('qa-name-in').value.trim();if(!name){alert('Enter a name.');return;}
  quickItems.push({id:'custom_'+Date.now(),name,emoji:gv('qa-emoji-in').value||'🍽️',
    calories:parseFloat(gv('qa-cal-in').value)||0,protein:parseFloat(gv('qa-p-in').value)||0,
    carbs:parseFloat(gv('qa-c-in').value)||0,fat:parseFloat(gv('qa-f-in').value)||0});
  save(`${KEY}_quickitems`,quickItems);closeQAModal();renderQuickAdd();
}

// FOOD LIST
function renderFoodList(){
  const el=gv('food-list');
  if(!meals.length){el.innerHTML='<div class="empty-st"><span class="empty-icon">🍽️</span>No meals logged yet.<br>Tap Log a Meal or Quick Add.</div>';return;}
  el.innerHTML='';
  for(let i=0;i<meals.length;i++){
    const m=meals[i];const div=document.createElement('div');div.className='fi';
    const th=m.thumb?`<img class="fi-thumb" src="${m.thumb}" style="width:50px;height:50px;border-radius:12px;object-fit:cover;flex-shrink:0"/>`:`<div class="fi-thumb">${m.emoji||'🍽️'}</div>`;
    div.innerHTML=`${th}<div class="fi-info"><div class="fi-name">${m.name}</div><div class="fi-tags"><span class="ft ftcal">${Math.round(m.calories)} kcal</span><span class="ft ftp">${Math.round(m.protein)}g P</span><span class="ft ftc">${Math.round(m.carbs)}g C</span><span class="ft ftf">${Math.round(m.fat)}g F</span></div></div><button class="fi-del">✕</button>`;
    div.querySelector('.fi-del').addEventListener('click',()=>deleteMeal(i));
    el.appendChild(div);
  }
}
function deleteMeal(i){meals.splice(i,1);save(`${KEY}_meals_${todayKey()}`,meals);renderAll();}

// LOG MODAL
function openLogModal(){resetLogModal();gv('log-modal').classList.add('open');}
function closeLogModal(){gv('log-modal').classList.remove('open');resetLogModal();}
function resetLogModal(){
  mealB64=null;ingredients=[];
  gv('preview').style.display='none';gv('ph-ph').style.display='block';
  gv('photo-zone').classList.remove('has-img');
  gv('meal-desc').value='';gv('ing-results').style.display='none';
  gv('ing-list').innerHTML='';gv('btn-analyze').textContent='ANALYSE MEAL';
  gv('btn-analyze').disabled=false;gv('meal-loading').classList.remove('show');
  gv('file-meal').value='';
  const aif=gv('add-ing-form');if(aif)aif.style.display='none';
}
function handleMealPhoto(e){
  const file=e.target.files[0];if(!file)return;
  const r=new FileReader();
  r.onload=ev=>{mealB64=ev.target.result.split(',')[1];gv('preview').src=ev.target.result;gv('preview').style.display='block';gv('ph-ph').style.display='none';gv('photo-zone').classList.add('has-img');};
  r.readAsDataURL(file);
}

async function analyzeMeal(){
  const desc=gv('meal-desc').value.trim();
  if(!mealB64&&!desc){alert('Add a photo or description first.');return;}
  gv('btn-analyze').disabled=true;gv('meal-loading').classList.add('show');gv('ing-results').style.display='none';
  const content=[];
  if(mealB64)content.push({type:'image',source:{type:'base64',media_type:'image/jpeg',data:mealB64}});
  const prompt=desc?(mealB64?`Analyse this food. Context: "${desc}". Identify every visible ingredient.`:`Identify ingredients and macros for: "${desc}". Use official label for branded products.`):'Identify every ingredient in this food image separately.';
  content.push({type:'text',text:prompt});
  try{
    const res=await fetch(PROXY,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:1500,
        system:`Precise nutrition expert. Identify each ingredient separately.
Return ONLY valid JSON, no markdown:
{"confidence":"high"|"medium"|"low","confidence_tip":"one sentence or empty","ingredients":[{"name":"name","emoji":"emoji","portion":"e.g. 80g","calories":number,"protein":number,"carbs":number,"fat":number}]}
Identify 2-8 ingredients. Use official macros for branded products.`,
        messages:[{role:'user',content}]})});
    const data=await res.json();
    const raw=data.content.map(b=>b.text||'').join('').replace(/```json|```/g,'').trim();
    const parsed=JSON.parse(raw);
    ingredients=parsed.ingredients.map((ing,i)=>({...ing,id:i,portion_multiplier:1,selected:true}));
    const conf=parsed.confidence||'medium';
    const cm={high:{cls:'conf-high',icon:'✓',label:'High Confidence'},medium:{cls:'conf-medium',icon:'~',label:'Medium Confidence'},low:{cls:'conf-low',icon:'!',label:'Low Confidence'}};
    const c=cm[conf];
    gv('conf-badge-wrap').innerHTML=`<div class="conf-badge ${c.cls}">${c.icon} ${c.label}</div>`;
    const te=gv('conf-tip');
    if(parsed.confidence_tip&&conf!=='high'){te.textContent='💡 '+parsed.confidence_tip;te.classList.add('show');}
    else te.classList.remove('show');
    renderIngredients();gv('ing-results').style.display='block';
    gv('btn-analyze').textContent='RE-ANALYSE';
  }catch(err){alert('Analysis failed. Please try again.');console.error(err);}
  finally{gv('btn-analyze').disabled=false;gv('meal-loading').classList.remove('show');}
}

function renderIngredients(){
  const el=gv('ing-list');el.innerHTML='';
  for(const ing of ingredients){
    const div=document.createElement('div');
    div.className='ing-item'+(ing.selected?' selected':'');
    const pm=ing.portion_multiplier;
    const cal=Math.round(ing.calories*pm),p=Math.round(ing.protein*pm*10)/10,c=Math.round(ing.carbs*pm*10)/10,f=Math.round(ing.fat*pm*10)/10;
    const pBtns=[.5,.75,1,1.5,2].map(v=>`<button class="pbtn${pm===v?' active':''}" onclick="setMultiplier(${ing.id},${v})">${v===1?'Full':v+'×'}</button>`).join('');
    div.innerHTML=`<div class="ing-top"><div class="ing-check" onclick="toggleIng(${ing.id})"><span class="ing-check-icon">✓</span></div><div class="ing-emoji">${ing.emoji}</div><div class="ing-name">${ing.name}</div></div>
    <div class="ing-macros"><span class="ing-m" style="color:var(--muted)">${ing.portion}</span><span class="ing-m" style="color:var(--lime)">${cal} kcal</span><span class="ing-m" style="color:var(--pc)">${p}g P</span><span class="ing-m" style="color:var(--cc)">${c}g C</span><span class="ing-m" style="color:var(--fc)">${f}g F</span></div>
    <div class="portion-row"><span class="portion-lbl">Portion:</span><div class="portion-btns">${pBtns}</div></div>`;
    el.appendChild(div);
  }
  updateSelTotals();
}
function toggleIng(id){const ing=ingredients.find(i=>i.id===id);if(ing){ing.selected=!ing.selected;renderIngredients();}}
function setMultiplier(id,val){const ing=ingredients.find(i=>i.id===id);if(ing){ing.portion_multiplier=val;renderIngredients();}}
function updateSelTotals(){
  const sel=ingredients.filter(i=>i.selected);
  const t=sel.reduce((a,i)=>({cal:a.cal+i.calories*i.portion_multiplier,p:a.p+i.protein*i.portion_multiplier,c:a.c+i.carbs*i.portion_multiplier,f:a.f+i.fat*i.portion_multiplier}),{cal:0,p:0,c:0,f:0});
  gv('sel-cal').textContent=Math.round(t.cal)+' kcal';
  gv('sel-p').textContent=Math.round(t.p)+'g P';
  gv('sel-c').textContent=Math.round(t.c)+'g C';
  gv('sel-f').textContent=Math.round(t.f)+'g F';
}

// ADD MISSING INGREDIENT
function toggleAddIngForm(){
  const f=gv('add-ing-form');
  f.style.display=f.style.display==='block'?'none':'block';
  if(f.style.display==='block'){gv('add-ing-name').focus();}
}
async function aiLookupIngredient(){
  const name=gv('add-ing-name').value.trim();if(!name){alert('Enter ingredient name first.');return;}
  gv('ing-lookup-loading').classList.add('show');
  try{
    const res=await fetch(PROXY,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:300,
        system:'Return ONLY valid JSON, no markdown: {"emoji":"emoji","portion":"portion description","calories":number,"protein":number,"carbs":number,"fat":number}',
        messages:[{role:'user',content:`Nutrition facts for: ${name}`}]})});
    const data=await res.json();
    const p=JSON.parse(data.content.map(b=>b.text||'').join('').replace(/```json|```/g,'').trim());
    if(p.emoji)gv('add-ing-emoji').value=p.emoji;
    if(p.calories)gv('add-ing-cal').value=p.calories;
    if(p.protein)gv('add-ing-p').value=p.protein;
    if(p.carbs)gv('add-ing-c').value=p.carbs;
    if(p.fat)gv('add-ing-f').value=p.fat;
    if(p.portion)gv('add-ing-portion').value=p.portion;
  }catch(e){alert('Lookup failed. Fill in manually.');}
  finally{gv('ing-lookup-loading').classList.remove('show');}
}
function addManualIngredient(){
  const name=gv('add-ing-name').value.trim();if(!name){alert('Enter a name.');return;}
  const newId=ingredients.length>0?Math.max(...ingredients.map(i=>i.id))+1:0;
  ingredients.push({id:newId,name,emoji:gv('add-ing-emoji').value||'🍽️',
    portion:gv('add-ing-portion').value||'1 serving',
    calories:parseFloat(gv('add-ing-cal').value)||0,
    protein:parseFloat(gv('add-ing-p').value)||0,
    carbs:parseFloat(gv('add-ing-c').value)||0,
    fat:parseFloat(gv('add-ing-f').value)||0,
    portion_multiplier:1,selected:true});
  ['add-ing-name','add-ing-emoji','add-ing-cal','add-ing-p','add-ing-c','add-ing-f','add-ing-portion'].forEach(id=>gv(id).value='');
  gv('add-ing-form').style.display='none';
  renderIngredients();
}

let _confirmLock=false;
function confirmMeal(){
  if(_confirmLock)return;
  const sel=ingredients.filter(i=>i.selected);
  if(!sel.length){alert('Select at least one ingredient.');return;}
  _confirmLock=true;

  const t=sel.reduce((a,i)=>({
    cal:a.cal+i.calories*i.portion_multiplier,
    p:a.p+i.protein*i.portion_multiplier,
    c:a.c+i.carbs*i.portion_multiplier,
    f:a.f+i.fat*i.portion_multiplier
  }),{cal:0,p:0,c:0,f:0});

  // CRITICAL: never store base64 thumb in localStorage — causes silent quota failures
  // Keep thumb in-memory on the entry only for the live session display
  const thumb = mealB64 ? `data:image/jpeg;base64,${mealB64}` : null;
  const entry = {
    name: sel.length===1 ? sel[0].name : sel.map(i=>i.name).join(' + '),
    emoji: sel[0].emoji,
    calories: Math.round(t.cal),
    protein: Math.round(t.p*10)/10,
    carbs: Math.round(t.c*10)/10,
    fat: Math.round(t.f*10)/10,
    thumb: null  // never persist thumb — only attach for live display below
  };

  // Push to in-memory array and persist (without thumb — safe size)
  meals.push(entry);
  save(`${KEY}_meals_${todayKey()}`, meals);

  // Attach thumb to in-memory object only (for live session display, not persisted)
  entry.thumb = thumb;

  // Close and reset modal synchronously
  gv('log-modal').classList.remove('open');
  resetLogModal();

  // Update UI immediately
  renderAll();

  // Navigate to today
  const todayBtn = document.querySelector('.nb');
  if(todayBtn) showPage('today', todayBtn);

  setTimeout(()=>{ _confirmLock=false; }, 800);
}

// AI COACH
function updateCoachStats(){
  const t=getTotals();
  gv('cs-cal').textContent=Math.round(t.cal)||'—';
  gv('cs-protein').textContent=Math.round(t.p)||'—';
  gv('cs-water').textContent=cups*ML_PER_CUP||'—';
}
// Day context string — reused for coach chat
function getDayContext(){
  const t=getTotals();
  const ws=whoopSnaps;
  const mealSum=meals.map(m=>`${m.name}: ${Math.round(m.calories)} kcal, ${Math.round(m.protein)}g P, ${Math.round(m.carbs)}g C, ${Math.round(m.fat)}g F`).join('\n');
  const whoopSum=`Wake: Sleep ${ws[0]?.sleep??'—'}h, Recovery ${ws[0]?.recovery??'—'}%\n1PM: Strain ${ws[1]?.strain??'—'}, Burned ${ws[1]?.burned??'—'} kcal, Steps ${ws[1]?.steps??'—'}\nEOD: Strain ${ws[2]?.strain??'—'}, Burned ${ws[2]?.burned??'—'} kcal, Steps ${ws[2]?.steps??'—'}`;
  return `BORNA'S DATA TODAY:\nMEALS:\n${mealSum||'None logged'}\nTOTALS: ${Math.round(t.cal)} kcal, ${Math.round(t.p)}g P, ${Math.round(t.c)}g C, ${Math.round(t.f)}g F\nTARGET: ${getCalTarget()} kcal (cut phase)\nMACRO TARGETS: 128g P, 200g C, 65g F\nWHOOP:\n${whoopSum}\nWATER: ${cups} cups (${cups*ML_PER_CUP}ml) / 8 cups\nPROFILE: Male, 26, 89.1kg, 25.1% BF, goal 20.1% BF by Apr 27 2026`;
}

let chatHistory=[];

async function generateCoachReport(){
  if(!meals.length&&!whoopSnaps.some(s=>s!==null)){alert('Log some meals or Whoop data first.');return;}
  gv('coach-loading').classList.add('show');gv('coach-response').classList.remove('show');
  gv('coach-chat').classList.remove('show');
  chatHistory=[];
  const ctx=getDayContext();
  const prompt=`${ctx}\n\nGive me a direct daily debrief:\n1. OVERALL SCORE (1-10, one punchy line)\n2. NUTRITION (specific callouts)\n3. RECOVERY & ACTIVITY\n4. TOP 3 ACTIONS FOR TOMORROW\n\nDirect. No fluff.`;
  try{
    const res=await fetch(PROXY,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:900,
        system:'You are a direct, no-nonsense performance and nutrition coach for Borna. Honest, specific, actionable. No filler.',
        messages:[{role:'user',content:prompt}]})});
    const data=await res.json();
    const text=data.content.map(b=>b.text||'').join('').trim();
    const re=gv('coach-response');
    re.innerHTML=`<div class="cr-header"><div class="cr-icon">🧠</div><div><div class="cr-title">Daily Debrief</div><div class="cr-time">${new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}</div></div></div><div class="cr-body">${text.replace(/\n/g,'<br>')}</div>`;
    re.classList.add('show');
    // Store debrief in chat history as context
    chatHistory=[
      {role:'user',content:prompt},
      {role:'assistant',content:text}
    ];
    // Show chat
    gv('chat-messages').innerHTML='';
    gv('coach-chat').classList.add('show');
  }catch(err){alert('Report failed.');console.error(err);}
  finally{gv('coach-loading').classList.remove('show');}
}

function handleChatKey(e){
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChatMessage();}
}

async function sendChatMessage(){
  const inp=gv('chat-input');
  const msg=inp.value.trim();if(!msg)return;
  inp.value='';inp.style.height='auto';

  const msgEl=gv('chat-messages');
  // Add user bubble
  const uDiv=document.createElement('div');
  uDiv.className='chat-msg user';uDiv.textContent=msg;
  msgEl.appendChild(uDiv);

  // Add loading bubble
  const lDiv=document.createElement('div');
  lDiv.className='chat-msg loading';lDiv.textContent='…';
  msgEl.appendChild(lDiv);
  msgEl.scrollTop=msgEl.scrollHeight;

  // Build messages — always include day context as system + history
  chatHistory.push({role:'user',content:msg});

  try{
    const res=await fetch(PROXY,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:600,
        system:`You are a direct, no-nonsense performance and nutrition coach for Borna. You have full context of his day. Be specific, honest, and actionable. Keep replies concise.\n\n${getDayContext()}`,
        messages:chatHistory})});
    const data=await res.json();
    const reply=data.content.map(b=>b.text||'').join('').trim();
    chatHistory.push({role:'assistant',content:reply});
    lDiv.className='chat-msg coach';
    lDiv.innerHTML=reply.replace(/\n/g,'<br>');
  }catch(err){
    lDiv.className='chat-msg coach';
    lDiv.textContent='Something went wrong. Try again.';
    chatHistory.pop();
  }
  msgEl.scrollTop=msgEl.scrollHeight;
}

// ── WELCOME CARD ──────────────────────────────────
const WMO_CODES={0:'Clear sky',1:'Mainly clear',2:'Partly cloudy',3:'Overcast',45:'Foggy',48:'Icy fog',51:'Light drizzle',53:'Drizzle',55:'Heavy drizzle',61:'Light rain',63:'Rain',65:'Heavy rain',71:'Light snow',73:'Snow',75:'Heavy snow',80:'Rain showers',81:'Heavy showers',82:'Violent showers',95:'Thunderstorm',96:'Thunderstorm',99:'Thunderstorm'};
const WMO_EMOJI={0:'☀️',1:'🌤️',2:'⛅',3:'☁️',45:'🌫️',48:'🌫️',51:'🌦️',53:'🌦️',55:'🌧️',61:'🌧️',63:'🌧️',65:'🌧️',71:'🌨️',73:'❄️',75:'❄️',80:'🌦️',81:'🌧️',82:'⛈️',95:'⛈️',96:'⛈️',99:'⛈️'};

function getTimeOfDay(h){
  if(h>=5&&h<12)return'morning';
  if(h>=12&&h<17)return'afternoon';
  if(h>=17&&h<21)return'evening';
  return'night';
}

function getGreeting(h){
  const tod=getTimeOfDay(h);
  const greetings={morning:'Good morning, Borna 🌅',afternoon:'Good afternoon, Borna ☀️',evening:'Good evening, Borna 🌆',night:'Late night, Borna 🌙'};
  return greetings[tod];
}

function getSmartSub(){
  const t=getTotals();
  const tgt=getCalTarget();
  const rem=tgt-t.cal;
  const h=new Date().getHours();
  const hints=[];
  if(cups<4)hints.push('💧 You\'re behind on water — drink up');
  else if(cups>=8)hints.push('💧 Hydration on point today');
  if(t.p<TARGETS.p*0.5)hints.push(`🥩 Only ${Math.round(t.p)}g protein — hit those targets`);
  else if(t.p>=TARGETS.p)hints.push(`🥩 Protein target crushed — ${Math.round(t.p)}g`);
  if(rem>800&&h>=14)hints.push(`🍽️ ${Math.round(rem)} kcal left — don't skip meals`);
  else if(rem<0)hints.push(`⚠️ Over target by ${Math.abs(Math.round(rem))} kcal`);
  else if(rem<200)hints.push(`✅ Almost at your ${tgt} kcal target`);
  if(!meals.length&&h>=10)hints.push('🍽️ No meals logged yet today');
  if(whoopSnaps[0]?.recovery&&whoopSnaps[0].recovery<33)hints.push('😴 Low recovery — keep training light');
  else if(whoopSnaps[0]?.recovery&&whoopSnaps[0].recovery>=67)hints.push(`💪 ${whoopSnaps[0].recovery}% recovery — ready to push`);
  if(!hints.length)hints.push('Track your meals and Whoop data below');
  return hints[0];
}

function setBgForTime(h,weatherCode){
  requestAnimationFrame(()=>{
  const canvas=gv('wc-canvas');
  const bg=gv('wc-bg');
  if(!canvas||!bg)return;
  const ctx=canvas.getContext('2d');
  canvas.width=canvas.parentElement.offsetWidth||400;
  canvas.height=canvas.parentElement.offsetHeight||120;
  const tod=getTimeOfDay(h);
  const gradients={
    morning:{bg:'linear-gradient(135deg,#0c2240,#1a3520)',c1:'#ff9a3c',c2:'#ffd06f'},
    afternoon:{bg:'linear-gradient(135deg,#08172e,#0c2818)',c1:'#f5c842',c2:'#ffe08a'},
    evening:{bg:'linear-gradient(135deg,#1c0a30,#280e0e)',c1:'#ff6b35',c2:'#ff9a3c'},
    night:{bg:'linear-gradient(135deg,#04060e,#080816)',c1:'#3a5a8a',c2:'#6090c4'},
  };
  const g=gradients[tod];
  bg.style.background=g.bg;
  const w=canvas.width,ch=canvas.height;
  ctx.clearRect(0,0,w,ch);
  // Ambient glow
  const grd=ctx.createRadialGradient(w*0.75,ch*0.25,0,w*0.75,ch*0.25,w*0.55);
  grd.addColorStop(0,g.c1+'66');
  grd.addColorStop(0.5,g.c1+'22');
  grd.addColorStop(1,'transparent');
  ctx.fillStyle=grd;
  ctx.fillRect(0,0,w,ch);
  // Secondary glow bottom-left
  const grd2=ctx.createRadialGradient(w*0.1,ch*0.9,0,w*0.1,ch*0.9,w*0.4);
  grd2.addColorStop(0,g.c2+'33');
  grd2.addColorStop(1,'transparent');
  ctx.fillStyle=grd2;
  ctx.fillRect(0,0,w,ch);
  // Stars at night/evening
  if(tod==='night'||tod==='evening'){
    ctx.fillStyle='rgba(255,255,255,0.75)';
    const seed=42;
    for(let i=0;i<28;i++){
      const x=((seed*i*137.5)%1)*w;
      const y=((seed*i*97.3)%1)*ch*0.65;
      const r=((i%3)===0)?1.2:0.6;
      ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();
    }
  }
  });
}

async function initWelcomeCard(){
  const h=new Date().getHours();
  gv('wc-greeting').textContent=getGreeting(h);
  gv('wc-sub').textContent=getSmartSub();
  setBgForTime(h,0);
  // Fetch Dubai weather from Open-Meteo (no API key needed)
  try{
    const r=await fetch('https://api.open-meteo.com/v1/forecast?latitude=25.2048&longitude=55.2708&current=temperature_2m,weathercode,windspeed_10m&timezone=Asia/Dubai');
    const d=await r.json();
    const temp=Math.round(d.current.temperature_2m);
    const code=d.current.weathercode;
    const desc=WMO_CODES[code]||'Dubai';
    const emoji=WMO_EMOJI[code]||'🌡️';
    gv('wc-wicon').textContent=emoji;
    gv('wc-wtemp').textContent=`${temp}°C`;
    gv('wc-wdesc').textContent=desc+' · Dubai';
    gv('wc-weather').style.display='flex';
    setBgForTime(h,code);
  }catch(e){
    // Weather failed silently — card still shows
  }
}



// CALENDAR
function buildCalendar(){
  const ce=gv('cal-grid');if(!ce)return;
  const y=calViewDate.getFullYear(),m=calViewDate.getMonth();
  gv('cal-month-lbl').textContent=MONTHS[m]+' '+y;
  gv('cal-dow').innerHTML=DOWS.map(d=>`<div class="cal-dow">${d}</div>`).join('');
  const fd=new Date(y,m,1).getDay(),days=new Date(y,m+1,0).getDate(),ts=todayKey();
  let html='';
  for(let i=0;i<fd;i++)html+=`<div class="cc empty"></div>`;
  for(let d=1;d<=days;d++){
    const ds=`${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const hm=load(`${KEY}_meals_${ds}`,[]).length>0;
    const hw=load(`${KEY}_whoopsnaps_${ds}`,[null,null,null]).some(s=>s!==null);
    html+=`<div class="cc${ds===ts?' today':''}${ds===calSelKey?' sel':''}${(hm||hw)?' has-data':''}" onclick="selectDay('${ds}')"><div class="cc-num">${d}</div></div>`;
  }
  ce.innerHTML=html;
  renderDayDetail(calSelKey);
}
function changeMonth(dir){calViewDate.setMonth(calViewDate.getMonth()+dir);buildCalendar();}
function selectDay(ds){calSelKey=ds;buildCalendar();}
function renderDayDetail(ds){
  const el=gv('day-detail');if(!el)return;
  const dm=load(`${KEY}_meals_${ds}`,[]),dw=load(`${KEY}_whoopsnaps_${ds}`,[null,null,null]);
  const dc=parseInt(localStorage.getItem(`${KEY}_cups_${ds}`)||'0');
  const t=getTotals(dm);
  const d=new Date(ds+'T12:00:00');
  const lbl=d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
  let html=`<div class="ddc"><div class="ddc-title">${lbl}</div><div class="ddc-row">
    <div class="ddc-s"><div class="ddc-v" style="color:var(--lime)">${t.cal>0?Math.round(t.cal):'—'}</div><div class="ddc-l">kcal</div></div>
    <div class="ddc-s"><div class="ddc-v" style="color:var(--pc)">${t.p>0?Math.round(t.p)+'g':'—'}</div><div class="ddc-l">Protein</div></div>
    <div class="ddc-s"><div class="ddc-v" style="color:var(--cc)">${t.c>0?Math.round(t.c)+'g':'—'}</div><div class="ddc-l">Carbs</div></div>
    <div class="ddc-s"><div class="ddc-v" style="color:var(--fc)">${t.f>0?Math.round(t.f)+'g':'—'}</div><div class="ddc-l">Fat</div></div>
    <div class="ddc-s"><div class="ddc-v" style="color:var(--blue)">${dc>0?dc+' cups':'—'}</div><div class="ddc-l">Water</div></div>
  </div></div>`;
  const snapLabels=['Wake','1PM','EOD'];
  dw.forEach((s,i)=>{
    if(!s)return;
    const cfg=SNAP_CFG[i];
    const items=cfg.fields.map(f=>{
      const v=s[f.id];if(v==null)return'';
      const disp=f.id==='steps'?Number(v).toLocaleString():f.id==='recovery'?v+'%':f.id==='sleep'?v+'h':v;
      return`<div class="ddc-s"><div class="ddc-v" style="color:var(--whoop-green)">${disp}</div><div class="ddc-l">${f.label}</div></div>`;
    }).filter(Boolean).join('');
    if(items)html+=`<div class="ddc"><div class="ddc-title" style="color:var(--whoop-green)">⚡ WHOOP · ${snapLabels[i]}</div><div class="ddc-row">${items}</div></div>`;
  });
  if(dm.length){
    html+=`<div class="ddc"><div class="ddc-title">Meals</div>`;
    dm.forEach(m=>html+=`<div class="dm-item"><div class="dm-name">${m.emoji||'🍽️'} ${m.name}</div><div class="dm-cal">${Math.round(m.calories)} kcal</div></div>`);
    html+=`</div>`;
  }else html+=`<div class="no-data">No meals logged on this day.</div>`;
  el.innerHTML=html;
}

// PROGRESS
function openEntryModal(){gv('entry-modal').classList.add('open');}
function closeEntryModal(){gv('entry-modal').classList.remove('open');}
function saveEntry(){
  const w=gv('e-w').value!==''?parseFloat(gv('e-w').value):null;
  const bf=gv('e-bf').value!==''?parseFloat(gv('e-bf').value):null;
  if(!w&&!bf){alert('Enter weight or body fat %.');return;}
  entries.push({date:new Date().toISOString(),weight:w,bf,notes:gv('e-notes').value.trim()});
  save(`${KEY}_entries`,entries);
  gv('e-w').value='';gv('e-bf').value='';gv('e-notes').value='';
  closeEntryModal();renderProgress();
}
function deleteEntry(i){entries.splice(i,1);save(`${KEY}_entries`,entries);renderProgress();}
function renderProgress(){
  const wEs=entries.filter(e=>e.weight!=null),bEs=entries.filter(e=>e.bf!=null);
  const lw=wEs.length?wEs[wEs.length-1].weight:null,lb=bEs.length?bEs[bEs.length-1].bf:null;
  const pw=wEs.length>1?wEs[wEs.length-2].weight:BASELINE.weight,pb=bEs.length>1?bEs[bEs.length-2].bf:BASELINE.bf;
  gv('p-weight').textContent=lw!=null?lw.toFixed(1):BASELINE.weight.toFixed(1);
  gv('p-bf').textContent=lb!=null?lb.toFixed(1):BASELINE.bf.toFixed(1);
  const wd=lw!=null?(lw-pw).toFixed(1):null,bd=lb!=null?(lb-pb).toFixed(1):null;
  if(wd)gv('p-w-delta').innerHTML=`<span class="${parseFloat(wd)<0?'dg':'db'}">${parseFloat(wd)>0?'+':''}${wd} kg</span> vs prev`;
  if(bd)gv('p-bf-delta').innerHTML=`<span class="${parseFloat(bd)<0?'dg':'db'}">${parseFloat(bd)>0?'+':''}${bd}%</span> vs prev`;
  const curBF=lb||BASELINE.bf,curW=lw||BASELINE.weight;
  const curFat=(curBF/100)*curW,tgtFat=(GOAL_BF/100)*BASELINE.weight;
  const fatLost=BASELINE.fatMass-curFat,totalLose=BASELINE.fatMass-tgtFat;
  const pct=Math.max(0,Math.min(100,Math.round((fatLost/totalLose)*100)));
  gv('goal-pct').textContent=pct+'%';gv('gbar-f').style.width=pct+'%';
  gv('goal-detail').textContent=`Baseline: 22.4kg fat → Target: ${tgtFat.toFixed(1)}kg fat · ${Math.max(0,totalLose-fatLost).toFixed(1)}kg to go`;
  renderChart('chart-w',wEs.slice(-8),'weight','kg','#c8f135',84,92);
  renderChart('chart-bf',bEs.slice(-8),'bf','%','#2dd4c8',18,28);
  const le=gv('entries-list');
  if(!entries.length){le.innerHTML='<div style="text-align:center;padding:24px;color:var(--muted);font-size:12px">No entries yet.</div>';return;}
  let html='';
  [...entries].reverse().forEach((e,ri)=>{
    const i=entries.length-1-ri;
    const ds=new Date(e.date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'});
    html+=`<div class="ei"><div><div class="ei-date">${ds}</div>${e.notes?`<div class="ei-note">${e.notes}</div>`:''}</div>
      <div class="ei-vals">${e.weight!=null?`<div class="ei-v"><div class="ei-vn" style="color:var(--lime)">${e.weight}</div><div class="ei-vl">kg</div></div>`:''}
      ${e.bf!=null?`<div class="ei-v"><div class="ei-vn" style="color:var(--cyan)">${e.bf}%</div><div class="ei-vl">BF</div></div>`:''}
      <button class="ei-del" onclick="deleteEntry(${i})">✕</button></div></div>`;
  });
  le.innerHTML=html;
}
function renderChart(id,data,field,unit,color,minV,maxV){
  const el=gv(id);
  if(!data.length){el.innerHTML=`<div style="color:var(--muted);font-size:11px;padding:8px">No data yet.</div>`;return;}
  const range=maxV-minV||1;let html='';
  data.forEach(e=>{
    const v=e[field],h=Math.max(6,Math.min(95,((v-minV)/range)*90));
    const dl=new Date(e.date).toLocaleDateString('en-US',{month:'short',day:'numeric'});
    html+=`<div class="cb-wrap"><div class="cb" style="height:${h}px;background:${color};opacity:.75"><div class="cb-val" style="color:${color}">${v}${unit}</div></div><div class="cb-lbl">${dl}</div></div>`;
  });
  el.innerHTML=html;
}

// ── MACRO IMPACT SCANNER ──────────────────────────────────────────────────
let impactB64=null;
let impactEntry=null; // the parsed result ready to add

function openImpactModal(){
  impactB64=null; impactEntry=null;
  gv('impact-desc').value='';
  gv('impact-result').classList.remove('show');
  gv('impact-loading').classList.remove('show');
  gv('impact-preview').style.display='none';
  gv('impact-ph-ph').style.display='block';
  gv('impact-photo-zone').classList.remove('has-img');
  gv('file-impact').value='';
  gv('impact-scan-btn').disabled=false;
  renderImpactNeeds();
  gv('impact-modal').classList.add('open');
}
function closeImpactModal(){ gv('impact-modal').classList.remove('open'); }

function renderImpactNeeds(){
  const t=getTotals(), tgt=getCalTarget();
  const remCal=Math.round(tgt-t.cal);
  const remP=Math.round(TARGETS.p-t.p);
  const remC=Math.round(TARGETS.c-t.c);
  const remF=Math.round(TARGETS.f-t.f);
  const chips=[
    {label: remCal>0 ? `${remCal} kcal left` : `${Math.abs(remCal)} kcal over`, cls:'cal'+(remCal<=0?' done':'')},
    {label: remP>0 ? `+${remP}g protein needed` : `✓ protein`, cls:'p'+(remP<=0?' done':'')},
    {label: remC>0 ? `+${remC}g carbs left` : `✓ carbs`, cls:'c'+(remC<=0?' done':'')},
    {label: remF>0 ? `+${remF}g fat left` : `✓ fat`, cls:'f'+(remF<=0?' done':'')},
  ];
  gv('impact-needs').innerHTML=chips.map(c=>`<div class="need-chip ${c.cls}">${c.label}</div>`).join('');
}

function handleImpactPhoto(e){
  const file=e.target.files[0]; if(!file)return;
  const r=new FileReader();
  r.onload=ev=>{
    impactB64=ev.target.result.split(',')[1];
    gv('impact-preview').src=ev.target.result;
    gv('impact-preview').style.display='block';
    gv('impact-ph-ph').style.display='none';
    gv('impact-photo-zone').classList.add('has-img');
  };
  r.readAsDataURL(file);
}

async function runImpactScan(){
  const desc=gv('impact-desc').value.trim();
  if(!impactB64&&!desc){ alert('Add a photo or description first.'); return; }
  gv('impact-scan-btn').disabled=true;
  gv('impact-loading').classList.add('show');
  gv('impact-result').classList.remove('show');
  impactEntry=null;

  const content=[];
  if(impactB64) content.push({type:'image',source:{type:'base64',media_type:'image/jpeg',data:impactB64}});
  const prompt = impactB64&&desc
    ? `Food item with photo. Description: "${desc}". Give total macros for the whole portion shown.`
    : impactB64
    ? 'Identify this food and give total macros for the whole portion shown.'
    : `Give total macros for: "${desc}". Use official label if branded.`;
  content.push({type:'text',text:prompt});

  try{
    const res=await fetch(PROXY,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:400,
        system:`Nutrition expert. Return ONLY valid JSON, no markdown:
{"name":"food name","emoji":"single emoji","calories":number,"protein":number,"carbs":number,"fat":number,"verdict":"one punchy sentence about whether this fits the user's remaining targets"}
Use official label macros for branded products. Be accurate.`,
        messages:[{role:'user',content}]})});
    const data=await res.json();
    const raw=data.content.map(b=>b.text||'').join('').replace(/```json|```/g,'').trim();
    const parsed=JSON.parse(raw);
    impactEntry={
      name:parsed.name, emoji:parsed.emoji||'🍽️',
      calories:Math.round(parsed.calories||0),
      protein:Math.round(parsed.protein*10||0)/10,
      carbs:Math.round(parsed.carbs*10||0)/10,
      fat:Math.round(parsed.fat*10||0)/10,
      thumb:null // no thumb in storage
    };
    renderImpactResult(parsed);
  }catch(err){
    alert('Analysis failed. Please try again.');
    console.error(err);
  }finally{
    gv('impact-scan-btn').disabled=false;
    gv('impact-loading').classList.remove('show');
  }
}

function renderImpactResult(parsed){
  const t=getTotals(), tgt=getCalTarget();
  const remP=TARGETS.p-t.p, remC=TARGETS.c-t.c, remF=TARGETS.f-t.f, remCal=tgt-t.cal;

  gv('impact-item-name').textContent=`${parsed.emoji||'🍽️'} ${parsed.name}`;

  // Score: how well does this fill what's actually needed?
  const p=parsed.protein||0, c=parsed.carbs||0, f=parsed.fat||0, cal=parsed.calories||0;
  let score=0;
  if(remP>5 && p>0)  score += Math.min(p/remP, 1) * 35;  // protein worth most
  if(remC>5 && c>0)  score += Math.min(c/remC, 1) * 25;
  if(remF>5 && f>0)  score += Math.min(f/remF, 1) * 20;
  if(remCal>50&&cal>0) score += Math.min(cal/remCal,1)*20;
  // penalise overshooting
  if(p>remP+10) score-=15;
  if(cal>remCal+100) score-=20;
  score=Math.max(0,Math.min(100,Math.round(score)));

  let scoreLabel, scoreCls;
  if(score>=75){scoreLabel='Great fit 🔥';scoreCls='score-great';}
  else if(score>=50){scoreLabel='Good fit ✓';scoreCls='score-good';}
  else if(score>=25){scoreLabel='Okay fit';scoreCls='score-ok';}
  else{scoreLabel='Poor fit';scoreCls='score-poor';}

  gv('impact-score').textContent=scoreLabel;
  gv('impact-score').className=`impact-score ${scoreCls}`;

  // Macro bars
  const bars=[
    {lbl:'Protein',cur:t.p,add:p,tgt:TARGETS.p,col:'var(--pc)'},
    {lbl:'Carbs',  cur:t.c,add:c,tgt:TARGETS.c,col:'var(--cc)'},
    {lbl:'Fat',    cur:t.f,add:f,tgt:TARGETS.f,col:'var(--fc)'},
    {lbl:'Cals',   cur:t.cal,add:cal,tgt:tgt,   col:'var(--lime)'},
  ];
  gv('impact-bars').innerHTML=bars.map(b=>{
    const curPct=Math.min(b.cur/b.tgt*100,100);
    const addPct=Math.min((b.cur+b.add)/b.tgt*100,100)-curPct;
    const after=b.lbl==='Cals'?Math.round(b.cur+b.add)+'':Math.round(b.cur+b.add)+'g';
    const afterColor=(b.cur+b.add)>b.tgt*1.05?'var(--red)':b.col;
    return `<div class="ibar-row">
      <div class="ibar-lbl" style="color:${b.col}">${b.lbl}</div>
      <div class="ibar-track">
        <div class="ibar-cur" style="width:${curPct}%;background:${b.col};opacity:0.5;height:100%;border-radius:4px;position:absolute;top:0;left:0"></div>
        <div class="ibar-add" style="left:${curPct}%;width:${Math.max(addPct,0)}%;background:${b.col};top:0;height:100%"></div>
      </div>
      <div class="ibar-after" style="color:${afterColor}">${after}</div>
    </div>`;
  }).join('');

  const tgtLabel=bars.map(b=>`${b.lbl}: ${Math.round(b.tgt)}${b.lbl==='Cals'?'':b.lbl==='Cals'?'':' g'}`);
  gv('impact-verdict').innerHTML=`<strong>After adding:</strong> ${parsed.verdict||''}`;
  gv('impact-result').classList.add('show');
}

let _impactAddLock=false;
function addImpactMeal(){
  if(!impactEntry||_impactAddLock)return;
  _impactAddLock=true;
  meals.push(impactEntry);
  save(`${KEY}_meals_${todayKey()}`,meals);
  renderAll();
  closeImpactModal();
  const todayBtn=document.querySelector('.nb');
  if(todayBtn) showPage('today',todayBtn);
  setTimeout(()=>{ _impactAddLock=false; },800);
}
