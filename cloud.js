// ═══════════════════════════════════════════════════════════════
// reBorn Cloud Sync — Supabase
// Loaded after app.js; all app globals are in scope.
// ═══════════════════════════════════════════════════════════════

const CLOUD_URL = 'https://dudphzxmudnbqdkigwyt.supabase.co';
const CLOUD_KEY = 'sb_publishable_zxzcP-635IxTb4riTdE7zw_Gk6nPxPH';

const _sb = supabase.createClient(CLOUD_URL, CLOUD_KEY);
let _cloudUser = null;

// Keys that should sync. `_SYNC_EXACT` is a fixed set; `_SYNC_PREFIX` matches
// any key that starts with one of the listed strings (date-keyed data).
const _SYNC_EXACT = new Set([
  `${KEY}_wo_history`,
  `${KEY}_wo_pbs`,
  `${KEY}_wo_notes`,
  `${KEY}_routines`,
  `${KEY}_entries`,
  `${KEY}_quickitems`,
  WO_KEY,
  FAST_LOG_KEY,
  FAST_STATE_KEY,
]);

const _SYNC_PREFIX = [
  `${KEY}_meals_`,
  `${KEY}_cups_`,
  `${KEY}_whoopsnaps_`,
  `${KEY}_whoopActivities_`,
];

function _shouldSync(key) {
  return _SYNC_EXACT.has(key) || _SYNC_PREFIX.some(p => key.startsWith(p));
}

// ── Local write-version tracking ──────────────────────────────
// Every local write to a synced key is stamped with the moment it happened.
// cloudPull uses these stamps to avoid clobbering data that is newer locally
// than what's in the cloud ("cloud wins" was overwriting fresh local writes —
// e.g. a workout you just finished — with a stale server copy on reload).
const _TS_KEY = `${KEY}_cloud_ts`;
function _loadTs() { try { return JSON.parse(localStorage.getItem(_TS_KEY)) || {}; } catch { return {}; } }
function _saveTs(map) { try { localStorage.setItem(_TS_KEY, JSON.stringify(map)); } catch {} }
function _stampLocal(key, iso) {
  const m = _loadTs(); m[key] = iso; _saveTs(m);
}
function _localTs(key) { return _loadTs()[key] || null; }

// ── Push one key to Supabase (fire-and-forget) ────────────────
async function cloudPush(key, value) {
  if (!_shouldSync(key)) return;
  // Stamp the local write time even when signed out, so a later sign-in pull
  // doesn't overwrite offline edits that are newer than the server copy.
  const iso = new Date().toISOString();
  _stampLocal(key, iso);
  if (!_cloudUser) return;
  try {
    const { error } = await _sb.from('user_data').upsert(
      { user_id: _cloudUser.id, key, value: JSON.stringify(value), updated_at: iso },
      { onConflict: 'user_id,key' }
    );
    if (error) throw error;
  } catch (e) {
    console.warn('[reBorn Cloud] push failed:', key, e.message);
  }
}

// ── Delete one key from Supabase (propagate local removals) ────
// localStorage.removeItem() alone left finished sessions alive in the cloud,
// so the next cloudPull resurrected them (an ended workout reappeared as
// still in-progress). Removing the cloud row too keeps deletions sticky.
async function cloudDelete(key) {
  const m = _loadTs(); delete m[key]; _saveTs(m);
  if (!_cloudUser || !_shouldSync(key)) return;
  try {
    const { error } = await _sb.from('user_data').delete()
      .eq('user_id', _cloudUser.id).eq('key', key);
    if (error) throw error;
  } catch (e) {
    console.warn('[reBorn Cloud] delete failed:', key, e.message);
  }
}

// ── Push all existing local data to cloud (first sign-in) ─────
async function _cloudPushAll() {
  if (!_cloudUser) return;
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (_shouldSync(k)) keys.push(k);
  }
  if (keys.length === 0) return;

  const rows = keys.map(key => {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    return { user_id: _cloudUser.id, key, value: raw, updated_at: new Date().toISOString() };
  }).filter(Boolean);

  try {
    const { error } = await _sb.from('user_data').upsert(rows, { onConflict: 'user_id,key' });
    if (error) throw error;
    console.log(`[reBorn Cloud] uploaded ${rows.length} local keys`);
  } catch (e) {
    console.warn('[reBorn Cloud] initial push failed:', e.message);
  }
}

// ── Pull all cloud data → localStorage → re-render ───────────
async function cloudPull() {
  if (!_cloudUser) return;
  try {
    const { data, error } = await _sb
      .from('user_data')
      .select('key, value, updated_at')
      .eq('user_id', _cloudUser.id);
    if (error) throw error;
    if (data && data.length > 0) {
      let applied = 0;
      data.forEach(({ key, value, updated_at }) => {
        // Skip rows that are older than an unsynced local write — otherwise a
        // stale server copy overwrites data you just changed on this device.
        const localIso = _localTs(key);
        if (localIso && updated_at && localIso > updated_at) return;
        localStorage.setItem(key, value);
        if (updated_at) _stampLocal(key, updated_at);
        applied++;
      });
      _cloudReloadState();
      renderAll();
      console.log(`[reBorn Cloud] pulled ${data.length} keys, applied ${applied}`);
    }
  } catch (e) {
    console.warn('[reBorn Cloud] pull failed:', e.message);
  }
}

