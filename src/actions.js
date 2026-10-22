// One-shot maintenance actions (cleanup, RAM, DNS, TRIM, restore point, ...).
import { runPS } from "./ps.js";

// Purges the standby list (cached RAM) like RAMMap / ISLC. Needs admin.
export const STANDBY_PS = String.raw`
if (-not ('GBMem' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GBMem {
  [DllImport("ntdll.dll")] static extern uint NtSetSystemInformation(int infoClass, IntPtr info, int length);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool LookupPrivilegeValue(string sys, string name, out long luid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TP state, int len, IntPtr prev, IntPtr retLen);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [StructLayout(LayoutKind.Sequential, Pack = 1)] struct TP { public int Count; public long Luid; public int Attr; }
  static void Enable(string name) {
    IntPtr tok; OpenProcessToken(GetCurrentProcess(), 0x28, out tok);
    TP tp = new TP(); tp.Count = 1; tp.Attr = 2;
    LookupPrivilegeValue(null, name, out tp.Luid);
    AdjustTokenPrivileges(tok, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero);
  }
  public static uint Command(int cmd) {
    Enable("SeProfileSingleProcessPrivilege");
    IntPtr p = Marshal.AllocHGlobal(4);
    Marshal.WriteInt32(p, cmd);
    uint r = NtSetSystemInformation(80, p, 4);
    Marshal.FreeHGlobal(p);
    return r;
  }
}
'@
}
function GB-PurgeStandby {
  $before = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory
  $r = [GBMem]::Command(4)
  if ($r -ne 0) { throw ("NtSetSystemInformation fehlgeschlagen (0x{0:X8}) – Administratorrechte erforderlich" -f $r) }
  Start-Sleep -Milliseconds 300
  $after = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory
  return [math]::Max(0, [math]::Round(($after - $before) / 1024))
}
`;

export const SIZE_PS = String.raw`
function GB-DirSize([string[]]$paths) {
  $sum = 0
  foreach ($p in $paths) { if (Test-Path -LiteralPath $p) { $sum += (Get-ChildItem -LiteralPath $p -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum } }
  return [int64]$sum
}
function GB-Clean([string[]]$paths) {
  $before = GB-DirSize $paths
  foreach ($p in $paths) {
    if (Test-Path -LiteralPath $p) { Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue }
  }
  $after = GB-DirSize $paths
  return [int64]($before - $after)
}
function GB-MB([int64]$b) { return ('{0:N0} MB' -f ($b / 1MB)) }
function GB-Glob([string[]]$patterns) { @($patterns | ForEach-Object { Get-Item -Path $_ -Force -ErrorAction SilentlyContinue } | ForEach-Object { $_.FullName }) }
`;

export const GROUPS = [
  { id: "clean", title: "Aufräumen" },
  { id: "system", title: "System & Leistung" },
  { id: "repair", title: "Reparatur & Sicherung" },
];

