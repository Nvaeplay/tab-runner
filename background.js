/**
 * Tab Runner - background service worker.
 *
 * Owns all tab orchestration. Content scripts only report "a video finished
 * here" and respond to play/pause requests; every decision about closing and
 * switching tabs is made in this file so there is exactly one place where
 * destructive actions happen.
 */

import { DEFAULTS } from './settings.js';

const ADVANCE_COOLDOWN_MS = 4000;

// Ceiling on how far one advance will look ahead for a tab with a video, so a
// window full of videoless tabs cannot turn into a long scan.
const MAX_SKIPS = 25;

// Ceiling on how many times an arrival check will move on again after finding
// nothing to play, so a window of sleeping videoless tabs cannot walk forever.
const MAX_ARRIVAL_HOPS = 10;

// A player that is still booting reports no media for a while, so an arrival
// check asks repeatedly and only gives up on a tab that stays empty throughout.
const ARRIVAL_TRIES = 6;
const ARRIVAL_GAP_MS = 700;

// Tab id -> timestamp of the last advance we started for it. Guards against
// duplicate `ended` events (multiple frames, YouTube re-firing on seek).
const recentAdvances = new Map();

async function getState() {
  return chrome.storage.local.get(DEFAULTS);
}

async function setState(patch) {
  await chrome.storage.local.set(patch);
}

function isCoolingDown(tabId) {
  const last = recentAdvances.get(tabId);
  return last !== undefined && Date.now() - last < ADVANCE_COOLDOWN_MS;
}

