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
  // Discarded or still loading: no content script is running to ask, and the
  // tab may well hold a video once it wakes up. In a large pile these are
  // common, so guessing here would skip half the queue.
  if (tab.discarded || tab.status === 'unloaded' || tab.status === 'loading') return true;

  // Pages no content script can run in - chrome://, about:blank, the Web Store,
  // the PDF viewer. These genuinely cannot be playing anything.
  if (!/^https?:/i.test(tab.url || '')) return false;

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
 */
async function advance(tab, { close, delay = 0 }) {
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
    // force: the runner chose to come here, so start the video whatever state
    // it was left in. Plain tab switches do not force, so a video you paused on
    // purpose stays paused when you wander back to it.
    await tell(next.id, { type: 'resume', force: true });
  }

  await updateBadge();
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

// Switching tabs by hand should pause whatever you just walked away from and
// pick up whatever you walked into.
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const state = await getState();
  if (!state.enabled || state.windowId !== windowId) return;
  if (state.autoplayNext) await tell(tabId, { type: 'resume' });
});

// The runner is scoped to one window; if that window goes away, stand down.
chrome.windows.onRemoved.addListener(async (windowId) => {
  const state = await getState();
  if (state.windowId === windowId) await stopRun();
});

for (const event of [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onDetached]) {
  event.addListener(() => updateBadge());
}

chrome.runtime.onStartup.addListener(() => stopRun());
chrome.runtime.onInstalled.addListener(() => stopRun());
