# STATION: your servers, and Unraid's health

STATION (the STATION button, MENU on phones) is the hub for your self-hosted services: a tile per service with UP / SLOW /
DOWN, the last answer time, a sparkline of the last 40 checks and a 24-hour uptime strip. DISCOVER finds apps on one of
your servers. Above the tiles, if you connect it, sits the **Unraid panel**: the health of your Unraid server.

The STATION button shows a number when something needs a look: services that are down, Unraid alerts and warnings, or an
Unraid that does not answer.

## Connect your Unraid server

> Untested against a real server. It was built and tested with made-up answers shaped like Unraid's API (from its public
> schema). On the first real run the panel may say what to fix; the table below lists the notes.

Needs Unraid 7.2 or newer (the API is built in). Older 7.x: install the **Unraid Connect** plugin from Community
Applications; you do not need to sign in to Unraid Connect for this.

1. **Make a read-only key** in Unraid's web page:
   - Settings > Management Access > API Keys
   - Press the create button ("Create API key", then "Create new")
   - Name: `Phosphor OS` (Unraid only allows letters, numbers and spaces)
   - Role / preset: **Viewer**, then submit
   - Copy the key now.

   Or in Unraid's terminal: `unraid-api apikey --create --name "Phosphor OS" --roles VIEWER --json`, and copy the `key`
   it prints. The Viewer role can read everything except API keys and cannot change anything.
2. **Two lines in `.env`** (the file in the Phosphor-OS folder on this PC):

   ```
   PHOSPHOR_UNRAID_URL=http://192.168.1.10
   PHOSPHOR_UNRAID_KEY=paste-the-key-here
   ```

   The address is what you type in the browser to open Unraid's page (no `/graphql` needed). If that address is `https`
   and Unraid uses its own certificate, add a third line: `PHOSPHOR_UNRAID_SELF_SIGNED=1`.

   Optional: `PHOSPHOR_UNRAID_SMART=1` adds "SMART OK" to each disk. It is off because Unraid's API fills that field by
   running `smartctl` on every disk, which can wake disks that are spun down (and spin-down is why you run Unraid
   this way). With it on, STATION asks at most once an hour. Everything else the panel shows is read from Unraid's own
   state and wakes nothing. Unraid's own SMART monitor still raises notifications, and those show under UNRAID NOTICES.
3. **Restart the server**: `systemctl --user restart phosphor-os-server`. A restart ends chats that are working, so do it
   when none is.
4. **Open STATION.** The Unraid panel is at the top; the first numbers come within a few seconds.

Not connected yet, STATION shows a short note with these steps (HIDE THIS puts it away on that device). One of the two
lines missing or not an address is named in the note.

### If the panel says something else

| The panel says | It means | What to do |
|---|---|---|
| NO ANSWER: nothing answers at that address | Wrong address or port, or the server is off | Use the address you open in the browser; check the server is on |
| NO ANSWER: that name was not found | This PC cannot resolve the name | Use the server's number address |
| NO ANSWER: certificate is not trusted | `https` with Unraid's own certificate | Add `PHOSPHOR_UNRAID_SELF_SIGNED=1` |
| NO ANSWER: does not speak HTTPS | The address says `https` but the port is plain | Use `http://` |
| KEY REFUSED | The key is wrong, was deleted, or may read nothing | Make a new key with the Viewer role, put it in `.env`, restart |
| NOT UNRAID? nothing at /graphql | Unraid older than 7.2 without the plugin, or not Unraid's address | Update Unraid, or install the Unraid Connect plugin |
| NOT UNRAID? sends you somewhere else | Unraid forwards `http` to `https` (Settings > Management Access > Use SSL/TLS) | Put the `https` address in `PHOSPHOR_UNRAID_URL` |
| NOT ANSWERED: DOCKER (or another part) | That one part failed (key may not read it, service off) | The rest still works; the note says why |

While Unraid does not answer, the panel shows its last answer, dimmed, with when it was.

## What the panel shows

- **Alerts** on top (see the rules below), or NO ALERTS.
- **ARRAY**: started or stopped, how full; a running parity check with progress and speed (Unraid's API does not say
  whether it is correcting, or how many errors it has found so far).
- **SYSTEM**: CPU and RAM use, uptime. The head line has the host name, Unraid version and how fresh the numbers are.
- **DISKS** (parity and data) and **CACHE AND POOLS**: name, device, temperature, used and size, errors, spinning or spun
  down, and SMART OK if you turned that on. A disk with an alert has a bright frame.