function markAdvance(tabId) {
  recentAdvances.set(tabId, Date.now());
  // Keep the map from growing without bound across a long session.
  if (recentAdvances.size > 200) {
    const cutoff = Date.now() - ADVANCE_COOLDOWN_MS;
    for (const [id, ts] of recentAdvances) {
      if (ts < cutoff) recentAdvances.delete(id);
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Best-effort message to a tab. Tabs without a content script just fail. */
async function tell(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    /* no content script in this tab (chrome://, web store, discarded) */
  }
}

/**
 * Can this tab be *proven* to have no video? Only then is it safe to skip.
 *
 * The bias is deliberate: skipping a tab that did have something to watch means
 * silently losing it from the queue, so anything we cannot inspect counts as
 * "might have video" and gets stopped at.
 */
async function tabHasVideo(tab) {
  // Pages no content script can run in - chrome://, about:blank, the new tab
  // page, the Web Store, the PDF viewer. These genuinely cannot be playing
  // anything, and that stays true whether the tab is loaded, loading or
  // discarded, so it is settled first. `pendingUrl` covers a tab that is on its
  // way to a real page but has no `url` yet.
  if (!/^https?:/i.test(tab.url || tab.pendingUrl || '')) return false;

  // Making sound settles it without asking anyone.
  if (tab.audible) return true;

  // Discarded or still loading: no content script is running to ask, and the tab
  // may well hold a video once it wakes up. Assume it might, land on it, and let
  // the arrival check settle it for real once it is awake.
  if (tab.discarded || tab.status === 'unloaded' || tab.status === 'loading') return true;

  const reply = await chrome.tabs.sendMessage(tab.id, { type: 'has-video' }).catch(() => null);
  // Unreachable despite being an ordinary page: assume it might, and stop.
  if (!reply) return true;
  return Boolean(reply.hasVideo);
}

/**
 * Walk right to the next tab worth stopping on, stepping over tabs with nothing
 * to play rather than stalling on them.
 *
 * Returns null when there is nowhere left to go - including when everything
 * ahead is videoless, in which case the runner stops rather than depositing you
 * on a blank tab.
 */
async function pickNextStop(tabs, current, state) {
  const ordered = [...tabs].sort((a, b) => a.index - b.index);
  const eligible = ordered.filter((t) => t.id !== current.id && !t.pinned);
  if (eligible.length === 0) return null;

  const rightward = eligible.filter((t) => t.index > current.index);
  const order = state.wrapAround
    ? [...rightward, ...eligible.filter((t) => t.index < current.index)]
    : rightward;

  if (!state.skipTabsWithoutVideo) return order[0] ?? null;

  let looked = 0;
  for (const candidate of order) {
    if (++looked > MAX_SKIPS) return candidate;
    if (await tabHasVideo(candidate)) return candidate;
  }
  return null;
}

async function recordClosed(tab, state) {
  if (!tab.url || tab.url.startsWith('chrome://')) return;
  const { history = [] } = await chrome.storage.local.get({ history: [] });
  history.unshift({
    url: tab.url,
    title: tab.title || tab.url,
    closedAt: Date.now(),
  });
  history.length = Math.min(history.length, state.historyLimit);
  await chrome.storage.local.set({ history });
}

/**
 * Move off `tab` to the next tab in its window.
 *
 * @param {chrome.tabs.Tab} tab      the tab being left
 * @param {object}          opts
 * @param {boolean}         opts.close  close `tab` once we have moved off it
 * @param {number}          opts.delay  ms to wait before acting
 * @param {number}          opts.hops   arrival checks already chained (internal)
 */
async function advance(tab, { close, delay = 0, hops = 0 }) {
  const state = await getState();

  if (delay > 0) {
    await sleep(delay);
    // The user may have taken over during the grace period (switched tabs,
    // scrubbed back, closed something). If this tab is no longer the one in
    // front, assume they are driving and stay out of the way.
    const stillThere = await chrome.tabs.get(tab.id).catch(() => null);
    if (!stillThere || !stillThere.active) return;
    tab = stillThere;
  }

  const tabs = await chrome.tabs.query({ windowId: tab.windowId });
  const next = await pickNextStop(tabs, tab, state);

  if (!next) {
    // End of the queue. Leave the last tab open - closing it would take the
    // window down with it.
    await chrome.action.setBadgeText({ text: '✓' });
    await chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
    return;
  }

  await chrome.tabs.update(next.id, { active: true });

  if (close) {
    await recordClosed(tab, state);
    await chrome.tabs.remove(tab.id).catch(() => {});
  }

  if (state.autoplayNext) {
    await tell(next.id, { type: 'resume' });
  }

  await updateBadge();

  // Only while the runner is actually driving this window. A manual advance on an
  // idle window does exactly one hop, the way it always did.
  if (
    state.enabled &&
    state.windowId === next.windowId &&
    state.skipTabsWithoutVideo &&
    hops < MAX_ARRIVAL_HOPS
  ) {
    await confirmArrival(next, hops);
  }
}

/**
 * Wait for a tab to finish waking up, then hand back its current state.
 *
 * Returns null if the tab went away. Gives up after `timeoutMs` and returns
 * whatever the tab looks like by then, so a page that never reaches `complete`
 * gets asked rather than holding up the queue.
 */
async function waitForLoad(tabId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return null;
    if (!tab.discarded && tab.status === 'complete') {
      // Content scripts run at document_idle, a beat after `complete`.
      await sleep(400);
      return chrome.tabs.get(tabId).catch(() => null);
    }
    await sleep(300);
  }
  return chrome.tabs.get(tabId).catch(() => null);
}

/**
 * Ask a tab we had to guess about whether it actually holds a video, now that it
 * is awake - and move on if it does not.
 *
 * A discarded or still-loading tab cannot be asked, so `pickNextStop` has to
 * assume it might have something and land on it. That assumption is why "skip
 * past tabs with no video" looked like it did nothing: in a window you filled by
 * spamming new tabs, Chrome has discarded most of the background ones, so the
 * leftover new tab pages and bare YouTube home pages the setting exists to step
 * over were exactly the ones the assumption protected.
 *
 * Nothing is closed here - skipping never closes anything. Bounded by
 * MAX_ARRIVAL_HOPS, and abandoned the moment this tab is no longer the one in
 * front, which means the user is driving.
 */
async function confirmArrival(tab, hops) {
  const wasAsleep = tab.discarded || tab.status === 'unloaded' || tab.status === 'loading';
  if (!wasAsleep) return;

  let awake = await waitForLoad(tab.id);
  if (!awake || !awake.active) return;

  // `complete` is not the same as "the player has media". YouTube's <video>
  // element exists long before it has a source, so a single negative answer here
  // would drop a perfectly good video tab out of the queue - and leave the runner
  // parked on nothing, with no video to end and so nothing left to close. Keep
  // asking, and only move on if it stays empty the whole time.
  for (let attempt = 0; attempt < ARRIVAL_TRIES; attempt++) {
    if (await tabHasVideo(awake)) return;
    if (attempt < ARRIVAL_TRIES - 1) await sleep(ARRIVAL_GAP_MS);
    awake = await chrome.tabs.get(tab.id).catch(() => null);
    // Gone, or the user took the wheel while we were asking.
    if (!awake || !awake.active) return;
  }

  // Re-read: the popup may have changed things while the tab was waking.
  const state = await getState();
  if (!state.skipTabsWithoutVideo) return;
  if (!state.enabled || state.windowId !== awake.windowId) return;

  markAdvance(awake.id);
  await advance(awake, { close: false, delay: 0, hops: hops + 1 });
}

/** A video finished playing in `tab`. */
async function onMediaEnded(tab) {
  const state = await getState();
  if (!state.enabled) return;
  if (state.windowId !== tab.windowId) return;
  // Only the tab the user is actually looking at drives the queue. A video
  // finishing in a background tab must never close anything.
  if (!tab.active) return;
  if (isCoolingDown(tab.id)) return;

  markAdvance(tab.id);
  await advance(tab, { close: state.closeOnEnd, delay: state.closeDelayMs });
}

async function updateBadge() {
  const state = await getState();
  if (!state.enabled || state.windowId === null) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  const tabs = await chrome.tabs.query({ windowId: state.windowId }).catch(() => []);
  await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  await chrome.action.setBadgeText({ text: String(tabs.length) });
}

async function startRun(windowId) {
  await setState({ enabled: true, windowId });
  await updateBadge();
  const [active] = await chrome.tabs.query({ windowId, active: true });
  const state = await getState();
  if (active && state.autoplayNext) await tell(active.id, { type: 'resume' });
}

async function stopRun() {
  await setState({ enabled: false, windowId: null });
  await updateBadge();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'media-ended':
        if (sender.tab) await onMediaEnded(sender.tab);
        sendResponse({ ok: true });
        break;

      case 'start-run':
        await startRun(message.windowId);
        sendResponse({ ok: true });
        break;

      case 'stop-run':
        await stopRun();
        sendResponse({ ok: true });
        break;

      case 'advance': {
        const [active] = await chrome.tabs.query({
          windowId: message.windowId,
          active: true,
        });
        if (active) {
          markAdvance(active.id);
          await advance(active, { close: message.close, delay: 0 });
        }
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ ok: false, error: 'unknown message' });
    }
  })();
  return true; // async sendResponse
});

