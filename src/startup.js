// Autostart management: Run/RunOnce keys, startup folders, scheduled tasks (logon/boot),
// Store app startup tasks and third-party services. Toggling works like Task Manager
// (StartupApproved); deleted entries are backed up and can be restored.
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { runPS } from "./ps.js";
import { loadState, updateState, logHistory, DATA_DIR } from "./state.js";

const BACKUP_DIR = join(DATA_DIR, "startup-backup");

export const STARTUP_PS = String.raw`
$approvedBase = 'Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved'
$runSources = @(
  @{ hive = 'HKCU'; key = 'Software\Microsoft\Windows\CurrentVersion\Run'; approved = 'Run'; scope = 'Benutzer'; type = 'run' },
  @{ hive = 'HKLM'; key = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Run'; approved = 'Run'; scope = 'Alle Benutzer'; type = 'run' },
  @{ hive = 'HKLM'; key = 'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run'; approved = 'Run32'; scope = 'Alle Benutzer'; type = 'run' },
  @{ hive = 'HKCU'; key = 'Software\Microsoft\Windows\CurrentVersion\RunOnce'; approved = 'RunOnce'; scope = 'Benutzer (einmalig)'; type = 'runonce' },
  @{ hive = 'HKLM'; key = 'SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce'; approved = 'RunOnce'; scope = 'Alle Benutzer (einmalig)'; type = 'runonce' },
  @{ hive = 'HKLM'; key = 'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\RunOnce'; approved = 'RunOnce32'; scope = 'Alle Benutzer (einmalig)'; type = 'runonce' }
)
$appxBase = 'Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\SystemAppData'

function GB-Approved($hive, $sub, $name) {
  $v = GB-RegGet $hive "$approvedBase\$sub" $name
  if (-not $v.exists) { return $true }
  $b = [Convert]::FromBase64String($v.value)
  return ($b[0] % 2) -eq 0
}
function GB-SetApproved($hive, $sub, $name, [bool]$enabled) {
  $bytes = New-Object byte[] 12
  $bytes[0] = if ($enabled) { 2 } else { 3 }
  if (-not $enabled) { [BitConverter]::GetBytes([DateTime]::Now.ToFileTime()).CopyTo($bytes, 4) }
  GB-RegSet $hive "$approvedBase\$sub" $name 'Binary' ([Convert]::ToBase64String($bytes))
}
function GB-StartupFolder($hive) {
  if ($hive -eq 'HKLM') { return [Environment]::GetFolderPath('CommonStartup') }
  return [Environment]::GetFolderPath('Startup')
}

# Executable of a command line ("C:\x y\a.exe" -arg, C:\x\a.exe /s, rundll32 x.dll,Entry).
function GB-ExeFromCommand([string]$cmd) {
  if (-not $cmd) { return $null }
  $c = [Environment]::ExpandEnvironmentVariables($cmd.Trim())
  if ($c.StartsWith('"')) {
    $end = $c.IndexOf('"', 1)
    $p = if ($end -gt 1) { $c.Substring(1, $end - 1) } else { $c.Trim('"') }
  } elseif ($c -match '^(.+?\.(exe|com|bat|cmd|vbs|js|ps1|lnk|msc|scr))(\s|,|$)') { $p = $Matches[1] }
  else { $p = ($c -split '\s+')[0] }
  try { $rooted = [IO.Path]::IsPathRooted($p) } catch { return $null }
  if (-not $rooted) {
    $found = Get-Command $p -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.Source }
    return $null
  }
  return $p
}

$GB_PUBLISHER = @{}
function GB-FileInfo([string]$path) {
  $r = @{ path = $path; exists = $null; publisher = '' }
  if (-not $path) { return $r }
  try { $r.exists = [bool](Test-Path -LiteralPath $path -PathType Leaf) } catch { $r.exists = $null; return $r }
  if ($r.exists) {
    if (-not $GB_PUBLISHER.ContainsKey($path)) {
      $pub = ''
      try { $pub = [string]([Diagnostics.FileVersionInfo]::GetVersionInfo($path).CompanyName) } catch {}
      $GB_PUBLISHER[$path] = $pub.Trim()
    }
    $r.publisher = $GB_PUBLISHER[$path]
  }
  return $r
}

function GB-Item($id, $type, $name, $command, $scope, $enabled, $admin, $canToggle, $canDelete, $exe) {
  $fi = GB-FileInfo $exe
  return @{
    id = $id; type = $type; name = $name; command = $command; scope = $scope; enabled = [bool]$enabled
    admin = [bool]$admin; canToggle = [bool]$canToggle; canDelete = [bool]$canDelete
    publisher = $fi.publisher; path = $fi.path; broken = ($fi.exists -eq $false)
  }
}

function GB-ListStartup {
  $items = @()
  foreach ($s in $runSources) {
    $k = (GB-Hive $s.hive).OpenSubKey($s.key)
    if (-not $k) { continue }
    foreach ($n in $k.GetValueNames()) {
      if (-not $n) { continue }
      $cmd = [string]$k.GetValue($n)
      $isRun = $s.type -eq 'run'
      $enabled = if ($isRun) { GB-Approved $s.hive $s.approved $n } else { $true }
      $items += GB-Item "$($s.hive)|$($s.approved)|$n" $s.type $n $cmd $s.scope $enabled ($s.hive -eq 'HKLM') $isRun $true (GB-ExeFromCommand $cmd)
    }
    $k.Close()
  }

  $sh = New-Object -ComObject WScript.Shell
  foreach ($hive in 'HKCU', 'HKLM') {
    $dir = GB-StartupFolder $hive
    if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
    $scope = if ($hive -eq 'HKLM') { 'Alle Benutzer (Ordner)' } else { 'Benutzer (Ordner)' }
    foreach ($file in Get-ChildItem -LiteralPath $dir -File -Force | Where-Object { $_.Name -ne 'desktop.ini' }) {
      $exe = $file.FullName; $cmd = $file.FullName
      if ($file.Extension -eq '.lnk') {
        try {
          $lnk = $sh.CreateShortcut($file.FullName)
          $exe = if ($lnk.TargetPath) { $lnk.TargetPath } else { $null }
          if ($lnk.TargetPath) { $cmd = ('"' + $lnk.TargetPath + '" ' + $lnk.Arguments).Trim() }
        } catch { $exe = $null }
      }
      $items += GB-Item "$hive|StartupFolder|$($file.Name)" 'folder' $file.BaseName $cmd $scope (GB-Approved $hive 'StartupFolder' $file.Name) ($hive -eq 'HKLM') $true $true $exe
    }
  }

  # Scheduled tasks of third-party software that start at logon or boot (updaters, helpers).
  $tasks = @()
  try { $tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskPath -notlike '\Microsoft\*' -and $_.TaskPath -notlike '\GameBoost\*' }) } catch {}
  foreach ($t in $tasks) {
    $trig = @($t.Triggers | Where-Object { $_ -and @('MSFT_TaskLogonTrigger', 'MSFT_TaskBootTrigger') -contains $_.CimClass.CimClassName })
    if ($trig.Count -eq 0) { continue }
    $a = @($t.Actions | Where-Object { $_.Execute }) | Select-Object -First 1
    $exe = if ($a) { [Environment]::ExpandEnvironmentVariables($a.Execute.Trim('"')) } else { $null }
    $cmd = if ($a) { ('"' + $exe + '" ' + $a.Arguments).Trim() } else { '(keine Programmaktion)' }
    $scope = if (@($trig | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger' }).Count) { 'Aufgabe (Systemstart)' } else { 'Aufgabe (Anmeldung)' }
    $items += GB-Item "TASK|$($t.TaskPath)$($t.TaskName)" 'task' $t.TaskName $cmd $scope ($t.State -ne 'Disabled') $true $true $true $exe
  }

  # Store apps (same switch as in Settings > Apps > Autostart).
  $root = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($appxBase)
  if ($root) {
    $pkgs = $null
    foreach ($fam in $root.GetSubKeyNames()) {
      $fk = $root.OpenSubKey($fam)
      if (-not $fk) { continue }
      foreach ($tid in $fk.GetSubKeyNames()) {
        $tk = $fk.OpenSubKey($tid)
        if (-not $tk) { continue }
        $st = $tk.GetValue('State'); $tk.Close()
        if ($null -eq $st -or $st -isnot [int]) { continue }
        if ($null -eq $pkgs) { $pkgs = @{}; foreach ($p in Get-AppxPackage) { $pkgs[$p.PackageFamilyName] = $p } }
        $pkg = $pkgs[$fam]
        if (-not $pkg) { continue }
        $name = $pkg.Name
        try {
          $dn = [string](Get-AppxPackageManifest $pkg).Package.Properties.DisplayName
          if ($dn -and $dn -notlike 'ms-resource*') { $name = $dn }
        } catch {}
        $pub = if ($pkg.Publisher -match 'CN=([^,]+)') { $Matches[1].Trim('"') } else { '' }
        $items += @{
          id = "APPX|$fam\$tid"; type = 'appx'; name = $name; command = "$($pkg.PackageFamilyName) ($tid)"; scope = 'Store-App'
          enabled = ($st -eq 2 -or $st -eq 4); admin = $false; canToggle = ($st -le 2); canDelete = $false
          publisher = $pub; path = $pkg.InstallLocation; broken = $false
        }
      }
      $fk.Close()
    }
    $root.Close()
  }

  # Third-party services that start automatically (and ones GameBoost switched to manual).
  $tracked = @($GB_IN.services)
  foreach ($s in Get-CimInstance Win32_Service) {
    $isTracked = $tracked -contains $s.Name
    if ($s.StartMode -ne 'Auto' -and -not $isTracked) { continue }
    $exe = GB-ExeFromCommand $s.PathName
    if (-not $exe) { continue }
    $fi = GB-FileInfo $exe
    if ($fi.publisher -match 'Microsoft' -or (-not $fi.publisher -and $exe -like "$env:SystemRoot\*")) { continue }
    $items += GB-Item "SVC|$($s.Name)" 'service' $s.DisplayName $s.PathName 'Dienst' ($s.StartMode -eq 'Auto') $true $true $false $exe
  }
  return $items
}

function GB-ParseId([string]$id) {
  $p = $id.Split('|', 3)
  if ($p[0] -eq 'TASK') {
    $full = $id.Substring(5); $i = $full.LastIndexOf('\')
    return @{ kind = 'task'; taskPath = $full.Substring(0, $i + 1); taskName = $full.Substring($i + 1) }
  }
  if ($p[0] -eq 'APPX') { return @{ kind = 'appx'; key = "$appxBase\$($id.Substring(5))" } }
  if ($p[0] -eq 'SVC') { return @{ kind = 'service'; name = $id.Substring(4) } }
  if ($p.Count -lt 3) { throw "Ungültiger Autostart-Eintrag: $id" }
  if ($p[1] -eq 'StartupFolder') { return @{ kind = 'folder'; hive = $p[0]; name = $p[2]; path = Join-Path (GB-StartupFolder $p[0]) $p[2] } }
  $src = $runSources | Where-Object { $_.hive -eq $p[0] -and $_.approved -eq $p[1] } | Select-Object -First 1
  if (-not $src) { throw "Ungültiger Autostart-Eintrag: $id" }
  return @{ kind = 'reg'; hive = $p[0]; key = $src.key; approved = $p[1]; name = $p[2]; toggle = ($src.type -eq 'run') }
}

switch ($GB_IN.mode) {
  'list' { GB-Out @{ items = @(GB-ListStartup) } }
  'set' {
    $e = [bool]$GB_IN.enabled
    $t = GB-ParseId $GB_IN.id
    switch ($t.kind) {
      'reg' { if (-not $t.toggle) { throw 'Einmalige Einträge (RunOnce) können nur gelöscht werden.' }; GB-SetApproved $t.hive $t.approved $t.name $e }
      'folder' { GB-SetApproved $t.hive 'StartupFolder' $t.name $e }
      'task' { if ($e) { Enable-ScheduledTask -TaskPath $t.taskPath -TaskName $t.taskName | Out-Null } else { Disable-ScheduledTask -TaskPath $t.taskPath -TaskName $t.taskName | Out-Null } }
      'appx' { GB-RegSet 'HKCU' $t.key 'State' 'DWord' $(if ($e) { 2 } else { 1 }) }
      'service' { GB-RegSet 'HKLM' "SYSTEM\CurrentControlSet\Services\$($t.name)" 'Start' 'DWord' $(if ($e) { 2 } else { 3 }) }
    }
    GB-Out @{ ok = $true }
  }
  'delete' {
    $t = GB-ParseId $GB_IN.id
    $b = $null
    switch ($t.kind) {
      'reg' {
        $v = GB-RegGet $t.hive $t.key $t.name
        if (-not $v.exists) { throw 'Eintrag existiert nicht mehr.' }
        $ap = GB-RegGet $t.hive "$approvedBase\$($t.approved)" $t.name
        GB-RegDel $t.hive $t.key $t.name
        GB-RegDel $t.hive "$approvedBase\$($t.approved)" $t.name
        $b = @{ kind = 'reg'; hive = $t.hive; key = $t.key; name = $t.name; value = $v; approvedKey = "$approvedBase\$($t.approved)"; approved = $ap }
      }
      'folder' {
        if (-not (Test-Path -LiteralPath $t.path)) { throw 'Datei existiert nicht mehr.' }
        $dir = Join-Path $GB_IN.backupDir $GB_IN.backupId
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $stored = Join-Path $dir $t.name
        $ap = GB-RegGet $t.hive "$approvedBase\StartupFolder" $t.name
        Move-Item -LiteralPath $t.path -Destination $stored -Force
        GB-RegDel $t.hive "$approvedBase\StartupFolder" $t.name
        $b = @{ kind = 'file'; path = $t.path; stored = $stored; hive = $t.hive; approvedKey = "$approvedBase\StartupFolder"; name = $t.name; approved = $ap }
      }
      'task' {
        $xml = Export-ScheduledTask -TaskPath $t.taskPath -TaskName $t.taskName
        Unregister-ScheduledTask -TaskPath $t.taskPath -TaskName $t.taskName -Confirm:$false
        $b = @{ kind = 'task'; taskPath = $t.taskPath; taskName = $t.taskName; xml = [string]$xml }
      }
      default { throw 'Dieser Eintrag kann nur deaktiviert werden.' }
    }
    GB-Out @{ backup = $b }
  }
  'restore' {
    $b = $GB_IN.backup
    switch ($b.kind) {
      'reg' { GB-RegSet $b.hive $b.key $b.name $b.value.kind $b.value.value }
      'file' {
        if (-not (Test-Path -LiteralPath $b.stored)) { throw "Gesicherte Datei fehlt: $($b.stored)" }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $b.path) | Out-Null
        Move-Item -LiteralPath $b.stored -Destination $b.path -Force
        Remove-Item -LiteralPath (Split-Path -Parent $b.stored) -Force -ErrorAction SilentlyContinue
      }
      'task' { Register-ScheduledTask -Xml $b.xml -TaskPath $b.taskPath -TaskName $b.taskName -Force | Out-Null }
    }
    if ($b.approved -and $b.approved.exists) { GB-RegSet $b.hive $b.approvedKey $b.name $b.approved.kind $b.approved.value }
    GB-Out @{ ok = $true }
  }
}
`;

