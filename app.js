
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
    {id:'sleep',label:'Sleep',ph:'7:42',step:'',inputType:'sleep'},
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
    if(f.id==='steps')d=Number(v).toLocaleString();
    else if(f.id==='recovery')d=v+'%';
    else if(f.id==='sleep'){const hh=Math.floor(v),mm=Math.round((v-hh)*60);d=hh+'h'+(mm>0?' '+mm+'m':'');}
    else d=v;
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
        const dec=snap[f.id]; const hh=dec!=null?Math.floor(dec):''; const mm=dec!=null?String(Math.round((dec-Math.floor(dec))*60)).padStart(2,'0'):'';
        const val=dec!=null?`${hh}:${mm}`:'';
        html+=`<div><label class="flbl">${f.label} <span style="color:var(--muted);font-size:10px">(h:mm)</span></label><input type="text" id="wf-${f.id}" placeholder="${f.ph}" value="${val}" inputmode="decimal"/></div>`;
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
    const el=gv(`wf-${f.id}`);if(!el||el.value==='')return;
    if(f.inputType==='sleep'){
      const v=el.value.trim();
      snap[f.id]=v.includes(':')?Math.round((parseInt(v.split(':')[0]||0)+parseInt(v.split(':')[1]||0)/60)*100)/100:parseFloat(v)||0;
    } else { snap[f.id]=f.id==='steps'?parseInt(el.value):parseFloat(el.value); }
  });
  const ge=gv('wf-goal');if(ge)snap.goal=ge.value;
  whoopSnaps[activeTab]=snap;
  save(`${KEY}_whoopsnaps_${todayKey()}`,whoopSnaps);
  closeWhoopModal();renderAll();
}
function getCalTarget(){
  // Food intake target is fixed at TARGETS.cal (2,340 kcal cut target).
  // WHOOP burned = total daily expenditure — it's informational only.
  // The deficit is already baked into TARGETS.cal; we don't adjust food
  // intake up or down based on how much was burned.
  const g=(whoopSnaps[0]&&whoopSnaps[0].goal)||(whoopSnaps[2]&&whoopSnaps[2].goal)||'cut';
  if(g==='bulk')  return TARGETS.cal+500;
  if(g==='maintain') return TARGETS.cal+200;
  return TARGETS.cal; // cut — default
}

// SUMMARY
function getTotals(arr){return(arr||meals).reduce((a,m)=>({cal:a.cal+m.calories,p:a.p+m.protein,c:a.c+m.carbs,f:a.f+m.fat,fibre:a.fibre+(m.fibre||0),sugar:a.sugar+(m.sugar||0),sodium:a.sodium+(m.sodium||0)}),{cal:0,p:0,c:0,f:0,fibre:0,sugar:0,sodium:0});}
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
    div.querySelector('.qa-del').addEventListener('click',e=>{e.stopPropagation();deleteQAItem(item.id);});
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
  if(!confirm('Remove from Quick Add?'))return;
  quickItems=quickItems.filter(i=>i.id!==id);
  save(`${KEY}_quickitems`,quickItems);
  renderQuickAdd();
}
let _quickLock=false;
function quickLog(id){
  if(_quickLock)return;
  const item=quickItems.find(i=>i.id===id);if(!item)return;
  _quickLock=true;
  meals.push({name:item.name,emoji:item.emoji,calories:item.calories,protein:item.protein,carbs:item.carbs,fat:item.fat,fibre:item.fibre||0,sugar:item.sugar||0,sodium:item.sodium||0,thumb:null});
  save(`${KEY}_meals_${todayKey()}`,meals);
  renderAll();
  setTimeout(()=>{_quickLock=false;},600);
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
    const th=m.thumb?`<img class="fi-thumb" src="${m.thumb}" style="width:46px;height:46px;border-radius:11px;object-fit:cover;flex-shrink:0"/>`:`<div class="fi-thumb">${m.emoji||'🍽️'}</div>`;
    const pPct=Math.min(Math.round(m.protein/TARGETS.p*100),100);
    const cPct=Math.min(Math.round(m.carbs/TARGETS.c*100),100);
    const fPct=Math.min(Math.round(m.fat/TARGETS.f*100),100);
    div.innerHTML=`<div class="fi-top">${th}<div class="fi-info"><div class="fi-name">${m.name}</div><div class="fi-tags"><span class="ft ftcal">${Math.round(m.calories)} kcal</span><span class="ft ftp">${Math.round(m.protein)}g P</span><span class="ft ftc">${Math.round(m.carbs)}g C</span><span class="ft ftf">${Math.round(m.fat)}g F</span></div></div><button class="fi-del">✕</button></div><div class="fi-bars"><div class="fi-bar-row"><span class="fi-bar-lbl">P</span><div class="fi-bar-track"><div class="fi-bar-fill" style="width:${pPct}%;background:var(--pc)"></div></div><span class="fi-bar-val" style="color:var(--pc)">${Math.round(m.protein)}g</span></div><div class="fi-bar-row"><span class="fi-bar-lbl">C</span><div class="fi-bar-track"><div class="fi-bar-fill" style="width:${cPct}%;background:var(--cc)"></div></div><span class="fi-bar-val" style="color:var(--cc)">${Math.round(m.carbs)}g</span></div><div class="fi-bar-row"><span class="fi-bar-lbl">F</span><div class="fi-bar-track"><div class="fi-bar-fill" style="width:${fPct}%;background:var(--fc)"></div></div><span class="fi-bar-val" style="color:var(--fc)">${Math.round(m.fat)}g</span></div></div>`;
    div.querySelector('.fi-del').addEventListener('click',(e)=>{e.stopPropagation();deleteMeal(i);});
    div.addEventListener('click',()=>openMealDetail(i));
    el.appendChild(div);
  }
}
function deleteMeal(i){meals.splice(i,1);save(`${KEY}_meals_${todayKey()}`,meals);renderAll();}