chrome.commands.onCommand.addListener(async (command) => {
  const state = await getState();
  const win = await chrome.windows.getLastFocused();

  if (command === 'toggle-run') {
    if (state.enabled && state.windowId === win.id) await stopRun();
    else await startRun(win.id);
    return;
  }

  const [active] = await chrome.tabs.query({ windowId: win.id, active: true });
  if (!active) return;
  markAdvance(active.id);
  await advance(active, { close: command === 'advance-close', delay: 0 });
});

/**
 * Which tab was last in front of each window, so the tab being *left* can be
 * told to stop.
 *
 * Kept in chrome.storage.session rather than a module-level Map. The service
 * worker is torn down a few seconds after it goes idle, and a Map would come
 * back empty on exactly the event that needs it - the first tab switch after
 * every idle period, which is most of them.
 */
const LAST_ACTIVE_KEY = 'lastActiveByWindow';

async function readLastActive() {
  const stored = await chrome.storage.session.get({ [LAST_ACTIVE_KEY]: {} }).catch(() => null);
  return stored?.[LAST_ACTIVE_KEY] ?? {};
}

/** Record the tab now in front of `windowId`, and hand back the one it replaced. */
async function rememberActive(windowId, tabId) {
  const map = await readLastActive();
  const previous = map[windowId];
  map[windowId] = tabId;
  await chrome.storage.session.set({ [LAST_ACTIVE_KEY]: map }).catch(() => {});
  return previous === undefined ? null : previous;
}

