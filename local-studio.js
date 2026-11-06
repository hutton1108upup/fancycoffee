(() => {
  const maxBytes = 10 * 1024 * 1024;
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
  const state = { style: 'standard', resolution: '480p', lead: null, regular: null, auth: null, health: null, packs: [], csrfToken: '' };
  const costs = { standard: { '480p': 20, '720p': 40 }, closer: { '480p': 30, '720p': 50 } };
  const $ = (s) => document.querySelector(s);
  const setFeedback = (message, kind = 'info') => { let node = $('[data-local-feedback]'); if (!node) { node = document.createElement('p'); node.dataset.localFeedback = ''; ($('.studio-action') || $('.pricing-section') || document.body)?.prepend(node); } node.textContent = message; node.className = `local-feedback ${kind}`; };
  const addStyles = () => { const style = document.createElement('style'); style.textContent = '.local-feedback{margin:0 0 12px;font-size:14px;line-height:1.5}.local-feedback.warning{color:#76591d}.local-feedback.error{color:#9d2b2b}.local-feedback.success{color:#356b35}.local-photo-preview{display:block;width:100%;max-height:180px;object-fit:cover;border-radius:6px;margin-bottom:8px}.photo-drop{min-height:150px}.billing-panel{margin:16px 0;padding:14px;border:1px solid var(--desk-line,#d9d8cb);border-radius:8px;background:#fffdf8;color:#282c24;font-size:14px}.billing-panel p{margin:4px 0;color:inherit}.billing-panel ul{margin:8px 0;padding-left:18px;color:inherit}.billing-test{color:#76591d;font-weight:600}'; document.head.append(style); };
  const api = async (path, options = {}) => { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), options.timeoutMs || 8000); try { const response = await fetch(path, { credentials: 'same-origin', ...options, signal: controller.signal }); const data = await response.json().catch(() => ({})); return { response, data }; } finally { clearTimeout(timer); } };
  const relativeReturnTo = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const wireAuth = async () => { const button = $('[data-testid="site-session-pending"]'); try { const [healthResult, authResult] = await Promise.all([api('/api/health'), api('/auth/me')]); state.health = healthResult.data; state.auth = authResult.data; state.csrfToken = authResult.data.csrfToken || ''; const pending = getPending(); if (pending && pending.userId && pending.userId !== authResult.data.user?.id) setPending(null); if (!button) return; if (healthResult.data.providers?.auth !== 'configured' || authResult.data.authConfigured === false) { button.disabled = true; button.textContent = 'Google sign-in unavailable'; button.title = 'Google OAuth is not configured'; return; } button.disabled = false; button.removeAttribute('title'); if (authResult.data.authenticated) { button.textContent = authResult.data.user?.email || 'Signed in'; button.dataset.authenticated = 'true'; button.onclick = async () => { try { const result = await api('/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': state.csrfToken } }); if (!result.response.ok) { setFeedback('Sign out was not confirmed by the server.', 'warning'); return; } window.location.reload(); } catch { setFeedback('Sign out could not be confirmed because the server is unavailable.', 'warning'); } }; } else { button.textContent = 'Sign in with Google'; button.onclick = () => { window.location.assign(`/auth/google/start?returnTo=${encodeURIComponent(relativeReturnTo())}`); }; } } catch { if (button) { button.disabled = true; button.textContent = 'Sign-in unavailable'; button.title = 'Start the server and configure Google OAuth'; } } };
  const renderBilling = (billing) => { let panel = $('[data-billing-panel]'); if (!panel) { panel = document.createElement('section'); panel.dataset.billingPanel = ''; panel.className = 'billing-panel'; document.body.append(panel); } while (panel.firstChild) panel.removeChild(panel.firstChild); const title = document.createElement('strong'); title.textContent = 'Account'; panel.append(title); const creditLine = document.createElement('p'); creditLine.textContent = billing?.credits == null ? 'Credits unavailable until billing is configured.' : `${billing.credits} credits available.`; panel.append(creditLine); if (billing?.orders?.length) { const heading = document.createElement('strong'); heading.textContent = 'Recent orders'; panel.append(heading); const list = document.createElement('ul'); billing.orders.forEach((order) => { const item = document.createElement('li'); item.textContent = `${order.orderId || 'Order'} · ${order.status || 'status unavailable'}`; list.append(item); }); panel.append(list); } else { const empty = document.createElement('p'); empty.textContent = 'No order status available.'; panel.append(empty); } };
  const paymentConfig = () => state.packsResult?.paymentMode || {};
  const updateServiceStatus = (health = {}, packs = null) => { const node = document.querySelector('#service-status'); if (!node) return; const unavailable = []; const providers = health?.providers || {}; if (providers.ai !== 'configured' && providers.video !== 'configured') unavailable.push('video generation'); if (providers.auth !== 'configured') unavailable.push('Google sign-in'); const payment = packs?.paymentMode || {}; const testMode = payment.mode === 'test'; const productionReady = payment.mode === 'prod' && payment.productionConfigured === true && payment.checkoutEnabled === true; if (!testMode && !productionReady) unavailable.push('purchases'); unavailable.push('customer support'); const parts = []; if (unavailable.length) parts.push(`${unavailable.join(', ')} remain unavailable.`); if (testMode) parts.push('Checkout is in test mode; no real charges.'); node.textContent = parts.length ? `Production preview: ${parts.join(' ')}` : 'Production preview: customer support remains unavailable.'; };
  const renderPackState = () => { const mode = paymentConfig(); const configured = mode.testConfigured === true || mode.productionConfigured === true; const checkoutEnabled = mode.checkoutEnabled === true; document.querySelectorAll('[data-testid^="buy-"]').forEach((button) => { const packId = button.dataset.packId; const available = state.packs.some((pack) => pack.id === packId); button.disabled = !configured || !checkoutEnabled || !available; button.textContent = mode.mode === 'test' ? 'Continue · Test mode' : 'Continue with Google'; button.title = configured && checkoutEnabled && available ? '' : 'Payments are not configured'; }); };
  const allowedCheckoutUrl = (value) => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && (url.port === '' || url.port === '443') && ['checkout.waffo.ai', 'pancake.waffo.ai'].includes(url.hostname); } catch { return false; } };
  let memoryPending = null;
  let storageFailed = false;
  const storage = { get() { if (storageFailed) return memoryPending; try { const raw = sessionStorage.getItem('fancycafe:pending-checkout'); if (raw === null) return memoryPending; const value = JSON.parse(raw); memoryPending = value; return value; } catch { storageFailed = true; return memoryPending; } }, set(value) { memoryPending = value || null; try { if (value) sessionStorage.setItem('fancycafe:pending-checkout', JSON.stringify(value)); else sessionStorage.removeItem('fancycafe:pending-checkout'); } catch { storageFailed = true; } } };
  const setPending = (value) => storage.set(value);
  const getPending = () => storage.get();
  const renderOrderResult = (order) => { const status = order?.status; if (!status) return 'Order status is still unknown.'; if (status === 'paid' || status === 'fulfilled') return `Payment confirmed by server. ${order.packId || 'Credits'} are available after balance refresh.`; return `Order status: ${status}. Payment is not confirmed.`; };
  const pollOrder = async (orderId, panel) => { try { for (let i = 0; i < 5; i += 1) { const result = await api(`/api/orders/${encodeURIComponent(orderId)}`); if (result.response.ok && result.data?.order) { panel.textContent = renderOrderResult(result.data.order); if (['paid', 'fulfilled'].includes(result.data.order.status)) { setPending(null); const refreshed = await api('/api/billing'); if (refreshed.response.ok && refreshed.data) renderBilling(refreshed.data); return; } } await new Promise((resolve) => setTimeout(resolve, 1200)); } panel.textContent = 'Order status is still unknown. Payment is not confirmed; try checking order status again.'; } catch { panel.textContent = 'Could not verify order status. Payment is not confirmed; try again.'; } };
  const checkout = async (packId, button) => { if (!state.auth?.authenticated) { window.location.assign(`/auth/google/start?returnTo=${encodeURIComponent(relativeReturnTo())}`); return; } if (!state.csrfToken) { setFeedback('Checkout is unavailable because the session CSRF token is missing.', 'warning'); return; } const prior = getPending(); const requestId = prior?.packId === packId && prior?.userId === state.auth.user?.id ? prior.requestId : (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`); const pending = prior?.packId === packId && prior?.userId === state.auth.user?.id ? { ...prior, requestId } : { packId, requestId, userId: state.auth.user?.id }; button.disabled = true; try { setPending(pending); const result = await api('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken }, body: JSON.stringify({ packId, requestId }) }); const orderId = result.data?.order?.orderId || result.data?.orderId; if (!result.response.ok) { if (orderId) { pending.orderId = orderId; setPending(pending); } throw new Error(result.data?.message || `Checkout unavailable (${result.data?.code || result.response.status}).`); } if (!result.data?.checkoutUrl && orderId) { const statusPanel = document.createElement('p'); statusPanel.className = 'local-feedback warning'; statusPanel.textContent = 'Existing order found. Checking server order status; no new checkout was created.'; (button.closest('.pack-action') || $('.pricing-section') || document.body).append(statusPanel); setPending({ ...pending, orderId }); await pollOrder(orderId, statusPanel); return; } if (!allowedCheckoutUrl(result.data?.checkoutUrl)) throw new Error('Hosted checkout is unavailable or is not an approved HTTPS Waffo URL.'); const statusPanel = document.createElement('p'); statusPanel.className = 'local-feedback warning'; statusPanel.textContent = `Checkout opened. Payment is not confirmed until the server reports order ${orderId || 'status'} as paid.`; (button.closest('.pack-action') || $('.pricing-section') || document.body).append(statusPanel); if (orderId) setPending({ ...pending, orderId }); window.location.assign(result.data.checkoutUrl); } catch (error) { state.lastCheckoutError = error?.message || 'unknown'; setPending(pending); setFeedback(error.message || 'Checkout is unavailable.', 'warning'); button.disabled = false; } };
  globalThis.__fancyCafeBilling = { allowedCheckoutUrl, renderOrderResult, setPending, getPending, checkout, updateServiceStatus, configure(options) { Object.assign(state, options); return state; } };
  const wireBilling = async () => { try { const packsResult = await api('/api/credit-packs'); state.packsResult = packsResult.data; state.packs = Array.isArray(packsResult.data?.packs) ? packsResult.data.packs : []; updateServiceStatus(state.health, packsResult.data); const billingResult = state.auth?.authenticated ? await api('/api/billing') : { data: null }; const map = { 'buy-starter-v2': 'credits-20', 'buy-pro-v2': 'credits-60', 'buy-studio-v2': 'credits-200' }; document.querySelectorAll('[data-testid="buy-starter-v2"],[data-testid="buy-pro-v2"],[data-testid="buy-studio-v2"]').forEach((button) => { const packId = map[button.getAttribute('data-testid')]; button.dataset.packId = packId; button.onclick = () => checkout(packId, button); }); renderPackState(); if (billingResult.data) renderBilling(billingResult.data); const pending = getPending(); const orderId = new URLSearchParams(window.location.search).get('order') || pending?.orderId; if (orderId) { const panel = document.createElement('p'); panel.className = 'local-feedback warning'; panel.textContent = 'Checking server order status…'; document.body.prepend(panel); await pollOrder(orderId, panel); } if (paymentConfig().mode === 'test') { const note = document.createElement('p'); note.className = 'billing-panel billing-test'; note.textContent = 'Test mode: checkout and order status are not proof of a live charge.'; document.body.append(note); } } catch { updateServiceStatus(state.health, null); renderPackState(); } await restoreGeneration(); };
  const updateSettings = () => { const settings = $('[data-testid="video-settings"]'); if (settings) { settings.dataset.style = state.style; settings.dataset.resolution = state.resolution; settings.querySelectorAll('span')[1].innerHTML = `<strong>${costs[state.style][state.resolution]} credits</strong> per video`; } const button = $('[data-testid="generate-video"]'); if (button) { button.disabled = false; button.textContent = `Prepare video · ${costs[state.style][state.resolution]} credits`; button.removeAttribute('title'); } };
  const wirePhoto = (id, role) => { const input = document.getElementById(id); if (!input || input.dataset.localWired) return; input.dataset.localWired = 'true'; input.disabled = false; input.removeAttribute('title'); input.addEventListener('change', () => { const file = input.files?.[0]; const label = input.closest('label'); const old = label?.querySelector('.local-photo-preview'); if (!file || !allowed.has(file.type) || file.size <= 0 || file.size > maxBytes) { input.value = ''; state[role] = null; old?.remove(); if (label) { const strong = label.querySelector('strong'); if (strong) strong.textContent = 'Add photo'; } setFeedback(`${role === 'lead' ? 'First-timer' : 'Regular'} photo must be JPG, PNG or WebP and no larger than 10 MB.`, 'error'); return; } state[role] = file; if (label) label.querySelector('strong').textContent = file.name; old?.remove(); const img = document.createElement('img'); img.alt = `${role} photo preview`; img.src = URL.createObjectURL(file); img.className = 'local-photo-preview'; label?.prepend(img); setFeedback(`${role === 'lead' ? 'First-timer' : 'Regular'} photo ready.`, 'success'); }); };
  const generationKey = (userId) => `fancycafe:generation:${userId}`;
  const generationRead = (userId) => {
    if (!userId) return null;
    try { return JSON.parse(sessionStorage.getItem(generationKey(userId)) || 'null'); } catch { return null; }
  };
  const generationWrite = (userId, job) => {
    if (!userId) return;
    try {
      if (job) sessionStorage.setItem(generationKey(userId), JSON.stringify(job));
      else sessionStorage.removeItem(generationKey(userId));
    } catch {}
  };
  const generationDownload = (value) => {
    try {
      const url = new URL(value, window.location.origin);
      return url.origin === window.location.origin && (url.protocol === 'https:' || url.protocol === 'http:');
    } catch { return false; }
  };
  const renderGeneration = (job) => {
    if (!job) return;
    if (job.status === 'completed' && (generationDownload(job.previewUrl) || generationDownload(job.downloadUrl))) {
      const previewUrl = generationDownload(job.previewUrl) ? job.previewUrl : null;
      const downloadUrl = generationDownload(job.downloadUrl) ? job.downloadUrl : null;
      let video = $('[data-generation-video]');
      if (!video) {
        video = document.createElement('video');
        video.dataset.generationVideo = '';
        video.controls = true;
        ($('.studio-action') || document.body).append(video);
      }
      if (previewUrl) {
        video.src = previewUrl;
        video.load();
      }
      let link = $('[data-generation-download]');
      if (!link) {
        link = document.createElement('a');
        link.dataset.generationDownload = '';
        link.className = 'cafe-text-link';
        ($('.studio-action') || document.body).append(link);
      }
      if (downloadUrl) {
        link.href = downloadUrl;
        link.download = '';
      }
      link.textContent = 'Download completed MP4';
      setFeedback('Video completed.', 'success');
    } else if (job.status === 'failed') {
      setFeedback(job.message || 'Video generation failed. No retry was started.', 'warning');
    } else if (job.status === 'unknown') {
      setFeedback('The server returned an unknown status. No retry was started.', 'warning');
    } else {
      setFeedback(`Video ${job.status || 'submitted'}…`);
    }
  };
  const generationLatest = async (requestId) => {
    const result = await api(`/api/generations/latest?requestId=${encodeURIComponent(requestId)}`);
    return result.response.ok && result.data?.job?.requestId === requestId ? result.data.job : null;
  };
  const generationPoll = async (userId, job) => {
    let current = job;
    const statusButton = ensureGenerationStatusButton();
    if (statusButton) statusButton.hidden = true;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      generationWrite(userId, current);
      renderGeneration(current);
      if (['completed', 'failed', 'unknown'].includes(current.status)) {
        if (statusButton) statusButton.hidden = current.status !== 'unknown';
        if (current.status === 'completed') {
          const billing = await api('/api/billing');
          if (billing.response.ok && billing.data) renderBilling(billing.data);
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        const result = await api(`/api/generations/${encodeURIComponent(current.id)}`);
        if (result.response.ok && result.data?.job) current = result.data.job;
      } catch {
        const statusButton = $('[data-testid="check-video-status"]');
        if (statusButton) statusButton.hidden = false;
        setFeedback('Status check was interrupted. The job remains saved; use Check status to continue.', 'warning');
        return;
      }
    }
    const timeoutButton = $('[data-testid="check-video-status"]');
    if (timeoutButton) timeoutButton.hidden = false;
    setFeedback('This job is still processing. It remains saved; use Check status to continue.', 'warning');
  };
  const ensureGenerationStatusButton = () => {
    const generateButton = $('[data-testid="generate-video"]');
    if (!generateButton) return null;
    let statusButton = $('[data-testid="check-video-status"]');
    if (!statusButton) {
      statusButton = document.createElement('button');
      statusButton.type = 'button';
      statusButton.dataset.testid = 'check-video-status';
      statusButton.textContent = 'Check video status';
      statusButton.hidden = true;
      statusButton.addEventListener('click', () => restoreGeneration());
      generateButton.parentElement?.append(statusButton);
    }
    return statusButton;
  };
  const restoreGeneration = async () => {
    if (!$('[data-testid="generate-video"]')) return;
    const userId = state.auth?.user?.id;
    const saved = generationRead(userId);
    if (!userId) return;
    const job = saved?.status === 'completed'
      ? saved
      : saved?.requestId
        ? await generationLatest(saved.requestId).catch(() => null)
        : (await api('/api/generations/latest').catch(() => ({ response: { ok: false }, data: {} }))).data?.job;
    if (job?.userId && job.userId !== userId) return;
    if (job) await generationPoll(userId, job);
    else if (saved?.requestId) { ensureGenerationStatusButton().hidden = false; setFeedback('Saved generation request was not found. No retry was started.', 'warning'); }
  };
  const wireGenerationController = () => {
    const button = $('[data-testid="generate-video"]');
    if (!button || button.dataset.generationController) return;
    button.dataset.generationController = 'true';
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const userId = state.auth?.user?.id;
      if (!state.auth?.authenticated) return window.location.assign(`/auth/google/start?returnTo=${encodeURIComponent(relativeReturnTo())}`);
      if (!state.csrfToken || !state.lead) {
        return setFeedback(!state.csrfToken
          ? 'Generation is unavailable because the session CSRF token is missing.'
          : 'Add the required first-timer photo before preparing a video.', 'warning');
      }
      const saved = generationRead(userId);
      if (saved && !['completed', 'failed'].includes(saved.status)) {
        return setFeedback('A video request is already in progress. No duplicate request was sent.', 'warning');
      }
      const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      generationWrite(userId, { requestId, userId, status: 'submitting' });
      const body = new FormData();
      body.append('lead', state.lead, state.lead.name);
      if (state.regular) body.append('regular', state.regular, state.regular.name);
      body.append('style', state.style);
      body.append('resolution', state.resolution);
      body.append('requestId', requestId);
      button.disabled = true;
      try {
        const result = await api('/api/generate', {
          method: 'POST',
          headers: { 'X-CSRF-Token': state.csrfToken },
          body,
          timeoutMs: 15000,
        });
        let job = result.data?.job;
        if (!result.response.ok && result.response.status < 500) {
          generationWrite(userId, null);
          return setFeedback(result.data?.message || result.data?.code || 'Video request was rejected.', 'error');
        }
        if (!result.response.ok || !job?.id) job = await generationLatest(requestId).catch(() => null);
        if (!job) return setFeedback('Request status could not be confirmed. No retry was started; use Check status.', 'warning');
        await generationPoll(userId, job);
      } catch {
        const job = await generationLatest(requestId).catch(() => null);
        if (job) await generationPoll(userId, job);
        else setFeedback('Request status could not be confirmed. No retry was started; use Check status.', 'warning');
      } finally {
        button.disabled = false;
      }
    });
  };
  const wireTestCharacter = () => {
    if (new URLSearchParams(window.location.search).get('sample') !== '1' || !state.auth?.authenticated) return;
    const input = document.getElementById('photo-lead'); const parent = input?.closest('label');
    if (!input || !parent || parent.querySelector('[data-testid="use-test-character"]')) return;
    const button = document.createElement('button'); button.type = 'button'; button.dataset.testid = 'use-test-character'; button.className = 'cafe-text-link'; button.textContent = 'Use test character';
    button.addEventListener('click', async () => {
      try {
        const response = await fetch('/media/fancy-cafe/test-character.png', { credentials: 'same-origin' });
        if (!response.ok) throw new Error('test character unavailable');
        const file = new File([await response.blob()], 'test-character.png', { type: 'image/png' });
        if (typeof DataTransfer === 'function') { const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files; } else Object.defineProperty(input, 'files', { configurable: true, value: [file] });
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } catch { setFeedback('The test character could not be loaded.', 'warning'); }
    });
    parent.append(button);
  };
  document.addEventListener('DOMContentLoaded', async () => {
    addStyles();
    wireGenerationController();
    wirePhoto('photo-lead', 'lead');
    wirePhoto('photo-keyboard', 'regular');
    document.querySelectorAll('.studio-quality fieldset[disabled]').forEach((field) => field.removeAttribute('disabled'));
    ['[data-testid="video-style-standard"]', '[data-testid="video-style-closer"]', '[data-testid="video-resolution-480p"]', '[data-testid="video-resolution-720p"]', '[data-testid="generate-free-preview"]', '[data-testid="generate-video"]'].forEach((s) => { const node = $(s); if (node) { node.disabled = false; node.removeAttribute('title'); } });
[['[data-testid="video-style-standard"]', 'standard'], ['[data-testid="video-style-closer"]', 'closer']].forEach(([selector, value]) => $(selector)?.addEventListener('click', () => { state.style = value; document.querySelectorAll('[data-testid^="video-style-"]').forEach((b) => b.setAttribute('aria-pressed', String(b === $(selector)))); updateSettings(); })); [['[data-testid="video-resolution-480p"]', '480p'], ['[data-testid="video-resolution-720p"]', '720p']].forEach(([selector, value]) => $(selector)?.addEventListener('click', () => { state.resolution = value; document.querySelectorAll('[data-testid^="video-resolution-"]').forEach((b) => b.setAttribute('aria-pressed', String(b === $(selector)))); updateSettings(); })); $('[data-testid="generate-free-preview"]')?.addEventListener('click', () => setFeedback('Free keyframe preview is unavailable until Google sign-in and an AI image provider are configured.', 'warning')); updateSettings(); await wireAuth(); wireTestCharacter(); await wireBilling(); await restoreGeneration(); });
  globalThis.__fancyCafeGeneration = { sameOriginDownload: generationDownload, storageKey: generationKey, statusText: (job) => job.status === 'completed' ? 'Video completed.' : job.status === 'failed' ? (job.message || 'Video generation failed.') : job.status === 'unknown' ? 'The server returned an unknown status.' : `Video ${job.status || 'submitted'}…`, configure(options) { Object.assign(state, options); return state; }, restoreGeneration };
})();
