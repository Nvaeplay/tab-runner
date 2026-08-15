# Chrome Extension — practice guide

How to design, build, version, and ship a **Chrome extension** (Manifest V3). Official start: [Get started](https://developer.chrome.com/docs/extensions/get-started).

**Default posture:** one narrow purpose, least privilege, all logic in the package, store listing matches the code. Prefer official Chrome APIs over clever workarounds.

---

## What this is / is not

An extension is HTML/CSS/JS plus a `manifest.json` that can customize Chrome UI, observe browser events, and (with permission) touch pages.

It is **not**:

- A website that happens to live in a toolbar
- A license to inject remote JS, scrape everything, or request `<all_urls>` “just in case”
- Manifest V2 (new CWS items must be **MV3**)

---

## Always-on rules

1. **MV3 only** for anything that will ship to the [Chrome Web Store](https://chromewebstore.google.com/).
2. **Single purpose.** One narrowly defined job, easy to explain in one sentence. Listing, screenshots, and permissions must match that job.
3. **All executable logic ships in the ZIP.** No remotely hosted JS/Wasm, no CDN scripts, no `eval` / `new Function` / string `executeScript` on extension pages. Config JSON and HTTPS APIs are fine; code is not.
4. **Least privilege.** Prefer `activeTab` + user gesture over host permissions; optional permissions over install-time warnings; specific match patterns over `<all_urls>`.
5. **Service workers are ephemeral.** Persist in `chrome.storage`. Use `chrome.alarms`, not `setInterval`. No DOM in the SW — use an [offscreen document](https://developer.chrome.com/docs/extensions/reference/api/offscreen) if needed.
6. **Treat content scripts as untrusted.** Validate messages. Do not send secrets or privileged data to the page world.
7. **HTTPS only** for any network I/O.
8. **Never invent secrets.** Placeholders only. Never commit CWS credentials, `.pem` signing keys, or API tokens.
9. **Do not publish, unpublish, or change store visibility** without an explicit ask.

---

## Anatomy

`manifest.json` is the only required file. It must sit at the **package root**.

| Piece | Role | Notes |
|-------|------|--------|
| `manifest.json` | Metadata, permissions, entry points | [Manifest](https://developer.chrome.com/docs/extensions/reference/manifest) |
| Service worker | Background events | [SW concepts](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers) |
| Content scripts | Run in page context | Isolated world by default |
| Action / popup | Toolbar click UI | Popup HTML is a separate document |
| Side panel | Persistent adjacent UI | Keep it useful, not noisy |
| Options page | Settings | Prefer `open_in_tab: true` for complex settings |
| `declarativeNetRequest` | Block/modify requests | Prefer over blocking `webRequest` |

Minimal skeleton (adapt; do not copy unused keys):

```json
{
  "manifest_version": 3,
  "name": "Example",
  "version": "0.0.0.1",
  "description": "≤132 chars. Accurate.",
  "icons": { "16": "icons/16.png", "48": "icons/48.png", "128": "icons/128.png" },
  "action": { "default_popup": "popup.html", "default_icon": "icons/16.png" },
  "background": { "service_worker": "background.js", "type": "module" },
  "permissions": ["storage", "activeTab"],
  "host_permissions": []
}
```

Start `version` low (`0.0.0.1`). Every CWS upload must be **strictly greater**.

---

## Local development

Load unpacked — do not pack a `.crx` for day-to-day work.

1. `chrome://extensions` → **Developer mode** on
2. **Load unpacked** → select the folder that contains `manifest.json`
3. Pin the icon while iterating
4. After code changes, reload per table below

| Change | Reload |
|--------|--------|
| Manifest | Extension reload |
| Service worker | Extension reload |
| Content script | Extension reload **and** host tab |
| Popup / options / other extension HTML | Usually just re-open |

Debug: popup → right-click → Inspect. SW / content / options: [Debug tutorial](https://developer.chrome.com/docs/extensions/get-started/tutorial/debug). Errors also surface on `chrome://extensions`.

Types: `chrome-types` npm package, keep it current.

### When to reload vs when to ship

Unpacked = source of truth during development. CWS ZIP is a **built package**, not the git root, if you use a bundler.

---

## Permissions (pick the weakest that works)

| Need | Prefer | Avoid |
|------|--------|--------|
| Act on the tab the user just clicked | `activeTab` + `scripting` | Permanent host access |
| Persist settings | `storage` | Writing to page `localStorage` as the store of record |
| Extra power later | `optional_permissions` / `optional_host_permissions` | Asking at install “for later” |
| Network filter | `declarativeNetRequest` | Blocking `webRequest` |
| Cross-origin `fetch` from SW | Tight `host_permissions` match patterns | `*://*/*` |

Adding or widening `permissions`, `host_permissions`, or `content_scripts.matches` can **disable the extension until the user re-accepts**. Treat permission growth as a product event, not a drive-by.

`file://` and incognito are **user toggles** on the extension details page, not manifest flags you can force.

---

## Security & privacy predicates

- Bundle third-party libs. If a lib fetches more JS at runtime (some Firebase builds), replace it or pre-bundle every chunk.
- CSP `extension_pages`: `script-src` / `object-src` / `worker-src` may only be `self`, `none`, `wasm-unsafe-eval`, or (unpacked only) localhost.
- Minimize `web_accessible_resources` and `externally_connectable`.
- No `innerHTML` / `document.write` for untrusted strings — build DOM + `textContent`.
- Privacy tab + privacy policy must match actual collection. If you collect nothing, say so honestly.
- Publisher Google account: 2FA (security key preferred). Least-privilege dashboard roles.

Remote-code alternatives (allowed):

| Goal | Do this |
|------|---------|
| Feature flags | Fetch/cache JSON config |
| Changeable logic | Your HTTPS API; client stays in the ZIP |
| UI framework | Vendor React/etc. into the package |
| Truly dynamic eval | Sandboxed iframe only; no page DOM |

---

## Performance

- Do not use `unload` handlers (kills [bfcache](https://web.dev/articles/bfcache)). Use `pagehide` or `chrome.tabs.onRemoved`.
- Do not open WebSockets / WebRTC from content scripts (also kills bfcache). Proxy via the SW.
- Keep the SW idle so Chrome can apply updates.
- Test with [Puppeteer extension guide](https://pptr.dev/guides/chrome-extensions) plus manual pass on current stable Chrome.

---

## Version control

Treat the **repo as source**, the **ZIP as a release artifact**.

### Do commit

- Source, `manifest.json` (or the template that generates it)
- Icons, locales, `README`, `CHANGELOG`
- `.env.example`, lockfile, lint/test config
- `package.json` scripts: `dev` / `build` / `zip`

### Never commit

| Artifact | Why |
|----------|-----|
| `node_modules/`, build caches | Regenerable |
| `.pem` / private signing keys | Account takeover = malware push |
| CWS OAuth client secrets, refresh tokens, `.env` | Same |
| Generated `dist/` (if a bundler owns it) | Rebuild on tag |
| Source maps in the **store ZIP** unless you intend them public | Leak + size |
| Real user data, cookies, session dumps | Privacy |

`.gitignore` minimum: `node_modules/`, `dist/`, `*.pem`, `.env`, `*.crx`, `*.zip` (keep zips in GitHub Releases if you want artifacts).

### IDs and keys

- Unpacked ID is a hash of the path (changes if you move the folder).
- For a **stable unpacked ID**, put the **public** `"key"` in the manifest (not the private key).
- CWS assigns the public ID on first upload. After that, do not rotate the signing identity casually.
- Optional extra store protection: [Verified CRX uploads](https://developer.chrome.com/docs/webstore/update) — private key stays offline, never in the Google account, never in git.

### Version numbers

| Field | Use |
|-------|-----|
| `version` | 1–4 dot-separated integers, each 0–65535. No leading zeros. Not all zeros. **Must increase** on every store upload. Compared left-to-right; missing parts = 0. |
| `version_name` | Optional display string (`1.2.0-beta`). Not used for update compare. |

Convention here: **semver in `version`** (`MAJOR.MINOR.PATCH`). Bump only when cutting a store (or trusted-tester) build.

- Patch: fix, no new permissions
- Minor: feature, same permission surface
- Major: breaking behavior **or** new install-time permission / host access

Git: tag `v1.2.3` when that `version` is submitted. One tag ↔ one uploaded package.

### Branch / release flow

```
main          last known-good (or next)
feature/*     unpacked iteration
release/x.y.z freeze → bump version → zip → upload → tag
```

1. Develop unpacked; do **not** bump `version` on every commit.
2. Before ship: increment `version`, update `CHANGELOG`, production-test unpacked.
3. `build` → ZIP with **`manifest.json` at zip root** (not nested in a folder). Exclude `.git`, tests, `node_modules`, secrets.
4. Upload ZIP (max **2 GB**). Manifest metadata is frozen after upload — typo in `name`/`description` means re-zip + higher version.
5. Submit for review. Prefer **deferred publish** if you need a coordinated announce.
6. Tag the commit that built that ZIP.

Permission-expanding updates: users must accept or the extension disables. Call this out in changelog + listing.

---

## Shipping (Chrome Web Store)

Prep: [Prepare](https://developer.chrome.com/docs/webstore/prepare) · Publish: [Publish](https://developer.chrome.com/docs/webstore/publish) · Update: [Update](https://developer.chrome.com/docs/webstore/update)

| Step | Detail |
|------|--------|
| Account | Register, pay one-time fee, enable 2FA |
| Package | ZIP of **built** files, manifest at root |
| Listing | Honest name, description, category, required images ([images](https://developer.chrome.com/docs/webstore/images)) |
| Privacy | Single-purpose statement + data-use that matches code |
| Distribution | Public / unlisted / private (trusted testers) |
| Test notes | Reviewer steps + credentials if login is required |
| Review | Same process on first publish and later upgrades |
| Deferred publish | After pass, **30 days** to hit Publish or it reverts to draft |
| Item cap | 20 published **extensions** per account (themes unlimited; raise via support) |

Channels:

- **Trusted testers / private** for dogfood
- **Public** for real users
- Parallel test + prod = **two store items**, not one item flipped back and forth (and not [repetitive content](https://developer.chrome.com/docs/webstore/program-policies))
- Moving public → private requires unpublish + republish; going public again is a new review

Large items (≥ ~10k 7-day users): **percentage rollout**. Raising % after publish does not re-review. A newer upload cancels the previous partial rollout.

Broken ship: [rollback](https://developer.chrome.com/docs/webstore/rollback) rather than panic-hotpatch without a version bump.

### Update lifecycle (after publish)

Chrome checks on startup and every few hours. An update **installs only when the extension is idle** (SW not running; no open popup / side panel / options). Content scripts do not block idle. A chatty SW can delay uptake until browser restart.

- Users: `chrome://extensions` + Developer mode → **Update**
- Extension: `chrome.runtime.requestUpdateCheck()` (throttled) and `onUpdateAvailable` → `reload()` when safe
- Analytics: CWS dashboard → Analytics → Users → daily users by version
- `minimum_chrome_version`: old Chrome users **silently stop updating** if you raise it past them

Enterprise: force-install, version pin, `override_update_url` can ignore CWS. Do not assume every install auto-updates.

---

## How Claude / Grok should work

- Read this file before scaffolding or reviewing an extension.
- Default stack: **vanilla MV3** (HTML/CSS/JS modules). Add Vite/TypeScript only if the repo already has it or the owner asks.
- Do not add analytics, ads, affiliate injection, or broad host permissions unless asked **and** policy-safe.
- Do not download JS at runtime. Do not recommend MV2.
- Ask before: publishing, unpublishing, widening permissions, adding `"key"`, enabling verified CRX, or changing store listing claims.
- After meaningful changes, state: **what changed**, **how to reload/test**, **whether `version` must bump**, **new permission warnings**.

### Preferred deliverables

| Deliverable | When |
|-------------|------|
| `manifest.json` + file map | New extension |
| Unpacked load + reload notes | Any code change |
| Permission justification table | Any permission add |
| `CHANGELOG` + version bump | Store-bound release |
| ZIP contents checklist | Before upload |
| Store listing + privacy draft | First publish / purpose change |

### Prompt stubs

- **Scaffold:** “MV3 extension, single purpose: ____. Least privilege. Popup + SW. No remote code.”
- **Review:** “Check this unpacked extension against `.md/CHROME-EXTENSION.md`: permissions, RHC, SW lifetime, zip hygiene.”
- **Ship:** “Bump version, write changelog, list zip includes/excludes, deferred-publish checklist.”

---

## Official pointers (do not paraphrase into a second source of truth)

| Topic | URL |
|-------|-----|
| Get started | https://developer.chrome.com/docs/extensions/get-started |
| Hello World (load unpacked) | https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world |
| Develop map | https://developer.chrome.com/docs/extensions/develop |
| Permissions | https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions |
| Stay secure | https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure |
| No remote code | https://developer.chrome.com/docs/extensions/develop/migrate/improve-security |
| Update lifecycle | https://developer.chrome.com/docs/extensions/develop/concepts/extensions-update-lifecycle |
| Manifest `version` | https://developer.chrome.com/docs/extensions/reference/manifest/version |
| Quality / listing best practices | https://developer.chrome.com/docs/webstore/best_practices |
| Program policies | https://developer.chrome.com/docs/webstore/program-policies |
| Prepare / publish / update | https://developer.chrome.com/docs/webstore/prepare · [publish](https://developer.chrome.com/docs/webstore/publish) · [update](https://developer.chrome.com/docs/webstore/update) |
| Samples | https://github.com/GoogleChrome/chrome-extensions-samples |

---

## Non-goals

- Firefox/Edge ports (possible later; APIs differ — do not assume Chrome-only APIs exist there)
- Sideloading policy-circumvention or “unlisted malware-style” distribution advice
- MV2 maintenance
- Full CWS marketing copy unless asked
