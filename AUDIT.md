# Field Notes audit (v9.3, 2026-11-16)

Written before the overhaul. Rollback point: git tag `pre-overhaul-v9.3`.

## How the app works today

One page, no build step: `index.html` loads `data.js` (empty seed), `sync.js`, `app.js` (about 2,100 lines, one IIFE). All state is one object in `localStorage["field-notes-v4"]`:

```
state = { version, contacts[], deleted[] (tombstones), settings{}, updatedAt }
contact = { id, name, tier, potential, company, school, location, notes, phone, email,
            interactions[] (dates), lastContact, tierLog[], tierSince, snoozedUntil,
            pending, added, importBatchId, updatedAt }
```

Data flow:

1. **Capture.** Add tab form (`quickAdd`) or CSV/VCF import (`handleFile` -> preview -> `applyImport`). New people default to Acquaintance.
2. **Tier and potential.** Set from the expanded row in Tiering, or in bulk with Select -> Move to. Tier changes stamp `tierSince` and append to `tierLog`.
3. **Reconnect.** `coldInfo(c)` looks up a day limit in `COLD_TABLE[tier][potential]` and counts days since `lastContact || tierSince`. Unrated and Low people have no limit, so they never surface. `nudgeCandidate()` picks the single most overdue person for the card shown on open; the Reach tab lists everyone overdue, highest potential first.
4. **Log.** "Log" on a row appends today to `interactions`, which resets the clock.
5. **Sync (optional).** `sync.js` encrypts the whole state with a passphrase-derived key (PBKDF2 250k, AES-GCM), `api/sync.js` stores the ciphertext in Upstash with a revision number. Merge is per contact by `updatedAt`, histories are unioned, deletes use tombstones.
6. **Offline.** `sw.js` caches the shell: navigations network-first, assets stale-while-revalidate.

Every state change calls `render()`, which rebuilds the whole view as one HTML string.

## Friction points

**Capture**
- The Add form shows 7 inputs and 9 chips before the Save button. On a phone the button is below the fold once the keyboard is up.
- The name box is not focused when the tab opens: one extra tap every time.
- No way to capture "who + where" in one line; context goes in a separate box.
- No home-screen shortcut straight to Add, and no URL that opens it.
- Logging a conversation needs a search every time, even for the same five people.

**Reconnect**
- The card says who, not why. "Close · clear pull toward more" gives no reason to act today.
- `COLD_TABLE` includes Acquaintance and Networking, so a rated Acquaintance can appear in the reminder card. The comment above the table says they are excluded. The stated rule is that they stay out of nudges.
- Nothing ties reconnecting to the calendar (breaks are when home friends are reachable).

**Recall**
- Groups exist only as school, company and city. There is no way to see "Geography Club" or "my hall".
- Trends shows three counts and nothing about who or which tiers.
- A promise ("I'll send you that article") has nowhere to live except free notes, and nothing brings it back.

**Speed**
- Every row renders its full edit form (15 inputs and chips) even when collapsed. A 900-person Acquaintance list builds roughly 2 MB of HTML on every tap. This is the main cause of slow taps.
- The first open after a deploy still runs the old code (assets are served stale); the new version appears on the second open.

## Bugs and risks

| # | Problem | Severity |
|---|---|---|
| B1 | Sync replaces `state` with the merged result when the request returns. A contact added during the 1-3 s sync window is dropped. | Data loss, small window |
| B2 | No lossless backup. CSV export omits `id`, `tierSince`, `snoozedUntil`, `added`, `pending`, `importBatchId`. Restoring from CSV resets reconnect clocks and breaks sync identity. | High for a 955-person dataset |
| B3 | Acquaintance/Networking can reach the reminder card (see above). | Behaviour vs stated rule |
| B4 | `/api/sync` has no rate limit and an 8 MB cap; anyone can write blobs to the store. | Cost/abuse once sync is on |
| B5 | Sync conflict on the same contact keeps the newer copy and silently discards the other side's notes. | Silent loss |
| B6 | Sync has never run against real Upstash. Both production deployments return 501 (no store configured). | Unknown |
| B7 | The sync passphrase is kept in plain text in `localStorage` so sync can run unattended. Accepted trade-off for a single-user device; documented, not changed. | Low |

## Dead code and drift

- `CLEAN_FILTERS`, `cleanupCandidates` and `viewCleanup` are defined twice; the first copy is dead.
- Comment above `COLD_TABLE` contradicts the table.
- README still says "955 contacts preloaded" and points to the Add tab for sync and export (both moved to Settings).
- The repo deploys to two Vercel projects (`field-notes-two-blond.vercel.app`, `field-notes-pwa-gules.vercel.app`). Both receive every push.
- No tests of any kind.

