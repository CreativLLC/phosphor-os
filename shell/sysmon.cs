// sysmon: the SYS panel's reader on Windows. server/system.ts starts it while someone has the panel open.
// Built by scripts/setup-shell.ps1 with Windows' own C# compiler, together with volume.cs (for Audio).
//
// Usage: sysmon.exe watch <ms>     (ms 500 to 60000)
// Prints one JSON line first:  {"t":"info","adapters":[...],"drives":[...]}
// then one line every <ms>:    {"t":"sample","cpu":..,"cores":[..],"gpu3d":{luid:%},"vram":{luid:bytes},"net":[[name,rx,tx]],"vol":[pct,muted]}
// Exits when its input closes, so it never outlives the server, even when the server crashes.
//
// Counters come from PDH, the API under typeperf and perfmon. Unlike typeperf, a PDH wildcard counter picks up
// programs that start later, so a game started after the panel opened still counts toward GPU use.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

static class SysMon
{
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhOpenQueryW(string source, IntPtr user, out IntPtr query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhAddEnglishCounterW(IntPtr query, string path, IntPtr user, out IntPtr counter);
    [DllImport("pdh.dll")] static extern uint PdhCollectQueryData(IntPtr query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhGetFormattedCounterArrayW(IntPtr counter, uint format, ref uint size, out uint count, IntPtr items);

    const uint PDH_FMT_DOUBLE = 0x200;
    const uint PDH_MORE_DATA = 0x800007D2;

    static readonly Regex Luid = new Regex(@"luid_(0x[0-9a-f]+_0x[0-9a-f]+)", RegexOptions.IgnoreCase);
    static readonly Regex Core = new Regex(@"^(\d+),(\d+)$");
    static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    static int Main(string[] args)
    {
        int ms;
        if (args.Length != 2 || args[0] != "watch" || !int.TryParse(args[1], out ms) || ms < 500 || ms > 60000) return 1;

        // The server closes our input when it stops us or dies.
        var guard = new Thread(() =>
        {
            try
            {
                var input = Console.OpenStandardInput();
                var buf = new byte[64];
                while (input.Read(buf, 0, buf.Length) > 0) { }
            }
            catch (IOException) { }
            Environment.Exit(0);
        });
        guard.IsBackground = true;
        guard.Start();

        IntPtr q;
        if (PdhOpenQueryW(null, IntPtr.Zero, out q) != 0) return 2;
        IntPtr cpu = Add(q, @"\Processor Information(*)\% Processor Utility");
        IntPtr gpu = Add(q, @"\GPU Engine(*engtype_3D)\Utilization Percentage");
        IntPtr vram = Add(q, @"\GPU Adapter Memory(*)\Dedicated Usage");
        IntPtr rx = Add(q, @"\Network Interface(*)\Bytes Received/sec");
        IntPtr tx = Add(q, @"\Network Interface(*)\Bytes Sent/sec");

        if (!Emit(Info())) return 0;
        PdhCollectQueryData(q); // rates need two reads
        while (true)
        {
            Thread.Sleep(ms);
            PdhCollectQueryData(q);
            if (!Emit(Sample(cpu, gpu, vram, rx, tx))) return 0;
        }
    }

    static IntPtr Add(IntPtr q, string path)
    {
        IntPtr c;
        return PdhAddEnglishCounterW(q, path, IntPtr.Zero, out c) == 0 ? c : IntPtr.Zero;
    }

    static bool Emit(string line)
    {
        try
        {
            Console.Out.Write(line + "\n");
            Console.Out.Flush();
            return true;
        }
        catch (IOException) { return false; } // the server went away
    }

    // ------------------------------------------------------------------ one sample

    static string Sample(IntPtr cpu, IntPtr gpu, IntPtr vram, IntPtr rx, IntPtr tx)
    {
        var sb = new StringBuilder("{\"t\":\"sample\"");

        var cores = new List<KeyValuePair<long, double>>();
        double total = -1;
        foreach (var kv in Read(cpu))
        {
            if (kv.Key == "_Total") total = kv.Value;
            var m = Core.Match(kv.Key);
            if (m.Success) cores.Add(new KeyValuePair<long, double>(long.Parse(m.Groups[1].Value) * 4096 + long.Parse(m.Groups[2].Value), kv.Value));
        }
        cores.Sort((a, b) => a.Key.CompareTo(b.Key));
        if (total >= 0) sb.Append(",\"cpu\":").Append(Num(total));
        sb.Append(",\"cores\":[");
        for (int i = 0; i < cores.Count; i++) sb.Append(i > 0 ? "," : "").Append(Num(cores[i].Value));
        sb.Append(']');

        sb.Append(",\"gpu3d\":").Append(ByLuid(Read(gpu)));
        sb.Append(",\"vram\":").Append(ByLuid(Read(vram)));

        var down = Read(rx);
        var up = new Dictionary<string, double>();
        foreach (var kv in Read(tx)) up[kv.Key] = kv.Value;
        sb.Append(",\"net\":[");
        bool first = true;
        foreach (var kv in down)
        {
            double sent;
            up.TryGetValue(kv.Key, out sent);
            sb.Append(first ? "" : ",").Append('[').Append(Str(kv.Key)).Append(',').Append(Num(kv.Value)).Append(',').Append(Num(sent)).Append(']');
            first = false;
        }
        sb.Append(']');

        int pct;
        bool muted;
        try
        {
            if (Audio.Get(out pct, out muted)) sb.Append(",\"vol\":[").Append(pct).Append(',').Append(muted ? 1 : 0).Append(']');
        }
        catch (Exception) { } // no audio service: leave volume out
        return sb.Append('}').ToString();
    }

    // Sum per graphics card: GPU Engine has one instance per program and engine, memory one per card.
    static string ByLuid(List<KeyValuePair<string, double>> items)
    {
        var sums = new Dictionary<string, double>();
        foreach (var kv in items)
        {
            var m = Luid.Match(kv.Key);
            if (!m.Success) continue;
            string id = m.Groups[1].Value.ToLowerInvariant();
            double s;
            sums.TryGetValue(id, out s);
            sums[id] = s + kv.Value;
        }
        var sb = new StringBuilder("{");
        foreach (var kv in sums) sb.Append(sb.Length > 1 ? "," : "").Append(Str(kv.Key)).Append(':').Append(Num(kv.Value));
        return sb.Append('}').ToString();
    }

    // Every instance of a wildcard counter, as of the last collect.
    static List<KeyValuePair<string, double>> Read(IntPtr counter)
    {
        var list = new List<KeyValuePair<string, double>>();
        if (counter == IntPtr.Zero) return list;
        for (int tries = 0; tries < 3; tries++)
        {
            uint size = 0, count;
            uint r = PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, ref size, out count, IntPtr.Zero);
            if (r != PDH_MORE_DATA) return list;
            IntPtr buf = Marshal.AllocHGlobal((int)size);
            try
            {
                r = PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, ref size, out count, buf);
                if (r == PDH_MORE_DATA) continue; // a program started in between; ask again
                if (r != 0) return list;
                // PDH_FMT_COUNTERVALUE_ITEM_W: name pointer, then status (DWORD) and the value (8-byte aligned).
                int item = IntPtr.Size == 8 ? 24 : 16;
                int valueAt = IntPtr.Size == 8 ? 16 : 8;
                for (int i = 0; i < count; i++)
                {
                    IntPtr p = buf + i * item;
                    uint status = (uint)Marshal.ReadInt32(p, IntPtr.Size);
                    if (status > 1) continue; // only valid (0) or new (1) data
                    double v = BitConverter.Int64BitsToDouble(Marshal.ReadInt64(p, valueAt));
                    list.Add(new KeyValuePair<string, double>(Marshal.PtrToStringUni(Marshal.ReadIntPtr(p)), v));
                }
                return list;
            }
            finally { Marshal.FreeHGlobal(buf); }
        }
        return list;
    }

