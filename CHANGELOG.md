# Changelog

Versions follow semver in `manifest.json`: patch for a fix, minor for a feature
on the same permission surface, major for breaking behavior or a new
install-time permission. One tag per released package.

## 1.1.0 — 2026-08-13

No permission change. Updates from 1.0.0 install without a re-accept prompt.

### Live streams are never sped up

Speeding up a live stream is not a milder version of speeding up a recording. A
live stream only contains what has already been broadcast, so any rate above 1×
borrows against the live edge until the player stalls — and the stall reads as
digital silence, which reads as "nobody is talking", which speeds it up again. A
quiet moment in a live stream turned into permanent rebuffering.

Detected automatically, with no setting to find: an infinite duration covers most
streams, YouTube's `ytp-live` marker covers DVR windows that report a finite
length, and a duration that keeps creeping forward covers the rest. The popup
says so when it sits out.

### Speeding up now respects the buffer

Applies to recordings too. Speed-up needs a few seconds of downloaded media ahead
of the playhead before it engages, and hands the rate back if that runs down. A
stalled player stands the detector down, so the gap after a rebuffer has to earn
the hold from scratch instead of arriving already counted as silence.

### Pause-on-leave no longer depends on the page

The pause was left to the content script noticing its own `visibilitychange`,
which put it inside the page's reach: content scripts run at `document_idle`, so
ours is always the last listener added to that document, and a page listener that
runs first and stops propagation takes it down with it.

- The service worker now remembers which tab was in front of each window and
  sends the tab you left an explicit stop, which does not travel through the page
  at all. Stored in `chrome.storage.session`, since the worker is torn down
  seconds after it goes idle.
- The content script's own watch moved to a capturing listener on `window`, ahead
  of the entire document phase.
- The stop is re-applied over the next second and a half, so a player that undoes
  an outside pause does not get the last word.
- Players that keep their `<video>` outside the light DOM are now covered.
- The autoplay fallback no longer restarts a video that was paused mid-`play()`.

Works whether or not the runner is armed, as before.

### Absent vocals are no longer detected by level alone

Loud ambience — a kitchen, a car, road noise, a crowd — could sit close enough to
the speaking level that nothing ever fell under the threshold, so a stretch with
nobody talking in it played out in full at 1×.

Two shape tests now run alongside the level. Speech is *modulated*: syllables
swing the band 10–25 dB several times a second, where ambience holds steady.
Speech is *peaky*: formants and harmonics, where noise spreads evenly across the
band. A frame above the threshold is demoted to ambience only when it fails
**both**, so a monotone voice or a brief hiss is not enough on its own.

Both measurements come off the analyser that was already running — no model, no
download, no new permission. Music is still not distinguished from speech; the
README documents why a transcript API and a bundled VAD were both weighed and
passed over.

### Fixed

- Extension reloads no longer orphan the content scripts in open tabs, which
  silently stopped the queue with nothing but an `Extension context invalidated`
  entry to show for it.

## 1.0.0 — 2026-07-26

Initial version. Play through a window of video tabs hands-free: when a video
ends, close the tab and start the next one to the right. Skipping past tabs with
nothing to play, a default playback rate, silence skipping, and a reopen list for
anything closed.

Never released to the Chrome Web Store.
