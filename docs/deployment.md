# Deployment runbook and current status

## Status (2026-10-23)

The app is deployed on `ai-tlt-artistlockers`, HTTPS port 9440. Identity, Gallery, Tools and Codex trust its separate signing keys. Accounts has the `al_member` and `al_admin` role templates; initial administrator access was assigned only to the operator. Live read checks passed for the operator's profile, artists/personas, Gallery, Tools, remaster history and Codex access. Locker and Exposition remain placeholders.

The operator authorized public publication on 2026-10-23. HAProxy now routes `artistlockers.eu` to this host, redirects `www.artistlockers.eu` to the canonical domain, and rejects `/internal`. The firewall allows HAProxy only on TCP 9440; SSH remains restricted to the LAN/operator workstation. The app's public URL and Accounts SSO registration now use `https://artistlockers.eu/` and `/auth/sso/callback`.

Proxy-local checks passed: landing 200, sign-in 302 to Accounts with the public callback, internal routes 404, www redirect 301. The operator issued the public certificate, and subsequent proxy-local HTTPS checks pass with certificate validation enabled. The refresh script includes both Artist Lockers hostnames in the existing `teletin.ro-0002` lineage. A trailing CR introduced during editing prevented the first deploy hook invocation; the script was corrected to LF and the existing certificate deployed without another issuance. Its standalone challenge workflow briefly stops HAProxy. The prior script is backed up at `/home/claude/refresh.sh.before-artistlockers`; routing backups are under `/home/claude/haproxy-backups`.

The UI review release is deployed on `ai-tlt-artistlockers`. Gallery page spacing and narrow-card metadata were corrected; Remaster uses light surfaces and readable status colors; Profile has separate details/artists/personas tabs, image previews, additional-image editing, persona linking, discard/save feedback and confirmation before leaving unsaved edits. `ArtistLockers:Components` defaults to profile/gallery/studio/codex. Without `teamboard`, Codex hides its Tasks/Backlinks sidebar, task creation controls, badges and task counts and refuses its TeamBoard-specific routes. Existing pages and links remain stored centrally. This does not change Mobvision's composition or frontend. Enabling TeamBoard later still requires a functioning backend integration and the user's own permissions.

Validation: 17 host tests; real-script browser fixtures for desktop/mobile, multiple Gallery cards and long filenames, Remaster states and text contrast, profile editing and preserving additional images, persona links, and both TeamBoard component states. Live health is ready, anonymous profile reads remain 401, and public assets are served by the proxy. Browser fixtures use synthetic data; interactive third-party SSO is not simulated as a live acceptance test.

The subsequent mobile pass makes Your media, Shared and Generations use the full browser width with small gutters; other reading/editing pages retain their own widths. On phones, all six navigation entries remain visible, primary controls have 44px touch targets, text-entry fields use 16px type, tool tabs use two columns, the profile form precedes its preview, and the Codex page browser defaults to collapsed while respecting a saved preference. Very narrow galleries use one column. Coarse-pointer targets also cover tablet/landscape use.

The header's app switcher is restricted to the operator. `ArtistLockers:AppSwitcherAccountIds` is empty by default and contains only the protected operator's account ID in the private deployment configuration. The host also requires `accounts:manage`; app administrators and other users receive `canSwitchApps: false` and an empty `apps` list without requesting Accounts' inventory. Every Artist Lockers header uses this server-provided flag. This changes the menu offered by Artist Lockers, not product assignments in Accounts or other apps' switchers. The four combinations of configured/unconfigured account and present/absent Accounts admin permission are covered by host tests.

Browser checks cover Chromium and WebKit with touch contexts at 320px, 390px, 768px and 844px (landscape) widths across Exposition/Locker placeholders, Profile, own/shared Gallery, Generations, video/image generation, Remaster, AI zone and Codex. They check overflow, navigation reachability, form sizing, modal fit and Codex page-browser toggling; the desktop check includes a 2560px Gallery. This is browser emulation, not physical iOS/Android hardware or on-screen-keyboard testing. Administrative Operations and the complete storyboard editing workflow are outside this mobile acceptance matrix.

## LXC handover

Run the temporary curl command supplied in the conversation in the new LXC's root console. It creates the locked-password `claude` SSH account with its dedicated public key, installs SSH/sudo, and sends hostname, LAN addresses and SSH host public key to the temporary receiver. No private key is transferred. Verify SSH and sudo, then remove the hosted bootstrap, temporary receiver and source copies. The receiver is time limited; check it is still running before reuse.

