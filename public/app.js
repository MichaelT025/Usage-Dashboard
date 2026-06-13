const REFRESH_INTERVAL_MS = 180_000; // 3 minutes default; overridable

let refreshTimer = null;
let isRefreshing = false;

// --- Fetch & render ---

async function fetchStatus() {
  const res = await fetch('/api/status');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function refresh(manual = false) {
  if (isRefreshing) return;
  isRefreshing = true;
  const btn = document.getElementById('refresh-btn');
  if (btn) btn.disabled = true;

  try {
    const data = await fetchStatus();
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
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// Tick countdowns every second
setInterval(updateCountdowns, 1000);

function updateLastUpdated(generatedAt) {
  const el = document.getElementById('last-updated');
  if (el) el.textContent = 'Updated ' + new Date(generatedAt).toLocaleTimeString();
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
}

// --- Wiring ---

document.getElementById('refresh-btn')?.addEventListener('click', () => refresh(true));
// Settings btn placeholder — T15 will wire this
document.getElementById('settings-btn')?.addEventListener('click', () => {
  document.getElementById('settings-modal')?.classList.toggle('hidden');
});

// Initial load
refresh();
