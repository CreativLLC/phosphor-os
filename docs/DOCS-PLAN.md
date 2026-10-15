# DOCS: storage plan (notes and reminders)

Written 2026-10-12. Plan only: nothing here is built yet.

## Where we are

- DOCS edits plain `.md` files in one folder (`PHOSPHOR_DOCS_DIR`, default a `Documents` folder next to the
  workspace). Agents read the same files with `@path`.
- DOC view (new) shows them as a normal document and writes plain Markdown. Untouched parts keep their exact bytes.
- Saving already checks for changes made elsewhere (a sync client, the phone, another program) and asks which
  version to keep.
- A sync client only syncs while its machine runs. If the docs folder sits on a disk that another OS syncs (for
  example a Windows partition mounted on Linux), **a note written on Linux reaches the server and the phone only after
  the next boot of the syncing OS.** Notes written from the phone (through Phosphor-OS) land on the PC first.

## Options

| | How | Good | Bad |
|---|---|---|---|
| 1. Synced local folder | Nextcloud desktop client on Linux (`nextcloud-client`, pacman) syncs a folder such as `~/Nextcloud/Documents`; `PHOSPHOR_DOCS_DIR` points there | No code. Works offline. Agents, Obsidian and DOCS all see real files. The conflict check already handles sync edits | One more program running. The client makes "conflicted copy" files if both sides change at once |
| 2. WebDAV from our server | `server/docs.ts` gets a second backend that talks to Nextcloud (PROPFIND, GET, PUT with If-Match) | No client. Nextcloud's ETags give a true conflict check | Online only (server down = DOCS down). Files are not on the PC, so agents cannot `@path` them. Search must download every file. App password in `.env` |
| 3. Google Drive | Later: `rclone bisync` on a timer into a local folder (same model as 1). Not `rclone mount` (no offline, odd file events), not the Drive API (Google app review, lots of code) | Same code as option 1 | Another sync tool, another login |
| 4. Obsidian | Point Obsidian at the same folder: it is already a valid vault | Plain `.md`, front matter kept (PROPERTIES box), `[[wiki links]]` and `#tags` kept as typed; `.obsidian/` is a dot folder, so DOCS hides it | Obsidian on the phone needs its own sync (the Nextcloud folder via the Remotely Save plugin, or Obsidian Sync) |

Do not point two sync clients at one folder: they fight over its sync database.
Use selective sync (only the documents folder, not folders with `.git` inside: sync clients can break those).

## Reminders

- Today: a checklist line is a reminder: `- [ ] call the bank`. It is a real tick box in DOC view and saves as `[x]`.
- Due dates, written the Obsidian Tasks way so Obsidian and agents read them too:
  `- [ ] call the bank 📅 2026-10-20` (done: `- [x] call the bank 📅 2026-10-20 ✅ 2026-10-19`).
- Alerts, two ways:
  - **A. Phosphor push.** The server scans `Reminders/` (or every doc) for open items with a date and sends the
    existing phone push on the day. File stays the only truth. Small, one-way, no new accounts.
  - **B. Nextcloud Tasks (CalDAV).** A sync job maps each dated item to a VTODO in a Tasks list on your
    Nextcloud (app password). Ticked on the phone (Tasks.org or jtx with DAVx5) = `[x]` in the file. Needs a
    stable id per item: Obsidian Tasks' `🆔 abc123` field (plain text, kept by DOC view). Two-way sync means
    handling edits on both sides, deleted items and renamed files: real work, worth it only if reminders must
    live in other apps.

## Recommendation

Option 1 (Nextcloud client on Linux, DOCS on `~/Nextcloud/Documents`), Obsidian-compatible files (option 4,
nothing to build), Google Drive later through rclone into a local folder if ever needed. No WebDAV backend.

## Open decisions

1. **Install the Nextcloud desktop client on Linux and move the docs folder to `~/Nextcloud/Documents`?**
   Suggested: yes, with selective sync (Documents only).
2. **Reminder alerts: A (Phosphor push) or B (Nextcloud Tasks)?** Suggested: A first; B later only if you want
   reminders inside other apps.
