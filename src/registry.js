// Targeted registry cleanup: only entries that verifiably point to files that no longer exist
// (no heuristics like classic "registry cleaners"). Every entry is exported to a .reg file before
// it is removed and can be restored.
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { runPS } from "./ps.js";
import { loadState, updateState, logHistory, DATA_DIR } from "./state.js";

const BACKUP_DIR = join(DATA_DIR, "registry-backup");

export const REGISTRY_PS = String.raw`
$GB_ISSUES = New-Object System.Collections.ArrayList
function Add-Issue($cat, $hive, $key, $value, $name, $detail, $path) {
  $id = "$cat|$hive|$key"; if ($value) { $id += "|$value" }
  [void]$GB_ISSUES.Add(@{ id = $id; category = $cat; hive = $hive; key = $key; value = $value; name = $name; detail = $detail; path = $path; admin = ($hive -eq 'HKLM') })
}

# Expanded, absolute path of a file referenced by a command/DLL value, or $null if unknown.
function GB-RefPath([string]$cmd) {
  if (-not $cmd) { return $null }
  $c = [Environment]::ExpandEnvironmentVariables($cmd.Trim())
  $c = $c -replace '^\\\?\?\\', '' -replace '^\\SystemRoot\\', "$env:SystemRoot\"
  if ($c.StartsWith('"')) { $e = $c.IndexOf('"', 1); if ($e -lt 2) { return $null }; $p = $c.Substring(1, $e - 1) }
  elseif ($c -match '^(.+?\.(exe|dll|ocx|cpl|com|bat|cmd|sys))(\s|,|$)') { $p = $Matches[1] }
  else { $p = ($c -split '\s+')[0] }
  if ($p -match '^(?i)system32\\') { $p = Join-Path $env:SystemRoot $p }
  try { if (-not [IO.Path]::IsPathRooted($p) -or $p.StartsWith('\')) { return $null } } catch { return $null }
  return $p
}
# True only if the file is definitely missing (also checks the 32-bit system folder).
function GB-Missing([string]$p) {
  if (-not $p) { return $false }
  try { if (Test-Path -LiteralPath $p) { return $false } } catch { return $false }
  $sys = "$env:SystemRoot\System32\"
  if ($p.StartsWith($sys, [StringComparison]::OrdinalIgnoreCase)) {
    if (Test-Path -LiteralPath ("$env:SystemRoot\SysWOW64\" + $p.Substring($sys.Length))) { return $false }
  }
  return $true
}
function GB-Key($hive, $path) { return (GB-Hive $hive).OpenSubKey($path) }
function GB-Default($k) { if ($k) { $v = $k.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $k.Close(); return [string]$v }; return '' }
$classes = @{ HKCU = 'Software\Classes'; HKLM = 'SOFTWARE\Classes' }
$cr = [Microsoft.Win32.Registry]::ClassesRoot

function GB-Scan {
  # 1) Context menu handlers whose DLL / COM class no longer exists (slow or hanging right-click)
  foreach ($cls in '*', 'AllFilesystemObjects', 'Directory', 'Directory\Background', 'Folder', 'Drive', 'DesktopBackground', 'exefile', 'lnkfile') {
    foreach ($hive in 'HKCU', 'HKLM') {
      $base = "$($classes[$hive])\$cls\shellex\ContextMenuHandlers"
      $hk = GB-Key $hive $base
      if (-not $hk) { continue }
      foreach ($hn in $hk.GetSubKeyNames()) {
        $clsid = if ($hn -match '^\{[0-9A-Fa-f-]{36}\}$') { $hn } else { GB-Default ($hk.OpenSubKey($hn)) }
        if ($clsid -notmatch '^\{[0-9A-Fa-f-]{36}\}$') { continue }
        $ck = $cr.OpenSubKey("CLSID\$clsid")
        if (-not $ck) {
          if ($cr.OpenSubKey("PackagedCom\ClassIndex\$clsid") -or $cr.OpenSubKey("WOW6432Node\CLSID\$clsid")) { continue }
          Add-Issue 'shellext' $hive "$base\$hn" $null $hn "Kontextmenü-Erweiterung ($cls): COM-Klasse $clsid ist nicht mehr registriert." $null
          continue
        }
        $ck.Close()
        $dll = GB-RefPath (GB-Default ($cr.OpenSubKey("CLSID\$clsid\InprocServer32")))
        if (GB-Missing $dll) { Add-Issue 'shellext' $hive "$base\$hn" $null $hn "Kontextmenü-Erweiterung ($cls): DLL fehlt." $dll }
      }
      $hk.Close()
    }
  }

  # 2) Entries in "Installed apps" whose uninstaller and folder are gone
  foreach ($r in @(@{ h = 'HKLM'; k = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall' }, @{ h = 'HKLM'; k = 'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall' }, @{ h = 'HKCU'; k = 'Software\Microsoft\Windows\CurrentVersion\Uninstall' })) {
    $k = GB-Key $r.h $r.k
    if (-not $k) { continue }
    foreach ($n in $k.GetSubKeyNames()) {
      $s = $k.OpenSubKey($n)
      if (-not $s) { continue }
      $name = [string]$s.GetValue('DisplayName'); $un = [string]$s.GetValue('UninstallString'); $loc = ([string]$s.GetValue('InstallLocation')).Trim('"', ' ')
      $s.Close()
      if (-not $name -or -not $un -or $un -match '(?i)msiexec') { continue }
      $exe = GB-RefPath $un
      if ((GB-Missing $exe) -and (-not $loc -or (GB-Missing $loc))) {
        Add-Issue 'uninstall' $r.h "$($r.k)\$n" $null $name 'Programm-Eintrag ohne Deinstallationsprogramm – das Programm wurde bereits entfernt.' $exe
      }
    }
    $k.Close()
  }

  # 3) App Paths (Win+R short names) pointing to missing programs
  foreach ($r in @(@{ h = 'HKLM'; k = 'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths' }, @{ h = 'HKLM'; k = 'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths' }, @{ h = 'HKCU'; k = 'Software\Microsoft\Windows\CurrentVersion\App Paths' })) {
    $k = GB-Key $r.h $r.k
    if (-not $k) { continue }
    foreach ($n in $k.GetSubKeyNames()) {
      $p = GB-RefPath (GB-Default ($k.OpenSubKey($n)))
      if (GB-Missing $p) { Add-Issue 'apppath' $r.h "$($r.k)\$n" $null $n "Kurzname „$n“ (Ausführen-Dialog) zeigt auf ein gelöschtes Programm." $p }
    }
    $k.Close()
  }

  # 4) "Open with" applications that no longer exist
  foreach ($hive in 'HKCU', 'HKLM') {
    $base = "$($classes[$hive])\Applications"
    $k = GB-Key $hive $base
    if (-not $k) { continue }
    foreach ($n in $k.GetSubKeyNames()) {
      $p = GB-RefPath (GB-Default ($k.OpenSubKey("$n\shell\open\command")))
      if (GB-Missing $p) { Add-Issue 'openwith' $hive "$base\$n" $null $n "„Öffnen mit“-Eintrag zeigt auf ein gelöschtes Programm." $p }
    }
    $k.Close()
  }

  # 5) Services whose program file is gone (errors at every boot)
  $sk = GB-Key 'HKLM' 'SYSTEM\CurrentControlSet\Services'
  foreach ($n in $sk.GetSubKeyNames()) {
    $s = $sk.OpenSubKey($n)
    if (-not $s) { continue }
    $type = $s.GetValue('Type'); $img = [string]$s.GetValue('ImagePath', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $dn = [string]$s.GetValue('DisplayName')
    $s.Close()
    if ($null -eq $type -or -not ($type -band 0x30) -or -not $img -or $img -match '(?i)svchost\.exe') { continue }
    $p = GB-RefPath $img
    if (GB-Missing $p) { Add-Issue 'service' 'HKLM' "SYSTEM\CurrentControlSet\Services\$n" $null $(if ($dn -and -not $dn.StartsWith('@') -and $dn -ne $n) { "$dn ($n)" } elseif ($dn -and -not $dn.StartsWith('@')) { $dn } else { $n }) 'Dienst, dessen Programmdatei fehlt – erzeugt Fehler beim Systemstart.' $p }
  }
  $sk.Close()

  # 6) Shared DLL counters for deleted files
  $k = GB-Key 'HKLM' 'SOFTWARE\Microsoft\Windows\CurrentVersion\SharedDLLs'
  if ($k) {
    foreach ($v in $k.GetValueNames()) { if ($v -and (GB-Missing ([Environment]::ExpandEnvironmentVariables($v)))) { Add-Issue 'shareddll' 'HKLM' 'SOFTWARE\Microsoft\Windows\CurrentVersion\SharedDLLs' $v (Split-Path -Leaf $v) 'Referenzzähler einer gelöschten gemeinsamen Datei.' $v } }
    $k.Close()
  }
  return $GB_ISSUES
}

switch ($GB_IN.mode) {
  'scan' { GB-Out @{ items = @(GB-Scan) } }
  'clean' {
    $res = @()
    foreach ($it in $GB_IN.items) {
      try {
        $root = if ($it.hive -eq 'HKLM') { 'HKLM' } else { 'HKCU' }
        if ($it.value) {
          $orig = GB-RegGet $it.hive $it.key $it.value
          GB-RegDel $it.hive $it.key $it.value
          $res += @{ id = $it.id; ok = $true; backup = @{ kind = 'value'; hive = $it.hive; key = $it.key; value = $it.value; data = $orig } }
          continue
        }
        $file = Join-Path $GB_IN.backupDir "$($it.backupId).reg"
        $code = GB-Run 'reg.exe' @('export', "$root\$($it.key)", $file, '/y')
        if ($code -ne 0 -or -not (Test-Path -LiteralPath $file)) { throw 'Sicherung fehlgeschlagen – Eintrag nicht gelöscht.' }
        if ($it.category -eq 'service') {
          $svc = Split-Path -Leaf $it.key
          $code = GB-Run 'sc.exe' @('delete', $svc)
          if ($code -ne 0 -and $code -ne 1072) { (GB-Hive 'HKLM').DeleteSubKeyTree($it.key, $false) }
        } else {
          (GB-Hive $it.hive).DeleteSubKeyTree($it.key, $false)
        }
        $res += @{ id = $it.id; ok = $true; backup = @{ kind = 'regfile'; file = $file; hive = $it.hive } }
      } catch { $res += @{ id = $it.id; ok = $false; error = $_.Exception.Message } }
    }
    GB-Out @{ results = $res }
  }
  'restore' {
    $b = $GB_IN.backup
    if ($b.kind -eq 'value') { GB-RegSet $b.hive $b.key $b.value $b.data.kind $b.data.value }
    else {
      if ((GB-Run 'reg.exe' @('import', $b.file)) -ne 0) { throw 'Import fehlgeschlagen.' }
    }
    GB-Out @{ ok = $true }
  }
}
`;

