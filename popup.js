// popup.js

// ── LinkedIn URL extraction ───────────────────────────────────────────────────

const LINKEDIN_URL_RE = /https?:\/\/(?:www\.)?linkedin\.com\/[^\s"'<>\])]*/gi;

function extractLinkedInUrls(text) {
  const raw = text.match(LINKEDIN_URL_RE) || [];
  // Deduplicate and clean trailing punctuation
  const cleaned = raw.map(u => u.replace(/[.,;:!?]+$/, '').trim());
  return [...new Set(cleaned)];
}

// ── DOM refs ──────────────────────────────────────────────────────────────────

const fileInput       = document.getElementById('file-input');
const fileLabelText   = document.getElementById('file-label-text');
const fileLabel       = fileInput.closest('label');
const urlCountEl      = document.getElementById('url-count');
const settingsSection = document.getElementById('settings-section');
const startBtn        = document.getElementById('start-btn');
const stopBtn         = document.getElementById('stop-btn');
const statusSection   = document.getElementById('status-section');
const progressBar     = document.getElementById('progress-bar');
const progressText    = document.getElementById('progress-text');
const currentUrlEl    = document.getElementById('current-url');
const waitTextEl      = document.getElementById('wait-text');
const urlListSection  = document.getElementById('url-list-section');
const urlListEl       = document.getElementById('url-list');
const listCountEl     = document.getElementById('list-count');
const minWaitEl       = document.getElementById('min-wait');
const maxWaitEl       = document.getElementById('max-wait');

let parsedUrls = [];

// ── File handling ─────────────────────────────────────────────────────────────

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    parsedUrls = extractLinkedInUrls(e.target.result);

    fileLabelText.textContent = file.name;
    fileLabel.classList.add('has-file');

    if (parsedUrls.length === 0) {
      urlCountEl.textContent = 'No LinkedIn URLs found in file.';
      startBtn.disabled = true;
    } else {
      urlCountEl.textContent = `Found ${parsedUrls.length} LinkedIn URL${parsedUrls.length !== 1 ? 's' : ''}`;
      startBtn.disabled = false;
      renderUrlList(parsedUrls);
      settingsSection.classList.remove('hidden');
      urlListSection.classList.remove('hidden');
    }
  };
  reader.readAsText(file);
});

// ── URL list render ───────────────────────────────────────────────────────────

function renderUrlList(urls, currentUrl = null, visitedUrls = []) {
  urlListEl.innerHTML = '';
  listCountEl.textContent = `(${urls.length + visitedUrls.length})`;

  visitedUrls.forEach(u => {
    const li = document.createElement('li');
    li.textContent = u;
    li.className = 'visited';
    li.title = u;
    urlListEl.appendChild(li);
  });

  if (currentUrl) {
    const li = document.createElement('li');
    li.textContent = currentUrl;
    li.className = 'active';
    li.title = currentUrl;
    urlListEl.appendChild(li);
  }

  urls.forEach(u => {
    const li = document.createElement('li');
    li.textContent = u;
    li.title = u;
    urlListEl.appendChild(li);
  });
}

// ── Progress update ───────────────────────────────────────────────────────────

function updateProgress(stats, currentUrl, waitSec) {
  const pct = stats.total > 0 ? (stats.done / stats.total) * 100 : 0;
  progressBar.style.width = `${pct}%`;
  progressText.textContent = `${stats.done} / ${stats.total} visited`;

  if (currentUrl) {
    currentUrlEl.textContent = currentUrl;
    waitTextEl.textContent = '';
  } else if (waitSec) {
    currentUrlEl.textContent = '';
    waitTextEl.textContent = `Waiting ${waitSec}s before next visit…`;
  } else {
    currentUrlEl.textContent = '';
    waitTextEl.textContent = '';
  }
}

// ── Controls ──────────────────────────────────────────────────────────────────

startBtn.addEventListener('click', async () => {
  if (parsedUrls.length === 0) return;

  const minWait = parseInt(minWaitEl.value, 10) || 45;
  const maxWait = parseInt(maxWaitEl.value, 10) || 180;

  // Persist custom wait range for background to use
  await chrome.storage.local.set({ waitMin: minWait, waitMax: maxWait });

  startBtn.classList.add('hidden');
  stopBtn.classList.remove('hidden');
  statusSection.classList.remove('hidden');
  settingsSection.classList.add('hidden');

  updateProgress({ done: 0, total: parsedUrls.length }, null, null);

  await chrome.runtime.sendMessage({ type: 'start', urls: parsedUrls });
});

stopBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'stop' });
  stopBtn.classList.add('hidden');
  startBtn.classList.remove('hidden');
  startBtn.disabled = parsedUrls.length === 0;
  waitTextEl.textContent = 'Stopped.';
  currentUrlEl.textContent = '';
});

// ── Incoming messages from background ────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status') {
    updateProgress(msg.stats, msg.current, null);

    // Sync list display from storage
    chrome.storage.local.get(['queue', 'visited', 'current']).then(data => {
      renderUrlList(data.queue || [], data.current, data.visited || []);
    });

  } else if (msg.type === 'waiting') {
    updateProgress(
      /* stats will be refreshed on next status event */ { done: 0, total: 0 },
      null, msg.seconds
    );
    // Refresh stats from storage
    chrome.storage.local.get('stats').then(data => {
      if (data.stats) progressText.textContent = `${data.stats.done} / ${data.stats.total} visited`;
    });

  } else if (msg.type === 'complete') {
    progressBar.style.width = '100%';
    progressText.textContent = 'All done!';
    currentUrlEl.textContent = '';
    waitTextEl.textContent = '';
    stopBtn.classList.add('hidden');
    startBtn.classList.remove('hidden');
    startBtn.disabled = true;

  } else if (msg.type === 'stopped') {
    stopBtn.classList.add('hidden');
    startBtn.classList.remove('hidden');
    startBtn.disabled = parsedUrls.length === 0;

  } else if (msg.type === 'error') {
    waitTextEl.textContent = `Error: ${msg.message}`;
    stopBtn.classList.add('hidden');
    startBtn.classList.remove('hidden');
    startBtn.disabled = parsedUrls.length === 0;
  }
});

// ── Restore state when popup reopens ─────────────────────────────────────────

(async () => {
  const state = await chrome.runtime.sendMessage({ type: 'get_state' });
  if (!state || !state.running) return;

  // A session is in progress — show live status
  startBtn.classList.add('hidden');
  stopBtn.classList.remove('hidden');
  statusSection.classList.remove('hidden');
  settingsSection.classList.add('hidden');

  parsedUrls = state.queue;
  updateProgress(state.stats, state.current, null);
  renderUrlList(state.queue, state.current, state.visited);
})();