// MEAL DETAIL MODAL
function openMealDetail(idx){
  const m=meals[idx];if(!m)return;
  const modal=gv('meal-detail-modal');if(!modal)return;
  // reset analysis state
  gv('mdd-analysis-wrap').style.display='none';
  gv('mdd-analysis-body').textContent='';
  gv('mdd-analyze-btn').style.display='block';
  gv('mdd-analyze-btn').disabled=false;
  gv('mdd-analyze-btn').textContent='✦ Analyse with Coach';
  // header
  gv('mdd-emoji').textContent=m.emoji||'🍽️';
  gv('mdd-name').textContent=m.name;
  const ts=m.loggedAt?new Date(m.loggedAt).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:true}):'';
  gv('mdd-time').textContent=ts?`Logged at ${ts}`:'';
  // macro summary chips
  gv('mdd-cal').textContent=Math.round(m.calories)+' kcal';
  gv('mdd-p').textContent=Math.round(m.protein*10)/10+'g P';
  gv('mdd-c').textContent=Math.round(m.carbs*10)/10+'g C';
  gv('mdd-f').textContent=Math.round(m.fat*10)/10+'g F';
  // ingredient breakdown
  const ingEl=gv('mdd-ingredients');
  if(m.ingredients&&m.ingredients.length>1){
    ingEl.innerHTML=m.ingredients.map(ing=>`
      <div class="mdd-ing-row">
        <span class="mdd-ing-emoji">${ing.emoji||'•'}</span>
        <div class="mdd-ing-info">
          <div class="mdd-ing-name">${ing.name}</div>
          <div class="mdd-ing-macros">
            <span style="color:var(--blue2)">${ing.calories} kcal</span>
            <span style="color:var(--pc)">${ing.protein}g P</span>
            <span style="color:var(--cc)">${ing.carbs}g C</span>
            <span style="color:var(--fc)">${ing.fat}g F</span>
          </div>
        </div>
      </div>`).join('');
    gv('mdd-ing-section').style.display='block';
  } else {
    gv('mdd-ing-section').style.display='none';
  }
  // progress bars showing this meal's contribution to daily targets
  const pPct=Math.min(Math.round(m.protein/TARGETS.p*100),100);
  const cPct=Math.min(Math.round(m.carbs/TARGETS.c*100),100);
  const fPct=Math.min(Math.round(m.fat/TARGETS.f*100),100);
  const calPct=Math.min(Math.round(m.calories/getCalTarget()*100),100);
  gv('mdd-bar-cal').style.width=calPct+'%';
  gv('mdd-bar-p').style.width=pPct+'%';
  gv('mdd-bar-c').style.width=cPct+'%';
  gv('mdd-bar-f').style.width=fPct+'%';
  gv('mdd-pct-cal').textContent=calPct+'%';
  gv('mdd-pct-p').textContent=pPct+'%';
  gv('mdd-pct-c').textContent=cPct+'%';
  gv('mdd-pct-f').textContent=fPct+'%';
  modal.classList.add('open');
  modal._mealIdx=idx;
}
function closeMealDetail(){
  const modal=gv('meal-detail-modal');
  if(modal)modal.classList.remove('open');
}
async function analyzeMealDetail(){
  const modal=gv('meal-detail-modal');
  const idx=modal._mealIdx;
  const m=meals[idx];if(!m)return;
  const btn=gv('mdd-analyze-btn');
  btn.disabled=true;btn.textContent='Analysing…';
  gv('mdd-analysis-wrap').style.display='block';
  gv('mdd-analysis-body').textContent='';
  gv('mdd-analysis-loading').style.display='block';
  const t=getTotals();
  const tgt=getCalTarget();
  const remaining={cal:Math.round(tgt-t.cal),p:Math.round(TARGETS.p-t.p),c:Math.round(TARGETS.c-t.c),f:Math.round(TARGETS.f-t.f)};
  const prompt=`You are a concise fitness coach. Borna is 26M, 89.1kg, 25.1% BF, goal: reach 20.1% BF by Apr 27 2026. Daily targets: ${tgt} kcal, 128g P, 200g C, 65g F.

He just ate: ${m.name} — ${Math.round(m.calories)} kcal, ${m.protein}g P, ${m.carbs}g C, ${m.fat}g F.
${m.ingredients&&m.ingredients.length>1?'Ingredients: '+m.ingredients.map(i=>`${i.name} (${i.calories}kcal, ${i.protein}gP)`).join(', '):''}

After this meal, remaining for the day: ${remaining.cal} kcal, ${remaining.p}g P, ${remaining.c}g C, ${remaining.f}g F.

Give a 2-3 sentence honest assessment: how well this meal fits his cut goals, what it does well or poorly, and one actionable tip. Be direct, no fluff.`;
  try{
    const res=await fetch(PROXY,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:200,
        messages:[{role:'user',content:prompt}]})});
    const data=await res.json();
    const text=data.content.map(b=>b.text||'').join('').trim();
    gv('mdd-analysis-loading').style.display='none';
    gv('mdd-analysis-body').textContent=text;
    btn.style.display='none';
  }catch(err){
    gv('mdd-analysis-loading').style.display='none';
    gv('mdd-analysis-body').textContent='Analysis failed. Try again.';
    btn.disabled=false;btn.textContent='✦ Analyse with Coach';
  }
}

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
{"confidence":"high"|"medium"|"low","confidence_tip":"one sentence or empty","ingredients":[{"name":"name","emoji":"emoji","portion":"e.g. 80g","calories":number,"protein":number,"carbs":number,"fat":number,"fibre":number,"sugar":number,"sodium":number}]}
Identify 2-8 ingredients. Include fibre, sugar, sodium where known (use 0 if unknown). Use official macros for branded products.`,
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
    const pm=ing.portion_multiplier;
    const cal=Math.round(ing.calories*pm),p=Math.round(ing.protein*pm*10)/10,c=Math.round(ing.carbs*pm*10)/10,f=Math.round(ing.fat*pm*10)/10;
    if(ing._editing){
      div.className='ing-item'+(ing.selected?' selected':'')+' ing-editing';
      div.innerHTML=`
        <div class="ing-top">
          <div class="ing-check" onclick="toggleIng(${ing.id})"><span class="ing-check-icon">✓</span></div>
          <div class="ing-emoji">${ing.emoji}</div>
          <div class="ing-name" style="font-size:13px">${ing.name}</div>
          <span class="ing-edit-hint">editing</span>
        </div>
        <div class="ing-edit-grid">
          <div class="ing-edit-col"><label class="ing-edit-lbl">kcal</label><input class="ing-edit-in" id="ied-cal-${ing.id}" type="number" min="0" step="1" value="${ing.calories}" inputmode="decimal"/></div>
          <div class="ing-edit-col"><label class="ing-edit-lbl">Protein g</label><input class="ing-edit-in" id="ied-p-${ing.id}" type="number" min="0" step="0.1" value="${ing.protein}" inputmode="decimal"/></div>
          <div class="ing-edit-col"><label class="ing-edit-lbl">Carbs g</label><input class="ing-edit-in" id="ied-c-${ing.id}" type="number" min="0" step="0.1" value="${ing.carbs}" inputmode="decimal"/></div>
          <div class="ing-edit-col"><label class="ing-edit-lbl">Fat g</label><input class="ing-edit-in" id="ied-f-${ing.id}" type="number" min="0" step="0.1" value="${ing.fat}" inputmode="decimal"/></div>
        </div>
        <div class="ing-edit-actions">
          <button class="ing-save-btn" onclick="saveIngEdit(${ing.id})">✓ Save</button>
          <button class="ing-cancel-btn" onclick="cancelIngEdit(${ing.id})">Cancel</button>
        </div>`;
    } else {
      div.className='ing-item'+(ing.selected?' selected':'');
      const pBtns=[.5,.75,1,1.5,2].map(v=>`<button class="pbtn${pm===v?' active':''}" onclick="setMultiplier(${ing.id},${v})">${v===1?'Full':v+'×'}</button>`).join('');
      div.innerHTML=`
        <div class="ing-top">
          <div class="ing-check" onclick="toggleIng(${ing.id})"><span class="ing-check-icon">✓</span></div>
          <div class="ing-emoji">${ing.emoji}</div>
          <div class="ing-name">${ing.name}</div>
          <button class="ing-pencil" onclick="startIngEdit(${ing.id})">✏️</button>
        </div>
        <div class="ing-macros"><span class="ing-m" style="color:var(--muted)">${ing.portion}</span><span class="ing-m" style="color:var(--blue2)">${cal} kcal</span><span class="ing-m" style="color:var(--pc)">${p}g P</span><span class="ing-m" style="color:var(--cc)">${c}g C</span><span class="ing-m" style="color:var(--fc)">${f}g F</span></div>
        <div class="portion-row"><span class="portion-lbl">Portion:</span><div class="portion-btns">${pBtns}</div></div>`;
    }
    el.appendChild(div);
  }
  updateSelTotals();
}
function toggleIng(id){const ing=ingredients.find(i=>i.id===id);if(ing){ing.selected=!ing.selected;renderIngredients();}}
function setMultiplier(id,val){const ing=ingredients.find(i=>i.id===id);if(ing){ing.portion_multiplier=val;renderIngredients();}}
function startIngEdit(id){
  ingredients.forEach(i=>{if(i.id!==id)delete i._editing;});
  const ing=ingredients.find(i=>i.id===id);
  if(ing){ing._editing=true;renderIngredients();}
}
function cancelIngEdit(id){
  const ing=ingredients.find(i=>i.id===id);
  if(ing){delete ing._editing;renderIngredients();}
}
function saveIngEdit(id){
  const ing=ingredients.find(i=>i.id===id);if(!ing)return;
  const n=(elId,fb)=>{const v=parseFloat(document.getElementById(elId)?.value);return isNaN(v)?fb:v;};
  ing.calories=n(`ied-cal-${id}`,ing.calories);
  ing.protein =n(`ied-p-${id}`, ing.protein);
  ing.carbs   =n(`ied-c-${id}`, ing.carbs);
  ing.fat     =n(`ied-f-${id}`, ing.fat);
  ing.portion_multiplier=1;
  ing.portion='custom';
  delete ing._editing;
  renderIngredients();
}
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
  const t=sel.reduce((a,i)=>({cal:a.cal+i.calories*i.portion_multiplier,p:a.p+i.protein*i.portion_multiplier,c:a.c+i.carbs*i.portion_multiplier,f:a.f+i.fat*i.portion_multiplier}),{cal:0,p:0,c:0,f:0});
  // Capture thumb BEFORE reset clears mealB64. Never persist to localStorage — base64 causes silent quota failures on iOS.
  const thumbForSession=mealB64?`data:image/jpeg;base64,${mealB64}`:null;
  const entry={
    name:sel.length===1?sel[0].name:sel.map(i=>i.name).join(' + '),
    emoji:sel[0].emoji,
    calories:Math.round(t.cal),protein:Math.round(t.p*10)/10,
    carbs:Math.round(t.c*10)/10,fat:Math.round(t.f*10)/10,
    // extended nutrients from analysis if available
    fibre:Math.round((sel.reduce((a,i)=>(a+(i.fibre||0)*i.portion_multiplier),0))*10)/10,
    sugar:Math.round((sel.reduce((a,i)=>(a+(i.sugar||0)*i.portion_multiplier),0))*10)/10,
    sodium:Math.round(sel.reduce((a,i)=>(a+(i.sodium||0)*i.portion_multiplier),0)),
    ingredients:sel.map(i=>({
      name:i.name,emoji:i.emoji,portion:i.portion,
      calories:Math.round(i.calories*i.portion_multiplier),
      protein:Math.round(i.protein*i.portion_multiplier*10)/10,
      carbs:Math.round(i.carbs*i.portion_multiplier*10)/10,
      fat:Math.round(i.fat*i.portion_multiplier*10)/10
    })),
    loggedAt:Date.now(),
    thumb:null
  };
  meals.push(entry);
  save(`${KEY}_meals_${todayKey()}`,meals);
  entry.thumb=thumbForSession; // attach to in-memory only
  gv('log-modal').classList.remove('open');
  resetLogModal();
  renderAll();
  const todayBtn=document.querySelector('.nb');
  if(todayBtn)showPage('today',todayBtn);
  setTimeout(()=>{_confirmLock=false;},800);
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
  let html=`<div class="ddc">
    <div class="ddc-title">${lbl}</div>
    <div class="ddc-row" style="grid-template-columns:repeat(5,1fr)">
      <div class="ddc-s"><div class="ddc-v" style="color:var(--blue2)">${t.cal>0?Math.round(t.cal):'—'}</div><div class="ddc-l">kcal</div></div>
      <div class="ddc-s"><div class="ddc-v" style="color:var(--pc)">${t.p>0?Math.round(t.p)+'g':'—'}</div><div class="ddc-l">Protein</div></div>
      <div class="ddc-s"><div class="ddc-v" style="color:var(--cc)">${t.c>0?Math.round(t.c)+'g':'—'}</div><div class="ddc-l">Carbs</div></div>
      <div class="ddc-s"><div class="ddc-v" style="color:var(--fc)">${t.f>0?Math.round(t.f)+'g':'—'}</div><div class="ddc-l">Fat</div></div>
      <div class="ddc-s"><div class="ddc-v" style="color:var(--wc)">${dc>0?dc:'—'}</div><div class="ddc-l">💧 cups</div></div>
    </div>
  </div>`;
  const snapLabels=['Wake','1PM','EOD'];
  dw.forEach((s,i)=>{
    if(!s)return;
    const cfg=SNAP_CFG[i];
    const items=cfg.fields.map(f=>{
      const v=s[f.id];if(v==null)return'';
  const disp=f.id==='steps'?Number(v).toLocaleString():f.id==='recovery'?v+'%':f.id==='sleep'?(()=>{const hh=Math.floor(v),mm=Math.round((v-hh)*60);return hh+'h'+(mm>0?' '+mm+'m':'');})():v;
      return`<div class="ddc-s"><div class="ddc-v" style="color:var(--whoop-green)">${disp}</div><div class="ddc-l">${f.label}</div></div>`;
    }).filter(Boolean).join('');
    if(items)html+=`<div class="ddc"><div class="ddc-title" style="color:var(--whoop-green)">⚡ WHOOP · ${snapLabels[i]}</div><div class="ddc-row" style="grid-template-columns:repeat(3,1fr)">${items}</div></div>`;
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
  renderChart('chart-w',wEs.slice(-8),'weight','kg','#388bfd',84,92);
  renderChart('chart-bf',bEs.slice(-8),'bf','%','#2dd4c8',18,28);
  const le=gv('entries-list');
  if(!entries.length){le.innerHTML='<div style="text-align:center;padding:24px;color:var(--muted);font-size:12px">No entries yet.</div>';return;}
  let html='';
  [...entries].reverse().forEach((e,ri)=>{
    const i=entries.length-1-ri;
    const ds=new Date(e.date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'});
    html+=`<div class="ei"><div><div class="ei-date">${ds}</div>${e.notes?`<div class="ei-note">${e.notes}</div>`:''}</div>
      <div class="ei-vals">${e.weight!=null?`<div class="ei-v"><div class="ei-vn" style="color:var(--blue2)">${e.weight}</div><div class="ei-vl">kg</div></div>`:''}
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

