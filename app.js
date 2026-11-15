
const PROXY='https://reborn-proxy.bormotyt.workers.dev';

// ══════════════════════════════════════════════════════════════════════════════
// AI INFRASTRUCTURE v2.0 — Production-Hardened
// ══════════════════════════════════════════════════════════════════════════════

// ── Configuration ──
const AI_CONFIG = {
  maxRetries: 5,                    // Increased from 3
  baseTimeout: 50000,               // 50s base timeout
  imageTimeout: 70000,              // 70s for image analysis (larger payloads)
  minBackoff: 1500,                 // Minimum retry delay
  maxBackoff: 12000,                // Maximum retry delay
  warmupInterval: 4 * 60 * 1000,    // Keep worker warm every 4 minutes
  logRetention: 50,                 // Keep last 50 API logs
};

// ── Network & API State ──
const _aiState = {
  isOnline: navigator.onLine,
  lastSuccessTime: null,
  lastErrorTime: null,
  consecutiveErrors: 0,
  workerWarmed: false,
  warmupTimer: null,
  logs: [],                         // Circular buffer of recent API calls
};

// ── Logging System ──
function _aiLog(type, data) {
  const entry = {
    ts: new Date().toISOString(),
    type,
    ...data
  };
  _aiState.logs.push(entry);
  if (_aiState.logs.length > AI_CONFIG.logRetention) _aiState.logs.shift();
  
  // Console output for debugging (can be disabled in production)
  const prefix = type === 'error' ? '❌' : type === 'retry' ? '🔄' : type === 'success' ? '✅' : 'ℹ️';
  console.log(`[reBorn AI] ${prefix}`, data);
}

// Get recent logs for debugging
function getAILogs() { return [..._aiState.logs]; }

// ── Network Quality Detection ──
window.addEventListener('online', () => { _aiState.isOnline = true; _aiLog('info', { msg: 'Back online' }); });
window.addEventListener('offline', () => { _aiState.isOnline = false; _aiLog('info', { msg: 'Went offline' }); });

function checkNetworkQuality() {
  if (!_aiState.isOnline) return { ok: false, reason: 'offline' };
  
  // Check for slow connection via Network Information API (if available)
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn) {
    if (conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g') {
      return { ok: true, slow: true, type: conn.effectiveType };
    }
    if (conn.saveData) {
      return { ok: true, slow: true, reason: 'data-saver' };
    }
  }
  
  // Check consecutive errors as a signal of poor conditions
  if (_aiState.consecutiveErrors >= 3) {
    return { ok: true, degraded: true, errors: _aiState.consecutiveErrors };
  }
  
  return { ok: true };
}

// ── Worker Warm-up System ──
// Cloudflare Workers sleep after inactivity; this keeps them warm
async function warmupWorker(silent = true) {
  if (_aiState.workerWarmed && Date.now() - _aiState.lastSuccessTime < AI_CONFIG.warmupInterval) {
    return true; // Already warm
  }
  
  try {
    const start = Date.now();
    const res = await fetch(PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ warmup: true }) // Your worker should handle this as a no-op ping
    });
    const latency = Date.now() - start;
    _aiState.workerWarmed = true;
    if (!silent) _aiLog('info', { msg: 'Worker warmed', latency });
    return true;
  } catch (e) {
    if (!silent) _aiLog('error', { msg: 'Warmup failed', error: e.message });
    return false;
  }
}

// Start periodic warmup
function startWarmupTimer() {
  if (_aiState.warmupTimer) return;
  // Initial warmup
  warmupWorker(false);
  // Periodic warmup
  _aiState.warmupTimer = setInterval(() => {
    if (document.visibilityState === 'visible') {
      warmupWorker(true);
    }
  }, AI_CONFIG.warmupInterval);
}

// Stop warmup when app is backgrounded for extended time
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // Coming back — warm up immediately
    warmupWorker(false);
  }
});

// ── Enhanced Fetch with Timeout ──
function fetchWithTimeout(url, options, ms = AI_CONFIG.baseTimeout) {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    let completed = false;
    
    const timer = setTimeout(() => {
      if (!completed) {
        completed = true;
        ctrl.abort();
        reject(new Error(`Request timed out after ${ms}ms`));
      }
    }, ms);
    
    fetch(url, { ...options, signal: ctrl.signal })
      .then(res => {
        if (!completed) {
          completed = true;
          clearTimeout(timer);
          resolve(res);
        }
      })
      .catch(err => {
        if (!completed) {
          completed = true;
          clearTimeout(timer);
          reject(err);
        }
      });
  });
}

// ── Calculate Backoff with Jitter ──
function calcBackoff(attempt) {
  // Exponential backoff: 1.5s, 3s, 6s, 9s, 12s (capped)
  const base = Math.min(AI_CONFIG.minBackoff * Math.pow(2, attempt), AI_CONFIG.maxBackoff);
  // Add jitter: ±25%
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.round(base + jitter);
}

// ── Error Classification ──
function classifyError(error, statusCode) {
  const msg = (error?.message || String(error)).toLowerCase();
  const code = statusCode || 0;
  
  // Non-retryable errors
  if (msg.includes('credit') || msg.includes('billing') || msg.includes('insufficient') || code === 402) {
    return { retryable: false, type: 'billing', userMsg: 'API credits exhausted — top up your Anthropic account.' };
  }
  if ((msg.includes('invalid') && msg.includes('key')) || msg.includes('authentication') || code === 401) {
    return { retryable: false, type: 'auth', userMsg: 'API key invalid — check proxy configuration.' };
  }
  if (msg.includes('invalid_request') || code === 400) {
    return { retryable: false, type: 'bad_request', userMsg: 'Invalid request — please try again.' };
  }
  
  // Retryable errors
  if (msg.includes('overloaded') || msg.includes('capacity') || code === 529) {
    return { retryable: true, type: 'overload', userMsg: 'API is busy — retrying...', priority: 'high' };
  }
  if (msg.includes('rate') || msg.includes('limit') || msg.includes('too many') || code === 429) {
    return { retryable: true, type: 'rate_limit', userMsg: 'Rate limited — waiting to retry...', priority: 'high' };
  }
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted')) {
    return { retryable: true, type: 'timeout', userMsg: 'Request timed out — retrying...' };
  }
  if (msg.includes('network') || msg.includes('fetch') || msg.includes('load failed') || msg.includes('failed to fetch')) {
    return { retryable: true, type: 'network', userMsg: 'Network error — retrying...' };
  }
  if (code >= 500) {
    return { retryable: true, type: 'server', userMsg: 'Server error — retrying...' };
  }
  
  // Unknown but probably retryable
  return { retryable: true, type: 'unknown', userMsg: 'Something went wrong — retrying...' };
}

// ── Retry Status Callback (for UI updates) ──
let _onRetryCallback = null;
function setRetryCallback(fn) { _onRetryCallback = fn; }
function clearRetryCallback() { _onRetryCallback = null; }

// ── Main AI Call Function ──
async function callAI(bodyObj, options = {}) {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const hasImage = JSON.stringify(bodyObj).includes('"type":"image"');
  const timeout = options.timeout || (hasImage ? AI_CONFIG.imageTimeout : AI_CONFIG.baseTimeout);
  const maxRetries = options.maxRetries || AI_CONFIG.maxRetries;
  
  // Pre-flight checks
  const netStatus = checkNetworkQuality();
  if (!netStatus.ok) {
    _aiLog('error', { requestId, msg: 'Offline', phase: 'preflight' });
    throw new Error('You appear to be offline. Check your connection.');
  }
  
  let lastErr = null;
  let lastErrClass = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const attemptStart = Date.now();
    
    try {
      // Backoff before retry (not on first attempt)
      if (attempt > 0) {
        const backoff = calcBackoff(attempt);
        _aiLog('retry', { requestId, attempt, backoff, reason: lastErrClass?.type });
        
        // Notify UI of retry
        if (_onRetryCallback) {
          _onRetryCallback({ attempt, maxRetries, backoff, reason: lastErrClass?.userMsg || 'Retrying...' });
        }
        
        await new Promise(r => setTimeout(r, backoff));
      }
      
      // Make the request
      const res = await fetchWithTimeout(PROXY, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Request-ID': requestId,
        },
        body: JSON.stringify(bodyObj)
      }, timeout);
      
      // Parse response
      let data;
      try {
        data = await res.json();
      } catch (parseErr) {
        throw new Error('Invalid JSON response from API');
      }
      
      // Check for API-level errors
      if (data.error) {
        const errClass = classifyError(data.error.message || data.error, res.status);
        if (!errClass.retryable) {
          _aiLog('error', { requestId, attempt, msg: data.error.message, type: errClass.type, final: true });
          throw new Error(data.error.message || JSON.stringify(data.error));
        }
        lastErr = new Error(data.error.message || JSON.stringify(data.error));
        lastErrClass = errClass;
        continue; // Retry
      }
      
      // Success!
      const latency = Date.now() - attemptStart;
      _aiState.lastSuccessTime = Date.now();
      _aiState.consecutiveErrors = 0;
      _aiState.workerWarmed = true;
      
      _aiLog('success', { requestId, attempt, latency, model: bodyObj.model });
      
      return data;
      
    } catch (e) {
      lastErr = e;
      lastErrClass = classifyError(e);
      
      _aiLog('error', { requestId, attempt, msg: e.message, type: lastErrClass.type });
      
      // Don't retry non-retryable errors
      if (!lastErrClass.retryable) {
        _aiState.consecutiveErrors++;
        _aiState.lastErrorTime = Date.now();
        throw e;
      }
      
      // Check if we should continue retrying
      if (attempt >= maxRetries - 1) {
        _aiState.consecutiveErrors++;
        _aiState.lastErrorTime = Date.now();
        break; // Fall through to throw
      }
    }
  }
  
  // All retries exhausted
  _aiLog('error', { requestId, msg: 'All retries exhausted', finalError: lastErr?.message });
  throw lastErr || new Error('Request failed after multiple retries');
}

// ── Extract Text from Response (with better error handling) ──
function aiText(data) {
  if (data.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }
  if (data.type === 'error') {
    throw new Error(data.error?.message || 'API returned an error');
  }
  if (!data.content || !Array.isArray(data.content)) {
    console.error('[reBorn AI] Invalid response structure:', data);
    throw new Error('Invalid API response structure');
  }
  
  const text = data.content
    .filter(block => block.type === 'text')
    .map(block => block.text || '')
    .join('');
  
  if (!text && data.content.length > 0) {
    // Response has content but no text (might be tool use, etc)
    console.warn('[reBorn AI] Response has no text blocks:', data.content);
  }
  
  return text;
}

// ── Robust JSON Extraction from AI Response ──
function extractJSON(text) {
  if (!text || typeof text !== 'string') return null;
  
  // Step 1: Remove markdown code fences
  let cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
  
  // Step 2: Try to find JSON object or array
  // Look for the outermost { } or [ ]
  const jsonPatterns = [
    /\{[\s\S]*\}/,  // Object
    /\[[\s\S]*\]/   // Array
  ];
  
  for (const pattern of jsonPatterns) {
    const match = cleaned.match(pattern);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e) {
        // Try to fix common issues
        let fixed = match[0]
          .replace(/,\s*}/g, '}')     // Trailing commas in objects
          .replace(/,\s*\]/g, ']')    // Trailing commas in arrays
          .replace(/'/g, '"')          // Single quotes to double
          .replace(/(\w+):/g, '"$1":') // Unquoted keys (rough)
          .replace(/""+/g, '"');       // Double double-quotes
        
        try {
          return JSON.parse(fixed);
        } catch (e2) {
          continue; // Try next pattern
        }
      }
    }
  }
  
  // Step 3: Last resort — try parsing the whole cleaned string
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('[reBorn AI] JSON extraction failed:', { original: text.slice(0, 200), cleaned: cleaned.slice(0, 200) });
    return null;
  }
}

// ── User-Friendly Error Messages ──
function _apiErrMsg(e) {
  const errClass = classifyError(e);
  
  // Add network status context
  if (!_aiState.isOnline) {
    return 'You\'re offline — check your internet connection.';
  }
  
  // Add retry context if applicable
  if (_aiState.consecutiveErrors >= 3) {
    return `${errClass.userMsg.replace(' — retrying...', '')} (${_aiState.consecutiveErrors} failures — the service may be experiencing issues)`;
  }
  
  return errClass.userMsg.replace(' — retrying...', ' — please try again.');
}

// ── AI Health Check ──
function getAIHealth() {
  const now = Date.now();
  const timeSinceSuccess = _aiState.lastSuccessTime ? now - _aiState.lastSuccessTime : null;
  const timeSinceError = _aiState.lastErrorTime ? now - _aiState.lastErrorTime : null;
  
  let status = 'unknown';
  if (_aiState.consecutiveErrors >= 5) status = 'degraded';
  else if (_aiState.consecutiveErrors >= 2) status = 'unstable';
  else if (timeSinceSuccess && timeSinceSuccess < 60000) status = 'healthy';
  else if (_aiState.workerWarmed) status = 'ready';
  
  return {
    status,
    online: _aiState.isOnline,
    workerWarmed: _aiState.workerWarmed,
    consecutiveErrors: _aiState.consecutiveErrors,
    timeSinceSuccess,
    timeSinceError,
    network: checkNetworkQuality()
  };
}

// ── Initialize warmup on load ──
startWarmupTimer();

// ══════════════════════════════════════════════════════════════════════════════
// END AI INFRASTRUCTURE
// ══════════════════════════════════════════════════════════════════════════════

// Lightweight markdown → HTML (bold, italic, headings, newlines)
function md(text){
  if(!text)return'';
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\*\*\*(.+?)\*\*\*/gs,'<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/gs,'<strong>$1</strong>')
    .replace(/\*([^*\n]+?)\*/g,'<em>$1</em>')
    .replace(/^#{3}\s+(.+)$/gm,'<div class="md-h3">$1</div>')
    .replace(/^#{2}\s+(.+)$/gm,'<div class="md-h2">$1</div>')
    .replace(/^#{1}\s+(.+)$/gm,'<div class="md-h1">$1</div>')
    .replace(/\n/g,'<br>');
}
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
  {label:'This Morning',sub:'Log sleep and recovery from this morning.',fields:[
    {id:'sleep',label:'Sleep',ph:'7:42',step:'',inputType:'sleep'},
    {id:'recovery',label:'Recovery %',ph:'e.g. 72',step:'1'},
  ]},
];

const todayKey=()=>new Date().toISOString().slice(0,10);
const load=(k,d)=>{try{return JSON.parse(localStorage.getItem(k))??d}catch{return d}};
const save=(k,v)=>{localStorage.setItem(k,JSON.stringify(v));if(typeof cloudPush==='function')cloudPush(k,v);};
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
let cups       =parseFloat(localStorage.getItem(`${KEY}_cups_${todayKey()}`)||'0')||0;
let entries    =load(`${KEY}_entries`,[]);
let quickItems =load(`${KEY}_quickitems`,DEFAULT_QA);
let calViewDate=new Date();
let calSelKey  =todayKey();
let mealB64    =null;
let ingredients=[];
let activeTab  =0;
const _mealThumbs=new Map(); // session-only thumb storage (keyed by loggedAt)

// Hydration wave slider state (declared early so renderCups() — invoked from the
// boot-time renderAll() below — doesn't hit a TDZ error when it references this.)
const _waveState = {
  mounted: false,
  displayCups: 0,
  p1: 0,
  p2: Math.PI,
  animTarget: null,
  animStart: 0,
  animFrom: 0,
  animDur: 160,
  lastW: 0,
  lastH: 0,
};

// FASTING STATE (must be declared before BOOT runs to avoid TDZ crashes)
const FAST_LOG_KEY   = 'fasting_log';
const FAST_STATE_KEY = `${KEY}_fast_state`;
const FAST_AI_KEY    = `${KEY}_fast_ai_rec`;
const FAST_CIRC      = 729.1;
const FAST_PHASES    = [
  {hours:0, name:'Digestion',          icon:'🍽️', desc:'Your body is processing your last meal'},
  {hours:4, name:'Glycogen Depletion', icon:'⚡',  desc:'Liver glycogen stores are being depleted'},
  {hours:8, name:'Fat Burning Begins', icon:'🔥',  desc:'Fat oxidation is ramping up'},
  {hours:12,name:'Deep Fat Burning',   icon:'💪',  desc:'Body is in full fat-burning mode'},
  {hours:16,name:'Autophagy Zone',     icon:'🧬',  desc:'Cellular repair and renewal underway'},
];
const FAST_PROTO_HRS = {'16:8':16,'18:6':18,'20:4':20,'custom':0};
let fastState    = load(FAST_STATE_KEY, null);
let fastLog      = load(FAST_LOG_KEY, []);
let fastTimer    = null;
let fastProtocol = '16:8';
let fastCustomHrs= 0;

// WORKOUT STORAGE KEYS (must be declared before BOOT runs — renderWhoopSnap reads woHistory)
const WO_KEY      = `${KEY}_workout`;       // active/in-progress session
const WO_HIST_KEY = `${KEY}_wo_history`;    // array of completed sessions
const WO_PBS_KEY  = `${KEY}_wo_pbs`;        // personal bests per exercise
const WO_NOTES_KEY = `${KEY}_wo_notes`;     // per-exercise persistent notes
const WO_PREFS_KEY = `${KEY}_wo_prefs`;     // generator preferences (variety mode)

// WHOOP ACTIVITY KEY (must be declared before BOOT runs — renderWhoopSnap reads activities)
const WH_ACT_KEY = (ds) => `${KEY}_whoopActivities_${ds || todayKey()}`;

// BOOT
const _n=new Date();
const _hdrDate=gv('hdr-date');if(_hdrDate)_hdrDate.innerHTML=_n.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})+'<br>'+_n.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
gv('coach-date').textContent=_n.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
renderAll();
initWelcomeCard();

function renderAll(){
  renderWhoopCard();renderSummary();renderRings();
  renderCups();renderFoodList();
  renderProgressPage();buildCalendar();updateCoachStats();
  // refresh smart subtitle with latest stats
  const sub=gv('wc-sub');if(sub)sub.textContent=getSmartSub();
}

// NAV
const PAGE_ORDER=['today','workout','fast','coach','progress'];
let _currentPage='today';
// Glide the nav pill under the active tab; hide it on pages without a tab (Progress).
function syncNavIndicator(){
  const inner=document.querySelector('.bnav-inner');if(!inner)return;
  const tabs=[...inner.querySelectorAll('.nb')];
  const i=tabs.findIndex(b=>b.classList.contains('active'));
  inner.classList.toggle('no-ind',i<0);
  if(i>=0)inner.style.setProperty('--nb-i',i);
}

function showPage(id,btn){
  if(btn&&btn.classList&&btn.classList.contains('nb')&&id!==_currentPage)woHaptic(6);
  const fromIdx=PAGE_ORDER.indexOf(_currentPage);
  const toIdx=PAGE_ORDER.indexOf(id);
  const dir=toIdx>=fromIdx?1:-1;
  const outgoing=gv('pg-'+_currentPage);
  const incoming=gv('pg-'+id);
  if(outgoing&&outgoing!==incoming){
    outgoing.classList.add(dir===1?'page-exit-left':'page-exit-right');
    outgoing.addEventListener('animationend',()=>{
      outgoing.classList.remove('active','page-exit-left','page-exit-right');
    },{once:true});
  }
  // Clear active states
  document.querySelectorAll('.nb').forEach(b=>b.classList.remove('active'));
  const cfab=gv('coach-fab');if(cfab)cfab.classList.remove('active');
  // Set active on correct button
  if(btn&&btn.classList.contains('nb'))btn.classList.add('active');
  else if(btn&&btn.id==='coach-fab'&&cfab)cfab.classList.add('active');
  // else: progress pill — no nav button highlighted
  incoming.classList.remove('page-exit-left','page-exit-right');
  incoming.classList.add('active',dir===1?'page-enter-right':'page-enter-left');
  incoming.addEventListener('animationend',()=>{
    incoming.classList.remove('page-enter-right','page-enter-left');
  },{once:true});
  incoming.scrollTop=0;
  _currentPage=id;
  
  syncNavIndicator();
  
  _updateFab(id);
  if(id==='progress'){renderProgressPage();buildCalendar();}
  if(id==='workout'){renderWorkoutPage();renderWorkoutFastBanner();}
  if(id==='fast')renderFastPage();
  if(id==='coach'){updateCoachStats();if(!chatHistory.length)generateCoachReport();}
}


// ── WHOOP 3-SNAPSHOT ──
function selectWhoopTab(i){
  // Only one tab is supported now — force 0 regardless of what the button requests.
  activeTab=0;
  document.querySelectorAll('.wh-tab').forEach((t,j)=>t.classList.toggle('active',j===0));
  renderWhoopSnap();
}
function renderWhoopCard(){
  const t0 = gv('wh-tab-0');
  if (t0) t0.classList.toggle('has-data', !!whoopSnaps[0]);
  renderWhoopSnap();
}
function renderWhoopSnap(){
  const el=gv('wh-snap-display');
  if(!el) return;
  const morning = whoopSnaps[0];

  // Morning recovery/sleep row
  let morningHtml = '';
  if (morning) {
    const recVal = morning.recovery!=null ? morning.recovery+'%' : '—';
    const sleepVal = morning.sleep!=null ? (()=>{const hh=Math.floor(morning.sleep),mm=Math.round((morning.sleep-hh)*60);return hh+'h'+(mm>0?' '+mm+'m':'');})() : '—';
    morningHtml = `<div class="wh-grid wh-grid-2">
      <div class="wh-s"><div class="wh-v">${recVal}</div><div class="wh-l">Recovery</div></div>
      <div class="wh-s"><div class="wh-v">${sleepVal}</div><div class="wh-l">Sleep</div></div>
    </div>`;
  } else {
    morningHtml = `<div class="wh-empty">No morning data yet. Tap <strong>+ Morning</strong> for recovery &amp; sleep.</div>`;
  }

  // Today's activities
  const acts = whActivities();
  let activitiesHtml = `
    <div class="wh-activities-head">
      <span class="wh-activities-lbl">Activities Today</span>
      <button class="wh-add-activity-btn" onclick="openActivityModal()">+ Activity</button>
    </div>`;

  if (acts.length > 0){
    const totalStrain = getTodaysWorkoutStrain();
    const totalCals = getTodaysWorkoutBurned();
    activitiesHtml += `
      <div class="wh-grid wh-grid-2 wh-totals">
        <div class="wh-s"><div class="wh-v">${totalStrain}</div><div class="wh-l">Total Strain</div></div>
        <div class="wh-s"><div class="wh-v">${totalCals}</div><div class="wh-l">kcal Burned</div></div>
      </div>
      <div class="wh-activities-list">${acts.map(a => {
        const t = new Date(a.loggedAt);
        const tStr = t.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
        return `<div class="wh-activity-row" onclick="openActivityModal('${a.id}')">
          <div class="wh-ar-left">
            <div class="wh-ar-name">${escapeHtml(a.name)}</div>
            <div class="wh-ar-time">${tStr}</div>
          </div>
          <div class="wh-ar-right">
            <div class="wh-ar-stat"><span class="wh-ar-v">${a.strain??'—'}</span><span class="wh-ar-u">strain</span></div>
            <div class="wh-ar-stat"><span class="wh-ar-v">${a.calories??'—'}</span><span class="wh-ar-u">kcal</span></div>
          </div>
        </div>`;
      }).join('')}</div>`;
  } else {
    activitiesHtml += `<div class="wh-empty-small">No activities logged today.</div>`;
  }

  el.innerHTML = morningHtml + `<div class="wh-divider"></div>` + activitiesHtml;
}

// ── Activity modal ──────────────────────────────────────
// If activityId is provided, we're editing; else adding new.
function openActivityModal(activityId) {
  const acts = whActivities();
  const editing = activityId ? acts.find(a => a.id === activityId) : null;

  const modalHtml = `
    <div class="overlay open" id="wh-act-modal">
      <div class="modal">
        <div class="m-handle"></div>
        <div class="m-title">${editing ? 'Edit Activity' : 'Log Activity'}</div>
        <div class="m-sub">Copy the strain &amp; calories from your Whoop for this activity.</div>

        <label class="flbl">Activity</label>
        <input type="text" id="wh-act-name" placeholder="e.g. Gym, Football, Run" value="${editing ? escapeAttr(editing.name) : ''}"/>

        <div class="frow">
          <div>
            <label class="flbl">Strain (1–21)</label>
            <input type="number" id="wh-act-strain" min="0" max="21" step="0.1" placeholder="e.g. 12.4" value="${editing?.strain ?? ''}" inputmode="decimal"/>
          </div>
          <div>
            <label class="flbl">Calories</label>
            <input type="number" id="wh-act-cals" min="0" step="10" placeholder="e.g. 420" value="${editing?.calories ?? ''}" inputmode="numeric"/>
          </div>
        </div>

        <button class="btn-p" onclick="saveActivityFromModal('${activityId || ''}')">
          ${editing ? 'Save Changes' : 'Add Activity'}
        </button>
        ${editing
          ? `<button class="btn-s wh-act-delete" onclick="deleteActivity('${activityId}')">Delete activity</button>`
          : ''}
        <button class="btn-s" onclick="closeActivityModal()">Cancel</button>
      </div>
    </div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = modalHtml.trim();
  document.body.appendChild(wrap.firstElementChild);
  // focus the name field
  setTimeout(() => { const n = gv('wh-act-name'); if (n && !editing) n.focus(); }, 100);
}

function closeActivityModal() {
  const m = gv('wh-act-modal');
  if (m) m.remove();
}

function saveActivityFromModal(activityId) {
  const name = (gv('wh-act-name')?.value || '').trim();
  const strainRaw = gv('wh-act-strain')?.value;
  const calsRaw = gv('wh-act-cals')?.value;

  if (!name) { alert('Add an activity name'); return; }

  const strain = strainRaw !== '' && !isNaN(parseFloat(strainRaw)) ? parseFloat(strainRaw) : null;
  const calories = calsRaw !== '' && !isNaN(parseInt(calsRaw)) ? parseInt(calsRaw) : null;

  const acts = whActivities();
  if (activityId) {
    const idx = acts.findIndex(a => a.id === activityId);
    if (idx >= 0) {
      acts[idx] = { ...acts[idx], name, strain, calories };
    }
  } else {
    acts.push({
      id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2,6),
      name, strain, calories,
      loggedAt: new Date().toISOString()
    });
  }
  whSaveActivities(acts);
  closeActivityModal();
  renderAll();
}

function deleteActivity(activityId) {
  if (!confirm('Delete this activity?')) return;
  const acts = whActivities().filter(a => a.id !== activityId);
  whSaveActivities(acts);
  closeActivityModal();
  renderAll();
}

function escapeHtml(s) {
  return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}
function escapeAttr(s) { return escapeHtml(s); }
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
        html+=`<div><label class="flbl">${f.label} <span style="color:var(--muted);font-size:10px">(h:mm)</span></label><input type="text" id="wf-${f.id}" placeholder="${f.ph}" value="${val}" inputmode="text"/></div>`;
      } else {
        html+=`<div><label class="flbl">${f.label}</label><input type="number" id="wf-${f.id}" placeholder="${f.ph}" step="${f.step}" value="${snap[f.id]??''}"/></div>`;
      }
    }
    html+='</div>';
  }
  if(activeTab===0){
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
// ══════════════════════════════════════════════════════════════════════════════
// WHOOP ACTIVITIES — standalone per-activity log (strain + calories per activity)
// Replaces the time-of-day snapshots for workouts. Works for ANY activity:
// gym, football, run, lift, bike, etc. Each day has its own list.
// ══════════════════════════════════════════════════════════════════════════════
// (WH_ACT_KEY declared above BOOT to prevent TDZ issues during renderAll.)

function whActivities(ds) {
  return load(WH_ACT_KEY(ds), []);
}
function whSaveActivities(arr, ds) {
  save(WH_ACT_KEY(ds), arr);
}

// Sum calories burned across today's activities.
function getTodaysWorkoutBurned(){
  return whActivities().reduce((a,x) => a + (Number(x.calories) || 0), 0);
}

// Sum strain across today's activities (cap at 21 — WHOOP strain ceiling).
function getTodaysWorkoutStrain(){
  const total = whActivities().reduce((a,x) => a + (Number(x.strain) || 0), 0);
  return Math.min(21, Math.round(total * 10) / 10);
}

function getCalTarget(){
  const g=(whoopSnaps[0]&&whoopSnaps[0].goal)||'cut';
  let base=TARGETS.cal;
  if(g==='bulk')     base+=500;
  if(g==='maintain') base+=200;
  // Add today's actual activity calories (sum across entries, rounded to nearest 50).
  const burned=getTodaysWorkoutBurned();
  if(burned>0) base+=Math.round(burned/50)*50;
  return base;
}
function getCalBurnedAdj(){
  const burned=getTodaysWorkoutBurned();
  return burned>0?Math.round(burned/50)*50:0;
}

// SUMMARY
function getTotals(arr){return(arr||meals).reduce((a,m)=>({cal:a.cal+m.calories,p:a.p+m.protein,c:a.c+m.carbs,f:a.f+m.fat,fibre:a.fibre+(m.fibre||0),sugar:a.sugar+(m.sugar||0),sodium:a.sodium+(m.sodium||0)}),{cal:0,p:0,c:0,f:0,fibre:0,sugar:0,sodium:0});}

// Animated number counter — cancels previous if called again on same element
function countUp(el,toVal,duration,suffix,prefix){
  if(!el)return;
  const prevTo=el._countTo;
  el._countTo=toVal;
  if(prevTo===toVal)return; // no change, skip
  const startVal=parseFloat(el._countFrom||0);
  el._countFrom=toVal;
  const startTime=performance.now();
  const isInt=Number.isInteger(toVal);
  function step(now){
    if(el._countTo!==toVal)return; // superseded
    const p=Math.min((now-startTime)/duration,1);
    // ease out cubic
    const ease=1-Math.pow(1-p,3);
    const cur=startVal+(toVal-startVal)*ease;
    el.textContent=(prefix||'')+(isInt?Math.round(cur):(Math.round(cur*10)/10))+(suffix||'');
    if(p<1)requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function renderSummary(){
  const t=getTotals();
  const tgt=getCalTarget(),rem=Math.round(tgt-t.cal),pct=t.cal/tgt;
  // Animate calorie number
  const calEl=gv('cal-num');
  const prevCal=calEl._countTo||0;
  const targetCal=Math.round(t.cal);
  const numSpan=calEl.querySelector('.cal-count-n')||calEl;
  numSpan._countTo=numSpan._countTo||0;
  const oldTarget=numSpan._countTo;
  numSpan._countTo=targetCal;
  if(oldTarget!==targetCal){
    // pulse the hero number
    calEl.classList.remove('cal-pulse');
    void calEl.offsetWidth;
    calEl.classList.add('cal-pulse');
    const startV=parseFloat(numSpan._countFrom||0);
    numSpan._countFrom=targetCal;
    const dur=600,start=performance.now();
    (function step(now){
      if(numSpan._countTo!==targetCal)return;
      const p=Math.min((now-start)/dur,1);
      const ease=1-Math.pow(1-p,3);
      numSpan.textContent=Math.round(startV+(targetCal-startV)*ease);
      if(p<1)requestAnimationFrame(step);
    })(performance.now());
  }
  const rEl=gv('cal-rem');
  rEl.textContent=rem>=0?rem+' left':Math.abs(rem)+' over';
  rEl.className='cal-rem'+(rem<0?' over':pct>0.85?' good':'');
  const burnedAdj=getCalBurnedAdj();
  gv('cal-tlbl').textContent=burnedAdj>0
    ?'of '+tgt.toLocaleString()+' kcal (+'+burnedAdj.toLocaleString()+' burned)'
    :'of '+tgt.toLocaleString()+' kcal target';
  const bar=gv('cal-bar');
  bar.style.width=Math.min(pct*100,100)+'%';
  bar.className='pbar-f'+(t.cal>tgt?' over':pct>0.85?' warn':'');
}

// RINGS
function renderRings(){
  const t=getTotals();
  setRing('rp','rp-v','rp-pct',t.p,TARGETS.p,'g',0);
  setRing('rc','rc-v','rc-pct',t.c,TARGETS.c,'g',80);
  setRing('rf','rf-v','rf-pct',t.f,TARGETS.f,'g',160);
}
function setRing(id,vid,pid,cur,tgt,unit,delay){
  const raw=cur/tgt;
  const targetOffset=CIRC-Math.min(raw,1)*CIRC;
  const over=raw>1;
  const strokeEl=gv(id);
  const valEl=gv(vid);
  const pctEl=gv(pid);
  // ring colour
  strokeEl.style.stroke=over?'var(--red)':'';
  pctEl.style.color=over?'var(--red)':'';
  // animate ring draw
  const prevOffset=parseFloat(strokeEl._prevOffset!=null?strokeEl._prevOffset:CIRC);
  if(Math.abs(prevOffset-targetOffset)>0.5){
    strokeEl._prevOffset=targetOffset;
    // briefly reset to start then let CSS transition carry it
    strokeEl.style.transition='none';
    strokeEl.style.strokeDashoffset=prevOffset;
    setTimeout(()=>{
      strokeEl.style.transition='stroke-dashoffset .9s cubic-bezier(.34,1.56,.64,1)';
      strokeEl.style.strokeDashoffset=targetOffset;
    }, delay||0);
  }
  // count up value label
  const prevVal=parseFloat(valEl._countFrom||0);
  valEl._countFrom=cur;
  const dur=700,start=performance.now()+delay;
  (function stepV(now){
    if(now<start){requestAnimationFrame(stepV);return;}
    const p=Math.min((now-start)/dur,1);
    const ease=1-Math.pow(1-p,3);
    valEl.textContent=Math.round(prevVal+(cur-prevVal)*ease)+unit;
    if(p<1)requestAnimationFrame(stepV);
  })(performance.now());
  // count up pct label
  const prevPct=parseFloat(pctEl._countFrom||0);
  pctEl._countFrom=raw*100;
  (function stepP(now){
    if(now<start){requestAnimationFrame(stepP);return;}
    const p=Math.min((now-start)/dur,1);
    const ease=1-Math.pow(1-p,3);
    pctEl.textContent=Math.round(prevPct+(raw*100-prevPct)*ease)+'%';
    if(p<1)requestAnimationFrame(stepP);
  })(performance.now());
}

// CUPS — water wave slider (state object hoisted to top of file to avoid TDZ)
function _waveBuildPath(w, h, fill01, phase, freq, amp, baseOffset){
  // fill01: 0..1 of the container. 0 = dry (water at bottom), 1 = full.
  // Build a path sampling N points across the width, then close along the bottom.
  // Output is a smooth-looking polyline (plenty of samples, no bezier needed for this size).
  const baseY = h * (1 - fill01) + baseOffset;
  const N = Math.max(24, Math.ceil(w / 8));
  let d = '';
  for (let i = 0; i <= N; i++){
    const x = (i / N) * w;
    const y = baseY + Math.sin((x / w) * freq * Math.PI * 2 + phase) * amp;
    d += (i === 0 ? 'M ' : 'L ') + x.toFixed(2) + ' ' + y.toFixed(2) + ' ';
  }
  d += 'L ' + w.toFixed(2) + ' ' + h.toFixed(2) + ' ';
  d += 'L 0 ' + h.toFixed(2) + ' Z';
  return d;
}

function _waveMeasureSurface(w, h, fill01, phase, freq, amp, baseOffset){
  // Return y-coord of the foreground wave at a given x (for bobbing the thumb).
  const baseY = h * (1 - fill01) + baseOffset;
  return function(x){
    return baseY + Math.sin((x / w) * freq * Math.PI * 2 + phase) * amp;
  };
}

function _waveLevelFromCups(c){
  // Map cups -> fill01 with a small floor so even at 0 there's a thin puddle visible.
  if (c <= 0) return 0;
  const f = Math.min(c / CUPS, 1);
  // soft nonlinearity: feels more satisfying (small fills appear instantly, tapers at top)
  return 0.03 + f * 0.97;
}

function _waveCommitCups(newCups, persist){
  // Called during drag (persist=false) and on release (persist=true).
  cups = newCups;
  if (persist){
    localStorage.setItem(`${KEY}_cups_${todayKey()}`, String(cups));if(typeof cloudPush==='function')cloudPush(`${KEY}_cups_${todayKey()}`,cups);
  }
  // Update compact readouts in the section header
  const a = gv('water-cups'); if (a) a.textContent = _waveFormatCups(cups);
  const b = gv('water-ml-display'); if (b) b.textContent = Math.round(cups * ML_PER_CUP).toLocaleString();
  const c = gv('water-wave-cups-lbl'); if (c) c.textContent = _waveFormatCups(cups);
  const wrap = gv('water-wave-wrap');
  if (wrap) wrap.setAttribute('aria-valuenow', String(cups));
  const hint = gv('water-wave-hint');
  if (hint) hint.style.opacity = cups <= 0.01 ? '' : '0';
}

function _waveFormatCups(c){
  // 4, 4.5, 0 etc. — trim trailing .0
  const r = Math.round(c * 2) / 2;
  return (r % 1 === 0) ? String(r) : r.toFixed(1);
}

function _waveMountOnce(){
  if (_waveState.mounted) return;
  const wrap = gv('water-wave-wrap');
  const svg  = gv('water-wave-svg');
  const clipRect = gv('water-wave-clip-rect');
  const bgPath = gv('water-wave-bg-path');
  const fgPath = gv('water-wave-fg-path');
  const thumb  = gv('water-wave-thumb');
  if (!wrap || !svg || !bgPath || !fgPath || !thumb) return;
  _waveState.mounted = true;

  _waveState.displayCups = cups;

  // --- Sizing ---
  let W = 0, H = 0;
  const measure = () => {
    const r = wrap.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    clipRect.setAttribute('width', W);
    clipRect.setAttribute('height', H);
    _waveState.lastW = W;
    _waveState.lastH = H;
  };
  measure();
  if (typeof ResizeObserver !== 'undefined'){
    new ResizeObserver(measure).observe(wrap);
  } else {
    window.addEventListener('resize', measure, { passive: true });
  }

  // --- Drag / tap interaction ---
  let dragging = false;
  let lastPointerX = 0;
  const setFromClientX = (clientX, commit) => {
    const r = wrap.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    // Map ratio -> cups, snap to 0.5 on commit, free during drag for smooth feel.
    let newCups = ratio * CUPS;
    if (commit) newCups = Math.round(newCups * 2) / 2;
    else        newCups = Math.round(newCups * 20) / 20; // 0.05 cup resolution during drag
    _waveState.displayCups = newCups;
    _waveCommitCups(newCups, commit);
  };

  const onDown = (e) => {
    dragging = true;
    wrap.classList.add('is-dragging');
    lastPointerX = e.clientX;
    if (wrap.setPointerCapture && e.pointerId != null){
      try { wrap.setPointerCapture(e.pointerId); } catch(_){}
    }
    setFromClientX(e.clientX, false);
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging) return;
    lastPointerX = e.clientX;
    setFromClientX(e.clientX, false);
  };
  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    wrap.classList.remove('is-dragging');
    // Snap to nearest 0.5 cup with a small glide animation for tactile feedback.
    const snapped = Math.round(_waveState.displayCups * 2) / 2;
    _waveState.animFrom = _waveState.displayCups;
    _waveState.animTarget = snapped;
    _waveState.animStart = performance.now();
    // Persist committed value right away so refreshes keep it.
    _waveCommitCups(snapped, true);
  };

  wrap.addEventListener('pointerdown', onDown);
  wrap.addEventListener('pointermove', onMove);
  wrap.addEventListener('pointerup', onUp);
  wrap.addEventListener('pointercancel', onUp);

  // Keyboard support (←/→ = -/+ 0.5 cup, Home/End = 0 / 8)
  wrap.addEventListener('keydown', (e) => {
    let step = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') step = 0.5;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') step = -0.5;
    else if (e.key === 'Home') { cups = 0; _waveCommitCups(0, true); _waveState.displayCups = 0; e.preventDefault(); return; }
    else if (e.key === 'End')  { cups = CUPS; _waveCommitCups(CUPS, true); _waveState.displayCups = CUPS; e.preventDefault(); return; }
    if (step !== null){
      const next = Math.max(0, Math.min(CUPS, (Math.round(cups * 2)/2) + step));
      _waveState.displayCups = next;
      _waveCommitCups(next, true);
      e.preventDefault();
    }
  });

  // --- Animation loop ---
  let lastT = performance.now();
  const loop = (now) => {
    const dt = Math.min(64, now - lastT); lastT = now;
    // Wave phase advance — subtle speeds so it never feels hectic.
    _waveState.p1 += dt * 0.0011;   // ~one cycle per ~5.7s
    _waveState.p2 -= dt * 0.00075;  // opposite direction, slower
    // Snap glide animation after drag release
    if (_waveState.animTarget !== null){
      const t = Math.min(1, (now - _waveState.animStart) / _waveState.animDur);
      // easeOutCubic
      const e = 1 - Math.pow(1 - t, 3);
      _waveState.displayCups = _waveState.animFrom + (_waveState.animTarget - _waveState.animFrom) * e;
      if (t >= 1){
        _waveState.displayCups = _waveState.animTarget;
        _waveState.animTarget = null;
      }
    }

    const w = _waveState.lastW, h = _waveState.lastH;
    if (w > 0 && h > 0){
      const fill = _waveLevelFromCups(_waveState.displayCups);
      // Two overlapping waves: background (slower, wider, offset down), foreground (sharper)
      const ampBg = 3.0, ampFg = 4.2;
      bgPath.setAttribute('d', _waveBuildPath(w, h, fill, _waveState.p1, 1.6, ampBg, 3));
      fgPath.setAttribute('d', _waveBuildPath(w, h, fill, _waveState.p2, 2.2, ampFg, 0));

      // Position the thumb so it bobs on the foreground surface
      const thumbX = (Math.round(_waveState.displayCups * 20) / 20 / CUPS) * w;
      const surfaceY = _waveMeasureSurface(w, h, fill, _waveState.p2, 2.2, ampFg, 0)(thumbX);
      // Clamp so the thumb never clips the container edges
      const thumbW = thumb.offsetWidth || 52;
      const thumbH = thumb.offsetHeight || 52;
      const clampedX = Math.max(thumbW / 2 + 2, Math.min(w - thumbW / 2 - 2, thumbX));
      const clampedY = Math.max(thumbH / 2 + 2, Math.min(h - thumbH / 2 - 2, surfaceY));
      thumb.style.transform = `translate(${clampedX - thumbW/2}px, ${clampedY - thumbH/2}px)`;
    }

    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function renderCups(){
  // Mount once, then sync the target level to the current `cups` value.
  _waveMountOnce();
  // If not currently in a drag-snap animation, align displayed level to stored cups.
  if (_waveState.animTarget === null){
    _waveState.displayCups = cups;
  }
  // Sync readouts (idempotent)
  _waveCommitCups(cups, false);
}
function resetWater(){
  // Smooth glide back to 0 rather than a hard snap — feels more tactile.
  _waveState.animFrom = _waveState.displayCups;
  _waveState.animTarget = 0;
  _waveState.animStart = performance.now();
  cups = 0;
  localStorage.setItem(`${KEY}_cups_${todayKey()}`, '0');if(typeof cloudPush==='function')cloudPush(`${KEY}_cups_${todayKey()}`,0);
  _waveCommitCups(0, false);
}

// QUICK ADD
function renderQuickAdd(){ /* qa-scroll removed — QA lives in FAB menu now */ }
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
  try{
  meals.push({name:item.name,emoji:item.emoji,calories:item.calories,protein:item.protein,carbs:item.carbs,fat:item.fat,fibre:item.fibre||0,sugar:item.sugar||0,sodium:item.sodium||0,thumb:null});
  save(`${KEY}_meals_${todayKey()}`,meals);
  renderAll();
  }finally{ setTimeout(()=>{_quickLock=false;},600); }
}
function openQAModal(){['qa-name-in','qa-emoji-in','qa-cal-in','qa-p-in','qa-c-in','qa-f-in'].forEach(id=>gv(id).value='');gv('qa-loading').classList.remove('show');gv('qa-modal').classList.add('open');}
function closeQAModal(){gv('qa-modal').classList.remove('open');}
async function aiLookupQA(){
  const name=gv('qa-name-in').value.trim();if(!name){alert('Enter a name first.');return;}
  const loadingEl = gv('qa-loading');
  loadingEl.classList.add('show');
  try{
    const data=await callAI({model:'claude-sonnet-4-6',max_tokens:300,
      system:'Return ONLY valid JSON, no markdown: {"emoji":"single emoji","calories":number,"protein":number,"carbs":number,"fat":number}',
      messages:[{role:'user',content:`Nutrition facts for: ${name}. Use official label if branded.`}]});
    const raw = aiText(data);
    const p = extractJSON(raw);
    if(!p){throw new Error('Could not parse nutrition data');}
    if(p.emoji)gv('qa-emoji-in').value=p.emoji;
    if(p.calories!=null)gv('qa-cal-in').value=p.calories;
    if(p.protein!=null)gv('qa-p-in').value=p.protein;
    if(p.carbs!=null)gv('qa-c-in').value=p.carbs;
    if(p.fat!=null)gv('qa-f-in').value=p.fat;
  }catch(e){
    console.error('[reBorn] Quick add lookup error:', e);
    alert(_apiErrMsg(e));
  }
  finally{loadingEl.classList.remove('show');}
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
  if(!meals.length){el.innerHTML='<div class="empty-st"><div class="empty-icon">🍽️</div><div>No meals logged yet.<br>Tap Log a Meal or Quick Add.</div></div>';return;}
  el.innerHTML='';
  // Group by category (with fallback to time-based for legacy meals)
  const categoryConfig = {
    'breakfast':    { label: '🌅 Breakfast', order: 0 },
    'lunch':        { label: '☀️ Lunch', order: 1 },
    'snack':        { label: '🍿 Snacks', order: 2 },
    'dinner':       { label: '🌙 Dinner', order: 3 },
    'pre-workout':  { label: '💪 Pre-workout', order: 4 },
    'post-workout': { label: '🏋️ Post-workout', order: 5 },
  };
  
  const groups = {};
  meals.forEach((m,i)=>{
    // Use explicit category if available, otherwise infer from time
    let cat = m.category;
    if (!cat && m.loggedAt) {
      const d = new Date(m.loggedAt);
      const mins = d.getHours() * 60 + d.getMinutes();
      if (mins < 630) cat = 'breakfast';
      else if (mins < 870) cat = 'lunch';
      else if (mins < 1080) cat = 'snack';
      else cat = 'dinner';
    }
    if (!cat) cat = 'snack'; // fallback
    
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push({m, i});
  });
  
  // Sort categories by order and render
  Object.keys(groups)
    .sort((a, b) => (categoryConfig[a]?.order || 99) - (categoryConfig[b]?.order || 99))
    .forEach(cat => {
      const entries = groups[cat];
      if (!entries.length) return;
      
      const groupCal = entries.reduce((s, {m}) => s + Math.round(m.calories), 0);
      const label = categoryConfig[cat]?.label || cat;
      const hdr = document.createElement('div');
      hdr.className = 'meal-group-lbl';
      hdr.innerHTML = `<span>${label}</span><span>${groupCal} kcal</span>`;
      el.appendChild(hdr);
      
      entries.forEach(({m, i}) => {
        const div = document.createElement('div');
        div.className = 'fi';
        const _ts = _mealThumbs.get(m.loggedAt);
        const th = _ts ? `<img class="fi-thumb" src="${_ts}" style="width:46px;height:46px;border-radius:11px;object-fit:cover;flex-shrink:0"/>` : `<div class="fi-thumb">${m.emoji||'🍽️'}</div>`;
        const pPct = Math.min(Math.round(m.protein/TARGETS.p*100), 100);
        const cPct = Math.min(Math.round(m.carbs/TARGETS.c*100), 100);
        const fPct = Math.min(Math.round(m.fat/TARGETS.f*100), 100);
        div.innerHTML = `<div class="fi-top">${th}<div class="fi-info"><div class="fi-name">${m.name}</div><div class="fi-tags"><span class="ft ftcal">${Math.round(m.calories)} kcal</span><span class="ft ftp">${Math.round(m.protein)}g P</span><span class="ft ftc">${Math.round(m.carbs)}g C</span><span class="ft ftf">${Math.round(m.fat)}g F</span></div></div><button class="fi-del">✕</button></div><div class="fi-bars"><div class="fi-bar-row"><span class="fi-bar-lbl">P</span><div class="fi-bar-track"><div class="fi-bar-fill" style="width:${pPct}%;background:var(--pc)"></div></div><span class="fi-bar-val" style="color:var(--pc)">${Math.round(m.protein)}g</span></div><div class="fi-bar-row"><span class="fi-bar-lbl">C</span><div class="fi-bar-track"><div class="fi-bar-fill" style="width:${cPct}%;background:var(--cc)"></div></div><span class="fi-bar-val" style="color:var(--cc)">${Math.round(m.carbs)}g</span></div><div class="fi-bar-row"><span class="fi-bar-lbl">F</span><div class="fi-bar-track"><div class="fi-bar-fill" style="width:${fPct}%;background:var(--fc)"></div></div><span class="fi-bar-val" style="color:var(--fc)">${Math.round(m.fat)}g</span></div></div>`;
        div.querySelector('.fi-del').addEventListener('click', (e) => { e.stopPropagation(); deleteMeal(i); });
        div.addEventListener('click', () => openMealDetail(i));
        el.appendChild(div);
      });
    });
}
function deleteMeal(i){meals.splice(i,1);save(`${KEY}_meals_${todayKey()}`,meals);renderAll();}

// MEAL DETAIL MODAL
function openMealDetail(idx){
  const m=meals[idx];if(!m)return;
  const modal=gv('meal-detail-modal');if(!modal)return;
  // reset edit + analysis state
  const ep=gv('mdd-edit-panel');if(ep)ep.style.display='none';
  const eb=gv('mdd-edit-btn');if(eb){eb.style.display='';eb.disabled=false;}
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
function openMealEdit(){
  const modal=gv('meal-detail-modal');
  const idx=modal._mealIdx;
  const m=meals[idx];if(!m)return;
  gv('mdd-in-cal').value=Math.round(m.calories);
  gv('mdd-in-p').value=Math.round(m.protein*10)/10;
  gv('mdd-in-c').value=Math.round(m.carbs*10)/10;
  gv('mdd-in-f').value=Math.round(m.fat*10)/10;
  gv('mdd-edit-panel').style.display='block';
  gv('mdd-edit-btn').style.display='none';
  gv('mdd-in-cal').focus();
}
function closeMealEdit(){
  gv('mdd-edit-panel').style.display='none';
  gv('mdd-edit-btn').style.display='';
}
function saveMealEdit(){
  const modal=gv('meal-detail-modal');
  const idx=modal._mealIdx;
  const m=meals[idx];if(!m)return;
  const n=(id,fb)=>{const v=parseFloat(gv(id).value);return isNaN(v)?fb:v;};
  m.calories=Math.round(n('mdd-in-cal',m.calories));
  m.protein =Math.round(n('mdd-in-p', m.protein)*10)/10;
  m.carbs   =Math.round(n('mdd-in-c', m.carbs)  *10)/10;
  m.fat     =Math.round(n('mdd-in-f', m.fat)    *10)/10;
  save(`${KEY}_meals_${todayKey()}`,meals);
  renderAll();
  // refresh chips and bars in the modal
  gv('mdd-cal').textContent=m.calories+' kcal';
  gv('mdd-p').textContent=m.protein+'g P';
  gv('mdd-c').textContent=m.carbs+'g C';
  gv('mdd-f').textContent=m.fat+'g F';
  const calPct=Math.min(Math.round(m.calories/getCalTarget()*100),100);
  const pPct=Math.min(Math.round(m.protein/TARGETS.p*100),100);
  const cPct=Math.min(Math.round(m.carbs/TARGETS.c*100),100);
  const fPct=Math.min(Math.round(m.fat/TARGETS.f*100),100);
  gv('mdd-bar-cal').style.width=calPct+'%';gv('mdd-pct-cal').textContent=calPct+'%';
  gv('mdd-bar-p').style.width=pPct+'%';gv('mdd-pct-p').textContent=pPct+'%';
  gv('mdd-bar-c').style.width=cPct+'%';gv('mdd-pct-c').textContent=cPct+'%';
  gv('mdd-bar-f').style.width=fPct+'%';gv('mdd-pct-f').textContent=fPct+'%';
  closeMealEdit();
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
    const data=await callAI({model:'claude-sonnet-4-6',max_tokens:200,
      messages:[{role:'user',content:prompt}]});
    const text=aiText(data).trim();
    gv('mdd-analysis-loading').style.display='none';
    gv('mdd-analysis-body').innerHTML=md(text);
    btn.style.display='none';
  }catch(err){
    gv('mdd-analysis-loading').style.display='none';
    gv('mdd-analysis-body').textContent=_apiErrMsg(err);
    btn.disabled=false;btn.textContent='✦ Analyse with Coach';
  }
}

// LOG MODAL
function openLogModal(){resetLogModal();gv('log-modal').classList.add('open');}
function closeLogModal(){gv('log-modal').classList.remove('open');resetLogModal();}

let _selectedMealCategory = null;

function resetLogModal(){
  mealB64=null;ingredients=[];_selectedMealCategory=null;
  gv('preview').style.display='none';gv('ph-ph').style.display='block';
  gv('photo-zone').classList.remove('has-img');
  gv('meal-desc').value='';gv('ing-results').style.display='none';const li=gv('log-impact');if(li)li.style.display='none';
  gv('ing-list').innerHTML='';gv('btn-analyze').textContent='ANALYSE MEAL';
  gv('btn-analyze').disabled=false;gv('meal-loading').classList.remove('show');
  gv('file-meal').value='';
  const aif=gv('add-ing-form');if(aif)aif.style.display='none';
  // Hide category picker
  const catPicker = gv('meal-cat-picker');
  if(catPicker) catPicker.style.display = 'none';
}

function getDefaultMealCategory() {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  if (mins < 630) return 'breakfast';       // before 10:30am
  if (mins < 870) return 'lunch';            // before 2:30pm
  if (mins < 1020) return 'snack';           // before 5pm
  return 'dinner';                            // 5pm onwards
}

function showMealCategoryPicker() {
  const picker = gv('meal-cat-picker');
  if (!picker) return;
  picker.style.display = 'block';
  
  // Set default category based on time
  const defaultCat = getDefaultMealCategory();
  selectMealCategory(defaultCat);
  
  // Add click handlers to buttons
  document.querySelectorAll('.meal-cat-btn').forEach(btn => {
    btn.onclick = () => selectMealCategory(btn.dataset.cat);
  });
}

function selectMealCategory(cat) {
  _selectedMealCategory = cat;
  document.querySelectorAll('.meal-cat-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.cat === cat);
  });
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
  
  const btn=gv('btn-analyze');
  const loadingEl=gv('meal-loading');
  btn.disabled=true;
  loadingEl.classList.add('show');
  gv('ing-results').style.display='none';
  
  // Set up retry feedback
  const originalBtnText = btn.textContent;
  setRetryCallback(({attempt, maxRetries, reason}) => {
    btn.textContent = `Retry ${attempt}/${maxRetries-1}...`;
    loadingEl.querySelector('.loading-text')?.remove();
    const retryMsg = document.createElement('div');
    retryMsg.className = 'loading-text';
    retryMsg.textContent = reason;
    loadingEl.appendChild(retryMsg);
  });
  
  const content=[];
  if(mealB64)content.push({type:'image',source:{type:'base64',media_type:'image/jpeg',data:mealB64}});
  const prompt=desc?(mealB64?`Analyse this food. Context: "${desc}". Identify every visible ingredient.`:`Identify ingredients and macros for: "${desc}". Use official label for branded products.`):'Identify every ingredient in this food image separately.';
  content.push({type:'text',text:prompt});
  
  try{
    const data=await callAI({model:'claude-sonnet-4-6',max_tokens:1500,
        system:`Precise nutrition expert. Identify each ingredient separately.
Return ONLY valid JSON, no markdown:
{"confidence":"high"|"medium"|"low","confidence_tip":"one sentence or empty","ingredients":[{"name":"name","emoji":"emoji","portion":"e.g. 80g","calories":number,"protein":number,"carbs":number,"fat":number,"fibre":number,"sugar":number,"sodium":number}]}
Identify 2-8 ingredients. Include fibre, sugar, sodium where known (use 0 if unknown). Use official macros for branded products.`,
        messages:[{role:'user',content}]});
    
    // Use robust JSON extraction
    const raw = aiText(data);
    const parsed = extractJSON(raw);
    
    if (!parsed || !parsed.ingredients || !Array.isArray(parsed.ingredients)) {
      throw new Error('Could not parse meal analysis — please try again');
    }
    
    ingredients=parsed.ingredients.map((ing,i)=>({...ing,id:i,portion_multiplier:1,selected:true}));
    const conf=parsed.confidence||'medium';
    const cm={high:{cls:'conf-high',icon:'✓',label:'High Confidence'},medium:{cls:'conf-medium',icon:'~',label:'Medium Confidence'},low:{cls:'conf-low',icon:'!',label:'Low Confidence'}};
    const c=cm[conf];
    gv('conf-badge-wrap').innerHTML=`<div class="conf-badge ${c.cls}">${c.icon} ${c.label}</div>`;
    const te=gv('conf-tip');
    if(parsed.confidence_tip&&conf!=='high'){te.textContent='💡 '+parsed.confidence_tip;te.classList.add('show');}
    else te.classList.remove('show');
    renderIngredients();gv('ing-results').style.display='block';
    showMealCategoryPicker();
    btn.textContent='RE-ANALYSE';
  }catch(err){
    alert(_apiErrMsg(err));
    console.error('[reBorn] Meal analysis error:', err);
    btn.textContent = originalBtnText;
  }
  finally{
    clearRetryCallback();
    btn.disabled=false;
    loadingEl.classList.remove('show');
    // Clean up retry message if any
    loadingEl.querySelector('.loading-text')?.remove();
  }
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
  renderLogImpact();
}

// TOTAL MACRO OVERRIDE
function openTotalEdit(){
  // pre-fill with current computed totals
  const sel=ingredients.filter(i=>i.selected);
  const t=sel.reduce((a,i)=>({cal:a.cal+i.calories*i.portion_multiplier,p:a.p+i.protein*i.portion_multiplier,c:a.c+i.carbs*i.portion_multiplier,f:a.f+i.fat*i.portion_multiplier}),{cal:0,p:0,c:0,f:0});
  gv('tot-cal').value=Math.round(t.cal);
  gv('tot-p').value=Math.round(t.p*10)/10;
  gv('tot-c').value=Math.round(t.c*10)/10;
  gv('tot-f').value=Math.round(t.f*10)/10;
  gv('sel-totals-view').style.display='none';
  gv('sel-totals-edit').style.display='block';
  gv('tot-cal').focus();
}
function closeTotalEdit(){
  gv('sel-totals-edit').style.display='none';
  gv('sel-totals-view').style.display='flex';
}
function saveTotalEdit(){
  const newCal=parseFloat(gv('tot-cal').value);
  const newP  =parseFloat(gv('tot-p').value);
  const newC  =parseFloat(gv('tot-c').value);
  const newF  =parseFloat(gv('tot-f').value);
  if([newCal,newP,newC,newF].some(isNaN)){alert('Fill in all four fields.');return;}
  const sel=ingredients.filter(i=>i.selected);
  if(!sel.length){closeTotalEdit();return;}
  // current totals (with multipliers)
  const cur=sel.reduce((a,i)=>({cal:a.cal+i.calories*i.portion_multiplier,p:a.p+i.protein*i.portion_multiplier,c:a.c+i.carbs*i.portion_multiplier,f:a.f+i.fat*i.portion_multiplier}),{cal:0,p:0,c:0,f:0});
  // scale ratio per macro — guard div-by-zero
  const rCal=cur.cal>0?newCal/cur.cal:0;
  const rP  =cur.p>0?newP/cur.p:0;
  const rC  =cur.c>0?newC/cur.c:0;
  const rF  =cur.f>0?newF/cur.f:0;
  // apply scaling directly to each selected ingredient's base values (reset multiplier to 1)
  sel.forEach(i=>{
    i.calories=Math.round(i.calories*i.portion_multiplier*rCal);
    i.protein =Math.round(i.protein *i.portion_multiplier*rP *10)/10;
    i.carbs   =Math.round(i.carbs   *i.portion_multiplier*rC *10)/10;
    i.fat     =Math.round(i.fat     *i.portion_multiplier*rF *10)/10;
    i.portion_multiplier=1;
    i.portion='custom';
  });
  closeTotalEdit();
  renderIngredients();
}

// INLINE IMPACT PANEL (inside log modal)
function renderLogImpact(){
  const el=gv('log-impact');if(!el)return;
  const sel=ingredients.filter(i=>i.selected);
  if(!sel.length){el.style.display='none';return;}
  const tot=sel.reduce((a,i)=>({cal:a.cal+i.calories*i.portion_multiplier,p:a.p+i.protein*i.portion_multiplier,c:a.c+i.carbs*i.portion_multiplier,f:a.f+i.fat*i.portion_multiplier}),{cal:0,p:0,c:0,f:0});
  const t=getTotals(),tgt=getCalTarget();
  const cal=Math.round(tot.cal),p=Math.round(tot.p*10)/10,c=Math.round(tot.c*10)/10,f=Math.round(tot.f*10)/10;
  const remCal=Math.round(tgt-t.cal),remP=Math.round(TARGETS.p-t.p),remC=Math.round(TARGETS.c-t.c),remF=Math.round(TARGETS.f-t.f);

  // Score
  let score=0;
  if(remP>5&&p>0)score+=Math.min(p/remP,1)*35;
  if(remC>5&&c>0)score+=Math.min(c/remC,1)*25;
  if(remF>5&&f>0)score+=Math.min(f/remF,1)*20;
  if(remCal>50&&cal>0)score+=Math.min(cal/remCal,1)*20;
  if(p>remP+10)score-=15;
  if(cal>remCal+100)score-=20;
  score=Math.max(0,Math.min(100,Math.round(score)));
  let scoreLabel,scoreCls;
  if(score>=75){scoreLabel='Great fit 🔥';scoreCls='score-great';}
  else if(score>=50){scoreLabel='Good fit ✓';scoreCls='score-good';}
  else if(score>=25){scoreLabel='Okay fit';scoreCls='score-ok';}
  else{scoreLabel='Poor fit';scoreCls='score-poor';}
  gv('li-score').textContent=scoreLabel;
  gv('li-score').className=`impact-score ${scoreCls}`;

  // Remaining chips
  const chips=[
    {v:remCal,unit:'kcal',label:'left',cls:'cal'},
    {v:remP,unit:'g',label:'protein',cls:'p'},
    {v:remC,unit:'g',label:'carbs',cls:'c'},
    {v:remF,unit:'g',label:'fat',cls:'f'},
  ];
  gv('li-needs').innerHTML=chips.map(chip=>{
    const done=chip.v<=0;
    return `<div class="need-chip ${chip.cls}${done?' done':''}">${done?`✓ ${chip.label}`:`${chip.v}${chip.unit} ${chip.label} left`}</div>`;
  }).join('');

  // Macro bars
  const bars=[
    {lbl:'Protein',cur:t.p,  add:p,  tgt:TARGETS.p, col:'var(--pc)'},
    {lbl:'Carbs',  cur:t.c,  add:c,  tgt:TARGETS.c, col:'var(--cc)'},
    {lbl:'Fat',    cur:t.f,  add:f,  tgt:TARGETS.f, col:'var(--fc)'},
    {lbl:'Cals',   cur:t.cal,add:cal,tgt:tgt,        col:'var(--blue2)'},
  ];
  gv('li-bars').innerHTML=bars.map(b=>{
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

  // Verdict: simple auto-generated based on score & macros
  let verdict='';
  if(score>=75)verdict=`Solid choice — fills ${Math.round(p/Math.max(remP,1)*100)}% of remaining protein and fits well within your targets.`;
  else if(cal>remCal+100)verdict=`This puts you ${Math.round(cal-remCal)} kcal over your remaining budget. Consider a smaller portion.`;
  else if(p<remP*0.15)verdict=`Low protein hit — only ${p}g. Pair with a protein source to stay on track.`;
  else verdict=`Decent option. Covers ${Math.round(cal/Math.max(remCal,1)*100)}% of remaining calories.`;
  gv('li-verdict').textContent=verdict;

  el.style.display='block';
}

// ADD MISSING INGREDIENT
function toggleAddIngForm(){
  const f=gv('add-ing-form');
  f.style.display=f.style.display==='block'?'none':'block';
  if(f.style.display==='block'){gv('add-ing-name').focus();}
}
async function aiLookupIngredient(){
  const name=gv('add-ing-name').value.trim();if(!name){alert('Enter ingredient name first.');return;}
  const loadingEl = gv('ing-lookup-loading');
  loadingEl.classList.add('show');
  try{
    const data=await callAI({model:'claude-sonnet-4-6',max_tokens:300,
      system:'Return ONLY valid JSON, no markdown: {"emoji":"emoji","portion":"portion description","calories":number,"protein":number,"carbs":number,"fat":number}',
      messages:[{role:'user',content:`Nutrition facts for: ${name}`}]});
    const raw = aiText(data);
    const p = extractJSON(raw);
    if(!p){throw new Error('Could not parse nutrition data');}
    if(p.emoji)gv('add-ing-emoji').value=p.emoji;
    if(p.calories!=null)gv('add-ing-cal').value=p.calories;
    if(p.protein!=null)gv('add-ing-p').value=p.protein;
    if(p.carbs!=null)gv('add-ing-c').value=p.carbs;
    if(p.fat!=null)gv('add-ing-f').value=p.fat;
    if(p.portion)gv('add-ing-portion').value=p.portion;
  }catch(e){
    console.error('[reBorn] Ingredient lookup error:', e);
    alert(_apiErrMsg(e)+' Fill in manually.');
  }
  finally{loadingEl.classList.remove('show');}
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
  try{
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
    category: _selectedMealCategory || getDefaultMealCategory(),
    thumb:null
  };
  meals.push(entry);
  save(`${KEY}_meals_${todayKey()}`,meals);
  // Store thumb in session-only map — never on the entry object (which lives in meals[])
  if(thumbForSession)_mealThumbs.set(entry.loggedAt,thumbForSession);
  gv('log-modal').classList.remove('open');
  resetLogModal();
  renderAll();
  const todayBtn=document.querySelector('.nb');
  if(todayBtn)showPage('today',todayBtn);
  }finally{ setTimeout(()=>{_confirmLock=false;},800); }
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

  // Morning recovery/sleep
  const morningLine = `Morning: Sleep ${ws[0]?.sleep??'—'}h, Recovery ${ws[0]?.recovery??'—'}%`;

  // Today's activities with strain + calories
  const acts = whActivities();
  let activityLines = '';
  if (acts.length > 0){
    activityLines = acts.map(a => `  • ${a.name}: strain ${a.strain??'—'}, ${a.calories??'—'} kcal`).join('\n');
    const totStrain = getTodaysWorkoutStrain();
    const totCals = getTodaysWorkoutBurned();
    activityLines = `Today's activities:\n${activityLines}\n  Total: ${totStrain} strain, ${totCals} kcal burned`;
  } else {
    activityLines = `Today's activities: none logged yet`;
  }
  const whoopSum = `${morningLine}\n${activityLines}`;

  let fastCtx='FASTING: no data';
  try{if(typeof getFastContext==='function')fastCtx=getFastContext();}catch(e){}
  return `BORNA'S DATA TODAY:\nMEALS:\n${mealSum||'None logged'}\nTOTALS: ${Math.round(t.cal)} kcal, ${Math.round(t.p)}g P, ${Math.round(t.c)}g C, ${Math.round(t.f)}g F\nTARGET: ${getCalTarget()} kcal (cut phase)\nMACRO TARGETS: 128g P, 200g C, 65g F\nWHOOP:\n${whoopSum}\nWATER: ${cups} cups (${cups*ML_PER_CUP}ml) / 8 cups\n${fastCtx}\nPROFILE: Male, 26, 89.1kg, 25.1% BF, goal 20.1% BF by Apr 27 2026`;
}

// Build the enriched coach context — called only by generateCoachReport
function _buildCoachContext(){
  const now=new Date();
  const hour=now.getHours();
  const timeLabel=hour<14?'morning/midday (day not over yet)':hour<18?'late afternoon':'evening (full day done)';

  // ── 3-day rolling average ──
  let rollingCal=0,rollingP=0,rollingDays=0;
  for(let i=1;i<=3;i++){
    const d=new Date();d.setDate(d.getDate()-i);
    const ms=load(`${KEY}_meals_${d.toISOString().slice(0,10)}`)||[];
    if(ms.length){
      rollingCal+=ms.reduce((a,m)=>a+m.calories,0);
      rollingP  +=ms.reduce((a,m)=>a+m.protein,0);
      rollingDays++;
    }
  }
  const rolling3=rollingDays>0
    ?`3-day avg (prev days): ${Math.round(rollingCal/rollingDays)} kcal, ${Math.round(rollingP/rollingDays)}g protein (over ${rollingDays} logged day${rollingDays>1?'s':''})`
    :'3-day avg: no recent data';

  // ── Yesterday's coach report summary ──
  const lastReport=localStorage.getItem(`${KEY}_last_coach_report`)||'';
  const yesterdaySummary=lastReport
    ?`Yesterday's report summary (1 sentence): "${lastReport.slice(0,280).replace(/\n/g,' ')}${lastReport.length>280?'…':''}"`
    :'Yesterday\'s report: none stored yet';

  // ── Today's workout ──
  const todayISO=todayKey();
  const todayWorkout=woHistory().find(s=>s.date&&s.date.slice(0,10)===todayISO);
  const workoutCtx=todayWorkout
    ?`Today's workout: COMPLETED — ${todayWorkout.splitName||'session'}, ${todayWorkout.totalVolume||'—'} kg total volume, ${todayWorkout.duration||'—'} min`
    :'Today\'s workout: none logged yet';

  return {timeLabel,rolling3,yesterdaySummary,workoutCtx,hour};
}

let chatHistory=[];

async function generateCoachReport(){
  if(chatHistory.length)return;
  const msgEl=gv('chat-messages');

  // Typing bubble
  const typingDiv=document.createElement('div');
  typingDiv.className='chat-msg coach coach-typing';
  typingDiv.innerHTML='<span></span><span></span><span></span>';
  msgEl.appendChild(typingDiv);
  msgEl.scrollTop=msgEl.scrollHeight;

  const ctx=getDayContext();
  const {timeLabel,rolling3,yesterdaySummary,workoutCtx,hour}=_buildCoachContext();
  const isMorning=hour<14;
  const toneInstruction=isMorning
    ?`It is currently ${timeLabel}. The day is still in progress — do NOT score the day as complete or call it a failure based on what hasn't been logged yet. Focus on what's been done so far and how to finish the day strong.`
    :`It is currently ${timeLabel}. Give a full honest assessment of the complete day.`;
  const scoringInstruction=isMorning
    ?`For OVERALL SCORE: rate effort and trajectory so far (e.g. "7/10 — strong start, protein on track, finish with a solid dinner"). Do NOT penalise for meals not yet eaten.`
    :`For OVERALL SCORE: rate the full day 1-10 with one punchy honest line.`;
  const prompt=`${ctx}

ROLLING CONTEXT:
${rolling3}
${yesterdaySummary}
${workoutCtx}

${toneInstruction}

Give me a direct daily debrief:
1. OVERALL SCORE — ${scoringInstruction}
2. NUTRITION — specific callouts, flag multi-day patterns if protein/calories are consistently off
3. RECOVERY & ACTIVITY — include workout if completed
4. TOP 3 ACTIONS — ${isMorning?'for the rest of today':'for tomorrow'}

Direct. No fluff. Reference the rolling context if there are patterns worth calling out.`;

  try{
    const data=await callAI({model:'claude-sonnet-4-6',max_tokens:900,
      system:'You are a direct, no-nonsense performance and nutrition coach for Borna. Honest, specific, actionable. No filler. When you spot multi-day patterns (e.g. 3rd day under on protein), call them out explicitly.',
      messages:[{role:'user',content:prompt}]});
    const text=aiText(data).trim();
    localStorage.setItem(`${KEY}_last_coach_report`,text);
    chatHistory=[{role:'user',content:prompt},{role:'assistant',content:text}];
    typingDiv.className='chat-msg coach';
    typingDiv.innerHTML=md(text);
    msgEl.scrollTop=msgEl.scrollHeight;
    generateCoachSuggestions(text);
  }catch(err){
    typingDiv.className='chat-msg coach';
    typingDiv.textContent=_apiErrMsg(err);
    console.error(err);
  }
}

async function generateCoachSuggestions(debriefText){
  try{
    const data=await callAI({model:'claude-sonnet-4-6',max_tokens:120,
      system:'You are a nutrition and performance coach.',
      messages:[{role:'user',content:`Based on this daily debrief, write 3 short questions that the athlete would ask their coach — things like "how can I fix my protein intake?", "what should I eat tonight?", "is my deficit too aggressive?". First-person from the athlete's perspective. Return ONLY 3 lines, one question per line, no numbering, under 10 words each.\n\n${debriefText}`}]});
    const chips=aiText(data).trim().split('\n').map(s=>s.trim()).filter(Boolean).slice(0,3);
    const el=gv('coach-suggestions');
    if(!el||!chips.length)return;
    el.innerHTML='';
    chips.forEach(q=>{
      const btn=document.createElement('button');
      btn.className='coach-sug-chip';
      btn.textContent=q;
      btn.onclick=()=>{gv('chat-input').value=q;el.innerHTML='';sendChatMessage();};
      el.appendChild(btn);
    });
  }catch(e){console.error('suggestions failed',e);}
}

function handleChatKey(e){
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChatMessage();}
}

async function sendChatMessage(){
  const inp=gv('chat-input');
  const msg=inp.value.trim();if(!msg)return;
  inp.value='';inp.style.height='auto';
  const sugEl=gv('coach-suggestions');if(sugEl)sugEl.innerHTML='';

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
    const data=await callAI({model:'claude-sonnet-4-6',max_tokens:600,
      system:`You are a direct, no-nonsense performance and nutrition coach for Borna. You have full context of his day. Be specific, honest, and actionable. Keep replies concise.\n\n${getDayContext()}`,
      messages:chatHistory});
    const reply=aiText(data).trim();
    chatHistory.push({role:'assistant',content:reply});
    lDiv.className='chat-msg coach';
    lDiv.innerHTML=md(reply);
  }catch(err){
    lDiv.className='chat-msg coach';
    lDiv.textContent=_apiErrMsg(err);
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

// ── WELCOME CARD LIVE SCENE ──────────────────────────────────────────────────
let _wcRaf=null;
let _wcScene=null;

function _wcStop(){if(_wcRaf){cancelAnimationFrame(_wcRaf);_wcRaf=null;}}

function _wcInitScene(tod,w,h){
  // Seeded pseudo-random so layout is stable
  const rng=(s)=>{let x=Math.sin(s)*10000;return x-Math.floor(x);};
  // Stars
  const stars=Array.from({length:32},(_,i)=>({
    x:rng(i*7+1)*w, y:rng(i*13+2)*h*0.8,
    r:rng(i*3+3)<0.25?1.3:0.6,
    phase:rng(i*11+4)*Math.PI*2,
    speed:0.4+rng(i*5+5)*0.8
  }));
  // Clouds — 2 per scene, different speeds/sizes
  const clouds=[
    {x:w*0.55, y:h*0.22, scale:1,   speed:0.012, opacity:0.18},
    {x:w*0.2,  y:h*0.40, scale:0.7, speed:0.007, opacity:0.12},
  ];
  return {tod,w,h,t:0,stars,clouds,
    sunX:w*0.82, sunY:h*0.30,
    moonX:w*0.78, moonY:h*0.22,
  };
}

function _drawCloud(ctx,cx,cy,scale,alpha){
  ctx.save();
  ctx.globalAlpha=alpha;
  ctx.fillStyle='rgba(255,255,255,1)';
  const s=scale;
  // Simple 3-circle cloud
  const blob=(x,y,r)=>{ctx.beginPath();ctx.arc(cx+x*s,cy+y*s,r*s,0,Math.PI*2);ctx.fill();};
  blob(0,0,11); blob(-13,-4,8); blob(13,-4,9); blob(-22,4,6); blob(22,4,6);
  ctx.restore();
}

function _wcFrame(canvas,bg,scene){
  const {tod,w,h,t}=scene;
  const dpr=scene.dpr||1;
  const ctx=canvas.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,w,h);

  if(tod==='morning'){
    // Sky gradient
    const sk=ctx.createLinearGradient(0,0,w,h);
    sk.addColorStop(0,'#0d2545'); sk.addColorStop(1,'#1e3d20');
    ctx.fillStyle=sk; ctx.fillRect(0,0,w,h);
    // Sun glow
    const sx=scene.sunX, sy=scene.sunY;
    const pulse=1+Math.sin(t*0.9)*0.04;
    const glow=ctx.createRadialGradient(sx,sy,0,sx,sy,w*0.5*pulse);
    glow.addColorStop(0,'rgba(255,200,80,0.22)');
    glow.addColorStop(0.4,'rgba(255,160,40,0.10)');
    glow.addColorStop(1,'transparent');
    ctx.fillStyle=glow; ctx.fillRect(0,0,w,h);
    // Rotating rays
    ctx.save(); ctx.translate(sx,sy);
    const numRays=12;
    for(let i=0;i<numRays;i++){
      const angle=(i/numRays)*Math.PI*2+t*0.25;
      const len=18+Math.sin(t*1.1+i)*3;
      const a=0.06+Math.sin(t*0.7+i*0.5)*0.02;
      ctx.strokeStyle=`rgba(255,210,80,${a})`;
      ctx.lineWidth=2.5;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle)*14,Math.sin(angle)*14);
      ctx.lineTo(Math.cos(angle)*(14+len),Math.sin(angle)*(14+len));
      ctx.stroke();
    }
    ctx.restore();
    // Sun circle
    const sunG=ctx.createRadialGradient(sx,sy,0,sx,sy,12);
    sunG.addColorStop(0,'rgba(255,240,160,0.95)');
    sunG.addColorStop(1,'rgba(255,190,60,0.80)');
    ctx.fillStyle=sunG;
    ctx.beginPath(); ctx.arc(sx,sy,12,0,Math.PI*2); ctx.fill();
    // Drifting clouds
    scene.clouds.forEach(c=>{
      c.x=(c.x+c.speed)%(w+80)-40;
      _drawCloud(ctx,c.x,c.y,c.scale,c.opacity+Math.sin(t*0.3+c.x*0.01)*0.03);
    });

  } else if(tod==='afternoon'){
    // Deeper blue-green sky
    const sk=ctx.createLinearGradient(0,0,w,h);
    sk.addColorStop(0,'#071a2e'); sk.addColorStop(1,'#0d2416');
    ctx.fillStyle=sk; ctx.fillRect(0,0,w,h);
    const sx=scene.sunX-w*0.1, sy=h*0.18;
    // Strong glow
    const pulse=1+Math.sin(t*0.6)*0.03;
    const glow=ctx.createRadialGradient(sx,sy,0,sx,sy,w*0.55*pulse);
    glow.addColorStop(0,'rgba(245,200,60,0.25)');
    glow.addColorStop(0.35,'rgba(245,160,30,0.10)');
    glow.addColorStop(1,'transparent');
    ctx.fillStyle=glow; ctx.fillRect(0,0,w,h);
    // Heat shimmer rays — longer, slower
    ctx.save(); ctx.translate(sx,sy);
    for(let i=0;i<8;i++){
      const angle=(i/8)*Math.PI*2+t*0.12;
      const len=22+Math.sin(t*0.5+i*0.8)*5;
      ctx.strokeStyle=`rgba(255,220,60,${0.05+Math.sin(t*0.4+i)*0.02})`;
      ctx.lineWidth=3;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle)*15,Math.sin(angle)*15);
      ctx.lineTo(Math.cos(angle)*(15+len),Math.sin(angle)*(15+len));
      ctx.stroke();
    }
    ctx.restore();
    // Sun
    const sunG=ctx.createRadialGradient(sx,sy,0,sx,sy,13);
    sunG.addColorStop(0,'rgba(255,248,180,0.98)');
    sunG.addColorStop(1,'rgba(245,200,40,0.85)');
    ctx.fillStyle=sunG;
    ctx.beginPath(); ctx.arc(sx,sy,13,0,Math.PI*2); ctx.fill();
    // One slow cloud
    const c=scene.clouds[0];
    c.x=(c.x+c.speed*0.7)%(w+80)-40;
    _drawCloud(ctx,c.x,c.y*0.6,c.scale*1.2,c.opacity*0.8);

  } else if(tod==='evening'){
    // Deep dusk
    const sk=ctx.createLinearGradient(0,0,0,h);
    sk.addColorStop(0,'#1a0828'); sk.addColorStop(0.6,'#2d0f0a'); sk.addColorStop(1,'#1a0808');
    ctx.fillStyle=sk; ctx.fillRect(0,0,w,h);
    // Horizon glow
    const sx=scene.sunX-w*0.05, sy=h*0.88;
    const hglow=ctx.createRadialGradient(sx,sy,0,sx,sy,w*0.7);
    hglow.addColorStop(0,'rgba(255,100,30,0.28)');
    hglow.addColorStop(0.5,'rgba(200,50,10,0.10)');
    hglow.addColorStop(1,'transparent');
    ctx.fillStyle=hglow; ctx.fillRect(0,0,w,h);
    // Top ambient
    const aglow=ctx.createRadialGradient(w*0.72,h*0.1,0,w*0.72,h*0.1,w*0.4);
    const aPulse=0.08+Math.sin(t*0.4)*0.02;
    aglow.addColorStop(0,`rgba(180,60,180,${aPulse})`);
    aglow.addColorStop(1,'transparent');
    ctx.fillStyle=aglow; ctx.fillRect(0,0,w,h);
    // Few stars appearing
    scene.stars.slice(0,12).forEach(s=>{
      const twinkle=0.3+Math.sin(t*s.speed+s.phase)*0.3;
      ctx.fillStyle=`rgba(255,255,255,${twinkle})`;
      ctx.beginPath(); ctx.arc(s.x,s.y*0.7,s.r*0.8,0,Math.PI*2); ctx.fill();
    });
    // Slow cloud silhouette
    scene.clouds.forEach(c=>{
      c.x=(c.x+c.speed*0.5)%(w+80)-40;
      ctx.save();
      ctx.globalAlpha=0.07;
      ctx.fillStyle='rgba(255,120,60,1)';
      const blob=(x,y,r)=>{ctx.beginPath();ctx.arc(c.x+x,c.y+y,r,0,Math.PI*2);ctx.fill();};
      const s=c.scale;
      blob(0,0,11*s); blob(-13,-4,8*s); blob(13,-4,9*s); blob(-22,4,6*s); blob(22,4,6*s);
      ctx.restore();
    });

  } else { // night
    const sk=ctx.createLinearGradient(0,0,w,h);
    sk.addColorStop(0,'#03050d'); sk.addColorStop(1,'#060810');
    ctx.fillStyle=sk; ctx.fillRect(0,0,w,h);
    // Stars twinkling
    scene.stars.forEach(s=>{
      const twinkle=0.4+Math.sin(t*s.speed+s.phase)*0.35;
      ctx.fillStyle=`rgba(255,255,255,${twinkle})`;
      ctx.beginPath(); ctx.arc(s.x,s.y,s.r,0,Math.PI*2); ctx.fill();
      // Occasional sparkle cross
      if(s.r>1){
        const spark=Math.max(0,Math.sin(t*s.speed*1.5+s.phase)-0.5)*0.3;
        if(spark>0){
          ctx.strokeStyle=`rgba(200,220,255,${spark})`;
          ctx.lineWidth=0.5;
          ctx.beginPath();ctx.moveTo(s.x-4,s.y);ctx.lineTo(s.x+4,s.y);ctx.stroke();
          ctx.beginPath();ctx.moveTo(s.x,s.y-4);ctx.lineTo(s.x,s.y+4);ctx.stroke();
        }
      }
    });
    // Crescent moon — slowly drifting
    const mx=scene.moonX+Math.sin(t*0.05)*6;
    const my=scene.moonY+Math.cos(t*0.04)*3;
    const moonGlow=ctx.createRadialGradient(mx,my,0,mx,my,28);
    moonGlow.addColorStop(0,'rgba(180,200,255,0.10)');
    moonGlow.addColorStop(1,'transparent');
    ctx.fillStyle=moonGlow; ctx.fillRect(0,0,w,h);
    // Moon body
    ctx.fillStyle='rgba(210,225,255,0.90)';
    ctx.beginPath(); ctx.arc(mx,my,10,0,Math.PI*2); ctx.fill();
    // Bite out for crescent
    ctx.globalCompositeOperation='destination-out';
    ctx.fillStyle='rgba(0,0,0,1)';
    ctx.beginPath(); ctx.arc(mx+5,my-2,8,0,Math.PI*2); ctx.fill();
    ctx.globalCompositeOperation='source-over';
    // Subtle blue ambient
    const bglow=ctx.createRadialGradient(w*0.8,h*0.3,0,w*0.8,h*0.3,w*0.45);
    bglow.addColorStop(0,'rgba(40,70,160,0.06)');
    bglow.addColorStop(1,'transparent');
    ctx.fillStyle=bglow; ctx.fillRect(0,0,w,h);
  }

  scene.t+=0.016; // ~60fps time increment
  _wcRaf=requestAnimationFrame(()=>_wcFrame(canvas,bg,scene));
}

function setBgForTime(h,weatherCode){
  _wcStop(); // cancel any existing loop
  const canvas=gv('wc-canvas');
  const bg=gv('wc-bg');
  if(!canvas||!bg)return;
  // Size canvas to physical pixels for crisp rendering
  const dpr=Math.min(window.devicePixelRatio||1,2);
  const pw=canvas.parentElement.offsetWidth||canvas.parentElement.clientWidth||360;
  const ph=(canvas.parentElement.offsetHeight||canvas.parentElement.clientHeight)||140;
  canvas.width=pw*dpr;
  canvas.height=ph*dpr;
  canvas.style.width=pw+'px';
  canvas.style.height=ph+'px';
  const tod=getTimeOfDay(h);
  const bgs={
    morning:  'linear-gradient(135deg,#1a4070,#2a5540)',
    afternoon:'linear-gradient(135deg,#1a3860,#1a4530)',
    evening:  'linear-gradient(135deg,#2e1450,#401818)',
    night:    'linear-gradient(135deg,#0a1020,#101828)',
  };
  bg.style.background=bgs[tod];
  _wcScene=_wcInitScene(tod,pw,ph);
  _wcScene.dpr=dpr;
  // Pause loop when tab hidden (battery saving)
  document.removeEventListener('visibilitychange',_wcVisChange);
  document.addEventListener('visibilitychange',_wcVisChange);
  _wcRaf=requestAnimationFrame(()=>_wcFrame(canvas,bg,_wcScene));
}
function _wcVisChange(){
  if(document.hidden){_wcStop();}
  else if(_wcScene){
    const canvas=gv('wc-canvas');
    const bg=gv('wc-bg');
    if(canvas&&bg)_wcRaf=requestAnimationFrame(()=>_wcFrame(canvas,bg,_wcScene));
  }
}

async function initWelcomeCard(){
  const h=new Date().getHours();
  gv('wc-greeting').textContent=getGreeting(h);
  gv('wc-sub').textContent=getSmartSub();
  // Defer until browser has painted and card has real dimensions
  setTimeout(()=>setBgForTime(h,0), 60);
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

// DAY CALENDAR STRIP (Whoop-style horizontal day picker)
let _dayCalSelected=todayKey();
const SHORT_DOWS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const SHORT_MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function buildDayCalStrip(){
  const el=gv('day-cal-strip');if(!el)return;
  const today=new Date();
  const days=[];
  for(let i=13;i>=0;i--){
    const d=new Date(today);
    d.setDate(d.getDate()-i);
    days.push(d);
  }
  el.innerHTML='';
  days.forEach(d=>{
    const ds=d.toISOString().slice(0,10);
    const hasData=load(`${KEY}_meals_${ds}`,[]).length>0;
    const isActive=ds===_dayCalSelected;
    const isToday=ds===todayKey();
    const dow=isToday?'Today':SHORT_DOWS[d.getDay()];
    const item=document.createElement('div');
    item.className='day-cal-item'+(isActive?' active':'')+(hasData?' has-data':'');
    item.innerHTML=`<span class="dc-dow">${dow}</span><span class="dc-day">${d.getDate()}</span><span class="dc-month">${SHORT_MONTHS[d.getMonth()]}</span>`;
    item.addEventListener('click',()=>selectDayCalDay(ds));
    el.appendChild(item);
  });
  // Scroll to active day
  const activeItem=el.querySelector('.day-cal-item.active');
  if(activeItem)activeItem.scrollIntoView({behavior:'smooth',inline:'center',block:'nearest'});
}
function selectDayCalDay(ds){
  _dayCalSelected=ds;
  // Reload meals and whoop data for selected day
  meals=load(`${KEY}_meals_${ds}`,[]);
  whoopSnaps=load(`${KEY}_whoopsnaps_${ds}`,[null,null,null]);
  cups=parseFloat(localStorage.getItem(`${KEY}_cups_${ds}`)||'0')||0;
  renderAll();
  buildDayCalStrip();
  renderDayPill();
}

// ─── DAY PILL (WHOOP-style day navigator in the header) ─────────
// The pill's center label reads TODAY / YESTERDAY / "APR 22" based on
// how far back we are from today. Arrows step by one day; the right
// arrow is disabled when _dayCalSelected is already today (no future).
// Tapping the label opens the month-picker modal. When viewing a past
// day, a read-only banner appears under the header.
function renderDayPill(){
  const pill=document.getElementById('day-pill');
  const labelEl=document.getElementById('dp-label');
  const nextBtn=document.getElementById('dp-next');
  const banner=document.getElementById('past-day-banner');
  const bannerLbl=document.getElementById('past-day-lbl');
  const pgToday=document.getElementById('pg-today');
  if(!pill||!labelEl||!nextBtn||!pgToday)return;

  const tKey=todayKey();
  const sel=_dayCalSelected||tKey;
  const isToday=sel===tKey;

  // Compute "yesterday" by subtracting one day from today (not from sel)
  const yest=new Date(); yest.setDate(yest.getDate()-1);
  const yKey=yest.toISOString().slice(0,10);

  // Label text: TODAY / YESTERDAY / "APR 22" (or "APR 22, 2025" if a prior year)
  let label;
  if(isToday){label='TODAY';}
  else if(sel===yKey){label='YESTERDAY';}
  else{
    const d=new Date(sel+'T12:00:00');
    const now=new Date();
    const sameYear=d.getFullYear()===now.getFullYear();
    label=SHORT_MONTHS[d.getMonth()].toUpperCase()+' '+d.getDate()+(sameYear?'':', '+d.getFullYear());
  }
  labelEl.textContent=label;

  // Disable the right arrow when on today
  if(isToday){nextBtn.setAttribute('disabled','');nextBtn.setAttribute('aria-disabled','true');}
  else{nextBtn.removeAttribute('disabled');nextBtn.removeAttribute('aria-disabled');}

  // Today-state class (for any future styling hooks)
  pill.classList.toggle('dp-is-today',isToday);

  // Read-only banner under the header when viewing a past day
  pgToday.classList.toggle('viewing-past',!isToday);
  if(!isToday&&banner&&bannerLbl){
    // Use a longer friendly format for the banner (e.g. "Thursday, Apr 24")
    const d=new Date(sel+'T12:00:00');
    const dowLong=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()];
    bannerLbl.textContent=dowLong+', '+SHORT_MONTHS[d.getMonth()]+' '+d.getDate();
  }
}
function _dayPillShift(deltaDays){
  const d=new Date((_dayCalSelected||todayKey())+'T12:00:00');
  d.setDate(d.getDate()+deltaDays);
  const next=d.toISOString().slice(0,10);
  // Clamp to today — never step into the future
  const clamped=next>todayKey()?todayKey():next;
  if(clamped!==_dayCalSelected)selectDayCalDay(clamped);
}
function dayPillPrev(){_dayPillShift(-1);}
function dayPillNext(){_dayPillShift(1);}

// ─── Day-picker month modal ─────────────────────────────────────
// A lightweight standalone month grid; tapping any past-or-today cell
// switches the whole home page to that day via selectDayCalDay.
let _dayCalViewDate=new Date();
function openDayCalendar(){
  _dayCalViewDate=new Date(); // reset to current month each open
  // If selected day is in a different month, show that month instead
  if(_dayCalSelected){
    const d=new Date(_dayCalSelected+'T12:00:00');
    _dayCalViewDate=new Date(d.getFullYear(),d.getMonth(),1);
  }
  buildDayCalendarGrid();
  const m=document.getElementById('daycal-modal');
  if(m)m.classList.add('open');
}
function closeDayCalendar(){
  const m=document.getElementById('daycal-modal');
  if(m)m.classList.remove('open');
}
function dayCalChangeMonth(dir){
  _dayCalViewDate.setMonth(_dayCalViewDate.getMonth()+dir);
  buildDayCalendarGrid();
}
function dayCalJumpToToday(){
  selectDayCalDay(todayKey());
  closeDayCalendar();
}
function dayCalPick(ds){
  // Guard against future dates (shouldn't be clickable, but belt-and-braces)
  if(ds>todayKey())return;
  selectDayCalDay(ds);
  closeDayCalendar();
}
function buildDayCalendarGrid(){
  const lbl=document.getElementById('dcal-month-lbl');
  const grid=document.getElementById('dcal-grid');
  if(!lbl||!grid)return;
  const y=_dayCalViewDate.getFullYear(),m=_dayCalViewDate.getMonth();
  lbl.textContent=['January','February','March','April','May','June','July','August','September','October','November','December'][m]+' '+y;
  const firstDow=new Date(y,m,1).getDay();
  const daysInMonth=new Date(y,m+1,0).getDate();
  const tKey=todayKey();
  const sel=_dayCalSelected||tKey;
  let html='';
  for(let i=0;i<firstDow;i++)html+=`<div class="dcal-cell empty"></div>`;
  for(let d=1;d<=daysInMonth;d++){
    const ds=`${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isFuture=ds>tKey;
    const isToday=ds===tKey;
    const isSelected=ds===sel;
    const hasData=load(`${KEY}_meals_${ds}`,[]).length>0;
    const cls=['dcal-cell'];
    if(isFuture)cls.push('future');
    if(isToday)cls.push('today');
    if(isSelected)cls.push('selected');
    if(hasData)cls.push('has-data');
    const onClick=isFuture?'':` onclick="dayCalPick('${ds}')"`;
    html+=`<div class="${cls.join(' ')}"${onClick}><span>${d}</span>${hasData?'<span class="dcal-dot"></span>':''}</div>`;
  }
  grid.innerHTML=html;
}
// Build strip on boot
buildDayCalStrip();
renderDayPill();

// CALENDAR
function buildCalendar(){
  const ce=gv('cal-grid');if(!ce)return;
  const y=calViewDate.getFullYear(),m=calViewDate.getMonth();
  gv('cal-month-lbl').textContent=MONTHS[m]+' '+y;
  gv('cal-dow').innerHTML=DOWS.map(d=>`<div class="cal-dow">${d}</div>`).join('');
  const fd=new Date(y,m,1).getDay(),days=new Date(y,m+1,0).getDate(),ts=todayKey();
  let html='';
  for(let i=0;i<fd;i++)html+=`<div class="cc empty"></div>`;
  const woSessions=load(`${KEY}_wo_history`,[]);
  for(let d=1;d<=days;d++){
    const ds=`${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const hm=load(`${KEY}_meals_${ds}`,[]).length>0;
    const hw=woSessions.some(s=>s.date&&s.date.slice(0,10)===ds);
    const dots=(hm?`<div style="width:5px;height:5px;border-radius:50%;background:#4ade80;flex-shrink:0"></div>`:'')+
               (hw?`<div style="width:5px;height:5px;border-radius:50%;background:var(--blue2);flex-shrink:0"></div>`:'');
    html+=`<div class="cc${ds===ts?' today':''}${ds===calSelKey?' sel':''}${(hm||hw)?' has-data':''}" onclick="selectDay('${ds}')"><div class="cc-num">${d}</div>${dots?`<div style="display:flex;gap:2px;justify-content:center;margin-top:2px">${dots}</div>`:''}</div>`;
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
  closeEntryModal();renderProgressPage();
}
function deleteEntry(i){entries.splice(i,1);save(`${KEY}_entries`,entries);renderProgressPage();}
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
  const fibreW=Math.min(fibre/30,1), sugarW=Math.min(sugar/50,1), sodiumW=Math.min(sodium/2300,1);
  const fibreCol=fibre>=25?'var(--green)':fibre>=15?'var(--amber)':'var(--muted)';
  const sugarCol=sugar>60?'var(--red)':sugar>40?'var(--amber)':'var(--cc)';
  const sodiumCol=sodium>2300?'var(--red)':sodium>1500?'var(--amber)':'var(--cyan)';
  el.innerHTML=`
    <div class="nut-row">
      <div class="nut-item macro-tap" onclick="openMacroBreakdown('fibre')">
        <div class="nut-top"><span class="nut-lbl">Fibre</span><span class="nut-val" style="color:${fibreCol}">${Math.round(fibre)}g</span></div>
        <div class="nut-bar-bg"><div class="nut-bar-f" style="width:${fibreW*100}%;background:${fibreCol}"></div></div>
        <div class="nut-sub">target 30g</div>
      </div>
      <div class="nut-item macro-tap" onclick="openMacroBreakdown('sugar')">
        <div class="nut-top"><span class="nut-lbl">Sugar</span><span class="nut-val" style="color:${sugarCol}">${Math.round(sugar)}g</span></div>
        <div class="nut-bar-bg"><div class="nut-bar-f" style="width:${sugarW*100}%;background:${sugarCol}"></div></div>
        <div class="nut-sub">keep under 50g</div>
      </div>
      <div class="nut-item macro-tap" onclick="openMacroBreakdown('sodium')">
        <div class="nut-top"><span class="nut-lbl">Sodium</span><span class="nut-val" style="color:${sodiumCol}">${Math.round(sodium)}mg</span></div>
        <div class="nut-bar-bg"><div class="nut-bar-f" style="width:${sodiumW*100}%;background:${sodiumCol}"></div></div>
        <div class="nut-sub">limit 2300mg</div>
      </div>
    </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
// MACRO CONTRIBUTOR BREAKDOWN
// ══════════════════════════════════════════════════════════════════════════
const MACRO_CFG={
  calories: {label:'Calories',    unit:'kcal', key:'calories', color:'var(--blue2)',  target:0,        fmt:v=>Math.round(v)+'kcal'},
  protein:  {label:'Protein',     unit:'g',    key:'protein',  color:'var(--pc)',     target:128,      fmt:v=>Math.round(v*10)/10+'g'},
  carbs:    {label:'Carbs',       unit:'g',    key:'carbs',    color:'var(--cc)',     target:200,      fmt:v=>Math.round(v*10)/10+'g'},
  fat:      {label:'Fat',         unit:'g',    key:'fat',      color:'var(--fc)',     target:65,       fmt:v=>Math.round(v*10)/10+'g'},
  fibre:    {label:'Fibre',       unit:'g',    key:'fibre',    color:'var(--green)',  target:30,       fmt:v=>Math.round(v*10)/10+'g'},
  sugar:    {label:'Sugar',       unit:'g',    key:'sugar',    color:'var(--amber)',  target:50,       fmt:v=>Math.round(v*10)/10+'g'},
  sodium:   {label:'Sodium',      unit:'mg',   key:'sodium',   color:'var(--cyan)',   target:2300,     fmt:v=>Math.round(v)+'mg'},
};

function openMacroBreakdown(macro){
  const cfg=MACRO_CFG[macro];if(!cfg)return;
  // update config target for calories dynamically
  if(macro==='calories')cfg.target=getCalTarget();

  const modal=gv('macro-breakdown-modal');
  gv('mbd-title').textContent=cfg.label+' Contributors';

  // build ranked list from today's meals
  const ranked=meals
    .map((m,i)=>({idx:i, name:m.name, emoji:m.emoji||'🍽️', val:m[cfg.key]||0}))
    .filter(r=>r.val>0)
    .sort((a,b)=>b.val-a.val);

  const total=ranked.reduce((s,r)=>s+r.val,0);
  const tgt=cfg.target;
  const pctOfTarget=tgt>0?Math.round(total/tgt*100):null;

  // sub-header
  let sub=cfg.fmt(total)+' total';
  if(pctOfTarget!==null) sub+=` · ${pctOfTarget}% of ${tgt}${cfg.unit} target`;
  gv('mbd-sub').textContent=sub;

  const listEl=gv('mbd-list');
  const emptyEl=gv('mbd-empty');

  if(!ranked.length){
    listEl.innerHTML='';
    emptyEl.style.display='block';
    modal.classList.add('open');
    return;
  }
  emptyEl.style.display='none';

  const maxVal=ranked[0].val;
  listEl.innerHTML=ranked.map((r,i)=>{
    const barPct=Math.round(r.val/maxVal*100);
    const sharePct=total>0?Math.round(r.val/total*100):0;
    return `<div class="mbd-row">
      <div class="mbd-rank">${i+1}</div>
      <div class="mbd-emoji">${r.emoji}</div>
      <div class="mbd-info">
        <div class="mbd-name">${r.name}</div>
        <div class="mbd-bar-wrap">
          <div class="mbd-bar-track">
            <div class="mbd-bar-fill" style="width:${barPct}%;background:${cfg.color}"></div>
          </div>
          <span class="mbd-share">${sharePct}%</span>
        </div>
      </div>
      <div class="mbd-val" style="color:${cfg.color}">${cfg.fmt(r.val)}</div>
    </div>`;
  }).join('');

  modal.classList.add('open');
}
function closeMacroBreakdown(){
  const modal=gv('macro-breakdown-modal');
  if(modal)modal.classList.remove('open');
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
    await video.play();
    // Wait for metadata so videoWidth/videoHeight are valid before allowing snap
    if(!video.videoWidth){
      await new Promise(res=>{
        video.addEventListener('loadedmetadata',res,{once:true});
        setTimeout(res,2000); // max 2s safety timeout
      });
    }
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
  // Guard: video must have valid dimensions (not a blank/unready frame)
  if(!video.videoWidth||!video.videoHeight){
    setBarcodeStatus('error','Camera not ready — wait a moment then try again.');
    return;
  }
  _barcodeScanning=true;
  setBarcodeStatus('reading');

  // Draw current video frame to canvas
  const canvas=document.createElement('canvas');
  canvas.width=video.videoWidth;
  canvas.height=video.videoHeight;
  const ctx=canvas.getContext('2d');
  ctx.drawImage(video,0,0,canvas.width,canvas.height);
  const b64=canvas.toDataURL('image/jpeg',0.92).split(',')[1];

  try{
    const data=await callAI({model:'claude-sonnet-4-6',max_tokens:100,
      system:'You are a barcode reader. Look at the image and find the barcode number (EAN-13, EAN-8, UPC-A etc). Return ONLY the digits, nothing else. If you cannot find a barcode, return the word NONE.',
      messages:[{role:'user',content:[
        {type:'image',source:{type:'base64',media_type:'image/jpeg',data:b64}},
        {type:'text',text:'What is the barcode number in this image? Return only the digits.'}
      ]}]});
    let raw;
    try{raw=aiText(data).trim().replace(/\s/g,'');}catch(e){
      _barcodeScanning=false;
      setBarcodeStatus('error','AI read failed — type barcode number below.');
      console.error('Barcode API error:',e);
      return;
    }
    // Extract only digits
    const digits=raw.replace(/[^0-9]/g,'');
    if(!digits||raw.toUpperCase()==='NONE'||digits.length<6){
      _barcodeScanning=false;
      setBarcodeStatus('error','Could not read barcode — reposition and try again, or type it below.');
      return;
    }
    gv('barcode-manual').value=digits;
    setBarcodeStatus('looking');
    lookupBarcode(digits,b64);
  }catch(e){
    _barcodeScanning=false;
    setBarcodeStatus('error','Read failed — try again.');
  }
}

function renderBarcodeProduct(prod){
  // prod = {name, servingG, servingLabel, per100, serving}
  window._barcodeEntry={name:prod.name,emoji:'🏷️',...prod.serving,thumb:null};
  window._barcodePer100=prod.per100;
  window._barcodeServingG=prod.servingG;
  window._barcodeName=prod.name;
  gv('bc-name').textContent=prod.name;
  gv('bc-serving').textContent=`Per serving (${prod.servingLabel})`;
  gv('bc-cal').textContent=prod.serving.calories+' kcal';
  gv('bc-p').textContent=prod.serving.protein+'g P';
  gv('bc-c').textContent=prod.serving.carbs+'g C';
  gv('bc-f').textContent=prod.serving.fat+'g F';
  gv('bc-fibre').textContent=prod.serving.fibre+'g fibre';
  gv('bc-sugar').textContent=prod.serving.sugar+'g sugar';
  gv('bc-sodium').textContent=prod.serving.sodium+'mg sodium';
  gv('barcode-qty').value='1';
  gv('barcode-result').style.display='block';
  _barcodeScanning=false;
  stopBarcodeCamera();
  setBarcodeStatus('found');
}

async function lookupBarcode(code,b64=null){
  if(!code||code.trim()===''){alert('Enter a barcode number.');return;}
  const cacheKey=`${KEY}_bc_${code.trim()}`;

  // 1. Check local cache first — works even when OFf is down
  const cached=load(cacheKey,null);
  if(cached){renderBarcodeProduct(cached);return;}

  gv('barcode-status').textContent='Looking up…';
  gv('barcode-result').style.display='none';
  try{
    const res=await fetch(`https://world.openfoodfacts.org/api/v2/product/${code.trim()}?fields=product_name,brands,nutriments,serving_size,serving_quantity,image_front_small_url`);
    const data=await res.json();
    if(data.status!==1||!data.product){
      _barcodeScanning=false;
      setBarcodeStatus('idle',b64?'Not in database — identifying from photo…':'Not found — switching to AI log');
      setTimeout(()=>{closeBarcodeModal();b64?identifyProductFromImage(b64):openLogModal();},600);
      return;
    }
    const p=data.product;
    const n=p.nutriments||{};
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
    const prod={name,servingG,servingLabel,per100,serving};
    // 2. Save to cache so future scans work even offline/OFf down
    localStorage.setItem(cacheKey,JSON.stringify(prod));
    renderBarcodeProduct(prod);
  }catch(e){
    _barcodeScanning=false;
    if(b64){
      setBarcodeStatus('idle','Database unavailable — identifying from photo…');
      setTimeout(()=>{closeBarcodeModal();identifyProductFromImage(b64);},600);
    }else{
      setBarcodeStatus('error','Lookup failed — database may be down.');
    }
    console.error(e);
  }
}

// When OFf has no match, use the original scan photo to identify the product
async function identifyProductFromImage(b64){
  openLogModal();
  const descEl=gv('meal-desc');
  if(descEl)descEl.value='Identifying product from packaging…';
  try{
    const data=await callAI({
      model:'claude-sonnet-4-6',
      max_tokens:80,
      messages:[{role:'user',content:[
        {type:'image',source:{type:'base64',media_type:'image/jpeg',data:b64}},
        {type:'text',text:'What food product is shown? Reply with only the brand and product name (e.g. "Danone Activia Strawberry Yogurt 125g"). Nothing else.'}
      ]}]
    });
    const name=aiText(data).trim().replace(/^["']+|["']+$/g,'');
    if(descEl)descEl.value=name||'Scanned product';
  }catch(e){
    if(descEl)descEl.value='Scanned product';
  }
  analyzeMeal();
}

let _barcodeLock=false;
function addBarcodeItem(){
  if(!window._barcodeEntry||_barcodeLock)return;
  _barcodeLock=true;
  try{
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
  }finally{ setTimeout(()=>{_barcodeLock=false;},800); }
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
  
  const btn = gv('impact-scan-btn');
  const loadingEl = gv('impact-loading');
  btn.disabled=true;
  loadingEl.classList.add('show');
  gv('impact-result').classList.remove('show');
  impactEntry=null;

  // Set up retry feedback
  setRetryCallback(({attempt, maxRetries, reason}) => {
    loadingEl.innerHTML = `<div class="spinner"></div><div>Retry ${attempt}/${maxRetries-1}...</div>`;
  });

  const content=[];
  if(impactB64)content.push({type:'image',source:{type:'base64',media_type:'image/jpeg',data:impactB64}});
  const prompt=impactB64&&desc
    ?`Food item. Description: "${desc}". Give total macros for the whole portion shown.`
    :impactB64?'Identify this food and give total macros for the whole portion shown.'
    :`Total macros for: "${desc}". Use official label if branded.`;
  content.push({type:'text',text:prompt});

  try{
    const data=await callAI({model:'claude-sonnet-4-6',max_tokens:400,
      system:'Nutrition expert. Return ONLY valid JSON, no markdown: {"name":"food name","emoji":"single emoji","calories":number,"protein":number,"carbs":number,"fat":number,"verdict":"one punchy sentence about whether this fits remaining targets"}',
      messages:[{role:'user',content}]});
    const raw=aiText(data);
    const parsed=extractJSON(raw);
    if(!parsed || parsed.calories === undefined){
      throw new Error('Could not parse nutrition data');
    }
    impactEntry={name:parsed.name,emoji:parsed.emoji||'🍽️',calories:Math.round(parsed.calories||0),protein:Math.round((parsed.protein||0)*10)/10,carbs:Math.round((parsed.carbs||0)*10)/10,fat:Math.round((parsed.fat||0)*10)/10,fibre:0,sugar:0,sodium:0,thumb:null};
    renderImpactResult(parsed);
  }catch(err){
    console.error('[reBorn] Impact scan error:', err);
    alert(_apiErrMsg(err));
  }finally{
    clearRetryCallback();
    btn.disabled=false;
    loadingEl.classList.remove('show');
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
  try{
  meals.push(impactEntry);
  save(`${KEY}_meals_${todayKey()}`,meals);
  renderAll();
  closeImpactModal();
  const todayBtn=document.querySelector('.nb');
  if(todayBtn)showPage('today',todayBtn);
  }finally{ setTimeout(()=>{_impactLock=false;},800); }
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

function renderProgressPage(){
  const el=gv('progress-content');if(!el)return;

  // ── Weekly data ──
  const days=getWeekData();
  const streak=calcStreak();
  const tgt=getCalTarget();
  const logged=days.filter(d=>d.hasData);
  const avgCal=logged.length?Math.round(logged.reduce((a,d)=>a+d.t.cal,0)/logged.length):0;
  const avgP=logged.length?Math.round(logged.reduce((a,d)=>a+d.t.p,0)/logged.length):0;
  const daysOnTarget=logged.filter(d=>d.t.cal>=tgt*0.8&&d.t.cal<=tgt*1.15).length;

  // ── Body data ──
  const wEs=entries.filter(e=>e.weight!=null),bEs=entries.filter(e=>e.bf!=null);
  const lw=wEs.length?wEs[wEs.length-1].weight:null,lb=bEs.length?bEs[bEs.length-1].bf:null;
  const pw=wEs.length>1?wEs[wEs.length-2].weight:BASELINE.weight,pb=bEs.length>1?bEs[bEs.length-2].bf:BASELINE.bf;
  const wd=lw!=null?(lw-pw).toFixed(1):null,bd=lb!=null?(lb-pb).toFixed(1):null;
  const dispW=lw!=null?lw.toFixed(1):BASELINE.weight.toFixed(1);
  const dispBF=lb!=null?lb.toFixed(1):BASELINE.bf.toFixed(1);
  const curBF=lb||BASELINE.bf,curWt=lw||BASELINE.weight;
  const curFat=(curBF/100)*curWt,tgtFat=(GOAL_BF/100)*BASELINE.weight;
  const fatLost=BASELINE.fatMass-curFat,totalLose=BASELINE.fatMass-tgtFat;
  const goalPct=Math.max(0,Math.min(100,Math.round((fatLost/totalLose)*100)));

  let html='';
  let statsHtml='';

  // ── ISO week key for AI cache ──
  const _wkDate=new Date();const _wkD=new Date(Date.UTC(_wkDate.getFullYear(),_wkDate.getMonth(),_wkDate.getDate()));
  const _wkDay=_wkD.getUTCDay()||7;_wkD.setUTCDate(_wkD.getUTCDate()+4-_wkDay);
  const _wkYS=new Date(Date.UTC(_wkD.getUTCFullYear(),0,1));
  const weekK=`${_wkD.getUTCFullYear()}-W${String(Math.ceil((((_wkD-_wkYS)/86400000)+1)/7)).padStart(2,'0')}`;
  const _waiCache=localStorage.getItem(`${KEY}_weekly_ai_${weekK}`);

  // ── 1. Streak card ──
  html+=`
  <div class="week-streak" onclick="openStreakModal()" style="cursor:pointer">
    <div class="streak-fire">🔥</div>
    <div class="streak-num">${streak}</div>
    <div class="streak-lbl">day streak</div>
    <div style="margin-left:auto;font-size:20px;color:var(--muted);font-weight:300">›</div>
  </div>`;

  // ── 1b. Weekly AI pattern card ──
  html+=`
  <div id="weekly-ai-summary" class="wk-ai-card">
    <div class="wk-ai-head">
      <span class="wk-ai-title">✦ Weekly Pattern</span>
      <button class="wk-ai-btn" onclick="generateWeeklySummary('${weekK}')">${_waiCache?'↺ Refresh':'Generate'}</button>
    </div>
    <div id="wk-ai-response" class="wk-ai-response"></div>
  </div>`;

  // ── 2. Body stats (Stats tab) ──
  statsHtml+=`
  <div class="prog-hdr"><div class="prog-title">Body Stats</div><button class="add-btn" onclick="openEntryModal()">+ Log</button></div>
  <div class="stats-grid">
    <div class="sc"><div class="sc-lbl">Weight</div><div class="sc-val" style="color:var(--blue2)">${dispW}</div><div class="sc-unit">kg</div>
      ${wd?`<div class="sc-delta"><span class="${parseFloat(wd)<0?'dg':'db'}">${parseFloat(wd)>0?'+':''}${wd} kg</span> vs prev</div>`:'<div class="sc-delta"></div>'}
    </div>
    <div class="sc"><div class="sc-lbl">Body Fat</div><div class="sc-val" style="color:var(--cyan)">${dispBF}</div><div class="sc-unit">%</div>
      ${bd?`<div class="sc-delta"><span class="${parseFloat(bd)<0?'dg':'db'}">${parseFloat(bd)>0?'+':''}${bd}%</span> vs prev</div>`:'<div class="sc-delta"></div>'}
    </div>
  </div>`;

  // ── 3. Goal card (Stats tab) ──
  statsHtml+=`
  <div class="goal-card">
    <div class="goal-top"><div class="goal-lbl">Fat Loss Goal</div><div class="goal-pct">${goalPct}%</div></div>
    <div class="gbar"><div class="gbar-f" style="width:${goalPct}%"></div></div>
    <div class="goal-detail">Baseline: 22.4kg fat → Target: ${tgtFat.toFixed(1)}kg fat · ${Math.max(0,totalLose-fatLost).toFixed(1)}kg to go</div>
    <div class="goal-dates"><span>Started: Mar 4, 2026</span><span>Target: Apr 27, 2026</span></div>
  </div>`;

  // ── 4. This Week ──
  html+=`
  <div class="sec-lbl" style="padding-left:0;padding-top:12px">This Week</div>
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

  // ── Weight Projection Card ──
  const weekKeys2=new Set(days.map(d=>d.key));
  let weekDeficit=0,projLogged=0;
  days.forEach(d=>{if(d.hasData){weekDeficit+=tgt-d.t.cal;projLogged++;}});
  const woBurned=load(`${KEY}_wo_history`,[])
    .filter(s=>weekKeys2.has((s.date||'').slice(0,10)))
    .reduce((a,s)=>a+(s.calories||Math.round((s.duration||0)*5)),0);
  const effDef=weekDeficit+woBurned;
  const latestW=[...entries].reverse().find(e=>e.weight!=null);
  const curW=latestW?.weight??89.1;
  const projW=Math.round((curW-effDef/7700)*10)/10;
  const avgDef=projLogged?Math.round(effDef/projLogged):0;
  const nowD=new Date(),dToSun=(7-nowD.getDay())%7;
  const sunD=new Date(nowD);sunD.setDate(nowD.getDate()+dToSun);
  const sunLbl=dToSun===0?'today':'Sun '+sunD.toLocaleDateString('en-US',{month:'short',day:'numeric'});
  const defCol=effDef>=0?'#4ade80':'var(--amber)';
  const defWord=effDef>=0?'deficit':'surplus';
  html+=`
  <div class="wk-proj-card">
    <div class="wk-proj-head">
      <span class="wk-proj-title">Weight Projection</span>
      <span class="wk-proj-period">→ ${sunLbl}</span>
    </div>
    <div class="wk-proj-body">
      <div>
        <div class="wk-proj-est">Est. Sunday weight</div>
        <div class="wk-proj-num">${projLogged?projW.toFixed(1)+' kg':'—'}</div>
      </div>
      ${projLogged
        ?`<div class="wk-proj-range-block"><div class="wk-proj-range">±0.3 kg</div><div class="wk-proj-from">from ${curW}kg baseline</div></div>`
        :`<div class="wk-proj-nodata">Log meals to see projection</div>`}
    </div>
    <div class="wk-proj-stats">
      <div class="wk-proj-stat">
        <span class="wk-proj-sv" style="color:${defCol}">${projLogged?Math.abs(Math.round(effDef)).toLocaleString():'—'}</span>
        <span class="wk-proj-sl">kcal ${defWord}</span>
      </div>
      <div class="wk-proj-div"></div>
      <div class="wk-proj-stat">
        <span class="wk-proj-sv" style="color:${defCol}">${projLogged?Math.abs(avgDef).toLocaleString():'—'}</span>
        <span class="wk-proj-sl">avg deficit/day</span>
      </div>
      ${woBurned>0?`<div class="wk-proj-div"></div><div class="wk-proj-stat"><span class="wk-proj-sv" style="color:var(--cyan)">${woBurned.toLocaleString()}</span><span class="wk-proj-sl">workout kcal</span></div>`:''}
    </div>
  </div>`;

  // ── 5. Trend charts (Stats tab) ──
  statsHtml+=`
  <div class="sec-lbl" style="padding-left:0;padding-top:8px">Trends</div>
  <div class="chart-card"><div class="chart-title">Weight (kg)</div><div class="chart-area" id="chart-w"></div></div>
  <div class="chart-card"><div class="chart-title">Body Fat %</div><div class="chart-area" id="chart-bf"></div></div>`;

  // ── 6. Per-day breakdown ──
  html+=`<div class="sec-lbl" style="padding-left:0;padding-top:8px">Daily Breakdown</div>`;
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

  // ── 7. History (Stats tab) ──
  if(entries.length){
    statsHtml+=`<div class="sec-lbl" style="padding-left:0;padding-top:8px">History</div><div class="entries-list">`;
    [...entries].reverse().forEach((e,ri)=>{
      const i=entries.length-1-ri;
      const ds=new Date(e.date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'});
      statsHtml+=`<div class="ei"><div><div class="ei-date">${ds}</div>${e.notes?`<div class="ei-note">${e.notes}</div>`:''}</div>
        <div class="ei-vals">${e.weight!=null?`<div class="ei-v"><div class="ei-vn" style="color:var(--blue2)">${e.weight}</div><div class="ei-vl">kg</div></div>`:''}
        ${e.bf!=null?`<div class="ei-v"><div class="ei-vn" style="color:var(--cyan)">${e.bf}%</div><div class="ei-vl">BF</div></div>`:''}
        <button class="ei-del" onclick="deleteEntry(${i})">✕</button></div></div>`;
    });
    statsHtml+=`</div>`;
  }

  statsHtml+=`<button onclick="openEntryModal()" style="width:100%;margin-top:10px;background:rgba(56,139,253,0.08);border:1.5px dashed rgba(56,139,253,0.3);border-radius:12px;padding:13px;font-family:var(--font);font-size:15px;font-weight:700;color:var(--blue2);cursor:pointer;letter-spacing:.05em">+ Log Entry</button>`;

  el.innerHTML=html;
  // Restore cached AI response (use textContent to avoid XSS)
  const _waiEl=gv('wk-ai-response');
  if(_waiEl&&_waiCache)_waiEl.textContent=_waiCache;

  const statsEl=gv('progress-stats-content');
  if(statsEl)statsEl.innerHTML=statsHtml;

  // Render charts after DOM is set
  renderChart('chart-w',wEs.slice(-8),'weight','kg','#388bfd',84,92);
  renderChart('chart-bf',bEs.slice(-8),'bf','%','#2dd4c8',18,28);
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
    const data=await callAI({model:'claude-sonnet-4-6',max_tokens:600,
      system:'Return ONLY valid JSON, no markdown: {"suggestions":[{"name":"food name","emoji":"emoji","reason":"one line why this fits","calories":number,"protein":number,"carbs":number,"fat":number}]} — 3 suggestions, practical foods available in Dubai, prioritize whatever macro is most behind.',
      messages:[{role:'user',content:ctx}]});
    const raw=aiText(data).replace(/```json|```/g,'').trim();
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
    el.innerHTML=`<div style="color:var(--muted);font-size:12px;padding:8px 0">${_apiErrMsg(e)}</div>`;
  }finally{
    btn.disabled=false;btn.textContent='↻ Refresh';
  }
}

// Hook renderAll to also call new renderers
const _origRenderAll=renderAll;
window.renderAll=function(){
  _origRenderAll();
  renderNutrients();
  renderStreakMini();
};
// Call it once now to init
renderNutrients();
renderProgressPage();
renderStreakMini();

// ══════════════════════════════════════════════════════════════════════════
// FEATURE: STREAK MINI-CARD (today page)
// ══════════════════════════════════════════════════════════════════════════
function renderStreakMini(){
  const el=gv('smc-num');
  if(!el)return;
  el.textContent=calcStreak();
}

// ══════════════════════════════════════════════════════════════════════════
// FEATURE: STREAK MODAL
// ══════════════════════════════════════════════════════════════════════════
let _sfRaf=null;

function openStreakModal(){
  const modal=gv('streak-modal');
  if(!modal)return;
  const streak=calcStreak();
  const tgt=getCalTarget();

  // ── Hero count-up ──
  const numEl=gv('sm-num');
  if(numEl){
    const dur=700,start=performance.now();
    (function tick(now){
      const p=Math.min((now-start)/dur,1);
      numEl.textContent=Math.round((1-Math.pow(1-p,3))*streak);
      if(p<1)requestAnimationFrame(tick);
    })(performance.now());
  }

  // ── Motivational headline ──
  const headlines=[
    [30,'Unstoppable 🚀'],
    [14,'On fire 🔥'],
    [7,'You\'re building something 💪'],
    [0,'Just getting started 🌱'],
  ];
  const headline=(headlines.find(([d])=>streak>=d)||headlines[headlines.length-1])[1];
  const hEl=gv('sm-headline');if(hEl)hEl.textContent=headline;

  // ── Gather 30 days of data ──
  const days30=[];
  for(let i=29;i>=0;i--){
    const d=new Date();d.setDate(d.getDate()-i);
    const k=d.toISOString().slice(0,10);
    const ms=load(`${KEY}_meals_${k}`)||[];
    const totCal=ms.reduce((a,m)=>a+m.calories,0);
    const totP  =ms.reduce((a,m)=>a+m.protein,0);
    const isFuture=d>new Date()&&k!==todayKey();
    const hasData=ms.length>0&&!isFuture;
    const onTarget=hasData&&totCal>=tgt*0.85&&totCal<=tgt*1.10;
    days30.push({k,d,ms,totCal,totP,hasData,onTarget,isFuture});
  }

  // ── Consistency grade ──
  const loggedDays=days30.filter(d=>d.hasData).length;
  const onTargetDays=days30.filter(d=>d.onTarget).length;
  const onTargetPct=loggedDays>0?Math.round(onTargetDays/Math.max(loggedDays,1)*100):0;
  const grade=onTargetPct>=90?'A+':onTargetPct>=75?'A':onTargetPct>=55?'B':'C';
  const gradeEl=gv('sm-grade');
  if(gradeEl){
    gradeEl.textContent=grade;
    gradeEl.className='sm-grade-val '+(grade==='A+'?'grade-aplus':grade==='A'?'grade-a':grade==='B'?'grade-b':'grade-c');
  }

  // ── KPI stats ──
  const proteinDays=days30.filter(d=>d.hasData&&d.totP>0);
  const avgProtein=proteinDays.length?Math.round(proteinDays.reduce((a,d)=>a+d.totP,0)/proteinDays.length):0;
  const p1=gv('sm-avg-protein');if(p1)p1.textContent=avgProtein?avgProtein+'g':'—';
  const p2=gv('sm-on-target');if(p2)p2.textContent=loggedDays?onTargetPct+'%':'—';
  const p3=gv('sm-current');if(p3)p3.textContent=streak+'d';

  // All-time best streak
  let maxStreak=0,cur=0;
  for(let i=0;i<365;i++){
    const d=new Date();d.setDate(d.getDate()-i);
    const ms=load(`${KEY}_meals_${d.toISOString().slice(0,10)}`)||[];
    if(ms.length>0){cur++;if(cur>maxStreak)maxStreak=cur;}else cur=0;
  }
  maxStreak=Math.max(maxStreak,streak);
  const p4=gv('sm-best');if(p4)p4.textContent=maxStreak+'d';

  // ── Best day highlight ──
  const bestDay=days30.filter(d=>d.hasData&&d.totP>0).reduce((best,d)=>(!best||d.totP>best.totP)?d:best,null);
  const hlEl=gv('sm-highlight');
  if(hlEl&&bestDay){
    const dtStr=bestDay.d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
    const htEl=gv('sm-highlight-title');if(htEl)htEl.textContent=`Best day: ${dtStr}`;
    const hsEl=gv('sm-highlight-sub');
    if(hsEl)hsEl.textContent=`${Math.round(bestDay.totP)}g protein · ${Math.round(bestDay.totCal)} kcal`;
    hlEl.style.display='flex';
  } else if(hlEl) hlEl.style.display='none';

  // ── 30-day heatmap ──
  const hmEl=gv('sm-heatmap');
  if(hmEl){
    // Find what weekday the earliest day fell on (Mon=0)
    const firstDow=(days30[0].d.getDay()+6)%7; // convert Sun=0 to Mon=0
    let html='';
    // Pad empty cells before first day
    for(let i=0;i<firstDow;i++) html+=`<div class="sm-hm-cell empty"></div>`;
    days30.forEach((day,idx)=>{
      let cls='sm-hm-cell';
      if(day.isFuture||(!day.hasData&&!day.onTarget)) cls+=' hm-grey';
      else if(day.onTarget) cls+=' hm-green';
      else cls+=' hm-amber';
      if(day.k===todayKey()) cls+=' hm-today';
      const title=`${day.k}: ${Math.round(day.totCal)} kcal`;
      html+=`<div class="${cls}" title="${title}"></div>`;
    });
    hmEl.innerHTML=html;
    // Animate dots in with staggered delay
    const cells=hmEl.querySelectorAll('.sm-hm-cell:not(.empty)');
    cells.forEach((c,i)=>{c.style.transitionDelay=`${i*18}ms`;c.classList.add('hm-reveal');});
  }

  // ── Milestone bar ──
  const milestones=[7,14,30,60,90,180,365];
  const nextM=milestones.find(m=>m>streak)||365;
  const prevM=[...milestones].reverse().find(m=>m<=streak)||0;
  const pct=nextM>prevM?Math.min(((streak-prevM)/(nextM-prevM))*100,100):100;
  const mbar=gv('sm-mbar'),mglow=gv('sm-mbar-glow');
  if(mbar)setTimeout(()=>{mbar.style.width=pct+'%';if(mglow)mglow.style.width=pct+'%';},100);
  const mlEl=gv('sm-mlabel');
  if(mlEl)mlEl.textContent=streak>=nextM?`🏆 ${nextM}-day milestone!`:`${streak} / ${nextM} days`;

  // ── Callout ──
  const msgs=[
    [90,'The 90-Day Club 🌟','Elite tier. Only a fraction of people ever reach this milestone. Your data is now a powerful body map.'],
    [60,'Two Months Straight ⚡','60 days of consistency. You\'ve built something most people only dream about.'],
    [30,'30-Day Warrior 🏆','One full month. Your metabolic data is now deeply accurate and your habits are locked in.'],
    [14,'Two Weeks — Locked In 🚀','14 days straight. This is no longer a challenge — it\'s who you are.'],
    [7,'One Week Strong 🔥','A full week! Your consistency is already beating most people who ever try.'],
    [3,'3 Days — Habit Forming 🌱','Research shows this is when habits start to stick. Keep the momentum.'],
    [0,'Day One Energy 💪','Every legend starts at day 1. Log your meals today and build the habit.'],
  ];
  const msg=msgs.find(([d])=>streak>=d)||msgs[msgs.length-1];
  const ctEl=gv('sm-callout-title'),cbEl=gv('sm-callout-body');
  if(ctEl)ctEl.textContent=msg[1];
  if(cbEl)cbEl.textContent=msg[2];

  _startStreakFlame(streak);
  modal.classList.add('active');
}

function closeStreakModal(){
  const modal=gv('streak-modal');
  if(modal)modal.classList.remove('active');
  if(_sfRaf){cancelAnimationFrame(_sfRaf);_sfRaf=null;}
}

function _newFlameParticle(W,H){
  return{x:W/2+(Math.random()-0.5)*W*0.5,y:H*0.85+Math.random()*H*0.1,vx:(Math.random()-0.5)*1.2,vy:-(1.5+Math.random()*2.5),life:1,decay:0.012+Math.random()*0.018,r:3+Math.random()*6,phase:Math.random()*Math.PI*2};
}

function _startStreakFlame(streak){
  const canvas=gv('streak-flame-canvas');if(!canvas)return;
  const dpr=window.devicePixelRatio||1;
  const W=260,H=200;
  canvas.width=W*dpr;canvas.height=H*dpr;
  canvas.style.width=W+'px';canvas.style.height=H+'px';
  const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
  const t=Math.min(streak/90,1);
  const r1=Math.round(255*(1-t)+181*t),g1=Math.round(120*(1-t)+40*t),b1=Math.round(0*(1-t)+255*t);
  const r2=Math.round(255*(1-t)+90*t),g2=Math.round(60*(1-t)+0*t),b2=Math.round(0*(1-t)+200*t);
  let particles=Array.from({length:60},()=>_newFlameParticle(W,H));
  function frame(){
    ctx.clearRect(0,0,W,H);
    if(particles.length<80)particles.push(_newFlameParticle(W,H));
    particles.forEach(p=>{
      p.x+=p.vx+Math.sin(p.phase+Date.now()*0.002)*0.4;
      p.y+=p.vy;p.life-=p.decay;p.phase+=0.05;
      if(p.life<=0)return;
      const cr=Math.round(r1+(r2-r1)*(1-p.life)),cg=Math.round(g1+(g2-g1)*(1-p.life)),cb=Math.round(b1+(b2-b1)*(1-p.life));
      ctx.beginPath();ctx.arc(p.x,p.y,p.r*p.life,0,Math.PI*2);
      ctx.fillStyle=`rgba(${cr},${cg},${cb},${p.life*0.85})`;ctx.fill();
    });
    particles=particles.filter(p=>p.life>0);
    _sfRaf=requestAnimationFrame(frame);
  }
  if(_sfRaf)cancelAnimationFrame(_sfRaf);
  frame();
}

// ══════════════════════════════════════════════════════════════════════════
// FEATURE: STYKU STATS BAR AUTO-SCROLL (ping-pong)
// ══════════════════════════════════════════════════════════════════════════
let _sbRaf=null,_sbDir=1,_sbPause=0;

function _sbFrame(){
  const row=document.querySelector('.sb-row');
  if(!row){_sbRaf=null;return;}
  const maxScroll=row.scrollWidth-row.clientWidth;
  if(maxScroll<=0){_sbRaf=requestAnimationFrame(_sbFrame);return;}
  if(_sbPause>0){_sbPause--;_sbRaf=requestAnimationFrame(_sbFrame);return;}
  row.scrollLeft+=_sbDir*0.6;
  if(row.scrollLeft>=maxScroll-1){row.scrollLeft=maxScroll;_sbDir=-1;_sbPause=120;}
  else if(row.scrollLeft<=1){row.scrollLeft=0;_sbDir=1;_sbPause=120;}
  _sbRaf=requestAnimationFrame(_sbFrame);
}

function initStykuScroll(){
  const row=document.querySelector('.sb-row');if(!row)return;
  row.addEventListener('touchstart',()=>{if(_sbRaf){cancelAnimationFrame(_sbRaf);_sbRaf=null;}},{passive:true});
  row.addEventListener('touchend',()=>{setTimeout(()=>{_sbPause=60;_sbRaf=requestAnimationFrame(_sbFrame);},600);},{passive:true});
  setTimeout(()=>{_sbRaf=requestAnimationFrame(_sbFrame);},2000);
}

// ══════════════════════════════════════════════════════════════════════════
// FEATURE: FAB (floating action button)
// ══════════════════════════════════════════════════════════════════════════
let _fabOpen=false;
let _fabRecentOpen=false;

function _fabSync(){
  const main=gv('fab-main'), subs=gv('fab-sub-btns');
  const dim=gv('fab-dim'),   rp=gv('fab-recent-panel');
  main?.classList.toggle('open',_fabOpen);
  subs?.classList.toggle('open',_fabOpen);
  dim?.classList.toggle('show',_fabOpen);
  rp?.classList.toggle('open',_fabRecentOpen);
}
function fabToggle(){
  _fabOpen=!_fabOpen;
  if(!_fabOpen) _fabRecentOpen=false;
  _fabSync();
}
function fabClose(){
  _fabOpen=false; _fabRecentOpen=false; _fabSync();
}
function fabPillRecent(){
  // Toggle the recent panel; keeps FAB menu open behind it
  _fabRecentOpen=!_fabRecentOpen;
  _fabSync();
  if(_fabRecentOpen) _fabRenderRecent();
}
function fabRecentClose(){
  _fabRecentOpen=false; _fabSync();
}
function _fabRenderRecent(){
  const el=gv('fab-recent-list'); if(!el) return;
  const todayK=todayKey();
  const d=new Date(); d.setDate(d.getDate()-1);
  const yesterK=d.toISOString().slice(0,10);
  const todayMs  =load(`${KEY}_meals_${todayK}`,[]);
  const yesterMs =load(`${KEY}_meals_${yesterK}`,[]);
  // Most-recent first, dedupe by name, cap at 5
  const seen=new Set(), recent=[];
  for(const m of [...todayMs].reverse().concat([...yesterMs].reverse())){
    if(!seen.has(m.name) && recent.length<5){ seen.add(m.name); recent.push(m); }
  }
  if(!recent.length){
    el.innerHTML='<div class="fab-rp-empty">No meals logged yet.</div>'; return;
  }
  el.innerHTML='';
  recent.forEach(m=>{
    const row=document.createElement('div');
    row.className='fab-rp-row';
    row.innerHTML=`
      <span class="fab-rp-emoji">${m.emoji||'🍽️'}</span>
      <div class="fab-rp-info">
        <div class="fab-rp-name">${m.name}</div>
        <div class="fab-rp-meta">${Math.round(m.calories)} kcal · ${Math.round(m.protein)}g P</div>
      </div>
      <button class="fab-rp-add" title="Re-log">+</button>`;
    row.querySelector('.fab-rp-add').addEventListener('click',e=>{
      e.stopPropagation();
      const entry={...m, loggedAt:Date.now(), thumb:null};
      meals.push(entry);
      save(`${KEY}_meals_${todayK}`,meals);
      renderAll();
      fabClose();
    });
    el.appendChild(row);
  });
}
// Dismiss FAB when tapping outside the wrap (dim overlay handles its own click)
document.addEventListener('click',e=>{
  if(_fabOpen && !gv('fab-wrap')?.contains(e.target) && e.target!==gv('fab-dim')) fabClose();
});

function _updateFab(page){
  const wrap=gv('fab-wrap');
  const icon=gv('fab-icon');
  const mainBtn=gv('fab-main');
  if(!wrap||!icon||!mainBtn) return;
  fabClose();
  if(page==='today'||page==='workout'){
    wrap.style.display='';
    wrap.classList.toggle('fab-wo-mode',page==='workout');
    mainBtn.onclick=fabToggle;
    icon.innerHTML='<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>';
  } else {
    wrap.style.display='none';
  }
}

initStykuScroll();

// ══════════════════════════════════════════════════════════════════════════
// WORKOUT TRACKER
// ══════════════════════════════════════════════════════════════════════════

// ── Storage keys ──
// (WO_KEY, WO_HIST_KEY, WO_PBS_KEY, WO_NOTES_KEY are declared above BOOT to prevent TDZ issues during renderAll.)

// ── State ──
let _woRecovery  = null;           // WHOOP recovery % entered this session
let _woPlan      = null;           // AI-generated plan object
let _woSession   = null;           // active workout session
let _woTimerInt  = null;           // elapsed timer interval
let _woRestInt   = null;           // rest timer interval
let _woHistMode  = false;          // viewing history?
let _woHistPage  = 'list';         // 'list' | 'detail' | 'exercise'
let _woHistDetail= null;           // selected session for detail view
let _woHistExName= null;           // selected exercise for progression
let _woSplitOverride = null;       // one-shot manual split override (else auto rotation)

// ── Utilities ──
function woLoad(key,def){try{const v=localStorage.getItem(key);return v?JSON.parse(v):def;}catch{return def;}}

// History / PBs / notes are read many times per render (every exercise card asks for
// its ghost sets, PB and note). Parsing a year of history that often was the main
// cost of tapping a set. This cache re-parses only when the stored string changes,
// so it stays correct after cloud pulls and writes from any other code path.
// NOTE: callers must treat the returned value as read-only (copy before mutating).
const _woCache=new Map();
function woLoadCached(key,def){
  let raw;
  try{raw=localStorage.getItem(key);}catch{return def;}
  if(!raw)return def;
  const hit=_woCache.get(key);
  if(hit&&hit.raw===raw)return hit.val;
  try{const val=JSON.parse(raw);_woCache.set(key,{raw,val});return val;}catch{return def;}
}

// The live session is saved on every keystroke. localStorage is written immediately
// (crash-safe), but the cloud upsert is coalesced — one request per burst of typing
// instead of one per digit. The local timestamp is stamped immediately so a cloud
// pull can never clobber a newer local write while the push is pending.
const _woPushTimers={};
function _woFlushPush(key){
  if(!_woPushTimers[key])return;
  clearTimeout(_woPushTimers[key].t);
  const val=_woPushTimers[key].val;delete _woPushTimers[key];
  if(typeof cloudPush==='function')cloudPush(key,val);
}
function woSave(key,val){
  localStorage.setItem(key,JSON.stringify(val));
  if(typeof cloudPush!=='function')return;
  if(key!==WO_KEY){cloudPush(key,val);return;}          // rare writes: push straight away
  if(typeof _stampLocal==='function')_stampLocal(key,new Date().toISOString());
  const prev=_woPushTimers[key];if(prev)clearTimeout(prev.t);
  _woPushTimers[key]={val,t:setTimeout(()=>_woFlushPush(key),1500)};
}
// Never lose the trailing edit when the app is backgrounded or closed.
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')Object.keys(_woPushTimers).forEach(_woFlushPush);});
window.addEventListener('pagehide',()=>{Object.keys(_woPushTimers).forEach(_woFlushPush);});

function woHistory(){return woLoadCached(WO_HIST_KEY,[]);}
function woPBs(){return woLoadCached(WO_PBS_KEY,{});}
function woNotes(){return woLoadCached(WO_NOTES_KEY,{});}
function woPrefs(){return woLoad(WO_PREFS_KEY,{variety:'balanced'});}
function woSetPref(k,v){const p=Object.assign({},woPrefs());p[k]=v;woSave(WO_PREFS_KEY,p);}
function epley(w,r){return r===1?w:Math.round(w*(1+r/30));}  // Epley 1RM formula

// ── Exercise Notes ──
function getExerciseNote(exerciseName) {
  const notes = woNotes();
  const key = exerciseName.toLowerCase().trim();
  return notes[key] || '';
}

function saveExerciseNote(exerciseName, note) {
  const notes = Object.assign({}, woNotes());   // copy — the cached object is shared
  const key = exerciseName.toLowerCase().trim();
  if (note && note.trim()) {
    notes[key] = note.trim();
  } else {
    delete notes[key];
  }
  woSave(WO_NOTES_KEY, notes);
}

function openNoteModal(ei) {
  const ex = _woSession?.exercises[ei];
  if (!ex) return;
  const exName = ex.swappedTo || ex.name;
  const currentNote = getExerciseNote(exName);
  
  const modal = document.createElement('div');
  modal.className = 'wo-note-modal-overlay';
  modal.id = 'wo-note-modal';
  modal.innerHTML = `
    <div class="wo-note-modal">
      <div class="wo-note-modal-hdr">
        <span>Note for ${exName}</span>
        <button class="wo-note-modal-close" onclick="closeNoteModal()">✕</button>
      </div>
      <textarea id="wo-note-textarea" class="wo-note-textarea" placeholder="Add a personal note for next time...">${currentNote}</textarea>
      <div class="wo-note-modal-btns">
        <button class="wo-note-btn-cancel" onclick="closeNoteModal()">Cancel</button>
        <button class="wo-note-btn-save" onclick="saveNoteFromModal(${ei})">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  setTimeout(() => modal.classList.add('visible'), 10);
  gv('wo-note-textarea').focus();
}

function closeNoteModal() {
  const modal = gv('wo-note-modal');
  if (modal) {
    modal.classList.remove('visible');
    setTimeout(() => modal.remove(), 200);
  }
}

function saveNoteFromModal(ei) {
  const ex = _woSession?.exercises[ei];
  if (!ex) return;
  const exName = ex.swappedTo || ex.name;
  const note = gv('wo-note-textarea')?.value || '';
  saveExerciseNote(exName, note);
  closeNoteModal();
  renderExercises();
}

// ── Exercise icon system: generated muscle maps ──
// One uniform style for every exercise: a front/back figure with the primary
// muscle in the brand colour and secondary muscles dimmed. Driven by the
// engine's exercise metadata, so all 200+ movements are covered automatically.
const MM_BODY='<ellipse cx="50" cy="15" rx="9" ry="11"/><path d="M45 24h10v9H45z"/>'+
  '<path d="M31 37Q50 31 69 37Q72 52 68 70Q65 88 64 104H36Q35 88 32 70Q28 52 31 37Z"/>'+
  '<ellipse cx="28" cy="43" rx="8" ry="8.5"/><ellipse cx="72" cy="43" rx="8" ry="8.5"/>'+
  '<rect x="17" y="46" width="10" height="36" rx="5"/><rect x="73" y="46" width="10" height="36" rx="5"/>'+
  '<rect x="15.5" y="81" width="9" height="32" rx="4.5"/><rect x="75.5" y="81" width="9" height="32" rx="4.5"/>'+
  '<ellipse cx="20" cy="118" rx="4.5" ry="5.5"/><ellipse cx="80" cy="118" rx="4.5" ry="5.5"/>'+
  '<path d="M36 101H64L66.5 121H33.5Z"/>'+
  '<rect x="33.5" y="113" width="15.5" height="50" rx="7.5"/><rect x="51" y="113" width="15.5" height="50" rx="7.5"/>'+
  '<rect x="35.5" y="161" width="11.5" height="33" rx="5.5"/><rect x="53" y="161" width="11.5" height="33" rx="5.5"/>'+
  '<ellipse cx="41" cy="196" rx="6" ry="3"/><ellipse cx="59" cy="196" rx="6" ry="3"/>';
const MM_FRONT={
  chest:'<path d="M34 44Q42 40 49 43V58Q41 62 34 56Z"/><path d="M66 44Q58 40 51 43V58Q59 62 66 56Z"/>',
  delts:'<ellipse cx="28" cy="43.5" rx="6.3" ry="7"/><ellipse cx="72" cy="43.5" rx="6.3" ry="7"/>',
  biceps:'<ellipse cx="22" cy="63" rx="3.6" ry="11"/><ellipse cx="78" cy="63" rx="3.6" ry="11"/>',
  obliques:'<path d="M35 62L41 63.5V96Q37.5 91 36 83Q34.5 73 35 62Z"/><path d="M65 62L59 63.5V96Q62.5 91 64 83Q65.5 73 65 62Z"/>',
  abs:'<path d="M42.5 63h15v31q-7.5 6-15 0z"/>',
  quads:'<ellipse cx="41.3" cy="136" rx="6" ry="19"/><ellipse cx="58.7" cy="136" rx="6" ry="19"/>',
  shins:'<ellipse cx="41.2" cy="174" rx="3.6" ry="11"/><ellipse cx="58.8" cy="174" rx="3.6" ry="11"/>',
};
const MM_BACK={
  traps:'<path d="M41 36L50 30.5L59 36L55.5 53H44.5Z"/>',
  reardelts:'<ellipse cx="28" cy="44" rx="6" ry="6.3"/><ellipse cx="72" cy="44" rx="6" ry="6.3"/>',
  lats:'<path d="M34 50Q42 53 48.5 57V86Q40 80 35 69Z"/><path d="M66 50Q58 53 51.5 57V86Q60 80 65 69Z"/>',
  triceps:'<ellipse cx="22" cy="62" rx="3.6" ry="11"/><ellipse cx="78" cy="62" rx="3.6" ry="11"/>',
  lowback:'<path d="M45 88h10v12h-10z"/>',
  glutes:'<ellipse cx="43" cy="112" rx="7.2" ry="7.6"/><ellipse cx="57" cy="112" rx="7.2" ry="7.6"/>',
  hams:'<ellipse cx="41.3" cy="141" rx="5.6" ry="16"/><ellipse cx="58.7" cy="141" rx="5.6" ry="16"/>',
  calves:'<ellipse cx="41.2" cy="172" rx="4.6" ry="10.5"/><ellipse cx="58.8" cy="172" rx="4.6" ry="10.5"/>',
};
const MM_BACK_REGIONS=new Set(Object.keys(MM_BACK));
// Muscle (engine vocabulary) → drawn regions; Back depends on the movement.
function mmRegionsOf(muscle,pat){
  switch(muscle){
    case 'Chest':return['chest'];
    case 'Shoulders':return['delts'];
    case 'Rear Delts':return['reardelts'];
    case 'Back':return pat==='tr'?['traps']:pat==='hr'?['lats','traps']:['lats'];
    case 'Biceps':return['biceps'];
    case 'Triceps':return['triceps'];
    case 'Quads':return['quads'];
    case 'Hamstrings':return['hams'];
    case 'Glutes':return['glutes'];
    case 'Calves':return['calves'];
    case 'Core':return pat==='cl'||pat==='cr'?['obliques']:['abs'];
  }
  return[];
}
function mmHighlight(names){
  const p=new Set(),sec=new Set();
  (names||[]).forEach(n=>{
    const m=WoEngine.musclesOf(n);if(!m)return;
    mmRegionsOf(m.primary,m.pat).forEach(r=>p.add(r));
    if(m.pat==='hg'){p.add('hams');p.add('glutes');sec.add('lowback');}
    if(m.pat==='cl'||m.pat==='cr')sec.add('abs');     // oblique work braces the abs too
    if(m.pat==='cx')sec.add('obliques');               // anti-extension holds load the sides
    m.secondary.forEach(x=>mmRegionsOf(x,m.pat).forEach(r=>{if(!p.has(r))sec.add(r);}));
  });
  return {p,s:sec};
}
function mmSvg(view,hi,crop,cls){
  const R=view==='front'?MM_FRONT:MM_BACK;
  const parts=Object.keys(R).map(k=>`<g class="${hi.p.has(k)?'mm-p':hi.s.has(k)?'mm-s':'mm-m'}">${R[k]}</g>`).join('');
  return `<svg viewBox="${crop||'0 0 100 200'}" preserveAspectRatio="xMidYMid meet" class="mm${cls?' '+cls:''}" aria-hidden="true"><g class="mm-b">${MM_BODY}</g>${parts}</svg>`;
}
// Thumbnail: the view and crop that best show the primary muscle.
function mmThumb(names){
  const hi=mmHighlight(names);
  const first=[...hi.p][0];
  if(!first)return null;
  const view=MM_BACK_REGIONS.has(first)?'back':'front';
  const crop=['quads','glutes','hams'].includes(first)?'14 96 72 72':first==='calves'?'14 134 72 66':(first==='abs'||first==='obliques')?'14 36 72 72':'10 26 80 80';
  return mmSvg(view,hi,crop);
}
// Hero: front and back side by side.
function mmHero(names,extraP){
  const hi=mmHighlight(names);
  (extraP||[]).forEach(m=>mmRegionsOf(m).forEach(r=>hi.p.add(r)));
  return `<div class="mm-hero">${mmSvg('front',hi)}${mmSvg('back',hi)}</div>`;
}
const WO_EQUIP_LABEL={bb:'Barbell',db:'Dumbbells',cable:'Cable',mach:'Machine',bw:'Bodyweight',smith:'Smith machine'};
function woEquipOf(name){const m=WoEngine.musclesOf(name);return m?(WO_EQUIP_LABEL[m.equip]||''):'';}

// Kept for older call sites/data: slugs no longer drive anything.
function getExIconSlug(){ return null; }
// Icon for any exercise or cardio machine (HTML string).
function getExIcon(name){
  const svg=mmThumb([name]);
  if(svg)return `<span class="wo-mm-thumb">${svg}</span>`;
  const n=String(name||'').toLowerCase();
  const cardio=/tread|bike|cycle|row(er|ing machine)|erg|stair|elliptical|walk|run|sprint|jump rope|ski/.test(n);
  return `<span class="wo-ex-glyph">${woIco(cardio?'heart':'dumbbell')}</span>`;
}

// ── Yesterday's nutrition helper ──
function getYesterdayNutrition(){
  const y=new Date();y.setDate(y.getDate()-1);
  const key=y.toISOString().slice(0,10);
  const yMeals=woLoad(`${KEY}_meals_${key}`,[]);
  return getTotals(yMeals);
}

// ── Last N sessions helper ──
function getRecentSessions(n=7){
  return woHistory().slice(-n).reverse();
}

// ── Fixed split rotation ──
// Push → Pull → Arms & Shoulders → Legs. The sequence, muscle map and classification
// (including legacy sessions) live in workout-engine.js so the generator and the UI
// can never disagree about what's next.
// (Guarded: if a stale cached index.html ever loads this file without workout-engine.js, only the
// workout tab degrades — the rest of the app must keep working. See renderWorkoutPage.)
const _WO_ENGINE_OK = typeof WoEngine !== 'undefined';
const WO_SPLIT_CYCLE = _WO_ENGINE_OK ? WoEngine.SPLIT_CYCLE : ['Push', 'Pull', 'Arms & Shoulders', 'Legs'];
const WO_SPLIT_MUSCLES = _WO_ENGINE_OK ? WoEngine.SPLIT_MUSCLES : {};
function classifySplit(session){ return _WO_ENGINE_OK ? WoEngine.classifySplit(session) : null; }
function getNextSplit(){ return _WO_ENGINE_OK ? WoEngine.nextSplit(woHistory()) : WO_SPLIT_CYCLE[0]; }

// ── Ghost Sets: Get last performed sets for an exercise ──
// Memoised per (history identity, name): the history array is only replaced when
// the stored string changes, so a WeakMap keyed on it invalidates automatically.
const _woGhostMemo=new WeakMap();
function getExerciseGhostSets(exerciseName) {
  const hist = woHistory();
  let memo = _woGhostMemo.get(hist);
  if (!memo) { memo = new Map(); _woGhostMemo.set(hist, memo); }
  const normalizedName = WoEngine.canon(exerciseName);
  if (memo.has(normalizedName)) return memo.get(normalizedName);

  let found = null;
  for (let i = hist.length - 1; i >= 0 && !found; i--) {
    const session = hist[i];
    if (!session.exercises) continue;
    const exercise = session.exercises.find(ex => WoEngine.canon(ex.swappedTo || ex.name) === normalizedName);
    if (exercise && exercise.sets && exercise.sets.length > 0) {
      // Only sets that were actually completed with data (blank weight counts as 0 for bodyweight/timed work)
      const completedSets = exercise.sets.filter(s => s.done && s.reps && (s.weight || s.weight === 0 || s.weight === '0' || s.weight === ''));
      if (completedSets.length > 0) {
        found = {
          date: session.date,
          sets: completedSets.map(s => ({
            weight: parseFloat(s.weight) || 0,
            reps: parseInt(s.reps),
            rpe: s.rpe || null
          }))
        };
      }
    }
  }
  memo.set(normalizedName, found);
  return found;
}

// ── Render workout page (readiness) ──
// ── v12 icon set (Lucide-style strokes) — replaces emoji across the workout UI ──
const WO_ICONS={
  shuffle:'<path d="m18 14 4 4-4 4"/><path d="m18 2 4 4-4 4"/><path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22"/><path d="M2 6h1.972a4 4 0 0 1 3.6 2.2"/><path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45"/>',
  play:'<circle cx="12" cy="12" r="10"/><path d="m10 8 6 4-6 4z" fill="currentColor"/>',
  check:'<path d="M20 6 9 17l-5-5"/>',
  sparkles:'<path d="M12 3 13.9 8.1 19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 3v4M17 5h4M5 17v4M3 19h4"/>',
  target:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
  bulb:'<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z"/>',
  flame:'<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  zap:'<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  note:'<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  trophy:'<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  layers:'<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  chevron:'<path d="m6 9 6 6 6-6"/>',
  heart:'<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  more:'<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  chart:'<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 6-6"/>',
  plates:'<rect x="2" y="9" width="3" height="6" rx="1"/><rect x="5" y="6" width="3" height="12" rx="1"/><path d="M8 12h8"/><rect x="16" y="6" width="3" height="12" rx="1"/><rect x="19" y="9" width="3" height="6" rx="1"/>',
  grip:'<path d="M5 9h14M5 15h14"/>',
  trash:'<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  reorder:'<path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4"/>',
  bell:'<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  minus:'<path d="M5 12h14"/>',
  gear:'<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  bookmark:'<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  dumbbell:'<path d="M14.4 14.4 9.6 9.6"/><path d="M18.657 21.485a2 2 0 1 1-2.829-2.828l-1.767 1.768a2 2 0 1 1-2.829-2.829l6.364-6.364a2 2 0 1 1 2.829 2.829l-1.768 1.767a2 2 0 1 1 2.828 2.829z"/><path d="m21.5 21.5-1.4-1.4"/><path d="M3.9 3.9 2.5 2.5"/><path d="M6.404 12.768a2 2 0 1 1-2.829-2.829l1.768-1.767a2 2 0 1 1-2.828-2.829l2.828-2.828a2 2 0 1 1 2.829 2.828l1.767-1.768a2 2 0 1 1 2.829 2.829z"/>',
};
function woIco(name,cls){
  return `<svg class="ico${cls?' '+cls:''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${WO_ICONS[name]||''}</svg>`;
}
// Light haptic tick on supporting devices (Android/Chrome). No-op elsewhere.
function woHaptic(p){
  try{ if(navigator.vibrate && !matchMedia('(prefers-reduced-motion: reduce)').matches) navigator.vibrate(p||10); }catch(e){}
}
function woFormUrl(name){ return 'https://www.youtube.com/results?search_query='+encodeURIComponent(name+' proper form'); }

// ══════════════════════════════════════════════════════════════════════════
// v13 bottom sheet — replaces window.confirm / prompt / alert in the workout flow
// ══════════════════════════════════════════════════════════════════════════
function woSheet(o){
  o=o||{};
  const ov=document.createElement('div');
  ov.className='wo-sheet-ov';
  const acts=o.actions||[];
  ov.innerHTML=`<div class="wo-sheet ${o.className||''}" role="dialog" aria-modal="true"${o.title?` aria-label="${escapeAttr(o.title)}"`:''}>
    <div class="wo-sheet-grab" aria-hidden="true"></div>
    ${o.title?`<div class="wo-sheet-title">${escapeHtml(o.title)}</div>`:''}
    ${o.message?`<div class="wo-sheet-msg">${o.message}</div>`:''}
    <div class="wo-sheet-body">${o.body||''}</div>
    ${acts.length?`<div class="wo-sheet-actions">${acts.map((a,i)=>`<button class="wo-sheet-btn ${a.style||''}" data-i="${i}">${a.icon?woIco(a.icon):''}<span>${escapeHtml(a.label)}</span></button>`).join('')}</div>`:''}
  </div>`;
  document.body.appendChild(ov);
  let done=false;
  const close=v=>{
    if(done)return;done=true;
    ov.classList.remove('open');ov.classList.add('closing');
    document.removeEventListener('keydown',onKey);
    setTimeout(()=>ov.remove(),240);
    if(o.onClose)o.onClose(v);
  };
  const onKey=e=>{if(e.key==='Escape')close(null);};
  document.addEventListener('keydown',onKey);
  ov.addEventListener('click',e=>{if(e.target===ov)close(null);});
  ov.querySelectorAll('.wo-sheet-btn[data-i]').forEach(b=>b.addEventListener('click',()=>{
    const a=acts[+b.dataset.i];
    const v=a.value!==undefined?a.value:a.label;
    close(v);
    if(a.onClick)a.onClick(v);
  }));
  requestAnimationFrame(()=>ov.classList.add('open'));
  const sheet=ov.querySelector('.wo-sheet');
  return {el:sheet,body:ov.querySelector('.wo-sheet-body'),close};
}
function woConfirm(title,message,okLabel,destructive){
  return new Promise(res=>woSheet({title,message:escapeHtml(message||''),
    actions:[{label:okLabel||'OK',style:destructive?'destructive':'primary',value:true},{label:'Cancel',style:'cancel',value:false}],
    onClose:v=>res(v===true)}));
}
function woPrompt(title,value,okLabel,placeholder){
  return new Promise(res=>{
    const sh=woSheet({title,
      body:`<input class="wo-sheet-input" type="text" value="${escapeAttr(value||'')}" placeholder="${escapeAttr(placeholder||'')}" maxlength="60" autocomplete="off">`,
      actions:[{label:okLabel||'Save',style:'primary',value:'__ok'},{label:'Cancel',style:'cancel',value:null}],
      onClose:v=>res(v==='__ok'?(inp.value.trim()||null):null)});
    const inp=sh.body.querySelector('input');
    inp.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();sh.el.querySelector('.wo-sheet-btn.primary').click();}});
    setTimeout(()=>{inp.focus();inp.select();},250);
  });
}

// ── Workout UI preferences (device-local; kept apart from engine prefs) ──
const WO_UI_KEY=KEY+'_wo_ui';
const WO_UI_DEFAULTS={autoRest:true,sound:true,alerts:false,awake:true,bar:20};
function woUi(){try{return Object.assign({},WO_UI_DEFAULTS,JSON.parse(localStorage.getItem(WO_UI_KEY)||'{}'));}catch(e){return Object.assign({},WO_UI_DEFAULTS);}}
function woSetUi(k,v){const u=woUi();u[k]=v;localStorage.setItem(WO_UI_KEY,JSON.stringify(u));}

// ── Rest-over alerts while the app is in the background ──
// A tiny service worker (sw.js, no caching) lets us post a system notification.
async function woEnableAlerts(on){
  if(!on){woSetUi('alerts',false);return true;}
  if(!('Notification' in window)||!('serviceWorker' in navigator)){woToast('This browser can’t show alerts');return false;}
  let perm=Notification.permission;
  if(perm==='default'){try{perm=await Notification.requestPermission();}catch(e){}}
  if(perm!=='granted'){woToast('Notifications are blocked for this app');return false;}
  try{await navigator.serviceWorker.register('sw.js');}catch(e){woToast('Couldn’t set up alerts');return false;}
  woSetUi('alerts',true);
  return true;
}
async function woNotify(title,body){
  try{
    if(!woUi().alerts||!('serviceWorker' in navigator)||Notification.permission!=='granted')return;
    const reg=await navigator.serviceWorker.getRegistration();
    if(reg)reg.showNotification(title,{body,tag:'rb-rest',renotify:true,vibrate:[200,100,200],icon:'reborn-logo-rb.png',badge:'reborn-logo-rb.png'});
  }catch(e){}
}

// ── Settings sheet ──
function openWoSettings(){
  const u=woUi();
  const sw=(k,label,sub)=>`<label class="wo-row wo-row-switch">
      <span class="wo-row-main"><span class="wo-row-label">${label}</span>${sub?`<span class="wo-row-sub">${sub}</span>`:''}</span>
      <input type="checkbox" class="wo-switch" ${u[k]?'checked':''} onchange="woSettingChange('${k}',this)">
    </label>`;
  woSheet({title:'Workout settings',className:'wo-sheet-tall',body:`
    <div class="wo-list">
      ${sw('autoRest','Start rest timer automatically','After each logged set')}
      ${sw('sound','Rest timer sound')}
      ${sw('alerts','Alert when rest ends','Notification if the app is in the background')}
      ${sw('awake','Keep screen on during workouts')}
    </div>
    <div class="wo-list">
      <div class="wo-row"><span class="wo-row-main"><span class="wo-row-label">Barbell weight</span></span>
        <div class="wo-seg wo-seg-sm" role="group" aria-label="Barbell weight">
          ${[20,15,10].map(b=>`<button class="wo-seg-btn${u.bar===b?' sel':''}" onclick="woSetBar(${b},this)">${b} kg</button>`).join('')}
        </div>
      </div>
    </div>
    <p class="wo-footnote">On iPhone, web apps pause in the background, so a rest alert may only arrive when you switch back. Keeping the screen on avoids this.</p>`,
    actions:[{label:'Done',style:'cancel'}]});
}
async function woSettingChange(k,inp){
  if(k==='alerts'){const ok=await woEnableAlerts(inp.checked);if(!ok)inp.checked=false;return;}
  woSetUi(k,inp.checked);
  if(k==='awake'){if(inp.checked)woWakeOn();else woWakeOff();}
}
function woSetBar(b,btn){
  woSetUi('bar',b);
  btn.parentElement.querySelectorAll('.wo-seg-btn').forEach(x=>x.classList.toggle('sel',x===btn));
}

// ══════════════════════════════════════════════════════════════════════════
// Plate calculator
// ══════════════════════════════════════════════════════════════════════════
const WO_PLATES=[25,20,15,10,5,2.5,1.25];
// Calibrated-plate colours (IWF), height % of the visual, thickness px.
const WO_PLATE_STYLE={25:['#D93A2B',96,22],20:['#2F67D8',96,20],15:['#E8B923',84,18],10:['#2E9D57',72,16],5:['#E9E9EC',54,12],2.5:['#8E8E93',42,10],1.25:['#C7C7CC',34,8]};
function woIsBarbell(name){
  const lib=WoEngine.byName(name);
  if(lib)return lib.equip==='bb'||lib.equip==='smith';
  return /barbell|smith|ez[- ]?bar|trap bar|landmine|t-bar/i.test(name||'');
}
function woPlatesFor(total,bar){
  let per=Math.round(((total-bar)/2)*1000)/1000;
  const plates=[];
  if(per<0)return {plates,left:per};
  for(const p of WO_PLATES){while(per>=p-1e-9){plates.push(p);per=Math.round((per-p)*1000)/1000;}}
  return {plates,left:per};
}
let _pc=null;
function openPlateCalc(ei){
  const ex=_woSession&&_woSession.exercises[ei];if(!ex)return;
  let si=ex.sets.findIndex(s=>!s.done);if(si<0)si=ex.sets.length-1;
  const h=woSetHint(ex,si);
  const bar=woUi().bar;
  const w=parseFloat(ex.sets[si].weight)||parseFloat(h.w)||bar+40;
  _pc={ei,si,w,bar};
  const sh=woSheet({title:'Plate calculator',className:'wo-sheet-tall',body:'<div id="wo-pc"></div>',
    actions:[{label:`Use for set ${si+1}`,style:'primary',value:'apply',onClick:woApplyPlates},{label:'Close',style:'cancel'}]});
  _pc.sheet=sh;
  woRenderPlates();
}
function woRenderPlates(){
  const el=gv('wo-pc');if(!el||!_pc)return;
  const {plates,left}=woPlatesFor(_pc.w,_pc.bar);
  const exact=left===0;
  const loaded=_pc.bar+2*plates.reduce((a,b)=>a+b,0);
  const stack=plates.map(p=>{const [c,h,w]=WO_PLATE_STYLE[p];return `<span class="pc-plate" style="--c:${c};--h:${h}%;--w:${w}px" title="${p} kg"></span>`;}).join('');
  const counts={};plates.forEach(p=>counts[p]=(counts[p]||0)+1);
  const legend=Object.keys(counts).map(Number).sort((a,b)=>b-a).map(p=>`<span class="pc-chip"><i style="background:${WO_PLATE_STYLE[p][0]}"></i>${counts[p]} × ${p}</span>`).join('');
  el.innerHTML=`
    <div class="pc-weight">
      <button class="wo-round-btn" onclick="woPlateStep(-2.5)" aria-label="Decrease">${woIco('minus')}</button>
      <div class="pc-total"><span class="tnum">${_pc.w}</span><small>kg</small></div>
      <button class="wo-round-btn" onclick="woPlateStep(2.5)" aria-label="Increase">${woIco('plus')}</button>
    </div>
    <div class="pc-visual" aria-hidden="true">
      <span class="pc-shaft"></span><span class="pc-collar"></span>${stack}<span class="pc-sleeve"></span>
    </div>
    <div class="pc-legend">${plates.length?`<span class="pc-legend-lbl">Each side</span>${legend}`:`<span class="pc-legend-lbl">${_pc.w<=_pc.bar?'Empty bar':'No plates'}</span>`}</div>
    ${!exact&&_pc.w>_pc.bar?`<div class="pc-warn">Closest you can load is <b class="tnum">${loaded} kg</b></div>`:''}
    <div class="wo-row"><span class="wo-row-main"><span class="wo-row-label">Bar</span></span>
      <div class="wo-seg wo-seg-sm">${[20,15,10].map(b=>`<button class="wo-seg-btn${_pc.bar===b?' sel':''}" onclick="woPlateBar(${b})">${b} kg</button>`).join('')}</div>
    </div>`;
}
function woPlateStep(d){if(!_pc)return;_pc.w=Math.max(0,Math.round((_pc.w+d)*100)/100);woHaptic(6);woRenderPlates();}
function woPlateBar(b){if(!_pc)return;_pc.bar=b;woSetUi('bar',b);woRenderPlates();}
function woApplyPlates(){
  if(!_pc||!_woSession)return;
  const ex=_woSession.exercises[_pc.ei];if(!ex||!ex.sets[_pc.si])return;
  ex.sets[_pc.si].weight=String(_pc.w);
  woSave(WO_KEY,_woSession);
  renderExerciseCardAt(_pc.ei);
  _pc=null;
}

// ══════════════════════════════════════════════════════════════════════════
// Per-exercise menu, swap, reorder, remove, swipe-to-delete
// ══════════════════════════════════════════════════════════════════════════
function openExMenu(ei){
  const ex=_woSession&&_woSession.exercises[ei];if(!ex)return;
  const name=ex.swappedTo||ex.name;
  const hasNote=!!getExerciseNote(name);
  const acts=[{label:'History & progress',icon:'chart',onClick:()=>openExerciseDetail(name)}];
  if((ex.alternatives||[]).length)acts.push({label:'Swap exercise',icon:'shuffle',onClick:()=>openSwapSheet(ei)});
  if(woIsBarbell(name))acts.push({label:'Plate calculator',icon:'plates',onClick:()=>openPlateCalc(ei)});
  acts.push({label:hasNote?'Edit note':'Add note',icon:'note',onClick:()=>openNoteModal(ei)});
  acts.push({label:'Watch form video',icon:'play',onClick:()=>window.open(woFormUrl(name),'_blank','noopener')});
  if(_woSession.exercises.length>1)acts.push({label:'Reorder exercises',icon:'reorder',onClick:openReorder});
  acts.push({label:'Remove exercise',icon:'trash',style:'destructive',onClick:()=>woRemoveExercise(ei)});
  acts.push({label:'Cancel',style:'cancel'});
  woSheet({title:name,actions:acts,className:'wo-sheet-menu'});
}
function openSwapSheet(ei){
  const ex=_woSession&&_woSession.exercises[ei];if(!ex)return;
  const acts=(ex.alternatives||[]).map((a,ai)=>({label:a,icon:(a===ex.name&&ex.swappedTo)?'reorder':null,onClick:()=>{swapExercise(ei,ai);woHaptic(8);}}));
  acts.push({label:'Cancel',style:'cancel'});
  woSheet({title:'Swap for…',message:'Same movement pattern, different equipment or angle.',actions:acts,className:'wo-sheet-menu'});
}
// ══════════════════════════════════════════════════════════════════════════
// Live recalibration — re-plan the lifts you haven't started whenever the
// session deviates from the plan (swap, remove, add, or a big rep shortfall).
// The engine decides; this applies it, explains it, and offers Undo.
// ══════════════════════════════════════════════════════════════════════════
function woDoneCount(){return _woSession?_woSession.exercises.reduce((a,e)=>a+(e.sets||[]).filter(s=>s.done).length,0):0;}
function woRecalibrate(){
  if(!_woSession||!_woSession.basePlan||typeof WoEngine.recalibrate!=='function')return;
  let res;
  try{res=WoEngine.recalibrate(_woSession,woEngineInput({recovery:_woSession.recovery??null}));}
  catch(e){console.error('[reBorn] recalibrate',e);return;}
  const changes=(res&&res.changes)||[];
  if(!changes.length)return;
  const snap={ex:JSON.stringify(_woSession.exercises),restEi:_restTimerState.ei,done:woDoneCount()};
  changes.forEach(c=>{
    if(c.type==='replace'){
      const nx=woSessionExercise(c.exercise);
      nx.recal={reason:c.reason,from:c.from};
      _woSession.exercises[c.index]=nx;
    }else if(c.type==='sets'){
      const ex=_woSession.exercises[c.index];if(!ex)return;
      while(ex.sets.length>c.to){const last=ex.sets[ex.sets.length-1];if(last.done||last.weight!==''||last.reps!=='')break;ex.sets.pop();}
      while(ex.sets.length<c.to){const last=ex.sets[ex.sets.length-1]||{};const ns={weight:'',reps:'',rpe:'',done:false};if(last.tw!=null){ns.tw=last.tw;ns.tr=last.tr;}ex.sets.push(ns);}
      ex.recal={reason:c.reason};
    }
  });
  changes.filter(c=>c.type==='insert').sort((a,b)=>b.index-a.index).forEach(c=>{
    const nx=woSessionExercise(c.exercise);nx.recal={reason:c.reason};
    _woSession.exercises.splice(c.index,0,nx);
    if(_restTimerState.ei!=null&&_restTimerState.ei>=c.index)_restTimerState.ei++;
    if(_currentSuggestion&&_currentSuggestion.ei>=c.index)_currentSuggestion.ei++;
  });
  woSave(WO_KEY,_woSession);
  renderExercises();
  woHaptic([8,40,8]);
  woRecalBanner(changes,snap);
}
function woRecalLine(c){
  if(c.type==='replace')return `<b>${escapeHtml(c.from)}</b> → <b>${escapeHtml(c.to)}</b>`;
  if(c.type==='sets')return `<b>${escapeHtml(c.name)}</b>: ${c.from} → ${c.to} sets`;
  return `Added <b>${escapeHtml(c.to)}</b>`;
}
let _woRecalTimer=null;
function woRecalBanner(changes,snap){
  document.querySelectorAll('.wo-recal-banner').forEach(b=>b.remove());
  const el=document.createElement('div');
  el.className='wo-recal-banner';el.setAttribute('role','status');
  const more=changes.length>1?`<div class="wo-recal-more">and ${changes.length-1} more change${changes.length>2?'s':''}</div>`:'';
  el.innerHTML=`<div class="wo-recal-ico">${woIco('sparkles')}</div>
    <div class="wo-recal-txt" role="button" tabindex="0"><div class="wo-recal-title">Plan adjusted</div><div class="wo-recal-line">${woRecalLine(changes[0])}</div>${more}</div>
    <button class="wo-recal-undo">Undo</button>`;
  document.body.appendChild(el);
  requestAnimationFrame(()=>el.classList.add('show'));
  const hide=()=>{clearTimeout(_woRecalTimer);el.classList.remove('show');setTimeout(()=>el.remove(),300);};
  el.querySelector('.wo-recal-undo').onclick=()=>{woRecalUndo(changes,snap);hide();};
  el.querySelector('.wo-recal-txt').onclick=()=>{
    const first=changes.reduce((m,c)=>Math.min(m,c.index),Infinity);
    woGoTo(first);
    hide();
  };
  clearTimeout(_woRecalTimer);_woRecalTimer=setTimeout(hide,8000);
}
function woRecalUndo(changes,snap){
  if(!_woSession)return;
  if(woDoneCount()!==snap.done){woToast('Can’t undo — you’ve logged sets since');return;}
  let exs;try{exs=JSON.parse(snap.ex);}catch(e){return;}
  // Pin what the lifter chose to keep, so the next recalibration leaves it alone.
  changes.forEach(c=>{if(c.type!=='insert'&&exs[c.index])exs[c.index].keep=true;});
  _woSession.exercises=exs;
  _restTimerState.ei=snap.restEi;
  _currentSuggestion=null;
  woSave(WO_KEY,_woSession);
  renderExercises();
  woToast('Kept your original plan');
}

// ══════════════════════════════════════════════════════════════════════════
// Session carousel — one page per exercise, swipe between them.
// ══════════════════════════════════════════════════════════════════════════
let _woPageIdx=0,_woCarRO=null,_woCarBound=false,_woCarT=null;
function woPages(){return [...document.querySelectorAll('#wo-carousel .wo-page')].filter(p=>p.style.display!=='none');}
function woGoTo(i,instant){
  const car=gv('wo-carousel');const pages=woPages();if(!car||!pages.length)return;
  i=Math.max(0,Math.min(i,pages.length-1));
  const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  car.scrollTo({left:pages[i].offsetLeft,behavior:(instant||reduce)?'auto':'smooth'});
  if(instant){_woPageIdx=i;woOnPage();}
}
function woOnPage(){
  const pages=woPages();const car=gv('wo-carousel');if(!car||!pages.length)return;
  const p=pages[Math.min(_woPageIdx,pages.length-1)];
  car.style.height=p.offsetHeight+'px';
  document.querySelectorAll('#wo-pager .wo-pg').forEach((b,k)=>{b.classList.toggle('on',k===_woPageIdx);b.setAttribute('aria-selected',k===_woPageIdx);});
  // keep the new page's top in view
  const hdr=document.querySelector('.wo-active-header');
  const top=car.getBoundingClientRect().top-(hdr?hdr.offsetHeight:0);
  if(top<0)window.scrollBy({top:top-4,behavior:'auto'});
}
function woBindCarousel(){
  const car=gv('wo-carousel');if(!car||_woCarBound)return;_woCarBound=true;
  car.addEventListener('scroll',()=>{
    const w=car.clientWidth||1;
    const i=Math.round(car.scrollLeft/w);
    if(i!==_woPageIdx){_woPageIdx=i;woHaptic(4);document.querySelectorAll('#wo-pager .wo-pg').forEach((b,k)=>b.classList.toggle('on',k===i));}
    clearTimeout(_woCarT);_woCarT=setTimeout(woOnPage,90);
  },{passive:true});
  document.addEventListener('keydown',e=>{
    if(gv('wo-active-view')?.style.display==='none'||_currentPage!=='workout')return;
    if(e.target.closest&&e.target.closest('input,textarea,[contenteditable]'))return;
    if(document.querySelector('.wo-sheet-ov'))return;
    if(e.key==='ArrowRight')woGoTo(_woPageIdx+1);
    if(e.key==='ArrowLeft')woGoTo(_woPageIdx-1);
  });
  window.addEventListener('resize',()=>woGoTo(_woPageIdx,true));
}
function woWatchPageSizes(){
  if(!('ResizeObserver' in window))return;
  if(_woCarRO)_woCarRO.disconnect();
  _woCarRO=new ResizeObserver(()=>{const car=gv('wo-carousel');const p=woPages()[_woPageIdx];if(car&&p)car.style.height=p.offsetHeight+'px';});
  woPages().forEach(p=>_woCarRO.observe(p));
}
function woRenderPager(){
  const el=gv('wo-pager');if(!el||!_woSession)return;
  const segs=_woSession.exercises.map((ex,i)=>{
    const n=ex.sets.length||1,d=ex.sets.filter(s=>s.done).length;
    return `<button class="wo-pg${d===n?' full':''}" style="--f:${d/n}" onclick="woGoTo(${i})" role="tab" aria-label="${escapeAttr((ex.swappedTo||ex.name)+': '+d+' of '+n+' sets')}"></button>`;
  });
  if(_woSession.cardio)segs.push(`<button class="wo-pg${_woSession.cardio.done?' full':''}" style="--f:${_woSession.cardio.done?1:0}" onclick="woGoTo(${_woSession.exercises.length})" role="tab" aria-label="Cardio finisher"></button>`);
  segs.push(`<button class="wo-pg wo-pg-end" onclick="woGoTo(${segs.length})" role="tab" aria-label="Finish">${woIco('check')}</button>`);
  el.innerHTML=segs.join('');
  el.querySelectorAll('.wo-pg').forEach((b,k)=>b.classList.toggle('on',k===_woPageIdx));
}
function woRenderOverview(){
  if(!_woSession)return;
  const el=gv('wo-overview');
  if(el)el.innerHTML=_woSession.exercises.map((ex,i)=>{
    const n=ex.sets.length,d=ex.sets.filter(s=>s.done).length;
    const recap=ex.sets.filter(s=>s.done).map(s=>ex.unit==='sec'?`${s.reps}s`:(parseFloat(s.weight)>0?`${s.weight}×${s.reps}`:`BW×${s.reps}`)).join('  ');
    return `<button class="wo-row wo-ov-row" onclick="woGoTo(${i})">
      ${getExIcon(ex.swappedTo||ex.name)}
      <span class="wo-row-main"><span class="wo-row-label">${escapeHtml(ex.swappedTo||ex.name)}</span><span class="wo-row-sub tnum">${recap||'Not started'}</span></span>
      <span class="wo-ov-state${d===n?' done':''}">${d===n?woIco('check'):`${d}/${n}`}</span>
    </button>`;
  }).join('');
  const st=gv('wo-finish-stats');
  if(st){
    let done=0,total=0,vol=0;
    _woSession.exercises.forEach(ex=>ex.sets.forEach(s=>{total++;if(s.done){done++;vol+=(parseFloat(s.weight)||0)*(parseInt(s.reps)||0);}}));
    const mins=Math.max(0,Math.round((Date.now()-_woSession.startTime)/60000));
    st.innerHTML=`<div class="wo-ss"><div class="wo-ss-v tnum">${done}/${total}</div><div class="wo-ss-l">Sets logged</div></div>
      <div class="wo-ss"><div class="wo-ss-v tnum">${Math.round(vol).toLocaleString()}</div><div class="wo-ss-l">kg volume</div></div>
      <div class="wo-ss"><div class="wo-ss-v tnum">${mins}</div><div class="wo-ss-l">Minutes</div></div>`;
  }
}
function woShowTech(ei){
  const ex=_woSession&&_woSession.exercises[ei];if(!ex)return;
  woSheet({title:ex.intensityTechnique,message:escapeHtml(ex.techNote||''),actions:[{label:'Got it',style:'cancel'}]});
}
function woSetMenu(ei,si){
  const ex=_woSession&&_woSession.exercises[ei];if(!ex)return;
  const s=ex.sets[si];
  const acts=[];
  if(s&&(s.weight!==''||s.reps!==''||s.done))acts.push({label:'Clear this set',icon:'minus',onClick:()=>{s.weight='';s.reps='';s.done=false;woSave(WO_KEY,_woSession);renderExerciseCardAt(ei);}});
  if(ex.sets.length>1)acts.push({label:'Delete set',icon:'trash',style:'destructive',onClick:()=>woDeleteSet(ei,si)});
  acts.push({label:'Cancel',style:'cancel'});
  woSheet({title:`${ex.swappedTo||ex.name} · Set ${si+1}`,actions:acts,className:'wo-sheet-menu'});
}

// Keep anything that refers to exercises by index consistent after a structural change.
function woReindex(map){
  if(_restTimerState&&_restTimerState.ei!=null){const n=map(_restTimerState.ei);_restTimerState.ei=n<0?null:n;}
  _currentSuggestion=null;
}
async function woRemoveExercise(ei){
  const ex=_woSession&&_woSession.exercises[ei];if(!ex)return;
  const logged=ex.sets.filter(s=>s.done).length;
  const ok=await woConfirm('Remove '+(ex.swappedTo||ex.name)+'?',logged?`${logged} logged set${logged>1?'s':''} will be removed too.`:'',"Remove",true);
  if(!ok)return;
  _woSession.exercises.splice(ei,1);
  woReindex(i=>i===ei?-1:(i>ei?i-1:i));
  woSave(WO_KEY,_woSession);
  renderExercises();
  woRecalibrate();
}
function woDeleteSet(ei,si){
  const ex=_woSession&&_woSession.exercises[ei];if(!ex)return;
  if(ex.sets.length<=1){woToast('An exercise needs at least one set');renderExerciseCardAt(ei);return;}
  ex.sets.splice(si,1);
  if(_currentSuggestion&&_currentSuggestion.ei===ei)_currentSuggestion=null;
  woHaptic(10);
  woSave(WO_KEY,_woSession);
  renderExerciseCardAt(ei);
}
function openReorder(){
  if(!_woSession)return;
  const items=_woSession.exercises.map((e,i)=>`<div class="wo-ro-item" data-i="${i}">
      <span class="wo-ro-thumb">${getExIcon(e.swappedTo||e.name,e.swappedTo?null:e.iconSlug)}</span>
      <span class="wo-ro-name">${escapeHtml(e.swappedTo||e.name)}</span>
      <span class="wo-ro-handle" aria-label="Drag to reorder">${woIco('grip')}</span>
    </div>`).join('');
  const sh=woSheet({title:'Reorder exercises',className:'wo-sheet-tall',body:`<div class="wo-reorder">${items}</div>`,
    actions:[{label:'Done',style:'primary',value:'done',onClick:()=>woApplyReorder(list)},{label:'Cancel',style:'cancel'}]});
  const list=sh.body.querySelector('.wo-reorder');
  woInitReorderDrag(list);
}
function woInitReorderDrag(list){
  list.addEventListener('pointerdown',e=>{
    const handle=e.target.closest('.wo-ro-handle');if(!handle)return;
    const item=handle.closest('.wo-ro-item');
    const items=[...list.children];
    const from=items.indexOf(item);
    const h=item.getBoundingClientRect().height+6;
    const y0=e.clientY;let to=from;
    item.classList.add('dragging');handle.setPointerCapture(e.pointerId);
    const move=ev=>{
      const dy=ev.clientY-y0;
      item.style.transform=`translateY(${dy}px)`;
      to=Math.max(0,Math.min(items.length-1,from+Math.round(dy/h)));
      items.forEach((it,i)=>{
        if(it===item)return;
        let shift=0;
        if(from<to&&i>from&&i<=to)shift=-h;
        if(to<from&&i>=to&&i<from)shift=h;
        it.style.transform=shift?`translateY(${shift}px)`:'';
      });
    };
    const up=()=>{
      handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',up);handle.removeEventListener('pointercancel',up);
      items.forEach(it=>{it.style.transform='';});
      item.classList.remove('dragging');
      if(to!==from){
        const ref=to>from?items[to].nextSibling:items[to];
        list.insertBefore(item,ref);
        woHaptic(8);
      }
    };
    handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',up);handle.addEventListener('pointercancel',up);
    e.preventDefault();
  });
}
function woApplyReorder(list){
  if(!_woSession||!list)return;
  const order=[...list.children].map(el=>+el.dataset.i);
  if(order.every((v,i)=>v===i))return;
  const old=_woSession.exercises;
  _woSession.exercises=order.map(i=>old[i]);
  woReindex(i=>order.indexOf(i));
  woSave(WO_KEY,_woSession);
  renderExercises();
}
// ── Exercise detail (history + chart), openable straight from a live session ──
let _woHistDirect=false;
function openExerciseDetail(name){
  if(typeof name==='number'){const ex=_woSession&&_woSession.exercises[name];if(!ex)return;name=ex.swappedTo||ex.name;}
  if(!gv('wo-hist-modal'))showWorkoutHistory();
  _woHistDirect=true;
  renderExerciseProgression(name);
}
async function woAskDiscard(){
  if(!_woSession)return;
  if(await woConfirm('Discard workout?','Nothing from this session will be saved.','Discard',true))discardWorkout();
}

function renderWorkoutPage(){
  if(!_WO_ENGINE_OK){
    const el=gv('wo-split-picker');
    if(el)el.innerHTML='<div class="wo-split-picker-card">The workout engine didn\'t load. Close and reopen the app (or refresh) to pick up the latest version.</div>';
    return;
  }
  const morning=whoopSnaps[0];
  if(morning?.recovery){
    _woRecovery=morning.recovery;
    const inp=gv('wo-rec-val');
    if(inp)inp.value=_woRecovery;
    const lbl=gv('wo-rec-autofill');
    if(lbl)lbl.style.display='';
  }
  updateReadiness();
  // Restore active session if app was closed mid-workout
  const saved=woLoad(WO_KEY,null);
  // Safety net: if this "active" session was already completed (its id is in
  // history), it's a stale copy — discard it instead of reopening it.
  const alreadyDone=saved&&woHistory().some(s=>s.id===saved.id);
  if(saved&&saved.inProgress&&!alreadyDone){
    _woSession=saved;
    _woPlan=saved.plan;
    showActiveWorkout();
  }else if(alreadyDone){
    localStorage.removeItem(WO_KEY);
    if(typeof cloudDelete==='function')cloudDelete(WO_KEY);
  }
  renderSplitPicker();
  renderLastSession();
}

function setRecovery(val){
  woHaptic(8);
  _woRecovery=val;
  const inp=gv('wo-rec-val');
  if(inp)inp.value=val;
  updateReadiness();
}

function updateReadiness(){
  const inp=gv('wo-rec-val');
  if(inp&&inp.value)_woRecovery=parseInt(inp.value);
  const rec=_woRecovery;
  const pctEl=gv('wo-ready-pct');
  const arcEl=gv('wo-ready-arc');
  const verdictEl=gv('wo-ready-verdict');

  // Recovery ring (r=29, circ=2*PI*29=182.2)
  if(rec!=null&&pctEl&&arcEl){
    const circ=182.2;
    const offset=circ-(circ*rec/100);
    arcEl.style.strokeDashoffset=offset;
    const col=rec>=67?'var(--green)':rec>=34?'var(--amber)':'var(--red)';
    arcEl.style.stroke=col;
    pctEl.textContent=rec+'%';
    pctEl.style.color=col;
  }

  // Side stats
  const yest=getYesterdayNutrition();
  const sleepSnap=whoopSnaps[0];
  const sleepDec=sleepSnap?.sleep;
  const sleepHrs=sleepDec!=null?(()=>{const hh=Math.floor(sleepDec),mm=Math.round((sleepDec-hh)*60);return hh+'h'+(mm>0?' '+mm+'m':'');})():'—';
  const lastSessions=getRecentSessions(1);
  const lastLabel=lastSessions.length?lastSessions[0].splitName+'  ·  '+new Date(lastSessions[0].date).toLocaleDateString('en-US',{weekday:'short'}):'None yet';

  const sleepEl=gv('wr-sleep');const protEl=gv('wr-protein');const lastEl=gv('wr-last');
  if(sleepEl)sleepEl.textContent=sleepHrs;
  if(protEl)protEl.textContent=yest.p?Math.round(yest.p)+'g':'—';
  if(lastEl)lastEl.textContent=lastLabel;

  // Level drives the card tint and the selected preset
  const lvl=rec==null?'':rec>=67?'high':rec>=34?'mid':'low';
  const card=gv('wo-ready');if(card)card.dataset.level=lvl;
  document.querySelectorAll('.wo-rec-preset').forEach(b=>b.classList.toggle('sel',b.dataset.lvl===lvl));

  // Verdict
  if(verdictEl){
    if(rec==null){verdictEl.textContent='Enter your WHOOP recovery to begin';return;}
    if(rec>=67)verdictEl.textContent='Great recovery — go heavy today';
    else if(rec>=50)verdictEl.textContent='Decent recovery — moderate volume';
    else if(rec>=34)verdictEl.textContent='Low recovery — keep intensity down';
    else verdictEl.textContent='Poor recovery — consider light work only';
  }
}

// ── Split picker: shows the auto-rotation next-up split and lets the user
// override it for the next generation (one-shot). ──
function woVarietyHint(v){
  return v==='max'
    ?'Every lift rotates every session.'
    :'Main lifts stay for the block; the rest rotates.';
}
function renderSplitPicker(){
  const el=gv('wo-split-picker');if(!el)return;
  const autoSplit=getNextSplit();
  const selected=_woSplitOverride||autoSplit;
  const B=WoEngine.blockInfo(woHistory().length);
  const variety=woPrefs().variety==='max'?'max':'balanced';
  const blockLabel=B.deload?'Deload week':`${B.phaseName} block · Week ${B.week+1} of 4`;
  const sub=gv('wo-hdr-sub');if(sub){sub.textContent=blockLabel;sub.title=B.blurb||'';}
  const muscles=(WoEngine.SPLIT_MUSCLES[selected]||[]);
  const short={'Arms & Shoulders':'Arms'};
  el.innerHTML=`
    <section class="wo-today">
      <div class="wo-today-txt">
        <div class="wo-page-kicker">${selected===autoSplit?'Up next':'Picked for today'}</div>
        <div class="wo-today-title">${escapeHtml(selected)}</div>
        <div class="wo-today-muscles">${muscles.map(escapeHtml).join(' · ')}</div>
        ${selected!==autoSplit?`<button class="wo-link" onclick="pickSplit('${autoSplit.replace(/'/g,"\\'")}')">Back to ${escapeHtml(autoSplit)}</button>`:''}
      </div>
      ${mmHero([],muscles)}
    </section>
    <div class="wo-seg wo-split-seg" role="group" aria-label="Split">
      ${WO_SPLIT_CYCLE.map(name=>`<button class="wo-seg-btn wo-split-chip${name===selected?' sel':''}" onclick="pickSplit('${name.replace(/'/g,"\\'")}')" aria-pressed="${name===selected}">${escapeHtml(short[name]||name)}</button>`).join('')}
    </div>`;
  const act=gv('wo-gen-actions');
  if(act){
    const vi=variety==='max'?1:0;
    act.innerHTML=`
      <div class="wo-group wo-list">
        <div class="wo-row">
          <span class="wo-row-main"><span class="wo-row-label">Variety</span><span class="wo-row-sub wo-variety-hint">${woVarietyHint(variety)}</span></span>
          <div class="wo-seg wo-seg-sm wo-seg-slide" data-sel="${vi}" role="group" aria-label="Variety">
            <span class="wo-seg-thumb" aria-hidden="true"></span>
            <button class="wo-seg-btn wo-variety-chip${vi===0?' sel':''}" onclick="setVariety('balanced')">Balanced</button>
            <button class="wo-seg-btn wo-variety-chip${vi===1?' sel':''}" onclick="setVariety('max')">Max</button>
          </div>
        </div>
      </div>
      <div class="wo-cta"><button class="wo-btn wo-btn-primary wo-btn-lg wo-gen-btn" onclick="generateWorkout()">Generate ${escapeHtml(selected)} workout</button></div>`;
  }
}

// Updated in place so the segmented thumb can glide instead of re-rendering.
function setVariety(v){
  v=v==='max'?'max':'balanced';
  woSetPref('variety',v);woHaptic(8);
  const seg=document.querySelector('#wo-gen-actions .wo-seg-slide');
  if(!seg){renderSplitPicker();return;}
  const vi=v==='max'?1:0;
  seg.dataset.sel=vi;
  seg.querySelectorAll('.wo-seg-btn').forEach((b,i)=>b.classList.toggle('sel',i===vi));
  const h=document.querySelector('#wo-gen-actions .wo-variety-hint');if(h)h.textContent=woVarietyHint(v);
}

// Set a manual override (or clear it back to auto when tapping the auto split).
function pickSplit(name){
  woHaptic(8);
  _woSplitOverride = (name===getNextSplit()) ? null : name;
  renderSplitPicker();
}

function renderLastSession(){
  const el=gv('wo-last-session');if(!el)return;
  const hist=getRecentSessions(1);
  if(!hist.length){el.style.display='none';return;}
  const s=hist[0];
  const date=new Date(s.date).toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});
  el.style.display='block';
  const idx=woHistory().length-1;
  el.innerHTML=`<h2 class="wo-section-title">Last session</h2>
  <button class="wo-group wo-row wo-last-card" onclick="showWorkoutHistory();openHistSession(${idx})">
    <span class="wo-row-main">
      <span class="wo-row-label">${escapeHtml(s.splitName||'Workout')}</span>
      <span class="wo-row-sub">${date} · <span class="tnum">${s.duration>0?s.duration:'<1'}</span> min · <span class="tnum">${(s.totalVolume||0).toLocaleString()}</span> kg</span>
    </span>
    <span class="wo-chev" aria-hidden="true">${woIco('chevron')}</span>
  </button>`;
}

// ── Workout generation (local engine — instant, offline, enforced variety) ──
// All selection, periodisation and progression logic is in workout-engine.js.
function woEngineInput(extra){
  return Object.assign({history:woHistory(),recovery:_woRecovery,prefs:woPrefs(),now:Date.now()},extra||{});
}

function woToast(text){
  const existing=document.querySelector('.wo-suggestion-toast');
  if(existing)existing.remove();
  const toast=document.createElement('div');
  toast.className='wo-suggestion-toast';
  toast.textContent=text;
  document.body.appendChild(toast);
  setTimeout(()=>toast.classList.add('show'),10);
  setTimeout(()=>{toast.classList.remove('show');setTimeout(()=>toast.remove(),300);},2200);
}

function generateWorkout(){
  if(_woSession&&_woSession.inProgress){woToast('Finish your current workout first');return;}
  const loader=gv('wo-generating');if(loader)loader.style.display='none';
  const split=_woSplitOverride||getNextSplit();
  woHaptic(12);
  try{
    _woPlan=WoEngine.generate(woEngineInput({split}));
    // Override was a one-shot; clear it so the next auto rotation resumes.
    _woSplitOverride=null;
    renderSplitPicker();
    renderWorkoutPreview(true);
  }catch(e){
    console.error('[reBorn] Workout gen error:',e);
    const el=gv('wo-plan-preview');
    if(el){
      el.style.display='block';
      el.innerHTML=`<div class="wo-card wo-error"><strong>Couldn't build a workout</strong><span>${escapeHtml(e&&e.message||'Unknown error')}</span><button onclick="generateWorkout()">Try again</button></div>`;
    }
  }
}

// Same split, brand-new selection.
function rerollWorkout(){
  if(!_woPlan)return;
  woHaptic(10);
  try{
    _woPlan=WoEngine.generate(woEngineInput({split:_woPlan.splitCategory}));
    renderWorkoutPreview(true);
  }catch(e){console.error('[reBorn] Reroll error:',e);woToast('Could not reroll');}
}

// Swap a single exercise in the preview for a fresh pick from the same slot.
function swapPreviewExercise(i){
  if(!_woPlan)return;
  const n=WoEngine.swapOne(_woPlan,i,woEngineInput());
  if(!n){woToast('No other options for this slot');return;}
  woHaptic(8);
  renderWorkoutPreview();
  const row=document.querySelector(`#wpp-exercises .wo-ex-preview[data-i="${i}"]`);
  if(row){row.classList.remove('wo-swapped');void row.offsetWidth;row.classList.add('wo-swapped');}
}

// Cardio spec chips — new plans carry `specs`; older sessions/routines fall back to the legacy fields.
function woCardioSpecs(c){
  if(c.specs&&c.specs.length)return c.specs;
  return [{v:c.duration,l:'min'},{v:c.speed,l:c.unit},{v:(c.incline??0)+'%',l:'incline'}];
}

function woTargetLine(ex,compact){
  const unit=ex.unit==='sec'?'s':'';
  if(ex.targets&&ex.targets[0]){
    const t=ex.targets[0];
    const tgt=(t.w>0?t.w+' kg × ':'')+t.r+unit;
    return `<div class="wo-ex-target"><span class="wo-tgt-lbl">Target</span> <span class="wo-tgt-val tnum">${tgt}</span>${ex.lastText&&!compact?`<span class="wo-tgt-last"> · ${escapeHtml(ex.lastText)}</span>`:''}</div>`;
  }
  if(ex.isNew&&!compact){
    const msg=ex.unit==='sec'?'First time — hold for a time that leaves a few seconds spare.'
      :ex.bw?'First time — stop about 2 reps short of failure.'
      :'First time — pick a weight you could lift for about 2 more reps.';
    return `<div class="wo-ex-target new">${msg}</div>`;
  }
  return '';
}
// Status tags shown as quiet coloured text, not pills.
function woBadges(ex){
  const b=[];
  if(ex.held)b.push('<span class="wo-tag brand">Main lift</span>');
  switch(ex.progression){
    case 'up':b.push('<span class="wo-tag ok">Add load</span>');break;
    case 'shift-up':b.push('<span class="wo-tag ok">Heavier</span>');break;
    case 'shift-down':b.push('<span class="wo-tag">Lighter, more reps</span>');break;
    case 'deload':b.push('<span class="wo-tag warn">Deload</span>');break;
    case 'return':b.push('<span class="wo-tag">Easing back in</span>');break;
    case 'reset':b.push('<span class="wo-tag warn">Reset</span>');break;
  }
  if(ex.isNew)b.push('<span class="wo-tag info">New</span>');
  if(ex.len&&ex.role==='isolation')b.push('<span class="wo-tag">Stretch focus</span>');
  return b.length?`<div class="wo-badges">${b.join('<span class="wo-tag-sep">·</span>')}</div>`:'';
}

function woShowCoachNote(){
  const note=(_woSession&&_woSession.coachNote)||(_woPlan&&_woPlan.coachNote)||'';
  if(!note)return;
  woSheet({title:'About this session',message:escapeHtml(note),actions:[{label:'Done',style:'cancel'}]});
}
// "8-10 reps", "30-45s", "10 each side" — never "eachs" or "each side reps".
function woRepsLabel(ex,short){
  const r=String(ex.reps||'').trim();
  if(!r)return '';
  if(/[a-z]/i.test(r))return r;                       // already carries its unit
  return ex.unit==='sec'?r+'s':(short?r:r+' reps');
}
function woRestLabel(sec){
  sec=parseInt(sec)||0;
  if(sec<60)return sec+'s';
  const m=Math.floor(sec/60),r=sec%60;
  return r?`${m}:${String(r).padStart(2,'0')}`:`${m} min`;
}
function woIntensityLine(ex){
  if(!ex.intensityTechnique||ex.intensityTechnique==='straight sets')return '';
  return `<div class="wo-ex-intensity"><b>${escapeHtml(ex.intensityTechnique)}</b>${ex.techNote?` — ${escapeHtml(ex.techNote)}`:''}</div>`;
}
// Sticky Start bar: shown only while the header's Start button is scrolled out of view.
let _woStartObs=null;
function woWatchStartDock(){
  const dock=gv('wo-start-dock');const anchor=document.querySelector('#wo-plan-preview .wo-plan-actions');
  if(!dock||!anchor||!('IntersectionObserver' in window))return;
  if(_woStartObs)_woStartObs.disconnect();
  _woStartObs=new IntersectionObserver(([e])=>{
    // Only once the button has gone off the TOP edge (user scrolled down into the list).
    const show=!e.isIntersecting&&e.boundingClientRect.top<0;
    dock.classList.toggle('show',show);
    dock.setAttribute('aria-hidden',show?'false':'true');
    const b=dock.querySelector('button');if(b)b.tabIndex=show?0:-1;
  });
  _woStartObs.observe(anchor);
}

function renderWorkoutPreview(animate){
  if(!_woPlan)return;
  const nameEl=gv('wpp-name');const noteEl=gv('wpp-note');
  const exEl=gv('wpp-exercises');const cardioEl=gv('wpp-cardio');
  const statsEl=gv('wpp-stats');
  const preview=gv('wo-plan-preview');
  const exs=_woPlan.exercises||[];
  if(nameEl)nameEl.textContent=_woPlan.splitName||'';
  if(noteEl)noteEl.textContent=_woPlan.coachNote||'';
  const nb=gv('wpp-note-btn');
  if(nb){const B=_woPlan.block||{};const T=_woPlan.tier||{};
    nb.innerHTML=`${woIco('sparkles')}<span>${B.deload?'Deload week':(B.phaseName||'')+' · Week '+(B.week||1)+' of 4'}${T.rec!=null?' · Recovery '+T.rec+'%':''}</span>${woIco('chevron','wo-chip-chev')}`;}
  if(statsEl){
    const sets=exs.reduce((a,e)=>a+(parseInt(e.sets)||0),0);
    const cardioMin=_woPlan.cardio?(parseInt(_woPlan.cardio.duration)||0):0;
    const mins=Math.round(exs.reduce((a,e)=>a+(parseInt(e.sets)||0)*((parseInt(e.rest)||90)+40),0)/60)+cardioMin;
    statsEl.innerHTML=`<span><b class="tnum">${exs.length}</b> exercises</span><span><b class="tnum">${sets}</b> sets</span><span><b class="tnum">~${mins}</b> min</span>`;
  }
  if(exEl){
    exEl.innerHTML=exs.map((ex,i)=>`
      <div class="wo-ex-preview" data-i="${i}" style="--i:${i}" onclick="this.classList.toggle('open')">
        <div class="wo-ex-icon">${getExIcon(ex.name, ex.iconSlug) || ex.icon || ''}</div>
        <div class="wo-ex-info">
          <div class="wo-ex-name">${escapeHtml(ex.name)}</div>
          <div class="wo-ex-meta">${ex.focus?`<span class="wo-focus">${escapeHtml(ex.focus)}</span> · `:''}${woEquipOf(ex.name)?escapeHtml(woEquipOf(ex.name))+' · ':''}<span class="tnum">${ex.sets} × ${escapeHtml(woRepsLabel(ex,true))}</span></div>
          ${woBadges(ex)}
          ${woTargetLine(ex,true)}
          <div class="wo-ex-more-info">
            <div class="wo-ex-cue">${escapeHtml(ex.cue||'')}</div>
            <div class="wo-ex-meta">${woRestLabel(ex.rest)} rest between sets</div>
            ${woIntensityLine(ex)}
            <a class="wo-link" href="${woFormUrl(ex.name)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${woIco('play')}Watch form video</a>
          </div>
        </div>
        ${ex.slot?`<button class="wo-icon-btn wo-ex-swap" onclick="event.stopPropagation();swapPreviewExercise(${i})" title="Swap for something different" aria-label="Swap exercise">${woIco('shuffle')}</button>`:''}
      </div>`).join('');
  }
  if(cardioEl){
    if(_woPlan.cardio){
      const c=_woPlan.cardio;
      const specs=woCardioSpecs(c);
      cardioEl.innerHTML=`<h2 class="wo-section-title">Finisher</h2><div class="wo-group wo-cardio-preview">
        <div class="wo-cardio-icon">${getExIcon(c.machine, c.iconSlug) || c.icon || ''}</div>
        <div class="wo-cardio-info">
          <div class="wo-cardio-title">${escapeHtml(c.machine)} · <span class="tnum">${c.duration}</span> min</div>
          <div class="wo-cardio-meta">${specs.slice(1).map(sp=>escapeHtml(sp.v)+' '+escapeHtml(sp.l)).join(' · ')}</div>
          <div class="wo-cardio-rat">${escapeHtml(c.rationale||'')}</div>
        </div>
      </div>`;
    }else cardioEl.innerHTML='';
  }
  woWatchStartDock();
  if(preview){
    preview.style.display='block';
    if(animate){
      preview.classList.remove('wo-preview-pop');void preview.offsetWidth;preview.classList.add('wo-preview-pop');
      preview.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});
    }
  }
}

// ── Start / Active Workout ──
// Fresh set rows for an exercise. Targets (tw/tr) are shown as placeholders and are
// adopted on ✓ if the lifter leaves the boxes blank — one tap to log "as prescribed".
function woNewSets(ex){
  const n=Array.isArray(ex.sets)?ex.sets.length:(parseInt(ex.sets)||3);
  return Array.from({length:n},(_,si)=>{
    const s={weight:'',reps:'',rpe:'',done:false};
    const t=ex.targets&&ex.targets[si];
    if(t){s.tw=t.w;s.tr=t.r;}
    return s;
  });
}
function woSessionExercise(ex){
  return {...ex, sets:woNewSets(ex), collapsed:false, swappedTo:null};
}

function startWorkout(){
  if(!_woPlan)return;
  woHaptic([10,40,18]);
  _woSession={
    id: Date.now(),
    date: new Date().toISOString(),
    coachNote: _woPlan.coachNote||'',
    splitName: _woPlan.splitName,
    splitCategory: _woPlan.splitCategory||null,
    muscleGroups: _woPlan.muscleGroups||[],
    block: _woPlan.block||null,
    recovery: _woRecovery??null,
    inProgress: true,
    startTime: Date.now(),
    exercises: (_woPlan.exercises||[]).map(woSessionExercise),
    // The plan as generated — live recalibration measures every deviation against this.
    basePlan: (_woPlan.exercises||[]).map(e=>({slot:e.slot||null,name:e.name,sets:Array.isArray(e.sets)?e.sets.length:(parseInt(e.sets)||3)})),
    cardio: _woPlan.cardio?{..._woPlan.cardio,done:false,actualDuration:null}:null,
  };
  woSave(WO_KEY,_woSession);
  showActiveWorkout();
}

function woSessionChrome(on){
  const nav=gv('wo-nav');if(nav)nav.style.display=on?'none':'';
}
function openSessionMenu(){
  const acts=[];
  if(_woSession&&_woSession.exercises.length>1)acts.push({label:'Reorder exercises',icon:'reorder',onClick:openReorder});
  acts.push({label:'About this session',icon:'sparkles',onClick:woShowCoachNote});
  acts.push({label:'Workout settings',icon:'gear',onClick:openWoSettings});
  acts.push({label:'History',icon:'clock',onClick:showWorkoutHistory});
  acts.push({label:'Discard workout',icon:'trash',style:'destructive',onClick:woAskDiscard});
  acts.push({label:'Cancel',style:'cancel'});
  woSheet({title:_woSession?.splitName||'Workout',actions:acts,className:'wo-sheet-menu'});
}

function showActiveWorkout(){
  woSessionChrome(true);
  if(_woSession&&!_woSession.basePlan){
    _woSession.basePlan=_woSession.exercises.map(e=>({slot:e.slot||null,name:e.name,sets:(e.sets||[]).length}));
  }
  gv('wo-generate-view').style.display='none';
  gv('wo-active-view').style.display='block';
  const nameEl=gv('wo-split-name');const noteEl=gv('wo-split-note');
  if(nameEl)nameEl.textContent=_woSession.splitName||'';
  if(noteEl)noteEl.textContent=_woSession.coachNote||_woSession.plan?.coachNote||'';
  renderExercises();
  renderCardioSection();
  startElapsedTimer();
  woBindCarousel();
  woWakeOn();
  requestAnimationFrame(()=>{const c=woCurrentEx();woGoTo(c<0?woPages().length-1:c,true);});
  // Show add exercises section
  const addExSection = gv('wo-add-exercises-section');
  if(addExSection) addExSection.style.display = 'block';
}

function startElapsedTimer(){
  if(_woTimerInt)clearInterval(_woTimerInt);
  _woTimerInt=setInterval(()=>{
    const el=gv('wo-elapsed');if(!el)return;
    const secs=Math.floor((Date.now()-_woSession.startTime)/1000);
    const m=Math.floor(secs/60),s=secs%60;
    el.textContent=`${m}:${s.toString().padStart(2,'0')}`;
  },1000);
}

// The exercise you're on: first one with an unlogged set (-1 when everything is done).
function woCurrentEx(){
  if(!_woSession)return -1;
  return _woSession.exercises.findIndex(e=>(e.sets||[]).some(s=>!s.done));
}
// What a blank set row should suggest: the prescribed target, else the previous set's
// numbers (so repeating a set is one tap on ✓).
function woSetHint(ex,si){
  const s=ex.sets[si]||{};
  const prev=si>0?ex.sets[si-1]:null;
  const pw=prev&&prev.weight!==''&&prev.weight!=null?prev.weight:null;
  const pr=prev&&prev.reps!==''&&prev.reps!=null?prev.reps:null;
  return {
    w: s.tw!=null&&s.tw>0 ? s.tw : (s.tw==null ? pw : null),
    r: s.tr!=null ? s.tr : pr,
  };
}

// Keep the screen awake while a session is running (Screen Wake Lock API).
let _woWake=null;
async function woWakeOn(){
  try{
    if(!('wakeLock' in navigator)||_woWake||!_woSession?.inProgress||document.visibilityState!=='visible'||!woUi().awake)return;
    _woWake=await navigator.wakeLock.request('screen');
    _woWake.addEventListener('release',()=>{_woWake=null;});
  }catch(e){_woWake=null;}
}
function woWakeOff(){try{if(_woWake)_woWake.release();}catch(e){}_woWake=null;}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')woWakeOn();});

// Sticky session bar: sets done / total + progress fill.
function woUpdateSessionProgress(){
  if(!_woSession)return;
  let done=0,total=0;
  _woSession.exercises.forEach(e=>(e.sets||[]).forEach(s=>{total++;if(s.done)done++;}));
  const fill=gv('wo-session-fill');if(fill)fill.style.transform=`scaleX(${total?done/total:0})`;
  const cnt=gv('wo-sets-count');if(cnt)cnt.textContent=`${done} / ${total} sets`;
}

function renderExercises(){
  const el=gv('wo-exercises');if(!el||!_woSession)return;
  el.innerHTML=_woSession.exercises.map((ex,ei)=>renderExerciseCard(ex,ei)).join('');
  woUpdateSessionProgress();
  woRenderPager();woRenderOverview();woWatchPageSizes();
  requestAnimationFrame(woOnPage);
  _restRedraw();
  // If a next-set suggestion is pending, re-display the effort rating (it was wiped by innerHTML).
  if (_currentSuggestion && typeof _currentSuggestion.ei === 'number') {
    showEffortRating(_currentSuggestion.ei);
  }
}

// Re-render ONE card in place. Tapping ✓ used to rebuild every card (and re-read the
// whole history for each); now only the card that changed is touched, so scroll
// position, typing focus and other cards' timers are left alone.
function renderExerciseCardAt(ei){
  const ex=_woSession&&_woSession.exercises[ei];
  const old=gv('wo-ex-'+ei);
  if(!ex||!old){renderExercises();return;}
  old.outerHTML=renderExerciseCard(ex,ei);
  woUpdateSessionProgress();
  woRenderPager();woRenderOverview();woWatchPageSizes();
  requestAnimationFrame(woOnPage);
  _restRedraw();
  if (_currentSuggestion && _currentSuggestion.ei === ei) showEffortRating(ei);
}

function woOneRM(ex,s){
  if(ex.unit==='sec')return null;
  const w=parseFloat(s.weight),r=parseInt(s.reps);
  return(w>0&&r>0)?epley(w,r):null;
}

function renderExerciseCard(ex,ei){
  const pbs=woPBs();
  const exName = ex.swappedTo || ex.name;
  const timed = ex.unit === 'sec';
  const pb=pbs[exName];
  const ghostData = getExerciseGhostSets(exName);
  const ghostSets = ghostData?.sets || [];
  const doneCount = ex.sets.filter(s=>s.done).length;
  const total = ex.sets.length;
  const allDone = total>0 && doneCount===total;
  const isCurrent = ei === woCurrentEx();
  const nextIdx = isCurrent ? ex.sets.findIndex(s=>!s.done) : -1;
  const nEx = _woSession.exercises.length;

  const setsHtml=ex.sets.map((s,si)=>{
    const ghost = ghostSets[si];
    let ghostText = '—', trend = '';
    if (ghost) {
      ghostText = timed ? `${ghost.reps}s` : (ghost.weight>0 ? `${ghost.weight} × ${ghost.reps}` : `BW × ${ghost.reps}`);
      if (s.done && s.reps) {
        const cur = (parseFloat(s.weight)||1) * parseInt(s.reps);
        const prev = (ghost.weight||1) * ghost.reps;
        trend = cur > prev ? ' wo-up' : cur < prev ? ' wo-down' : '';
      }
    }
    const hint = woSetHint(ex, si);
    const hasTarget = hint.w != null || hint.r != null;
    const wPh = hint.w != null ? hint.w : (ex.bw||timed ? '0' : '');
    const rPh = hint.r != null ? hint.r : '';
    return `<div class="wo-set-row ${s.done?'done':''}${si===nextIdx?' next':''}" id="wo-set-${ei}-${si}">
      <button class="wo-set-num" onclick="woSetMenu(${ei},${si})" aria-label="Set ${si+1} options">${si+1}</button>
      <div class="wo-set-ghost${trend}">${ghostText}</div>
      <input class="wo-set-inp${hasTarget?' has-target':''}" type="number" inputmode="decimal" placeholder="${wPh}" value="${s.weight}"
        oninput="setExerciseSet(${ei},${si},'weight',this.value)" min="0" step="0.5" aria-label="Set ${si+1} weight in kg">
      <input class="wo-set-inp wo-set-reps${hasTarget?' has-target':''}" type="number" inputmode="numeric" placeholder="${rPh}" value="${s.reps}"
        oninput="setExerciseSet(${ei},${si},'reps',this.value)" min="0" aria-label="Set ${si+1} ${timed?'seconds':'reps'}">
      <button class="wo-set-done-btn ${s.done?'active':''}" onclick="toggleSetDone(${ei},${si})" aria-label="Mark set ${si+1} done" aria-pressed="${!!s.done}">${woIco('check')}</button>
    </div>`;
  }).join('');

  // The one number that matters: what to lift on the next set.
  const t = ex.targets && ex.targets[0];
  let target;
  if (t) {
    target = `<div class="wo-tgt-big tnum">${t.w>0?`${t.w}<small>kg</small><i>×</i>`:''}${t.r}<small>${timed?'s':' reps'}</small></div>
      <div class="wo-tgt-sub">${ex.lastText?escapeHtml(ex.lastText):'Target for every set'}${pb&&!timed?`<br>Best e1RM ${pb.oneRM} kg`:''}</div>`;
  } else {
    target = `<div class="wo-tgt-big wo-tgt-new">${ex.isNew?'New exercise':'Your call'}</div>
      <div class="wo-tgt-sub">${timed?'Hold for a time that leaves a few seconds spare':ex.bw?'Stop about 2 reps short of failure':'Pick a weight you could lift for ~2 more reps'}</div>`;
  }
  const savedNote = getExerciseNote(exName);
  const tech = ex.intensityTechnique&&ex.intensityTechnique!=='straight sets'
    ? `<button class="wo-tech-chip" onclick="woShowTech(${ei})">${woIco('zap')}<span>${escapeHtml(ex.intensityTechnique)} on the last set</span></button>` : '';
  const how = [
    ex.cue?`<p>${escapeHtml(ex.cue)}</p>`:'',
    ex.warmup?`<p class="wo-howto-dim">${escapeHtml(ex.warmup)}</p>`:'',
    `<a class="wo-link" href="${woFormUrl(exName)}" target="_blank" rel="noopener">${woIco('play')}Watch form video</a>`,
  ].join('');
  const equip = woEquipOf(exName);
  return `<section class="wo-page wo-ex-card${allDone?' complete':''}${isCurrent?' current':''}" id="wo-ex-${ei}" data-ei="${ei}" aria-label="${escapeAttr(exName)}">
    <div class="wo-page-top">
      <div class="wo-page-head">
        <div class="wo-page-kicker">${allDone?`<span class="wo-kicker-done">${woIco('check')}Done</span> · `:''}${ex.isAutoCore?'Core first · ':''}Exercise ${ei+1} of ${nEx}</div>
        <button class="wo-page-title" onclick="openExerciseDetail(${ei})">${escapeHtml(exName)}</button>
        <div class="wo-page-meta">${ex.focus?escapeHtml(ex.focus)+' · ':''}${equip?escapeHtml(equip)+' · ':''}${escapeHtml(woRepsLabel(ex))} · ${woRestLabel(ex.rest)} rest</div>
      </div>
      <button class="wo-icon-btn wo-ex-more" onclick="openExMenu(${ei})" aria-label="Exercise options">${woIco('more')}</button>
    </div>
    <div class="wo-page-hero">${mmHero([exName])}<div class="wo-page-target">${target}${tech}</div></div>
    ${ex.recal&&!doneCount?`<div class="wo-recal-note">${woIco('sparkles')}<span>${escapeHtml(ex.recal.reason)}</span></div>`:''}
    ${savedNote?`<div class="wo-ex-note" onclick="openNoteModal(${ei})">${woIco('note')}<span class="wo-ex-note-text">${escapeHtml(savedNote)}</span></div>`:''}
    <div class="wo-sets">
      <div class="wo-sets-header"><span>Set</span><span>Previous</span><span>kg</span><span>${timed?'Secs':'Reps'}</span><span></span></div>
      ${setsHtml}
    </div>
    <button class="wo-add-set-btn" onclick="addSet(${ei})">${woIco('plus')}Add set</button>
    <div id="wo-effort-slot-${ei}" class="wo-effort-slot" style="display:none"></div>
    <details class="wo-howto"><summary>How to do it${woIco('chevron','wo-howto-chev')}</summary><div class="wo-howto-body">${how}</div></details>
  </section>`;
}

function renderCardioSection(){
  const page=gv('wo-cardio-page');
  const el=gv('wo-cardio-section');if(!el)return;
  if(!_woSession?.cardio){if(page)page.style.display='none';el.innerHTML='';return;}
  if(page)page.style.display='';
  const c=_woSession.cardio;
  el.innerHTML=`<div class="wo-cardio-card ${c.done?'done':''}">
    <div class="wo-page-head">
      <div class="wo-page-kicker">${c.done?`<span class="wo-kicker-done">${woIco('check')}Done</span> · `:''}Finisher</div>
      <div class="wo-page-title-static">${escapeHtml(c.machine)}</div>
    </div>
    <div class="wo-cardio-specs">
      ${woCardioSpecs(c).map(sp=>`<div class="wo-cs"><div class="wo-cs-v">${escapeHtml(sp.v)}</div><div class="wo-cs-l">${escapeHtml(sp.l)}</div></div>`).join('')}
    </div>
    <p class="wo-cardio-rat">${escapeHtml(c.rationale||'')}</p>
    <button class="wo-btn ${c.done?'wo-btn-gray':'wo-btn-primary'} wo-btn-lg" onclick="toggleCardioDone()">${c.done?'Mark as not done':'Mark cardio done'}</button>
  </div>`;
  woRenderOverview();
}

// ── Set logging ──
// Live 1RM readout for one row. (The old selector used :nth-child on a parent that
// also holds headers and hints, so it never matched and the 1RM never updated.)
function woRefreshOneRM(ei,si){
  const ex=_woSession&&_woSession.exercises[ei];if(!ex)return;
  const row=gv(`wo-set-${ei}-${si}`);if(!row)return;
  const oneRM=woOneRM(ex,ex.sets[si]);
  const rm=row.querySelector('.wo-set-1rm');
  if(rm){rm.textContent=oneRM?oneRM:'—';rm.classList.toggle('has',!!oneRM);}
}

function setExerciseSet(ei,si,field,val){
  if(!_woSession)return;
  _woSession.exercises[ei].sets[si][field]=val;
  woRefreshOneRM(ei,si);
  woSave(WO_KEY,_woSession);
}

function toggleSetDone(ei,si){
  if(!_woSession)return;
  const ex=_woSession.exercises[ei];
  const set=ex&&ex.sets[si];
  if(!set)return;
  const name=ex.swappedTo||ex.name;
  const timed=ex.unit==='sec';
  const curBefore=woCurrentEx();
  set.done=!set.done;
  // A pending "how was that set?" for this very set is moot once it's logged.
  if(_currentSuggestion&&_currentSuggestion.ei===ei&&_currentSuggestion.nextSetIndex===si)_currentSuggestion=null;

  if(set.done){
    woHaptic(14);
    // One-tap logging: anything left blank adopts the target, else repeats the previous set.
    const hint=woSetHint(ex,si);
    if((set.weight===''||set.weight==null)){
      if(set.tw!=null)set.weight=String(set.tw);
      else if(hint.w!=null)set.weight=String(hint.w);
      else if(ex.bw||timed)set.weight='0';            // bodyweight / holds: no added load
    }
    if((set.reps===''||set.reps==null)&&hint.r!=null)set.reps=String(hint.r);

    const w=parseFloat(set.weight),r=parseInt(set.reps);
    if(!timed&&w>0&&r>0){
      // Personal best: only a beaten PB is news; the very first log just becomes the baseline.
      const pbs=Object.assign({},woPBs());
      const oneRM=epley(w,r);
      const prev=pbs[name];
      if(!prev||oneRM>prev.oneRM){
        pbs[name]={weight:w,reps:r,oneRM,date:new Date().toISOString()};
        woSave(WO_PBS_KEY,pbs);
        if(prev){
          const hits=(_woSession.pbHits=_woSession.pbHits||[]);
          const i=hits.findIndex(h=>h.name===name);
          const rec={name,weight:w,reps:r,oneRM,prevOneRM:prev.oneRM};
          if(i>=0)hits[i]=rec;else hits.push(rec);
          woToast(`New PB — ${name}: ${w}kg × ${r} (1RM ${oneRM}kg)`);
          woHaptic([20,60,20,60,40]);
        }
      }
    }
    // Offer the effort rating for the next set
    const nextSetIndex=si+1;
    if(!timed&&w>0&&r>0&&nextSetIndex<ex.sets.length&&!ex.sets[nextSetIndex].done){
      _currentSuggestion={ei,nextSetIndex,baseWeight:w,baseReps:r};
    }
  }
  // Focus flow: a finished exercise folds into a one-line recap; un-ticking reopens it.
  const exDone=ex.sets.every(s=>s.done);
  if(set.done&&exDone){
    ex.collapsed=true;
    if(_currentSuggestion&&_currentSuggestion.ei===ei)_currentSuggestion=null;
  }
  if(!set.done)ex.collapsed=false;
  const curAfter=woCurrentEx();
  if(curAfter>=0)_woSession.exercises[curAfter].collapsed=false;
  woSave(WO_KEY,_woSession);
  renderExerciseCardAt(ei);
  // The "current" highlight may have moved to another card — repaint those too.
  new Set([curBefore,curAfter]).forEach(i=>{if(i>=0&&i!==ei)renderExerciseCardAt(i);});
  if(set.done)woRecalibrate();
  if(set.done){
    const row=gv(`wo-set-${ei}-${si}`);if(row)row.classList.add('just-done');
    if(woUi().autoRest)startRestTimer(ei,ex.rest||90);
    if(_currentSuggestion&&_currentSuggestion.ei===ei)showEffortRating(ei);
    if(exDone){
      const c=gv('wo-ex-'+ei);if(c)c.classList.add('just-complete');
      woHaptic([12,50,24]);
      // Move on to the next exercise (or the finish page) once this one is complete.
      const nextPage=curAfter>=0?curAfter:woPages().length-1;
      if(nextPage!==ei)setTimeout(()=>woGoTo(nextPage),650);
    }
  }
}

// ── Weight/Rep Suggestion System ──
let _currentSuggestion = null;

function showEffortRating(ei) {
  const slot = gv(`wo-effort-slot-${ei}`);
  if (!slot) return;
  if (slot.dataset.shown === '1') return;

  slot.innerHTML = `
    <div class="wo-effort-rating">
      <div class="wo-effort-label">How did that set feel?</div>
      <div class="wo-effort-btns">
        <button class="wo-effort-btn easy" onclick="applyEffortSuggestion('easy')"><b>Easy</b><span>Add weight</span></button>
        <button class="wo-effort-btn good" onclick="applyEffortSuggestion('good')"><b>Good</b><span>Keep it</span></button>
        <button class="wo-effort-btn hard" onclick="applyEffortSuggestion('hard')"><b>Hard</b><span>One less rep</span></button>
      </div>
    </div>
  `;
  slot.style.display = 'block';
  slot.dataset.shown = '1';
}

function hideEffortRating(ei) {
  const slot = gv(`wo-effort-slot-${ei}`);
  if (!slot) return;
  slot.innerHTML = '';
  slot.style.display = 'none';
  slot.dataset.shown = '';
}

function applyEffortSuggestion(effort) {
  if (!_currentSuggestion || !_woSession) return;

  const { ei, nextSetIndex, baseWeight, baseReps } = _currentSuggestion;
  const ex = _woSession.exercises[ei];
  const nextSet = ex.sets[nextSetIndex];

  if (!nextSet || nextSet.done) { _currentSuggestion = null; return; }

  let suggestedWeight = baseWeight, suggestedReps = baseReps;
  if (effort === 'easy') {
    suggestedWeight = baseWeight + (baseWeight >= 50 ? 5 : 2.5);   // bump the load
  } else if (effort === 'hard') {
    suggestedReps = Math.max(baseReps - 1, 1);                     // same load, one fewer rep
  }

  nextSet.weight = String(suggestedWeight);
  nextSet.reps = String(suggestedReps);
  woSave(WO_KEY, _woSession);

  hideEffortRating(ei);

  // Patch just that row's inputs — a full re-render would wipe the running rest timer.
  const row = gv(`wo-set-${ei}-${nextSetIndex}`);
  if (row) {
    const inputs = row.querySelectorAll('input');
    if (inputs[0]) inputs[0].value = nextSet.weight;
    if (inputs[1]) inputs[1].value = nextSet.reps;
    woRefreshOneRM(ei, nextSetIndex);
  }
  showSuggestionToast(suggestedWeight, suggestedReps, effort);
  _currentSuggestion = null;
}

function showSuggestionToast(weight, reps, effort) {
  woToast(`Next set: ${weight}kg × ${reps}`);
}

function toggleExCollapse(ei){
  if(!_woSession)return;
  _woSession.exercises[ei].collapsed=!_woSession.exercises[ei].collapsed;
  renderExerciseCardAt(ei);
}

function addSet(ei){
  if(!_woSession)return;
  const sets=_woSession.exercises[ei].sets;
  const last=sets[sets.length-1];
  const ns={weight:'',reps:'',rpe:'',done:false};
  if(last&&last.tw!=null){ns.tw=last.tw;ns.tr=last.tr;}   // extra set inherits the target
  sets.push(ns);
  woSave(WO_KEY,_woSession);
  renderExerciseCardAt(ei);
}

// ── Suggest more exercises (local) ──
// Finds the least-covered muscles of today's split and proposes low-recovery-cost
// isolation work for them, preferring stretched-position movements you haven't done lately.
function suggestMoreExercises() {
  if (!_woSession) return;
  const suggestEl = gv('wo-suggested-exercises');
  if (!suggestEl) return;

  const extras = WoEngine.suggestExtras(_woSession, woEngineInput({ recovery: _woSession.recovery ?? null }));
  if (!extras.length) {
    suggestEl.innerHTML = `<div class="wo-suggest-error">Nothing more to add — today's plan already covers this split.</div>`;
    return;
  }
  window._suggestedExercises = extras;
  suggestEl.innerHTML = `
    <div class="wo-suggest-title">Suggested Exercises</div>
    ${extras.map((s, i) => `
      <div class="wo-suggest-card">
        <div class="wo-suggest-card-top">
          <div class="wo-suggest-card-icon">${getExIcon(s.name)}</div>
          <div class="wo-suggest-card-info">
            <div class="wo-suggest-card-name">${escapeHtml(s.name)}</div>
            <div class="wo-suggest-card-meta">${s.sets} sets · ${escapeHtml(s.reps)} reps · ${escapeHtml(s.muscle)}</div>
          </div>
          <button class="wo-suggest-add-btn" onclick="addSuggestedExercise(${i})">+ Add</button>
        </div>
        <div class="wo-suggest-card-reason">${escapeHtml(s.reason)}</div>
      </div>
    `).join('')}
  `;
}

function addSuggestedExercise(index) {
  if (!_woSession || !window._suggestedExercises?.[index]) return;

  const s = window._suggestedExercises[index];
  _woSession.exercises.push(Object.assign(woSessionExercise({ ...s, icon: getExIcon(s.name), iconSlug: getExIconSlug(s.name) }), { addedByUser: true }));
  woSave(WO_KEY, _woSession);
  renderExercises();
  woRecalibrate();

  const cards = document.querySelectorAll('.wo-suggest-card');
  if (cards[index]) {
    cards[index].style.opacity = '0.5';
    const btn = cards[index].querySelector('.wo-suggest-add-btn');
    if (btn) { btn.textContent = '✓ Added'; btn.disabled = true; }
  }
  setTimeout(() => {
    woGoTo(_woSession.exercises.length - 1);
  }, 100);
}

// ── Exercise cue lookup (MMC cues for common exercises) ──
const EXERCISE_CUES = {
  // Chest
  'bench press': 'Drive through your chest, not arms. Squeeze pecs at the top, controlled descent.',
  'incline dumbbell press': 'Feel the stretch at the bottom, drive elbows toward each other at top.',
  'cable fly': 'Slight bend in elbows, squeeze chest together like hugging a tree.',
  'dumbbell fly': 'Control the stretch, think about bringing your elbows together.',
  'push-up': 'Protract shoulders at top, chest to floor, core tight throughout.',
  'machine chest press': 'Push through your chest, not shoulders. Full range of motion.',
  
  // Back
  'lat pulldown': 'Pull with your elbows, not hands. Drive elbows down and back.',
  'cable row': 'Initiate by squeezing shoulder blades, then pull elbows back.',
  'seated row': 'Chest up, squeeze back at contraction. No momentum.',
  'barbell row': 'Hip hinge, pull to lower chest, squeeze lats at top.',
  'dumbbell row': 'Drive elbow to hip, feel lat stretch at bottom.',
  'pull-up': 'Lead with chest to bar, squeeze lats at top.',
  'face pull': 'Pull to face level, externally rotate at end. Rear delts and traps.',
  't-bar row': 'Drive elbows back, squeeze shoulder blades together.',
  
  // Shoulders
  'overhead press': 'Core tight, press straight up, lockout overhead.',
  'lateral raise': 'Lead with elbows, slight bend, control the descent.',
  'front raise': 'Slight lean forward, raise to eye level, slow negative.',
  'rear delt fly': 'Bent over, lead with elbows out, squeeze rear delts.',
  'arnold press': 'Rotate as you press, feel all three delt heads.',
  'shoulder press machine': 'Keep back against pad, press through delts.',
  
  // Arms
  'bicep curl': 'Elbows pinned, squeeze at top, control the negative.',
  'hammer curl': 'Neutral grip, focus on brachialis and forearm.',
  'tricep pushdown': 'Elbows locked at sides, squeeze triceps at bottom.',
  'skull crusher': 'Elbows fixed, lower to forehead, extend fully.',
  'overhead tricep extension': 'Elbows by ears, full stretch at bottom.',
  'preacher curl': 'Arm flat on pad, no swinging, peak contraction.',
  'cable curl': 'Constant tension, squeeze bicep at top.',
  
  // Legs
  'squat': 'Push floor away, knees track toes, chest up throughout.',
  'leg press': 'Full depth, push through heels, control the descent.',
  'romanian deadlift': 'Hinge at hips, feel hamstring stretch, squeeze glutes at top.',
  'leg curl': 'Squeeze hamstrings, control both phases of the movement.',
  'leg extension': 'Quad squeeze at top, don\'t lock aggressively.',
  'lunge': 'Step forward, knee over ankle, drive through front heel.',
  'bulgarian split squat': 'Lean slightly forward, feel the stretch, drive up through front leg.',
  'hip thrust': 'Drive through heels, squeeze glutes at top, chin tucked.',
  'calf raise': 'Full stretch at bottom, peak squeeze at top, pause.',
  'deadlift': 'Push floor away, bar close to body, lockout with hips.',
  'sumo deadlift': 'Knees out, chest up, drive through heels.',
  'goblet squat': 'Elbows between knees, sit back, chest proud.',
  
  // Core
  'plank': 'Squeeze glutes and core, straight line from head to heels.',
  'dead bug': 'Lower back pressed to floor, opposite arm and leg extend.',
  'hanging leg raise': 'Control the swing, curl pelvis up, feel lower abs.',
  'cable crunch': 'Curl down with abs, not hip flexors, squeeze at bottom.',
  'ab wheel': 'Core braced, roll out with control, don\'t collapse lower back.',
  'russian twist': 'Lean back slightly, rotate from core not arms.',
  'pallof press': 'Resist rotation, press straight out, brace core.',
};

function getExerciseCue(exerciseName) {
  const normalized = exerciseName.toLowerCase().trim();
  // Direct match
  if (EXERCISE_CUES[normalized]) return EXERCISE_CUES[normalized];
  // Partial match
  for (const [key, cue] of Object.entries(EXERCISE_CUES)) {
    if (normalized.includes(key) || key.includes(normalized)) return cue;
  }
  return 'Focus on the target muscle, control the movement, full range of motion.';
}

function swapExercise(ei,ai){
  if(!_woSession)return;
  const ex = _woSession.exercises[ei];
  if (!ex) return;
  const newName = typeof ai === 'number' ? (ex.alternatives||[])[ai] : ai;
  if (!newName) return;

  // The exercise currently visible (before swap).
  const currentDisplayed = ex.swappedTo || ex.name;

  // Remove the chosen new exercise from the alternatives pool…
  ex.alternatives = Array.isArray(ex.alternatives) ? ex.alternatives.filter(a => a !== newName) : [];

  // …and add the previously-displayed exercise to the pool so the user can swap back.
  if (currentDisplayed && currentDisplayed !== newName &&
      !ex.alternatives.includes(currentDisplayed)) {
    ex.alternatives.unshift(currentDisplayed); // put "swap back" first
  }
  if (ex.alternatives.length > 4) ex.alternatives = ex.alternatives.slice(0, 4);

  ex.swappedTo = newName;
  ex.icon = getExIcon(newName);
  ex.iconSlug = getExIconSlug(newName);

  // Everything that depends on the movement is re-derived: cue, units, targets, warm-up.
  const lib = WoEngine.byName(newName);
  ex.cue = lib ? lib.cue : getExerciseCue(newName);
  ex.unit = lib ? lib.unit : 'reps';
  ex.bw = lib ? lib.bw : false;
  const fresh = lib ? WoEngine.exerciseFor(newName, woEngineInput({
    block: _woSession.block, split: _woSession.splitCategory, slot: ex.slot, recovery: _woSession.recovery ?? null,
  })) : null;
  if (fresh) {
    ex.targets = fresh.targets; ex.progression = fresh.progression; ex.lastText = fresh.lastText;
    ex.isNew = fresh.isNew; ex.warmup = fresh.warmup; ex.muscle = fresh.muscle; ex.held = false;
    ex.intensityTechnique = 'straight sets'; ex.techNote = null;
  } else {
    ex.targets = null; ex.lastText = ''; ex.warmup = null; ex.isNew = true;
  }
  // Untouched sets pick up the new targets; anything already logged is left as typed.
  ex.sets.forEach((s, si) => {
    if (s.done || s.weight !== '' || s.reps !== '') return;
    const t = ex.targets && ex.targets[si];
    if (t) { s.tw = t.w; s.tr = t.r; } else { delete s.tw; delete s.tr; }
  });
  woSave(WO_KEY, _woSession);
  renderExerciseCardAt(ei);
  woRecalibrate();
}

function toggleCardioDone(){
  if(!_woSession?.cardio)return;
  _woSession.cardio.done=!_woSession.cardio.done;
  if(_woSession.cardio.done)woHaptic(15);
  setTimeout(woRenderPager,0);
  woSave(WO_KEY,_woSession);
  renderCardioSection();
}

// ── Rest timer ──
// Derived from an end timestamp rather than counted down tick by tick, so it stays
// accurate when the phone throttles timers in a locked / backgrounded app.
let _restTimerState = { ei: null, endAt: 0, total: 0, active: false, shown: -1 };

function _restRemaining() { return Math.max(0, Math.ceil((_restTimerState.endAt - Date.now()) / 1000)); }

// One dock for the whole app (lives outside the cards, so it survives a card collapsing
// and stays visible on other tabs). Tapping its readout jumps back to the session.
function woRestEl(){ return gv('wo-rest-dock'); }
function woRestHide(){ const el=woRestEl(); if(el){ el.style.display='none'; el.innerHTML=''; } }
function woUpNext(){
  const c=woCurrentEx();
  if(c<0)return _woSession?.cardio&&!_woSession.cardio.done?'Cardio finisher':'Finish workout';
  const ex=_woSession.exercises[c];
  const si=ex.sets.findIndex(s=>!s.done);
  const h=woSetHint(ex,si);
  const s=ex.sets[si];
  const w=s.weight!==''?s.weight:h.w, r=s.reps!==''?s.reps:h.r;
  const load=(w!=null&&parseFloat(w)>0?w+' × ':'')+(r!=null?r+(ex.unit==='sec'?'s':''):'');
  if(c===_restTimerState.ei)return `Set ${si+1} of ${ex.sets.length}${load?' · '+load:''}`;
  return escapeHtml(ex.swappedTo||ex.name);
}
function woRestGoto(){
  if(_currentPage!=='workout')showPage('workout',gv('nb-workout'));
  const c=woCurrentEx();setTimeout(()=>woGoTo(c<0?woPages().length-1:c),60);
}

function _restDraw(force) {
  const st = _restTimerState;
  if (!st.active) return;
  const el = woRestEl();
  if (!el) return;
  const remaining = _restRemaining();
  if (!force && remaining === st.shown && el.style.display === 'flex') return;
  st.shown = remaining;
  el.style.display = 'flex';
  const mins = Math.floor(remaining / 60);
  const secsLeft = remaining % 60;
  const timeStr = `${mins}:${secsLeft.toString().padStart(2, '0')}`;
  const progress = st.total > 0 ? (st.total - remaining) / st.total : 0;
  const isUrgent = remaining <= 10;
  const isPulsing = remaining <= 5 && remaining > 0;
  el.innerHTML = `
    <div class="rest-timer-content ${isUrgent ? 'urgent' : ''} ${isPulsing ? 'pulsing' : ''}">
      <div class="rest-timer-bar" style="transform: scaleX(${progress})"></div>
      <div class="rest-timer-info" onclick="woRestGoto()"><div class="rest-timer-lbl">Rest</div><div class="rest-timer-time">${timeStr}</div></div>
      <div class="rest-timer-next" onclick="woRestGoto()"><div class="rest-timer-lbl">Up next</div><div class="rest-timer-next-v">${woUpNext()}</div></div>
      <div class="rest-timer-btns">
        <button class="rest-timer-btn" onclick="addRestTime(-15)" aria-label="15 seconds less">−15</button>
        <button class="rest-timer-btn" onclick="addRestTime(15)" aria-label="15 seconds more">+15</button>
        <button class="rest-timer-btn skip" onclick="skipRestTimer()">Skip</button>
      </div>
    </div>
  `;
}
// After a card is re-rendered its timer element is brand new — paint the running timer back in.
function _restRedraw() { _restDraw(true); }

function startRestTimer(ei, secs) {
  if (_woRestInt) clearInterval(_woRestInt);
  _restTimerState = { ei, endAt: Date.now() + secs * 1000, total: secs, active: true, shown: -1 };
  _restDraw(true);
  _woRestInt = setInterval(_restTick, 500);
}

function _restTick() {
  const st = _restTimerState;
  if (!st.active) { if (_woRestInt) clearInterval(_woRestInt); return; }
  if (_restRemaining() <= 0) {
    st.active = false;
    clearInterval(_woRestInt);
    const el = woRestEl();
    if (el) { el.style.display = 'flex'; el.innerHTML = `<div class="rest-timer-done" onclick="woRestGoto()">${woIco('zap')}<span>Go — ${woUpNext()}</span></div>`; }
    if (woUi().sound) playRestChime();
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    if (document.visibilityState === 'hidden') woNotify('Rest over', 'Up next: ' + woUpNext().replace(/&[a-z#0-9]+;/g, ''));
    setTimeout(() => { if (!_restTimerState.active) woRestHide(); }, 2600);
    return;
  }
  _restDraw(false);
}
// Catch up immediately when the app comes back to the foreground.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') _restTick(); });

function addRestTime(secs) {
  if (!_restTimerState.active) return;
  woHaptic(6);
  _restTimerState.endAt += secs * 1000;
  _restTimerState.total += secs;
  _restDraw(true);
}

function skipRestTimer() {
  if (_woRestInt) clearInterval(_woRestInt);
  _restTimerState.active = false;
  woRestHide();
}

function playRestChime() {
  // Approach 1 — Web Audio (desktop + when AudioContext is available)
  // Uses triangle wave + higher gain to cut through background music.
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      const ac = window._restChimeCtx || (window._restChimeCtx = new AC());
      // Suspended contexts (common in PWA background/foreground) do nothing silently.
      // resume() returns a promise; we fire-and-forget.
      if (ac.state === 'suspended') ac.resume().catch(()=>{});

      const playTone = (freq, startOffset, dur, gain=0.7) => {
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.type = 'triangle'; // richer than sine, more audible than square
        o.frequency.value = freq;
        const t0 = ac.currentTime + startOffset;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        o.connect(g);
        g.connect(ac.destination);
        o.start(t0);
        o.stop(t0 + dur + 0.02);
      };

      // Three ascending tones — brighter "ding-ding-ding" pattern
      playTone(880,  0.00, 0.18, 0.7);  // A5
      playTone(1175, 0.15, 0.18, 0.7);  // D6
      playTone(1568, 0.30, 0.28, 0.8);  // G6
    }
  } catch (e) {
    console.log('[reBorn] Web Audio not available:', e);
  }

  // Approach 2 — HTML5 <audio> fallback.
  // On iOS, <audio> playback goes to MEDIA volume and ducks other media apps
  // (Spotify) instead of being muted by the silent switch / other-audio-playing.
  // This is the reliable path when Spotify is active.
  try {
    if (!window._restChimeAudio) {
      // Short 3-tone chime baked as a base64 WAV, ~0.6s.
      // 22050Hz mono 16-bit, three tones: A5, D6, G6.
      window._restChimeAudio = _buildChimeAudioEl();
    }
    const a = window._restChimeAudio;
    a.currentTime = 0;
    a.volume = 1.0;
    const p = a.play();
    if (p && p.catch) p.catch(err => console.log('[reBorn] <audio> blocked:', err));
  } catch (e) {
    console.log('[reBorn] HTML5 audio fallback failed:', e);
  }

  // Approach 3 — Vibration (already present in caller, but belt & suspenders
  // here too in case the timer's vibrate call gets ripped out later).
  try { if (navigator.vibrate) navigator.vibrate([120, 60, 120, 60, 200]); } catch(e){}
}

// Synthesize a 3-tone chime WAV and return a playable <audio> element.
// Runs once per page-load; the result is cached on window._restChimeAudio.
function _buildChimeAudioEl() {
  const sampleRate = 22050;
  const tones = [
    { freq: 880,  start: 0.00, dur: 0.18 }, // A5
    { freq: 1175, start: 0.15, dur: 0.18 }, // D6
    { freq: 1568, start: 0.30, dur: 0.30 }, // G6
  ];
  const totalDur = 0.70;
  const totalSamples = Math.floor(sampleRate * totalDur);
  const samples = new Float32Array(totalSamples);

  tones.forEach(t => {
    const startIdx = Math.floor(t.start * sampleRate);
    const endIdx   = Math.min(totalSamples, Math.floor((t.start + t.dur) * sampleRate));
    for (let i = startIdx; i < endIdx; i++) {
      const localT = (i - startIdx) / sampleRate;
      // Triangle wave — richer than sine, still smooth
      const phase = (t.freq * localT) % 1;
      const tri = phase < 0.5 ? (4*phase - 1) : (3 - 4*phase);
      // Exponential decay envelope for a nice "ding"
      const env = Math.exp(-4 * localT);
      samples[i] += tri * env * 0.55;
    }
  });

  // Soft clip anything over [-1, 1]
  for (let i = 0; i < totalSamples; i++) {
    if (samples[i] >  1) samples[i] =  1;
    if (samples[i] < -1) samples[i] = -1;
  }

  // Encode as 16-bit PCM WAV
  const buffer = new ArrayBuffer(44 + totalSamples * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i=0;i<s.length;i++) view.setUint8(off+i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + totalSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);        // PCM chunk size
  view.setUint16(20, 1, true);         // PCM format
  view.setUint16(22, 1, true);         // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);         // block align
  view.setUint16(34, 16, true);        // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, totalSamples * 2, true);
  let off = 44;
  for (let i = 0; i < totalSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s * 0x7FFF, true);
    off += 2;
  }

  const blob = new Blob([buffer], { type: 'audio/wav' });
  const a = new Audio();
  a.src = URL.createObjectURL(blob);
  a.preload = 'auto';
  // iOS: treat this as media (plays over Spotify at media volume rather than being silenced)
  a.setAttribute('playsinline', '');
  return a;
}

// Unlock audio on first user tap — required by iOS/Safari so Web Audio + <audio>
// can both play mid-workout without a prior gesture in that session.
(function primeAudioOnFirstTap(){
  let primed = false;
  const prime = () => {
    if (primed) return;
    primed = true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        const ac = window._restChimeCtx || (window._restChimeCtx = new AC());
        if (ac.state === 'suspended') ac.resume().catch(()=>{});
        // Silent blip to fully unlock on iOS
        const o = ac.createOscillator();
        const g = ac.createGain();
        g.gain.value = 0.0001;
        o.connect(g); g.connect(ac.destination);
        o.start(); o.stop(ac.currentTime + 0.02);
      }
      if (!window._restChimeAudio) window._restChimeAudio = _buildChimeAudioEl();
      // Touch the <audio> element so iOS registers it as "user-initiated"
      const a = window._restChimeAudio;
      a.volume = 0;
      const p = a.play();
      if (p && p.then) p.then(()=>{ a.pause(); a.currentTime = 0; a.volume = 1.0; }).catch(()=>{});
    } catch(e){}
  };
  ['touchstart','click','keydown'].forEach(ev => document.addEventListener(ev, prime, { once:false, passive:true }));
})();

// ── Finish workout ──
// A pending (debounced) cloud push of the live session must be cancelled whenever the
// session ends — otherwise it could re-upload a stale in-progress copy after we delete it.
function _woCancelPush(key){
  if(_woPushTimers[key]){clearTimeout(_woPushTimers[key].t);delete _woPushTimers[key];}
}
function _woClearLiveSession(){
  _woCancelPush(WO_KEY);
  localStorage.removeItem(WO_KEY);
  if(typeof cloudDelete==='function')cloudDelete(WO_KEY);
}

function discardWorkout(){
  if(_woTimerInt)clearInterval(_woTimerInt);
  if(_woRestInt)clearInterval(_woRestInt);
  _restTimerState.active=false;
  woRestHide();woWakeOff();
  _currentSuggestion=null;
  _woSession=null;_woPlan=null;
  _woClearLiveSession();
  gv('wo-active-view').style.display='none';
  gv('wo-generate-view').style.display='block';
  woSessionChrome(false);
  const prev=gv('wo-plan-preview');if(prev)prev.style.display='none';
  renderWorkoutPage();
}

async function finishWorkout(){
  if(!_woSession)return;
  // Saving an empty session would advance the split rotation for nothing — offer to discard instead.
  if(!_woSession.exercises.some(ex=>ex.sets.some(s=>s.done))){
    if(await woConfirm('Nothing logged yet','Discard this workout instead of saving it?','Discard workout',true))discardWorkout();
    return;
  }
  const unlogged=_woSession.exercises.reduce((a,ex)=>a+ex.sets.filter(s=>!s.done).length,0);
  if(unlogged&&!(await woConfirm('Finish workout?',`${unlogged} set${unlogged>1?'s are':' is'} not logged and won’t be saved.`,'Finish')))return;
  if(_woTimerInt)clearInterval(_woTimerInt);
  if(_woRestInt)clearInterval(_woRestInt);
  _restTimerState.active=false;
  woRestHide();woWakeOff();
  _woSession.inProgress=false;
  _woSession.endTime=Date.now();
  const durMins=Math.round((_woSession.endTime-_woSession.startTime)/60000);
  _woSession.duration=durMins;

  // Calculate total volume
  let vol=0;
  _woSession.exercises.forEach(ex=>{
    ex.sets.forEach(s=>{
      if(s.weight&&s.reps&&s.done)vol+=parseFloat(s.weight)*parseInt(s.reps);
    });
  });
  _woSession.totalVolume=Math.round(vol);

  // Show strain rating BEFORE saving to history
  showStrainRating(_woSession);
}

// History keeps what happened, not how it was planned: drops the plan copy, the
// alternatives list and per-set target placeholders (roughly halves each session's size).
function woCompactSession(session){
  const c={...session};
  delete c.plan;
  c.exercises=(session.exercises||[]).map(ex=>{
    const {alternatives,targets,warmup,collapsed,lastText,techNote,...rest}=ex;
    return {...rest,sets:ex.sets.map(({tw,tr,...r})=>r)};
  });
  return c;
}

function showStrainRating(session) {
  // Estimate strain based on duration and volume (user-adjustable)
  const estStrain = Math.min(21, Math.max(5, Math.round(session.duration / 5 + (session.totalVolume / 5000))));

  const html = `<div class="wo-strain-modal" id="wo-strain-modal">
    <div class="wo-strain-inner">
      <div class="wo-strain-title">Rate Your Workout Strain</div>
      <div class="wo-strain-sub">How hard did this feel overall? (WHOOP scale 1-21)<br><span style="color:var(--text-3);font-size:11px">Log the strain & calories from your Whoop later under Activities.</span></div>
      <div class="wo-strain-value" id="strain-value">${estStrain}</div>
      <input type="range" class="wo-strain-slider" id="strain-slider" min="1" max="21" value="${estStrain}"
        oninput="document.getElementById('strain-value').textContent=this.value">
      <div class="wo-strain-labels">
        <span>Light</span><span>Moderate</span><span>Hard</span><span>All Out</span>
      </div>
      <div class="wo-strain-zones">
        <span class="zone z1">1-9</span>
        <span class="zone z2">10-13</span>
        <span class="zone z3">14-17</span>
        <span class="zone z4">18-21</span>
      </div>
      <button class="wo-strain-save" onclick="saveStrainAndFinish()">Save & Complete</button>
    </div>
  </div>`;

  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstElementChild);

  window._pendingSession = session;
}

function saveStrainAndFinish() {
  const session = window._pendingSession;
  if (!session) return;

  const strain = parseInt(document.getElementById('strain-slider')?.value) || 10;
  session.strain = strain;

  // Save workout strain to WHOOP logs (legacy — kept for backwards compat)
  const whoopLogsKey = `${KEY}_whoopLogs_${todayKey()}`;
  const logs = load(whoopLogsKey, { recovery: whoopSnaps[0]?.recovery || null, workouts: [] });
  logs.workouts.push({
    time: new Date().toISOString(),
    type: session.splitName,
    strain: strain,
    duration: session.duration,
    volume: session.totalVolume
  });
  save(whoopLogsKey, logs);

  // Save to history (copy — the cached array is shared and must stay read-only)
  const hist = woHistory().slice();
  hist.push(woCompactSession(session));
  woSave(WO_HIST_KEY, hist);
  // Clear the active session locally AND in the cloud. Without the cloud
  // delete, the finished session survived on the server and cloudPull restored
  // it on the next load — the ended workout came back as still in-progress.
  _woClearLiveSession();

  // Remove strain modal
  const strainModal = gv('wo-strain-modal');
  if (strainModal) strainModal.remove();

  // Show summary
  showWorkoutSummary(session);
  _woSession = null;
  _woPlan = null;
  window._pendingSession = null;
}

function showWorkoutSummary(session){
  // PB highlights: only records actually broken in THIS session (previously every
  // exercise that had any PB at all was listed, whenever it was set).
  const pbHtml=(session.pbHits||[]).map(h=>
    `<div class="wo-sum-pb"><span class="wo-sum-pb-ico">${woIco('trophy')}</span><span class="wo-sum-pb-txt"><b>${escapeHtml(h.name)}</b><span class="mono">${h.weight}kg × ${h.reps} · 1RM ${h.oneRM}kg</span></span><span class="wo-sum-pb-up mono">+${Math.round((h.oneRM-h.prevOneRM)*10)/10}</span></div>`
  ).join('');
  const setsDone=(session.exercises||[]).reduce((a,ex)=>a+ex.sets.filter(s=>s.done).length,0);

  const strainColor = session.strain >= 18 ? 'var(--bad)' : session.strain >= 14 ? 'var(--brand-text)' : session.strain >= 10 ? 'var(--warn)' : 'var(--ok)';
  const dur = session.duration>0 ? session.duration : '<1';
  const dateStr = new Date(session.date||Date.now()).toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});

  const html=`<div class="wo-summary-modal" id="wo-sum-modal">
    <div class="wo-sum-inner">
      <div class="wo-sum-badge">${woIco('check')}</div>
      <div class="wo-sum-title">Workout complete</div>
      <div class="wo-sum-split">${escapeHtml(session.splitName||'')}<span class="wo-dot-sep"> · </span>${dateStr}</div>
      <div class="wo-sum-stats">
        <div class="wo-ss" style="--i:0"><div class="wo-ss-v">${dur}</div><div class="wo-ss-l">Minutes</div></div>
        <div class="wo-ss" style="--i:1"><div class="wo-ss-v">${setsDone}</div><div class="wo-ss-l">Sets</div></div>
        <div class="wo-ss" style="--i:2"><div class="wo-ss-v">${(session.totalVolume||0).toLocaleString()}</div><div class="wo-ss-l">kg volume</div></div>
        <div class="wo-ss" style="--i:3"><div class="wo-ss-v" style="color:${strainColor}">${session.strain || '—'}</div><div class="wo-ss-l">Strain</div></div>
      </div>
      <div class="wo-sum-muscles">${(session.muscleGroups||[]).map(m=>`<span class="wo-muscle-chip">${escapeHtml(m)}</span>`).join('')}</div>
      ${pbHtml?`<div class="wo-sum-pbs"><div class="wo-eyebrow">New personal bests</div>${pbHtml}</div>`:''}
      <button class="wo-sum-close" onclick="closeWorkoutSummary()">Done</button>
      <button class="wo-sum-save-routine" onclick="saveAsRoutine()">${woIco('bookmark')}<span>Save as routine</span></button>
    </div>
  </div>`;

  const wrap=document.createElement('div');
  wrap.innerHTML=html;
  document.body.appendChild(wrap.firstElementChild);
}

function closeWorkoutSummary(){
  const el=gv('wo-sum-modal');
  if(el)el.remove();
  gv('wo-active-view').style.display='none';
  gv('wo-generate-view').style.display='block';
  woSessionChrome(false);
  window.scrollTo(0,0);
  renderLastSession();
  renderWorkoutPage();
}

const WO_ROUTINES_KEY=`${KEY}_routines`;
function saveAsRoutine(){
  const session=woHistory().slice(-1)[0];
  if(!session){woToast('No session found');return;}
  woPromptRoutineName(session);
}
async function woPromptRoutineName(session){
  const name=await woPrompt('Name this routine',session.splitName||'My routine','Save');
  if(!name||!name.trim())return;
  const routines=load(WO_ROUTINES_KEY,[]);
  const c=session.cardio;
  routines.push({
    id:Date.now().toString(36),
    name:name.trim(),
    splitName:session.splitName||'',
    splitCategory:session.splitCategory||null,
    muscleGroups:session.muscleGroups||[],
    // `sets` is a COUNT. (It used to be the logged-sets array, so a loaded routine had 0 sets.)
    exercises:(session.exercises||[]).map(ex=>({
      name:ex.swappedTo||ex.name,
      sets:Array.isArray(ex.sets)?ex.sets.length:(parseInt(ex.sets)||3),
      reps:ex.reps||'',rest:ex.rest||90,cue:ex.cue||'',icon:ex.icon,
      intensityTechnique:ex.intensityTechnique||'straight sets',
    })),
    cardio:(c&&c.machine)?{machine:c.machine,key:c.key,iconSlug:c.iconSlug,duration:c.duration,specs:c.specs,speed:c.speed,unit:c.unit,incline:c.incline,rationale:c.rationale}:null,
    savedAt:new Date().toISOString()
  });
  save(WO_ROUTINES_KEY,routines);
  const btn=document.querySelector('.wo-sum-save-routine');
  if(btn){btn.innerHTML=`${woIco('check')}<span>Saved to routines</span>`;btn.disabled=true;btn.classList.add('saved');}woHaptic(10);
}

function showRoutinesModal(){
  const routines=load(WO_ROUTINES_KEY,[]);
  const rows=routines.length
    ?[...routines].reverse().map(r=>`
        <div class="wo-routine-row" onclick="loadRoutine('${escapeAttr(r.id)}')">
          <div class="wo-routine-main">
            <div class="wo-routine-name">${escapeHtml(r.name)}</div>
            <div class="wo-routine-split">${escapeHtml(r.splitName||'')}<span class="wo-dot-sep"> · </span><span class="mono">${(r.exercises||[]).length}</span> exercises</div>
            <div class="wo-routine-chips">${(r.muscleGroups||[]).map(m=>`<span class="wo-muscle-chip">${escapeHtml(m)}</span>`).join('')}</div>
          </div>
          <span class="wo-routine-go">${woIco('play')}</span>
        </div>`).join('')
    :`<div class="wo-hist-empty"><span class="wo-hist-empty-ico">${woIco('bookmark')}</span><b>No saved routines</b><span>Finish a workout and tap “Save as routine” to reuse it here.</span></div>`;
  const modal=document.createElement('div');
  modal.id='wo-routines-modal';
  modal.className='wo-hist-modal';
  modal.innerHTML=`
    <div class="wo-hist-inner">
      <div class="wo-hist-topbar">
        <div class="wo-hist-title">Routines</div>
        <button class="wo-hist-close" onclick="document.getElementById('wo-routines-modal').remove()" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      </div>
      <div class="wo-hist-content-scroll">${rows}</div>
    </div>`;
  document.body.appendChild(modal);
}

function loadRoutine(id){
  const r=load(WO_ROUTINES_KEY,[]).find(x=>x.id===id);
  if(!r)return;
  const hist=woHistory(),now=Date.now();
  const exercises=(r.exercises||[]).map(rx=>{
    // legacy routines stored the logged-sets array in `sets`
    const sets=Array.isArray(rx.sets)?rx.sets.length:(parseInt(rx.sets)||3);
    const lib=WoEngine.byName(rx.name);
    const t=WoEngine.targetsFor(rx.name,{history:hist,now,sets,reps:rx.reps});
    return {
      name:rx.name,sets,reps:rx.reps||'8-12',rest:rx.rest||90,
      cue:rx.cue||(lib?lib.cue:getExerciseCue(rx.name)),icon:rx.icon,
      unit:lib?lib.unit:'reps',bw:lib?lib.bw:false,
      intensityTechnique:rx.intensityTechnique||'straight sets',
      targets:t?t.targets:null,lastText:t?t.lastText:'',isNew:t?t.isNew:false,progression:t?t.kind:null,
      alternatives:[],
    };
  });
  _woPlan={
    splitName:r.splitName,
    splitCategory:r.splitCategory||null,
    muscleGroups:r.muscleGroups||[],
    coachNote:'Loaded from saved routine — targets refreshed from your history.',
    exercises,
    cardio:(r.cardio&&r.cardio.machine)?r.cardio:null   // very old routines stored a different cardio shape
  };
  const m=gv('wo-routines-modal');if(m)m.remove();
  renderWorkoutPreview(true);
}

// ══════════════════════════════════════════════════════════════════════════
// WORKOUT HISTORY + PROGRESSION
// ══════════════════════════════════════════════════════════════════════════
function showWorkoutHistory(){
  _woHistMode=true;
  _woHistPage='list';
  const modal=document.createElement('div');
  modal.id='wo-hist-modal';
  modal.className='wo-hist-modal';
  modal.innerHTML=`
    <div class="wo-hist-inner">
      <div class="wo-hist-topbar">
        <button class="wo-hist-back" id="wo-hist-back-btn" onclick="woHistBack()" style="display:none" aria-label="Back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg></button>
        <div class="wo-hist-title" id="wo-hist-title">History</div>
        <button class="wo-hist-close" onclick="closeWorkoutHistory()" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      </div>
      <div id="wo-hist-content"></div>
    </div>`;
  document.body.appendChild(modal);
  renderHistoryList();
}

function closeWorkoutHistory(){
  const el=gv('wo-hist-modal');if(el)el.remove();
  _woHistDirect=false;_woHistDetail=null;
  _woHistMode=false;
  _woHistLimit=30;
}

function woHistBack(){
  if(_woHistPage==='exercise'&&(_woHistDirect||!_woHistDetail)){closeWorkoutHistory();return;}
  if(_woHistPage==='detail'){_woHistPage='list';renderHistoryList();}
  else if(_woHistPage==='exercise'){_woHistPage='detail';renderHistoryDetail(_woHistDetail);}
  gv('wo-hist-back-btn').style.display=_woHistPage==='list'?'none':'block';
}

let _woHistLimit=30;
function renderHistoryList(){
  const el=gv('wo-hist-content');if(!el)return;
  const all=woHistory();                        // shared cached array — read only
  const titleEl=gv('wo-hist-title');if(titleEl)titleEl.textContent='History';
  const backBtn=gv('wo-hist-back-btn');if(backBtn)backBtn.style.display='none';

  if(!all.length){
    el.innerHTML=`<div class="wo-hist-empty"><span class="wo-hist-empty-ico">${woIco('dumbbell')}</span><b>No workouts yet</b><span>Generate a session on the Train tab — it'll show up here when you finish.</span></div>`;
    return;
  }

  // Newest first, paged. Rows carry an index, not a copy of the whole session in an attribute.
  const shown=Math.min(_woHistLimit,all.length);
  let html='';
  for(let k=0;k<shown;k++){
    const idx=all.length-1-k;
    const s=all[idx];
    const date=new Date(s.date).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
    html+=`<div class="wo-hist-row" onclick="openHistSession(${idx})">
      <div class="wo-hr-left">
        <div class="wo-hr-split">${escapeHtml(s.splitName||'Workout')}</div>
        <div class="wo-hr-date">${date}</div>
        <div class="wo-hr-muscles">${(s.muscleGroups||[]).map(m=>`<span class="wo-muscle-chip">${escapeHtml(m)}</span>`).join('')}</div>
      </div>
      <div class="wo-hr-right">
        <div class="wo-hr-vol mono">${s.totalVolume?.toLocaleString()||'—'}<span class="wo-hr-unit">kg</span></div>
        <div class="wo-hr-dur mono">${s.duration>0?s.duration:'<1'} min</div>
      </div>
    </div>`;
  }
  if(shown<all.length)html+=`<button class="wo-hist-more" onclick="woHistMore()">Show older (${all.length-shown} more)</button>`;
  el.innerHTML=html;
}
function woHistMore(){_woHistLimit+=30;renderHistoryList();}
function openHistSession(idx){const s=woHistory()[idx];if(s)renderHistoryDetail(s);}

function renderHistoryDetail(session){
  if(typeof session==='string'){try{session=JSON.parse(session);}catch{return;}}
  _woHistDetail=session;
  _woHistPage='detail';
  const el=gv('wo-hist-content');if(!el)return;
  const backBtn=gv('wo-hist-back-btn');if(backBtn)backBtn.style.display='block';
  const titleEl=gv('wo-hist-title');if(titleEl)titleEl.textContent=session.splitName||'Session';
  const date=new Date(session.date).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});

  const exHtml=(session.exercises||[]).map(ex=>{
    const name=ex.swappedTo||ex.name;
    const doneSets=ex.sets.filter(s=>s.done&&s.weight&&s.reps);
    const bestSet=doneSets.reduce((b,s)=>epley(parseFloat(s.weight),parseInt(s.reps))>epley(parseFloat(b.weight||0),parseInt(b.reps||1))?s:b,doneSets[0]);
    return `<div class="wo-det-ex" onclick="renderExerciseProgression('${name.replace(/'/g,"\\'")}')">
      <div class="wo-det-ex-top">
        <div class="wo-det-ex-name">${getExIcon(name, ex.iconSlug)} ${escapeHtml(name)}</div>
        <div class="wo-det-ex-arrow">›</div>
      </div>
      <div class="wo-det-sets">
        ${doneSets.map(s=>`<span class="wo-det-set">${s.weight}kg×${s.reps}</span>`).join('')}
      </div>
      ${bestSet?`<div class="wo-det-1rm">Best 1RM: <strong>${epley(parseFloat(bestSet.weight),parseInt(bestSet.reps))}kg</strong></div>`:''}
    </div>`;
  }).join('');

  el.innerHTML=`<div class="wo-det-header">
    <div class="wo-det-date">${date}</div>
    <div class="wo-det-stats">
      <span><b class="mono">${session.duration>0?session.duration:(session.duration===0?'<1':'—')}</b> min</span>
      <span><b class="mono">${session.totalVolume?.toLocaleString()||'—'}</b> kg</span>
    </div>
    <div class="wo-det-muscles">${(session.muscleGroups||[]).map(m=>`<span class="wo-muscle-chip">${m}</span>`).join('')}</div>
  </div>
  <div class="wo-det-ex-list">
    <div class="wo-det-section-lbl">Exercises · tap for progress</div>
    ${exHtml}
  </div>`;
}

let _woProgMetric='e1rm';
function setProgMetric(m){_woProgMetric=m;if(_woHistExName)renderExerciseProgression(_woHistExName);}

// One point per session: best estimated 1RM, heaviest weight, total volume.
function woExerciseSeries(exName){
  const out=[];
  woHistory().forEach(session=>{
    (session.exercises||[]).forEach(ex=>{
      const name=ex.swappedTo||ex.name;
      if(WoEngine.canon(name)!==WoEngine.canon(exName))return;
      const sets=(ex.sets||[]).filter(s=>s.done&&s.reps!==''&&s.reps!=null);
      if(!sets.length)return;
      let best=null,heavy=0,vol=0,reps=0;
      sets.forEach(s=>{
        const w=parseFloat(s.weight)||0,r=parseInt(s.reps)||0;
        reps+=r;vol+=w*r;heavy=Math.max(heavy,w);
        const e=w>0&&r>0?epley(w,r):0;
        if(!best||e>best.e)best={e,w,r};
      });
      out.push({date:session.date,e1rm:best.e,heavy,vol:Math.round(vol),reps,bestW:best.w,bestR:best.r,sets});
    });
  });
  return out;
}

function woChartSvg(points,key,unit){
  const W=340,H=170,L=8,R=44,T=14,B=26;
  const vals=points.map(p=>p[key]);
  let lo=Math.min(...vals),hi=Math.max(...vals);
  if(lo===hi){lo=lo*0.9;hi=hi*1.1||1;}
  const padv=(hi-lo)*0.12;lo=Math.max(0,lo-padv);hi=hi+padv;
  const n=points.length;
  const x=i=>n===1?(L+(W-L-R)/2):L+(i/(n-1))*(W-L-R);
  const y=v=>T+(1-(v-lo)/(hi-lo))*(H-T-B);
  const fmt=v=>v>=1000?(Math.round(v/100)/10)+'k':String(Math.round(v*10)/10);
  const grid=[0,0.5,1].map(f=>{const v=lo+(hi-lo)*(1-f);const yy=T+f*(H-T-B);
    return `<line x1="${L}" x2="${W-R}" y1="${yy}" y2="${yy}" class="ch-grid"/><text x="${W-R+6}" y="${yy+4}" class="ch-ylab">${fmt(v)}</text>`;}).join('');
  const pts=points.map((p,i)=>`${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`);
  const area=n>1?`<path class="ch-area" d="M${x(0)},${H-B} L${pts.join(' L')} L${x(n-1)},${H-B} Z"/>`:'';
  const line=n>1?`<polyline class="ch-line" points="${pts.join(' ')}"/>`:'';
  const dots=points.map((p,i)=>`<circle class="ch-dot${i===n-1?' last':''}" cx="${x(i)}" cy="${y(p[key])}" r="${i===n-1?4.5:3}"><title>${fmt(p[key])} ${unit}</title></circle>`).join('');
  const d0=new Date(points[0].date).toLocaleDateString('en-US',{month:'short',day:'numeric'});
  const d1=new Date(points[n-1].date).toLocaleDateString('en-US',{month:'short',day:'numeric'});
  const xl=n>1?`<text x="${L}" y="${H-6}" class="ch-xlab">${d0}</text><text x="${W-R}" y="${H-6}" class="ch-xlab" text-anchor="end">${d1}</text>`
             :`<text x="${x(0)}" y="${H-6}" class="ch-xlab" text-anchor="middle">${d1}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" class="wo-prog-chart" role="img" aria-label="${unit} over time">${grid}${area}${line}${dots}${xl}</svg>`;
}

function renderExerciseProgression(exName){
  _woHistPage='exercise';
  _woHistExName=exName;
  const el=gv('wo-hist-content');if(!el)return;
  const backBtn=gv('wo-hist-back-btn');if(backBtn)backBtn.style.display='block';
  const titleEl=gv('wo-hist-title');if(titleEl)titleEl.textContent=exName;

  const pts=woExerciseSeries(exName);
  const lib=WoEngine.byName(exName);
  const timed=lib&&lib.unit==='sec';
  const loaded=pts.some(p=>p.heavy>0);
  const metrics=loaded&&!timed
    ?[['e1rm','Est. 1RM','kg'],['heavy','Heaviest','kg'],['vol','Volume','kg']]
    :[['reps','Total '+(timed?'seconds':'reps'),timed?'s':'reps']];
  if(!metrics.some(m=>m[0]===_woProgMetric))_woProgMetric=metrics[0][0];
  const [mk,mlabel,munit]=metrics.find(m=>m[0]===_woProgMetric);

  if(!pts.length){
    el.innerHTML=`<div class="wo-hist-empty"><span class="wo-hist-empty-ico">${woIco('chart')}</span><b>No history yet</b><span>Log this exercise in a workout and your progress will chart here.</span></div>`;
    return;
  }
  const last=pts[pts.length-1],first=pts[0];
  const delta=pts.length>1?Math.round((last[mk]-first[mk])*10)/10:null;
  const bestE=pts.reduce((b,p)=>p.e1rm>b.e1rm?p:b,pts[0]);
  const heaviest=pts.reduce((b,p)=>p.heavy>b.heavy?p:b,pts[0]);
  const bestVol=pts.reduce((b,p)=>p.vol>b.vol?p:b,pts[0]);
  const totalVol=pts.reduce((a,p)=>a+p.vol,0);
  const dfmt=d=>new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric'});
  const rec=(label,val,sub)=>`<div class="wo-rec"><div class="wo-rec-l">${label}</div><div class="wo-rec-v tnum">${val}</div>${sub?`<div class="wo-rec-s">${sub}</div>`:''}</div>`;

  const histRows=pts.slice().reverse().map(d=>`<div class="wo-prog-row">
      <div class="wo-prog-date">${dfmt(d.date)}</div>
      <div class="wo-prog-sets tnum">${d.sets.map(s=>timed?`${s.reps}s`:(parseFloat(s.weight)>0?`${s.weight}×${s.reps}`:`BW×${s.reps}`)).join('  ')}</div>
      <div class="wo-prog-1rm tnum">${loaded&&!timed?d.e1rm+' kg':''}</div>
    </div>`).join('');

  el.innerHTML=`
    <div class="wo-prog-top">
      ${metrics.length>1?`<div class="wo-seg wo-seg-sm" role="group" aria-label="Chart metric">${metrics.map(m=>`<button class="wo-seg-btn${m[0]===mk?' sel':''}" onclick="setProgMetric('${m[0]}')">${m[1]}</button>`).join('')}</div>`:''}
      <div class="wo-prog-head">
        <div class="wo-prog-big tnum">${Math.round(last[mk]*10)/10}<small> ${munit}</small></div>
        <div class="wo-prog-delta ${delta>0?'up':delta<0?'down':''}">${delta==null?'1 session logged — one more to see a trend':`${delta>0?'+':''}${delta} ${munit} since ${dfmt(first.date)}`}</div>
      </div>
      ${woChartSvg(pts,mk,munit)}
    </div>
    <h2 class="wo-section-title">Records</h2>
    <div class="wo-recs">
      ${loaded&&!timed?rec('Best est. 1RM',bestE.e1rm+' kg',`${bestE.bestW} kg × ${bestE.bestR} · ${dfmt(bestE.date)}`):''}
      ${loaded&&!timed?rec('Heaviest weight',heaviest.heavy+' kg',dfmt(heaviest.date)):''}
      ${loaded&&!timed?rec('Best session volume',bestVol.vol.toLocaleString()+' kg',dfmt(bestVol.date)):''}
      ${rec('Sessions',pts.length,loaded&&!timed?`${Math.round(totalVol).toLocaleString()} kg lifted in total`:'')}
    </div>
    <h2 class="wo-section-title">History</h2>
    <div class="wo-group wo-prog-history">${histRows}</div>`;
}

// ── Weekly/Calendar merge: toggle inside weekly page ──
let _weeklyTab='weekly';
function switchWeeklyTab(tab){
  _weeklyTab=tab;
  gv('wk-tab-weekly').classList.toggle('active',tab==='weekly');
  gv('wk-tab-calendar').classList.toggle('active',tab==='calendar');
  gv('wk-tab-stats').classList.toggle('active',tab==='stats');
  gv('wk-tab-content-weekly').style.display=tab==='weekly'?'block':'none';
  gv('wk-tab-content-calendar').style.display=tab==='calendar'?'block':'none';
  gv('wk-tab-content-stats').style.display=tab==='stats'?'block':'none';
  if(tab==='calendar')buildCalendar();
  if(tab==='weekly'||tab==='stats')renderProgressPage();
}

// ══════════════════════════════════════════════════════════════════════════
// WEEKLY AI PATTERN SUMMARY
// ══════════════════════════════════════════════════════════════════════════
async function generateWeeklySummary(weekK){
  const card=gv('weekly-ai-summary');
  if(!card)return;
  const btn=card.querySelector('.wk-ai-btn');
  const responseEl=gv('wk-ai-response');
  if(btn){btn.disabled=true;btn.textContent='Analyzing...';}
  if(responseEl){responseEl.innerHTML='<div class="wk-ai-loading">Analyzing your week...</div>';}

  // Gather 7-day data
  const days=getWeekData();
  const tgt=getCalTarget();
  const woSessions=load(`${KEY}_wo_history`,[]);
  const weekDayKeys=new Set(days.map(d=>d.key));
  const weekWo=woSessions.filter(s=>weekDayKeys.has((s.date||'').slice(0,10)));

  const dayLines=days.map(d=>{
    if(!d.hasData&&!d.isToday)return `${d.label}: no data`;
    const hit=d.t.cal>=tgt*0.8&&d.t.cal<=tgt*1.15?'✓':'✗';
    const wo=weekWo.filter(s=>(s.date||'').slice(0,10)===d.key).map(s=>s.splitName||'workout').join(', ');
    return `${d.label}: ${Math.round(d.t.cal)}kcal, ${Math.round(d.t.p)}g P, target ${hit}${wo?`, wo: ${wo}`:''}`;
  }).join('\n');

  const userMsg=`Week ${weekK}. Daily target: ${tgt}kcal.\n${dayLines}`;

  try{
    const data=await callAI({
      model:'claude-sonnet-4-6',
      max_tokens:120,
      system:"You are a concise performance coach. Analyse this week's data and give 2-3 bullet observations about patterns — e.g. consistently under on protein, stronger workout days after better sleep, calories spiking on weekends. Be specific, use the actual numbers, max 60 words total.",
      messages:[{role:'user',content:userMsg}]
    });
    const text=aiText(data).trim();
    localStorage.setItem(`${KEY}_weekly_ai_${weekK}`,text);
    if(responseEl)responseEl.innerHTML=md(text);
    if(btn){btn.disabled=false;btn.textContent='↺ Refresh';}
  }catch(e){
    console.error('[reBorn] Weekly summary error:', e);
    if(btn){btn.disabled=false;btn.textContent='Try Again';}
    if(responseEl)responseEl.innerHTML=`<div style="color:var(--red)">${_apiErrMsg(e)}</div>`;
  }
}


// ══════════════════════════════════════════════════════
// FASTING MODULE (state vars declared at top of file)
// ══════════════════════════════════════════════════════

// Resume fasting timer if a fast was active on last session
if(fastState&&!fastState.end)_startFastTimer();
setTimeout(()=>_updateFastNavIndicator(),200);

function getFastTargetHours(){
  return fastProtocol==='custom'?(fastCustomHrs||16):(FAST_PROTO_HRS[fastProtocol]||16);
}

function selectFastProtocol(proto,btn){
  fastProtocol=proto;
  document.querySelectorAll('.fast-proto-btn').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
  const cr=gv('fast-custom-row');
  if(cr)cr.style.display=proto==='custom'?'block':'none';
  _updateFastIdleDisplay();
}

function updateCustomFastProtocol(){
  fastCustomHrs=parseInt(gv('fast-custom-h')?.value||0)||0;
  _updateFastIdleDisplay();
}

function _updateFastIdleDisplay(){
  const el=gv('fast-proto-display');
  if(el)el.textContent=getFastTargetHours()+' hours';
}

function getFastPhase(elapsedHours){
  let phase=FAST_PHASES[0];
  for(const p of FAST_PHASES){if(elapsedHours>=p.hours)phase=p;else break;}
  return phase;
}

function toggleFast(){
  if(fastState&&!fastState.end)endFast();
  else startFast();
}

function startFast(){
  fastState={start:new Date().toISOString(),protocol:fastProtocol,targetHours:getFastTargetHours(),end:null};
  save(FAST_STATE_KEY,fastState);
  _startFastTimer();
  renderFastPage();
  renderWorkoutFastBanner();
  _updateFastNavIndicator();
}

function endFast(){
  if(!fastState)return;
  fastState.end=new Date().toISOString();
  const actualHours=(new Date(fastState.end)-new Date(fastState.start))/3600000;
  fastLog.unshift({start:fastState.start,end:fastState.end,protocol:fastState.protocol,targetHours:fastState.targetHours,actualHours:Math.round(actualHours*10)/10});
  save(FAST_LOG_KEY,fastLog);
  _stopFastTimer();
  fastState=null;
  save(FAST_STATE_KEY,null);
  renderFastPage();
  renderWorkoutFastBanner();
  _updateFastNavIndicator();
}

function _startFastTimer(){
  _stopFastTimer();
  fastTimer=setInterval(_tickFastTimer,1000);
  _tickFastTimer();
}
function _stopFastTimer(){if(fastTimer){clearInterval(fastTimer);fastTimer=null;}}

function _tickFastTimer(){
  if(!fastState||fastState.end){_stopFastTimer();return;}
  const now=new Date();
  const elapsedMs=now-new Date(fastState.start);
  const elapsedSec=Math.floor(elapsedMs/1000);
  const elapsedHours=elapsedMs/3600000;
  const targetMs=fastState.targetHours*3600000;
  const remainingMs=Math.max(0,targetMs-elapsedMs);
  const pct=Math.min(100,(elapsedMs/targetMs)*100);

  // Elapsed timer HH:MM:SS
  const h=Math.floor(elapsedSec/3600),m=Math.floor((elapsedSec%3600)/60),s=elapsedSec%60;
  const timerStr=`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  const etEl=gv('fast-elapsed-timer');if(etEl)etEl.textContent=timerStr;
  const pctEl=gv('fast-pct-label');if(pctEl)pctEl.textContent=`ELAPSED (${Math.round(pct)}%)`;

  // Ring arc
  const arc=gv('fast-ring-arc');
  if(arc)arc.style.strokeDashoffset=String(FAST_CIRC*(1-pct/100));

  // Phase
  const pl=gv('fast-phase-label');if(pl)pl.textContent=getFastPhase(elapsedHours).name.toUpperCase();
  const pn=gv('fast-phase-name');if(pn)pn.textContent=getFastPhase(elapsedHours).name;
  const pd=gv('fast-phase-desc');if(pd)pd.textContent=getFastPhase(elapsedHours).desc;
  const pi=gv('fast-phase-icon');if(pi)pi.textContent=getFastPhase(elapsedHours).icon;

  // Remaining
  const remH=Math.floor(remainingMs/3600000),remM=Math.floor((remainingMs%3600000)/60000);
  const remEl=gv('fast-remaining-timer');if(remEl)remEl.textContent=`${remH}h ${String(remM).padStart(2,'0')}m`;

  // Phase dots
  const dotsEl=gv('fast-phase-dots');
  if(dotsEl){
    dotsEl.innerHTML=FAST_PHASES.map(p=>{
      const done=elapsedHours>=p.hours+4;
      const curr=!done&&elapsedHours>=p.hours;
      return`<div class="fast-phase-dot${done?' done':curr?' current':''}"></div>`;
    }).join('');
  }
}

function renderFastPage(){
  const isActive=fastState&&!fastState.end;
  const ps=gv('fast-protocol-section');if(ps)ps.style.display=isActive?'none':'block';
  const idle=gv('fast-idle-content'),actc=gv('fast-active-content');
  if(idle)idle.style.display=isActive?'none':'block';
  if(actc)actc.style.display=isActive?'block':'none';
  const arc=gv('fast-ring-arc');
  if(arc){arc.classList.toggle('fasting',!!isActive);if(!isActive)arc.style.strokeDashoffset=String(FAST_CIRC);}
  const ai=gv('fast-active-info');if(ai)ai.style.display=isActive?'block':'none';
  const btn=gv('fast-main-btn');
  if(btn){btn.textContent=isActive?'End Fast':'Start Fasting';btn.classList.toggle('ending',!!isActive);}
  if(isActive&&fastState){
    const startDt=new Date(fastState.start);
    const endDt=new Date(startDt.getTime()+fastState.targetHours*3600000);
    const fmt=d=>d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})+', '+d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
    const sl=gv('fast-start-lbl');if(sl)sl.textContent=fmt(startDt);
    const el=gv('fast-end-lbl');if(el)el.textContent=fmt(endDt);
    const gl=gv('fast-goal-label');if(gl)gl.textContent=fastState.targetHours+'H GOAL';
    const gd=gv('fast-goal-disp');if(gd)gd.textContent=fastState.targetHours+'h';
    _tickFastTimer();
  }
  if(!isActive)_updateFastIdleDisplay();
  const fsn=gv('fast-streak-num');if(fsn)fsn.textContent=calcStreak();
  _renderFastLog();
}

function _renderFastLog(){
  const c=gv('fast-log-list');if(!c)return;
  if(!fastLog.length){c.innerHTML='<div style="padding:0 14px 8px;font-size:13px;color:var(--muted)">No fasts logged yet — start your first fast above!</div>';return;}
  c.innerHTML=fastLog.slice(0,7).map(f=>{
    const dateStr=new Date(f.start).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
    const dur=f.actualHours!=null?`${f.actualHours}h`:`${f.targetHours}h`;
    const completed=f.actualHours>=f.targetHours;
    return`<div class="fast-log-item">
      <div class="fli-top"><span class="fli-proto">${f.protocol}${completed?' ✓':''}</span><span class="fli-date">${dateStr}</span></div>
      <div class="fli-dur">${dur}${completed?' · Goal reached! 🎉':f.actualHours!=null&&f.actualHours<f.targetHours?' · Ended early':''}</div>
    </div>`;
  }).join('');
}

function getFastContext(){
  const isActive=fastState&&!fastState.end;
  if(isActive){
    const elapsed=(new Date()-new Date(fastState.start))/3600000;
    const phase=getFastPhase(elapsed);
    return`FASTING: Currently fasting (${fastState.protocol}, ${Math.floor(elapsed)}h elapsed, goal ${fastState.targetHours}h) · Phase: ${phase.name}`;
  }
  if(fastLog.length){
    const last=fastLog[0];
    const ago=new Date(last.start).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
    return`FASTING: Last fast on ${ago} — ${last.protocol}, ${last.actualHours}h (target ${last.targetHours}h)`;
  }
  return'FASTING: No fasts logged yet';
}

async function loadFastingRecommendation(forceRefresh=false){
  const cached=localStorage.getItem(FAST_AI_KEY);
  const cacheDate=localStorage.getItem(FAST_AI_KEY+'_date');
  if(!forceRefresh&&cached&&cacheDate===todayKey()){
    const el=gv('fast-ai-content');
    if(el){el.innerHTML=md(cached);el.style.display='block';}
    return;
  }
  const loading=gv('fast-ai-loading'),content=gv('fast-ai-content');
  if(loading)loading.style.display='block';
  if(content)content.style.display='none';
  const recentFasts=fastLog.slice(0,7);
  const avgDur=recentFasts.length?(recentFasts.reduce((s,f)=>s+(f.actualHours||f.targetHours),0)/recentFasts.length).toFixed(1):'none';
  const ctx=`${getDayContext()}\n${getFastContext()}\nFasting preference: ${fastProtocol}\nAvg recent fast: ${avgDur}h over ${recentFasts.length} fasts\n${_buildCoachContext().workoutCtx}`;
  try{
    const data=await callAI({
      model:'claude-sonnet-4-6',max_tokens:450,
      system:'You are a concise intermittent fasting and nutrition coach for Borna (26M, 89.1kg, 25.1% BF, goal 20.1% BF by Apr 27 2026). Give specific, actionable fasting advice. Be brief and direct. No markdown headers, just 3-4 short paragraphs.',
      messages:[{role:'user',content:`Based on my data, recommend:\n1. Best fasting protocol (16:8, 18:6, or 20:4) for my fat loss goal and why\n2. Optimal eating window start/end times\n3. Which days this week to fast considering my workout schedule\n4. One key tip for right now\n\n${ctx}`}]
    });
    const text=aiText(data).trim();
    localStorage.setItem(FAST_AI_KEY,text);
    localStorage.setItem(FAST_AI_KEY+'_date',todayKey());
    if(content){content.innerHTML=md(text);content.style.display='block';}
  }catch(e){
    if(content){content.textContent=_apiErrMsg(e);content.style.display='block';}
  }finally{
    if(loading)loading.style.display='none';
  }
}

// Workout page: fasting status banner
function renderWorkoutFastBanner(){
  const banner=gv('wo-fast-banner');if(!banner)return;
  const isActive=fastState&&!fastState.end;
  if(isActive){
    const elapsed=(new Date()-new Date(fastState.start))/3600000;
    const phase=getFastPhase(elapsed);
    const startTime=new Date(fastState.start).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
    banner.style.display='flex';
    banner.innerHTML=`<div class="fwb-icon">${phase.icon}</div><div class="fwb-text"><div class="fwb-title">Currently fasting \u00b7 ${phase.name}</div><div class="fwb-sub">Started ${startTime} \u00b7 ${Math.floor(elapsed)}h elapsed \u00b7 ${fastState.targetHours}h goal</div></div>`;
  }else{
    banner.style.display='none';
  }
}

// Update the Fast nav button indicator dot when fasting state changes
function _updateFastNavIndicator(){
  const btn=gv('nb-fast');if(!btn)return;
  const isActive=fastState&&!fastState.end;
  let dot=btn.querySelector('.fast-nav-dot');
  if(isActive&&!dot){
    dot=document.createElement('div');
    dot.className='fast-nav-dot';
    btn.appendChild(dot);
  } else if(!isActive&&dot){
    dot.remove();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// NETWORK STATUS & OFFLINE BANNER
// ══════════════════════════════════════════════════════════════════════════════

let _offlineBanner = null;

function showOfflineBanner() {
  if (_offlineBanner) return;
  _offlineBanner = document.createElement('div');
  _offlineBanner.className = 'network-offline-banner';
  _offlineBanner.textContent = '📡 You\'re offline — AI features unavailable';
  document.body.prepend(_offlineBanner);
}

function hideOfflineBanner() {
  if (_offlineBanner) {
    _offlineBanner.remove();
    _offlineBanner = null;
  }
}

// Show/hide offline banner based on network status
window.addEventListener('offline', showOfflineBanner);
window.addEventListener('online', hideOfflineBanner);
if (!navigator.onLine) showOfflineBanner();

// ══════════════════════════════════════════════════════════════════════════════
// DEBUG HELPERS — Access via browser console
// ══════════════════════════════════════════════════════════════════════════════

// Expose debug functions globally for console access
window.reBornDebug = {
  // Get all AI logs
  getLogs: () => getAILogs(),
  
  // Get AI health status
  getHealth: () => getAIHealth(),
  
  // Manually warm up the worker
  warmup: () => warmupWorker(false),
  
  // Clear all AI state
  resetAIState: () => {
    _aiState.consecutiveErrors = 0;
    _aiState.lastErrorTime = null;
    console.log('[reBorn Debug] AI state reset');
  },
  
  // Test API connection
  testConnection: async () => {
    console.log('[reBorn Debug] Testing API connection...');
    const start = Date.now();
    try {
      await warmupWorker(false);
      console.log(`[reBorn Debug] ✅ Connection OK (${Date.now() - start}ms)`);
      return true;
    } catch (e) {
      console.log(`[reBorn Debug] ❌ Connection failed: ${e.message}`);
      return false;
    }
  },
  
  // Show full state
  showState: () => ({
    aiState: { ..._aiState, logs: `${_aiState.logs.length} entries` },
    health: getAIHealth(),
    network: checkNetworkQuality()
  })
};

console.log('%c[reBorn] AI Infrastructure v2.0 loaded', 'color: #4ade80; font-weight: bold;');
console.log('%c[reBorn] Debug: window.reBornDebug.showState()', 'color: #888;');

/* ═══════════════════════════════════════════════════════════
   THE LANTERN — companion object logic
   Append to the end of app.js
   Reads existing rb5_ state keys, writes nothing.
═══════════════════════════════════════════════════════════ */

// ── Ritual definitions — bite-sized daily goals derived from existing data ──
const LNT_RITUALS = [
  { id:'fuel',    label:'Break the fast',       test:()=>getTotals().cal > 0 },
  { id:'protein', label:'Protein on pace',      test:()=>getTotals().p >= TARGETS.p*0.6 },
  { id:'water',   label:'4+ cups of water',     test:()=>cups >= 4 },
  { id:'move',    label:'Workout logged',       test:()=>_lntWorkoutToday() },
  { id:'recovery',label:'WHOOP recorded',       test:()=>!!(whoopSnaps[0]&&whoopSnaps[0].recovery) },
  { id:'window',  label:'Stayed in the window', test:()=>_lntEatingWindowOK() },
];

function _lntWorkoutToday(){
  const hist = load(`${KEY}_wo_history`, []);
  const today = todayKey();
  return hist.some(s => s.date && s.date.slice(0,10) === today);
}

function _lntLastWorkoutMs(){
  const hist = load(`${KEY}_wo_history`, []);
  if(!hist.length) return null;
  let latest = 0;
  hist.forEach(s => {
    if(s.date){
      const t = new Date(s.date).getTime();
      if(t > latest) latest = t;
    }
  });
  return latest || null;
}

function _lntEatingWindowOK(){
  // true if no meal logged outside 10h window from first meal
  if(meals.length < 1) return true;
  const times = meals.map(m => m.loggedAt ? new Date(m.loggedAt).getTime() : null).filter(Boolean);
  if(times.length < 2) return true;
  const span = (Math.max(...times) - Math.min(...times)) / 3600000;
  return span <= 10;
}

function _lntHour(){ return new Date().getHours(); }

// ═══ STATE COMPUTATION ═══
// Returns { state, factors, rituals }
function computeLanternState(){
  const t = getTotals();
  const protPct = t.p / TARGETS.p;
  const calPct  = t.cal / getCalTarget();
  const hour    = _lntHour();
  const rec     = whoopSnaps[0]?.recovery;
  const fastActive = fastState && !fastState.end;
  const lastWoMs = _lntLastWorkoutMs();
  const hoursSinceWo = lastWoMs ? (Date.now() - lastWoMs) / 3600000 : null;
  const streak = calcStreak();

  // Factors list — each is a signal that affects the lantern
  const factors = [];

  // Protein
  if(t.p > 0){
    const pFactor = {
      icon: protPct >= 0.7 ? '🔥' : protPct >= 0.4 ? '◐' : '◯',
      tone: protPct >= 0.7 ? 'pos' : protPct >= 0.4 ? 'neu' : 'neg',
      title:'Protein',
      desc: protPct >= 0.7 ? 'Strong — core burning warm'
          : protPct >= 0.4 ? 'Building, needs more before evening'
          : 'Low — the lantern can\'t catch',
      val: Math.round(t.p)+'g'
    };
    factors.push(pFactor);
  } else {
    factors.push({ icon:'◯', tone:'neu', title:'Protein', desc:'Not yet logged today', val:'0g' });
  }

  // Calories
  if(calPct > 0){
    factors.push({
      icon: calPct > 1.1 ? '▲' : calPct >= 0.7 ? '◆' : '◇',
      tone: calPct > 1.1 ? 'neg' : calPct >= 0.7 ? 'pos' : 'neu',
      title:'Calories',
      desc: calPct > 1.1 ? 'Over target — burning through reserves'
          : calPct >= 0.7 ? 'On pace for the day'
          : 'Room to fuel',
      val: Math.round(t.cal)+' kcal'
    });
  }

  // Water
  const wTone = cups >= 6 ? 'pos' : cups >= 3 ? 'neu' : 'neg';
  factors.push({
    icon: cups >= 6 ? '◉' : cups >= 3 ? '◍' : '◌',
    tone: wTone,
    title:'Hydration',
    desc: cups >= 6 ? 'Flowing well'
        : cups >= 3 ? 'Steady — keep sipping'
        : hour >= 15 ? 'Thin — lantern is dimming' : 'Just starting',
    val: cups+' / 8'
  });

  // Workout
  if(hoursSinceWo !== null && hoursSinceWo < 24){
    factors.push({
      icon:'⚡',
      tone:'pos',
      title:'Movement',
      desc: hoursSinceWo < 4 ? 'Still glowing from your session'
          : 'Trained earlier — afterburn active',
      val: hoursSinceWo < 1 ? 'just now' : Math.round(hoursSinceWo)+'h ago'
    });
  } else {
    factors.push({
      icon:'○', tone:'neu', title:'Movement',
      desc:'No session logged today', val:'—'
    });
  }

  // WHOOP recovery
  if(rec !== undefined && rec !== null){
    factors.push({
      icon: rec >= 67 ? '●' : rec >= 34 ? '◐' : '○',
      tone: rec >= 67 ? 'pos' : rec >= 34 ? 'neu' : 'neg',
      title:'Recovery',
      desc: rec >= 67 ? 'Body is ready — push today'
          : rec >= 34 ? 'Yellow — move with care'
          : 'Red — the lantern flickers',
      val: rec+'%'
    });
  }

  // Fast
  if(fastActive){
    const startMs = new Date(fastState.start).getTime();
    const hrs = (Date.now() - startMs)/3600000;
    factors.push({
      icon:'☾', tone:'neu', title:'Fasting',
      desc: hrs >= 14 ? 'Deep in the window — lantern cooled to moon'
          : hrs >= 8  ? 'Halfway in — metabolism shifting'
          : 'Early in the fast',
      val: hrs.toFixed(1)+'h'
    });
  }

  // Streak
  if(streak >= 3){
    factors.push({
      icon:'🔥', tone:'pos', title:'Consistency',
      desc: streak >= 30 ? 'A month of keeping the flame' : streak >= 7 ? 'The routine is holding' : 'Building momentum',
      val: streak+'d'
    });
  }

  // ═══ STATE — precedence order ═══
  let state = 'still';

  if(hoursSinceWo !== null && hoursSinceWo < 4){
    state = 'kindled';
  } else if(fastActive){
    state = 'moonlit';
  } else if(rec !== undefined && rec < 34 && (meals.length === 0 || cups < 2)){
    state = 'guttering';
  } else if(
    (hour >= 15 && cups < 4) ||
    (hour >= 18 && protPct < 0.4)
  ){
    state = 'banked';
  } else if(
    protPct >= 0.7 &&
    (_lntWorkoutToday() || streak >= 7)
  ){
    state = 'ember';
  }

  // Rituals — how many done
  const rituals = LNT_RITUALS.map(r => ({ id:r.id, label:r.label, done:!!r.test() }));

  return { state, factors, rituals };
}

// ═══ CAPTION GENERATION — procedural, no AI needed ═══
function _lntCaption(s){
  const t = getTotals();
  const rec = whoopSnaps[0]?.recovery;
  const hour = _lntHour();

  const primary = {
    kindled:   'Still glowing from your session.',
    moonlit:   'Cooled to moonlight. The fast is holding.',
    guttering: 'Flickering. The lantern needs fuel.',
    banked:    hour >= 18 ? 'Dimmed through the evening.' : 'Cooling — hydration is thin.',
    ember:     'Warm since your last lift.',
    still:     meals.length === 0 ? 'Waiting for the first spark.' : 'Steady. The day is holding its shape.',
  }[s.state];

  // One small supporting line — varies by what's most "off"
  const bits = [];
  if(t.p > 0) bits.push(`Protein ${Math.round((t.p/TARGETS.p)*100)}%`);
  if(cups > 0) bits.push(`${cups} cup${cups===1?'':'s'}`);
  if(rec) bits.push(`Recovery ${rec}`);
  if(s.state === 'moonlit' && fastState){
    const hrs = ((Date.now()-new Date(fastState.start).getTime())/3600000).toFixed(1);
    bits.unshift(`${hrs}h in`);
  }
  const sub = bits.slice(0,3).join(' · ');

  return { primary, sub };
}

// ═══ ORB SVG — single component, state-driven ═══
// Returns an SVG string. Two palettes: warm (ember/kindled/still) and cool (moonlit/banked/guttering)
function _lntOrbSvg(state, size){
  size = size || 220;
  const h = Math.round(size * 0.77);
  const cx = size/2, cy = h/2;

  // Per-state palette and dims
  const cfg = {
    ember:    { haloA:'#E8A87C', haloO:0.40, coreA:'#F4C29A', coreB:'#E8A87C', core:38, hot:11, center:'#FFE8D4', ringO:0.12, haloR:78 },
    kindled:  { haloA:'#F4C29A', haloO:0.55, coreA:'#FFE8D4', coreB:'#E8A87C', core:42, hot:13, center:'#FFF5E8', ringO:0.18, haloR:88 },
    still:    { haloA:'#8FC9B5', haloO:0.28, coreA:'#B8E0CF', coreB:'#8FC9B5', core:34, hot:9,  center:'#E8F5EE', ringO:0.10, haloR:70 },
    moonlit:  { haloA:'#B8A3E4', haloO:0.32, coreA:'#D4C5F0', coreB:'#B8A3E4', core:36, hot:9,  center:'#F0E8FA', ringO:0.12, haloR:72 },
    banked:   { haloA:'#7FB0D4', haloO:0.22, coreA:'#A8C8E0', coreB:'#7FB0D4', core:30, hot:7,  center:'#D4E4F0', ringO:0.08, haloR:60 },
    guttering:{ haloA:'#E88A82', haloO:0.18, coreA:'#E8A8A2', coreB:'#B8625A', core:22, hot:5,  center:'#F0C8C4', ringO:0.06, haloR:48 },
  }[state] || { haloA:'#8FC9B5', haloO:0.28, coreA:'#B8E0CF', coreB:'#8FC9B5', core:34, hot:9, center:'#E8F5EE', ringO:0.10, haloR:70 };

  // Unique IDs so multiple orbs (home + modal) don't collide
  const uid = 'lnt_' + Math.random().toString(36).slice(2,8);

  return `
    <svg class="lnt-orb-svg lnt-${state}" width="${size}" height="${h}" viewBox="0 0 ${size} ${h}" aria-hidden="true">
      <defs>
        <radialGradient id="${uid}_halo" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="${cfg.haloA}" stop-opacity="${cfg.haloO}"/>
          <stop offset="60%" stop-color="${cfg.haloA}" stop-opacity="${cfg.haloO*0.3}"/>
          <stop offset="100%" stop-color="${cfg.haloA}" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="${uid}_core" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="${cfg.coreA}" stop-opacity="1"/>
          <stop offset="40%" stop-color="${cfg.coreB}" stop-opacity="0.9"/>
          <stop offset="100%" stop-color="${cfg.coreB}" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <circle cx="${cx}" cy="${cy}" r="${cfg.haloR}" fill="url(#${uid}_halo)"/>
      <circle cx="${cx}" cy="${cy}" r="${cfg.core+24}" fill="none" stroke="${cfg.haloA}" stroke-opacity="${cfg.ringO*0.7}" stroke-width="0.5"/>
      <circle cx="${cx}" cy="${cy}" r="${cfg.core+10}" fill="none" stroke="${cfg.haloA}" stroke-opacity="${cfg.ringO}" stroke-width="0.5"/>
      <g class="lnt-core-anim">
        <circle cx="${cx}" cy="${cy}" r="${cfg.core}" fill="url(#${uid}_core)"/>
        <circle cx="${cx}" cy="${cy}" r="${cfg.hot}" fill="${cfg.coreA}"/>
        <circle cx="${cx}" cy="${cy-2}" r="${Math.max(3,cfg.hot/2.5)}" fill="${cfg.center}"/>
      </g>
    </svg>
  `;
}

// ═══ RENDER — called from renderAll() ═══
function renderLantern(){
  const host = gv('lantern-home');
  if(!host) return;

  const s = computeLanternState();
  const cap = _lntCaption(s);

  host.className = 'lnt-section lnt-'+s.state;

  const ritualsHtml = s.rituals.map(r =>
    `<div class="lnt-ritual-dot ${r.done?'done':''}" title="${r.label}"></div>`
  ).join('');
  const doneCount = s.rituals.filter(r=>r.done).length;

  host.innerHTML = `
    <div class="lnt-head">
      <span class="lnt-kicker">THE LANTERN</span>
      <span class="lnt-state-pill">
        <span class="lnt-state-dot"></span>
        <span>${s.state.toUpperCase()}</span>
      </span>
    </div>
    <div class="lnt-orb-wrap">${_lntOrbSvg(s.state, 220)}</div>
    <div class="lnt-caption">
      ${cap.primary}
      ${cap.sub ? `<span class="lnt-caption-sub">${cap.sub}</span>` : ''}
    </div>
    <div class="lnt-rituals">
      ${ritualsHtml}
      <span class="lnt-ritual-count">${doneCount} / ${s.rituals.length} RITUALS</span>
    </div>
  `;

  // Cache for modal
  host._lntState = s;
}

// ═══ MODAL — click-through insights ═══
function openLanternModal(){
  const modal = gv('lantern-modal');
  if(!modal) return;
  const host = gv('lantern-home');
  const s = (host && host._lntState) || computeLanternState();

  const stateBlurb = {
    kindled:   'You\'ve just finished a session — the afterburn is still active and recovery is beginning.',
    ember:     'Protein is landing, your training is present in the week. The flame holds itself.',
    still:     'Nothing is wrong. Nothing is exceptional. The day is quiet.',
    moonlit:   'You\'re inside a fasting window. The lantern waits with you.',
    banked:    'Hydration is thin or protein hasn\'t caught up to the hour. The lantern is cooling.',
    guttering: 'The day is running low on inputs. The lantern needs something — water, food, or rest logged.',
  }[s.state];

  // Figure out what would push toward the next "better" state
  const tip = _lntTipForNext(s);

  const factorsHtml = s.factors.map(f => `
    <div class="lnm-factor">
      <div class="lnm-factor-icon ${f.tone}">${f.icon}</div>
      <div class="lnm-factor-body">
        <div class="lnm-factor-title">${f.title}</div>
        <div class="lnm-factor-desc">${f.desc}</div>
      </div>
      <div class="lnm-factor-val">${f.val}</div>
    </div>
  `).join('');

  const ritualsHtml = s.rituals.map(r => `
    <div class="lnm-factor">
      <div class="lnm-factor-icon ${r.done?'pos':'neu'}">${r.done?'✓':'○'}</div>
      <div class="lnm-factor-body">
        <div class="lnm-factor-title">${r.label}</div>
        <div class="lnm-factor-desc">${r.done?'Complete':'Open'}</div>
      </div>
    </div>
  `).join('');

  const tipHtml = tip ? `
    <div class="lnm-tip">
      <div class="lnm-tip-icon">✦</div>
      <div class="lnm-tip-body">${tip}</div>
    </div>` : '';

  const body = gv('lnm-body');
  body.innerHTML = `
    <div class="lnm-hero">
      <div class="lnm-hero-orb">${_lntOrbSvg(s.state, 70)}</div>
      <div class="lnm-hero-txt">
        <div class="lnm-hero-kicker">THE LANTERN IS</div>
        <div class="lnm-hero-state">${s.state[0].toUpperCase()+s.state.slice(1)}</div>
        <div class="lnm-hero-sub">${stateBlurb}</div>
      </div>
    </div>
    ${tipHtml}
    <div class="lnm-section-lbl">WHAT'S SHAPING IT</div>
    ${factorsHtml}
    <div class="lnm-section-lbl">TODAY'S RITUALS</div>
    ${ritualsHtml}
  `;

  modal.classList.add('open');
}
function closeLanternModal(){ gv('lantern-modal').classList.remove('open'); }

// Suggests the smallest input change that would warm the lantern
function _lntTipForNext(s){
  const t = getTotals();
  const rec = whoopSnaps[0]?.recovery;
  const hour = _lntHour();

  if(s.state === 'ember' || s.state === 'kindled') return null; // already there

  if(s.state === 'guttering'){
    if(t.cal === 0) return 'Log anything — even water — to get the lantern back to <strong>Still</strong>.';
    if(cups < 2) return 'Two more cups of water pulls you out of <strong>Guttering</strong>.';
    return 'Log a meal and the lantern catches again.';
  }
  if(s.state === 'moonlit'){
    const hrs = fastState ? ((Date.now()-new Date(fastState.start).getTime())/3600000) : 0;
    const target = fastState?.targetHours || 16;
    const left = Math.max(0, target - hrs);
    return left > 0
      ? `${left.toFixed(1)}h left in the window. Break it with protein to jump to <strong>Ember</strong>.`
      : 'Window complete. Break the fast with protein.';
  }
  if(s.state === 'banked'){
    if(cups < 4) return `${4-cups} more cup${4-cups===1?'':'s'} of water clears <strong>Banked</strong>.`;
    const need = Math.max(0, Math.round(TARGETS.p*0.7 - t.p));
    return `Another ${need}g of protein today pushes you to <strong>Ember</strong>.`;
  }
  if(s.state === 'still'){
    const protPct = t.p / TARGETS.p;
    if(protPct < 0.7){
      const need = Math.max(0, Math.round(TARGETS.p*0.7 - t.p));
      return `${need}g more protein and a session today → <strong>Ember</strong>.`;
    }
    if(!_lntWorkoutToday()) return 'A workout today would push you to <strong>Ember</strong>.';
    return 'You\'re close. A workout + protein = <strong>Ember</strong>.';
  }
  return null;
}

// ═══ HOOK INTO renderAll ═══
// Wrap the existing renderAll so we don't have to edit it.
(function(){
  const _prev = window.renderAll;
  window.renderAll = function(){
    _prev && _prev.apply(this, arguments);
    try { renderLantern(); } catch(e){ console.warn('[lantern]', e); }
  };
})();

// Initial render in case renderAll already fired
try { renderLantern(); } catch(e){ console.warn('[lantern init]', e); }

/* ═══════════════════════════════════════════════════════════
   HOME READINESS TILE — populates the placeholder elements
   (home-ready-pct, home-ready-arc, home-ready-verdict,
    home-weight-v, home-streak-v)
═══════════════════════════════════════════════════════════ */
function renderHomeReadiness(){
  const pctEl    = gv('home-ready-pct');
  const arcEl    = gv('home-ready-arc');
  const verdictEl= gv('home-ready-verdict');
  const wEl      = gv('home-weight-v');
  const sEl      = gv('home-streak-v');
  if(!pctEl && !wEl && !sEl) return; // tile not on page

  const rec = whoopSnaps[0]?.recovery;
  // Ring geometry matches the SVG in index.html: r=38, circ=2*PI*38 = 238.76
  const CIRC_HOME = 238.76;

  if(pctEl && arcEl){
    if(rec != null){
      const offset = CIRC_HOME - (CIRC_HOME * Math.min(rec,100) / 100);
      arcEl.style.strokeDashoffset = offset;
      const col = rec >= 67 ? 'var(--green)' : rec >= 34 ? 'var(--amber)' : 'var(--red)';
      arcEl.style.stroke = col;
      pctEl.textContent = rec;
      pctEl.style.color = col;
    } else {
      arcEl.style.strokeDashoffset = CIRC_HOME;
      pctEl.textContent = '—';
      pctEl.style.color = '';
    }
  }

  if(verdictEl){
    if(rec == null){
      verdictEl.textContent = 'Log recovery →';
    } else if(rec >= 67){
      verdictEl.textContent = 'Green day. Push the lift.';
    } else if(rec >= 50){
      verdictEl.textContent = 'Decent — moderate volume.';
    } else if(rec >= 34){
      verdictEl.textContent = 'Yellow — keep it controlled.';
    } else {
      verdictEl.textContent = 'Red — light work or rest.';
    }
  }

  // Latest weight (from entries[])
  if(wEl){
    const wEntries = entries.filter(e => e && e.weight != null);
    const latest = wEntries.length ? wEntries[wEntries.length-1].weight : null;
    wEl.textContent = latest != null ? (+latest).toFixed(1) : '—';
  }

  // Streak
  if(sEl){
    try {
      const s = calcStreak();
      sEl.textContent = s > 0 ? s + 'd' : '—';
    } catch(e){ sEl.textContent = '—'; }
  }
}

// Hook into renderAll additively — same wrapper pattern as the Lantern.
(function(){
  const _prev = window.renderAll;
  window.renderAll = function(){
    _prev && _prev.apply(this, arguments);
    try { renderHomeReadiness(); } catch(e){ console.warn('[home-readiness]', e); }
  };
})();

// Initial render in case renderAll already fired
try { renderHomeReadiness(); } catch(e){ console.warn('[home-readiness init]', e); }


/* ═══════════════════════════════════════════════════════════
   v11 rev3 — reBORN Home redesign · JS patches
   - Canvas-based particle orb (breathing glow + drifting particles)
   - Signal-driven intensity (sleep, recovery, workout, water, protein)
   - v4-style compact meal cards (120px with inline macro chips)
   - Expanded food photo map (100+ entries including ethnic cuisines)
   - All existing app logic preserved — this layer only patches renderAll
     and renderFoodList/renderLantern via the wrapper pattern.
═══════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  // ─── 1. HERO RING: big calorie arc + 3-layer end-cap dot ───
  const V11_HERO_R = 112;
  const V11_HERO_CIRC = 2 * Math.PI * V11_HERO_R; // ≈ 703.72

  function renderHeroV11(){
    try {
      const t = getTotals();
      const tgt = getCalTarget();
      const pct = Math.max(0, Math.min(t.cal / tgt, 1.15));
      const arc = document.getElementById('hero-v11-arc');
      const dotGroup = document.getElementById('hero-v11-dot-group');
      if (arc) {
        const clamped = Math.min(pct, 1);
        const offset = V11_HERO_CIRC - clamped * V11_HERO_CIRC;
        arc.setAttribute('stroke-dashoffset', offset);
      }
      if (dotGroup) {
        const angle = Math.min(pct, 1) * 360;
        dotGroup.style.transform = `rotate(${angle}deg)`;
      }

      const remEl = document.getElementById('cal-rem');
      const rem = Math.round(tgt - t.cal);
      if (remEl) {
        if (rem >= 0) {
          remEl.innerHTML = `<span class="hv-rem-num">${rem.toLocaleString()}</span> kcal remaining`;
        } else {
          remEl.innerHTML = `<span class="hv-rem-num">${Math.abs(rem).toLocaleString()}</span> kcal over`;
        }
      }

      // Feed the current signal score into the particle animation
      _updateParticleSignals();
    } catch(e){ console.warn('[v11-hero]', e); }
  }

  function _startCalNumberFormatter(){
    const calEl = document.getElementById('cal-num');
    if (!calEl) return;
    const numSpan = calEl.querySelector('.cal-count-n') || calEl;
    if (numSpan._v11_formatter_bound) return;
    numSpan._v11_formatter_bound = true;

    const observer = new MutationObserver(() => {
      const raw = numSpan.textContent.replace(/,/g, '');
      if (/^\d+$/.test(raw)) {
        const formatted = Number(raw).toLocaleString();
        if (formatted !== numSpan.textContent) {
          numSpan.textContent = formatted;
        }
      }
    });
    observer.observe(numSpan, { characterData: true, childList: true, subtree: true });
    const raw = numSpan.textContent.replace(/,/g, '');
    if (/^\d+$/.test(raw)) {
      numSpan.textContent = Number(raw).toLocaleString();
    }
  }

  // ─── 1b. CANVAS-BASED PARTICLE ORB ───
  //
  // Continuous requestAnimationFrame loop. Each particle orbits at a random
  // radius with its own rotation speed and pulses in brightness. The overall
  // intensity (particle count, brightness, orbit speed) is driven by daily
  // signals via _readDailySignals().
  let _particleAnim = null;
  let _particles = [];
  let _canvasCtx = null;
  let _canvasSize = 0;
  let _signalScore = 0;  // 0..5
  let _signalBreakdown = { sleep:0, rec:0, workout:0, water:0, protein:0 };

  function _readDailySignals(){
    let sleep = 0, rec = 0, workout = 0, water = 0, protein = 0;

    try {
      const w0 = (typeof whoopSnaps !== 'undefined' && whoopSnaps) ? whoopSnaps[0] : null;
      if (w0) {
        if (w0.sleep != null)    sleep = Math.max(0, Math.min(w0.sleep / 8, 1));
        if (w0.recovery != null) rec   = Math.max(0, Math.min(w0.recovery / 100, 1));
      }
    } catch(e){}

    try {
      if (typeof whActivities === 'function') {
        const acts = whActivities();
        workout = acts && acts.length > 0 ? 1 : 0;
      }
      if (!workout && typeof WO_HIST_KEY !== 'undefined') {
        const hist = (typeof load === 'function') ? (load(WO_HIST_KEY, []) || []) : [];
        const todayStr = (typeof todayKey === 'function') ? todayKey() : (new Date()).toISOString().slice(0,10);
        if (hist.some(h => {
          const d = h.date || h.endedAt || h.startedAt;
          return d && String(d).slice(0,10) === todayStr;
        })) workout = 1;
      }
    } catch(e){}

    try {
      if (typeof cups !== 'undefined' && typeof CUPS !== 'undefined' && CUPS > 0) {
        water = Math.max(0, Math.min(cups / CUPS, 1));
      }
    } catch(e){}

    try {
      const t = getTotals();
      const ptgt = (typeof TARGETS !== 'undefined') ? TARGETS.p : 128;
      if (ptgt > 0) protein = Math.max(0, Math.min(t.p / ptgt, 1));
    } catch(e){}

    const score = sleep + rec + workout + water + protein;
    return { sleep, rec, workout, water, protein, score };
  }

  function _updateParticleSignals(){
    const sig = _readDailySignals();
    _signalScore = sig.score;
    _signalBreakdown = sig;
  }

  function _initParticleCanvas(){
    const canvas = document.getElementById('hero-v11-canvas');
    if (!canvas) return false;

    // Size the canvas to its rendered dimensions
    const rect = canvas.getBoundingClientRect();
    const size = Math.max(rect.width, 1);
    const dpr  = window.devicePixelRatio || 1;

    if (canvas._v11_size === size && canvas._v11_dpr === dpr && _canvasCtx) {
      // already initialised at correct size
      return true;
    }

    canvas.width  = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width  = size + 'px';
    canvas.style.height = size + 'px';
    canvas._v11_size = size;
    canvas._v11_dpr  = dpr;

    _canvasCtx = canvas.getContext('2d');
    _canvasCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    _canvasSize = size;

    // Build particle pool (22 particles, randomised)
    _particles = Array.from({ length: 22 }, () => {
      return {
        angle: Math.random() * Math.PI * 2,
        dist:  (size / 2) * (0.22 + Math.random() * 0.62),
        sz:    0.6 + Math.random() * 2.2,
        baseOp:0.12 + Math.random() * 0.38,
        dAngle:(Math.random() > 0.5 ? 1 : -1) * (0.0005 + Math.random() * 0.0012),
        pulse: Math.random() * Math.PI * 2,
        pulseSpeed: 0.008 + Math.random() * 0.018,
      };
    });

    return true;
  }

  function _drawParticles(){
    if (!_canvasCtx || !_canvasSize) return;
    const ctx = _canvasCtx;
    const size = _canvasSize;
    const cx = size / 2;
    const cy = size / 2;
    const r  = size / 2 - 4;

    // Signal-driven intensity: 0..1 gate that modulates count + brightness
    // score 0   → intensity ~0.30  (just a whisper of particles)
    // score 2.5 → intensity ~0.65
    // score 5   → intensity 1.0
    const intensity = Math.max(0.30, Math.min(_signalScore / 5, 1));
    const activeCount = Math.max(6, Math.round(_particles.length * intensity));

    ctx.clearRect(0, 0, size, size);

    // Breathing radial glow
    const t = performance.now() / 1000;
    const breathe = 0.88 + Math.sin(t * 0.55) * 0.12;
    const grd = ctx.createRadialGradient(cx, cy, r * 0.05, cx, cy, r * breathe);
    const ar = 255, ag = 45, ab = 0;  // #FF2D00
    grd.addColorStop(0,    `rgba(${ar},${ag},${ab},0.00)`);
    grd.addColorStop(0.45, `rgba(${ar},${ag},${ab},${(0.05 * intensity).toFixed(3)})`);
    grd.addColorStop(0.80, `rgba(${ar},${ag},${ab},${(0.14 * intensity).toFixed(3)})`);
    grd.addColorStop(1,    `rgba(${ar},${ag},${ab},0.00)`);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, size, size);
    ctx.restore();

    // Particles
    for (let i = 0; i < activeCount; i++) {
      const p = _particles[i];
      p.angle += p.dAngle * (0.6 + 0.4 * intensity);
      p.pulse += p.pulseSpeed;

      const x = cx + Math.cos(p.angle) * p.dist;
      const y = cy + Math.sin(p.angle) * p.dist;
      const op = p.baseOp * (0.55 + 0.45 * Math.sin(p.pulse)) * (0.55 + 0.45 * intensity);

      // Soft halo
      const halo = ctx.createRadialGradient(x, y, 0, x, y, p.sz * 4.5);
      halo.addColorStop(0, `rgba(255,255,255,${(op * 0.7).toFixed(3)})`);
      halo.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(x, y, p.sz * 4.5, 0, Math.PI * 2);
      ctx.fill();

      // Bright core
      ctx.fillStyle = `rgba(255,255,255,${Math.min(op * 1.6, 0.9).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x, y, p.sz, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function _startParticleLoop(){
    if (!_initParticleCanvas()) return;
    _updateParticleSignals();
    if (_particleAnim) return; // already running

    const tick = () => {
      _drawParticles();
      _particleAnim = requestAnimationFrame(tick);
    };
    _particleAnim = requestAnimationFrame(tick);
  }

  function _stopParticleLoop(){
    if (_particleAnim) {
      cancelAnimationFrame(_particleAnim);
      _particleAnim = null;
    }
  }

  // Pause when tab is hidden to conserve battery
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) _stopParticleLoop();
    else _startParticleLoop();
  });

  // Re-init on resize
  window.addEventListener('resize', () => {
    const canvas = document.getElementById('hero-v11-canvas');
    if (canvas) {
      canvas._v11_size = 0; // force reinit
      _initParticleCanvas();
    }
  });

  // ─── 2. MACRO ROW ───
  function renderMacrosV11(){
    try {
      const t = getTotals();
      const T = (typeof TARGETS !== 'undefined') ? TARGETS : {p:128,c:200,f:65};

      const rows = [
        { id: 'rp', cur: t.p, tgt: T.p },
        { id: 'rc', cur: t.c, tgt: T.c },
        { id: 'rf', cur: t.f, tgt: T.f },
      ];

      rows.forEach(r => {
        const valEl = document.getElementById(r.id + '-v-big');
        const tgtEl = document.getElementById(r.id + '-target');
        const barEl = document.getElementById(r.id + '-bar');
        const cellEl = barEl ? barEl.closest('.mrow-cell') : null;

        if (valEl) valEl.textContent = Math.round(r.cur);
        if (tgtEl) tgtEl.textContent = r.tgt;
        if (barEl) {
          const pct = Math.min((r.cur / r.tgt) * 100, 100);
          barEl.style.width = pct + '%';
        }
        if (cellEl) cellEl.classList.toggle('over', r.cur > r.tgt);
      });
    } catch(e){ console.warn('[v11-macros]', e); }
  }

  // ─── 3. STREAK PILL ───
  function renderStreakPillV11(){
    try {
      const streak = (typeof calcStreak === 'function') ? calcStreak() : 0;
      const numEl = document.getElementById('smc-num');
      const bestEl = document.getElementById('smc-best');
      if (numEl) numEl.textContent = streak;

      if (bestEl) {
        let maxStreak = 0, cur = 0;
        for (let i = 0; i < 365; i++) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const key = d.toISOString().slice(0, 10);
          const ms = (typeof load === 'function') ? (load(`${KEY}_meals_${key}`) || []) : [];
          if (ms.length > 0) { cur++; if (cur > maxStreak) maxStreak = cur; }
          else cur = 0;
        }
        maxStreak = Math.max(maxStreak, streak);
        bestEl.textContent = maxStreak;
      }
    } catch(e){ console.warn('[v11-streak]', e); }
  }

  // ─── 4. LANTERN PILL ───
  const LANTERN_STATE_RANK = {
    moonlit: 1, still: 2, ember: 3, kindled: 4, radiant: 5, banked: 3
  };

  function renderLanternPillV11(){
    try {
      const host = document.getElementById('lantern-home');
      if (!host) return;
      if (typeof computeLanternState !== 'function') return;

      const s = computeLanternState();
      const stateName = (s.state || 'still').toUpperCase();
      const pctBase = Math.min((LANTERN_STATE_RANK[s.state] || 2) / 5, 1);
      let pct = pctBase;
      if (Array.isArray(s.rituals) && s.rituals.length) {
        const ritualDone = s.rituals.filter(r => r.done).length / s.rituals.length;
        pct = Math.max(pctBase, 0.5 * pctBase + 0.5 * ritualDone);
      }
      pct = Math.max(0.08, Math.min(pct, 1));

      host.innerHTML = `
        <div class="lpv11-row">
          <span class="lpv11-kicker">LANTERN</span>
          <span class="lpv11-state">${stateName}</span>
          <div class="lpv11-bar-wrap"><div class="lpv11-bar-fill" style="width:${Math.round(pct * 100)}%"></div></div>
          <span class="lpv11-tap">TAP ›</span>
        </div>
      `;
      host.classList.add('lantern-pill-v11');
    } catch(e){ console.warn('[v11-lantern-pill]', e); }
  }

  // ─── 5. MEAL PHOTO LOOKUP (expanded, ethnic/local foods) ───
  const V11_PHOTO_CACHE_KEY = 'v11_meal_photo_cache_v3';
  const V11_PHOTO_BASE = 'https://images.unsplash.com/';
  const V11_PHOTO_PARAMS = '?w=800&h=300&fit=crop&auto=format';

  const V11_PHOTO_MAP = [
    // Breakfast
    { kws: ['eggs benedict', 'benedict'],                      id: 'photo-1608039829572-78524f79c4c7' },
    { kws: ['egg', 'sourdough', 'avocado toast', 'toast'],     id: 'photo-1525351484163-7529414344d8' },
    { kws: ['omelette', 'omelet', 'frittata', 'scrambled'],    id: 'photo-1510693206972-df098062cb71' },
    { kws: ['pancake', 'waffle', 'french toast'],              id: 'photo-1528207776546-365bb710ee93' },
    { kws: ['oatmeal', 'oats', 'porridge', 'granola'],         id: 'photo-1517673132405-a56a62b18caf' },
    { kws: ['yogurt', 'parfait'],                              id: 'photo-1488477181946-6428a0291777' },
    { kws: ['smoothie bowl', 'acai'],                          id: 'photo-1501746877-14782df58970' },
    { kws: ['smoothie', 'juice', 'shake'],                     id: 'photo-1610970881699-44a5587cabec' },
    { kws: ['cereal'],                                         id: 'photo-1521483451569-e33803c0330c' },
    { kws: ['bagel', 'cream cheese'],                          id: 'photo-1585478259715-1c195acdcd2b' },
    { kws: ['muffin', 'croissant', 'pastry', 'danish'],        id: 'photo-1608198093002-ad4e005484ec' },
    { kws: ['donut', 'doughnut'],                              id: 'photo-1551024601-bec78aea704b' },

    // South Asian / Indian / Pakistani
    { kws: ['biryani', 'biriyani'],                            id: 'photo-1633945274405-b6c8069047b0' },
    { kws: ['butter chicken', 'chicken tikka', 'tikka masala'],id: 'photo-1585937421612-70a008356fbe' },
    { kws: ['paneer', 'palak paneer', 'shahi paneer'],         id: 'photo-1631452180519-c014fe946bc7' },
    { kws: ['dal', 'daal', 'lentil curry'],                    id: 'photo-1546833999-b9f581a1996d' },
    { kws: ['naan', 'roti', 'chapati', 'paratha'],             id: 'photo-1585937421612-70a008356fbe' },
    { kws: ['samosa', 'pakora', 'bhaji', 'pakoda'],            id: 'photo-1601050690597-df0568f70950' },
    { kws: ['dosa', 'idli', 'sambar', 'uttapam'],              id: 'photo-1589301760014-d929f3979dbc' },
    { kws: ['chole', 'chana', 'chickpea curry'],               id: 'photo-1565557623262-b51c2513a641' },
    { kws: ['kebab', 'kabab', 'seekh'],                        id: 'photo-1529193591184-b1d58069ecdd' },
    { kws: ['nihari', 'haleem'],                               id: 'photo-1574484284002-952d92456975' },
    { kws: ['curry'],                                          id: 'photo-1585937421612-70a008356fbe' },
    { kws: ['masala'],                                         id: 'photo-1585937421612-70a008356fbe' },

    // Middle Eastern
    { kws: ['shawarma'],                                       id: 'photo-1529006557810-274b9b2fc783' },
    { kws: ['falafel'],                                        id: 'photo-1540189549336-e6e99c3679fe' },
    { kws: ['hummus'],                                         id: 'photo-1617161318376-cd5c9b1c54a8' },
    { kws: ['kabob', 'shish'],                                 id: 'photo-1529193591184-b1d58069ecdd' },
    { kws: ['manakish', 'manaqish', 'manoushe', 'zaatar'],     id: 'photo-1593560708920-61dd98c46a4e' },
    { kws: ['fattoush', 'tabbouleh'],                          id: 'photo-1512621776951-a57141f2eefd' },
    { kws: ['machboos', 'kabsa', 'mandi'],                     id: 'photo-1603133872878-684f208fb84b' },
    { kws: ['baklava'],                                        id: 'photo-1625944525533-473f1b3d9684' },
    { kws: ['mezze', 'mezzeh'],                                id: 'photo-1540189549336-e6e99c3679fe' },
    { kws: ['karak', 'chai tea', 'masala chai'],               id: 'photo-1544787219-7f47ccb76574' },

    // East Asian
    { kws: ['sushi', 'nigiri', 'maki', 'sashimi'],             id: 'photo-1579871494447-9811cf80d66c' },
    { kws: ['ramen'],                                          id: 'photo-1569718212165-3a8278d5f624' },
    { kws: ['pho'],                                            id: 'photo-1569562211093-4ed0d0758f12' },
    { kws: ['udon', 'soba'],                                   id: 'photo-1569718212165-3a8278d5f624' },
    { kws: ['dumpling', 'dim sum', 'gyoza', 'potsticker'],     id: 'photo-1496116218417-1a781b1c416c' },
    { kws: ['fried rice'],                                     id: 'photo-1603133872878-684f208fb84b' },
    { kws: ['bibimbap', 'korean bowl'],                        id: 'photo-1553163147-622ab57be1c7' },
    { kws: ['bulgogi', 'kalbi', 'korean bbq'],                 id: 'photo-1553163147-622ab57be1c7' },
    { kws: ['kimchi'],                                         id: 'photo-1583224964978-2257b960c3d3' },
    { kws: ['pad thai'],                                       id: 'photo-1559314809-0d155014e29e' },
    { kws: ['thai', 'green curry', 'red curry'],               id: 'photo-1559314809-0d155014e29e' },
    { kws: ['noodle'],                                         id: 'photo-1495521821757-a1efb6729352' },

    // Latin / Mexican
    { kws: ['taco', 'al pastor', 'carnitas'],                  id: 'photo-1565299585323-38d6b0865b47' },
    { kws: ['burrito', 'chimichanga'],                         id: 'photo-1626700051175-6818013e1d4f' },
    { kws: ['quesadilla', 'enchilada'],                        id: 'photo-1618040996337-11c5b61cf8f2' },
    { kws: ['guac', 'guacamole'],                              id: 'photo-1584538061257-aaff03e27b6a' },
    { kws: ['nachos'],                                         id: 'photo-1513456852971-30c0b8199d4d' },
    { kws: ['ceviche'],                                        id: 'photo-1548078949-cab75c41ad28' },

    // Mediterranean / Italian / Greek
    { kws: ['pizza', 'margherita', 'pepperoni'],               id: 'photo-1513104890138-7c749659a591' },
    { kws: ['carbonara', 'spaghetti'],                         id: 'photo-1551183053-bf91a1d81141' },
    { kws: ['lasagna', 'lasagne'],                             id: 'photo-1574894709920-11b28e7367e3' },
    { kws: ['pasta', 'penne', 'rigatoni', 'fettuccine'],       id: 'photo-1551183053-bf91a1d81141' },
    { kws: ['risotto', 'arancini'],                            id: 'photo-1603133872878-684f208fb84b' },
    { kws: ['bruschetta', 'caprese'],                          id: 'photo-1525351484163-7529414344d8' },
    { kws: ['gyro', 'souvlaki'],                               id: 'photo-1529006557810-274b9b2fc783' },
    { kws: ['greek salad'],                                    id: 'photo-1540420773420-3366772f4999' },

    // American / proteins
    { kws: ['burger', 'cheeseburger'],                         id: 'photo-1568901346375-23c9450c58cd' },
    { kws: ['steak', 'ribeye', 'sirloin', 'filet', 'tenderloin'], id: 'photo-1558030006-450675393462' },
    { kws: ['salmon'],                                         id: 'photo-1467003909585-2f8a72700288' },
    { kws: ['tuna'],                                           id: 'photo-1582845512747-e42001c95638' },
    { kws: ['shrimp', 'prawn'],                                id: 'photo-1625943553852-781c6dd46faa' },
    { kws: ['fish', 'cod', 'tilapia', 'snapper', 'bass'],      id: 'photo-1467003909585-2f8a72700288' },
    { kws: ['grilled chicken', 'chicken breast', 'chicken salad', 'chicken caesar'], id: 'photo-1546069901-ba9599a7e63c' },
    { kws: ['chicken wings', 'wings'],                         id: 'photo-1608039755401-742074f0548d' },
    { kws: ['chicken'],                                        id: 'photo-1598103442097-8b74394b95c6' },
    { kws: ['turkey'],                                         id: 'photo-1574672280600-4accfa5b6f98' },
    { kws: ['beef', 'stew'],                                   id: 'photo-1558030006-450675393462' },
    { kws: ['pork', 'bacon', 'ham'],                           id: 'photo-1528607929212-2636ec44253e' },
    { kws: ['lamb'],                                           id: 'photo-1558030006-450675393462' },
    { kws: ['tofu', 'tempeh', 'seitan'],                       id: 'photo-1546069901-d5bfd2cbfb1f' },

    // Salads / bowls / sides
    { kws: ['caesar salad', 'caesar'],                         id: 'photo-1546069901-ba9599a7e63c' },
    { kws: ['poke', 'poke bowl'],                              id: 'photo-1553621042-f6e147245754' },
    { kws: ['grain bowl', 'buddha bowl', 'quinoa bowl'],       id: 'photo-1540189549336-e6e99c3679fe' },
    { kws: ['salad'],                                          id: 'photo-1512621776951-a57141f2eefd' },
    { kws: ['soup', 'broth', 'bisque'],                        id: 'photo-1547592166-23ac45744acd' },
    { kws: ['sandwich', 'sub', 'hoagie', 'panini', 'wrap'],    id: 'photo-1528735602780-2552fd46c7af' },
    { kws: ['rice'],                                           id: 'photo-1603133872878-684f208fb84b' },

    // Snacks / fruit / nuts
    { kws: ['apple'],                                          id: 'photo-1568702846914-96b305d2aaeb' },
    { kws: ['banana'],                                         id: 'photo-1481349518771-20055b2a7b24' },
    { kws: ['strawberry', 'berries', 'blueberry', 'raspberry'],id: 'photo-1464965911861-746a04b4bca6' },
    { kws: ['mango'],                                          id: 'photo-1553279768-865429fa0078' },
    { kws: ['orange', 'tangerine', 'clementine'],              id: 'photo-1547514701-42782101795e' },
    { kws: ['grape'],                                          id: 'photo-1596363505729-4190a9506133' },
    { kws: ['watermelon'],                                     id: 'photo-1587049352846-4a222e784d38' },
    { kws: ['fruit'],                                          id: 'photo-1490474418585-ba9bad8fd0ea' },
    { kws: ['date', 'ajwa', 'medjool'],                        id: 'photo-1609501676725-7186f017c0c8' },
    { kws: ['almond', 'cashew', 'pistachio', 'walnut', 'pecan', 'nut'], id: 'photo-1508747703725-719777637510' },
    { kws: ['chocolate', 'cocoa'],                             id: 'photo-1511381939415-e44015466834' },
    { kws: ['protein bar', 'cliff bar', 'granola bar', 'ghost bar'], id: 'photo-1606914501449-5a96b6ce24ca' },
    { kws: ['cheese', 'cheddar', 'brie', 'feta', 'mozzarella'],id: 'photo-1486297678162-eb2a19b0a32d' },
    { kws: ['cookie', 'biscuit'],                              id: 'photo-1499636136210-6f4ee915583e' },
    { kws: ['cake', 'cheesecake', 'brownie'],                  id: 'photo-1606313564200-e75d5e30476c' },
    { kws: ['ice cream', 'gelato', 'sorbet'],                  id: 'photo-1501443762994-82bd5dace89a' },
    { kws: ['popcorn'],                                        id: 'photo-1578849278619-e73505e9610f' },

    // Drinks
    { kws: ['coffee', 'latte', 'espresso', 'cappuccino', 'americano', 'mocha'], id: 'photo-1509042239860-f550ce710b93' },
    { kws: ['matcha'],                                         id: 'photo-1536256263959-770b48d82b0a' },
    { kws: ['tea', 'green tea', 'chamomile'],                  id: 'photo-1544787219-7f47ccb76574' },
    { kws: ['water', 'sparkling water'],                       id: 'photo-1548839140-29a749e1cf4d' },
    { kws: ['beer'],                                           id: 'photo-1608270586620-248524c67de9' },
    { kws: ['wine'],                                           id: 'photo-1474722883778-792e7990302f' },
    { kws: ['cocktail'],                                       id: 'photo-1558645836-e44122a743ee' },

    // Supplements
    { kws: ['whey', 'protein shake', 'protein powder', 'protein drink'], id: 'photo-1579722821273-0f6c1c4a5a56' },
    { kws: ['ghost', 'pre workout', 'pre-workout'],            id: 'photo-1579722820308-d74e571900a9' },
    { kws: ['nada', 'quest', 'oikos', 'chobani'],              id: 'photo-1488477181946-6428a0291777' },

    // Vegetables
    { kws: ['veggie', 'vegetable', 'roasted veg', 'broccoli', 'cauliflower'], id: 'photo-1540420773420-3366772f4999' },
  ];

  const V11_PHOTO_FALLBACKS = [
    'photo-1504674900247-0877df9cc836',
    'photo-1540189549336-e6e99c3679fe',
    'photo-1484723091739-30a097e8f929',
    'photo-1495521821757-a1efb6729352',
    'photo-1498579809087-ef1e558fd1da',
    'photo-1467003909585-2f8a72700288',
    'photo-1473093295043-cdd812d0e601',
  ];

  let _photoCache = {};
  try { _photoCache = JSON.parse(localStorage.getItem(V11_PHOTO_CACHE_KEY) || '{}'); }
  catch(e) { _photoCache = {}; }

  function _savePhotoCache(){
    try { localStorage.setItem(V11_PHOTO_CACHE_KEY, JSON.stringify(_photoCache)); }
    catch(e) { /* quota */ }
  }

  function _mealKeywords(name){
    if (!name) return 'food';
    return name.toLowerCase()
      .replace(/[^\w\s&-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'food';
  }

  function _hashStr(s){
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  function getMealPhotoUrl(name){
    const cleaned = _mealKeywords(name);
    if (_photoCache[cleaned]) return _photoCache[cleaned];

    let photoId = null;
    for (const entry of V11_PHOTO_MAP) {
      for (const kw of entry.kws) {
        if (cleaned.includes(kw)) { photoId = entry.id; break; }
      }
      if (photoId) break;
    }
    if (!photoId) {
      const idx = _hashStr(cleaned) % V11_PHOTO_FALLBACKS.length;
      photoId = V11_PHOTO_FALLBACKS[idx];
    }

    const url = V11_PHOTO_BASE + photoId + V11_PHOTO_PARAMS;
    _photoCache[cleaned] = url;
    _savePhotoCache();
    return url;
  }

  // ─── 6. FOOD LIST — v4-style compact 120px cards ───
  const CATEGORY_CONFIG_V11 = {
    'breakfast':    { label: 'BREAKFAST',    order: 0 },
    'lunch':        { label: 'LUNCH',        order: 1 },
    'snack':        { label: 'SNACK',        order: 2 },
    'dinner':       { label: 'DINNER',       order: 3 },
    'pre-workout':  { label: 'PRE-WORKOUT',  order: 4 },
    'post-workout': { label: 'POST-WORKOUT', order: 5 },
  };

  function _inferCategory(m){
    if (m.category) return m.category;
    if (m.loggedAt) {
      const d = new Date(m.loggedAt);
      const mins = d.getHours() * 60 + d.getMinutes();
      if (mins < 630) return 'breakfast';
      if (mins < 870) return 'lunch';
      if (mins < 1080) return 'snack';
      return 'dinner';
    }
    return 'snack';
  }

  function _formatMealTime(loggedAt){
    if (!loggedAt) return '';
    try {
      return new Date(loggedAt).toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true
      });
    } catch(e){ return ''; }
  }

  function _mealDescription(m){
    if (m.ingredients && m.ingredients.length > 0) {
      const names = m.ingredients.slice(0, 3).map(i => i.name || '').filter(Boolean);
      if (names.length) return names.join(' · ');
    }
    if (m.description) return m.description;
    return '';
  }

  function _escapeHtml(s){
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  function renderFoodListV11(){
    const el = document.getElementById('food-list');
    if (!el) return;
    if (!el.classList.contains('food-list-v11')) return false;
    if (typeof meals === 'undefined' || !meals) return;

    if (!meals.length) {
      el.innerHTML = `
        <div class="empty-st">
          <div class="empty-icon">🍽️</div>
          <div>No meals logged yet.<br>Tap <strong>+ ADD</strong> to log one.</div>
        </div>`;
      return true;
    }

    const groups = {};
    meals.forEach((m, i) => {
      const cat = _inferCategory(m);
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push({ m, i });
    });

    const frag = document.createDocumentFragment();

    Object.keys(groups)
      .sort((a, b) => (CATEGORY_CONFIG_V11[a]?.order ?? 99) - (CATEGORY_CONFIG_V11[b]?.order ?? 99))
      .forEach(cat => {
        const entries = groups[cat];
        if (!entries.length) return;

        const groupCal = entries.reduce((s, {m}) => s + Math.round(m.calories || 0), 0);
        const label = CATEGORY_CONFIG_V11[cat]?.label || cat.toUpperCase();

        const hdr = document.createElement('div');
        hdr.className = 'meal-group-lbl';
        hdr.innerHTML = `<span>${label}</span><span>${groupCal} kcal</span>`;
        frag.appendChild(hdr);

        entries.forEach(({m, i}) => {
          const card = document.createElement('div');
          card.className = 'fi fi-v11';
          card.setAttribute('data-idx', i);

          const time = _formatMealTime(m.loggedAt);
          const desc = _mealDescription(m);
          const photoUrl = getMealPhotoUrl(m.name);

          const sessionThumb = (typeof _mealThumbs !== 'undefined' && _mealThumbs.get)
            ? _mealThumbs.get(m.loggedAt)
            : null;
          const bgUrl = sessionThumb || photoUrl;

          const fibre = m.fibre != null ? Math.round(m.fibre) : (m.fiber != null ? Math.round(m.fiber) : 0);

          const tgt = (typeof getCalTarget === 'function') ? getCalTarget() : 2340;
          const mealPct = Math.max(3, Math.min(((m.calories || 0) / tgt) * 100, 100));

          card.innerHTML = `
            <div class="fiv11-bg" data-emoji="${m.emoji || '🍽️'}" style="background-image:url('${bgUrl}')"></div>

            <div class="fiv11-top">
              <span class="fiv11-kcal">${Math.round(m.calories || 0)}<span class="fiv11-kcal-unit">kcal</span></span>
              <span class="fiv11-time">${time || ''}</span>
            </div>

            <div class="fiv11-body">
              <div class="fiv11-body-text">
                <div class="fiv11-name">${_escapeHtml(m.name || 'Meal')}</div>
                ${desc ? `<div class="fiv11-desc">${_escapeHtml(desc)}</div>` : ''}
              </div>
              <div class="fiv11-chips">
                <div class="fiv11-chip protein">
                  <span class="fiv11-chip-lbl">Protein</span>
                  <span class="fiv11-chip-val">${Math.round(m.protein || 0)}<span class="fiv11-chip-unit">g</span></span>
                </div>
                <div class="fiv11-chip carbs">
                  <span class="fiv11-chip-lbl">Carbs</span>
                  <span class="fiv11-chip-val">${Math.round(m.carbs || 0)}<span class="fiv11-chip-unit">g</span></span>
                </div>
                <div class="fiv11-chip fat">
                  <span class="fiv11-chip-lbl">Fat</span>
                  <span class="fiv11-chip-val">${Math.round(m.fat || 0)}<span class="fiv11-chip-unit">g</span></span>
                </div>
                <div class="fiv11-chip fiber">
                  <span class="fiv11-chip-lbl">Fiber</span>
                  <span class="fiv11-chip-val">${fibre}<span class="fiv11-chip-unit">g</span></span>
                </div>
              </div>
            </div>

            <div class="fiv11-progress-track">
              <div class="fiv11-progress-fill" style="width:${mealPct}%"></div>
            </div>

            <button class="fi-del" aria-label="Delete">✕</button>
          `;

          card.addEventListener('click', (e) => {
            if (e.target.classList.contains('fi-del')) return;
            if (typeof openMealDetail === 'function') openMealDetail(i);
          });

          const delBtn = card.querySelector('.fi-del');
          if (delBtn) {
            delBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              if (typeof deleteMeal === 'function') deleteMeal(i);
            });
          }

          const bgDiv = card.querySelector('.fiv11-bg');
          const probe = new Image();
          probe.onerror = () => {
            bgDiv.classList.add('fiv11-bg-fallback');
            bgDiv.style.backgroundImage = '';
          };
          probe.src = bgUrl;

          frag.appendChild(card);
        });
      });

    el.innerHTML = '';
    el.appendChild(frag);
    return true;
  }

  // ─── 7. HOOK INTO renderAll ───
  (function(){
    const _prev = window.renderAll;
    window.renderAll = function(){
      _prev && _prev.apply(this, arguments);
      renderHeroV11();
      renderMacrosV11();
      renderStreakPillV11();
      renderLanternPillV11();
      renderFoodListV11();
    };
  })();

  (function(){
    const _origRenderFoodList = window.renderFoodList;
    window.renderFoodList = function(){
      const v11Handled = renderFoodListV11();
      if (v11Handled === false) {
        _origRenderFoodList && _origRenderFoodList.apply(this, arguments);
      }
    };
  })();

  (function(){
    const _origRenderLantern = window.renderLantern;
    window.renderLantern = function(){
      const host = document.getElementById('lantern-home');
      if (host && host.classList.contains('lantern-pill-v11')) {
        renderLanternPillV11();
        return;
      }
      _origRenderLantern && _origRenderLantern.apply(this, arguments);
    };
  })();

  // Expose helpers
  window.v11 = {
    renderHero: renderHeroV11,
    renderMacros: renderMacrosV11,
    renderStreak: renderStreakPillV11,
    renderLanternPill: renderLanternPillV11,
    renderFoodList: renderFoodListV11,
    readSignals: _readDailySignals,
    getMealPhotoUrl,
    startParticles: _startParticleLoop,
    stopParticles: _stopParticleLoop,
    clearPhotoCache(){ _photoCache = {}; localStorage.removeItem(V11_PHOTO_CACHE_KEY); }
  };

  // Initial render + start particle loop once the DOM is ready
  function _boot(){
    try {
      _startCalNumberFormatter();
      renderHeroV11();
      renderMacrosV11();
      renderStreakPillV11();
      renderLanternPillV11();
      renderFoodListV11();
      _startParticleLoop();
    } catch(e) {
      console.warn('[v11 init]', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot);
  } else {
    _boot();
  }

  // Refresh signals every 60s
  setInterval(_updateParticleSignals, 60000);

})();
