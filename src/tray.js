// Tray icon (Windows Forms NotifyIcon in an STA PowerShell): toggle the boost, launch games, run
// the 1-click maintenance, see available updates and get the FPS report after each session.
// Started at logon by a scheduled task with highest privileges, so actions need no UAC prompt.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR, updateState, logHistory } from "./state.js";
import { registerTask, unregisterTask, getTasks, TASKS } from "./schedule.js";

const CLI = fileURLToPath(new URL("../bin/gameboost.js", import.meta.url));
const ICON = fileURLToPath(new URL("../ui/icon.ico", import.meta.url));
const PKG = fileURLToPath(new URL("../package.json", import.meta.url));
const PID_FILE = join(DATA_DIR, "tray.pid");
const POWERSHELL = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

export const TRAY_PS = String.raw`
param([string]$Node, [string]$Cli, [string]$DataDir, [string]$Icon, [string]$Version)
$ErrorActionPreference = 'Continue'
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\GameBoostTray', [ref]$created)
if (-not $created) { return }
Set-Content -LiteralPath (Join-Path $DataDir 'tray.pid') -Value $PID
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$stateFile = Join-Path $DataDir 'state.json'
function Read-State { try { return Get-Content -Raw -Encoding UTF8 -LiteralPath $stateFile | ConvertFrom-Json } catch { return $null } }
function Run-Cli([string[]]$cliArgs) {
  $argLine = (@($Cli) + $cliArgs | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
  Start-Process -FilePath $Node -ArgumentList $argLine -WindowStyle Hidden
}

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = New-Object System.Drawing.Icon($Icon)
$tray.Text = 'GameBoost'
$tray.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip

$open = $menu.Items.Add('GameBoost öffnen')
$open.Font = New-Object System.Drawing.Font($open.Font, [System.Drawing.FontStyle]::Bold)
$open.add_Click({ Run-Cli @('ui') })
$tray.add_MouseDoubleClick({ Run-Cli @('ui') })
$boost = $menu.Items.Add('Game Boost starten')
$boost.add_Click({ Run-Cli @('boost', 'toggle') })
$games = New-Object System.Windows.Forms.ToolStripMenuItem('Spielen mit Boost')
[void]$menu.Items.Add($games)
$clean = $menu.Items.Add('1-Klick-Wartung')
$clean.add_Click({ Run-Cli @('run', 'quick-clean'); $tray.ShowBalloonTip(3000, 'GameBoost', '1-Klick-Wartung läuft …', [System.Windows.Forms.ToolTipIcon]::Info) })
$update = $menu.Items.Add('Update verfügbar')
$update.Visible = $false
$update.add_Click({ Run-Cli @('ui') })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$quit = $menu.Items.Add('Tray-Symbol beenden')
$quit.add_Click({ $tray.Visible = $false; [System.Windows.Forms.Application]::Exit() })
$tray.ContextMenuStrip = $menu

$script:lastActive = $null
$script:lastReport = $null
$script:gamesKey = ''
function Refresh {
  $s = Read-State
  if (-not $s) { return }
  $active = $null -ne $s.session
  $boost.Text = if ($active) { 'Game Boost beenden' } else { 'Game Boost starten' }
  $tray.Text = if ($active) { 'GameBoost – Boost aktiv' } else { 'GameBoost' }
  if ($null -ne $script:lastActive -and $active -and -not $script:lastActive) {
    $tray.ShowBalloonTip(3000, 'Game Boost aktiv', 'Dienste pausiert, Apps beendet, RAM freigegeben.', [System.Windows.Forms.ToolTipIcon]::Info)
  }
  $script:lastActive = $active
  # FPS report of the session that just ended
  $r = @($s.sessions)[0]
  if ($r -and $r.id -ne $script:lastReport) {
    if ($null -ne $script:lastReport) {
      $tray.ShowBalloonTip(8000, "$($r.game): Ø $($r.avgFps) FPS", "1 % Low $($r.low1) FPS · 0,1 % Low $($r.low01) · $($r.stutters) Ruckler · $($r.minutes) min", [System.Windows.Forms.ToolTipIcon]::Info)
    }
    $script:lastReport = $r.id
  }
  if ($null -eq $script:lastReport) { $script:lastReport = '' }
  $latest = $s.update.latest.version
  $newer = $false; try { $newer = $latest -and ([version]$latest -gt [version]$Version) } catch {}
  if ($newer) { $update.Text = "Update auf $latest verfügbar"; $update.Visible = $true } else { $update.Visible = $false }
  $key = (@($s.games) | ForEach-Object { $_.id }) -join ','
  if ($key -ne $script:gamesKey) {
    $script:gamesKey = $key
    $games.DropDownItems.Clear()
    foreach ($g in @($s.games | Sort-Object { $_.lastPlayed } -Descending)) {
      $item = $games.DropDownItems.Add($g.name)
      $item.Tag = $g.id
      $item.add_Click({ param($sender) Run-Cli @('games', 'launch', [string]$sender.Tag) })
    }
    $games.Enabled = $games.DropDownItems.Count -gt 0
  }
}
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({ Refresh })
$timer.Start()
Refresh
[System.Windows.Forms.Application]::Run()
$tray.Dispose()
Remove-Item -LiteralPath (Join-Path $DataDir 'tray.pid') -Force -ErrorAction SilentlyContinue
`;

function version() {
  return JSON.parse(readFileSync(PKG, "utf8")).version;
}

/** `gameboost tray run`: shows the icon and blocks until it is closed. */
export function runTray() {
  mkdirSync(join(DATA_DIR, "tools"), { recursive: true });
  const script = join(DATA_DIR, "tools", "tray.ps1");
  writeFileSync(script, "\uFEFF" + TRAY_PS, "utf8");
  return new Promise((resolve) => {
    const c = spawn(POWERSHELL, ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", script, "-Node", process.execPath, "-Cli", CLI, "-DataDir", DATA_DIR, "-Icon", ICON, "-Version", version()], { stdio: "ignore", windowsHide: true });
    c.on("exit", (code) => resolve({ exit: code }));
    c.on("error", (e) => resolve({ error: e.message }));
  });
}

/** Starts the tray icon in the background (detached node → attached PowerShell, see session.js). */
export function startTray() {
  spawn(process.execPath, [CLI, "tray", "run"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  return { started: true };
}

function trayPid() {
  try {
    const pid = Number(readFileSync(PID_FILE, "utf8"));
    if (pid) { process.kill(pid, 0); return pid; }
  } catch {}
  return null;
}

export async function trayStatus() {
  const task = (await getTasks())[TASKS.tray] || null;
  return { autostart: !!task, running: !!trayPid() };
}

export async function enableTray() {
  await registerTask({ name: TASKS.tray, args: "tray run", schedule: "logon", description: "GameBoost: Tray-Symbol (Boost umschalten, Spiele starten, FPS-Berichte)." });
  if (!trayPid()) startTray();
  updateState((s) => logHistory(s, { action: "tray", name: "Mit Windows starten: an" }));
  return trayStatus();
}

export async function disableTray() {
  await unregisterTask(TASKS.tray);
  const pid = trayPid();
  if (pid) try { process.kill(pid); } catch {}
  updateState((s) => logHistory(s, { action: "tray", name: "Mit Windows starten: aus" }));
  return trayStatus();
}
