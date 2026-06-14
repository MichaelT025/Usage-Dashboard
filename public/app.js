let refreshIntervalMs = 180_000; // default; synced from /api/config on load

let refreshTimer = null;
let isRefreshing = false;

let activeFilter = 'all';      // persists across re-renders
let latestProviders = [];      // last fetched providers array (for re-filter on pill click)

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
    scheduleAutoRefresh(refreshIntervalMs);
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

// --- Filtering ---

function applyFilter(providers) {
  // Always exclude not_implemented from everything
  const active = providers.filter(p => p.state !== 'not_implemented');
  if (activeFilter === 'connected') return active.filter(p => p.state === 'ok');
  if (activeFilter === 'attention') return active.filter(p => p.state !== 'ok');
  return active; // 'all'
}

function computeCounts(providers) {
  const active = providers.filter(p => p.state !== 'not_implemented');
  return {
    all: active.length,
    connected: active.filter(p => p.state === 'ok').length,
    attention: active.filter(p => p.state !== 'ok').length,
  };
}

// --- Provider card rendering ---

function renderProviders(providers) {
  latestProviders = providers;
  const grid = document.getElementById('providers-grid');
  const emptyEl = document.querySelector('.grid-empty');
  if (!grid) return;

  // Update pill counts
  const counts = computeCounts(providers);
  document.querySelectorAll('.filter-pill').forEach(btn => {
    const f = btn.dataset.filter;
    const countEl = btn.querySelector('.pill-count');
    if (countEl) countEl.textContent = counts[f] ?? '';
  });

  const shown = applyFilter(providers);

  if (shown.length === 0) {
    grid.innerHTML = '';
    grid.style.display = 'none';
    if (emptyEl) emptyEl.classList.remove('hidden');
  } else {
    if (emptyEl) emptyEl.classList.add('hidden');
    grid.style.display = '';
    grid.innerHTML = shown.map(renderCard).join('');
    // Programmatic icon fallback (no inline onerror — module scope not visible in HTML strings)
    grid.querySelectorAll('img.provider-icon').forEach(img => {
      img.onerror = () => img.replaceWith(monogramTile(img.dataset.monogram || '?'));
    });
  }

  startCountdowns();
}

function monogramTile(letter) {
  const el = document.createElement('span');
  el.className = 'provider-icon is-monogram';
  el.textContent = String(letter).charAt(0).toUpperCase();
  return el;
}

function renderCard(provider) {
  const monogram = escHtml(provider.displayName.trim().charAt(0).toUpperCase());
  const iconImg = `<img class="provider-icon" src="icons/${escHtml(provider.providerId)}.svg" alt="" data-monogram="${monogram}">`;

  if (provider.state === 'ok') {
    return `
      <article class="provider-card state-ok" data-provider="${escHtml(provider.providerId)}">
        <div class="card-header">
          ${iconImg}
          <h2 class="card-title">${escHtml(provider.displayName)}</h2>
          ${provider.plan ? `<span class="card-plan">${escHtml(provider.plan)}</span>` : ''}
          <span class="status-dot dot-ok" title="OK"></span>
        </div>
        <div class="card-body">
          ${provider.windows.map(renderWindow).join('')}
          ${provider.credits ? renderCredits(provider.credits) : ''}
        </div>
      </article>`;
  }
  const stateLabel = { unavailable: 'Unavailable', unconfigured: 'Not Configured' }[provider.state] ?? provider.state;
  const hint = provider.error?.hint ?? '';
  const code = provider.error?.code ?? '';
  const dotClass = provider.state === 'unavailable' ? 'dot-error' : 'dot-warn';
  return `
    <article class="provider-card state-${escHtml(provider.state)}" data-provider="${escHtml(provider.providerId)}">
      <div class="card-header">
        ${iconImg}
        <h2 class="card-title">${escHtml(provider.displayName)}</h2>
        <span class="status-dot ${dotClass}" title="${escHtml(stateLabel)}"></span>
      </div>
      <div class="card-body">
        <div class="error-body">
          <p class="error-label">${escHtml(stateLabel)}</p>
          ${code ? `<code class="error-code">${escHtml(code)}</code>` : ''}
          ${hint ? `<p class="error-hint">${escHtml(hint)}</p>` : ''}
        </div>
      </div>
    </article>`;
}

function renderWindow(win) {
  const pct = Math.min(100, Math.max(0, win.usedPercent));
  const colorClass = pct >= 100 ? 'bar-critical' : pct >= 80 ? 'bar-warning' : 'bar-ok';
  const barOpacity = (0.4 + (pct / 100) * 0.6).toFixed(2);
  return `
    <div class="window-row">
      <div class="window-meta">
        <span class="window-label">${escHtml(win.label)}</span>
      </div>
      <div class="window-bar-row">
        <div class="progress-bar-track">
          <div class="progress-bar ${colorClass}"
               style="width:${pct}%;--bar-opacity:${barOpacity}"
               role="progressbar"
               aria-valuenow="${pct}"
               aria-valuemin="0"
               aria-valuemax="100"
               aria-label="${escHtml(win.label)}"></div>
        </div>
        <span class="window-pct">${pct}% used</span>
      </div>
      <span class="window-countdown" data-resets-at="${escHtml(win.resetsAt)}">…</span>
    </div>`;
}

