/**
 * Guards the settings schema against the failure that produced blank dropdowns:
 * a control existing in popup.html with no matching default behind it, so its
 * value read back as undefined and the <select> rendered empty.
 *
 *   deno test --allow-read test/settings.test.js
 */

import { DEFAULTS, SETTING_CONTROLS } from '../settings.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? 'assertion failed');
}

const html = await Deno.readTextFile(new URL('../popup.html', import.meta.url));

/** Option values of a <select id="..."> in popup.html, or null if absent. */
function selectOptions(id) {
  const block = html.match(new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`));
  if (!block) return null;
  return [...block[1].matchAll(/value="([^"]*)"/g)].map((m) => m[1]);
}

Deno.test('every exposed control has a default behind it', () => {
  for (const key of Object.keys(SETTING_CONTROLS)) {
    assert(
      Object.hasOwn(DEFAULTS, key),
      `"${key}" is wired into the popup but missing from DEFAULTS - its control would render blank`
    );
    assert(DEFAULTS[key] !== undefined, `"${key}" has an undefined default`);
  }
});

Deno.test('every exposed control exists in popup.html', () => {
  for (const key of Object.keys(SETTING_CONTROLS)) {
    assert(html.includes(`id="${key}"`), `no element with id="${key}" in popup.html`);
  }
});

Deno.test('every dropdown has an option matching its default', () => {
  for (const [key, kind] of Object.entries(SETTING_CONTROLS)) {
    const options = selectOptions(key);
    if (kind === 'checkbox' || options === null) continue;
    assert(
      options.includes(String(DEFAULTS[key])),
      `<select id="${key}"> has no option for its default ${DEFAULTS[key]} ` +
        `(options: ${options.join(', ')}) - it would open blank`
    );
  }
});

Deno.test('checkbox controls are actually checkboxes in the markup', () => {
  for (const [key, kind] of Object.entries(SETTING_CONTROLS)) {
    if (kind !== 'checkbox') continue;
    assert(
      new RegExp(`<input type="checkbox" id="${key}"`).test(html),
      `"${key}" is declared a checkbox but is not one in popup.html`
    );
    assert(
      typeof DEFAULTS[key] === 'boolean',
      `"${key}" is a checkbox but its default is not a boolean`
    );
  }
});

Deno.test('numeric controls have numeric defaults', () => {
  for (const [key, kind] of Object.entries(SETTING_CONTROLS)) {
    if (kind !== 'number') continue;
    assert(
      typeof DEFAULTS[key] === 'number' && Number.isFinite(DEFAULTS[key]),
      `"${key}" is a numeric control but its default is ${DEFAULTS[key]}`
    );
  }
});

Deno.test('dropdown options all parse as numbers', () => {
  for (const [key, kind] of Object.entries(SETTING_CONTROLS)) {
    if (kind !== 'number') continue;
    const options = selectOptions(key);
    if (options === null) continue; // a plain number input, not a dropdown
    for (const value of options) {
      assert(
        Number.isFinite(Number(value)),
        `<select id="${key}"> option "${value}" is not numeric, but the popup stores it with Number()`
      );
    }
  }
});

/**
 * The DEFAULTS literal out of a content script. MV3 content scripts are classic
 * scripts and cannot import settings.js, so they carry their own copy - which is
 * what a fresh profile runs on, since storage holds nothing until the popup
 * writes something.
 */
function contentDefaults(file) {
  const src = Deno.readTextFileSync(new URL(`../${file}`, import.meta.url));
  const literal = src.match(/const DEFAULTS = (\{[^}]*\})/);
  assert(literal, `no DEFAULTS object literal found in ${file}`);
  return new Function(`return ${literal[1]}`)();
}

Deno.test('content script defaults match settings.js', () => {
  // silence-skip.js once shipped silenceHoldMs: 350 against a 3000 default here,
  // so a fresh install got the sub-second speed-ups the 3s default exists to
  // avoid until the user happened to touch that dropdown.
  for (const file of ['content.js', 'silence-skip.js']) {
    for (const [key, value] of Object.entries(contentDefaults(file))) {
      assert(
        Object.hasOwn(DEFAULTS, key),
        `${file} defaults "${key}", which settings.js does not define`
      );
      assert(
        DEFAULTS[key] === value,
        `${file} defaults ${key} to ${value} but settings.js says ${DEFAULTS[key]} ` +
          `- a fresh profile would run on the wrong value`
      );
    }
  }
});

Deno.test('content.js declares nothing at top level', () => {
  // The service worker re-injects content scripts after a reload, into the same
  // isolated world as the copy being replaced. A top-level `const` would throw
  // "already been declared" and abort the whole injection, leaving the tab with
  // only the dead copy: no video reports, no autoplay, no has-video answer.
  const src = Deno.readTextFileSync(new URL('../content.js', import.meta.url));
  const declaration = src.match(/^(?:const|let|class|function)\s+\S+/m);
  assert(
    !declaration,
    `content.js declares "${declaration?.[0]}" at top level - re-injection would ` +
      `throw a redeclaration error and abort. Keep declarations inside the IIFE.`
  );
});

Deno.test('videoless tabs are ruled out by URL before load state', () => {
  // A discarded chrome://newtab is still provably videoless. Testing load state
  // first made every discarded tab a stop, which is most of a hoarded window.
  const src = Deno.readTextFileSync(new URL('../background.js', import.meta.url));
  const body = src.match(/async function tabHasVideo\(tab\) \{([\s\S]*?)\n\}/);
  assert(body, 'tabHasVideo not found in background.js');
  // Comments stripped: both terms are discussed in the prose above the code.
  const code = body[1].replace(/\/\/.*$/gm, '');
  const url = code.indexOf('tab.pendingUrl');
  const state = code.indexOf('tab.discarded');
  assert(url !== -1, 'tabHasVideo no longer reads tab.pendingUrl');
  assert(state !== -1, 'tabHasVideo no longer reads tab.discarded');
  assert(
    url < state,
    'tabHasVideo checks load state before the URL again - discarded videoless ' +
      'tabs would all become stops'
  );
});

Deno.test('the popup does not ask the worker for setting values', () => {
  // The original bug: the popup rendered from state the service worker sent
  // back, and the worker only reloads with the extension.
  const popup = Deno.readTextFileSync(new URL('../popup.js', import.meta.url));
  assert(
    !popup.includes('get-status'),
    'popup.js is round-tripping settings through the service worker again'
  );
});
