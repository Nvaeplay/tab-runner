/**
 * Tab Runner - content script.
 *
 * Runs in every frame. Two jobs:
 *   1. Report when a real video finishes (not an ad, not a 3-second bumper).
 *   2. Start playback when the runner switches into this tab.
 *
 * It never closes or switches tabs - that is the service worker's job.
 */

const DEFAULTS = {
  minDurationSec: 15,
  pauseOnLeave: true,
  autoplayNext: true,
  defaultRate: 1,
};

let settings = { ...DEFAULTS };

chrome.storage.local.get(DEFAULTS).then((s) => {
  settings = s;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key in settings) settings[key] = newValue;
  }
});

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
    SilenceSkip.reset();

    chrome.runtime
      .sendMessage({
        type: 'media-ended',
        url: location.href,
        title: document.title,
        duration: media.duration,
      })
      .catch(() => {
        /* service worker asleep or extension reloading */
      });
  },
  true
);

// ---------------------------------------------------------------------------
// Default playback speed
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Playback control
// ---------------------------------------------------------------------------

let pausedByUs = false;

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
 * Try to start playback, retrying while the page finishes loading. A tab that
 * has been sitting in the background for hours may have been discarded and is
 * still re-rendering when we arrive.
 *
 * `force` means the runner deliberately moved here, so start the video whatever
 * state it is in. Without it we only take over playback we are entitled to -
 * a video the user paused on purpose stays paused when they wander back to it.
 */
function requestResume(attempt = 0, force = false) {
  clearTimeout(resumeTimer);

  const video = mainVideo();
  if (video) {
    if (!video.paused) return;
    const neverStarted = video.currentTime === 0;
    if (force || pausedByUs || neverStarted) {
      pausedByUs = false;
      playWithAutoplayFallback(video);
      return;
    }
    return;
  }

  if (attempt < 12) {
    resumeTimer = setTimeout(() => requestResume(attempt + 1, force), 750);
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  if (!settings.pauseOnLeave) return;
  const video = mainVideo();
  if (video && !video.paused) {
    pausedByUs = true;
    video.pause();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'resume') {
    if (settings.autoplayNext) requestResume(0, Boolean(message.force));
    sendResponse({ ok: true });
  }
  if (message?.type === 'silence-status') {
    sendResponse(SilenceSkip.status());
  }
  if (message?.type === 'has-video') {
    // Only a video with actual media behind it counts. An empty <video> element
    // - YouTube's home page keeps one around for hover previews - is not
    // something worth stopping the queue on.
    const video = mainVideo();
    sendResponse({
      hasVideo: Boolean(video && (video.readyState > 0 || video.currentSrc)),
    });
  }
  return false;
});

// Silence skipping needs to agree with this file on which video is the real one
// and when an ad is on screen, so it borrows both rather than reimplementing.
SilenceSkip.init({ getVideo: mainVideo, isAd: adIsPlaying });
