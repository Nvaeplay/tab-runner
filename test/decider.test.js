/**
 * Tests for the silence decision logic in silence-skip.js.
 *
 * Loads the real content script (it is a classic script, not a module) and
 * drives its decider with synthetic speech-band level traces, so the thing
 * under test is the shipped code rather than a copy of it.
 *
 *   deno test --allow-read test/decider.test.js
 */

function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? 'assertion failed');
}

function assertEquals(actual, expected, msg) {
  if (!Object.is(actual, expected)) {
    throw new Error(msg ?? `expected ${expected}, got ${actual}`);
  }
}

const src = await Deno.readTextFile(new URL('../silence-skip.js', import.meta.url));
const SilenceSkip = new Function(`${src}\nreturn SilenceSkip;`)();
const createDecider = SilenceSkip._createDecider;

const FRAME_MS = 1000 / 60;
const BALANCED = { silenceMarginDb: 14, silenceHoldMs: 350 };

/**
 * Run a level trace through a decider.
 * @param {Array<{db: number, ms: number}>} segments
 * @returns {{fast: boolean[], times: number[], settleMs: number}}
 */
function run(segments, settings = BALANCED) {
  const decider = createDecider(() => settings);
  const fast = [];
  const times = [];
  let now = 0;
  for (const { db, ms } of segments) {
    for (let elapsed = 0; elapsed < ms; elapsed += FRAME_MS) {
      // A little jitter, because real audio is never a flat line.
      const level = db + (Math.random() - 0.5) * 2;
      fast.push(decider.push(level, now));
      times.push(now);
      now += FRAME_MS;
    }
  }
  return { fast, times };
}

/** Milliseconds spent at fast speed within a time window. */
function fastMsBetween({ fast, times }, from, to) {
  let ms = 0;
  for (let i = 0; i < fast.length; i++) {
    if (times[i] >= from && times[i] < to && fast[i]) ms += FRAME_MS;
  }
  return ms;
}

Deno.test('speeds up during a silent gap, and only after the hold', () => {
  // 6s of speech to learn the loudness, then a 4s gap, then speech again.
  const trace = run([
    { db: -25, ms: 6000 },
    { db: -70, ms: 4000 },
    { db: -25, ms: 2000 },
  ]);

  const duringGap = fastMsBetween(trace, 6000, 10000);
  // Should be fast for the gap minus the ~350ms hold.
  assert(duringGap > 3200, `expected >3200ms fast in the gap, got ${duringGap}`);
  assert(duringGap < 3800, `expected <3800ms fast in the gap, got ${duringGap}`);

  // The hold must actually delay engagement, not fire instantly.
  assertEquals(fastMsBetween(trace, 6000, 6300), 0);
});

Deno.test('never speeds up while speech is continuous', () => {
  const trace = run([{ db: -25, ms: 12000 }]);
  assertEquals(fastMsBetween(trace, 0, 12000), 0);
});

Deno.test('drops back to normal within one frame of speech returning', () => {
  const trace = run([
    { db: -25, ms: 6000 },
    { db: -70, ms: 3000 },
    { db: -25, ms: 2000 },
  ]);
  // No fast frames survive past the first frame after speech resumes at 9000ms.
  assertEquals(fastMsBetween(trace, 9000 + FRAME_MS, 11000), 0);
});

Deno.test('adapts to a quietly recorded video without a sensitivity change', () => {
  // Same shape as the first test but 30 dB quieter throughout.
  const trace = run([
    { db: -55, ms: 6000 },
    { db: -100, ms: 4000 },
    { db: -55, ms: 2000 },
  ]);
  const duringGap = fastMsBetween(trace, 6000, 10000);
  assert(duringGap > 3200, `expected >3200ms fast in the gap, got ${duringGap}`);
});

Deno.test('ignores pauses shorter than the hold', () => {
  // Natural between-sentence breathing gaps of 200ms.
  const segments = [{ db: -25, ms: 6000 }];
  for (let i = 0; i < 10; i++) {
    segments.push({ db: -70, ms: 200 }, { db: -25, ms: 800 });
  }
  const trace = run(segments);
  assertEquals(fastMsBetween(trace, 6000, 16000), 0);
});

Deno.test('DOCUMENTED LIMIT: a music bed under narration still reads as silence', () => {
  // Narration at -25 dB, music-only stretch at -40 dB. A human would want the
  // music-only part skipped or not depending on taste, but the point is that
  // this is decided by level alone - the algorithm has no idea it is music.
  const trace = run([
    { db: -25, ms: 6000 },
    { db: -40, ms: 4000 },
    { db: -25, ms: 2000 },
  ]);
  const duringMusic = fastMsBetween(trace, 6000, 10000);
  assert(
    duringMusic > 3000,
    `music bed at 15 dB below speech is treated as silence (${duringMusic}ms fast) - ` +
      'this is the known limit of level-based detection'
  );
});

Deno.test('DOCUMENTED LIMIT: loud music holds it at normal speed', () => {
  // Music at only 6 dB below speech sits above the 14 dB margin, so a musical
  // interlude with no talking will NOT be skipped.
  const trace = run([
    { db: -25, ms: 6000 },
    { db: -31, ms: 4000 },
    { db: -25, ms: 2000 },
  ]);
  assertEquals(fastMsBetween(trace, 6000, 10000), 0);
});

Deno.test('aggressive sensitivity skips less than cautious', () => {
  const segments = [
    { db: -25, ms: 6000 },
    { db: -42, ms: 4000 },
    { db: -25, ms: 2000 },
  ];
  const cautious = fastMsBetween(run(segments, { silenceMarginDb: 20, silenceHoldMs: 350 }), 6000, 10000);
  const aggressive = fastMsBetween(run(segments, { silenceMarginDb: 9, silenceHoldMs: 350 }), 6000, 10000);
  // A 17 dB drop clears the aggressive (9 dB) bar but not the cautious (20 dB) one.
  assertEquals(cautious, 0);
  assert(aggressive > 3000, `expected aggressive to engage, got ${aggressive}ms`);
});

Deno.test('reset clears learned loudness so a new video starts fresh', () => {
  const decider = createDecider(() => BALANCED);
  let now = 0;
  for (let i = 0; i < 600; i++, now += FRAME_MS) decider.push(-25, now);
  assert(decider.threshold > -Infinity, 'should have learned a threshold');
  decider.reset();
  assertEquals(decider.threshold, -Infinity);
});