## Candidates

Scores are 1-5. Impact is scored per goal (Alive = keep friendships alive, Capture = fast capture, Recall = insight and recall). Rank = (sum of impact + capture bonus) / effort, where the bonus is +2 for anything that cuts time-to-capture. Risk breaks ties (lower first).

| # | Candidate | Alive | Capture | Recall | Effort | Risk | Bonus | Rank | Decision |
|---|---|---|---|---|---|---|---|---|---|
| 1 | One-line capture: "Sam Lee at Geography Club", Enter saves, box stays focused | 2 | 5 | 3 | 2 | 1 | 2 | 6.0 | Build |
| 2 | Render only the open row's form; cap long lists | 2 | 4 | 2 | 1 | 2 | 2 | 10.0 | Build |
| 3 | Instant update: reload once when a new version takes over, "Updated to vX" toast | 2 | 2 | 1 | 1 | 2 | 0 | 5.0 | Build |
| 4 | Home-screen shortcuts and `?tab=add` / `?add=` URLs | 1 | 4 | 1 | 1 | 1 | 2 | 8.0 | Build |
| 5 | Lossless JSON backup and restore, rollback copy before each update | 3 | 1 | 3 | 2 | 2 | 0 | 3.5 | Build (safety net) |
| 6 | "Why now" reason on the card and Reach rows | 5 | 1 | 3 | 2 | 1 | 0 | 4.5 | Build |
| 7 | Nudge card limited to Close and Middle | 4 | 1 | 1 | 1 | 1 | 0 | 6.0 | Build |
| 8 | One-tap log: recent and Close people shown without searching | 4 | 4 | 1 | 1 | 1 | 2 | 11.0 | Build |
| 9 | `#tags` in notes, browse "By tag" (clubs, hall, class) | 2 | 2 | 5 | 2 | 1 | 0 | 4.5 | Build |
| 10 | Break prompts from the Penn calendar (home friends during breaks) | 4 | 1 | 2 | 2 | 2 | 0 | 3.5 | Build |
| 11 | Follow-up promise per person, surfaced on Reach until done | 4 | 1 | 4 | 2 | 2 | 0 | 4.5 | Build |
| 12 | Network overview: tier balance, who this month, rising and fading | 3 | 1 | 4 | 2 | 1 | 0 | 4.0 | Build |
| 13 | One-tap discreet mode (hide tier names) | 1 | 1 | 2 | 1 | 1 | 0 | 4.0 | Build |
| 14 | Sync hardening: rate limit, size cap, passphrase warning, conflict-safe merge, last-synced | 3 | 1 | 2 | 3 | 3 | 0 | 2.0 | Build (data safety outranks the score) |
| 15 | Fix sync dropping edits made mid-sync (B1) | 3 | 1 | 1 | 1 | 2 | 0 | 5.0 | Build |
| 16 | Voice capture | 1 | 4 | 1 | 3 | 3 | 2 | 2.7 | Cut: the phone keyboard's dictation key already does this into the one-line box |
| 17 | Share-sheet target (Web Share Target) | 1 | 3 | 1 | 3 | 3 | 2 | 2.3 | Cut: Android-only, needs POST handling in the service worker; URL shortcut covers it |
| 18 | Per-role reconnect cadence | 3 | 1 | 1 | 3 | 3 | 0 | 1.7 | Cut: roles were removed in v9; would bring back a required field |
| 19 | Structured per-person fields (interests, last topic) | 2 | 1 | 4 | 3 | 2 | 0 | 2.3 | Cut: more fields to fill; notes plus tags cover it |
| 20 | Auto-suggest tier promotions from interaction counts | 3 | 1 | 3 | 3 | 4 | 0 | 2.3 | Cut: tiers are a judgement, the app does not make it |
| 21 | Interaction notes (what we talked about, per date) | 2 | 1 | 4 | 3 | 2 | 0 | 2.3 | Cut for now: turns Log into journaling |
| 22 | Push notifications for reconnect | 3 | 1 | 1 | 4 | 4 | 0 | 1.3 | Cut: needs a server and permission prompts; conflicts with "one card on open" |

## Release plan

| Release | Contents |
|---|---|
| v9.4 | Safety net and updates: JSON backup/restore, rollback copy, instant update, version on Add tab, test suite, dead code removal (5, 3) |
| v9.5 | Fast capture and speed: one-line capture, lighter rows, shortcuts, one-tap log (1, 2, 4, 8) |
| v9.6 | Reconnect and recall: why-now, Close/Middle-only card, break prompts, promises, tags, overview, discreet mode (6, 7, 9, 10, 11, 12, 13) |
| v9.7 | Sync hardening (14, 15) |
| v9.8 | Polish, first-run, copy, docs |
