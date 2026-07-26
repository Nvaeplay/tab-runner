/**
 * Tab Runner - silence skipping.
 *
 * Speeds the video up while nothing is being said, and drops back to normal the
 * instant sound returns.
 *
 * What this actually measures: energy in the 300-3400 Hz speech band, compared
 * against a threshold derived from the video's own recent loudness. It is not a
 * speech classifier - music or room tone will read as "sound" and hold it at
 * normal speed. See README for where that shows.
 *
 * Loaded before content.js, which hands it a video getter and an ad check via
 * init(). It owns nothing else: no tab logic lives here.
 */

var SilenceSkip = (() => {
  const SPEECH_BAND_HZ = [300, 3400];
  const FFT_SIZE = 1024;
  const HISTORY_FRAMES = 600; // ~10s at 60fps
  const RECALC_EVERY_MS = 250;
  const RESCAN_EVERY_MS = 1000;
  const MIN_SAMPLES = 30;
  // Speech resumption is detected one frame late, so at rate R we rush through
  // R x ~16ms of real video before dropping back. At 4x that is ~66ms - about
  // the shortest clip you would not notice. Higher rates start eating words.
  const MAX_RATE = 4;
  // Frames of exact digital silence, while the video should be audible, before
  // we conclude the audio graph is giving us nothing and stand down.
  const DEAD_SIGNAL_FRAMES = 480; // ~8s

  const DEFAULTS = {
    skipSilence: false,
    silenceMultiplier: 2,
    silenceMarginDb: 14,
    silenceHoldMs: 350,
    showSpeedBadge: true,
  };

  let settings = { ...DEFAULTS };
  let hooks = { getVideo: () => null, isAd: () => false };

  /**
   * The whole decision, isolated from audio plumbing: given a stream of
   * speech-band levels in dB, say whether playback should be fast right now.
   *
   * Pure and side-effect free so it can be tested against synthetic audio
   * without a browser. See test/decider.test.js.
   *
   * @param {() => {silenceMarginDb: number, silenceHoldMs: number}} getSettings
   */
  function createDecider(getSettings) {
    let levels = [];
    let threshold = -Infinity;
    let lastRecalc = 0;
    let quietSince = 0;
    let fast = false;

    return {
      get threshold() {
        return threshold;
      },

      reset() {
        levels = [];
        threshold = -Infinity;
        lastRecalc = 0;
        quietSince = 0;
        fast = false;
      },

      /**
       * @param {number} level dB in the speech band; -Infinity for digital silence
       * @param {number} now   monotonic ms
       * @returns {boolean}    true while playback should run fast
       */
      push(level, now) {
        const { silenceMarginDb, silenceHoldMs } = getSettings();

        levels.push(level === -Infinity ? -100 : level);
        if (levels.length > HISTORY_FRAMES) levels.shift();

        // Threshold rides the video's own loudness rather than a fixed dB
        // value, so a quietly-recorded lecture and a loud one both work without
        // the user touching a dial. The 90th percentile of the last ~10s
        // approximates "this is how loud this video is when someone is talking".
        if (now - lastRecalc >= RECALC_EVERY_MS && levels.length >= MIN_SAMPLES) {
          lastRecalc = now;
          const sorted = [...levels].sort((a, b) => a - b);
          threshold = sorted[Math.floor(sorted.length * 0.9)] - silenceMarginDb;
        }

        if (threshold === -Infinity) return false; // still learning this video

        if (level < threshold) {
          if (quietSince === 0) quietSince = now;
          // Wait out short gaps so we do not flip speed between words.
          if (now - quietSince >= silenceHoldMs) fast = true;
        } else {
          // Drop back the instant sound returns - any hold here clips the first
          // word of the next sentence.
          quietSince = 0;
          fast = false;
        }
        return fast;
      },
    };
  }

  const decider = createDecider(() => settings);

  let ctx = null;
  let analyser = null;
  let bins = null;
  let bandLo = 0;
  let bandHi = 0;
  // createMediaElementSource throws if called twice for the same element, so
  // sources are cached for the life of the page.
  const sources = new WeakMap();

  let video = null;
  let rafId = null;
  let lastScan = 0;
  let disabledReason = null;

  let engaged = false;
  let baseRate = 1;
  let rateWeSet = null;
  let deadFrames = 0;
  let badge = null;

  // -------------------------------------------------------------------------
  // Safety gates
  // -------------------------------------------------------------------------

  /**
   * Routing a cross-origin video that was not CORS-approved through Web Audio
   * makes it output silence *permanently* - createMediaElementSource cannot be
   * undone. So we only touch media we know is safe to route.
   */
  function safeToRoute(el) {
    // crossorigin was set and the media is playing, so CORS was granted.
    if (el.crossOrigin) return true;
    const src = el.currentSrc || el.src;
    if (!src) return false;
    // MSE/blob sources are minted by this page and are always same-origin.
    if (src.startsWith('blob:') || src.startsWith('data:')) return true;
    try {
      return new URL(src, location.href).origin === location.origin;
    } catch {
      return false;
    }
  }

  /**
   * The AudioContext must already be running before we route anything into it.
   * Attaching a video to a *suspended* context silences the video until a user
   * gesture arrives, which is exactly the failure we must never cause.
   */
  function contextReady() {
    if (!ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) {
        disabledReason = 'no-web-audio';
        return false;
      }
      try {
        ctx = new Ctor();
      } catch {
        disabledReason = 'no-web-audio';
        return false;
      }
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx.state === 'running';
  }

  function canEngage(el) {
    if (!settings.skipSilence || disabledReason) return false;
    if (!el || el.paused || el.ended || el.seeking) return false;
    // A muted element feeds the analyser silence; we would speed through
    // everything. content.js mutes briefly during its autoplay fallback.
    if (el.muted || el.volume === 0) return false;
    if (hooks.isAd()) return false;
    return true;
  }

  // -------------------------------------------------------------------------
  // Audio graph
  // -------------------------------------------------------------------------

  function attach(el) {
    if (!safeToRoute(el)) {
      disabledReason = 'cross-origin-media';
      return false;
    }
    if (!contextReady()) return false; // retried on later frames

    try {
      let source = sources.get(el);
      if (!source) {
        source = ctx.createMediaElementSource(el);
        sources.set(el, source);
      }
      if (analyser) analyser.disconnect();
      analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0;

      source.disconnect();
      source.connect(analyser);
      // Audio must still reach the speakers - the analyser is a tap, not a sink.
      analyser.connect(ctx.destination);

      bins = new Float32Array(analyser.frequencyBinCount);
      const perBin = ctx.sampleRate / 2 / bins.length;
      bandLo = Math.max(1, Math.floor(SPEECH_BAND_HZ[0] / perBin));
      bandHi = Math.min(bins.length - 1, Math.ceil(SPEECH_BAND_HZ[1] / perBin));
    } catch {
      disabledReason = 'audio-graph-failed';
      return false;
    }

    video = el;
    baseRate = el.playbackRate || 1;
    rateWeSet = null;
    resetMeasurements();
    try {
      el.preservesPitch = true;
    } catch {
      /* older engines */
    }
    el.addEventListener('ratechange', onRateChange);
    el.addEventListener('loadstart', resetMeasurements);
    el.addEventListener('emptied', resetMeasurements);
    return true;
  }

  function detach() {
    if (!video) return;
    release();
    video.removeEventListener('ratechange', onRateChange);
    video.removeEventListener('loadstart', resetMeasurements);
    video.removeEventListener('emptied', resetMeasurements);
    video = null;
  }

  /** Mean power in the speech band, in dB. -Infinity means digital silence. */
  function speechBandLevel() {
    analyser.getFloatFrequencyData(bins);
    let power = 0;
    let counted = 0;
    for (let i = bandLo; i <= bandHi; i++) {
      const db = bins[i];
      if (db === -Infinity) continue;
      power += Math.pow(10, db / 10);
      counted++;
    }
    if (counted === 0) return -Infinity;
    return 10 * Math.log10(power / counted);
  }

  function resetMeasurements() {
    decider.reset();
    deadFrames = 0;
  }

  // -------------------------------------------------------------------------
  // Rate control
  // -------------------------------------------------------------------------

  function applyRate(rate) {
    rateWeSet = rate;
    try {
      video.playbackRate = rate;
    } catch {
      /* some players clamp or refuse */
    }
  }

  function engage() {
    if (engaged || !video) return;
    engaged = true;
    const rate = Math.min(baseRate * settings.silenceMultiplier, MAX_RATE);
    applyRate(rate);
    showBadge(rate);
  }

  function release() {
    if (!engaged) return;
    engaged = false;
    if (video) applyRate(baseRate);
    hideBadge();
  }

  /**
   * If anything other than us changes the rate - the user, or YouTube resetting
   * it across an ad - adopt that as the new normal instead of fighting it.
   */
  function onRateChange() {
    if (!video) return;
    if (rateWeSet !== null && Math.abs(video.playbackRate - rateWeSet) < 0.001) return;
    baseRate = video.playbackRate;
    engaged = false;
    hideBadge();
  }

  // -------------------------------------------------------------------------
  // On-video indicator
  // -------------------------------------------------------------------------

  function showBadge(rate) {
    if (!settings.showSpeedBadge || !video) return;
    if (!badge) {
      badge = document.createElement('div');
      badge.style.cssText = [
        'position:fixed',
        'z-index:2147483647',
        'pointer-events:none',
        'padding:3px 8px',
        'border-radius:999px',
        'background:rgba(17,17,17,.78)',
        'color:#fff',
        'font:600 12px/1 system-ui,sans-serif',
        'letter-spacing:.02em',
        'backdrop-filter:blur(3px)',
      ].join(';');
    }
    const rect = video.getBoundingClientRect();
    badge.textContent = `${rate.toFixed(2).replace(/\.?0+$/, '')}×`;
    badge.style.top = `${Math.max(8, rect.top + 12)}px`;
    badge.style.left = `${Math.max(8, rect.right - 60)}px`;
    // In fullscreen only descendants of the fullscreen element are painted.
    (document.fullscreenElement || document.body).appendChild(badge);
  }

  function hideBadge() {
    badge?.remove();
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  function tick() {
    // An orphaned copy left behind by an extension reload must not keep an
    // animation loop alive in the page forever.
    try {
      if (!chrome.runtime?.id) {
        rafId = null;
        release();
        return;
      }
    } catch {
      rafId = null;
      return;
    }

    rafId = requestAnimationFrame(tick);
    const now = performance.now();

    if (!settings.skipSilence || disabledReason) {
      if (video) detach();
      return;
    }

    // Players swap their <video> element out; re-check periodically.
    if (now - lastScan > RESCAN_EVERY_MS) {
      lastScan = now;
      const current = hooks.getVideo();
      if (current && current !== video) {
        detach();
        attach(current);
      } else if (!current) {
        detach();
      }
    }

    if (!video || !analyser) return;

    if (!canEngage(video)) {
      release();
      return;
    }

    const level = speechBandLevel();

    // Guard against a graph that is silently producing nothing - without this
    // we would read permanent silence and blast through the whole video.
    if (level === -Infinity) {
      if (++deadFrames > DEAD_SIGNAL_FRAMES) {
        disabledReason = 'no-audio-signal';
        release();
        return;
      }
    } else {
      deadFrames = 0;
    }

    if (decider.push(level, now)) engage();
    else release();

    if (engaged) showBadge(video.playbackRate);
  }

  function start() {
    if (rafId === null) rafId = requestAnimationFrame(tick);
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  return {
    init(injected) {
      hooks = { ...hooks, ...injected };
      // An orphaned copy throws on every chrome.* call; it has no work to do.
      try {
        if (!chrome.runtime?.id) return;
      } catch {
        return;
      }
      chrome.storage.local.get(DEFAULTS).then((stored) => {
        settings = stored;
        start();
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        for (const [key, { newValue }] of Object.entries(changes)) {
          if (key in settings) settings[key] = newValue;
        }
        // Give a previously-refused page another chance after a settings change.
        if (changes.skipSilence?.newValue && disabledReason === 'cross-origin-media') {
          disabledReason = null;
        }
        start();
      });
    },

    /** Restore normal speed - called when a video ends. */
    reset() {
      release();
      resetMeasurements();
    },

    /** Why skipping is inactive on this page, or null. Surfaced in the popup. */
    status() {
      return {
        active: Boolean(video && analyser) && !disabledReason,
        engaged,
        disabledReason,
      };
    },

    /** Exposed for test/decider.test.js. Not part of the runtime surface. */
    _createDecider: createDecider,
  };
})();