// ══════════════════════════════════════════════════════════════════════════
// FEATURE: NUTRIENT BREAKDOWN — shown below macro rings on Today tab
// ══════════════════════════════════════════════════════════════════════════
function renderNutrients(){
  const t=getTotals();
  const fibre=t.fibre||0, sugar=t.sugar||0, sodium=t.sodium||0;
  const el=gv('nutrient-breakdown');
  if(!el)return;
  // fibre target ~30g, sugar soft warn >50g, sodium warn >2300mg
  const fibreW=Math.min(fibre/30,1), sugarW=Math.min(sugar/50,1), sodiumW=Math.min(sodium/2300,1);
  const fibreCol=fibre>=25?'var(--green)':fibre>=15?'var(--amber)':'var(--muted)';
  const sugarCol=sugar>60?'var(--red)':sugar>40?'var(--amber)':'var(--cc)';
  const sodiumCol=sodium>2300?'var(--red)':sodium>1500?'var(--amber)':'var(--cyan)';
  el.innerHTML=`
    <div class="nut-row">
      <div class="nut-item">
        <div class="nut-top"><span class="nut-lbl">Fibre</span><span class="nut-val" style="color:${fibreCol}">${Math.round(fibre)}g</span></div>
        <div class="nut-bar-bg"><div class="nut-bar-f" style="width:${fibreW*100}%;background:${fibreCol}"></div></div>
        <div class="nut-sub">target 30g</div>
      </div>
      <div class="nut-item">
        <div class="nut-top"><span class="nut-lbl">Sugar</span><span class="nut-val" style="color:${sugarCol}">${Math.round(sugar)}g</span></div>
        <div class="nut-bar-bg"><div class="nut-bar-f" style="width:${sugarW*100}%;background:${sugarCol}"></div></div>
        <div class="nut-sub">keep under 50g</div>
      </div>
      <div class="nut-item">
        <div class="nut-top"><span class="nut-lbl">Sodium</span><span class="nut-val" style="color:${sodiumCol}">${Math.round(sodium)}mg</span></div>
        <div class="nut-bar-bg"><div class="nut-bar-f" style="width:${sodiumW*100}%;background:${sodiumCol}"></div></div>
        <div class="nut-sub">limit 2300mg</div>
      </div>
    </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
// FEATURE: BARCODE SCANNER — OCR via Claude (works on all devices) + Open Food Facts
// ══════════════════════════════════════════════════════════════════════════
let barcodeStream=null;
let _barcodeScanning=false;

function openBarcodeModal(){
  gv('barcode-modal').classList.add('open');
  gv('barcode-result').style.display='none';
  gv('barcode-manual').value='';
  _barcodeScanning=false;
  setBarcodeStatus('idle');
  startBarcodeCamera();
}
function closeBarcodeModal(){
  stopBarcodeCamera();
  _barcodeScanning=false;
  gv('barcode-modal').classList.remove('open');
}
function stopBarcodeCamera(){
  if(barcodeStream){barcodeStream.getTracks().forEach(t=>t.stop());barcodeStream=null;}
  const v=gv('barcode-video');if(v)v.srcObject=null;
}
function setBarcodeStatus(state,txt){
  const el=gv('barcode-status');
  const btn=gv('barcode-snap-btn');
  if(state==='idle'){
    el.textContent='Aim at barcode then tap the button';
    if(btn){btn.disabled=false;btn.textContent='📷 Read Barcode';}
  } else if(state==='reading'){
    el.textContent='Reading barcode…';
    if(btn){btn.disabled=true;btn.textContent='Reading…';}
  } else if(state==='looking'){
    el.textContent='✓ Got number — looking up product…';
    if(btn)btn.disabled=true;
  } else if(state==='found'){
    el.textContent='✓ Product found';
    if(btn){btn.disabled=false;btn.textContent='📷 Scan Again';}
  } else if(state==='error'){
    el.textContent=txt||'Try again';
    if(btn){btn.disabled=false;btn.textContent='📷 Try Again';}
  }
}

async function startBarcodeCamera(){
  const video=gv('barcode-video');
  if(!video)return;
  try{
    barcodeStream=await navigator.mediaDevices.getUserMedia({
      video:{facingMode:'environment',width:{ideal:1920},height:{ideal:1080}}
    });
    video.srcObject=barcodeStream;
    video.play();
    setBarcodeStatus('idle');
  }catch(e){
    setBarcodeStatus('error','Camera unavailable. Type barcode number below.');
  }
}

// Capture a frame from video and send to Claude to read the barcode digits
async function snapAndReadBarcode(){
  if(_barcodeScanning)return;
  const video=gv('barcode-video');
  if(!video||!barcodeStream){
    // No camera — fall back to manual
    const code=gv('barcode-manual').value.trim();
    if(code)lookupBarcode(code);
    else setBarcodeStatus('error','No camera. Type the barcode number below.');
    return;
  }
  _barcodeScanning=true;
  setBarcodeStatus('reading');

  // Draw current video frame to canvas
  const canvas=document.createElement('canvas');
  canvas.width=video.videoWidth||1280;
  canvas.height=video.videoHeight||720;
  const ctx=canvas.getContext('2d');
  ctx.drawImage(video,0,0,canvas.width,canvas.height);
  const b64=canvas.toDataURL('image/jpeg',0.92).split(',')[1];

  try{
    const res=await fetch(PROXY,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:100,
        system:'You are a barcode reader. Look at the image and find the barcode number (EAN-13, EAN-8, UPC-A etc). Return ONLY the digits, nothing else. If you cannot find a barcode, return the word NONE.',
        messages:[{role:'user',content:[
          {type:'image',source:{type:'base64',media_type:'image/jpeg',data:b64}},
          {type:'text',text:'What is the barcode number in this image? Return only the digits.'}
        ]}]})});
    const data=await res.json();
    const raw=(data.content||[]).map(b=>b.text||'').join('').trim().replace(/\s/g,'');
    // Extract only digits
    const digits=raw.replace(/[^0-9]/g,'');
    if(!digits||raw==='NONE'||digits.length<6){
      _barcodeScanning=false;
      setBarcodeStatus('error','Could not read barcode — reposition and try again, or type it below.');
      return;
    }
    gv('barcode-manual').value=digits;
    setBarcodeStatus('looking');
    lookupBarcode(digits);
  }catch(e){
    _barcodeScanning=false;
    setBarcodeStatus('error','Read failed — try again.');
  }
}

async function lookupBarcode(code){
  if(!code||code.trim()===''){alert('Enter a barcode number.');return;}
  gv('barcode-status').textContent='Looking up…';
  gv('barcode-result').style.display='none';
  try{
    const res=await fetch(`https://world.openfoodfacts.org/api/v2/product/${code.trim()}?fields=product_name,brands,nutriments,serving_size,serving_quantity,image_front_small_url`);
    const data=await res.json();
    if(data.status!==1||!data.product){
      _barcodeScanning=false; setBarcodeStatus('error','Product not found in database — try typing the name in Log a Meal instead.');
      return;
    }
    const p=data.product;
    const n=p.nutriments||{};
    // Per 100g values
    const per100={
      calories:Math.round(n['energy-kcal_100g']||n['energy_100g']/4.184||0),
      protein:Math.round((n['proteins_100g']||0)*10)/10,
      carbs:Math.round((n['carbohydrates_100g']||0)*10)/10,
      fat:Math.round((n['fat_100g']||0)*10)/10,
      fibre:Math.round((n['fiber_100g']||0)*10)/10,
      sugar:Math.round((n['sugars_100g']||0)*10)/10,
      sodium:Math.round((n['sodium_100g']||0)*1000)
    };
    const servingG=parseFloat(p.serving_quantity)||100;
    const factor=servingG/100;
    const serving={
      calories:Math.round(per100.calories*factor),
      protein:Math.round(per100.protein*factor*10)/10,
      carbs:Math.round(per100.carbs*factor*10)/10,
      fat:Math.round(per100.fat*factor*10)/10,
      fibre:Math.round(per100.fibre*factor*10)/10,
      sugar:Math.round(per100.sugar*factor*10)/10,
      sodium:Math.round(per100.sodium*factor)
    };
    const name=`${p.brands?p.brands.split(',')[0].trim()+' ':''}${p.product_name||'Unknown'}`;
    const servingLabel=p.serving_size||`${servingG}g`;
    // Store for add
    window._barcodeEntry={name,emoji:'🏷️',...serving,thumb:null};
    window._barcodePer100=per100;
    window._barcodeServingG=servingG;
    window._barcodeName=name;
    gv('bc-name').textContent=name;
    gv('bc-serving').textContent=`Per serving (${servingLabel})`;
    gv('bc-cal').textContent=serving.calories+' kcal';
    gv('bc-p').textContent=serving.protein+'g P';
    gv('bc-c').textContent=serving.carbs+'g C';
    gv('bc-f').textContent=serving.fat+'g F';
    gv('bc-fibre').textContent=serving.fibre+'g fibre';
    gv('bc-sugar').textContent=serving.sugar+'g sugar';
    gv('bc-sodium').textContent=serving.sodium+'mg sodium';
    gv('barcode-qty').value='1';
    gv('barcode-result').style.display='block';
    _barcodeScanning=false;
    stopBarcodeCamera();
    setBarcodeStatus('found');
  }catch(e){
    _barcodeScanning=false;
    setBarcodeStatus('error','Lookup failed — product may not be in database.');
    console.error(e);
  }
}