- **DOCKER**: running and stopped containers (stopped ones that should be running are bright). **VMS** the same.
- **UNRAID NOTICES**: how many unread warnings and alerts, and the latest titles.
- **UPS**: charge, minutes left, load, if Unraid has one.
- **BACKUPS**: the last parity check (result, date, how long, speed). Unraid's API can start a flash backup but has no
  question that says when one last ran, so that line says "not shown by the Unraid API".

## Alerts

| Alert | When | Level |
|---|---|---|
| ARRAY IS NOT STARTED | The array is stopped or in another state than started | ALERT |
| DISK IS DISABLED / MISSING / WRONG / INVALID | Unraid does not count on that disk | ALERT |
| DISK HAS N ERRORS | Unraid counted read or write errors on it | ALERT |
| DISK IS 52 C | Hard disks: over Unraid's own warning temperature (WARN), at or over its critical one (ALERT). Defaults 45 and 55, read from Unraid's display settings. SSDs and NVMe: 15 degrees higher. A spun-down disk is not judged | WARN / ALERT |
| LAST PARITY CHECK FOUND N ERRORS / FAILED | The newest finished check in Unraid's parity history (a running check that reports errors counts too, if Unraid says so) | ALERT |
| CONTAINER HAS STOPPED | Not running and set to start with the array, or seen running and stopped within the last 24 hours | WARN |
| VM HAS CRASHED | Unraid says crashed | WARN |
| UPS IS ON BATTERY | The UPS status says so | WARN |
| N UNREAD UNRAID ALERTS / WARNINGS | Unraid's own notifications you have not read | ALERT / WARN |

A container you stop by hand shows as STOPPED for a day, then drops off by itself (unless it is set to start with the
array). SMART "unknown" is not an alert: Unraid's API only says OK or UNKNOWN. No push alerts yet; these are rows and the
badge.

## 24-hour strip on every service

Each tile has a strip of 96 blocks, 15 minutes each, newest on the right: a low dim block = every check answered, taller =
slow, a full block with a bright top = some checks failed, a full bright block = all failed, a thin line = no check then.
Under it: `24H 99.8% UP · AVERAGE 143 MS`. Checks run once a minute while STATION is open anywhere, and every 10 minutes
otherwise, so the strip fills while you are away. The counts are kept in `data/station-health.json` (about 2 KB per
service).

## What it reads, what it can do, where the key lives

- **Read-only.** The code only sends GraphQL `query` documents (never `mutation`), the Viewer role cannot change anything
  even if it tried, and it never starts, stops or restarts anything.
- **Asked** (eight small questions, one per part, every minute while STATION is open, every 10 minutes otherwise; none of
  them touches a disk): version, host
  name, uptime, temperature limits; array state, capacity, parity check and history, each disk's name, device, size,
  temperature, errors, status and spin state (and SMART status, only with `PHOSPHOR_UNRAID_SMART=1`); CPU and RAM use; Docker container names, states and
  auto-start; VM names and states; unread notification counts and the latest titles; UPS status.
- **Never asked**: the server's licence or registration, user names, shares and files, logs, other API keys, the web
  login's tokens, network addresses.
- **A part Unraid does not have** (an older Unraid lacks a field) is dropped from the question and asked again without it.
- **The key** lives in `.env` only. The server takes it out of its environment at start (so the Claude processes it starts
  do not inherit it), keeps it where it cannot be printed, and never sends it to the page, a log, `data/` or any chat.
  The panel gets a cleaned summary. `data/station-unraid.json` holds only the names of containers that were running and
  the times (for "has stopped").
- **No chat gets any of this.** No tool, MCP server or prompt line in Phosphor-OS reaches the Unraid data; `tests/station-unraid.ts` checks
  that no chat code imports it. One honest limit: a chat that is allowed to read files could open `.env` (the app password
  is in there too). The key can only look, and you can revoke it any time in Unraid (Settings > Management Access >
  API Keys).

## Notes for the code

Server: `server/unraidapi.ts` (the questions in one place, the request, the cleaning, the alert rules), `server/unraid.ts`
(`.env`, polling, the route `GET /api/station/unraid`, the memory of running containers), `server/stationhealth.ts` (the
24-hour counts), `server/station.ts`. Shared shapes: `shared/unraid.ts`, `shared/station.ts`. Page: `web/src/unraid.ts`
(the panel), `unraidfmt.ts` (number words), `station.ts` (badge, strip), `stationdemo.ts` (made-up data for `/?demo=1`;
`&unraid=off` and `&unraid=down` show the other two states). Test: `npx tsx tests/station-unraid.ts` (fixtures in
`tests/fixtures/unraid/`, made up and shaped like the API's schema).