export const ACTIONS = [
  {
    id: "quick-clean",
    group: "clean",
    title: "1-Klick-Optimierung",
    description: "Temporäre Dateien und Papierkorb leeren, DNS-Cache leeren und Standby-RAM freigeben.",
    icon: "🚀", admin: true,
    script: SIZE_PS + STANDBY_PS + String.raw`
      $freed = GB-Clean @($env:TEMP, "$env:SystemRoot\Temp")
      try { Clear-RecycleBin -Force -ErrorAction Stop } catch {}
      ipconfig /flushdns | Out-Null
      $ram = 0; try { $ram = GB-PurgeStandby } catch {}
      return "$(GB-MB $freed) Speicher und $ram MB RAM freigegeben, DNS-Cache geleert."`,
  },
  {
    id: "clean-temp",
    group: "clean",
    title: "Temporäre Dateien löschen",
    description: "Leert den Benutzer- und Windows-Temp-Ordner (gesperrte Dateien werden übersprungen).",
    icon: "🧹", admin: true,
    script: SIZE_PS + String.raw`
      $freed = GB-Clean @($env:TEMP, "$env:SystemRoot\Temp")
      return "$(GB-MB $freed) freigegeben."`,
  },
  {
    id: "empty-recycle-bin",
    group: "clean",
    title: "Papierkorb leeren",
    description: "Leert den Papierkorb auf allen Laufwerken.",
    icon: "🗑️", admin: false,
    script: String.raw`Clear-RecycleBin -Force -ErrorAction SilentlyContinue; return 'Papierkorb geleert.'`,
  },
  {
    id: "clean-shader-cache",
    group: "clean",
    title: "Shader-Cache leeren",
    description: "Löscht DirectX-, NVIDIA- und AMD-Shader-Caches. Sinnvoll nach Treiber-Updates oder bei Grafikfehlern – Spiele kompilieren Shader danach einmalig neu.",
    icon: "🎨", admin: false,
    script: SIZE_PS + String.raw`
      $paths = @("$env:LOCALAPPDATA\D3DSCache", "$env:LOCALAPPDATA\NVIDIA\DXCache", "$env:LOCALAPPDATA\NVIDIA\GLCache", "$env:LOCALAPPDATA\AMD\DxCache", "$env:LOCALAPPDATA\AMD\DxcCache", "$env:LOCALAPPDATA\AMD\VkCache", "$env:LOCALAPPDATA\Intel\ShaderCache", "$env:USERPROFILE\AppData\LocalLow\NVIDIA\PerDriverVersion\DXCache")
      $freed = GB-Clean $paths
      return "$(GB-MB $freed) Shader-Cache gelöscht."`,
  },
  {
    id: "clean-update-cache",
    group: "clean",
    title: "Windows-Update-Cache leeren",
    description: "Löscht bereits installierte Update-Downloads (SoftwareDistribution\\Download).",
    icon: "📦", admin: true,
    script: SIZE_PS + String.raw`
      Stop-Service wuauserv, bits -Force -ErrorAction SilentlyContinue
      $freed = GB-Clean @("$env:SystemRoot\SoftwareDistribution\Download")
      Start-Service wuauserv, bits -ErrorAction SilentlyContinue
      return "$(GB-MB $freed) freigegeben."`,
  },
  {
    id: "clean-crash-dumps",
    group: "clean",
    title: "Absturzberichte & Speicherabbilder",
    description: "Löscht Fehlerberichte (WER), Minidumps und MEMORY.DMP. Nur nötig, wenn du Abstürze nicht mehr analysieren willst.",
    icon: "💥", admin: true,
    script: SIZE_PS + String.raw`
      $paths = @("$env:SystemRoot\Minidump", "$env:LOCALAPPDATA\CrashDumps", "$env:ProgramData\Microsoft\Windows\WER\ReportArchive", "$env:ProgramData\Microsoft\Windows\WER\ReportQueue", "$env:LOCALAPPDATA\Microsoft\Windows\WER\ReportArchive", "$env:LOCALAPPDATA\Microsoft\Windows\WER\ReportQueue")
      $freed = GB-Clean $paths
      $dmp = "$env:SystemRoot\MEMORY.DMP"
      if (Test-Path -LiteralPath $dmp) { $freed += (Get-Item -LiteralPath $dmp -Force).Length; Remove-Item -LiteralPath $dmp -Force -ErrorAction SilentlyContinue }
      return "$(GB-MB $freed) Absturzberichte gelöscht."`,
  },
  {
    id: "clean-do-cache",
    group: "clean",
    title: "Übermittlungsoptimierung-Cache",
    description: "Löscht zwischengespeicherte Update-Pakete, die Windows per P2P an andere PCs verteilt.",
    icon: "📡", admin: true,
    script: SIZE_PS + String.raw`
      $dir = "$env:SystemRoot\ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache"
      $before = GB-DirSize @($dir)
      try { Delete-DeliveryOptimizationCache -Force -ErrorAction Stop } catch { GB-Clean @($dir) | Out-Null }
      $freed = [math]::Max(0, $before - (GB-DirSize @($dir)))
      return "$(GB-MB $freed) freigegeben."`,
  },
  {
    id: "clean-browser-cache",
    group: "clean",
    title: "Browser-Cache leeren",
    description: "Leert den Cache von Edge, Chrome, Brave, Opera und Firefox (Verläufe, Passwörter und Cookies bleiben erhalten). Geöffnete Browser sperren Teile davon.",
    icon: "🌍", admin: false,
    script: SIZE_PS + String.raw`
      $chromium = @("$env:LOCALAPPDATA\Microsoft\Edge\User Data", "$env:LOCALAPPDATA\Google\Chrome\User Data", "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\User Data", "$env:APPDATA\Opera Software\Opera Stable", "$env:APPDATA\Opera Software\Opera GX Stable")
      $pat = @()
      foreach ($c in $chromium) { foreach ($sub in 'Cache', 'Code Cache', 'GPUCache') { $pat += "$c\*\$sub"; $pat += "$c\$sub" } }
      $pat += "$env:LOCALAPPDATA\Mozilla\Firefox\Profiles\*\cache2"
      $freed = GB-Clean (GB-Glob $pat)
      return "$(GB-MB $freed) Browser-Cache gelöscht."`,
  },
  {
    id: "clean-thumbnails",
    group: "clean",
    title: "Miniaturansichten-Cache",
    description: "Löscht Vorschaubilder und Symbol-Cache des Explorers (hilft bei falschen/verpixelten Symbolen). Der Explorer startet dafür kurz neu.",
    icon: "🖼️", admin: false,
    script: String.raw`
      $dir = "$env:LOCALAPPDATA\Microsoft\Windows\Explorer"
      $files = @(Get-ChildItem -LiteralPath $dir -Force -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'thumbcache_*.db' -or $_.Name -like 'iconcache_*.db' })
      Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 800
      $freed = 0
      foreach ($f in $files) { try { $len = $f.Length; Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop; $freed += $len } catch {} }
      if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }
      return ('{0:N0} MB Miniaturansichten gelöscht.' -f ($freed / 1MB))`,
  },
  {
    id: "remove-windows-old",
    group: "clean",
    title: "Alte Windows-Installation (Windows.old)",
    description: "Löscht den Ordner Windows.old nach einem Funktionsupdate (oft 10–30 GB). ⚠ Danach ist keine Rückkehr zur vorherigen Windows-Version mehr möglich.",
    icon: "🗄️", admin: true, timeout: 60,
    script: SIZE_PS + String.raw`
      $dir = "$env:SystemDrive\Windows.old"
      if (-not (Test-Path -LiteralPath $dir)) { return 'Kein Windows.old vorhanden.' }
      $before = GB-DirSize @($dir)
      & takeown.exe /F $dir /R /A /D Y | Out-Null
      & icacls.exe $dir /grant '*S-1-5-32-544:F' /T /C /Q | Out-Null
      Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath $dir) { & cmd.exe /c rd /s /q "$dir" 2>&1 | Out-Null }
      $left = if (Test-Path -LiteralPath $dir) { GB-DirSize @($dir) } else { 0 }
      return "$(GB-MB ($before - $left)) freigegeben."`,
  },
  {
    id: "component-cleanup",
    group: "clean",
    title: "Komponentenspeicher bereinigen (WinSxS)",
    description: "Entfernt durch Updates ersetzte Systemkomponenten (DISM /StartComponentCleanup). Dauert 5–20 Minuten.",
    icon: "🧩", admin: true, timeout: 60,
    script: String.raw`
      $free = (Get-PSDrive ($env:SystemDrive.TrimEnd(':'))).Free
      $out = & dism.exe /Online /Cleanup-Image /StartComponentCleanup /NoRestart 2>&1
      if ($LASTEXITCODE -ne 0) { throw "DISM-Fehler $LASTEXITCODE" }
      $gain = (Get-PSDrive ($env:SystemDrive.TrimEnd(':'))).Free - $free
      return ('Komponentenspeicher bereinigt ({0:N0} MB freigegeben).' -f ([math]::Max(0, $gain) / 1MB))`,
  },
  {
    id: "clear-standby",
    group: "system",
    title: "Standby-RAM freigeben",
    description: "Leert die Standby-Liste des Arbeitsspeichers (wie ISLC/RAMMap). Hilft gegen Ruckler bei vollem RAM.",
    icon: "🧠", admin: true,
    script: STANDBY_PS + String.raw`$mb = GB-PurgeStandby; return "$mb MB RAM freigegeben."`,
  },
  {
    id: "flush-dns",
    group: "system",
    title: "DNS-Cache leeren",
    description: "Hilft bei Verbindungsproblemen zu Spieleservern nach IP-Änderungen.",
    icon: "🌐", admin: false,
    script: String.raw`ipconfig /flushdns | Out-Null; return 'DNS-Cache geleert.'`,
  },
  {
    id: "trim-ssd",
    group: "system",
    title: "SSD-TRIM ausführen",
    description: "Sendet TRIM an alle SSDs, damit Schreibleistung hoch bleibt. Auf HDDs wird nichts gemacht.",
    icon: "💽", admin: true,
    script: String.raw`
      $done = @()
      $ssd = Get-PhysicalDisk | Where-Object MediaType -eq 'SSD'
      foreach ($d in $ssd) {
        $vols = Get-Partition -DiskNumber $d.DeviceId -ErrorAction SilentlyContinue | Where-Object DriveLetter | ForEach-Object { $_.DriveLetter }
        foreach ($v in $vols) { Optimize-Volume -DriveLetter $v -ReTrim -ErrorAction SilentlyContinue; $done += "$($v):" }
      }
      if ($done.Count -eq 0) { return 'Keine SSD-Laufwerke gefunden.' }
      return "TRIM ausgeführt für $($done -join ', ')."`,
  },
  {
    id: "restart-explorer",
    group: "system",
    title: "Explorer neu starten",
    description: "Startet Taskleiste und Explorer neu, damit Darstellungs-Optimierungen sofort greifen.",
    icon: "🔄", admin: false,
    script: String.raw`Stop-Process -Name explorer -Force; Start-Sleep -Seconds 1; if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }; return 'Explorer neu gestartet.'`,
  },
  {
    id: "sfc",
    group: "repair",
    title: "Systemdateien prüfen (SFC)",
    description: "Prüft geschützte Windows-Dateien und repariert beschädigte (sfc /scannow). Dauert 5–15 Minuten.",
    icon: "🩺", admin: true, timeout: 60,
    script: String.raw`
      $out = ((& "$env:SystemRoot\System32\sfc.exe" /scannow) -join ' ').Replace([string][char]0, '')
      if ($out -match 'keine Integrit|did not find any integrity') { return 'Keine beschädigten Systemdateien gefunden.' }
      if ($out -match 'erfolgreich repariert|successfully repaired') { return 'Beschädigte Systemdateien gefunden und repariert. Neustart empfohlen.' }
      if ($out -match 'nicht reparieren|unable to fix') { return 'Beschädigte Dateien gefunden, aber nicht alle reparierbar – „Windows-Abbild reparieren (DISM)“ ausführen und SFC danach wiederholen.' }
      if ($out -match 'ausstehend|pending') { return 'Eine Systemreparatur wartet auf einen Neustart. Bitte neu starten und erneut prüfen.' }
      return 'Prüfung abgeschlossen. Details: %WINDIR%\Logs\CBS\CBS.log'`,
  },
  {
    id: "dism-restore",
    group: "repair",
    title: "Windows-Abbild reparieren (DISM)",
    description: "Repariert den Komponentenspeicher über Windows Update (DISM /RestoreHealth) – Grundlage dafür, dass SFC reparieren kann. Dauert 10–30 Minuten.",
    icon: "🛠️", admin: true, timeout: 60,
    script: String.raw`
      $out = & dism.exe /Online /Cleanup-Image /RestoreHealth /NoRestart 2>&1
      if ($LASTEXITCODE -ne 0) { throw "DISM-Fehler $LASTEXITCODE – Internetverbindung prüfen." }
      return 'Windows-Abbild geprüft und repariert. Danach „Systemdateien prüfen (SFC)“ ausführen.'`,
  },
  {
    id: "restore-point",
    group: "repair",
    title: "Wiederherstellungspunkt erstellen",
    description: "Sichert den Systemzustand vor größeren Änderungen. Benötigt aktivierten Computerschutz auf C:.",
    icon: "🛟", admin: true,
    script: String.raw`
      $k = 'SOFTWARE\Microsoft\Windows NT\CurrentVersion\SystemRestore'
      $prev = GB-RegGet 'HKLM' $k 'SystemRestorePointCreationFrequency'
      GB-RegSet 'HKLM' $k 'SystemRestorePointCreationFrequency' 'DWord' 0
      try {
        Enable-ComputerRestore -Drive "$env:SystemDrive\" -ErrorAction SilentlyContinue
        Checkpoint-Computer -Description 'GameBoost' -RestorePointType MODIFY_SETTINGS
      } finally {
        if ($prev.exists) { GB-RegSet 'HKLM' $k 'SystemRestorePointCreationFrequency' $prev.kind $prev.value } else { GB-RegDel 'HKLM' $k 'SystemRestorePointCreationFrequency' }
      }
      return 'Wiederherstellungspunkt „GameBoost“ erstellt.'`,
  },
];

export function getAction(id) {
  const a = ACTIONS.find((x) => x.id === id);
  if (!a) throw new Error(`Unbekannte Aktion: ${id}`);
  return a;
}

export async function runAction(id) {
  const a = getAction(id);
  const message = await runPS(`$m = & {\n${a.script}\n}\nGB-Out @{ message = [string]$m }`, null, { timeout: (a.timeout || 15) * 60 * 1000 });
  return { id, title: a.title, message: message?.message || "Erledigt." };
}

export function publicActions() {
  return ACTIONS.map(({ script, ...a }) => a);
}