let _barcodeLock=false;
function addBarcodeItem(){
  if(!window._barcodeEntry||_barcodeLock)return;
  _barcodeLock=true;
  const qty=parseFloat(gv('barcode-qty').value)||1;
  const e=window._barcodeEntry;
  const entry={
    name:`${e.name}${qty!==1?' ×'+qty:''}`,
    emoji:'🏷️',
    calories:Math.round(e.calories*qty),
    protein:Math.round(e.protein*qty*10)/10,
    carbs:Math.round(e.carbs*qty*10)/10,
    fat:Math.round(e.fat*qty*10)/10,
    fibre:Math.round(e.fibre*qty*10)/10,
    sugar:Math.round(e.sugar*qty*10)/10,
    sodium:Math.round(e.sodium*qty),
    thumb:null
  };
  meals.push(entry);
  save(`${KEY}_meals_${todayKey()}`,meals);
  renderAll();
  closeBarcodeModal();
  const todayBtn=document.querySelector('.nb');
  if(todayBtn)showPage('today',todayBtn);
  setTimeout(()=>{_barcodeLock=false;},800);
}



// ══════════════════════════════════════════════════════════════════════════
// FEATURE: MACRO IMPACT SCANNER
// ══════════════════════════════════════════════════════════════════════════
let impactB64=null;
let impactEntry=null;

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
  const chips=[
    {v:Math.round(tgt-t.cal), unit:'kcal', label:'left', cls:'cal'},
    {v:Math.round(TARGETS.p-t.p), unit:'g', label:'protein', cls:'p'},
    {v:Math.round(TARGETS.c-t.c), unit:'g', label:'carbs', cls:'c'},
    {v:Math.round(TARGETS.f-t.f), unit:'g', label:'fat', cls:'f'},
  ];
  gv('impact-needs').innerHTML=chips.map(chip=>{
    const done=chip.v<=0;
    const display=done?`✓ ${chip.label}`:`${chip.v}${chip.unit} ${chip.label} left`;
    return `<div class="need-chip ${chip.cls}${done?' done':''}">${display}</div>`;
  }).join('');
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
  if(!impactB64&&!desc){alert('Add a photo or description first.');return;}
  gv('impact-scan-btn').disabled=true;
  gv('impact-loading').classList.add('show');
  gv('impact-result').classList.remove('show');
  impactEntry=null;

  const content=[];
  if(impactB64)content.push({type:'image',source:{type:'base64',media_type:'image/jpeg',data:impactB64}});
  const prompt=impactB64&&desc
    ?`Food item. Description: "${desc}". Give total macros for the whole portion shown.`
    :impactB64?'Identify this food and give total macros for the whole portion shown.'
    :`Total macros for: "${desc}". Use official label if branded.`;
  content.push({type:'text',text:prompt});

  try{
    const res=await fetch(PROXY,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:400,
        system:'Nutrition expert. Return ONLY valid JSON, no markdown: {"name":"food name","emoji":"single emoji","calories":number,"protein":number,"carbs":number,"fat":number,"verdict":"one punchy sentence about whether this fits remaining targets"}',
        messages:[{role:'user',content}]})});
    const data=await res.json();
    const raw=data.content.map(b=>b.text||'').join('').replace(/```json|```/g,'').trim();
    const parsed=JSON.parse(raw);
    impactEntry={name:parsed.name,emoji:parsed.emoji||'🍽️',calories:Math.round(parsed.calories||0),protein:Math.round((parsed.protein||0)*10)/10,carbs:Math.round((parsed.carbs||0)*10)/10,fat:Math.round((parsed.fat||0)*10)/10,fibre:0,sugar:0,sodium:0,thumb:null};
    renderImpactResult(parsed);
  }catch(err){
    alert('Analysis failed. Try again.');console.error(err);
  }finally{
    gv('impact-scan-btn').disabled=false;
    gv('impact-loading').classList.remove('show');
  }
}

