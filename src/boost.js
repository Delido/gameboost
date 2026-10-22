// Game Booster session: temporarily switches to the GameBoost power plan, stops background
// services, closes distracting apps and frees RAM. `stop` restores everything.
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runPS } from "./ps.js";
import { STANDBY_PS } from "./actions.js";
import { ULTIMATE_PLAN_PS } from "./catalog.js";
import { loadState, updateState, logHistory } from "./state.js";

export const START_PS = STANDBY_PS + ULTIMATE_PLAN_PS + String.raw`
$cfg = $GB_IN.config
$res = @{ stoppedServices = @(); killed = @(); prevScheme = $null; ramFreed = 0; errors = @() }
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
GB-Out $res
`;

export function sessionStatus() {
  return loadState().session;
}

export async function startBoost({ gameId = null, watchProcess = null, auto = false } = {}) {
  const state = loadState();
  if (state.session) return { alreadyActive: true, session: state.session };
  const r = await runPS(START_PS, { config: state.config.boost });
  const session = {
    startedAt: new Date().toISOString(),
    prevScheme: r.prevScheme,
    stoppedServices: r.stoppedServices || [],
    killed: r.killed || [],
    ramFreed: r.ramFreed || 0,
    gameId,
    watchProcess,
    auto,
  };
  updateState((s) => {
    s.session = session;
    logHistory(s, { action: "boost-start", gameId, game: s.games.find((g) => g.id === gameId)?.name, auto });
  });
  return { alreadyActive: false, session, errors: r.errors || [] };
}

export async function stopBoost() {
  const state = loadState();
  if (!state.session) return { wasActive: false };
  const r = await runPS(STOP_PS, { session: state.session, restartApps: state.config.boost.restartProcesses });
  const duration = Math.round((Date.now() - new Date(state.session.startedAt).getTime()) / 60000);
  updateState((s) => {
    s.session = null;
    logHistory(s, { action: "boost-stop", minutes: duration });
  });
  return { wasActive: true, minutes: duration, ...r };
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
