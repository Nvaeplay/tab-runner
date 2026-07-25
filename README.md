# Tab Runner

[![test](https://github.com/Nvaeplay/tab-runner/actions/workflows/test.yml/badge.svg)](https://github.com/Nvaeplay/tab-runner/actions/workflows/test.yml)

A Chrome extension for the pile of tabs you opened to learn something and never
got through.

Arm it on **one window**. When the video in the tab you're watching ends, that
tab closes and the nearest tab to the right takes over and starts playing. Keep
going and the window empties itself, left to right, hands-free.

## Install

```
git clone https://github.com/Nvaeplay/tab-runner.git
```

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → select the cloned folder.

No build step — it's plain JS and loads as-is.

Works on any Chromium browser with MV3 support: Chrome, Edge, Brave, Vivaldi,
Arc, Opera.

## Use

Open the pile of videos in one window, click the toolbar icon, hit **Run this
window**. Play the first video. That's it.

| Action | Shortcut | What it does |
| --- | --- | --- |
| Run / stop | `Alt+Shift+R` | Arms or disarms the runner on the current window |
| Done → next | `Alt+Shift+N` | Close this tab now and play the next one |
| Skip → next | `Alt+Shift+M` | Keep this tab, move to the next one anyway |

Rebind them at `chrome://extensions/shortcuts`.

The toolbar badge shows how many tabs are left in the armed window, and turns
into a ✓ when you reach the last one.

## Speed

Two independent controls, in the popup:

**Play everything at** — applies your chosen rate to every video the runner
touches, once, when it starts playing. After that the rate is yours; the runner
won't re-force it when you seek. Pitch is preserved, so 1.75× doesn't chipmunk.

**Speed up further while nobody is talking** — multiplies whatever rate is in
effect during quiet stretches, and drops back the instant sound returns.

### How much this actually saves

Reproduce with:

```
deno run --allow-read test/estimate-savings.js
```

That drives the shipped decision logic against two synthetic 20-minute audio
profiles. These are model numbers meant to show the shape of the tradeoff, not a
promise about your particular backlog:

| Base speed | Silence skipping | Well-edited talk | Rambly screencast |
| --- | --- | --- | --- |
| Normal | off | — | — |
| Normal | 2× | 7% | 12% |
| 1.5× | off | 33% | 33% |
| 1.5× | 2× | 38% | 42% |
| 1.75× | 2× | 47% | 50% |
| 2× | 2× | 53% | 56% |

The honest read: **silence skipping is the smaller lever.** A well-edited talk is
only ~13% silence, and playing that silence at 2× recovers half of it — so ~7%.
Raising the base rate is where the time is. Silence skipping is worth turning on
because it stacks on top for free, not because it carries the feature.

Speed during silence is capped at 4×. Speech resumption is detected one frame
late, so at rate R you rush through R × ~16 ms of real video before dropping
back; past 4× that starts eating the first syllable of the next sentence.

## Settings

All in the popup:

- **Close the tab when its video ends** — off turns the runner into a pure
  auto-advance: it moves on but leaves everything open.
- **Start playing the next tab automatically** — the actual autoplay.
- **Pause a video when I switch away from it** — stops two things playing at once.
- **Wrap back to the first tab at the end** — makes the window a loop instead of
  a queue.
- **Wait before closing** (default 1200 ms) — grace period between the video
  ending and the tab closing.
- **Ignore videos shorter than** (default 15 s) — filters out bumpers and stings.

## Getting tabs back

Every tab the runner closes is recorded with its URL and listed in the popup
under **Closed by Tab Runner**, newest first, with a **Reopen** button. The last
60 are kept. This is the safety net for the one case that actually stings — a
mis-detected video ending and taking a tab you weren't done with.

## Design notes

Things that are deliberate rather than incidental:

- **Ads don't count.** A pre-roll's `<video>` fires `ended` exactly like the real
  video. Without a guard, a YouTube ad would close the tab before the video you
  queued ever started. The content script checks for YouTube's `ad-showing` /
  `ad-interrupting` player state and the ad overlay elements, and ignores those
  endings.
- **Only the tab you're looking at drives the queue.** A video finishing in a
  background tab never closes anything. Everything the runner does is anchored
  to the active tab of the one armed window.
- **The last tab is never closed.** Closing it would take the window down with
  it, so the runner stops and shows ✓ instead.
- **Grabbing the wheel cancels the close.** During the grace period, if you
  switch tabs or the tab is no longer in front, the runner stands down rather
  than closing something you just moved to.
- **The runner won't un-pause a video you paused on purpose.** It only starts
  playback it's entitled to: a video that has never been started, or one the
  runner itself paused when you switched away.
- **`ended` is caught in the capture phase on `document`.** The event doesn't
  bubble, but a capturing listener still sees it. This survives SPA navigation
  and players that swap out their `<video>` element, which a direct listener on
  the element would not.
- **The video is paused the instant it ends**, so YouTube's own "up next"
  countdown can't navigate the tab out from under the runner during the grace
  period.
- **Autoplay fallback.** Chrome blocks unmuted programmatic playback on pages
  that haven't earned autoplay permission. When `play()` is rejected, the content
  script starts the video muted and unmutes it as soon as playback is actually
  running — which Chrome does allow. On sites you watch often, the first attempt
  usually just works.

## How silence detection works, and where it doesn't

It measures energy in the 300–3400 Hz speech band via a Web Audio `AnalyserNode`,
and compares it against a threshold derived from **the video's own recent
loudness** — the 90th percentile of the last ~10 seconds, minus a margin. That
adaptive baseline is why a quietly-recorded lecture and a loud one both work
without touching the sensitivity dial.

It is **not** a speech classifier. It cannot tell speech from other sound, and
the tests pin down both directions of that:

- A music bed 15 dB under the narration reads as silence and gets sped through.
- Music only 6 dB under the narration reads as sound, so a musical interlude with
  no talking is *not* skipped.

If that turns out to be the thing that bothers you, the upgrade is a real voice
activity detector — Silero VAD via ONNX Runtime Web in an `AudioWorklet`. It
genuinely distinguishes speech from music. It also costs a ~2 MB model per tab
and runs into page CSP restrictions on some sites, which is why it isn't the
default.

### Why it refuses to run on some pages

Routing a video through Web Audio requires `createMediaElementSource`, and for
cross-origin media that wasn't CORS-approved at load time, that call makes the
audio output **silence, permanently** — it cannot be undone. So the extension
only attaches to media it knows is safe: `blob:`/MSE sources (which covers
YouTube and most streaming players), same-origin files, and elements with
`crossorigin` set. Everywhere else it declines and says so in the popup.

There is a second guard behind that one: if the analyser returns exact digital
silence for ~8 seconds while the video should be audible, silence skipping shuts
itself off rather than blasting through the whole video.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest, permissions, keyboard commands |
| `settings.js` | Every setting, its default, and its popup control. Source of truth |
| `background.js` | Service worker. Owns *all* tab closing and switching |
| `content.js` | Per-frame. Reports video endings, starts/pauses playback, applies default speed |
| `silence-skip.js` | Audio analysis and the speed-up decision |
| `popup.html` / `.css` / `.js` | Control panel, settings, reopen list |
| `test/` | Tests for the silence decision and the settings schema, plus the savings estimator |

Content scripts never close or switch tabs — they only report and play. Every
destructive action lives in `background.js`, in one function (`advance`).

### Where settings live

`settings.js` is imported by both the service worker and the popup. The popup
reads and writes `chrome.storage` **directly** and only messages the worker for
actions the worker owns (closing and switching tabs).

This matters more than it looks. The popup is re-parsed every time it opens; the
service worker only reloads when the extension does. Earlier the popup rendered
its controls from state the worker sent back, so adding a setting produced a
popup control the running worker had never heard of — the value came back
`undefined` and the dropdown rendered blank, discarding the value on every open.
`test/settings.test.js` now fails if that coupling returns.

## Tests

```
deno test --allow-read test/
```

Requires [Deno](https://deno.com). Nothing else — no package install, no lockfile.

`decider.test.js` loads the real `silence-skip.js` and drives its decision
function with synthetic level traces, so what's under test is the shipped code
rather than a copy. It covers engagement timing, immediate release on speech
onset, adaptation to quiet recordings, ignoring between-sentence gaps, and both
music failure modes.

`settings.test.js` cross-checks `settings.js` against `popup.html`: every exposed
control has a default behind it, every dropdown has an option matching that
default, control kinds match the markup and the default's type, and the popup
never goes back to sourcing setting values from the worker.

## Development note

Editing `popup.*` takes effect the next time you open the popup. Editing
`manifest.json`, `background.js`, `settings.js`, or either content script
requires **Reload** on the extension card at `chrome://extensions`. Mixing the
two is how the blank-dropdown bug hid.

## License

[MIT](LICENSE) — use it, fork it, ship it. If it saves you from a 200-tab window,
that was the point.

## Known limits

- Only tabs to the **right** are candidates, matching how you built the pile.
  Pinned tabs are skipped.
- Tabs Chrome won't run content scripts in (`chrome://`, the Web Store, PDF
  viewer) are still valid stops in the queue — they just can't autoplay or
  report an ending. Use `Alt+Shift+N` to move past them.
- Video in a cross-origin iframe works (the content script runs in all frames),
  but sites that wrap playback in a custom element with a shadow-DOM-isolated
  `<video>` may not report endings.
- Long-discarded background tabs reload when activated. The content script
  retries starting playback for ~9 seconds to cover that.
- Silence skipping needs unmuted audio to measure. While a video is muted — including
  the brief mute during the autoplay fallback — it holds at normal speed.
- Silence skipping stays off during ads, so it won't race through a pre-roll.