function renderImpactResult(parsed){
  const t=getTotals(),tgt=getCalTarget();
  const remP=TARGETS.p-t.p,remC=TARGETS.c-t.c,remF=TARGETS.f-t.f,remCal=tgt-t.cal;
  const p=parsed.protein||0,c=parsed.carbs||0,f=parsed.fat||0,cal=parsed.calories||0;

  gv('impact-item-name').textContent=`${parsed.emoji||'🍽️'} ${parsed.name}`;

  // Score
  let score=0;
  if(remP>5&&p>0) score+=Math.min(p/remP,1)*35;
  if(remC>5&&c>0) score+=Math.min(c/remC,1)*25;
  if(remF>5&&f>0) score+=Math.min(f/remF,1)*20;
  if(remCal>50&&cal>0) score+=Math.min(cal/remCal,1)*20;
  if(p>remP+10) score-=15;
  if(cal>remCal+100) score-=20;
  score=Math.max(0,Math.min(100,Math.round(score)));

  let scoreLabel,scoreCls;
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
    {lbl:'Cals',   cur:t.cal,add:cal,tgt:tgt,  col:'var(--blue2)'},
  ];
  gv('impact-bars').innerHTML=bars.map(b=>{
    const curPct=Math.min(b.cur/b.tgt*100,100);
    const addPct=Math.max(0,Math.min((b.cur+b.add)/b.tgt*100,100)-curPct);
    const after=b.lbl==='Cals'?Math.round(b.cur+b.add)+'kcal':Math.round(b.cur+b.add)+'g';
    const afterCol=(b.cur+b.add)>b.tgt*1.05?'var(--red)':b.col;
    return `<div class="ibar-row">
      <div class="ibar-lbl" style="color:${b.col}">${b.lbl}</div>
      <div class="ibar-track">
        <div style="position:absolute;top:0;left:0;height:100%;width:${curPct}%;background:${b.col};opacity:0.45;border-radius:4px"></div>
        <div style="position:absolute;top:0;left:${curPct}%;height:100%;width:${addPct}%;background:${b.col};border-radius:0 4px 4px 0"></div>
      </div>
      <div class="ibar-after" style="color:${afterCol}">${after}</div>
    </div>`;
  }).join('');

  gv('impact-verdict').innerHTML=`<strong>Verdict:</strong> ${parsed.verdict||''}`;
  gv('impact-result').classList.add('show');
}

