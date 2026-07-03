// Alicia account — sign in with a Chatwillow account (shared Supabase) for a higher
// daily AI allowance, and upgrade to Alicia Pro (Stripe, via the Chatwillow backend).
//
// Auth is Supabase email OTP over plain REST (no SDK): request a 6-digit code, verify
// it, keep {access_token, refresh_token} in chrome.storage.local, refresh when stale.
// Everything degrades gracefully: signed-out users keep working on the anonymous tier.
//
// NOTE (one-time Supabase setup): the "Magic Link" email template must include the
// {{ .Token }} code, otherwise the email only carries a link and the code field here
// has nothing to accept.

var ALICIA_SUPABASE_URL = 'https://boleszqdqphfxxwizyoo.supabase.co';
// Publishable key — ships in clients by design (RLS enforces access), same as the PWA.
var ALICIA_SUPABASE_KEY = 'sb_publishable_i_JpTN1VMvgByGCL3KPNQQ_7PpYGzhb';
var ALICIA_SITE_URL = 'https://chatwillow.com';

var AliciaAccount = (function () {
  'use strict';

  var STORAGE_KEY = 'alicia_session';

  function loadSession() {
    return new Promise(function (resolve) {
      try { chrome.storage.local.get([STORAGE_KEY], function (d) { resolve((d && d[STORAGE_KEY]) || null); }); }
      catch (e) { resolve(null); }
    });
  }
  function saveSession(s) {
    return new Promise(function (resolve) {
      try { var o = {}; o[STORAGE_KEY] = s; chrome.storage.local.set(o, resolve); }
      catch (e) { resolve(); }
    });
  }
  function clearSession() {
    return new Promise(function (resolve) {
      try { chrome.storage.local.remove([STORAGE_KEY], resolve); } catch (e) { resolve(); }
    });
  }

  async function gotrue(path, body) {
    var resp = await fetch(ALICIA_SUPABASE_URL + '/auth/v1' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': ALICIA_SUPABASE_KEY },
      body: JSON.stringify(body)
    });
    var data = null;
    try { data = await resp.json(); } catch (e) { data = {}; }
    if (!resp.ok) {
      throw new Error(data.msg || data.error_description || data.error || ('Sign-in error (' + resp.status + ')'));
    }
    return data;
  }

  function sessionFromTokenResponse(data, email) {
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + ((data.expires_in || 3600) * 1000),
      email: email || (data.user && data.user.email) || ''
    };
  }

  // Step 1: email the user a 6-digit code (creates the account if it doesn't exist —
  // same identity pool as chatwillow.com sign-in).
  async function requestCode(email) {
    await gotrue('/otp', { email: email, create_user: true });
  }

  // Step 2: trade the code for a session.
  async function verifyCode(email, code) {
    var data = await gotrue('/verify', { type: 'email', email: email, token: String(code).trim() });
    if (!data.access_token) throw new Error('Invalid code — check the newest email and try again.');
    var s = sessionFromTokenResponse(data, email);
    await saveSession(s);
    return s;
  }

  async function refreshSession(session) {
    var data = await gotrue('/token?grant_type=refresh_token', { refresh_token: session.refresh_token });
    var s = sessionFromTokenResponse(data, session.email);
    await saveSession(s);
    return s;
  }

  // Valid bearer token, or null when signed out / refresh failed (anonymous tier).
  async function getAccessToken() {
    var s = await loadSession();
    if (!s || !s.access_token) return null;
    if (Date.now() > (s.expires_at || 0) - 60000) {
      try { s = await refreshSession(s); }
      catch (e) { await clearSession(); return null; }
    }
    return s.access_token;
  }

  // 'pro' | 'free' | null (null = signed out). RLS scopes the query to the caller's row.
  async function getPlan() {
    var token = await getAccessToken();
    if (!token) return null;
    try {
      var resp = await fetch(ALICIA_SUPABASE_URL + '/rest/v1/subscriptions?select=plan,status', {
        headers: { 'apikey': ALICIA_SUPABASE_KEY, 'Authorization': 'Bearer ' + token }
      });
      if (!resp.ok) return 'free';
      var rows = await resp.json();
      var sub = rows && rows[0];
      var active = sub && (sub.status === 'active' || sub.status === 'trialing');
      return (active && (sub.plan === 'alicia_pro' || sub.plan === 'pro')) ? 'pro' : 'free';
    } catch (e) { return 'free'; }
  }

  // Opens Stripe Checkout for Alicia Pro in a new tab.
  async function upgrade() {
    var token = await getAccessToken();
    if (!token) throw new Error('Sign in first.');
    var resp = await fetch(ALICIA_SITE_URL + '/api/stripe-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ product: 'alicia' })
    });
    var data = null;
    try { data = await resp.json(); } catch (e) { data = {}; }
    if (!resp.ok || !data.url) throw new Error(data.error || 'Could not start checkout.');
    chrome.tabs.create({ url: data.url });
  }

  async function signOut() { await clearSession(); }
  async function getEmail() { var s = await loadSession(); return s ? s.email : null; }

  return {
    requestCode: requestCode,
    verifyCode: verifyCode,
    getAccessToken: getAccessToken,
    getPlan: getPlan,
    getEmail: getEmail,
    upgrade: upgrade,
    signOut: signOut
  };
})();

// ---------- Account section UI (Tools tab) ----------
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function setStatus(msg, isError) {
    var el = $('account-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = isError ? '#d92d20' : '';
  }

  async function renderState() {
    var email = await AliciaAccount.getEmail();
    var signedIn = !!email && !!(await AliciaAccount.getAccessToken());
    $('account-signed-out').classList.toggle('hidden', signedIn);
    $('account-signed-in').classList.toggle('hidden', !signedIn);
    if (signedIn) {
      $('account-user-email').textContent = email;
      $('account-plan').textContent = '…';
      var plan = await AliciaAccount.getPlan();
      $('account-plan').textContent = plan === 'pro' ? '⭐ Alicia Pro' : 'Free plan';
      $('account-upgrade').classList.toggle('hidden', plan === 'pro');
    }
  }

  function wire() {
    if (!$('account-section')) return;

    $('account-send-code').addEventListener('click', async function () {
      var email = ($('account-email').value || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setStatus('Enter a valid email address.', true); return; }
      setStatus('Sending code…');
      try {
        await AliciaAccount.requestCode(email);
        $('account-code-row').classList.remove('hidden');
        setStatus('Code sent — check your email (and spam).');
      } catch (e) { setStatus(e.message, true); }
    });

    $('account-verify').addEventListener('click', async function () {
      var email = ($('account-email').value || '').trim();
      var code = ($('account-code').value || '').trim();
      if (!code) { setStatus('Enter the code from your email.', true); return; }
      setStatus('Verifying…');
      try {
        await AliciaAccount.verifyCode(email, code);
        setStatus('');
        await renderState();
      } catch (e) { setStatus(e.message, true); }
    });

    $('account-upgrade').addEventListener('click', async function () {
      setStatus('Opening checkout…');
      try { await AliciaAccount.upgrade(); setStatus(''); }
      catch (e) { setStatus(e.message, true); }
    });

    $('account-signout').addEventListener('click', async function () {
      await AliciaAccount.signOut();
      $('account-code-row').classList.add('hidden');
      setStatus('');
      await renderState();
    });

    renderState();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
