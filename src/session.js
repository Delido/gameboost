// Game session helpers used by the Game Booster:
// - CPU topology of hybrid CPUs (P-/E-cores) for affinity rules
// - a session agent (detached PowerShell) that runs while the boost is active: holds a 0.5 ms
//   timer resolution, pins the game to the P-cores and records frame times with PresentMon
// - the FPS report (average, 1 % / 0.1 % lows, stutters, GPU-bound share) after the session
import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./state.js";

const CLI = fileURLToPath(new URL("../bin/gameboost.js", import.meta.url));

const TOOLS = join(DATA_DIR, "tools");
const SESSIONS = join(DATA_DIR, "sessions");
const PRESENTMON = join(TOOLS, "PresentMon.exe");
const POWERSHELL = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

// C# helpers: P-/E-core masks (GetSystemCpuSetInformation, processor group 0) and timer resolution.
export const CPU_PS = String.raw`
if (-not ('GBCpu' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GBCpu {
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetSystemCpuSetInformation(IntPtr info, uint len, out uint ret, IntPtr proc, uint flags);
  [DllImport("ntdll.dll")] public static extern int NtSetTimerResolution(uint desired, bool set, out uint current);
  [DllImport("ntdll.dll")] public static extern int NtQueryTimerResolution(out uint min, out uint max, out uint current);
  // { P-core mask, E-core mask } – both 0 on CPUs without different core types
  public static long[] Masks() {
    uint len;
    GetSystemCpuSetInformation(IntPtr.Zero, 0, out len, IntPtr.Zero, 0);
    if (len == 0) return new long[] { 0, 0 };
    IntPtr buf = Marshal.AllocHGlobal((int)len);
    try {
      if (!GetSystemCpuSetInformation(buf, len, out len, IntPtr.Zero, 0)) return new long[] { 0, 0 };
      int maxEff = -1, minEff = 256;
      for (int pass = 0; pass < 2; pass++) {
        long p = 0, e = 0;
        for (int off = 0; off < len; ) {
          int size = Marshal.ReadInt32(buf, off);
          if (size <= 0) break;
          int group = Marshal.ReadInt16(buf, off + 12);
          int lp = Marshal.ReadByte(buf, off + 14);
          int eff = Marshal.ReadByte(buf, off + 18);
          if (group == 0 && lp < 64) {
            if (pass == 0) { if (eff > maxEff) maxEff = eff; if (eff < minEff) minEff = eff; }
            else if (eff == maxEff) p |= 1L << lp; else e |= 1L << lp;
          }
          off += size;
        }
        if (pass == 1) return maxEff == minEff ? new long[] { 0, 0 } : new long[] { p, e };
      }
      return new long[] { 0, 0 };
    } finally { Marshal.FreeHGlobal(buf); }
  }
}
'@
}
function GB-BitCount([int64]$m) { $c = 0; while ($m -ne 0) { $c += $m -band 1; $m = $m -shr 1 }; return $c }
`;