## First deployment

1. Confirm the reported host key, LAN address, distro and SSH access. Add the dedicated SSH alias. Install the ASP.NET Core 10 runtime for that distro.
2. Publish `src/AiTlt.ArtistLockers.Host` in Release and upload the release, `deploy/`, and the example settings (one directory above `deploy/`). Run `setup-box.sh` as root on the new LXC. It creates the system account, TLS certificate, private configuration and separate signing key for each peer. Private keys remain there.
3. Verify peer certificate fingerprints against each peer's local certificate through SSH. Setup supports `ARTISTLOCKERS_IDENTITY_SHA256`, `ARTISTLOCKERS_GALLERY_SHA256`, `ARTISTLOCKERS_TOOLS_SHA256`, and `ARTISTLOCKERS_CODEX_SHA256` overrides. Do not trust a newly observed fingerprint without this independent check.
4. Back up peer settings and composition manifests on their owners. Register the four public keys below with ClientId `ai-tlt-artistlockers`, Issuer `urn:ai-tlt:client:artistlockers`, SiteId `mobvision` and the corresponding audience/key id from the example config. The legacy shared SiteId preserves the existing shared content namespace; the Accounts application ID is independently `artistlockers`. Retain existing shared user/content ownership.
5. Register Identity SSO: ClientId `ai-tlt-artistlockers`, ApplicationId `artistlockers`, name `Artist Lockers`, HomeUrl `https://artistlockers.eu/`, RedirectUri `https://artistlockers.eu/auth/sso/callback`, description `A workspace for music, stories and illustrated worlds.`
6. Apply the reviewed Accounts role-template migration through the Identity owner's DbTool. It adds `al_member` and `al_admin`; neither grants Studio or Codex automatically. Assign initial review access to the operator through Accounts using an audited role assignment. Do not bulk assign every user.
7. Run `install.sh <release.tgz>`. It installs the unit and retains the previous release, restoring it if the new release fails liveness. Check readiness separately; all four private peers must answer.
8. Back up and update HAProxy through its existing apply workflow. Route artistlockers.eu to the new LXC's HTTPS port 9440, block public `/internal`, provide the public certificate, and redirect www to the canonical domain. Verify Accounts launch goes to the same tab.
9. Check anonymous landing, SSO, grants, profile/artist/persona reads, own/shared Gallery, image/video models, provider-key metadata and Codex documents using the operator session. Live write acceptance uses isolated creator fixtures only. Remove the temporary bootstrap hosting after SSH handover succeeds.

## Peer scope ceilings

| Peer | Actor scopes | Service scopes |
| --- | --- | --- |
| Identity | profiles:read:self, profiles:write:self, artists:write:self, personas:write:self | identity:accounts:login, identity:accounts:read, artists:read |
| Gallery | assets:preview:self, assets:preview:any, assets:list:self, assets:write:self | assets:deliver:public, assets:list:shared |
| Tools | jobs:list:self, tools:use, tools:keys:self, remaster:use | tools:operate |
| Codex | codex:use | none |

`assets:preview:any` is used only after the validated account has `accounts:manage`, preserving the existing shared administrator behavior. Product membership alone grants no global preview. Tools operations require `studio:manage` before a service token is issued.

## Known port boundary

Artist Lockers has two creative bundles: `al_member` grants full Codex and personal-key tools;
`al_creator` adds `studio:generate_local` for H3 and Qwen. `al_admin` remains separate product administration.
Both Member and Creator include `artistlockers:host` for their own online/venue events (Identity migration 009).
No separate Artist Lockers Host role is required; global Events administration remains separate.
Local models are filtered from Member capabilities and rejected at submission. The shared Tools queue independently
rechecks the actor's current Accounts grant, so using another product cannot bypass the restriction. Migration
`identity/007_artistlockers_simple_roles` consolidates the retired Codex/Tools bundles and preserves existing
Studio/team local-generation access. The queue uses its own read-only Identity client and certificate pin.

Image/video generation includes Mobvision's complete composers, references, prompt assistance, frame tools and Extend/Extend+. Gallery carries generation provenance and Repeat/Vary back to Tools. Audio Remaster forwards to the shared Tools queue on `ai-tlt-apps`; processing runs on `ai-tlt-workers`. No Mobvision session cookies or database access are used.

Locker and Exposition remain labelled concept placeholders. Their publishing/editor/playback requirements are preserved in the product brief.
