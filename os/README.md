# Phosphor-OS OS themes

Make the whole computer match Phosphor-OS. Three looks, same names as the app's themes:

| OS theme | App theme | Look |
|---|---|---|
| `retro-amber` | amber | amber phosphor on near black, square corners, soft glow, VT323 |
| `retro-green` | green | green phosphor, same shapes |
| `lcars` | lcars | black, orange/gold/peach/lilac/lavender blocks, rounded, condensed capitals |

| Folder | What |
|---|---|
| `omarchy/desktop.sh` | the whole look in one step: theme, font, bar at the bottom with the taskbar (Linux) |
| `omarchy/themes/<theme>/` | Omarchy 4.0.4 theme (Linux) |
| `omarchy/install-fonts.sh` | installs VT323 and Antonio for your user (Linux) |
| `omarchy/bar/taskbar.qml` | bar module: one button per open window (Linux) |
| `omarchy/hooks/theme-set.d/` | optional: switch the system font to VT323 with the retro themes |
| `hyprland/phosphor-os.lua` | desktop mode and keys; `scripts/setup-linux.sh` loads it (Linux) |
| `wallpapers/<theme>/` | every wallpaper at 3440x1440, 2560x1440 and 3840x2160 (any OS) |
| `firefox/` | Firefox looks + installers for Windows and Linux |
| `windows/terminal-schemes.json` | Windows Terminal color schemes |
| `tools/` | the generators (palettes, configs, wallpapers); see "Change a theme" |

## Install the look on Omarchy

One step: `bash os/omarchy/desktop.sh` (add `--theme retro-green` or `--theme lcars` for another look,
`--dry-run` to see first, `--undo` to take it back). `docs/OMARCHY.md` lists each change. By hand, the theme alone:

1. Copy the theme folder into your themes:
   `cp -r os/omarchy/themes/retro-amber ~/.config/omarchy/themes/`
2. Turn it on: `omarchy theme set retro-amber`, or Super+Space > Style > Theme.
3. Other wallpapers of the theme: Super+Ctrl+Space.
4. Optional, boot unlock screen: Super+Space > Style > Unlock, pick the theme.

Copy the folder; do not install it with `omarchy theme install <url>`. Themes cloned from a git repo lose
their `.lua` files, and the window borders, corners and glow live in `hyprland.lua`.

Fonts (optional):

1. `bash os/omarchy/install-fonts.sh` (VT323 and Antonio, checked against pinned SHA-256s).
2. Retro themes: `omarchy font set VT323`. With VT323 the bar text is small; add `[font]` and `base-size = 16`
   to `~/.config/omarchy/shell.toml`.
3. Or let the font follow the theme: `mkdir -p ~/.config/omarchy/hooks/theme-set.d && cp os/omarchy/hooks/theme-set.d/50-phosphor-os-font ~/.config/omarchy/hooks/theme-set.d/`.
   It sets VT323 when you pick a retro theme and puts your old font back when you pick any other.

Undo by hand: pick another theme (`omarchy theme set tokyo-night`), then
`rm -rf ~/.config/omarchy/themes/retro-amber` (and the others). Fonts: `bash os/omarchy/install-fonts.sh --undo`,
`rm ~/.config/omarchy/hooks/theme-set.d/50-phosphor-os-font`, `omarchy font set "JetBrainsMono Nerd Font"`.

## Firefox (Windows and Linux)

Windows: `powershell -ExecutionPolicy Bypass -File os\firefox\install-firefox-theme.ps1 -Theme retro-amber`
Linux: `bash os/firefox/install-firefox-theme.sh -Theme retro-amber`

- Themes: `retro-amber`, `retro-green`, `lcars`. Close Firefox fully and open it again to see it.
- It uses your default profile. Another one: add `-Profile <profile folder>` (about:profiles shows the folder).
- It backs up the profile's `chrome` folder and `user.js` to `<profile>/phosphor-os-backup/<time>/`, then turns on
  `toolkit.legacyUserProfileCustomizations.stylesheets` (Firefox ignores theme files without it).
- Undo: run it again with `-Undo`. Each undo puts back the newest backup, so two installs need two undos.
- It replaces the whole `chrome` folder (the old one is in the backup).
- LCARS uses Antonio if installed, else Bahnschrift Condensed (Windows) or Roboto Condensed / Liberation Sans Narrow.
  The retro looks bring their own VT323 file.

## Windows now

Nothing here changes a Windows setting by itself.

