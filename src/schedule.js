// Scheduled tasks created by GameBoost (folder \GameBoost\ in Task Scheduler):
// - "Wartung": runs the 1-click maintenance daily/weekly
// - "Auto-Boost": background watcher started at logon (see autoboost.js)
import { fileURLToPath } from "node:url";
import { runPS } from "./ps.js";
import { updateState, logHistory } from "./state.js";

const CLI = fileURLToPath(new URL("../bin/gameboost.js", import.meta.url));
const TASK_PATH = "\\GameBoost\\";

export const SCHEDULE_PS = String.raw`
$tp = $GB_IN.taskPath
switch ($GB_IN.mode) {
  'get' {
    $res = @{}
    foreach ($n in $GB_IN.names) {
      $t = Get-ScheduledTask -TaskPath $tp -TaskName $n -ErrorAction SilentlyContinue
      if (-not $t) { $res[$n] = $null; continue }
      $info = $t | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
      $trig = @($t.Triggers)[0]
      $kind = if ($trig.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger') { 'logon' } elseif ($trig.DaysOfWeek) { 'weekly' } else { 'daily' }
      $res[$n] = @{ state = [string]$t.State; schedule = $kind; lastRun = if ($info.LastRunTime -and $info.LastRunTime.Year -gt 2000) { $info.LastRunTime.ToString('o') } else { $null }; nextRun = if ($info.NextRunTime) { $info.NextRunTime.ToString('o') } else { $null } }
    }
    GB-Out $res
  }
  'register' {
    $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument ('--headless "' + $GB_IN.node + '" "' + $GB_IN.cli + '" ' + $GB_IN.args) -WorkingDirectory (Split-Path -Parent (Split-Path -Parent $GB_IN.cli))
    $user = "$env:USERDOMAIN\$env:USERNAME"
    $trigger = switch ($GB_IN.schedule) {
      'logon' { New-ScheduledTaskTrigger -AtLogOn -User $user }
      'daily' { New-ScheduledTaskTrigger -Daily -At '12:00' }
      default { New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At '12:00' }
    }
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
    $limit = if ($GB_IN.schedule -eq 'logon') { [TimeSpan]::Zero } else { New-TimeSpan -Hours 1 }
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit $limit
    Register-ScheduledTask -TaskPath $tp -TaskName $GB_IN.name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $GB_IN.description -Force | Out-Null
    if ($GB_IN.startNow) { Start-ScheduledTask -TaskPath $tp -TaskName $GB_IN.name }
    GB-Out @{ ok = $true }
  }
  'unregister' {
    if (Get-ScheduledTask -TaskPath $tp -TaskName $GB_IN.name -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskPath $tp -TaskName $GB_IN.name -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskPath $tp -TaskName $GB_IN.name -Confirm:$false
    }
    GB-Out @{ ok = $true }
  }
}
`;

export const TASKS = { maintenance: "Wartung", autoboost: "Auto-Boost", tray: "Tray" };

export async function getTasks() {
  return (await runPS(SCHEDULE_PS, { mode: "get", taskPath: TASK_PATH, names: Object.values(TASKS) })) || {};
}

export async function registerTask({ name, args, schedule, description, startNow = false }) {
  await runPS(SCHEDULE_PS, { mode: "register", taskPath: TASK_PATH, name, args, schedule, description, startNow, node: process.execPath, cli: CLI });
}

export async function unregisterTask(name) {
  await runPS(SCHEDULE_PS, { mode: "unregister", taskPath: TASK_PATH, name });
}

/** schedule: daily | weekly | off */
export async function setMaintenanceSchedule(schedule) {
  if (!["daily", "weekly", "off"].includes(schedule)) throw new Error("Zeitplan muss daily, weekly oder off sein");
  if (schedule === "off") await unregisterTask(TASKS.maintenance);
  else await registerTask({ name: TASKS.maintenance, args: "run quick-clean", schedule, description: "GameBoost: 1-Klick-Wartung (Temp, Papierkorb, DNS, Standby-RAM)" });
  updateState((s) => logHistory(s, { action: "schedule", name: { daily: "Täglich 12:00", weekly: "Sonntags 12:00", off: "Aus" }[schedule] }));
  return { schedule };
}
