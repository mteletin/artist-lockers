# Deployment runbook and current status

## Status (2026-10-23)

The private GitLab repository exists. Source builds and access tests pass. Browser fixtures exercise the real scripts with synthetic profile/media/tool responses; they are not a live backend acceptance test. The dedicated LXC has not called back yet. No Artist Lockers production route, SSO registration, role assignment, peer trust or deployment has been applied.

## LXC handover

Run the temporary curl command supplied in the conversation in the new LXC's root console. It creates the locked-password `claude` SSH account with its dedicated public key, installs SSH/sudo, and sends hostname, LAN addresses and SSH host public key to the temporary receiver. No private key is transferred. Verify SSH and sudo, then remove the hosted bootstrap, temporary receiver and source copies. The receiver is time limited; check it is still running before reuse.

## First deployment

1. Confirm the reported host key, LAN address, distro and SSH access. Add the dedicated SSH alias. Install the ASP.NET Core 10 runtime for that distro.
2. Publish `src/AiTlt.ArtistLockers.Host` in Release and upload the release, `deploy/`, and the example settings (one directory above `deploy/`). Run `setup-box.sh` as root on the new LXC. It creates the system account, TLS certificate, private configuration and separate signing key for each peer. Private keys remain there.
3. Verify peer certificate fingerprints against each peer's local certificate through SSH. Setup supports `ARTISTLOCKERS_IDENTITY_SHA256`, `ARTISTLOCKERS_GALLERY_SHA256`, `ARTISTLOCKERS_TOOLS_SHA256`, and `ARTISTLOCKERS_CODEX_SHA256` overrides. Do not trust a newly observed fingerprint without this independent check.
4. Back up peer settings and composition manifests on their owners. Register the four public keys below with ClientId `ai-tlt-artistlockers`, Issuer `urn:ai-tlt:client:artistlockers`, SiteId `artistlockers` and the corresponding audience/key id from the example config. Extend each service's composition catalog with the Artist Lockers site before adding trust where required. This is a capability catalog; retain existing shared user/content ownership and the existing published-media namespace.
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
| Tools | jobs:list:self, tools:use, tools:keys:self | tools:operate |
| Codex | codex:use | none |

`assets:preview:any` is used only after the validated account has `accounts:manage`, preserving the existing shared administrator behavior. Product membership alone grants no global preview. Tools operations require `studio:manage` before a service token is issued.

## Known port boundary

Image/video generation includes Mobvision's complete composers, references, prompt assistance, frame tools and Extend/Extend+. Gallery carries generation provenance and Repeat/Vary back to Tools. Audio Remaster is still owned by Mobvision's contest visualizer repository and has no shared service API; it is not exposed as a working Artist Lockers tool. Extract that capability into the shared Tools service before porting it. No Mobvision session cookies or database access are used as a workaround.

Locker and Exposition remain labelled concept placeholders. Their publishing/editor/playback requirements are preserved in the product brief.