// Runs detached for the whole boost session (stops when the flag file is deleted).
export const AGENT_PS = String.raw`
param([string]$InputFile)
$ErrorActionPreference = 'Continue'
$cfg = Get-Content -Raw -Encoding UTF8 -LiteralPath $InputFile | ConvertFrom-Json
` + CPU_PS + String.raw`
$status = @{ timerMs = $null; pinned = @(); presentMon = $false; finished = $false; error = $null }
function Save-Status { $status | ConvertTo-Json -Compress | Set-Content -LiteralPath $cfg.statusFile -Encoding UTF8 }

if ($cfg.timer) { $cur = [uint32]0; [void][GBCpu]::NtSetTimerResolution(5000, $true, [ref]$cur); $status.timerMs = $cur / 10000.0 }
$masks = [GBCpu]::Masks()
$pMask = if ($cfg.pCores -and $masks[0] -ne 0) { $masks[0] } else { 0 }
$name = if ($cfg.process) { [IO.Path]::GetFileNameWithoutExtension($cfg.process) } else { $null }
$pm = $null; $seen = @{}
Save-Status

while (Test-Path -LiteralPath $cfg.flagFile) {
  if ($name) {
    $procs = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
    $changed = $false
    foreach ($p in $procs) {
      if ($seen.ContainsKey($p.Id)) { continue }
      $seen[$p.Id] = $true; $changed = $true
      if ($pMask) { try { $p.ProcessorAffinity = [IntPtr]$pMask; $status.pinned += $p.Id } catch { $status.error = $_.Exception.Message } }
    }
    if ($procs.Count -and -not $pm -and $cfg.presentMon) {
      try {
        $pm = Start-Process -FilePath $cfg.presentMon -WindowStyle Hidden -PassThru -ArgumentList @('--process_name', $cfg.process, '--output_file', ('"' + $cfg.csv + '"'), '--no_console_stats', '--session_name', 'GameBoost', '--stop_existing_session', '--terminate_on_proc_exit')
        $status.presentMon = $true
      } catch { $status.error = "PresentMon: $($_.Exception.Message)" }
      $changed = $true
    }
    if ($changed) { Save-Status }
  }
  Start-Sleep -Seconds 2
}
# Session over: stop PresentMon cleanly so that the CSV is complete.
if ($pm -and -not $pm.HasExited) {
  Start-Process -FilePath $cfg.presentMon -ArgumentList @('--terminate_existing_session', '--session_name', 'GameBoost') -WindowStyle Hidden -Wait
  if (-not $pm.WaitForExit(5000)) { try { $pm.Kill() } catch {} }
}
$status.finished = $true
Save-Status
`;