let _impactLock=false;
function addImpactMeal(){
  if(!impactEntry||_impactLock)return;
  _impactLock=true;
  meals.push(impactEntry);
  save(`${KEY}_meals_${todayKey()}`,meals);
  renderAll();
  closeImpactModal();
  const todayBtn=document.querySelector('.nb');
  if(todayBtn)showPage('today',todayBtn);
  setTimeout(()=>{_impactLock=false;},800);
}

// ══════════════════════════════════════════════════════════════════════════
// FEATURE: WEEKLY SUMMARY & STREAK
// ══════════════════════════════════════════════════════════════════════════
function getWeekData(){
  const days=[];
  const now=new Date();
  for(let i=6;i>=0;i--){
    const d=new Date(now);d.setDate(now.getDate()-i);
    const key=d.toISOString().slice(0,10);
    const dayMeals=load(`${KEY}_meals_${key}`,[]);
    const dayWater=parseInt(localStorage.getItem(`${KEY}_cups_${key}`)||'0');
    const dayWhoop=load(`${KEY}_whoopsnaps_${key}`,[null,null,null]);
    const t=dayMeals.reduce((a,m)=>({cal:a.cal+m.calories,p:a.p+m.protein,c:a.c+m.carbs,f:a.f+m.fat}),{cal:0,p:0,c:0,f:0});
    const isToday=i===0;
    const hasData=dayMeals.length>0;
    days.push({key,d,t,dayWater,dayWhoop,hasData,isToday,label:d.toLocaleDateString('en-US',{weekday:'short'})});
  }
  return days;
}

