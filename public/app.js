const REFRESH_INTERVAL_MS = 180_000; // 3 minutes default; overridable

let refreshTimer = null;
let isRefreshing = false;

// --- Fetch & render ---

async function fetchStatus() {
  const res = await fetch('/api/status');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function triggerBackendRefresh() {
  const res = await fetch('/api/refresh', { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function refresh(manual = false) {
  if (isRefreshing) return;
  isRefreshing = true;
  const btn = document.getElementById('refresh-btn');
  if (btn) btn.disabled = true;

  try {
    const data = manual ? await triggerBackendRefresh() : await fetchStatus();
    renderProviders(data.providers);
    updateLastUpdated(data.generatedAt);
    scheduleAutoRefresh(REFRESH_INTERVAL_MS);
  } catch (err) {
    // Show error state but don't clear existing cards
    console.error('Refresh failed:', err.message);
  } finally {
    isRefreshing = false;
    if (btn) btn.disabled = false;
  }
}

function scheduleAutoRefresh(ms) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh(), ms);
}

// --- Provider card rendering ---

function renderProviders(providers) {
  const grid = document.getElementById('providers-grid');
  if (!grid) return;
  // Filter out not_implemented providers
  const active = providers.filter(p => p.state !== 'not_implemented');
  grid.innerHTML = active.map(renderCard).join('');
  // Start live countdowns
  startCountdowns();
}

function renderCard(provider) {
  if (provider.state === 'ok') {
    return `
      <article class="provider-card state-ok" data-provider="${provider.providerId}">
        <header class="card-header">
          <h2 class="card-title">${escHtml(provider.displayName)}</h2>
          ${provider.plan ? `<span class="card-plan">${escHtml(provider.plan)}</span>` : ''}
          <span class="status-dot dot-ok" title="OK"></span>
        </header>
        <div class="windows">
          ${provider.windows.map(renderWindow).join('')}
        </div>
        ${provider.credits ? renderCredits(provider.credits) : ''}
      </article>`;
  }
  // unavailable, unconfigured, or error state
  const stateLabel = { unavailable: 'Unavailable', unconfigured: 'Not Configured' }[provider.state] ?? provider.state;
  const hint = provider.error?.hint ?? '';
  const code = provider.error?.code ?? '';
  const dotClass = provider.state === 'unavailable' ? 'dot-error' : 'dot-warn';
  return `
    <article class="provider-card state-${provider.state}" data-provider="${provider.providerId}">
      <header class="card-header">
        <h2 class="card-title">${escHtml(provider.displayName)}</h2>
        <span class="status-dot ${dotClass}" title="${stateLabel}"></span>
      </header>
      <div class="error-body">
        <p class="error-label">${escHtml(stateLabel)}</p>
        ${code ? `<code class="error-code">${escHtml(code)}</code>` : ''}
        ${hint ? `<p class="error-hint">${escHtml(hint)}</p>` : ''}
      </div>
    </article>`;
}

function renderWindow(win) {
  const pct = Math.min(100, Math.max(0, win.usedPercent));
  const colorClass = pct >= 100 ? 'bar-critical' : pct >= 80 ? 'bar-warning' : 'bar-ok';
  return `
    <div class="window-row">
      <div class="window-meta">
        <span class="window-label">${escHtml(win.label)}</span>
        <span class="window-pct">${pct}%</span>
        <span class="window-countdown" data-resets-at="${win.resetsAt}">…</span>
      </div>
      <div class="progress-bar-track">
        <div class="progress-bar ${colorClass}" style="width:${pct}%"></div>
      </div>
    </div>`;
}

function renderCredits(credits) {
  const parts = [];
  if (credits.balanceUsd != null) parts.push(`Balance: $${credits.balanceUsd.toFixed(2)}`);
  if (credits.valueUsd != null) parts.push(`Used: $${credits.valueUsd.toFixed(2)}`);
  return parts.length ? `<p class="credits-row">${escHtml(credits.label)}: ${parts.join(' · ')}</p>` : '';
}

// --- Live countdown ticking ---

function startCountdowns() {
  updateCountdowns();
}

function updateCountdowns() {
  const now = Date.now();
  document.querySelectorAll('.window-countdown').forEach(el => {
    const resetsAt = el.dataset.resetsAt;
    if (!resetsAt) return;
    const delta = new Date(resetsAt).getTime() - now;
    el.textContent = delta <= 0 ? 'resetting…' : 'resets in ' + formatDuration(delta);
  });
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const totalMin = Math.floor(s / 60);
  const totalH = Math.floor(s / 3600);
  const totalD = Math.floor(s / 86400);
  const remH = totalH % 24;
  const remM = totalMin % 60;
  const remS = s % 60;
  if (totalD >= 1) return `${totalD}d ${remH}h`;
  if (totalH >= 1) return `${totalH}h ${remM}m`;
  if (totalMin >= 1) return `${totalMin}m ${remS}s`;
  return `${remS}s`;
}

// Tick countdowns every second
setInterval(updateCountdowns, 1000);

let lastGeneratedAt = null;

function updateLastUpdated(generatedAt) {
  lastGeneratedAt = generatedAt;
  renderLastUpdated();
}

function renderLastUpdated() {
  const el = document.getElementById('last-updated');
  if (!el || !lastGeneratedAt) return;
  const diffMs = Date.now() - new Date(lastGeneratedAt).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 5)  { el.textContent = 'updated just now'; return; }
  if (diffSec < 60) { el.textContent = `updated ${diffSec}s ago`; return; }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) { el.textContent = `updated ${diffMin}m ago`; return; }
  const diffH = Math.floor(diffMin / 60);
  el.textContent = `updated ${diffH}h ago`;
}

