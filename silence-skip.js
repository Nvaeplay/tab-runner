/**
 * Tab Runner - silence skipping.
 *
 * Speeds the video up while nothing is being said, and drops back to normal the
 * instant sound returns.
 *
 * What this actually measures: energy in the 300-3400 Hz speech band, compared
 * against a threshold derived from the video's own recent loudness, plus two
 * cheap shape tests that tell a talking human from a loud room. It is still not
 * a speech classifier - music will read as "sound" and hold it at normal speed.
 * See README for where that shows.
 *
 * Loaded before content.js, which hands it a video getter, an ad check and a
 * live-stream check via init(). It owns nothing else: no tab logic lives here.
 */

var SilenceSkip = (() => {
  /** True while the extension context that created this instance is still live. */
  const contextAlive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  };

  /**
   * Like content.js, this file has to survive being injected twice into one page
   * after an extension reload. A live instance is handed straight back rather
   * than rebuilt: its animation loop would otherwise run twice, and its cached
   * MediaElementSource nodes cannot be created a second time for the same
   * element. A dead instance left behind by the reload is replaced.
   */
  if (globalThis.__tabRunnerSilenceAlive?.()) return globalThis.__tabRunnerSilence;
  globalThis.__tabRunnerSilenceAlive = contextAlive;

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

  // Seconds of already-downloaded media that must sit ahead of the playhead
  // before we are willing to consume it faster than it arrives, and the point at
  // which we hand the rate back.
  //
  // Playing at 2x spends two seconds of buffer per second of wall clock. On a
  // recording that is free - the rest of the file is already on its way - but on
  // anything delivered in real time it is borrowed, and running the buffer flat
  // stalls the player. See the live-stream note on isLive().
  const ENGAGE_MIN_BUFFER_SEC = 3;
  const RELEASE_MIN_BUFFER_SEC = 1.5;

  // Consecutive small forward steps in duration before a stream is called live.
  // A recording settles its duration in one or two jumps as the manifest loads;
  // a live window creeps forward for as long as the broadcast runs.
  const LIVE_GROWTH_EVENTS = 3;

  // Must match settings.js. These are what a fresh profile runs on, since
  // storage holds nothing until the popup writes something.
  // test/settings.test.js fails if they drift apart.
  const DEFAULTS = {
    skipSilence: false,
    silenceMultiplier: 2,
    silenceMarginDb: 14,
    silenceHoldMs: 3000,
    showSpeedBadge: true,
  };

  let settings = { ...DEFAULTS };
  let hooks = { getVideo: () => null, isAd: () => false, isLive: () => false };

  // Frames of level history the "is this modulated like speech" test looks at.
  const MOD_WINDOW_FRAMES = 60; // ~1s at 60fps

  // A talking human swings the speech band by 10-25 dB inside a second, syllable
  // by syllable. A fan, an engine, rain, road noise or room tone sits still.
  const AMBIENT_MOD_MAX_DB = 6;

  // Spectral flatness: 1 is white noise, near 0 is a handful of strong peaks.
  // Voiced speech is all formants and harmonics and lands well under this;
  // broadband ambience lands over it.
  const AMBIENT_FLATNESS_MIN = 0.45;

  /** Value at `p` through an already-sorted array. */
  function at(sorted, p) {
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  }

  /**
   * The whole decision, isolated from audio plumbing: given a stream of
   * speech-band measurements, say whether playback should be fast right now.
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
       * Abandon the current run of quiet without forgetting how loud this video
       * is. Used when the picture stops being measurable - a rebuffer, a stall -
       * so the gap that follows has to earn the full hold again instead of
       * arriving already counted as silence.
       */
      standDown() {
        quietSince = 0;
        fast = false;
      },

      /**
       * @param {number|{level: number, flatness: number}} frame
       *   Speech-band level in dB (-Infinity for digital silence), optionally
       *   with the band's spectral flatness. A bare number skips the
       *   speech-vs-ambience test and decides on level alone.
       * @param {number} now   monotonic ms
       * @returns {boolean}    true while playback should run fast
       */
      push(frame, now) {
        const { silenceMarginDb, silenceHoldMs } = getSettings();
        const level = typeof frame === 'number' ? frame : frame.level;
        const flatness = typeof frame === 'number' ? null : frame.flatness;

        levels.push(level === -Infinity ? -100 : level);
        if (levels.length > HISTORY_FRAMES) levels.shift();

        // Threshold rides the video's own loudness rather than a fixed dB
        // value, so a quietly-recorded lecture and a loud one both work without
        // the user touching a dial. The 90th percentile of the last ~10s
        // approximates "this is how loud this video is when someone is talking".
        if (now - lastRecalc >= RECALC_EVERY_MS && levels.length >= MIN_SAMPLES) {
          lastRecalc = now;
          const sorted = [...levels].sort((a, b) => a - b);
          threshold = at(sorted, 0.9) - silenceMarginDb;
        }

        if (threshold === -Infinity) return false; // still learning this video

        // Level alone cannot tell a quiet room from a loud one. A kitchen, a
        // car, an air conditioner or a crowd can sit close enough to the
        // speaking level that nothing ever falls under the threshold, and a
        // stretch with nobody talking in it plays out in full at 1x.
        //
        // Two things separate that from actual speech, and both are already in
        // the spectrum we are reading. Speech is *modulated*: syllables push the
        // band up and down by a wide margin several times a second, while
        // ambience holds a near-constant level. And speech is *peaky*: voiced
        // sound is a pitch plus its harmonics under a couple of formants, where
        // broadband noise spreads evenly. Neither is conclusive alone - a held
        // note is unmodulated, a hiss can be brief - so a frame is only demoted
        // to ambience when it fails both at once.
        let ambient = false;
        if (flatness !== null && levels.length >= MOD_WINDOW_FRAMES) {
          const recent = levels.slice(-MOD_WINDOW_FRAMES).sort((a, b) => a - b);
          const modulation = at(recent, 0.9) - at(recent, 0.1);
          ambient = modulation < AMBIENT_MOD_MAX_DB && flatness > AMBIENT_FLATNESS_MIN;
        }

        if (level < threshold || ambient) {
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

  // Live-stream state for the currently attached element.
  let live = false;
  let durationSeen = 0;
  let durationGrowths = 0;

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

  /**
   * True while the attached element is playing a live stream.
   *
   * Speeding up a live stream is not a milder version of speeding up a
   * recording, it is a different thing entirely. A recording is already on its
   * way down the wire, so spending buffer faster than real time costs nothing. A
   * live stream only contains what has already been broadcast: it produces one
   * second of media per second, and any rate above 1x borrows against the live
   * edge until there is nothing left to play. The player then stalls, buffers,
   * and hands back a few seconds - which arrive as digital silence, which reads
   * as "nobody is talking", which speeds it up again. That loop is why a quiet
   * moment in a live stream turned into permanent rebuffering.
   *
   * There is no setting for this. Nothing about a live stream makes speeding it
   * up work, so there is nothing for a user to decide.
   */
  function isLive(el) {
    if (!el) return false;
    // Streams with no known end - the common case - report Infinity here.
    if (!Number.isFinite(el.duration)) return true;
    // DVR live streams report the seekable window instead, which is finite, so
    // they are caught by the player's own marker or by the window growing.
    return live || Boolean(hooks.isLive(el));
  }

  /**
   * A live window creeps forward while the broadcast runs. A recording settles
   * its duration in one or two jumps as the manifest loads and then holds, so it
   * is the repetition of small steps rather than any single one that gives a
   * stream away.
   */
  function onDurationChange() {
    if (!video) return;
    const current = video.duration;
    if (!Number.isFinite(current)) return; // isLive() reads this directly
    const grew = current - durationSeen;
    if (durationSeen > 0 && grew > 0.5 && grew < 30 && video.currentTime > 10) {
      if (++durationGrowths >= LIVE_GROWTH_EVENTS) live = true;
    }
    durationSeen = Math.max(durationSeen, current);
  }

  /** Seconds of already-downloaded media sitting ahead of the playhead. */
  function bufferAhead(el) {
    const { buffered } = el;
    for (let i = 0; i < buffered.length; i++) {
      if (buffered.start(i) <= el.currentTime && el.currentTime <= buffered.end(i)) {
        return buffered.end(i) - el.currentTime;
      }
    }
    return 0;
  }

  /**
   * Is there enough downloaded media ahead to spend it faster than it arrives?
   *
   * The tail of a video is exempt: once everything left is buffered there is
   * nothing to run out of, and without this the last few seconds of every video
   * would refuse to speed up.
   */
  function bufferHealthy(el) {
    const ahead = bufferAhead(el);
    const floor = engaged ? RELEASE_MIN_BUFFER_SEC : ENGAGE_MIN_BUFFER_SEC;
    if (ahead >= floor) return true;
    const remaining = Number.isFinite(el.duration) ? el.duration - el.currentTime : Infinity;
    return ahead >= remaining - 0.5;
  }

  function canEngage(el) {
    if (!settings.skipSilence || disabledReason) return false;
    if (!el || el.paused || el.ended || el.seeking) return false;
    // A muted element feeds the analyser silence; we would speed through
    // everything. content.js mutes briefly during its autoplay fallback.
    if (el.muted || el.volume === 0) return false;
    if (hooks.isAd()) return false;
    if (isLive(el)) return false;
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
    el.addEventListener('durationchange', onDurationChange);
    el.addEventListener('loadstart', resetMeasurements);
    el.addEventListener('emptied', resetMeasurements);
    return true;
  }

  function detach() {
    if (!video) return;
    release();
    video.removeEventListener('ratechange', onRateChange);
    video.removeEventListener('durationchange', onDurationChange);
    video.removeEventListener('loadstart', resetMeasurements);
    video.removeEventListener('emptied', resetMeasurements);
    video = null;
  }

  /**
   * One frame of the speech band: how loud it is, and how evenly the energy is
   * spread across it.
   *
   * `level` is mean power in dB, -Infinity for digital silence. `flatness` is
   * the Wiener entropy - geometric mean over arithmetic mean - which runs from
   * near 0 for a few strong peaks (a voice) to 1 for white noise (a room).
   */
  function analyseFrame() {
    analyser.getFloatFrequencyData(bins);
    let power = 0;
    let logPower = 0;
    let counted = 0;
    for (let i = bandLo; i <= bandHi; i++) {
      const db = bins[i];
      if (db === -Infinity) continue;
      const binPower = Math.pow(10, db / 10);
      power += binPower;
      logPower += Math.log(binPower);
      counted++;
    }
    if (counted === 0) return { level: -Infinity, flatness: 1 };
    const mean = power / counted;
    return {
      level: 10 * Math.log10(mean),
      flatness: Math.exp(logPower / counted) / mean,
    };
  }

  function resetMeasurements() {
    decider.reset();
    deadFrames = 0;
    // A player that reuses one element can go from a live stream to a recording
    // and back, so what was learned about the last one is thrown away with it.
    live = false;
    durationSeen = Number.isFinite(video?.duration) ? video.duration : 0;
    durationGrowths = 0;
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
    if (!contextAlive()) {
      rafId = null;
      release();
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
      // A live stream or an ad break is not a silence to be counted; the gap
      // after it starts from scratch.
      decider.standDown();
      return;
    }

    // A video that has run out of buffer produces nothing, and nothing reads as
    // silence. Left alone the decider would call a rebuffer "quiet", speed up,
    // drain whatever came back, and stall again. Stand down until there is
    // enough media ahead to spend.
    if (video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA || !bufferHealthy(video)) {
      release();
      decider.standDown();
      return;
    }

    const { level, flatness } = analyseFrame();

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

    if (decider.push({ level, flatness }, now)) engage();
    else release();

    if (engaged) showBadge(video.playbackRate);
  }

  function start() {
    if (rafId === null) rafId = requestAnimationFrame(tick);
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  const api = {
    init(injected) {
      hooks = { ...hooks, ...injected };
      // An orphaned copy throws on every chrome.* call; it has no work to do.
      if (!contextAlive()) return;
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
        // Not a disabledReason: it belongs to this video, not this page, and
        // clears by itself when the player moves on to a recording.
        live: isLive(video),
      };
    },

    /** Exposed for test/decider.test.js. Not part of the runtime surface. */
    _createDecider: createDecider,
  };

  globalThis.__tabRunnerSilence = api;
  return api;
})();
