// background.js — service worker
// Manages the visit queue, navigation, and inter-visit delays via alarms.
// State is persisted in chrome.storage.local so it survives service worker restarts.

const ALARM_NEXT_VISIT = 'next_visit';
const ALARM_WATCHDOG   = 'visit_watchdog';
const WATCHDOG_MINUTES = 8; // max time allowed for a single page visit before we consider it stalled

// ── Helpers ──────────────────────────────────────────────────────────────────

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── Badge helpers ─────────────────────────────────────────────────────────────

// Format the running badge text: "3/20", or just "12" when total > 99.
function badgeText(stats) {
  if (!stats || stats.total === 0) return '…';
  return stats.total > 99 ? String(stats.done) : `${stats.done}/${stats.total}`;
}

async function updateBadge(type, stats) {
  switch (type) {
    case 'running':
      await chrome.action.setBadgeBackgroundColor({ color: '#0a66c2' });
      await chrome.action.setBadgeText({ text: badgeText(stats) });
      break;
    case 'error':
      await chrome.action.setBadgeBackgroundColor({ color: '#b91c1c' });
      await chrome.action.setBadgeText({ text: '!' });
      break;
    case 'download':
      await chrome.action.setBadgeBackgroundColor({ color: '#15803d' });
      await chrome.action.setBadgeText({ text: '\u2193' }); // ↓
      break;
    default: // idle
      await chrome.action.setBadgeText({ text: '' });
  }
  // White badge text (Chrome 111+)
  chrome.action.setBadgeTextColor?.({ color: '#ffffff' });
}

// Set badge to reflect whatever state is currently persisted.
async function restoreBadge() {
  const state  = await getState();
  const stored = await chrome.storage.local.get('scrapedProfiles');
  const hasData = (stored.scrapedProfiles || []).length > 0;
  if (state.running)   await updateBadge('running', state.stats);
  else if (hasData)    await updateBadge('download');
  else                 await updateBadge('idle');
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
  await updateBadge('running', state.stats);

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

  // Arm the watchdog — if behavior_complete isn't received within WATCHDOG_MINUTES,
  // the visit is considered stalled (tab closed, redirect, crash, etc.)
  await chrome.alarms.create(ALARM_WATCHDOG, { delayInMinutes: WATCHDOG_MINUTES });

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
      await chrome.alarms.clear(ALARM_WATCHDOG);
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

  await updateBadge('running', newStats);

  // Inter-visit delay: 45 s – 3 min, human-weighted
  const delaySec = humanDelay(45, 180) / 1000;
  const delayMs  = delaySec * 1000;

  console.log(`[LPV] Next visit in ${Math.round(delaySec)}s`);
  notifyPopup({ type: 'waiting', seconds: Math.round(delaySec) });

  // Use an alarm so the service worker can be suspended during the wait
  await chrome.alarms.create(ALARM_NEXT_VISIT, { delayInMinutes: delayMs / 60000 });
}

async function finish(completed) {
  await chrome.alarms.clear(ALARM_WATCHDOG);
  await setState({ running: false, current: null });
  notifyPopup({ type: completed ? 'complete' : 'stopped' });
  console.log('[LPV] Finished.');
  await restoreBadge(); // shows ↓ if profiles exist, else clears
}

async function handleWatchdog() {
  const state = await getState();
  if (!state.running) return; // already stopped by another path

  console.warn('[LPV] Watchdog fired — stall detected on:', state.current);

  await chrome.alarms.clear(ALARM_NEXT_VISIT);
  await setState({ running: false, current: null });
  await updateBadge('error');

  const stored = await chrome.storage.local.get('scrapedProfiles');
  const scrapedCount = (stored.scrapedProfiles || []).length;

  notifyPopup({
    type:        'watchdog_fail',
    timedOutUrl: state.current,
    stats:       state.stats,
    scrapedCount,
  });
}

// ── Message bus ───────────────────────────────────────────────────────────────

function notifyPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => { /* popup may be closed */ });
}

// ── Event listeners ───────────────────────────────────────────────────────────

// Alarm fires → visit next URL, or watchdog triggers a stall stop
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NEXT_VISIT) {
    await visitNext();
  } else if (alarm.name === ALARM_WATCHDOG) {
    await handleWatchdog();
  }
});

// Messages from popup or content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'start') {
      const { urls } = msg;
      await setState({
        queue:           urls,
        visited:         [],
        current:         null,
        running:         true,
        stats:           { done: 0, total: urls.length },
        scrapedProfiles: [],
      });
      await updateBadge('running', { done: 0, total: urls.length });
      await visitNext();
      sendResponse({ ok: true });

    } else if (msg.type === 'stop') {
      await chrome.alarms.clear(ALARM_NEXT_VISIT);
      await chrome.alarms.clear(ALARM_WATCHDOG);
      await setState({ running: false });
      notifyPopup({ type: 'stopped' });
      await restoreBadge(); // shows ↓ if profiles exist, else clears
      sendResponse({ ok: true });

    } else if (msg.type === 'behavior_complete') {
      // Disarm the watchdog — visit completed normally
      await chrome.alarms.clear(ALARM_WATCHDOG);

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

// Restore badge on service worker startup (browser restart, extension reload, etc.)
restoreBadge();
