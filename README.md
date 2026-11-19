# Field Notes

A private tracker for the people you want to keep in your life. It runs as an installable web app, keeps all data on the device, and works offline.

The idea behind it: a contact list tells you who you know. Field Notes tells you who is worth reaching out to, because you rated them as having potential to deepen and it has been a while.

## Using it

**Add someone.** Add tab, type `Sam Lee at Geography Club`, press Enter. The name is saved, "Met at Geography Club" goes in the notes, and the box is ready for the next person. A name alone is a complete entry. Tier, potential and everything else are optional, one tap each on the card that appears.

**Tiers** are about closeness: Close, Middle, Acquaintance, Networking. New people start as Acquaintance.

**Potential to deepen** (Low, Some, Moderate, Strong, Rare) is the rating that drives everything else. Unrated and Low people never appear in any prompt.

**Reach tab.** People you rated who you have not logged in a while, each with a reason ("Last talked 40 days ago · you usually talk every 10 days"). Reminders are for Close and Middle only. Rated Acquaintance and Networking people sit in a folded list at the bottom and never trigger anything. When you open the app, at most one reminder card appears.

**Log tab.** Tap Log next to someone you talked to. The people you talk to most are listed so you rarely need to search. Skipping days costs nothing.

**Promises.** Open a person and fill in "Something I said I would do". It stays on the Reach tab until you tap Done.

**Tags.** Type a word with `#` in anyone's notes (`#geoclub`, `#hall`). Tiering -> Tag shows each group. To tag many people at once: Select -> tick people -> + Tag.

**Penn** is saved in the School field. Everyone whose company, school, email or name says Penn (University of Pennsylvania, UPenn, Wharton, Perelman, any upenn.edu address) gets a Penn badge automatically; Penn State and lookalikes do not. Open a person and tap "From Penn" to override. The Add card has a "From Penn" toggle that starts on, remembers when you turn it off, and switches on by itself when you type Penn. "Penn only" above any list shows just Penn people, in any tier.

**Family.** A mark you set yourself: open a person, the card after adding, or the sort queue, and tap Family; or Select -> + Family for several. Family has its own list next to the tiers and its own badge, and does not change anyone's tier. It is never guessed from names, because phone names like "Sam Lee Mom" usually mean a friend's mother.

**Duplicates.** Settings -> Clean up -> Duplicates lists anyone saved more than once. Merging keeps the closest tier, all notes and all logged conversations, and has Undo. Two records count as the same person when they share a full name, an email, or first and last name (with no conflicting middle name), or a phone number plus the same first name. A shared number alone never merges people, so family members on one line stay separate.

**Breaks.** Around Thanksgiving, winter break, spring break and summer, the Reach tab lists rated Close and Middle people whose city is not Philadelphia. At the start of a semester it lists rated people you added last term and have not logged. Dates follow the Penn calendar. A prompt with nobody to show does not appear.

**Discreet mode.** Tap the "Field Notes" title to hide tier names and ratings. Tap again to show them.

**Shortcuts.** On Android, long-press the app icon for "Add someone" and "Log a conversation". Links also work: `/?tab=add`, `/?tab=log`, `/?add=Sam+Lee+at+GBM` (fills the line, never saves by itself).

## Your data

- Stored in this browser on this device (`localStorage`). The app ships with no contacts in it.
- **Back up:** Settings -> Backup -> "Save a full backup" writes a JSON file that restores everything exactly. CSV export is for spreadsheets.
- **Import:** Settings -> Backup -> choose a CSV, VCF or backup file. One tap adds everyone new as Acquaintance. People already in the app keep their tier.
- **Contacts file from your phone** (`.vcf`): repeated cards are combined, people already here are not added again (only their empty fields are filled in), and "Add the Penn people" brings in just the new Penn ones. Contact files are in `.gitignore`; never commit one.
- **Updates** keep your data. Before a new version first runs, the app saves a copy of the data as it was; Settings -> About -> "Go back to that copy" restores it.
- Bulk actions (import, move, tag, delete) all have Undo.

Never commit contact data to this repo. `.gitignore` excludes `*.csv` and backups.

## Updates

Pushing to `main` deploys to Vercel. When the installed app is next opened, it fetches the new version, reloads itself once, and shows "Updated to vX". The version is at the bottom of the Add tab.

Release checklist: bump `APP_VERSION` in `app.js` and `CACHE` in `sw.js`, run the tests, push, run `bash tools/deploy_check.sh <version>`.

## Sync across devices (optional, off by default)

Contacts are encrypted in the browser with a key derived from your passphrase (PBKDF2-SHA256, 250k iterations, AES-GCM) before upload. The server stores ciphertext and a revision number.

**The passphrase cannot be recovered or reset.** If you forget it, the synced copy is unreadable. Local data is not affected.

Setup:
1. Vercel dashboard -> this project -> Storage -> create an Upstash Redis store and connect it. Redeploy.
2. Check it: `bash tools/sync_smoke.sh https://<your-site>`.
3. In the app: Settings -> Sync -> passphrase twice -> Turn on sync.
4. Second device: same site, paste the sync code, same passphrase, Join.

Without the store, `/api/sync` returns 501 and the app says sync is not configured. Nothing else is affected.

How conflicts resolve: per person, newer edit wins. If both devices edited the same person since the last sync, the other device's notes are appended rather than dropped. Conversation and tier histories are always merged. Deletes use tombstones so they are not undone by the other device.

Limits on the endpoint: 3 MB per upload, 90 requests per address per 5 minutes, 40 writes per sync id per 5 minutes, 6 new sync ids per address per day.

Sync is not a backup. Keep a backup file too.

## Development

No build step and no dependencies.

```
index.html      app shell, service worker registration and update handling
app.js          all app logic
sync.js         encryption and merge for sync
api/sync.js     serverless endpoint storing the encrypted blob (CommonJS on purpose)
sw.js           service worker: offline shell, stale-while-revalidate assets
data.js         empty seed, by design
styles.css      all styling
tests/          browser test suite (fake people only)
tools/          dev server, deploy check, sync smoke test
```

Run the tests:

```
python tools/serve.py 8780
```

then open `http://localhost:8780/tests/run.html`. Tests drive the real app in a frame with generated fake people and a separate storage key, and only run on localhost. `tests/`, `tools/` and the `.md` files are not deployed (`.vercelignore`).

Project notes: `AUDIT.md` (how it works, ranked ideas), `DECISIONS.md` (judgement calls and how to reverse them), `PROGRESS.md` (per-release evidence), `CHANGELOG.md`.
