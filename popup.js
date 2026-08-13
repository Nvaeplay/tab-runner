/**
 * Tab Runner - popup UI.
 *
 * Settings are read and written straight to chrome.storage. The popup only
 * messages the service worker for things the worker actually owns - closing and
 * switching tabs. Asking the worker for setting *values* was a bug: the popup is
 * re-parsed on every open while the worker only reloads with the extension, so a
 * newly added setting came back undefined and its control rendered blank.
 */

import { DEFAULTS, SETTING_CONTROLS } from './settings.js';

// Why silence skipping is sitting out on the current page. The failure that
// actually needs explaining is cross-origin media, which is a hard refusal
// rather than a bug.
const SILENCE_NOTES = {
  'cross-origin-media':
    'Off on this page: its video is served from another domain without CORS, and routing that through Web Audio would permanently mute it.',
  'no-audio-signal':
    'Off on this page: the audio tap is returning nothing, so speeding up would be guesswork.',
  'audio-graph-failed': 'Off on this page: Web Audio refused to attach to the video.',
  'no-web-audio': 'This browser has no Web Audio support.',
};

const $ = (id) => document.getElementById(id);

let currentWindowId = null;

const send = (message) => chrome.runtime.sendMessage(message);

function renderStatus(state, tabCount) {
  const runningHere = state.enabled && state.windowId === currentWindowId;
  const status = $('status');
  const toggle = $('toggle');

  if (runningHere) {
    status.textContent = `Running · ${tabCount} tab${tabCount === 1 ? '' : 's'} in the queue`;
    status.classList.add('live');
    toggle.textContent = 'Stop';
    toggle.classList.add('on');
  } else if (state.enabled) {
    status.textContent = 'Running on another window';
    status.classList.remove('live');
    toggle.textContent = 'Run this window instead';
    toggle.classList.remove('on');
  } else {
    status.textContent = `Idle · ${tabCount} tab${tabCount === 1 ? '' : 's'} in this window`;
    status.classList.remove('live');
    toggle.textContent = 'Run this window';
    toggle.classList.remove('on');
  }
}

function renderSettings(state) {
  for (const [key, kind] of Object.entries(SETTING_CONTROLS)) {
    const input = $(key);
    if (!input) continue;

    if (kind === 'checkbox') {
      input.checked = Boolean(state[key]);
      continue;
    }

    input.value = String(state[key]);
    // A <select> silently goes blank when its value matches no option, which is
    // exactly how a missing or renamed setting used to disappear. Fall back to
    // the default rather than showing an empty control.
    if (input.tagName === 'SELECT' && input.selectedIndex === -1) {
      input.value = String(DEFAULTS[key]);
      if (input.selectedIndex === -1) input.selectedIndex = 0;
      chrome.storage.local.set({ [key]: Number(input.value) });
    }
  }
}

async function renderHistory() {
  const { history = [] } = await chrome.storage.local.get({ history: [] });
  const list = $('history');
  list.textContent = '';

  const empty = history.length === 0;
  $('history-empty').hidden = !empty;
  list.hidden = empty;

  for (const entry of history) {
    const li = document.createElement('li');

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = entry.title;
    title.title = entry.url;

    const restore = document.createElement('button');
    restore.className = 'restore';
    restore.textContent = 'Reopen';
    restore.addEventListener('click', async () => {
      await chrome.tabs.create({ url: entry.url, active: false });
      const { history: current = [] } = await chrome.storage.local.get({ history: [] });
      await chrome.storage.local.set({
        history: current.filter((h) => h.url !== entry.url || h.closedAt !== entry.closedAt),
      });
      renderHistory();
    });

    li.append(title, restore);
    list.append(li);
  }
}

/** Ask the active tab whether silence skipping actually got a foothold there. */
async function renderSilenceNote(state) {
  const note = $('silence-note');
  if (!state.skipSilence) {
    note.hidden = true;
    return;
  }

  const [active] = await chrome.tabs.query({ windowId: currentWindowId, active: true });
  let status = null;
  if (active) {
    status = await chrome.tabs
      .sendMessage(active.id, { type: 'silence-status' })
      .catch(() => null);
  }

  if (!status) {
    note.textContent = 'No video detected on this tab.';
  } else if (status.disabledReason) {
    note.textContent =
      SILENCE_NOTES[status.disabledReason] ?? `Off on this page (${status.disabledReason}).`;
  } else if (status.live) {
    note.textContent =
      'Off for this video: a live stream has no buffer to spend, so speeding it up only makes it rebuffer.';
  } else if (status.active) {
    note.textContent = status.engaged ? 'Speeding up now.' : 'Listening — normal speed.';
  } else {
    note.textContent = 'Waiting for a video to start playing.';
  }
  note.hidden = false;
}

async function refresh() {
  const [state, tabs] = await Promise.all([
    chrome.storage.local.get(DEFAULTS),
    chrome.tabs.query({ windowId: currentWindowId }),
  ]);
  renderStatus(state, tabs.length);
  renderSettings(state);
  await renderSilenceNote(state);
  await renderHistory();
}

async function init() {
  currentWindowId = (await chrome.windows.getCurrent()).id;

  $('toggle').addEventListener('click', async () => {
    const state = await chrome.storage.local.get(DEFAULTS);
    if (state.enabled && state.windowId === currentWindowId) {
      await send({ type: 'stop-run' });
    } else {
      await send({ type: 'start-run', windowId: currentWindowId });
    }
    await refresh();
  });

  $('advance-close').addEventListener('click', async () => {
    await send({ type: 'advance', windowId: currentWindowId, close: true });
    window.close();
  });

  $('advance-keep').addEventListener('click', async () => {
    await send({ type: 'advance', windowId: currentWindowId, close: false });
    window.close();
  });

  $('clear-history').addEventListener('click', async () => {
    await chrome.storage.local.set({ history: [] });
    await renderHistory();
  });

  for (const [key, kind] of Object.entries(SETTING_CONTROLS)) {
    $(key).addEventListener('change', async (event) => {
      const value =
        kind === 'checkbox' ? event.target.checked : Number(event.target.value);
      await chrome.storage.local.set({ [key]: value });
      if (key === 'skipSilence') {
        await renderSilenceNote(await chrome.storage.local.get(DEFAULTS));
      }
    });
  }

  await refresh();
}

init();
