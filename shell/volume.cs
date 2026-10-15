// volume: read or change the PC's main volume (the default playback device), for the SYS panel.
// Built by scripts/setup-shell.ps1 with Windows' own C# compiler. sysmon.exe is built from this file too (Audio).
//
// Usage: volume.exe get            prints "<pct> <muted>", e.g. "37 0"
//        volume.exe set <0-100>    sets the level, prints the new state
//        volume.exe mute <0|1>     mutes or unmutes, prints the new state
// Exit:  0 = done, 1 = wrong use, 2 = no playback device (or Windows refused).

using System;
using System.Runtime.InteropServices;

// Core Audio (IAudioEndpointVolume), the same control as the volume icon in the taskbar.
static class Audio
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumerator { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    // Methods in vtable order; only the ones used are called.
    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume
    {
        [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
        [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
        [PreserveSig] int GetChannelCount(out uint count);
        [PreserveSig] int SetMasterVolumeLevel(float db, ref Guid context);
        [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid context);
        [PreserveSig] int GetMasterVolumeLevel(out float db);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
        [PreserveSig] int SetChannelVolumeLevel(uint channel, float db, ref Guid context);
        [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
        [PreserveSig] int GetChannelVolumeLevel(uint channel, out float db);
        [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    const int RENDER = 0, MULTIMEDIA = 1, CLSCTX_ALL = 23;

    // Asked fresh each time: the default device changes when a headset is plugged in.
    static IAudioEndpointVolume Endpoint()
    {
        var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        try
        {
            IMMDevice dev;
            if (en.GetDefaultAudioEndpoint(RENDER, MULTIMEDIA, out dev) != 0 || dev == null) return null;
            Guid iid = typeof(IAudioEndpointVolume).GUID;
            object o;
            int hr = dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o);
            Marshal.ReleaseComObject(dev);
            return hr == 0 ? (IAudioEndpointVolume)o : null;
        }
        finally { Marshal.ReleaseComObject(en); }
    }

    // pct 0-100 as Windows shows it; false when there is no playback device.
    public static bool Get(out int pct, out bool muted)
    {
        pct = 0;
        muted = false;
        var ep = Endpoint();
        if (ep == null) return false;
        try
        {
            float level;
            if (ep.GetMasterVolumeLevelScalar(out level) != 0 || ep.GetMute(out muted) != 0) return false;
            pct = (int)Math.Round(level * 100);
            return true;
        }
        finally { Marshal.ReleaseComObject(ep); }
    }

    public static bool SetPct(int pct)
    {
        var ep = Endpoint();
        if (ep == null) return false;
        try
        {
            Guid ctx = Guid.Empty;
            return ep.SetMasterVolumeLevelScalar(pct / 100f, ref ctx) >= 0; // S_FALSE (1) = already at that level
        }
        finally { Marshal.ReleaseComObject(ep); }
    }

    public static bool SetMute(bool mute)
    {
        var ep = Endpoint();
        if (ep == null) return false;
        try
        {
            Guid ctx = Guid.Empty;
            return ep.SetMute(mute, ref ctx) >= 0; // S_FALSE (1) = already in that state
        }
        finally { Marshal.ReleaseComObject(ep); }
    }
}

static class VolumeMain
{
    static int Main(string[] args)
    {
        if (args.Length == 0) return 1;
        int n = -1;
        if (args.Length == 2 && !int.TryParse(args[1], out n)) return 1;
        bool ok;
        if (args[0] == "get" && args.Length == 1) ok = true;
        else if (args[0] == "set" && args.Length == 2 && n >= 0 && n <= 100) ok = Audio.SetPct(n);
        else if (args[0] == "mute" && args.Length == 2 && (n == 0 || n == 1)) ok = Audio.SetMute(n == 1);
        else return 1;
        int pct;
        bool muted;
        if (!ok || !Audio.Get(out pct, out muted)) return 2;
        Console.Out.Write(pct + " " + (muted ? 1 : 0) + "\n");
        Console.Out.Flush();
        return 0;
    }
}
