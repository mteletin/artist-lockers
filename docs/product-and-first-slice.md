# Artist Lockers: product brief and first slice

Recorded from the operator's instructions on 2026-10-23, before product implementation.

## Identity and presentation

An independent creator site at artistlockers.eu, hosted in its own LXC/repository/service. Similar shared capabilities to Mobvision, with no contest, editions, voting, submissions, scoreboards, party administration or contest-specific profile fields. Minimalist silver/gray surfaces, dark graphite typography, restrained orange/clay/earth accents. Square corners throughout; no slanted boxes and no rounded corners. Design dialogs, menus, editors, media viewers and scrollbars consistently.

Signed-out landing is intentionally quiet: Artist Lockers, sign-in, little else. After sign-in the top navigation is EXPOSITION, LOCKER, CODEX, TOOLS, GALLERY, then the user's profile. App switching uses the personalized Accounts inventory and current-tab navigation. Product entry and shared-tool rights compose according to the existing Accounts matrix; UI visibility is backed by API authorization. Content stays the user's same existing content, with its current sharing and ownership rules.

## Authorized implementation order and stop point

1. Scaffold the separate repository/host, SSO, grants, frontend shell, configuration and deployment.
2. Port Profile: the shared creator profile, artists/personas and account identity, styled for Artist Lockers. Keep shared backend ownership; omit contest data.
3. Port Gallery: the user's existing media, shared pool, uploads, metadata, generation provenance and media viewer.
4. Port Tools: existing image/video generation and provider-key workflows, under the existing Studio/tool grants.
5. Port Codex: Mobvision's editor, tree, sharing and storyboard capabilities, with the Artist Lockers style and the existing Codex/Studio grant composition.
6. Stop. Locker and Exposition are explicit placeholders or a nonfunctional labelled concept sketch, never a fake live content catalog. Do not build Locker storage/editor/publishing or Exposition playback in this slice.

## Deferred Locker concept: preserve these requirements

Locker is where an author designs content for publication in Exposition. It needs a WYSIWYG publishing editor in a future authorized slice.

- Song: cover artwork, audio, author commentary and stylized timed lyrics. Karaoke behavior should reuse the listening-party alignment/playback capability, preserving synchronization semantics rather than adding a separate timing system.
- Album: multiple tracks, album art, notes/extras from the author and the same treatment for each track. During playback the current track takes visual prominence over the album cover; its lyrics follow the karaoke presentation. Elegant album-to-track transitions are part of the concept.
- Lore/publication: characters, illustrated articles, short novels, interviews, dialogs, comics and other publishable formats. Text and embedded images can be placed above, beside and after one another, with proper article flow. Comics require a deliberate page/panel reading presentation.

Exposition is a polished exhibition arena for published Locker items. It presents intentional publications, not a dump of uploaded Gallery media. The visual sketch can suggest editorial display and quiet framing without implementing publish state or sample user content.

## Infrastructure and access

Use a dedicated Artist Lockers signing identity, cookie encryption key ring and runtime configuration. Reuse fleet SSH bootstrap with a dedicated public key, temporarily hosted on an existing LXC over HTTPS; remove it after the new LXC is reachable. Never check in operational private keys or copied live settings. Domain DNS is already configured by the operator; inspect routing and certificates before cutover. Register SSO and the app link in Accounts, and supply Artist Lockers role templates without altering Mobvision role membership or spreading grants to every existing account.

## Verification

Prove anonymous minimal landing, denied private APIs, disabled/stale/revoked sessions, CSRF protection, product/component grant composition, ownership/sharing and safe peer routing. Check profiles, media and generation flows with synthetic browser fixtures, then signed read-only live checks. Inspect desktop/mobile and dialog geometry. Full write tests must use isolated/synthetic data, never production creator content as disposable fixtures.