- Wallpapers: `os\wallpapers\<theme>\`. In Settings > Personalization > Background > Picture, Browse to the
  3440x1440 file, then the 2560x1440 one; right-click each in the picture list > Set for monitor 1 or 2.
- Windows Terminal: copy `os\windows\terminal-schemes.json` to
  `%LOCALAPPDATA%\Microsoft\Windows Terminal\Fragments\PhosphorOS\` (make the folder), restart Terminal, then
  Settings > your profile > Appearance > Color scheme > "Phosphor-OS Amber", "Phosphor-OS Green" or
  "Phosphor-OS LCARS". Or paste the three objects into `"schemes"` in Settings > Open JSON file.
  Undo: delete the `PhosphorOS` fragment folder (or the pasted objects) and pick your old scheme.

## What an Omarchy 4.0.4 theme can hold (checked in the v4.0.4 source)

`omarchy-theme-set <name>` copies `/usr/share/omarchy/themes/<name>/`, lays `~/.config/omarchy/themes/<name>/`
over it, fills every file the theme does not ship from `default/themed/*.tpl` and `colors.toml`, then moves the
result to `~/.local/state/omarchy/current/theme/` and tells the shell, terminals, btop, browsers and editors.
A shipped file always wins over the generated one.

| File | What it does | Ours |
|---|---|---|
| `colors.toml` | the palette; every template reads it (terminals, btop, Neovim, Helix, VS Code, Obsidian, Claude Code, browsers, shell) | all 30 keys the 22 built-in themes use |
| `backgrounds/` | wallpapers; the first one is used, Super+Ctrl+Space cycles | 3440x1440 copies (pixel exact on 1440p screens) |
| `preview.png` | picture in the theme switcher (else the first background) | mock desktop |
| `unlock.png`, `preview-unlock.png` | boot (disk unlock) logo and its preview; lists the theme under Style > Unlock | yes |
| `icons.theme` | Yaru icon color for the file manager | Yaru-yellow, Yaru-sage, Yaru-wartybrown |
| `hyprland.lua` | Hyprland settings loaded after Omarchy's defaults: borders, gaps, rounding, shadow, groups | yes |
| `shell.toml` (or `shell.<section>.toml`) | the Omarchy 4 shell: bar, launcher, menus, notifications, OSD, lock screen, polkit | full file |
| `btop.theme` | btop colors | phosphor ramps / LCARS blocks |
| `chromium.theme` | `r,g,b` toolbar color for Chromium, Chrome, Edge, Brave | yes |
| `keyboard.rgb` | keyboard backlight color (some ASUS and Framework) | accent |
| `neovim.lua`, `vscode.json` | pick a named Neovim / VS Code theme instead of the generated one | not shipped: the generated ones follow `colors.toml` |
| `alacritty.toml`, `foot.ini`, `ghostty.conf`, `kitty.conf`, `helix.toml`, ... | hand-written app configs (override the template) | not needed |
| `light.mode` | old way to mark a light theme (`mode = "light"` in colors.toml now) | dark |

Things that changed in 4.0 ("Quattro"): Waybar, Walker, Mako, SwayOSD and Hyprlock are gone. The bar, launcher,
notifications, OSD and lock screen are one Quickshell program styled by `shell.toml`, and Hyprland is configured in
Lua (`hyprland.lua`, not `hyprland.conf`). Corner rounding of shell panels follows Hyprland's `decoration.rounding`.

Fonts: a 4.0.4 theme cannot set the font family. Omarchy has one system-wide monospace font
(`omarchy font set <name>`, fontconfig `monospace`) used by the terminal and the bar; a theme only sets sizes
(`[font] base-size` in `shell.toml`). That is why the font is a separate step (or the hook) above. A condensed
LCARS face cannot be the system font (terminals need a fixed-width font), so LCARS keeps your monospace font in
terminals and uses Antonio in Firefox. Menus alone can take another family through the `OMARCHY_MENU_FONT`
environment variable (read when the shell starts; untested).

## Change a theme

All colors come from `os/tools/palettes.mjs`. After editing it:

- `node os/tools/build-themes.mjs` rewrites every config file (Omarchy, Firefox CSS, Terminal schemes).
- `PLAYWRIGHT_CORE=<path to playwright-core/index.mjs> node os/tools/wallpapers.mjs` redraws the wallpapers,
  previews and unlock logos in headless Edge (nothing shows on screen). Add `--theme lcars` to do one theme.

## Untested

- `retro-green` and `lcars` on a real Omarchy (`retro-amber`, VT323 and the taskbar run on the author's PC).
- `desktop.sh` ran only in a test home with stub `omarchy` commands; on the author's PC its settings were made by hand.
- The font hook ran in Git Bash on Windows (stub `omarchy` commands), not on Arch.
- Firefox: checked in Firefox 157.0.1 on Windows, headless (tabs, toolbar, address bar and its results list, new
  tab page, menu colors read from the live styles). Not seen on screen: drop-down menus and panels as drawn, Linux
  Firefox, 125% scaling, vertical tabs.
- Windows Terminal schemes: JSON checked, not loaded into Terminal.
