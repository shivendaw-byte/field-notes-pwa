# Changelog

## 9.12 — 2026-11-19 — faster sorting
- Sort queue: "Save as Penn" is a setting that stays on from person to person (and after closing the app) until you turn it off. Each person you save gets School: Penn.
- Sort queue: the tier buttons ("Save as") sit right under the name, next to Save as Penn and Family. One tap saves and shows the next person. Company, school, phone and the rest are folded under "Edit details".
- While people are waiting to be sorted, the sort card is first on the Add tab and the keyboard does not open.
- New ways into the sort queue: "Sort these one by one" on the Just imported list, Select -> "Sort one by one", and "Add the Penn people and sort them one by one" on the import screen. Each has Undo.
- Back in the sort queue also undoes the Penn it saved.
- Open contact: From Penn and Family moved up, right under the tier buttons.

## 9.11 — 2026-11-19
- Clearer Penn line under the From Penn button ("Saved in School as Penn.").

## 9.10 — 2026-11-19 — Penn in School, Family
- Penn is saved in the School field, the way the first 648 were. Turning Penn on writes "Penn" into an empty School; a School that names somewhere else is kept and the person is marked Penn on top. Turning it off clears a plain "Penn".
- On the first open of 9.10, anyone whose name, company or email says Penn, or who was marked Penn, gets "Penn" in an empty School. Nothing else changes, and the copy from before the update is kept.
- Phone names count: "Sam Lee Penn", "Sam Lee Wharton", "Sam Lee - Penn '28". A first name of Penn does not.
- New people from a contacts file who look like Penn are saved with School: Penn.
- The sort queue for imported contacts has From Penn and Family buttons, so both can be set before picking a tier.
- Family: a mark you set yourself, with its own badge, its own list next to the tiers, a Family button when adding someone (it switches Penn off for that person), and Select -> + Family. Never guessed from names.
- Select -> + Penn marks many people at once. Both bulk marks have Undo.
- CSV export and import carry the Family mark.

## 9.9 — 2026-11-19 — Penn and duplicates
- Penn badge on every contact, worked out from the company, school or a upenn.edu email you already have. "University of Pennsylvania" in the company shows as one short Penn badge. Penn State and similar names do not count.
- "From Penn" toggle on the Add card. It starts on, remembers when you turn it off, and switches on by itself when you type Penn, UPenn or Wharton.
- "From Penn" on every contact: one tap overrides, a second tap goes back to automatic.
- "Penn only" button above every list, remembered between opens.
- Contacts file import (vCard from iPhone or iCloud): handles folded lines, several phones and emails, and photos; repeated cards in the file are combined; people already here are matched and get only their empty fields filled in; a new "Add the Penn people" button imports only those.
- Duplicates screen (Settings, Clean up): people saved more than once, merged one group at a time or all at once, keeping the closest tier, every note and every logged conversation. Undo.
- Same-person rule tightened: a shared phone number needs the same first name, and different middle names or numbers keep entries apart.
- Import undo now also puts back fields it filled in.

## 9.8 — 2026-11-16 — polish
- New users see a "Start with one person" card instead of an empty list.
- Phone, email and passphrase boxes are full height (they were 22px tall and unstyled).
- Call and Email links are proper buttons.
- Every input has an accessible name; chips and filters report their pressed state.
- The backup reminder moved below the capture box and now saves a full backup.
- Fixed: "Back to settings" on Trends did nothing.
- README rewritten for the current app.

## 9.7 — 2026-11-16 — sync hardening
- `/api/sync`: 3 MB size cap and rate limits per address, per sync id and on new sync ids.
- Turning sync on needs the passphrase twice, shows that it cannot be recovered, and asks for a confirm.
- When two devices edit the same person, the other device's notes are appended instead of dropped.
- Fixed: a contact added while a sync was running could be lost.
- "synced 3 min ago" under the title when sync is on; clear messages for rate-limit and size errors.

## 9.6 — 2026-11-16 — reconnect and recall
- Reminders (the card on open and the Reach count) are for Close and Middle only.
- Every reminder says why now, with a line from your notes.
- "Something I said I would do" per person, listed on Reach until Done.
- Break and new-semester prompts from the Penn calendar.
- `#tags` in notes, a Tag view, and bulk tagging with undo.
- Trends: your circle, talked to this month, rising, gone quiet, groups.
- Discreet mode: tap the title to hide tier names and ratings.

## 9.5 — 2026-11-16 — fast capture
- One-line capture: `Sam Lee at Geography Club` + Enter.
- The name box is focused when Add opens and after each save.
- Follow-up card to set tier and potential in one tap each.
- Notice when the name is already in the app.
- Home-screen shortcuts and `?tab=` / `?add=` links.
- Log tab lists the people you talk to most.
- Lists are about 7 times faster to redraw: rows draw their form only when open, and long lists draw 150 rows at a time.

## 9.4 — 2026-11-16 — safety net
- Full backup and restore (JSON). CSV import now keeps potential ratings.
- A copy of your data is kept before each update, with a button to go back to it.
- New versions load on the first open and show "Updated to vX".
- Version shown at the bottom of the Add tab.
- First automated test suite.

## 9.3 — 2026-11-15
- One-tap import as Acquaintance, undo for imports and bulk moves, "Just imported" filter, multi-select Move to.
