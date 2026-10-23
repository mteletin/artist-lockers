# AI-TLT Artist Lockers

The creator product at https://artistlockers.eu, with its own host and square silver/clay UI. Uses the existing AI-TLT identity, creator profiles, Gallery, generation and Codex services. No contest or copied user content.

The first slice contains Profile, Gallery, Tools and the complete Mobvision Codex editor port. Locker and Exposition are labelled placeholders. See the [product brief](docs/product-and-first-slice.md) and [deployment runbook/status](docs/deployment.md), including the Audio Remaster boundary.

## Develop the UI on its own

Clone **only this repository**, install Node.js 22 or later, and run:

```sh
git clone https://github.com/mteletin/artist-lockers.git
cd artist-lockers
npm run dev
```

Open **http://127.0.0.1:5088**. No `npm install`, .NET SDK, sibling repositories, database, credentials, or running AI-TLT
services are needed. The mock host serves the real UI files directly; edit HTML/CSS/JavaScript under
`src/AiTlt.ArtistLockers.Host/wwwroot` and refresh the browser.

The **DEMO** badge opens developer controls for Member, Creator, Administrator, signed-out, empty and error scenarios,
plus simulated API latency. Profile/media/Codex edits and mock jobs work in memory. Restart or reset to start fresh.
Use `demo-seevio-key` in Tools → AI zone to try personal-key video generation; it never contacts a provider.

```sh
npm run dev:member
npm run dev -- --persona signed-out
npm run dev -- --port 5090 --scenario empty
npm run dev -- --delay 1200
npm run test:dev
```

### Mock features

| Area | Available locally |
| --- | --- |
| Sign-in/out | Simulated browser session; no Discord or Accounts connection |
| Profile | Edit/save your profile, create/edit/archive artists and personas, and link personas |
| Gallery | Own/shared media, metadata, tags, uploads, sharing, deletion and frame saves |
| Media | Fictional SVG artwork, playable sample video and WAV audio |
| Codex | Seeded world, editable pages/tree, create/delete/move, autosave, sharing controls and basic storyboard shots |
| Tools | Model selection, fictional personal API keys, mock prompt assistance and simulated generation jobs/results |
| Audio Remaster | Mock upload, queue progress, cancellation and a synthetic WAV result |
| UI states | Populated, empty, signed-out, simulated service failures and adjustable response latency |

### Roles and developer controls

Open the **DEMO** badge or **http://127.0.0.1:5088/__dev** to change the current browser's persona and scenario:

- **Member:** Profile, Gallery, full Codex and personal-key tools. Add `demo-seevio-key` in Tools → AI zone to reveal cloud video models.
- **Creator** (default): Member features plus local H3 and Qwen generation.
- **Administrator:** Creator experience plus product administration; shared-service operations and the super-admin app switcher stay unavailable.
- **Signed out:** The minimal landing and local sign-in flow.

The controls also let you reset fictional data, simulate API failures, add up to two seconds of latency and inspect recent
mock request paths. You can always recover an error or signed-out scenario through `/__dev`.

### Data and limitations

All mock state is **in memory and independent per browser session**. Tabs in the same browser share it. Persona and latency
changes retain edits; changing scenarios, resetting, or restarting the host clears the data. Uploads stay in memory, with an
8 MiB request limit and a 32 MiB limit per session.

There is no real OAuth, AI generation, remaster processing, billing, publishing or collaboration. The host never contacts a
provider or production service. Use fictional `demo-` keys only. Locker and Exposition remain the product's labelled placeholders;
advanced cut exports and unsupported API routes return explicit errors rather than pretending to work.

The mock server binds **only to loopback**. Use browser device emulation for mobile layouts. It is separate from the production
.NET application and is not included in its deployment; this is not a production authentication-bypass switch.

### Editing and verification

Edit the real application files in `src/AiTlt.ArtistLockers.Host/wwwroot`, then refresh. Change synthetic data in
`dev/fixtures.mjs` and API behavior in `dev/api.mjs`; Node watch restarts the server when its mock modules change.

Run the mock API tests without installing packages:

```sh
npm run test:dev
```

Optional real-browser checks require Playwright:

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
node tests/browser/dev-host.cjs
```

The browser checks cover real UI edits, media playback, Codex autosave, role/key controls, empty/error states and desktop/mobile
layouts, while refusing external requests. Screenshots go to ignored `artifacts/dev-host/`. Set `PLAYWRIGHT_PACKAGE` to use an
existing Playwright package, `ARTISTLOCKERS_BROWSER` to select another installed engine such as `webkit`, or
`ARTISTLOCKERS_SCREENSHOTS` to change the output directory.

If port 5088 is busy, run `npm run dev -- --port 5090`. See [UI development](docs/ui-development.md) for additional details.

## Run the integration host

The production .NET host requires sibling `ai-tlt-platform` and `ai-tlt-identity` checkouts. .NET 10 is the target runtime;
`build-dependencies.json` records the tested revisions. This is separate from the dependency-free UI workflow above.

```powershell
dotnet build src/AiTlt.ArtistLockers.Host
dotnet test tests/ArtistLockers.Host.Tests
```

Start with `appsettings.example.json` and supply private settings outside source control. An empty local host cannot authenticate against production until its own signing keys are registered. Never copy another product's signing identity.

## Access

Accounts assignment supplies `artistlockers:access` (or `manage`). Tools additionally requires `studio:access`; Codex requires `codex:access`; generation inside Codex additionally requires Studio. Tool operations require `studio:manage`. The host revalidates current Accounts state and derives every delegated user identity from the signed-in session. Role names never authorize requests.

Browser checks use Playwright Chromium and synthetic services:

```powershell
node tests/browser/check.cjs
```

Install Playwright in the environment, or set `PLAYWRIGHT_PACKAGE` to an existing package location. Screenshots go into ignored `artifacts/browser/` (override with `ARTISTLOCKERS_SCREENSHOTS`). The check covers anonymous landing, profile dialog/save, Gallery Repeat handoff, a generation request with an exact large seed, Codex creation/autosave, and desktop/mobile layouts. It never signs into or writes to production.
