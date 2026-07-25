/**
 * Reproduces the savings table in the README.
 *
 * Drives the real decision logic from silence-skip.js with synthetic audio level
 * traces and reports how much wall-clock time you save at various base speeds,
 * with and without silence skipping.
 *
 *   deno run --allow-read test/estimate-savings.js
 *
 * These are model numbers, not measurements of real videos. They exist to show
 * the *shape* of the tradeoff - that base playback rate dominates silence
 * skipping - not to promise a specific percentage on your particular backlog.
 */

const src = await Deno.readTextFile(new URL('../silence-skip.js', import.meta.url));
const SilenceSkip = new Function(`${src}\nreturn SilenceSkip;`)();

const FRAME_MS = 1000 / 60;
const MAX_RATE = 4;

/**
 * A talk-shaped level trace: sentences separated by short breathing gaps, with a
 * longer dead-air pause every `longPauseEvery` sentences.
 */
function lectureProfile(minutes, longPauseEvery) {
  const out = [];
  const target = minutes * 60 * 1000;
  let total = 0;
  let i = 0;
  while (total < target) {
    const sentence = 2500 + Math.random() * 3000;
    out.push({ db: -26 + Math.random() * 4, ms: sentence });
    total += sentence;

    const long = i % longPauseEvery === longPauseEvery - 1;
    const gap = long ? 2500 + Math.random() * 4000 : 250 + Math.random() * 350;
    out.push({ db: -72, ms: gap });
    total += gap;
    i++;
  }
  return out;
}

// Matches the shipped defaults in settings.js.
const SILENCE_MARGIN_DB = 14;
const SILENCE_HOLD_MS = 3000;

function simulate(profile, baseRate, multiplier) {
  const decider = SilenceSkip._createDecider(() => ({
    silenceMarginDb: SILENCE_MARGIN_DB,
    silenceHoldMs: SILENCE_HOLD_MS,
  }));
  let now = 0;
  let realMs = 0; // wall-clock time you spend watching
  let videoMs = 0; // video timeline consumed
  let quietMs = 0;

  for (const { db, ms } of profile) {
    for (let elapsed = 0; elapsed < ms; elapsed += FRAME_MS) {
      const fast = decider.push(db + (Math.random() - 0.5) * 2, now);
      if (fast) quietMs += FRAME_MS;
      const rate = Math.min(fast ? baseRate * multiplier : baseRate, MAX_RATE);
      videoMs += FRAME_MS;
      realMs += FRAME_MS / rate;
      now += FRAME_MS;
    }
  }
  return { videoMs, realMs, quietMs };
}

const profiles = [
  ['Well-edited talk', lectureProfile(20, 7)],
  ['Rambly screencast', lectureProfile(20, 3)],
];

console.log(`Silence must last ${SILENCE_HOLD_MS / 1000}s before speeding up (the default).`);

for (const [label, profile] of profiles) {
  const probe = simulate(profile, 1, 2);
  const quietPct = ((probe.quietMs / probe.videoMs) * 100).toFixed(0);
  console.log(`\n${label} - 20 min, ${quietPct}% spent sped up\n`);
  console.log('  base    silence   watched    saved');
  console.log('  ------  --------  ---------  -------');

  for (const base of [1, 1.5, 1.75, 2]) {
    for (const mult of [1, 2]) {
      const { videoMs, realMs } = simulate(profile, base, mult);
      const saved = ((videoMs - realMs) / videoMs) * 100;
      console.log(
        `  ${String(base).padEnd(6)}  ${(mult === 1 ? 'off' : `${mult}x`).padEnd(8)}  ` +
          `${(realMs / 60000).toFixed(1).padStart(6)} min  ${saved.toFixed(0).padStart(5)}%`
      );
    }
  }
}

console.log('\nSilence skipping is the smaller lever. Base rate is where the time is.\n');
