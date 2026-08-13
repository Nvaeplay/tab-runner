/**
 * Tab Runner - content script.
 *
 * Runs in every frame. Two jobs:
 *   1. Report when a real video finishes (not an ad, not a 3-second bumper).
 *   2. Start playback when the runner switches into this tab.
 *
 * It never closes or switches tabs - that is the service worker's job.
 */

(() => {
  /**
   * True while the extension context that installed this copy is still live.
   *
   * Reloading or updating the extension orphans the content scripts already
   * running in open tabs. Their chrome.* handles survive syntactically but throw
   * "Extension context invalidated" on use - and throw *synchronously*, so a
   * trailing .catch() on the returned promise never sees it.
   */
  const contextAlive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  };

  /**
   * This file has to survive being run twice in one page. After a reload the
   * service worker injects a fresh copy, and that copy lands in the *same*
   * isolated world as the orphan it is replacing.
   *
   * The IIFE is what makes that safe. At top level a second `const DEFAULTS`
   * throws "Identifier 'DEFAULTS' has already been declared", which aborts the
   * entire injection - leaving the tab with nothing but the dead orphan: no
   * video reports, no autoplay, no answer to "do you have a video". Wrapping the
   * file keeps every declaration function-scoped, so a second run is harmless.
   *
   * The hook then reports whether the copy that installed it still has a live
   * context, so a working copy is left alone and only a dead one is replaced.
   */
  if (globalThis.__tabRunnerAlive?.()) return;
  globalThis.__tabRunnerAlive = contextAlive;

  const DEFAULTS = {
    minDurationSec: 15,
    pauseOnLeave: true,
    autoplayNext: true,
    autoStartPaused: true,
    defaultRate: 1,
  };

  let settings = { ...DEFAULTS };

  /**
   * Every chrome.* call from this file goes through here, so an orphaned copy
   * degrades quietly instead of spraying uncaught errors and silently stalling
   * the queue.
   */
  function safely(fn) {
    if (!contextAlive()) return null;
    try {
      return fn();
    } catch {
      return null;
    }
  }

  /**
   * silence-skip.js loads first and defines SilenceSkip. If it ever fails to
   * run, the rest of this file still has to work: an exception thrown from the
   * `ended` handler would stop finished videos being reported at all, which
   * stops the queue with no visible symptom.
   */
  const silence = () => (typeof SilenceSkip === 'undefined' ? null : SilenceSkip);

  safely(() =>
    chrome.storage.local.get(DEFAULTS).then((s) => {
      settings = s;
    })
  );

  safely(() =>
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      for (const [key, { newValue }] of Object.entries(changes)) {
        if (key in settings) settings[key] = newValue;
      }
    })
  );

  /**
   * True while an ad is on screen. An ad's <video> fires `ended` exactly like the
   * real thing, and without this guard a pre-roll would close the tab before the
   * video you actually queued ever started.
   */
  function adIsPlaying() {
    const player = document.querySelector('#movie_player, .html5-video-player');
    if (player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'))) {
      return true;
    }
    return Boolean(document.querySelector('.ytp-ad-player-overlay, .ytp-ad-module'));
  }

  /**
   * True when this element is showing a live stream rather than a recording.
   *
   * Most players make this trivial - a stream with no known end reports an
   * infinite duration - but YouTube's live streams are seekable within a DVR
   * window and report that window's length, which is finite and looks exactly
   * like a recording. The player marks itself instead, and silence-skip.js
   * watches the window grow as a last resort.
   *
   * Consumed by silence-skip.js, which refuses to speed a live stream up.
   */
  function isLiveMedia(media) {
    if (!(media instanceof HTMLMediaElement)) return false;
    if (!Number.isFinite(media.duration)) return true;
    return Boolean(document.querySelector('.html5-video-player.ytp-live, #movie_player.ytp-live'));
  }

  /** The video the user is most likely actually watching: the biggest one. */
  function mainVideo() {
    const videos = [...document.querySelectorAll('video')].filter(
      (v) => v.readyState > 0 || v.currentSrc || v.src
    );
    if (videos.length === 0) return null;
    return videos.reduce((best, v) => {
      const area = v.clientWidth * v.clientHeight;
      return area > best.clientWidth * best.clientHeight ? v : best;
    });
  }

  function isRealVideoEnd(media) {
    if (!(media instanceof HTMLMediaElement)) return false;
    if (media.loop) return false;
    // Live streams and un-probed media report Infinity / NaN.
    if (!Number.isFinite(media.duration)) return false;
    if (media.duration < settings.minDurationSec) return false;
    // Some players fire `ended` on a seek to the tail; require us to be there.
    if (media.duration - media.currentTime > 2) return false;
    if (adIsPlaying()) return false;
    return true;
  }

  // `ended` does not bubble, but a capturing listener on the document still sees
  // it on the way down. That keeps this working across SPA navigations and
  // players that swap their <video> element out from under you.
  document.addEventListener(
    'ended',
    (event) => {
      const media = event.target;
      if (!isRealVideoEnd(media)) return;

      // Stop here and now so YouTube's own "up next" countdown cannot navigate
      // this tab out from under the runner during the close delay.
      try {
        media.pause();
      } catch {
        /* some players guard pause() */
      }

      // Hand the element back at normal speed. Matters when closeOnEnd is off, and
      // on SPA players that reuse one <video> across navigations.
      silence()?.reset();

      safely(() =>
        chrome.runtime
          .sendMessage({
            type: 'media-ended',
            url: location.href,
            title: document.title,
            duration: media.duration,
          })
          .catch(() => {
            /* service worker asleep */
          })
      );
    },
    true
  );

  // -------------------------------------------------------------------------
  // Default playback speed
  // -------------------------------------------------------------------------

  // Applied once per media element. After that the rate belongs to you (or to
  // silence skipping) - re-forcing it on every seek would fight the player.
  const ratedElements = new WeakSet();

  document.addEventListener(
    'playing',
    (event) => {
      const media = event.target;
      if (!(media instanceof HTMLMediaElement)) return;
      if (settings.defaultRate === 1) return;
      if (ratedElements.has(media)) return;
      if (adIsPlaying()) return; // let ads run at their own speed
      ratedElements.add(media);
      try {
        media.preservesPitch = true;
        media.playbackRate = settings.defaultRate;
      } catch {
        /* some players clamp the rate */
      }
    },
    true
  );

  // -------------------------------------------------------------------------
  // Playback control
  // -------------------------------------------------------------------------

  let resumeRequestedAt = 0;

  /**
   * True when this tab is in the background and the user asked for background
   * tabs to stay quiet. Checked on every path that could start playback, not
   * just when the visibility actually changes.
   *
   * The grace period is not cosmetic. The runner activates a tab and then sends
   * it `resume`, and those two travel different IPC pipes - so the message can
   * arrive while the renderer still reports `hidden` on a tab that is already in
   * front. Without the grace, the guard below paused the very video the runner
   * had just started, which stopped the queue dead: nothing plays, so nothing
   * ends, so nothing closes. A tab the user actually walked away from never gets
   * a `resume`, so it stays covered.
   */
  function shouldStayPaused() {
    if (!document.hidden || !settings.pauseOnLeave) return false;
    return Date.now() - resumeRequestedAt > 3000;
  }

  /**
   * Chrome blocks unmuted programmatic playback unless the page has earned
   * autoplay permission. When it refuses, start muted and unmute the moment
   * playback is actually running - which Chrome does allow.
   */
  async function playWithAutoplayFallback(video) {
    try {
      await video.play();
      return true;
    } catch {
      // play() also rejects when something pauses the element mid-call, and the
      // most likely something is us, on our way out of the tab. Retrying then
      // would restart the video the user just walked away from.
      if (shouldStayPaused()) return false;
      const wasMuted = video.muted;
      video.muted = true;
      try {
        await video.play();
        if (!wasMuted) {
          video.addEventListener(
            'playing',
            () => {
              video.muted = false;
            },
            { once: true }
          );
        }
        return true;
      } catch {
        return false;
      }
    }
  }

  let resumeTimer = null;

  /**
   * Start playback, retrying while the page finishes loading. A tab that has been
   * sitting in the background for hours may have been discarded and is still
   * re-rendering when we arrive.
   *
   * With `autoStartPaused` on (the default) this is unconditional: landing on a
   * tab starts its video whatever state it was left in. With it off, only videos
   * that have never been started are touched, so a video paused part-way through
   * stays paused.
   */
  function requestResume(attempt = 0) {
    clearTimeout(resumeTimer);
    // The retry chain outlives the arrival that started it. Leaving the tab
    // during its ~9 second window used to let the chain find the video
    // afterwards and start it in a tab the user had already walked away from.
    if (shouldStayPaused()) return;

    const video = mainVideo();
    if (video) {
      if (!video.paused) return;
      const neverStarted = video.currentTime === 0;
      if (settings.autoStartPaused || neverStarted) playWithAutoplayFallback(video);
      return;
    }

    if (attempt < 12) {
      resumeTimer = setTimeout(() => requestResume(attempt + 1), 750);
    }
  }

  /**
   * Every video that has actually started playing in this frame.
   *
   * `document.querySelectorAll('video')` only sees the light DOM, and a player
   * is free to keep its element inside a shadow root where that query returns
   * nothing. A `play` event still reaches a capturing listener on the document,
   * so anything that ever started is remembered here and stays pausable.
   */
  const playedHere = new Set();

  /** Everything worth pausing in this frame, from both sources. */
  function pausableMedia() {
    const found = new Set(document.querySelectorAll('video'));
    for (const media of playedHere) {
      if (media.isConnected) found.add(media);
      else playedHere.delete(media); // the player threw this one away
    }
    return found;
  }

  /**
   * Stop everything playing in this frame. Every video, not just the biggest one
   * - a page with a second player running would otherwise keep talking from the
   * background.
   */
  function pauseAll() {
    for (const media of pausableMedia()) {
      if (media.paused) continue;
      try {
        media.pause();
      } catch {
        /* some players guard pause() */
      }
    }
  }

  /**
   * Leave this tab quiet.
   *
   * One pause is not enough. A player with its own state machine - YouTube's is
   * the loud example - can treat a pause it did not initiate as a glitch and
   * play again a beat later, and the `play` guard below only covers the elements
   * that actually fire an event we see. Re-checking for a second or so costs
   * nothing and closes the gap; each check re-reads the conditions, so returning
   * to the tab or an arriving `resume` cancels the rest.
   */
  function pauseUntilWeComeBack() {
    if (!settings.pauseOnLeave) return;
    clearTimeout(resumeTimer);
    pauseAll();
    for (const delay of [150, 600, 1500]) {
      setTimeout(() => {
        if (shouldStayPaused()) pauseAll();
      }, delay);
    }
  }

  /**
   * Registered on `window` in the capture phase rather than on `document`, which
   * is where `visibilitychange` is dispatched.
   *
   * Content scripts share the page's event dispatch, so a page listener that
   * runs first and calls stopImmediatePropagation() takes every later listener
   * on that node down with it - including ours, which is necessarily later
   * because content scripts run at document_idle. Capturing on the window puts
   * us ahead of the whole document phase, where nothing on the page can be.
   */
  window.addEventListener(
    'visibilitychange',
    () => {
      if (document.hidden) pauseUntilWeComeBack();
    },
    true
  );

  /**
   * `visibilitychange` fires once, and only catches what is already playing. A
   * player can start on its own long after you have left - YouTube's "up next",
   * a lazily initialised player, a discarded tab finishing its reload - and there
   * is no second visibility event to catch it.
   *
   * `play` in the capture phase catches all of them, and fires before any audio
   * is produced, so nothing is heard from a tab that should be quiet.
   */
  document.addEventListener(
    'play',
    (event) => {
      const media = event.target;
      if (!(media instanceof HTMLMediaElement)) return;
      if (media instanceof HTMLVideoElement) {
        // Prune here rather than only on the way out: a detached element in the
        // set keeps its whole subtree alive, and an SPA can churn through a lot
        // of them before anyone switches tabs.
        for (const seen of playedHere) if (!seen.isConnected) playedHere.delete(seen);
        playedHere.add(media);
      }
      if (!shouldStayPaused()) return;
      try {
        media.pause();
      } catch {
        /* some players guard pause() */
      }
    },
    true
  );

  /**
   * The service worker saw this tab lose the front and says to stop.
   *
   * It is the authoritative signal - it comes from outside the page, so no
   * amount of player JS can interfere with it - but it can arrive a moment
   * before the renderer agrees the tab is hidden, and a tab that is genuinely
   * still in front is not one to pause. So the visibility is confirmed rather
   * than assumed, with a short window for it to catch up.
   */
  function pauseFromRunner(attempt = 0) {
    if (document.hidden) {
      pauseUntilWeComeBack();
      return;
    }
    if (attempt < 5) setTimeout(() => pauseFromRunner(attempt + 1), 120);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'resume') {
      resumeRequestedAt = Date.now();
      if (settings.autoplayNext) requestResume();
      sendResponse({ ok: true });
    }
    if (message?.type === 'pause') {
      if (settings.pauseOnLeave) pauseFromRunner();
      sendResponse({ ok: true });
    }
    if (message?.type === 'silence-status') {
      sendResponse(silence()?.status() ?? null);
    }
    if (message?.type === 'ping') {
      sendResponse({ alive: true });
    }
    if (message?.type === 'has-video') {
      // Only a video with actual media behind it counts. An empty <video> element
      // - YouTube's home page keeps one around for hover previews - is not
      // something worth stopping the queue on.
      const video = mainVideo();
      const hasVideo = Boolean(video && (video.readyState > 0 || video.currentSrc));

      // This script runs in every frame, and Chrome uses whichever frame answers
      // first. A "yes" is always right, so send it immediately. A "no" from the
      // top frame is only right if no subframe has a video - courses often put the
      // player in a cross-origin iframe - so hold it briefly and let any subframe
      // win the race. Subframes without video stay silent entirely.
      if (hasVideo) {
        sendResponse({ hasVideo: true });
        return false;
      }
      if (window.top !== window) return false;
      setTimeout(() => sendResponse({ hasVideo: false }), 150);
      return true;
    }
    return false;
  });

  // Silence skipping needs to agree with this file on which video is the real
  // one, when an ad is on screen and what counts as live, so it borrows all
  // three rather than reimplementing them.
  silence()?.init({ getVideo: mainVideo, isAd: adIsPlaying, isLive: isLiveMedia });
})();