function calcStreak(){
  let streak=0;
  const now=new Date();
  for(let i=0;i<60;i++){
    const d=new Date(now);d.setDate(now.getDate()-i);
    const key=d.toISOString().slice(0,10);
    const dayMeals=load(`${KEY}_meals_${key}`,[]);
    if(dayMeals.length>0)streak++;
    else if(i>0)break; // today allowed to be empty (in progress)
  }
  return streak;
}

function renderWeekly(){
  const el=gv('weekly-content');if(!el)return;
  const days=getWeekData();
  const streak=calcStreak();
  const tgt=getCalTarget();

  // Averages over days with data
  const logged=days.filter(d=>d.hasData);
  const avgCal=logged.length?Math.round(logged.reduce((a,d)=>a+d.t.cal,0)/logged.length):0;
  const avgP=logged.length?Math.round(logged.reduce((a,d)=>a+d.t.p,0)/logged.length):0;
  const daysOnTarget=logged.filter(d=>d.t.cal>=tgt*0.8&&d.t.cal<=tgt*1.15).length;

  let html=`
  <div class="week-streak">
    <div class="streak-fire">🔥</div>
    <div class="streak-num">${streak}</div>
    <div class="streak-lbl">day streak</div>
  </div>
  <div class="week-stats-row">
    <div class="wk-s"><div class="wk-v" style="color:var(--blue2)">${avgCal||'—'}</div><div class="wk-l">avg kcal/day</div></div>
    <div class="wk-s"><div class="wk-v" style="color:var(--pc)">${avgP||'—'}g</div><div class="wk-l">avg protein</div></div>
    <div class="wk-s"><div class="wk-v" style="color:var(--cyan)">${daysOnTarget}/7</div><div class="wk-l">days on target</div></div>
  </div>
  <div class="week-bars">`;

  const maxCal=Math.max(...days.map(d=>d.t.cal),tgt,1);
  days.forEach(d=>{
    const h=Math.max(4,Math.round((d.t.cal/maxCal)*80));
    const col=d.t.cal===0?'var(--glass2)':d.t.cal>tgt*1.1?'var(--red)':d.t.cal>=tgt*0.85?'var(--blue2)':'var(--amber)';
    const borderStyle=d.isToday?'border:2px solid var(--blue2);border-bottom:none;':'';
    html+=`<div class="wk-bar-wrap${d.isToday?' today':''}">
      <div class="wk-bar-val" style="color:${col}">${d.t.cal?Math.round(d.t.cal):''}</div>
      <div class="wk-bar" style="height:${h}px;background:${col};opacity:${d.isToday?1:0.7};${borderStyle}"></div>
      <div class="wk-bar-lbl">${d.label}</div>
      <div class="wk-bar-dot" style="background:${d.hasData?'var(--blue2)':'var(--glass2)'}"></div>
    </div>`;
  });
  html+=`</div>`;

  // Per-day detail list
  html+=`<div class="week-days">`;
  [...days].reverse().forEach(d=>{
    if(!d.hasData&&!d.isToday)return;
    const lbl=d.isToday?'Today':d.d.toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});
    const recovery=d.dayWhoop[0]?.recovery;
    const recBadge=recovery!=null?`<span class="wk-badge" style="background:${recovery>=67?'rgba(0,229,190,0.15)':recovery>=34?'rgba(245,166,35,0.15)':'rgba(255,69,69,0.15)'};color:${recovery>=67?'var(--whoop-green)':recovery>=34?'var(--amber)':'var(--red)'}">${recovery}% rec</span>`:'';
    html+=`<div class="week-day-row">
      <div class="wkd-lbl">${lbl}</div>
      <div class="wkd-stats">
        <span style="color:var(--blue2)">${Math.round(d.t.cal)||'—'} kcal</span>
        <span style="color:var(--pc)">${Math.round(d.t.p)||'—'}g P</span>
        <span style="color:var(--cyan)">${d.dayWater} 💧</span>
        ${recBadge}
      </div>
    </div>`;
  });
  html+=`</div>`;

  el.innerHTML=html;
}

