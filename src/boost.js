// Game Booster session: temporarily switches to the GameBoost power plan, stops background
// services, closes distracting apps, frees RAM, mutes notifications and moves background apps to
// the E-cores. A session agent (session.js) holds the timer resolution, pins the game to the
// P-cores and records frame times. `stop` restores everything and returns an FPS report.
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { runPS } from "./ps.js";
import { STANDBY_PS } from "./actions.js";
import { ULTIMATE_PLAN_PS } from "./catalog.js";
import { CPU_PS, ensurePresentMon, startAgent, stopAgent } from "./session.js";
import { loadState, updateState, logHistory } from "./state.js";
import { isAdmin } from "./system.js";

const PUSH = String.raw`Software\Microsoft\Windows\CurrentVersion\PushNotifications`;

export const START_PS = STANDBY_PS + ULTIMATE_PLAN_PS + CPU_PS + String.raw`
$cfg = $GB_IN.config
$res = @{ stoppedServices = @(); killed = @(); prevScheme = $null; ramFreed = 0; errors = @(); toast = $null; affinity = @(); hybrid = $false }
if ($cfg.powerPlan) {
  $res.prevScheme = GB-ActiveScheme
  try { $g = GB-EnsurePlan; powercfg /setactive $g | Out-Null } catch { $res.errors += $_.Exception.Message }
}
foreach ($s in @($cfg.services)) {
  $svc = Get-Service -Name $s -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -eq 'Running') {
    try { Stop-Service -Name $s -Force -ErrorAction Stop -WarningAction SilentlyContinue; $res.stoppedServices += $s }
    catch { $res.errors += "$($s): $($_.Exception.Message)" }
  }
}
foreach ($p in @($cfg.processes)) {
  $n = [IO.Path]::GetFileNameWithoutExtension($p)
  $procs = @(Get-Process -Name $n -ErrorAction SilentlyContinue)
  if ($procs.Count -gt 0) {
    $path = ($procs | Where-Object { $_.Path } | Select-Object -First 1).Path
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    $res.killed += @{ name = $p; path = $path }
  }
}
if ($cfg.clearStandby) { try { $res.ramFreed = GB-PurgeStandby } catch { $res.errors += $_.Exception.Message } }
if ($cfg.flushDns) { ipconfig /flushdns | Out-Null }
if ($cfg.dnd) {
  # Notifications master switch (Settings > System > Notifications), restored afterwards
  $res.toast = GB-RegGet 'HKCU' '${PUSH}' 'ToastEnabled'
  GB-RegSet 'HKCU' '${PUSH}' 'ToastEnabled' 'DWord' 0
}
if ($cfg.pCores) {
  $masks = [GBCpu]::Masks()
  if ($masks[1] -ne 0) {
    $res.hybrid = $true
    foreach ($p in @($cfg.ecoreProcesses)) {
      foreach ($proc in @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($p)) -ErrorAction SilentlyContinue)) {
        try { $orig = [int64]$proc.ProcessorAffinity; $proc.ProcessorAffinity = [IntPtr]$masks[1]; $res.affinity += @{ pid = $proc.Id; name = $proc.ProcessName; mask = $orig } } catch {}
      }
    }
  }
}
GB-Out $res
`;

export const STOP_PS = String.raw`
$s = $GB_IN.session
$res = @{ restartedServices = @(); restartedApps = @(); errors = @() }
if ($s.prevScheme) { powercfg /setactive $s.prevScheme | Out-Null }
foreach ($n in @($s.stoppedServices)) {
  try { Start-Service -Name $n -ErrorAction Stop -WarningAction SilentlyContinue; $res.restartedServices += $n } catch { }
}
if ($GB_IN.restartApps) {
  foreach ($k in @($s.killed)) {
    if (-not $k.path -or -not (Test-Path -LiteralPath $k.path)) { continue }
    $n = [IO.Path]::GetFileNameWithoutExtension($k.name)
    if (Get-Process -Name $n -ErrorAction SilentlyContinue) { continue }
    # explorer.exe starts the app with normal (non-elevated) rights
    Start-Process explorer.exe -ArgumentList ('"' + $k.path + '"')
    $res.restartedApps += $k.name
  }
}
if ($s.toast) {
  if ($s.toast.exists) { GB-RegSet 'HKCU' '${PUSH}' 'ToastEnabled' $s.toast.kind $s.toast.value } else { GB-RegDel 'HKCU' '${PUSH}' 'ToastEnabled' }
}
foreach ($a in @($s.affinity)) {
  $proc = Get-Process -Id $a.pid -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -eq $a.name) { try { $proc.ProcessorAffinity = [IntPtr][int64]$a.mask } catch {} }
}
GB-Out $res
`;

