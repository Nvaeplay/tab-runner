/**
 * Every persisted setting and its default, in one place.
 *
 * Imported by both the service worker and the popup. They used to keep separate
 * lists, which broke in a way worth remembering: the popup is re-parsed every
 * time it opens, but the service worker only reloads when the extension does.
 * Add a setting and the popup would render a control the worker had never heard
 * of, so the value round-tripped back as undefined and the control went blank.
 *
 * content.js and silence-skip.js still carry their own small default sets - MV3
 * content scripts are classic scripts and cannot import. Keep the values here in
 * sync with those; they are the consumers, this is the source of truth.
 */

export const DEFAULTS = {
  enabled: false,
  // Window the runner is armed on. Null when idle.
  windowId: null,
  closeOnEnd: true,
  // Grace period between the video ending and the tab being closed, so a
  // mis-detection is recoverable by grabbing the wheel.
  closeDelayMs: 1200,
  // Anything shorter than this is assumed to be an ad, a bumper or a preview.
  minDurationSec: 15,
  wrapAround: false,
  pauseOnLeave: true,
  autoplayNext: true,
  historyLimit: 60,

  // Step over tabs with nothing to play instead of stalling on them. On by
  // default: it only changes where the runner lands, it never closes anything.
  skipTabsWithoutVideo: true,

  // Speed
  defaultRate: 1,
  skipSilence: false,
  silenceMultiplier: 2,
  silenceMarginDb: 14,
  // How long the quiet has to last before speeding up. Short values make the
  // rate flicker on every between-sentence breath, which reads as glitchy
  // playback, so this is deliberately slow by default.
  silenceHoldMs: 3000,
  showSpeedBadge: true,
};

/**
 * The popup control backing each exposed setting, keyed by element id.
 *
 * Not every setting appears here - silenceHoldMs and historyLimit are
 * deliberately not exposed. test/settings.test.js checks that everything that
 * *is* listed has a matching element in popup.html and, for dropdowns, an option
 * matching its default.
 */
export const SETTING_CONTROLS = {
  closeOnEnd: 'checkbox',
  autoplayNext: 'checkbox',
  pauseOnLeave: 'checkbox',
  wrapAround: 'checkbox',
  skipTabsWithoutVideo: 'checkbox',
  closeDelayMs: 'number',
  minDurationSec: 'number',
  defaultRate: 'number',
  skipSilence: 'checkbox',
  silenceMultiplier: 'number',
  silenceHoldMs: 'number',
  silenceMarginDb: 'number',
  showSpeedBadge: 'checkbox',
};
