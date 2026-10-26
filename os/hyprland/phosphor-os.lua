-- Phosphor-OS as the desktop on Omarchy 4 (Hyprland 0.55+ reads its config as Lua).
--
-- scripts/setup-linux.sh adds ONE line at the end of ~/.config/hypr/hyprland.lua (after a backup):
--   phosphor_os_dir = "<project folder>"; dofile(phosphor_os_dir .. "/os/hyprland/phosphor-os.lua") -- phosphor-os-desktop
-- `setup-linux.sh --undo` takes that line out again. Nothing else in Omarchy's config is changed.
--
-- What it does:
--   At login         Phosphor-OS starts maximized on workspace 1, no border, no rounded corners.
--   Super + Alt + R  restart the Phosphor-OS app (the server and running chats keep going)
--   Super + Alt + T  a plain terminal: the safety net, works even when Phosphor-OS does not
--   Super + T        full size under the bar;  Super + Shift + T  floating on/off;  no window gaps
--   Super + M        minimize (the taskbar button brings it back)
--   Ctrl + Space     DICTATE in any app: press, talk, press again, the words go in at the cursor
--                    (in Phosphor-OS itself the key goes on to the app's own DICTATE)
-- Omarchy's own keys stay: Super + Space (Omarchy menu), Super + Return (terminal), Super + F (real full
-- screen), Super + Shift + Space (bar on/off), Super + W (close a window; the desktop ignores it).

local dir = phosphor_os_dir
if type(dir) ~= "string" or dir == "" then
  return
end

local function quote(s)
  return "'" .. tostring(s):gsub("'", "'\\''") .. "'"
end

-- The window class Electron gets from app.setDesktopName('phosphor-os.desktop') in shell/main.mjs.
local CLASS = "^phosphor-os$"
local app = "bash " .. quote(dir .. "/scripts/phosphor-os.sh")

-- Omarchy starts apps through uwsm-app (own systemd scope); fall back to a plain start elsewhere.
local function launch(args)
  local cmd = app .. " " .. args
  if o and o.launch then
    return o.launch(cmd)
  end
  return cmd
end

local dictate = "bash " .. quote(dir .. "/os/omarchy/clock/phosphor-dictate")

hl.on("hyprland.start", function()
  hl.exec_cmd(launch("--desktop"))
  hl.exec_cmd(dictate .. " reset") -- a take cut off by a logout or crash leaves the mic dot on
end)

-- Every Phosphor-OS window: workspace 1, flat, fully opaque (Omarchy dims other windows a little).
hl.window_rule({
  match = { class = CLASS },
  workspace = "1",
  border_size = 0,
  rounding = 0,
  no_shadow = true,
  no_blur = true,
  tag = "-default-opacity",
  opacity = "1 override 1 override",
})

-- The main window only (not its dialogs or sign-in popups, which float): maximized from the first frame.
-- Maximized, not full screen, so the bar with the taskbar (~/.config/omarchy/bar/modules/taskbar.qml) stays visible.
hl.window_rule({
  match = { class = CLASS, initial_title = "^Phosphor-OS", float = false, modal = false },
  tile = true, -- never floating: a floating window sits over every other app and hides them
  maximize = true,
})

-- No gaps between windows or at the screen edge (borders stay, to show the active window).
hl.config({ general = { gaps_in = 0, gaps_out = 0 } })

-- Ours win if a later Omarchy update binds the same keys.
for _, keys in ipairs({ "SUPER + ALT + R", "SUPER + ALT + T", "SUPER + T", "SUPER + SHIFT + T", "SUPER + M", "SUPER + CTRL + ALT + D", "CTRL + SPACE" }) do
  pcall(hl.unbind, keys)
end

hl.bind("SUPER + ALT + R", hl.dsp.exec_cmd(launch("--restart")), { description = "Restart Phosphor-OS" })

-- Super + T = full size UNDER the bar (Omarchy: float toggle, which hid windows behind floating ones).
-- Super + F stays Omarchy's real full screen (over the bar: games, video). Float toggle moves to Super + Shift + T.
hl.bind("SUPER + T", hl.dsp.window.fullscreen({ mode = "maximized" }), { description = "Full size under the bar" })
hl.bind("SUPER + SHIFT + T", hl.dsp.window.float({ action = "toggle" }), { description = "Toggle window floating/tiling" })

-- Super + M = minimize: park the window on a hidden workspace. The bar's taskbar keeps a dimmed button for it;
-- a click there (or a notification that focuses it) brings it back (os/omarchy/bar/taskbar.qml).
hl.bind("SUPER + M", hl.dsp.window.move({ workspace = "special:minimized", follow = false }), { description = "Minimize window" })

-- The calendar (Omarchy's key): asks the clock itself, so it works with the pack's clock (os/omarchy/clock, where
-- `shell toggle omarchy.clock` finds no omarchy.clock in the bar) and with Omarchy's own.
hl.bind("SUPER + CTRL + ALT + D", hl.dsp.exec_cmd("omarchy-shell omarchy.clock toggle"), { description = "Calendar" })

-- Ctrl + Space: DICTATE anywhere (os/omarchy/clock/phosphor-dictate). Phosphor-OS has its own DICTATE on the same
-- key, with live text, so there the key is handed on to the app (down and up apart, like Omarchy's clipboard keys).
-- A global bind takes the key from every other app (an editor's code completion, an input method switch): on
-- purpose: Super + H with hold to talk was tried (2026-10-26) and dropped, since a tap on this key does it all.
hl.bind("CTRL + SPACE", function()
  local w = hl.get_active_window()
  if w and w.class == "phosphor-os" then -- CLASS is a regex for rules; a Lua pattern reads "-" as a repeat
    hl.dispatch(hl.dsp.send_key_state({ mods = "CTRL", key = "space", state = "down" }))
    hl.timer(function()
      hl.dispatch(hl.dsp.send_key_state({ mods = "CTRL", key = "space", state = "up" }))
    end, { timeout = 50, type = "oneshot" })
  else
    hl.dispatch(hl.dsp.exec_cmd(dictate .. " toggle"))
  end
end, { description = "Dictate (any app)" })

-- Safety net: no Omarchy launcher, no uwsm, just the first terminal that is installed.
hl.bind(
  "SUPER + ALT + T",
  hl.dsp.exec_cmd('exec "$(command -v foot || command -v xdg-terminal-exec || command -v alacritty || command -v kitty || command -v ghostty)"'),
  { description = "Terminal (safety net)" }
)

-- Steam's main window joins the normal layout like every other app (Omarchy floats it, so it sat over
-- everything and hid the windows behind it). Its small popups (Friends List, dialogs) still float.
hl.window_rule({
  match = { class = "^steam$", title = "^Steam$" },
  tile = true,
})
