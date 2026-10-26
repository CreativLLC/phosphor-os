// paste.exe: presses Ctrl+V in the app in front, for DICTATE in any app (shell/dictate.mjs puts the words on the
// clipboard first). Built by scripts/setup-shell.ps1 with the C# compiler that ships with Windows. Untested.
using System;
using System.Runtime.InteropServices;

static class Paste {
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit, Size = 40)]
  struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }
  [DllImport("user32.dll", SetLastError = true)]
  static extern uint SendInput(uint n, INPUT[] inputs, int size);

  const uint KEYBOARD = 1, KEYUP = 2;
  const ushort CTRL = 0x11, V = 0x56;

  static INPUT Key(ushort vk, bool up) {
    var i = new INPUT { type = KEYBOARD };
    i.ki.wVk = vk;
    i.ki.dwFlags = up ? KEYUP : 0;
    return i;
  }

  static int Main() {
    var keys = new[] { Key(CTRL, false), Key(V, false), Key(V, true), Key(CTRL, true) };
    return SendInput((uint)keys.Length, keys, Marshal.SizeOf(typeof(INPUT))) == keys.Length ? 0 : 1;
  }
}
