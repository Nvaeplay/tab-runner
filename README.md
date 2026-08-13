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

It never engages on a **live stream**, and there is no setting for that. A
recording is already on its way down the wire, so spending buffer faster than
real time costs nothing. A live stream only contains what has already been
broadcast: it produces one second of media per second, and any rate above 1×
borrows against the live edge until there is nothing left to play. The player
stalls, buffers, and hands back a few seconds — which arrive as digital silence,
which reads as "nobody is talking", which speeds it up again. A quiet moment in a
live stream became permanent rebuffering. Nothing about a live stream makes
speeding it up work, so there is nothing for a user to decide.

Streams with no known end give themselves away with an infinite duration.
YouTube's are seekable inside a DVR window and report *that* length, which looks
exactly like a recording, so the player's own `ytp-live` marker is checked too —
and as a last resort, a duration that keeps creeping forward.

The same reasoning applies below the live line: speeding up also needs a few
seconds of buffer ahead of the playhead, and hands the rate back if that runs
down. A stalled video outputs nothing, and nothing measures as silence.

**After this much quiet** (default 3 s) — how long silence must last before the
speed-up kicks in. This is a feel control more than a savings one: at a few
hundred milliseconds the rate changes on every breath between sentences, which
reads as glitchy playback rather than as speed. Three seconds means only real
dead air qualifies.

### How much this actually saves

Reproduce with:

```
deno run --allow-read test/estimate-savings.js
```

That drives the shipped decision logic against two synthetic 20-minute audio
profiles. These are model numbers meant to show the shape of the tradeoff, not a
promise about your particular backlog:

At the default 3-second threshold:

| Base speed | Silence skipping | Well-edited talk | Rambly screencast |
| --- | --- | --- | --- |
| Normal | off | — | — |
| Normal | 2× | 2% | 4% |
| 1.5× | off | 33% | 33% |
| 1.5× | 2× | 35% | 36% |
| 1.75× | 2× | 44% | 45% |
| 2× | 2× | 51% | 52% |

The honest read: **silence skipping is the smaller lever, and the 3-second
threshold makes it smaller still.** Requiring three seconds of quiet excludes
every between-sentence pause, which is most of the silence in a talk — only 4–8%
of runtime ends up sped. Dropping the threshold to 1 s roughly doubles the
contribution, at the cost of the rate visibly flickering during natural speech
gaps.

Raising the base rate is where the time actually is. Silence skipping is worth
having because it stacks on top for free, not because it carries the feature.

Speed during silence is capped at 4×. Speech resumption is detected one frame
late, so at rate R you rush through R × ~16 ms of real video before dropping
back; past 4× that starts eating the first syllable of the next sentence.

## Settings

All in the popup:

- **Close the tab when its video ends** — off turns the runner into a pure
  auto-advance: it moves on but leaves everything open.
- **Start playing the next tab automatically** — the actual autoplay.
- **Also start videos that were left paused** — off restricts autoplay to videos
  that have never been started, so a video you paused part-way stays paused.
- **Pause a video when I switch away from it** — stops two things playing at once.
  Also stops anything *starting* in a tab you've left, including the runner's own
  arrival retries. Works whether or not the runner is armed.
- **Wrap back to the first tab at the end** — makes the window a loop instead of
  a queue.
- **Skip past tabs with no video** — steps over tabs with nothing to play instead
  of stalling on them. Never closes anything. On by default.
- **Wait before closing** (default 1200 ms) — grace period between the video
  ending and the tab closing.
- **Ignore videos shorter than** (default 15 s) — filters out bumpers and stings.

## Skipping tabs with no video

Open tabs faster than you can read them and you end up with strays: a new tab
page you never typed into, a docs page, a YouTube home page. They have nothing to
play, so the queue used to stall on them.

The runner now steps *over* them. **Nothing is closed** — skipped tabs stay
exactly where they are, and you can go back to them whenever. On by default,
since it only changes where the runner lands.