    // ------------------------------------------------------------------ once: graphics cards and drives

    static string Info()
    {
        var sb = new StringBuilder("{\"t\":\"info\",\"adapters\":[");
        try { Adapters(sb); }
        catch (Exception) { } // no DXGI: the server shows the card as unknown
        sb.Append("],\"drives\":[");
        bool first = true;
        foreach (var d in DriveInfo.GetDrives())
        {
            if (d.DriveType != DriveType.Fixed) continue; // never touch network or removable drives
            string label = "";
            try { if (d.IsReady) label = d.VolumeLabel; else continue; }
            catch (Exception) { continue; }
            sb.Append(first ? "" : ",").Append("{\"root\":").Append(Str(d.Name)).Append(",\"label\":").Append(Str(label)).Append('}');
            first = false;
        }
        return sb.Append("]}").ToString();
    }

    [ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDXGIFactory1
    {
        [PreserveSig] int SetPrivateData(ref Guid name, uint size, IntPtr data);
        [PreserveSig] int SetPrivateDataInterface(ref Guid name, IntPtr unknown);
        [PreserveSig] int GetPrivateData(ref Guid name, ref uint size, IntPtr data);
        [PreserveSig] int GetParent(ref Guid iid, out IntPtr parent);
        [PreserveSig] int EnumAdapters(uint index, out IntPtr adapter);
        [PreserveSig] int MakeWindowAssociation(IntPtr window, uint flags);
        [PreserveSig] int GetWindowAssociation(out IntPtr window);
        [PreserveSig] int CreateSwapChain(IntPtr device, IntPtr desc, out IntPtr swapChain);
        [PreserveSig] int CreateSoftwareAdapter(IntPtr module, out IntPtr adapter);
        [PreserveSig] int EnumAdapters1(uint index, out IDXGIAdapter1 adapter);
    }

    [ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDXGIAdapter1
    {
        [PreserveSig] int SetPrivateData(ref Guid name, uint size, IntPtr data);
        [PreserveSig] int SetPrivateDataInterface(ref Guid name, IntPtr unknown);
        [PreserveSig] int GetPrivateData(ref Guid name, ref uint size, IntPtr data);
        [PreserveSig] int GetParent(ref Guid iid, out IntPtr parent);
        [PreserveSig] int EnumOutputs(uint index, out IntPtr output);
        [PreserveSig] int GetDesc(IntPtr desc);
        [PreserveSig] int CheckInterfaceSupport(ref Guid iid, out long version);
        [PreserveSig] int GetDesc1(out AdapterDesc1 desc);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct AdapterDesc1
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
        public uint VendorId, DeviceId, SubSysId, Revision;
        public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
        public uint LuidLow;
        public int LuidHigh;
        public uint Flags;
    }

    [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid iid, out IDXGIFactory1 factory);

    // Name, video memory and the LUID that the GPU counters use, for every graphics card. Flags & 2 = software.
    static void Adapters(StringBuilder sb)
    {
        Guid iid = typeof(IDXGIFactory1).GUID;
        IDXGIFactory1 f;
        if (CreateDXGIFactory1(ref iid, out f) != 0) return;
        try
        {
            bool first = true;
            for (uint i = 0; i < 16; i++)
            {
                IDXGIAdapter1 a;
                if (f.EnumAdapters1(i, out a) != 0) break;
                try
                {
                    AdapterDesc1 d;
                    if (a.GetDesc1(out d) != 0) continue;
                    string luid = string.Format(Inv, "0x{0:x8}_0x{1:x8}", d.LuidHigh, d.LuidLow);
                    sb.Append(first ? "" : ",")
                      .Append("{\"luid\":").Append(Str(luid))
                      .Append(",\"name\":").Append(Str(d.Description.Trim()))
                      .Append(",\"vendor\":").Append(d.VendorId)
                      .Append(",\"vram\":").Append(d.DedicatedVideoMemory.ToUInt64())
                      .Append(",\"software\":").Append((d.Flags & 2) != 0 ? "true" : "false")
                      .Append('}');
                    first = false;
                }
                finally { Marshal.ReleaseComObject(a); }
            }
        }
        finally { Marshal.ReleaseComObject(f); }
    }

    // ------------------------------------------------------------------ JSON

    static string Num(double v)
    {
        if (double.IsNaN(v) || double.IsInfinity(v)) return "0";
        return v.ToString("0.##", Inv);
    }

    static string Str(string s)
    {
        var sb = new StringBuilder("\"");
        foreach (char c in s ?? "")
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }
}
