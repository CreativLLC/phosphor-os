// focus-app: bring a running program's main window to the front, for the desktop app's program buttons
// (WEB = Firefox, DISCORD = the Discord app). Built by scripts/setup-shell.ps1 with Windows' own C# compiler.
//
// Usage: focus-app.exe <process name>      e.g. focus-app.exe firefox
// Exit:  0 = in front, 2 = no window (start the program instead), 3 = Windows kept another window in front,
//        1 = wrong use.

using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

static class FocusApp
{
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    const int SW_RESTORE = 9;

    static int Main(string[] args)
    {
        if (args.Length != 1) return 1;
        IntPtr win = IntPtr.Zero;
        foreach (Process p in Process.GetProcessesByName(args[0]))
        {
            try
            {
                if (p.MainWindowHandle != IntPtr.Zero && p.MainWindowTitle.Length > 0) { win = p.MainWindowHandle; break; }
            }
            catch (InvalidOperationException) { } // the process just ended
        }
        if (win == IntPtr.Zero) return 2;

        if (IsIconic(win)) ShowWindow(win, SW_RESTORE);
        if (!SetForegroundWindow(win))
        {
            // Borrow the front window's input queue for a moment; Windows then lets this program switch windows.
            uint front = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
            uint me = GetCurrentThreadId();
            AttachThreadInput(me, front, true);
            SetForegroundWindow(win);
            BringWindowToTop(win);
            AttachThreadInput(me, front, false);
        }
        if (GetForegroundWindow() != win) SwitchToThisWindow(win, true); // what Alt+Tab uses
        if (GetForegroundWindow() != win)
        {
            // Last try: a tap of Alt (to the window in front now) makes this the program that had the last input.
            keybd_event(0x12, 0, 0, UIntPtr.Zero);
            keybd_event(0x12, 0, 2, UIntPtr.Zero);
            SetForegroundWindow(win);
        }
        return GetForegroundWindow() == win ? 0 : 3;
    }
}
