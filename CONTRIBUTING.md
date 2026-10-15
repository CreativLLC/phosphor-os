# Contributing

Small, clean changes are welcome. Open an issue first for anything big.

## Run the checks

```
npm ci
npx tsc --noEmit -p .      # typecheck
npm run build              # builds the page
npm run test:docs          # DOCS Markdown round trip
npm run test:router        # AUTO model picking
npm run test:calendar      # calendar parsing
bash tests/pack.sh         # the Omarchy pack, setup undo, migration
```

`tests/pack.sh` runs in fake home folders with stand-in commands. It never touches your real desktop, services or
files. It needs Node 24, `jq`, `rsync`, `curl`, `script` and `unshare`, and a finished `npm ci` and `npm run build`.
CI runs the typecheck, the build, `bash -n` and ShellCheck on every shell script, and `tests/pack.sh`.

Builds and tests can use a lot of memory. On Linux with systemd, cap them:
`systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 -- npm run build`.

UI checks use the demo page (`/?demo=1`), which never sends a chat message.

## Rules for the OS pack

The pack is everything under `os/` plus the installers in `scripts/`. It changes someone's desktop, so:

- **Every OS change goes into the pack, never only into `~/.config` by hand.** Change the file in `os/` (or the
  installer that applies it), apply it with the installer, check it, and record it in `docs/OMARCHY.md` (what, why,
  file, how to undo).
- **Everything must be undoable.** Each script has `--dry-run` and `--undo`, and is safe to run twice.
- **Never edit `/usr/share/omarchy/`.** The Omarchy package owns it. Leave Omarchy's own user files as Omarchy made
  them. Our Hyprland changes live in `os/hyprland/phosphor-os.lua`, loaded by one line at the end of
  `~/.config/hypr/hyprland.lua`.
- **Check the result.** After `hyprctl reload`, run `hyprctl configerrors`. Bar modules and shell plugins do not
  hot-reload: `omarchy restart shell`.
- **QML traps.** No function named like an Item property (`focus`). Property names start lower-case. Bar add-ons get
  a limited `bar` object (no `shellQuote`, no notification service). A bash pipeline in a `Process` outlives the bar.
- **No personal data.** No names, emails, IPs, host or tailnet names, personal paths, hardware details or passwords
  in any file. Personal values go in `.env` or `data/`, both gitignored.
- **Keep it small.** No unused options. Comments only where the why is not obvious. Prefer plain words in docs.

## Safety rules for the app

- Localhost plus `tailscale serve` only. Never `tailscale funnel`, never bind to `0.0.0.0`. See [SECURITY.md](SECURITY.md).
- Never print or log the app password (`.env`).
- Restarting the server stops every running chat and sub-agent. Restart only when idle.
- Stop only processes you started, by PID, never by name.

## Pull requests

Describe what changed and how you checked it. Say what you could not test (the docs have an "untested" list; add to
it rather than guessing).