const TYPE_ORDER = { run: 0, folder: 1, runonce: 2, appx: 3, task: 4, service: 5 };

export async function listStartup() {
  const r = await runPS(STARTUP_PS, { mode: "list", services: loadState().startupServices });
  return (r?.items || []).sort((a, b) => (TYPE_ORDER[a.type] - TYPE_ORDER[b.type]) || a.name.localeCompare(b.name));
}

export async function setStartup(id, enabled) {
  if (!id) throw new Error("Kein Autostart-Eintrag angegeben");
  await runPS(STARTUP_PS, { mode: "set", id, enabled });
  // Services switched to "manual" no longer start automatically – remember them so they stay listed.
  if (id.startsWith("SVC|")) {
    const name = id.slice(4);
    updateState((s) => {
      s.startupServices = s.startupServices.filter((x) => x !== name);
      if (!enabled) s.startupServices.push(name);
    });
  }
  return { id, enabled };
}

export async function deleteStartup(id) {
  const item = (await listStartup()).find((x) => x.id === id);
  if (!item) throw new Error(`Autostart-Eintrag nicht gefunden: ${id}`);
  if (!item.canDelete) throw new Error(`${item.name} kann nur deaktiviert werden.`);
  const backupId = randomBytes(4).toString("hex");
  const r = await runPS(STARTUP_PS, { mode: "delete", id, backupId, backupDir: BACKUP_DIR });
  const entry = {
    backupId, itemId: id, name: item.name, type: item.type, scope: item.scope, command: item.command,
    publisher: item.publisher, deletedAt: new Date().toISOString(), backup: r.backup,
  };
  updateState((s) => {
    s.startupDeleted.unshift(entry);
    logHistory(s, { action: "startup-delete", name: item.name });
  });
  return entry;
}

export function listDeletedStartup() {
  return loadState().startupDeleted.map(({ backup, ...e }) => e);
}

function getDeleted(backupId) {
  const e = loadState().startupDeleted.find((x) => x.backupId === backupId);
  if (!e) throw new Error(`Gelöschter Eintrag nicht gefunden: ${backupId}`);
  return e;
}

export async function restoreStartup(backupId) {
  const e = getDeleted(backupId);
  await runPS(STARTUP_PS, { mode: "restore", backup: e.backup });
  updateState((s) => {
    s.startupDeleted = s.startupDeleted.filter((x) => x.backupId !== backupId);
    logHistory(s, { action: "startup-restore", name: e.name });
  });
  return { backupId, name: e.name, itemId: e.itemId };
}

export function startupNeedsAdmin(id) {
  return /^(HKLM|TASK|SVC)\|/.test(String(id));
}

export function restoreNeedsAdmin(backupId) {
  return startupNeedsAdmin(getDeleted(backupId).itemId);
}
