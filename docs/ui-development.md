# Standalone UI development

The mock host in `dev/` serves the application's actual `wwwroot` with synthetic APIs. It needs only this
repository and Node.js 22+. Its runtime imports are all Node built-ins; there are no npm dependencies to install.

## Start

From the repository root:

```sh
npm run dev
```

Open http://127.0.0.1:5088. Start in Creator mode, or choose a starting persona/scenario:

```sh
npm run dev:member
npm run dev -- --persona signed-out
npm run dev -- --scenario empty --port 5090
npm run dev -- --delay 1200
```

Supported personas are `member`, `creator`, `administrator`, and `signed-out`. Administrator combines the Creator
experience with product administration.
The Member/Creator difference is local H3/Qwen generation. Both can use Codex, Gallery, Profile and personal-key tools.

The **DEMO** badge, or http://127.0.0.1:5088/__dev, opens controls for persona, scenario, latency and reset. The controls
also show recent mock request paths. A simulated outage leaves these controls usable so you can recover without restarting.

The host binds to loopback only and refuses external Host headers and cross-origin writes. It does not expose a
`--host 0.0.0.0` option. For mobile layouts, use your browser's responsive/device tools on the same computer.

## What works

| UI area | Mock behavior |
| --- | --- |
| Sign-in/out | Simulated local browser session |
| Profile | Edit/save a fictional profile; create/edit/archive artists/personas; link personas |
| Gallery | Own/shared libraries, tags, media metadata, uploads, sharing, deletion and saved frames |
| Media viewers | Bundled geometric SVG studies, a generated four-second MP4 and a generated WAV; byte-range playback |
| Codex | Seeded world, editable pages/tree, create/delete/move, autosave versions/conflicts, sharing controls and basic shots |
| Generators | Model/permission selection, fictional provider-key entries, prompt assistance, jobs that advance to synthetic results |
| Audio Remaster | Mock upload, queue progress, cancellation and a synthetic WAV result |
| Empty/error/loading states | Empty media/documents, simulated API failures, 0–2000 ms response latency |
| Locker / Exposition | The same labelled placeholders as the current product |

All responses are synthetic; the mock host makes no remote calls or real AI generation or audio processing requests.
In AI zone enter a **fictional** key beginning with `demo-`, such as
`demo-seevio-key`. Only its label/last-four metadata is retained. Member mode reveals cloud video models after an
enabled default demo key is added; local H3/Qwen remains unavailable.

The mock implements the common UI flows above. Advanced cut exports, real collaboration,
provider billing and publish workflows are not executed. An unknown API route returns an explicit 404 rather than a
success-shaped empty response: implement its fixture before using it to validate a new feature.

## State and assets

Each browser session has independent in-memory data, identified by a local mock cookie. Tabs in the same browser
share it. Persona/latency changes keep edits; changing scenarios or pressing Reset replaces the data. Restarting
Node clears all sessions. No development state is written into a database, the working tree or production.

Uploads stay in memory: 8 MiB per request and 32 MiB per browser session. Reset to release them. The bundled MP4 is
synthetic geometric footage; no production user media is included. The server needs no ffmpeg to run.

The dev host reads files relative to its own location, so it also works when launched from another working directory.
Node watch restarts it when its imported mock modules change; refresh the browser after UI asset changes. A restart
also resets the in-memory data.

## Where to work

| File | Purpose |
| --- | --- |
| `src/AiTlt.ArtistLockers.Host/wwwroot/` | The real product HTML, CSS, JavaScript, fonts and editor assets |
| `dev/fixtures.mjs` | Fictional people, media, documents, model capabilities and job progression |
| `dev/api.mjs` | API shapes and in-memory mutations used by the real UI |
| `dev/server.mjs` | Loopback HTTP server, static files, local sessions, uploads and media responses |
| `dev/controls.html`, `dev/banner.js` | Local-only scenario controls and the DEMO badge |

For a new UI call, add the fixture response or mutation in `dev/api.mjs` with the shape the UI expects, then exercise
the populated, empty and error states. Mock checks validate local UI behavior; they do not verify real AI output.

## Checks

No installation is needed for the mock API checks:

```sh
npm run test:dev
```

The tests cover isolated sessions, sign-in/out, state reset, errors, actual UI/static file serving, source-file
boundaries, range playback, profile/Codex mutations, stale-write conflicts, uploads, fake keys and generation grants.

For real-browser checks, use an installed Playwright package (or set `PLAYWRIGHT_PACKAGE` to its location):

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
node tests/browser/dev-host.cjs
```

`ARTISTLOCKERS_BROWSER=webkit` selects WebKit if installed. `ARTISTLOCKERS_SCREENSHOTS` changes the output directory;
the default `artifacts/dev-host` is ignored by Git. Browser checks start/stop their own loopback mock host on a free
port and refuse external requests. The existing `tests/browser/check.cjs` remains the detailed synthetic layout suite.

If the port is busy, use `npm run dev -- --port 5090`. If a page is stuck in an outage or signed-out state, open
`/__dev` and reset.
