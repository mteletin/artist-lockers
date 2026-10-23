# AI-TLT Artist Lockers

The creator product at https://artistlockers.eu, with its own host and square silver/clay UI. Uses the existing AI-TLT identity, creator profiles, Gallery, generation and Codex services. No contest or copied user content.

The first slice contains Profile, Gallery, Tools and the complete Mobvision Codex editor port. Locker and Exposition are labelled placeholders. See the [product brief](docs/product-and-first-slice.md) and [deployment runbook/status](docs/deployment.md), including the Audio Remaster boundary.

## Develop the UI on its own

Clone **only this repository**, install Node.js 22 or later, and run:

```sh
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
npm run dev -- --port 5090 --scenario empty
npm run test:dev
```

See [UI development](docs/ui-development.md) for mock coverage, troubleshooting and browser checks.

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
