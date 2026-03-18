// background.js — service worker
// Manages the visit queue, navigation, and inter-visit delays via alarms.
// State is persisted in chrome.storage.local so it survives service worker restarts.

const ALARM_NEXT_VISIT = 'next_visit';

// ── Helpers ──────────────────────────────────────────────────────────────────

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Returns a delay in milliseconds weighted toward the middle of [minSec, maxSec].
function humanDelay(minSec, maxSec) {
  // Average of two uniform samples → bell-ish distribution
  const a = Math.random() * (maxSec - minSec) + minSec;
  const b = Math.random() * (maxSec - minSec) + minSec;
  return Math.round(((a + b) / 2) * 1000);
}

// ── State helpers ─────────────────────────────────────────────────────────────

async function getState() {
  const data = await chrome.storage.local.get(['queue', 'visited', 'current', 'tabId', 'running', 'stats']);
  return {
    queue:   data.queue   || [],
    visited: data.visited || [],
    current: data.current || null,
    tabId:   data.tabId   || null,
    running: data.running || false,
    stats:   data.stats   || { done: 0, total: 0 },
  };
}

async function setState(patch) {
  await chrome.storage.local.set(patch);
}

// ── Tab management ────────────────────────────────────────────────────────────

async function getOrCreateTab(existingTabId) {
  // Try to reuse the existing tab
  if (existingTabId) {
    try {
      const tab = await chrome.tabs.get(existingTabId);
      if (tab) return tab.id;
    } catch (_) { /* tab was closed */ }
  }
  // Create a new tab
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  await setState({ tabId: tab.id });
  return tab.id;
}

// ── Core visit logic ──────────────────────────────────────────────────────────

async function visitNext() {
  const state = await getState();

  if (!state.running || state.queue.length === 0) {
    await finish(state.queue.length === 0);
    return;
  }

  const [url, ...rest] = state.queue;
  await setState({ queue: rest, current: url });

  notifyPopup({ type: 'status', current: url, stats: state.stats });

  let tabId;
  try {
    tabId = await getOrCreateTab(state.tabId);
  } catch (err) {
    console.error('[LPV] Could not get/create tab:', err);
    await setState({ running: false });
    notifyPopup({ type: 'error', message: 'Could not open tab. Is a LinkedIn tab available?' });
    return;
  }

  // Navigate
  await chrome.tabs.update(tabId, { url, active: false });

  // Wait for page load then inject behavior script
  chrome.tabs.onUpdated.addListener(async function listener(updatedTabId, info) {
    if (updatedTabId !== tabId || info.status !== 'complete') return;
    chrome.tabs.onUpdated.removeListener(listener);

    // Small extra pause before the content script starts acting
    const preDelay = randomBetween(1500, 4000);
    await new Promise(r => setTimeout(r, preDelay));

    // Tell the content script to start human behavior
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'start_behavior' });
    } catch (err) {
      // Content script may not be ready (non-profile page, etc.) — move on
      console.warn('[LPV] Could not send message to content script:', err.message);
      await scheduleNext(state);
    }
  });
}

async function scheduleNext(stateSnapshot) {
  const state = await getState();

  const newVisited = [...state.visited, state.current].filter(Boolean);
  const newStats = { done: state.stats.done + 1, total: state.stats.total };

  await setState({ visited: newVisited, current: null, stats: newStats });

  notifyPopup({ type: 'status', current: null, stats: newStats });

  if (state.queue.length === 0) {
    await finish(true);
    return;
  }

  // Inter-visit delay: 45 s – 3 min, human-weighted
  const delaySec = humanDelay(45, 180) / 1000;
  const delayMs  = delaySec * 1000;

  console.log(`[LPV] Next visit in ${Math.round(delaySec)}s`);
  notifyPopup({ type: 'waiting', seconds: Math.round(delaySec) });

  // Use an alarm so the service worker can be suspended during the wait
  await chrome.alarms.create(ALARM_NEXT_VISIT, { delayInMinutes: delayMs / 60000 });
}

async function finish(completed) {
  await setState({ running: false, current: null });
  notifyPopup({ type: completed ? 'complete' : 'stopped' });
  console.log('[LPV] Finished.');
}

// ── Message bus ───────────────────────────────────────────────────────────────

function notifyPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => { /* popup may be closed */ });
}

// ── Event listeners ───────────────────────────────────────────────────────────

// Alarm fires → visit next URL
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NEXT_VISIT) {
    await visitNext();
  }
});

// Messages from popup or content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'start') {
      const { urls } = msg;
      await setState({
        queue:          urls,
        visited:        [],
        current:        null,
        running:        true,
        stats:          { done: 0, total: urls.length },
        scrapedProfiles: [],
      });
      await visitNext();
      sendResponse({ ok: true });

    } else if (msg.type === 'stop') {
      await chrome.alarms.clear(ALARM_NEXT_VISIT);
      await setState({ running: false });
      notifyPopup({ type: 'stopped' });
      sendResponse({ ok: true });

    } else if (msg.type === 'behavior_complete') {
      // Content script finished (with optional scraped data)
      const state = await getState();

      if (msg.data && !msg.skipped) {
        const stored = await chrome.storage.local.get('scrapedProfiles');
        const profiles = stored.scrapedProfiles || [];
        profiles.push(msg.data);
        await chrome.storage.local.set({ scrapedProfiles: profiles });
        notifyPopup({ type: 'profile_scraped', count: profiles.length });
      }

      await scheduleNext(state);
      sendResponse({ ok: true });

    } else if (msg.type === 'get_state') {
      const state = await getState();
      sendResponse(state);

    } else if (msg.type === 'get_profiles') {
      const stored = await chrome.storage.local.get('scrapedProfiles');
      sendResponse(stored.scrapedProfiles || []);
    }
  })();
  return true; // keep message channel open for async response
});