/** Downloads PresentMon (Intel, MIT license) on first use and verifies its checksum. */
export async function ensurePresentMon() {
  if (existsSync(PRESENTMON)) return PRESENTMON;
  const r = await fetch("https://api.github.com/repos/GameTechDev/PresentMon/releases/latest", {
    headers: { "User-Agent": "GameBoost", Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`PresentMon-Download fehlgeschlagen (${r.status})`);
  const asset = (await r.json()).assets.find((a) => /^PresentMon-[\d.]+-x64\.exe$/i.test(a.name));
  if (!asset) throw new Error("PresentMon nicht im Release gefunden");
  const bin = Buffer.from(await (await fetch(asset.browser_download_url, { headers: { "User-Agent": "GameBoost" }, signal: AbortSignal.timeout(120000) })).arrayBuffer());
  const want = asset.digest?.replace(/^sha256:/, "");
  if (want && createHash("sha256").update(bin).digest("hex") !== want) throw new Error("PresentMon: Prüfsumme stimmt nicht");
  mkdirSync(TOOLS, { recursive: true });
  writeFileSync(PRESENTMON, bin);
  return PRESENTMON;
}

const files = (id) => ({ flagFile: join(SESSIONS, `${id}.active`), statusFile: join(SESSIONS, `${id}.status.json`), inputFile: join(SESSIONS, `${id}.json`), csv: join(SESSIONS, `${id}.csv`) });

/** Starts the detached session agent. Returns what it will do (for the session record). */
export function startAgent(id, { process: processName = null, timer = false, pCores = false, presentMon = null }) {
  if (!timer && !pCores && !presentMon) return null;
  mkdirSync(SESSIONS, { recursive: true });
  mkdirSync(TOOLS, { recursive: true });
  const f = files(id);
  const script = join(TOOLS, "session-agent.ps1");
  writeFileSync(script, "\uFEFF" + AGENT_PS, "utf8");
  writeFileSync(f.flagFile, "");
  writeFileSync(f.inputFile, JSON.stringify({ ...f, process: processName, timer, pCores, presentMon }), "utf8");
  // Detached via a small node process (`gameboost agent`): a detached powershell.exe does not start
  // reliably (it exits immediately when Windows hands its new console over to Windows Terminal).
  spawn(process.execPath, [CLI, "agent", f.inputFile], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  return { timer, pCores, capture: !!presentMon };
}

/** Body of `gameboost agent <inputFile>`: runs the PowerShell agent and waits for it. */
export function runAgent(inputFile) {
  const script = join(TOOLS, "session-agent.ps1");
  return new Promise((resolve) => {
    const c = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-InputFile", inputFile], { stdio: "ignore", windowsHide: true });
    c.on("exit", (code) => resolve({ exit: code }));
    c.on("error", (e) => resolve({ error: e.message }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ends the agent, waits for PresentMon to finish writing and returns the FPS report (or null). */
export async function stopAgent(id, processName) {
  const f = files(id);
  if (!existsSync(f.inputFile)) return { report: null };
  rmSync(f.flagFile, { force: true });
  let status = null;
  for (let i = 0; i < 30; i++) {
    try { status = JSON.parse(readFileSync(f.statusFile, "utf8").replace(/^\uFEFF/, "")); } catch {}
    if (status?.finished) break;
    await sleep(500);
  }
  let report = null;
  if (existsSync(f.csv)) {
    try { report = await analyzeCapture(f.csv, processName); } catch {}
  }
  for (const p of [f.csv, f.statusFile, f.inputFile]) rmSync(p, { force: true });
  return { report, status };
}

/** Frame time statistics of the busiest swap chain of the game in a PresentMon CSV. */
export async function analyzeCapture(csvFile, processName) {
  const rl = createInterface({ input: createReadStream(csvFile, "utf8"), crlfDelay: Infinity });
  let cols = null;
  const chains = new Map();
  const want = String(processName || "").toLowerCase();
  for await (const line of rl) {
    if (!line) continue;
    const v = line.split(",");
    if (!cols) {
      cols = Object.fromEntries(v.map((c, i) => [c.trim(), i]));
      continue;
    }
    if (want && v[cols.Application]?.toLowerCase() !== want) continue;
    const key = v[cols.SwapChainAddress] || "0";
    let c = chains.get(key);
    if (!c) chains.set(key, (c = { ft: [], gpuBound: 0, gpu: 0, modes: new Map(), lastStart: null }));
    // Frame time: MsBetweenPresents (1.x and current 2.x), FrameTime (early 2.x) or start-time deltas
    let ft = parseFloat(v[cols.MsBetweenPresents ?? cols.FrameTime]);
    if (cols.MsBetweenPresents === undefined && cols.FrameTime === undefined) {
      const start = parseFloat(v[cols.CPUStartTime ?? cols.TimeInSeconds]) * (cols.TimeInSeconds !== undefined && cols.CPUStartTime === undefined ? 1000 : 1);
      ft = c.lastStart === null ? NaN : start - c.lastStart;
      c.lastStart = start;
    }
    if (!(ft > 0) || ft > 5000) continue;
    c.ft.push(ft);
    const gpuBusy = parseFloat(v[cols.MsGPUBusy ?? cols.GPUBusy]);
    if (gpuBusy > 0) { c.gpu++; if (gpuBusy >= ft * 0.9) c.gpuBound++; }
    const mode = v[cols.PresentMode];
    if (mode) c.modes.set(mode, (c.modes.get(mode) || 0) + 1);
  }
  const best = [...chains.values()].sort((a, b) => b.ft.length - a.ft.length)[0];
  if (!best || best.ft.length < 60) return null;
  const ft = Float64Array.from(best.ft);
  const total = ft.reduce((a, b) => a + b, 0);
  const sorted = Float64Array.from(ft).sort();
  const n = sorted.length;
  const median = sorted[Math.floor(n / 2)];
  const lowFps = (share) => {
    const k = Math.max(1, Math.floor(n * share));
    let s = 0;
    for (let i = n - k; i < n; i++) s += sorted[i];
    return 1000 / (s / k);
  };
  const stutterLimit = Math.max(median * 2.5, 1000 / 60);
  let stutters = 0;
  for (const x of ft) if (x > stutterLimit) stutters++;
  const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
  return {
    frames: n,
    seconds: Math.round(total / 1000),
    avgFps: round((n * 1000) / total),
    low1: round(lowFps(0.01)),
    low01: round(lowFps(0.001)),
    p99Ms: round(sorted[Math.min(n - 1, Math.floor(n * 0.99))], 2),
    maxMs: round(sorted[n - 1], 1),
    stutters,
    gpuBoundPct: best.gpu ? Math.round((best.gpuBound / best.gpu) * 100) : null,
    presentMode: [...best.modes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
  };
}
