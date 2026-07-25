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

Deno.test('the popup does not ask the worker for setting values', () => {
  // The original bug: the popup rendered from state the service worker sent
  // back, and the worker only reloads with the extension.
  const popup = Deno.readTextFileSync(new URL('../popup.js', import.meta.url));
  assert(
    !popup.includes('get-status'),
    'popup.js is round-tripping settings through the service worker again'
  );
});