export const REGISTRY_CATEGORIES = {
  shellext: "Kontextmenü-Erweiterungen",
  uninstall: "Einträge in „Installierte Apps“",
  apppath: "Programm-Kurznamen (App Paths)",
  openwith: "„Öffnen mit“-Programme",
  service: "Dienste",
  shareddll: "Gemeinsame DLLs",
};

export async function scanRegistry() {
  const r = await runPS(REGISTRY_PS, { mode: "scan" }, { timeout: 120000 });
  return r?.items || [];
}

export function registryNeedsAdmin(ids) {
  return ids.some((id) => String(id).split("|")[1] === "HKLM");
}

/** Removes the given issues (re-scanned first, so only still-broken entries are touched). */
export async function cleanRegistry(ids) {
  const want = new Set(ids);
  const items = (await scanRegistry()).filter((i) => want.has(i.id)).map((i) => ({ ...i, backupId: randomBytes(4).toString("hex") }));
  if (!items.length) return [];
  mkdirSync(BACKUP_DIR, { recursive: true });
  const r = await runPS(REGISTRY_PS, { mode: "clean", items, backupDir: BACKUP_DIR });
  const results = r?.results || [];
  updateState((s) => {
    for (const res of results.filter((x) => x.ok)) {
      const it = items.find((i) => i.id === res.id);
      s.registryDeleted.unshift({ backupId: it.backupId, id: it.id, category: it.category, name: it.name, detail: it.detail, key: `${it.hive}\\${it.key}${it.value ? ` [${it.value}]` : ""}`, deletedAt: new Date().toISOString(), backup: res.backup });
    }
    s.registryDeleted = s.registryDeleted.slice(0, 500);
    logHistory(s, { action: "registry-clean", name: `${results.filter((x) => x.ok).length} Einträge` });
  });
  return results.map((res) => ({ ...res, name: items.find((i) => i.id === res.id)?.name, backup: undefined }));
}

export function listRegistryBackups() {
  return loadState().registryDeleted.map(({ backup, ...e }) => ({ ...e, admin: backup?.hive === "HKLM" }));
}

function getBackup(backupId) {
  const e = loadState().registryDeleted.find((x) => x.backupId === backupId);
  if (!e) throw new Error(`Sicherung nicht gefunden: ${backupId}`);
  return e;
}

export function restoreNeedsAdmin(backupId) {
  return getBackup(backupId).backup?.hive === "HKLM";
}

export async function restoreRegistry(backupId) {
  const e = getBackup(backupId);
  await runPS(REGISTRY_PS, { mode: "restore", backup: e.backup });
  updateState((s) => {
    s.registryDeleted = s.registryDeleted.filter((x) => x.backupId !== backupId);
    logHistory(s, { action: "registry-restore", name: e.name });
  });
  return { backupId, name: e.name, service: e.category === "service" };
}