A tab is only skipped when it can be **proven** to have no video, because
skipping something watchable silently drops it from the queue. So:

- Pages no content script can run in — `chrome://`, `about:blank`, the new tab
  page, the Web Store, the PDF viewer — genuinely cannot play anything, and are
  skipped. This is settled from the URL alone, so it holds even for a tab Chrome
  has put to sleep.
- Ordinary pages are asked directly whether they hold a video with real media
  behind it. An empty `<video>` element (YouTube's home page keeps one for hover
  previews) doesn't count.
- **Discarded or still-loading tabs get landed on, then checked again.** No
  content script is running to ask, so the runner has to assume they might have
  something. It moves there, waits for the tab to wake up, and then asks
  repeatedly for a few seconds — a player that is still booting reports no media
  for a while, and one negative answer is not enough to drop a tab from the queue.
  Only a tab that stays empty the whole time is moved on from.
- A page that should be reachable but isn't gets stopped at, not skipped.

That last point matters more than it sounds. In a window you filled by spamming
new tabs, Chrome has discarded most of the background ones, so the leftover new
tab pages and bare YouTube home pages this setting exists to step over were
exactly the ones the "assume it might" rule protected — which made the setting
look like it did nothing. Checking again on arrival is what fixes it. One chain
of arrival checks moves on at most 10 times.

If everything ahead is videoless the runner stops and shows ✓ rather than
depositing you on a blank tab. One advance looks ahead at most 25 tabs.

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
- **Landing on a tab starts its video by default** — whether it never started or
  you paused it by hand. No attempt is made to guess which pauses were
  deliberate; the runner exists to keep playback moving. Turn off *Also start
  videos that were left paused* to restrict it to videos that never started, or
  *Start playing the next tab automatically* to stop it touching playback at all.
- **An extension reload replaces content scripts in open tabs.** Chrome doesn't
  do this itself: the old copies keep running but every `chrome.*` call throws
  `Extension context invalidated`, so a finished video never reports back and the
  queue stops dead with no visible symptom. Tabs that answer a ping are left
  alone; the rest are re-injected. Content scripts also route every `chrome.*`
  call through a guard, because that error is thrown *synchronously* and a
  trailing `.catch()` never sees it.
- **Content scripts are wrapped so they can be injected twice.** The replacement
  copy lands in the *same* isolated world as the orphan it replaces, so a
  top-level `const` would throw `Identifier … has already been declared` and abort
  the whole injection — leaving the tab with nothing but the dead copy, which
  looks exactly like several unrelated features breaking at once. Everything lives
  inside an IIFE, and a live copy is detected and left alone rather than stacked
  on top of.
- **Nothing starts playing in a background tab** while *Pause a video when I
  switch away from it* is on. A single `visibilitychange` isn't enough for that: a
  player can start on its own well after you left — YouTube's "up next", a lazily
  initialised player, a discarded tab finishing its reload, or the runner's own
  arrival retries, which keep looking for a video for ~9 seconds. `play` is
  watched in the capture phase instead, which fires before any audio is produced.
  There is a short grace period after the runner asks a tab to resume: activating
  a tab and telling it to play travel different IPC pipes, so the message can
  arrive while the renderer still reports the tab as hidden, and without the grace
  this guard stopped the video the runner had just started.
- **The tab being left is told to stop from outside the page.** Leaving the pause
  to the page's own `visibilitychange` puts it at the mercy of the page: content
  scripts run at `document_idle`, so ours is always the *last* listener added to
  that document, and a page listener that runs first and calls
  `stopImmediatePropagation()` takes every later one down with it. The service
  worker now remembers which tab was in front of each window and sends the one
  you left an explicit stop, which does not travel through the page at all. The
  content script's own visibility watch stays as the second route, moved to a
  **capturing listener on `window`** so it runs ahead of the entire document
  phase, and the stop is re-applied over the next second and a half so a player
  that undoes an outside pause doesn't win the last word. The last-active tab per
  window lives in `chrome.storage.session`, not a variable: the worker is torn
  down seconds after it goes idle, and a variable would be empty on exactly the
  event that needs it.
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