function renderCredits(credits) {
  const parts = [];
  if (credits.balanceUsd != null) parts.push(`$${credits.balanceUsd.toFixed(2)}`);
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

// Keep the "X ago" label ticking every minute
setInterval(renderLastUpdated, 60000);

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
}

// --- Wiring ---

document.getElementById('refresh-btn')?.addEventListener('click', () => refresh(true));

// Sync refresh interval from server config on load
(async function initRefreshInterval() {
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    if (cfg.refreshIntervalSec) refreshIntervalMs = cfg.refreshIntervalSec * 1000;
  } catch { /* keep default */ }
})();

// Initial load
refresh();

// Filter pill wiring
document.querySelectorAll('.filter-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    if (isRefreshing) return; // don't interfere during refresh
    activeFilter = btn.dataset.filter;
    // Update active state + aria
    document.querySelectorAll('.filter-pill').forEach(b => {
      b.classList.toggle('is-active', b === btn);
      b.setAttribute('aria-pressed', String(b === btn));
    });
    // Re-render from cached data (no network call)
    renderProviders(latestProviders);
  });
});

// ─── Settings Drawer ──────────────────────────────────────────────

function initDrawer() {
  const drawer = document.getElementById('settings-drawer');
  const gearBtn = document.getElementById('settings-btn');
  if (!drawer || !gearBtn) return;

  let loaded = false;

  function openDrawer() {
    drawer.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    if (!loaded) {
      loaded = true;
      loadConfigStatus();
    }
  }

  function closeDrawer() {
    drawer.classList.remove('is-open');
    document.body.style.overflow = '';
    loaded = false; // reset so config reloads on next open (preserves original behavior)
    gearBtn.focus();
  }

  gearBtn.addEventListener('click', openDrawer);

  drawer.querySelector('.drawer-backdrop')?.addEventListener('click', closeDrawer);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && drawer.classList.contains('is-open')) {
      closeDrawer();
    }
  });

  async function loadConfigStatus() {
    const panel = drawer.querySelector('.drawer-panel');
    if (!panel) return;
    try {
      const data = await fetch('/api/config').then(r => r.json());
      renderDrawer(panel, data);
    } catch {
      panel.innerHTML = '<p style="padding:1rem;color:var(--crit)">Failed to load config</p>';
    }
  }

  function renderDrawer(panel, s) {
    panel.innerHTML = `
      <div class="drawer-header">
        <h2 class="drawer-title">Settings</h2>
        <button id="drawer-close" type="button" title="Close">&#x2715;</button>
      </div>
      <div class="settings-section">
        <h3>Provider Status</h3>
        <div class="status-row"><span>Claude</span>
          <span class="${s.claudeTokenFound ? 'status-ok' : 'status-warn'}">${s.claudeTokenFound ? '✓ configured' : '✗ run `claude`'}</span></div>
        <div class="status-row"><span>Codex</span>
          <span class="${s.codexTokenFound ? 'status-ok' : 'status-warn'}">${s.codexTokenFound ? '✓ configured' : '✗ run `codex login`'}</span></div>
        <div class="status-row"><span>OpenCode Go workspace</span>
          <span class="${s.opencodeWorkspaceIdSet ? 'status-ok' : 'status-warn'}">${s.opencodeWorkspaceIdSet ? '✓ set' : '✗ not set'}</span></div>
        <div class="status-row"><span>OpenCode Go cookie</span>
          <span class="${s.opencodeAuthCookieSet ? 'status-ok' : 'status-warn'}">${s.opencodeAuthCookieSet ? '✓ set' : '✗ not set'}</span></div>
      </div>
      <div class="settings-section">
        <h3>OpenCode Go</h3>
        <p class="settings-hint">Workspace ID is in the opencode.ai URL: /workspace/<strong>wrk_…</strong>/go</p>
        <label class="settings-label">Workspace ID
          <input type="text" id="s-wsid" placeholder="wrk_YOUR_ID_HERE" autocomplete="off"/>
        </label>
        <p class="settings-hint">Copy the <code>auth</code> cookie from browser DevTools</p>
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
        <button class="btn-save" id="s-save" type="button">Save</button>
      </div>`;

    // Wire close button (rendered dynamically)
    document.getElementById('drawer-close')?.addEventListener('click', closeDrawer);
    document.getElementById('s-cancel')?.addEventListener('click', closeDrawer);
    document.getElementById('s-save')?.addEventListener('click', doSave);

    const closeBtn = document.getElementById('drawer-close');
    if (closeBtn) closeBtn.focus();
  }

  async function doSave() {
    const wsid = document.getElementById('s-wsid')?.value?.trim();
    const cookie = document.getElementById('s-cookie')?.value?.trim();
    const interval = parseInt(document.getElementById('s-interval')?.value ?? '180', 10);
    const payload = {};
    if (wsid) payload.opencodeWorkspaceId = wsid;
    if (cookie) payload.opencodeAuthCookie = cookie;
    if (interval >= 30) payload.refreshIntervalSec = interval;

    const fb = document.getElementById('s-feedback');
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
        if (interval >= 30) refreshIntervalMs = interval * 1000;
        const cookieEl = document.getElementById('s-cookie');
        if (cookieEl) cookieEl.value = ''; // never echo stored value
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
}

// Call at bottom of module
initDrawer();