/**
 * Fill in the tab in front of every window we have not seen switch yet, so the
 * first switch after the worker wakes knows what it is leaving.
 *
 * Windows already recorded are left alone: an activation that landed while this
 * was in flight holds the newer truth.
 */
async function seedLastActive() {
  const map = await readLastActive();
  const active = await chrome.tabs.query({ active: true }).catch(() => []);
  let added = false;
  for (const tab of active) {
    if (map[tab.windowId] === undefined) {
      map[tab.windowId] = tab.id;
      added = true;
    }
  }
  if (added) await chrome.storage.session.set({ [LAST_ACTIVE_KEY]: map }).catch(() => {});
}

// Switching tabs by hand should pause whatever you just walked away from and
// pick up whatever you walked into.
//
// The pause used to be left entirely to the content script noticing its own
// `visibilitychange`. That put it inside the page's reach: the event is
// dispatched on the page's own document, and a content script - running at
// document_idle - is always the last listener added to it, so a page listener
// that runs first and stops propagation takes ours with it. Telling the tab from
// out here does not go through the page at all. The content script still watches
// its own visibility, hardened; this is the independent second route, and it is
// the one that holds when the page fights the first.
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const previous = await rememberActive(windowId, tabId);
  const state = await getState();

  // Not gated on the runner. "Pause a video when I switch away from it" is about
  // the browser, not about the queue, and it has always applied whether or not
  // Tab Runner is running on this window.
  if (state.pauseOnLeave && previous !== null && previous !== tabId) {
    await tell(previous, { type: 'pause' });
  }

  if (!state.enabled || state.windowId !== windowId) return;
  if (state.autoplayNext) await tell(tabId, { type: 'resume' });
});

// The runner is scoped to one window; if that window goes away, stand down.
chrome.windows.onRemoved.addListener(async (windowId) => {
  const map = await readLastActive();
  if (windowId in map) {
    delete map[windowId];
    await chrome.storage.session.set({ [LAST_ACTIVE_KEY]: map }).catch(() => {});
  }
  const state = await getState();
  if (state.windowId === windowId) await stopRun();
});

for (const event of [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onDetached]) {
  event.addListener(() => updateBadge());
}

/**
 * Reloading or updating the extension orphans the content scripts in tabs that
 * were already open. They keep running, but every chrome.* call throws, so a
 * finished video never reports back and the queue silently stops - with no
 * symptom beyond an "Extension context invalidated" entry in the error log.
 *
 * Chrome does not re-inject into existing tabs by itself, so do it here. Any tab
 * that answers a ping already has a live copy and is left alone.
 */
async function reinjectContentScripts() {
  const scripts = chrome.runtime.getManifest().content_scripts ?? [];
  for (const script of scripts) {
    const tabs = await chrome.tabs.query({ url: script.matches }).catch(() => []);
    for (const tab of tabs) {
      // A discarded tab runs nothing and re-injects itself when it wakes.
      if (tab.discarded || !tab.id) continue;
      const alive = await chrome.tabs.sendMessage(tab.id, { type: 'ping' }).catch(() => null);
      if (alive) continue;
      await chrome.scripting
        .executeScript({
          target: { tabId: tab.id, allFrames: Boolean(script.all_frames) },
          files: script.js,
        })
        .catch(() => {
          /* restricted page, or the tab went away mid-flight */
        });
    }
  }
}

chrome.runtime.onStartup.addListener(async () => {
  await stopRun();
  await reinjectContentScripts();
});

chrome.runtime.onInstalled.addListener(async () => {
  await stopRun();
  await reinjectContentScripts();
});

// Runs on every wake, not just on install. Deliberately not awaited: listeners
// have to be registered synchronously or the worker misses the event that woke
// it, and nothing above depends on the seed having finished.
seedLastActive();