export function sessionStatus() {
  return loadState().session;
}

export async function startBoost({ gameId = null, watchProcess = null, auto = false } = {}) {
  const state = loadState();
  if (state.session) return { alreadyActive: true, session: state.session };
  const cfg = state.config.boost;
  const r = await runPS(START_PS, { config: cfg });
  const errors = r.errors || [];
  const id = randomBytes(5).toString("hex");
  // FPS capture needs the game's exe name and administrator rights (ETW).
  let presentMon = null;
  if (cfg.fpsCapture && watchProcess && (await isAdmin())) {
    try { presentMon = await ensurePresentMon(); } catch (e) { errors.push(`FPS-Messung nicht verfügbar: ${e.message}`); }
  }
  const agent = startAgent(id, { process: watchProcess, timer: !!cfg.timerResolution, pCores: !!cfg.pCores && r.hybrid, presentMon });
  const session = {
    id,
    startedAt: new Date().toISOString(),
    prevScheme: r.prevScheme,
    stoppedServices: r.stoppedServices || [],
    killed: r.killed || [],
    ramFreed: r.ramFreed || 0,
    gameId,
    watchProcess,
    auto,
    toast: r.toast,
    affinity: r.affinity || [],
    agent,
  };
  updateState((s) => {
    s.session = session;
    logHistory(s, { action: "boost-start", gameId, game: s.games.find((g) => g.id === gameId)?.name, auto });
  });
  return { alreadyActive: false, session, errors };
}

export async function stopBoost() {
  const state = loadState();
  if (!state.session) return { wasActive: false };
  const session = state.session;
  // Mark the session as ended first so that watchers/agents stop, then restore the system.
  updateState((s) => { s.session = null; });
  const { report } = session.agent && session.id ? await stopAgent(session.id, session.watchProcess) : { report: null };
  const r = await runPS(STOP_PS, { session, restartApps: state.config.boost.restartProcesses });
  const duration = Math.round((Date.now() - new Date(session.startedAt).getTime()) / 60000);
  const game = state.games.find((g) => g.id === session.gameId);
  const entry = report && {
    id: session.id, at: new Date().toISOString(), startedAt: session.startedAt, minutes: duration,
    game: game?.name || session.watchProcess, gameId: session.gameId, process: session.watchProcess,
    pCores: !!session.agent?.pCores, timer: !!session.agent?.timer, ...report,
  };
  updateState((s) => {
    if (entry) s.sessions = [entry, ...s.sessions].slice(0, 100);
    logHistory(s, { action: "boost-stop", minutes: duration, game: entry?.game, fps: entry ? `Ø ${entry.avgFps} FPS · 1 % ${entry.low1}` : undefined });
  });
  return { wasActive: true, minutes: duration, report: entry || null, ...r };
}

/** Spawn a detached watcher that ends the boost session when the game process exits. */
export function spawnWatcher(processName) {
  const cli = fileURLToPath(new URL("../bin/gameboost.js", import.meta.url));
  const child = spawn(process.execPath, [cli, "watch", processName], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function isRunning(processName) {
  return new Promise((resolve) => {
    execFile("tasklist", ["/FI", `IMAGENAME eq ${processName}`, "/NH", "/FO", "CSV"], { windowsHide: true }, (err, out) => {
      resolve(!err && out.toLowerCase().includes(`"${processName.toLowerCase()}"`));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Blocking: waits for the process to appear (max 5 min), then for it to exit, then stops the boost. */
export async function watch(processName) {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (!(await isRunning(processName))) {
    if (Date.now() > deadline || !loadState().session) return { stopped: false, reason: "Prozess nicht gestartet" };
    await sleep(3000);
  }
  let missing = 0;
  while (missing < 3) {
    await sleep(5000);
    if (!loadState().session) return { stopped: false, reason: "Session bereits beendet" };
    missing = (await isRunning(processName)) ? 0 : missing + 1;
  }
  const s = loadState().session;
  if (!s || s.watchProcess?.toLowerCase() !== processName.toLowerCase()) return { stopped: false, reason: "Andere Session aktiv" };
  return { stopped: true, ...(await stopBoost()) };
}
