# =============================================================================
# win-detect.ps1  —  Core AI-tool detection for Windows (no native compilation)
# =============================================================================
# This script is spawned by the Electron agent. It uses Add-Type to P/Invoke
# real Win32 APIs, so it runs on any Windows machine without compiling a native
# addon. It prints a single JSON object to stdout.
#
# WHAT IT DETECTS:
#  1. CAPTURE-EXCLUDED WINDOWS  (the strongest signal)
#       Cluely/Parakeet/Final Round hide their overlay from screen capture using
#       SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE = 0x11) or WDA_MONITOR(0x01).
#       We enumerate top-level windows and call GetWindowDisplayAffinity on each.
#       A visible window that is excluded from capture during an interview is a
#       near-smoking-gun — legitimate apps almost never do this mid-interview.
#  2. PROCESS SIGNATURES
#       Process name + Authenticode signer (Cluely renames its binary, so signer
#       and window title matter more than the file name).
#  3. AUDIO DEVICES
#       Virtual audio / loopback devices used by audio-listening assistants.
#
# It does NOT do stealth monitoring, keylogging, or anything hidden. It reports
# metadata only, and only while the interview is active.
# =============================================================================

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class WinCapture {
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    // The key API: returns the display-affinity flag for a window.
    [DllImport("user32.dll")]
    public static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint dwAffinity);

    public class WinInfo {
        public string Title;
        public uint Pid;
        public uint Affinity;   // 0 = NONE, 1 = MONITOR, 0x11 = EXCLUDEFROMCAPTURE
    }

    public static List<WinInfo> GetWindows() {
        var list = new List<WinInfo>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;
            var sb = new StringBuilder(512);
            GetWindowText(hWnd, sb, sb.Capacity);
            string title = sb.ToString();
            uint pid; GetWindowThreadProcessId(hWnd, out pid);
            uint aff = 0; GetWindowDisplayAffinity(hWnd, out aff);
            // Read affinity BEFORE filtering on title. A stealth overlay is exactly
            // the window that carries no title, so skipping untitled windows first
            // would discard the strongest signal we have. Keep an untitled window
            // only when it is actually excluded from capture.
            if (string.IsNullOrWhiteSpace(title) && aff == 0) return true;
            list.Add(new WinInfo { Title = title, Pid = pid, Affinity = aff });
            return true;
        }, IntPtr.Zero);
        return list;
    }
}
"@

$result = [ordered]@{
    captureExcludedWindows = @()
    processes              = @()
    audioDevices           = @()
    timestamp              = (Get-Date).ToString("o")
}

# ── 1. Capture-excluded windows (strongest signal) ──────────────────────────
try {
    $windows = [WinCapture]::GetWindows()
    foreach ($w in $windows) {
        # 0x11 = WDA_EXCLUDEFROMCAPTURE, 0x01 = WDA_MONITOR (also hides from capture)
        if ($w.Affinity -eq 0x11 -or $w.Affinity -eq 0x01) {
            $proc = $null
            try { $proc = Get-Process -Id $w.Pid -ErrorAction SilentlyContinue } catch {}
            # NOTE: `try` is a statement, not an expression, in Windows PowerShell 5.1 —
            # inlining it in a hash literal is a parse error there. Resolve it first.
            $procPath = $null
            if ($proc) { try { $procPath = $proc.Path } catch { $procPath = $null } }
            $result.captureExcludedWindows += [ordered]@{
                title       = $w.Title
                pid         = [int]$w.Pid
                affinity    = ("0x{0:X}" -f $w.Affinity)
                processName = if ($proc) { $proc.ProcessName } else { "unknown" }
                path        = $procPath
            }
        }
    }
} catch {}

# ── 2. Process list with Authenticode signer (name can be renamed → signer matters) ──
# Get-AuthenticodeSignature is by far the slowest call here (~0.5s each), and a
# tool like Cluely runs a dozen processes off ONE executable. Cache by path so
# each distinct binary is verified once — this is the difference between a scan
# that takes ~100s and one that takes a few seconds.
$signerCache = @{}
try {
    Get-Process | Where-Object { $_.MainWindowTitle -ne "" -or $_.Path } |
    Select-Object -First 200 | ForEach-Object {
        $signer = $null
        # Accessing .Path throws for protected/system processes — resolve before
        # building the hash literal (see note above re: PowerShell 5.1).
        $procPath = $null
        try { $procPath = $_.Path } catch { $procPath = $null }
        if ($procPath) {
            if ($signerCache.ContainsKey($procPath)) {
                $signer = $signerCache[$procPath]
            } else {
                try {
                    $sig = Get-AuthenticodeSignature -FilePath $procPath -ErrorAction SilentlyContinue
                    if ($sig -and $sig.SignerCertificate) { $signer = $sig.SignerCertificate.Subject }
                } catch {}
                $signerCache[$procPath] = $signer
            }
        }
        $result.processes += [ordered]@{
            name        = $_.ProcessName
            pid         = $_.Id
            windowTitle = $_.MainWindowTitle
            path        = $procPath
            signer      = $signer
        }
    }
} catch {}

# ── 3. Audio devices (virtual / loopback used by audio assistants) ──────────
try {
    Get-CimInstance Win32_SoundDevice -ErrorAction SilentlyContinue | ForEach-Object {
        $result.audioDevices += [ordered]@{ name = $_.Name; manufacturer = $_.Manufacturer }
    }
} catch {}

$result | ConvertTo-Json -Depth 5 -Compress
