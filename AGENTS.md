# Artist Lockers repository guidelines

Artist Lockers is a creator product with its own UI and deployment. It has no contest features. Read docs/product-and-first-slice.md before changing scope.

Use the sibling AI-TLT services for identity, profiles, artists/personas, media, generation and Codex. Never read another service's database or copy production credentials, keys, records or media into this repository. The browser talks to this host; private calls use this product's own signed actor tokens and pinned certificates.

Accounts owns product assignment and component permissions. Require artistlockers:access (manage implies access), plus the relevant universal component grant. Do not infer grants from team-role names. Preserve the same user's existing content and ownership/sharing rules across products.

The first release ports Profile, Gallery, Tools and Codex, in that order. Locker/Exposition receive labelled placeholders only. Do not implement publishing storage, a Locker editor, albums, lyrics alignment or Exposition playback until separately authorized.

Visual language: silver/gray, restrained earthy orange, minimalist square geometry. No rounded corners or slanted boxes. Dialogs, navigation, scrollbars, error states and mobile layouts must follow this language. Signed-out landing shows only Artist Lockers and sign-in.

Target .NET 10. Keep source UTF-8; C# CRLF on Windows. Run the host build, relevant access/ownership tests and browser checks. No Docker. Production SQL changes use reviewed migration files and DbTool execute --file --confirm-write.