// Re-hydrate in-memory variables after a pull so the UI reflects cloud data
function _cloudReloadState() {
  const today = todayKey();
  // Reassign module-level vars that were set at boot
  Object.assign(window, {
    meals:      load(`${KEY}_meals_${today}`, []),
    whoopSnaps: load(`${KEY}_whoopsnaps_${today}`, [null, null, null]),
    cups:       parseFloat(localStorage.getItem(`${KEY}_cups_${today}`) || '0') || 0,
    entries:    load(`${KEY}_entries`, []),
    quickItems: load(`${KEY}_quickitems`, DEFAULT_QA),
    fastState:  load(FAST_STATE_KEY, null),
    fastLog:    load(FAST_LOG_KEY, []),
  });
}

// ── Auth helpers ──────────────────────────────────────────────
async function cloudSignIn(email, password) {
  const { data, error } = await _sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

async function cloudSignUp(email, password) {
  const { data, error } = await _sb.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

async function cloudSignOut() {
  await _sb.auth.signOut();
  _cloudUser = null;
  _updateCloudUI(null);
  _cloudToast('Signed out');
}

// ── Auth state listener ───────────────────────────────────────
_sb.auth.onAuthStateChange(async (event, session) => {
  _cloudUser = session?.user ?? null;
  _updateCloudUI(_cloudUser);
  if (event === 'SIGNED_IN') {
    _cloudToast('Syncing your data…');
    await cloudPull();      // cloud wins — pull first
    await _cloudPushAll();  // then upload any local-only keys
    _cloudToast('All data synced ✓');
  }
});

// Restore session on page load
(async () => {
  const { data: { session } } = await _sb.auth.getSession();
  if (session) {
    _cloudUser = session.user;
    _updateCloudUI(_cloudUser);
    _cloudToast('Syncing…');
    await cloudPull();
    _cloudToast('Data synced ✓');
  }
})();

// ── Auth modal logic ──────────────────────────────────────────
let _authMode = 'in';

function openCloudModal() {
  const m = document.getElementById('cloud-modal');
  if (!m) return;
  if (_cloudUser) {
    // Already signed in → show account sheet instead
    const sheet = document.getElementById('cloud-account-sheet');
    if (sheet) {
      document.getElementById('cloud-acct-email').textContent = _cloudUser.email;
      sheet.classList.add('open');
    }
    return;
  }
  _setAuthMode('in');
  m.classList.add('open');
}

function closeCloudModal() {
  document.getElementById('cloud-modal')?.classList.remove('open');
  document.getElementById('cloud-account-sheet')?.classList.remove('open');
}

function _setAuthMode(mode) {
  _authMode = mode;
  const title  = document.getElementById('cloud-modal-title');
  const submit = document.getElementById('cloud-auth-submit');
  const toggle = document.getElementById('cloud-auth-toggle');
  const err    = document.getElementById('cloud-auth-err');
  if (err) { err.textContent = ''; err.style.color = ''; }
  if (mode === 'in') {
    if (title)  title.textContent = 'Sign in';
    if (submit) submit.textContent = 'Sign In';
    if (toggle) toggle.innerHTML = `No account? <button onclick="_setAuthMode('up')">Create one</button>`;
  } else {
    if (title)  title.textContent = 'Create account';
    if (submit) submit.textContent = 'Sign Up';
    if (toggle) toggle.innerHTML = `Already have one? <button onclick="_setAuthMode('in')">Sign in</button>`;
  }
}

async function _submitAuth() {
  const email    = (document.getElementById('cloud-email')?.value || '').trim();
  const password = document.getElementById('cloud-password')?.value || '';
  const err      = document.getElementById('cloud-auth-err');
  const btn      = document.getElementById('cloud-auth-submit');
  if (!err || !btn) return;

  err.textContent = '';
  if (!email || !password) { err.textContent = 'Enter your email and password.'; return; }
  if (_authMode === 'up' && password.length < 6) { err.textContent = 'Password must be at least 6 characters.'; return; }

  btn.disabled = true;
  btn.textContent = _authMode === 'in' ? 'Signing in…' : 'Creating account…';

  try {
    if (_authMode === 'in') {
      await cloudSignIn(email, password);
    } else {
      const { data } = await cloudSignUp(email, password);
      if (data?.user && !data?.session) {
        err.style.color = 'var(--ok)';
        err.textContent = 'Check your email to confirm your account, then sign in.';
        _setAuthMode('in');
        btn.disabled = false;
        btn.textContent = 'Sign In';
        return;
      }
    }
    closeCloudModal();
  } catch (e) {
    err.textContent = e.message || 'Something went wrong.';
  } finally {
    btn.disabled = false;
    btn.textContent = _authMode === 'in' ? 'Sign In' : 'Sign Up';
  }
}

// ── UI helpers ────────────────────────────────────────────────
function _updateCloudUI(user) {
  const badge   = document.getElementById('cloud-badge');
  const signBtn = document.getElementById('cloud-signin-btn');
  if (!badge || !signBtn) return;
  if (user) {
    const span = badge.querySelector('span');
    if (span) span.textContent = user.email.split('@')[0].slice(0, 14);
    badge.style.display = 'flex';
    signBtn.style.display = 'none';
  } else {
    badge.style.display = 'none';
    signBtn.style.display = 'flex';
  }
}

function _cloudToast(msg) {
  let t = document.getElementById('cloud-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'cloud-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3000);
}
