-- Phosphor-OS: YouTube's speed keys in mpv. Shift+> faster, Shift+< slower, in YouTube's steps up to 3x.
-- (They take mpv's own > and <, which jump to the next and previous file of a playlist; Enter still goes to the
-- next one.) The voice keeps its pitch (mpv's default). Linked into ~/.config/mpv/scripts/ by desktop.sh.
local steps = { 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3 }

local function set(speed)
  mp.set_property_number("speed", speed)
  mp.osd_message(string.format("Speed %.2fx", speed))
end

mp.add_forced_key_binding(">", "phosphor-speed-up", function()
  local now = mp.get_property_number("speed", 1)
  for _, s in ipairs(steps) do
    if s > now + 0.001 then return set(s) end
  end
  set(steps[#steps])
end)

mp.add_forced_key_binding("<", "phosphor-speed-down", function()
  local now = mp.get_property_number("speed", 1)
  for i = #steps, 1, -1 do
    if steps[i] < now - 0.001 then return set(steps[i]) end
  end
  set(steps[1])
end)