// ══════════════════════════════════════════════════════════════════════════
// FEATURE: AUTO-SUGGEST — what to eat based on what's missing
// ══════════════════════════════════════════════════════════════════════════
async function generateSuggestions(){
  const btn=gv('suggest-btn');
  const el=gv('suggest-results');
  if(!btn||!el)return;
  btn.disabled=true;btn.textContent='Thinking…';
  el.innerHTML='<div style="color:var(--muted);font-size:12px;padding:8px 0">Generating suggestions…</div>';

  const t=getTotals(),tgt=getCalTarget();
  const remCal=Math.round(tgt-t.cal);
  const remP=Math.round(TARGETS.p-t.p);
  const remC=Math.round(TARGETS.c-t.c);
  const remF=Math.round(TARGETS.f-t.f);

  const ctx=`Borna has eaten today: ${Math.round(t.cal)} kcal, ${Math.round(t.p)}g protein, ${Math.round(t.c)}g carbs, ${Math.round(t.f)}g fat.
Remaining targets: ${remCal} kcal, ${remP}g protein, ${remC}g carbs, ${remF}g fat.
Time of day: ${new Date().getHours()}:00. Goal: fat loss cut phase.`;

  try{
    const res=await fetch(PROXY,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:600,
        system:'Return ONLY valid JSON, no markdown: {"suggestions":[{"name":"food name","emoji":"emoji","reason":"one line why this fits","calories":number,"protein":number,"carbs":number,"fat":number}]} — 3 suggestions, practical foods available in Dubai, prioritize whatever macro is most behind.',
        messages:[{role:'user',content:ctx}]})});
    const data=await res.json();
    const raw=data.content.map(b=>b.text||'').join('').replace(/```json|```/g,'').trim();
    const parsed=JSON.parse(raw);

    el.innerHTML='';
    for(const s of parsed.suggestions){
      const div=document.createElement('div');
      div.className='sugg-item';
      div.innerHTML=`
        <div class="sugg-top">
          <span class="sugg-emoji">${s.emoji}</span>
          <div class="sugg-name">${s.name}</div>
          <button class="sugg-add" title="Add to log">+</button>
        </div>
        <div class="sugg-reason">${s.reason}</div>
        <div class="sugg-macros">
          <span style="color:var(--blue2)">${s.calories} kcal</span>
          <span style="color:var(--pc)">${s.protein}g P</span>
          <span style="color:var(--cc)">${s.carbs}g C</span>
          <span style="color:var(--fc)">${s.fat}g F</span>
        </div>`;
      div.querySelector('.sugg-add').addEventListener('click',()=>{
        let addLock=false;
        if(addLock)return;addLock=true;
        meals.push({name:s.name,emoji:s.emoji,calories:s.calories,protein:s.protein,carbs:s.carbs,fat:s.fat,fibre:0,sugar:0,sodium:0,thumb:null});
        save(`${KEY}_meals_${todayKey()}`,meals);
        renderAll();
        div.querySelector('.sugg-add').textContent='✓';
        div.querySelector('.sugg-add').disabled=true;
      });
      el.appendChild(div);
    }
  }catch(e){
    el.innerHTML='<div style="color:var(--muted);font-size:12px;padding:8px 0">Suggestions failed. Try again.</div>';
  }finally{
    btn.disabled=false;btn.textContent='↻ Refresh';
  }
}

// Hook renderAll to also call new renderers
const _origRenderAll=renderAll;
window.renderAll=function(){
  _origRenderAll();
  renderNutrients();
  renderWeekly();
};
// Call it once now to init
renderNutrients();
renderWeekly();