## How speech detection works, and where it doesn't

Everything is measured off one Web Audio `AnalyserNode` on the 300–3400 Hz speech
band, and a frame has to fail three tests before it counts as "nobody is talking".

**Is it loud enough?** The level is compared against a threshold derived from
**the video's own recent loudness** — the 90th percentile of the last ~10 seconds,
minus a margin. That adaptive baseline is why a quietly-recorded lecture and a
loud one both work without touching the sensitivity dial.

**Is it moving like speech?** Level alone cannot tell a quiet room from a loud
one. A kitchen, a car, an air conditioner, road noise, a crowd — any of these can
sit close enough to the speaking level that nothing ever falls under the
threshold, and a stretch with nobody talking in it plays out in full at 1×. But
speech is *modulated*: syllables push the band up and down by 10–25 dB several
times a second, where ambience holds a near-constant level. The recent
peak-to-trough range over the last second separates the two.

**Is it shaped like speech?** Voiced sound is a pitch plus its harmonics under a
couple of formants — a few strong peaks. Broadband noise spreads evenly. The
spectral flatness of the band (geometric mean over arithmetic mean, ~0 for peaks
and 1 for white noise) says which one this is.

Neither shape test is conclusive alone — a held note is unmodulated, a hiss is
brief — so a frame above the threshold is only demoted to ambience when it fails
**both**. The tests pin that down in all four directions.

It is still **not** a speech classifier, and music is where that shows:

- A music bed 15 dB under the narration reads as silence and gets sped through.
- Music only 6 dB under the narration is modulated *and* peaky, so a musical
  interlude with no talking is *not* skipped.

### Why not a transcript API or a real VAD

Three options were weighed against the local analysis above before it was built.

| Approach | Verdict |
| --- | --- |
| **Local DSP** — level + modulation + flatness | **Shipped.** ~40 lines on an analyser that was already running. No model, no download, no permission, no per-tab cost worth measuring. Beats level alone on exactly the failure that prompted it: loud ambience. Cannot tell speech from music. |
| **Web Speech API** — `SpeechRecognition.start(audioTrack)`, [Chrome 133+](https://chromestatus.com/feature/5178378197139456), on-device via [`processLocally`](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/processLocally) | **No.** It can genuinely take tab audio now, and on-device keeps it private. But recognition results land hundreds of milliseconds to seconds behind the audio, and the whole feature turns on reacting to speech *within one frame*. A transcript tells you what was said after it was said. It also needs `captureStream()`, which fails on DRM-protected media, and a language pack that may not be installed. |
| **Silero VAD** via ONNX Runtime Web in an `AudioWorklet` | **Not now.** A real speech/music/noise classifier, and the only option that fixes the music case. Costs a ~2 MB model plus the ORT wasm runtime in every tab, needs `wasm-unsafe-eval`, and runs into page CSP on some sites. Worth revisiting if music turns out to be the thing that bothers you; ambience was. |

Captions are the other tempting "transcript" answer — cue gaps are exact speech
boundaries and cost nothing to read. `video.textTracks` is the honest version of
that and is worth using where a player exposes it, but YouTube renders its own
captions in its own overlay and exposes nothing there, so getting them means
scraping the timed-text endpoint out of the player response. That is fragile,
site-specific, and it is a network fetch for something a local measurement
already answers.

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

It also guards three things that aren't schema, but broke the same quiet way —
working code, no error, a feature that just doesn't happen:

- The content scripts' own `DEFAULTS` must match `settings.js`. They can't import
  it (MV3 content scripts are classic scripts), and their copy is what a fresh
  profile runs on until the popup writes something. `silence-skip.js` once shipped
  a 350 ms silence threshold against a 3 s default here.
- `content.js` must declare nothing at top level, or re-injection dies on a
  redeclaration.
- `tabHasVideo` must rule tabs out by URL *before* looking at load state, or every
  discarded tab becomes a stop.

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