// Keep the "X ago" label ticking every 5 seconds
setInterval(renderLastUpdated, 5000);

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
}

// --- Wiring ---

document.getElementById('refresh-btn')?.addEventListener('click', () => refresh(true));

// Initial load
refresh();

// ─── Settings Modal ───────────────────────────────────────────────

(function initSettings() {
  const modal  = document.getElementById('settings-modal');
  const gearBtn = document.getElementById('settings-btn');
  if (!modal || !gearBtn) return;

  let loaded = false;

  gearBtn.addEventListener('click', async () => {
    modal.classList.toggle('hidden');
    if (!modal.classList.contains('hidden') && !loaded) {
      loaded = true;
      await loadConfigStatus();
    }
  });

  async function loadConfigStatus() {
    try {
      const data = await fetch('/api/config').then(r => r.json());
      renderModal(data);
    } catch {
      modal.innerHTML = '<div class="modal-content"><p style="padding:1rem;color:#f87171">Failed to load config</p></div>';
    }
  }

  function renderModal(s) {
    modal.innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop"></div>
      <div class="modal-content">
        <div class="modal-header">
          <h2>Settings</h2>
          <button class="modal-close" id="modal-close" type="button">✕</button>
        </div>
        <div class="modal-body">
          <div class="settings-section">
            <h3>Provider Status</h3>
            <div class="status-row"><span>Claude</span>
              <span class="${s.claudeTokenFound?'status-ok':'status-warn'}">${s.claudeTokenFound?'✓ configured':'✗ run `claude` to login'}</span></div>
            <div class="status-row"><span>Codex</span>
              <span class="${s.codexTokenFound?'status-ok':'status-warn'}">${s.codexTokenFound?'✓ configured':'✗ run `codex login`'}</span></div>
            <div class="status-row"><span>OpenCode Go workspace</span>
              <span class="${s.opencodeWorkspaceIdSet?'status-ok':'status-warn'}">${s.opencodeWorkspaceIdSet?'✓ set':'✗ not set'}</span></div>
            <div class="status-row"><span>OpenCode Go cookie</span>
              <span class="${s.opencodeAuthCookieSet?'status-ok':'status-warn'}">${s.opencodeAuthCookieSet?'✓ set':'✗ not set'}</span></div>
          </div>
          <div class="settings-section">
            <h3>OpenCode Go</h3>
            <p class="settings-hint">Workspace ID is in the opencode.ai URL: /workspace/<strong>wrk_…</strong>/go</p>
            <label class="settings-label">Workspace ID
              <input type="text" id="s-wsid" placeholder="wrk_YOUR_ID_HERE" autocomplete="off"/>
            </label>
            <p class="settings-hint">Copy the <code>auth</code> cookie from browser DevTools after logging into opencode.ai</p>
            <label class="settings-label">Auth Cookie
              <input type="password" id="s-cookie" placeholder="Fe26.2**… (paste here)" autocomplete="new-password"/>
            </label>
          </div>
          <div class="settings-section">
            <h3>Refresh Interval</h3>
            <label class="settings-label">Seconds (min 30)
              <input type="number" id="s-interval" value="${escHtml(String(s.refreshIntervalSec))}" min="30" max="3600"/>
            </label>
          </div>
          <div id="s-feedback" class="s-feedback hidden"></div>
          <div class="modal-footer">
            <button class="btn-cancel" id="s-cancel" type="button">Cancel</button>
            <button class="btn-save"   id="s-save"   type="button">Save</button>
          </div>
        </div>
      </div>`;

    document.getElementById('modal-backdrop').addEventListener('click', close);
    document.getElementById('modal-close').addEventListener('click', close);
    document.getElementById('s-cancel').addEventListener('click', close);
    document.getElementById('s-save').addEventListener('click', doSave);
  }

  function close() {
    modal.classList.add('hidden');
    loaded = false;
  }

  async function doSave() {
    const wsid     = document.getElementById('s-wsid')?.value?.trim();
    const cookie   = document.getElementById('s-cookie')?.value?.trim();
    const interval = parseInt(document.getElementById('s-interval')?.value ?? '180', 10);
    const payload  = {};
    if (wsid)   payload.opencodeWorkspaceId  = wsid;
    if (cookie) payload.opencodeAuthCookie   = cookie;
    if (interval >= 30) payload.refreshIntervalSec = interval;

    const fb   = document.getElementById('s-feedback');
    const save = document.getElementById('s-save');
    if (save) save.disabled = true;
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({ error: 'Save failed' }));
        showFeedback(fb, '✗ ' + (d.error ?? 'Save failed'), 'error');
      } else {
        showFeedback(fb, '✓ Saved', 'success');
        const cookieEl = document.getElementById('s-cookie');
        if (cookieEl) cookieEl.value = '';   // never echo stored value
        setTimeout(() => refresh(true), 600);
      }
    } catch {
      showFeedback(fb, '✗ Network error', 'error');
    } finally {
      if (save) save.disabled = false;
    }
  }

  function showFeedback(el, msg, type) {
    if (!el) return;
    el.textContent = msg;
    el.className = 's-feedback ' + type;
  }
}());
