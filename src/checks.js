// Hardware/system health checks with concrete hints: refresh rate below the monitor's maximum,
// RAM without XMP/EXPO or in single channel, old GPU driver, Resizable BAR, disk health, ...
// status: ok | info | warn | bad. fix: { type: "uri" | "url" | "action" | "tweak", value, label }
import { runPS } from "./ps.js";

export const CHECKS_PS = String.raw`
if (-not ('GBDisp' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class GBDisp {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
    public int dmFields, dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DISPLAY_DEVICE {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplayDevices(string dev, int i, ref DISPLAY_DEVICE dd, int flags);
  // "monitor|width|height|currentHz|maxHzAtThisResolution" per active display
  public static string[] Query() {
    var res = new List<string>();
    for (int i = 0; ; i++) {
      var dd = new DISPLAY_DEVICE(); dd.cb = Marshal.SizeOf(dd);
      if (!EnumDisplayDevices(null, i, ref dd, 0)) break;
      if ((dd.StateFlags & 1) == 0) continue;
      var cur = new DEVMODE(); cur.dmSize = (short)Marshal.SizeOf(cur);
      if (!EnumDisplaySettings(dd.DeviceName, -1, ref cur)) continue;
      int max = cur.dmDisplayFrequency;
      for (int m = 0; ; m++) {
        var dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(dm);
        if (!EnumDisplaySettings(dd.DeviceName, m, ref dm)) break;
        if (dm.dmPelsWidth == cur.dmPelsWidth && dm.dmPelsHeight == cur.dmPelsHeight && dm.dmDisplayFrequency > max) max = dm.dmDisplayFrequency;
      }
      var mon = new DISPLAY_DEVICE(); mon.cb = Marshal.SizeOf(mon);
      string name = EnumDisplayDevices(dd.DeviceName, 0, ref mon, 0) ? mon.DeviceString : dd.DeviceString;
      res.Add(name + "|" + cur.dmPelsWidth + "|" + cur.dmPelsHeight + "|" + cur.dmDisplayFrequency + "|" + max);
    }
    return res.ToArray();
  }
}
'@
}

$checks = New-Object System.Collections.ArrayList
function Add-Check($id, $group, $title, $status, $detail, $fix = $null) {
  [void]$checks.Add(@{ id = $id; group = $group; title = $title; status = $status; detail = $detail; fix = $fix })
}

# ── Display refresh rate
try {
  $i = 0
  foreach ($d in [GBDisp]::Query()) {
    $f = $d.Split('|'); $i++
    $name = if ($f[0] -and $f[0] -ne 'Generic PnP Monitor' -and $f[0] -ne 'Generischer PnP-Monitor') { $f[0] } else { "Monitor $i" }
    $cur = [int]$f[3]; $max = [int]$f[4]
    if ($max -gt $cur + 1) {
      Add-Check "refresh-$i" 'display' "Bildwiederholrate: $name" 'warn' "Läuft mit $cur Hz bei $($f[1])×$($f[2]), unterstützt aber bis zu $max Hz. In den Anzeigeeinstellungen unter „Erweiterte Anzeige“ umstellen." @{ type = 'uri'; value = 'ms-settings:display-advanced'; label = 'Anzeigeeinstellungen' }
    } else {
      Add-Check "refresh-$i" 'display' "Bildwiederholrate: $name" 'ok' "$cur Hz bei $($f[1])×$($f[2]) – das Maximum dieser Auflösung."
    }
  }
} catch { Add-Check 'refresh' 'display' 'Bildwiederholrate' 'info' "Konnte nicht ermittelt werden: $($_.Exception.Message)" }

# ── RAM: XMP/EXPO and dual channel
try {
  $mods = @(Get-CimInstance Win32_PhysicalMemory)
  if ($mods.Count) {
    $cfg = [int](($mods | Measure-Object ConfiguredClockSpeed -Maximum).Maximum)
    $rated = [int](($mods | Measure-Object Speed -Maximum).Maximum)
    $type = [int]$mods[0].SMBIOSMemoryType
    $ddr = switch ($type) { 26 { 'DDR4' } 34 { 'DDR5' } 24 { 'DDR3' } default { 'RAM' } }
    $partSpeed = 0
    foreach ($m in $mods) {
      foreach ($x in [regex]::Matches([string]$m.PartNumber, '(?<!\d)(\d{4})(?!\d)')) { $v = [int]$x.Groups[1].Value; if ($v -ge 2133 -and $v -le 9600 -and $v -gt $partSpeed) { $partSpeed = $v } }
    }
    # Some boards report DDR4 clocks in MHz (half the MT/s value).
    if ($partSpeed -and [math]::Abs($cfg * 2 - $partSpeed) -le 100) { $cfg = $cfg * 2 }
    $gb = [math]::Round((($mods | Measure-Object Capacity -Sum).Sum) / 1GB)
    $bios = @{ type = 'url'; value = 'https://www.google.com/search?q=' + [uri]::EscapeDataString("$((Get-CimInstance Win32_BaseBoard).Product) XMP EXPO aktivieren"); label = 'Anleitung suchen' }
    if ($partSpeed -gt $cfg + 100) {
      Add-Check 'ram-xmp' 'memory' 'Arbeitsspeicher-Takt (XMP/EXPO)' 'warn' "$ddr läuft mit $cfg MT/s, die Module sind laut Typbezeichnung für $partSpeed MT/s ausgelegt. XMP (Intel) bzw. EXPO (AMD) im BIOS aktivieren – bringt in CPU-limitierten Spielen oft 5–15 % mehr FPS." $bios
    } elseif ($rated -gt $cfg + 100) {
      Add-Check 'ram-xmp' 'memory' 'Arbeitsspeicher-Takt (XMP/EXPO)' 'warn' "$ddr läuft mit $cfg MT/s, die Module melden bis zu $rated MT/s. XMP/EXPO im BIOS aktivieren." $bios
    } elseif (($type -eq 26 -and $cfg -le 2666) -or ($type -eq 34 -and $cfg -le 4800)) {
      Add-Check 'ram-xmp' 'memory' 'Arbeitsspeicher-Takt (XMP/EXPO)' 'info' "$ddr läuft mit JEDEC-Standardtakt ($cfg MT/s). Falls die Module ein XMP/EXPO-Profil haben, im BIOS aktivieren." $bios
    } else {
      Add-Check 'ram-xmp' 'memory' 'Arbeitsspeicher-Takt (XMP/EXPO)' 'ok' "$ddr läuft mit $cfg MT/s."
    }
    if ($mods.Count -eq 1) {
      Add-Check 'ram-channel' 'memory' 'Dual-Channel' 'warn' "Nur ein Speichermodul ($gb GB) – Single-Channel halbiert die Speicherbandbreite. Ein zweites, identisches Modul bringt in vielen Spielen deutlich bessere 1%-Lows."
    } else {
      Add-Check 'ram-channel' 'memory' 'Dual-Channel' 'ok' "$($mods.Count) Module, $gb GB gesamt."
    }
  }
} catch {}

# ── GPU driver age and Resizable BAR (NVIDIA)
foreach ($g in Get-CimInstance Win32_VideoController) {
  if ($g.Name -match 'Basic Display|Remote|Virtual|Parsec|Meta') { continue }
  $vendor = if ($g.Name -match 'NVIDIA') { 'nvidia' } elseif ($g.Name -match 'AMD|Radeon') { 'amd' } elseif ($g.Name -match 'Intel') { 'intel' } else { '' }
  $url = switch ($vendor) {
    'nvidia' { 'https://www.nvidia.com/de-de/geforce/drivers/' }
    'amd' { 'https://www.amd.com/de/support/download/drivers.html' }
    'intel' { 'https://www.intel.de/content/www/de/de/download-center/home.html' }
    default { $null }
  }
  if ($g.DriverDate) {
    $age = [int]((Get-Date) - $g.DriverDate).TotalDays
    $fix = if ($url) { @{ type = 'url'; value = $url; label = 'Treiber herunterladen' } } else { $null }
    $date = $g.DriverDate.ToString('dd.MM.yyyy')
    if ($age -gt 180) { Add-Check "driver-$vendor" 'gpu' "Grafiktreiber: $($g.Name)" 'warn' "Treiber $($g.DriverVersion) vom $date ist $age Tage alt. Neue Treiber bringen oft Leistungsverbesserungen und Fehlerkorrekturen für aktuelle Spiele." $fix }
    else { Add-Check "driver-$vendor" 'gpu' "Grafiktreiber: $($g.Name)" 'ok' "Treiber $($g.DriverVersion) vom $date." $fix }
  }
}
$smi = @("$env:SystemRoot\System32\nvidia-smi.exe", "$env:ProgramFiles\NVIDIA Corporation\NVSMI\nvidia-smi.exe") | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($smi) {
  try {
    $out = (& $smi -q -d MEMORY) -join "\n"
    if ($out -match 'BAR1 Memory Usage[^:]*?Total\s*:\s*(\d+)\s*MiB') {
      $bar = [int]$Matches[1]
      if ($bar -gt 256) { Add-Check 'rebar' 'gpu' 'Resizable BAR' 'ok' "Aktiv (BAR1 = $bar MiB)." }
      else { Add-Check 'rebar' 'gpu' 'Resizable BAR' 'info' "Nicht aktiv (BAR1 = 256 MiB). Im BIOS „Above 4G Decoding“ und „Re-Size BAR Support“ aktivieren (RTX 30/40/50) – bringt in unterstützten Spielen einige Prozent." }
    }
  } catch {}
}

# ── Disks: health, wear, temperature
foreach ($pd in Get-PhysicalDisk) {
  $name = "$($pd.FriendlyName)".Trim()
  $detail = "Status: $($pd.HealthStatus)"
  $st = if ($pd.HealthStatus -eq 'Healthy') { 'ok' } elseif ($pd.HealthStatus -eq 'Warning') { 'warn' } else { 'bad' }
  try {
    $rc = $pd | Get-StorageReliabilityCounter -ErrorAction Stop
    if ($null -ne $rc.Wear) { $detail += " · Abnutzung $($rc.Wear) %"; if ($rc.Wear -ge 80 -and $st -eq 'ok') { $st = 'warn' } }
    if ($rc.Temperature) { $detail += " · $($rc.Temperature) °C"; if ($rc.Temperature -ge 70 -and $st -eq 'ok') { $st = 'warn' } }
    if ($rc.ReadErrorsUncorrected) { $detail += " · $($rc.ReadErrorsUncorrected) nicht korrigierbare Lesefehler"; $st = 'bad' }
  } catch {}
  if ($st -eq 'bad') { $detail += ' – Datensicherung empfohlen!' }
  Add-Check "disk-$($pd.DeviceId)" 'disk' "Laufwerk: $name ($($pd.MediaType))" $st $detail
}
$sys = Get-Volume -DriveLetter ($env:SystemDrive.TrimEnd(':')) -ErrorAction SilentlyContinue
if ($sys -and $sys.Size) {
  $freeGB = [math]::Round($sys.SizeRemaining / 1GB); $pct = [math]::Round($sys.SizeRemaining / $sys.Size * 100)
  if ($pct -lt 10 -or $freeGB -lt 20) { Add-Check 'disk-free' 'disk' "Freier Speicher auf $env:SystemDrive" 'warn' "Nur $freeGB GB ($pct %) frei. Windows und Spiele-Updates brauchen Platz; volle SSDs werden langsamer." @{ type = 'action'; value = 'quick-clean'; label = 'Aufräumen' } }
  else { Add-Check 'disk-free' 'disk' "Freier Speicher auf $env:SystemDrive" 'ok' "$freeGB GB ($pct %) frei." }
}

# ── Windows: pending reboot, uptime, power plan
$pending = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')
$up = [math]::Round(((Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime).TotalDays, 1)
if ($pending) { Add-Check 'reboot' 'windows' 'Neustart ausstehend' 'warn' 'Updates warten auf einen Neustart. Bis dahin können Dienste im Hintergrund Ressourcen belegen.' }
elseif ($up -gt 7) { Add-Check 'reboot' 'windows' 'Laufzeit' 'info' "Der PC läuft seit $up Tagen ohne Neustart. Ein Neustart räumt Speicherlecks und hängende Prozesse auf." }
else { Add-Check 'reboot' 'windows' 'Laufzeit' 'ok' "Letzter Neustart vor $up Tagen." }
$scheme = GB-ActiveScheme
if ($scheme -eq 'a1841308-3541-4fab-bc81-f71556f20b4a') {
  Add-Check 'power' 'windows' 'Energieplan' 'warn' 'Der Energiesparplan ist aktiv – die CPU wird stark gedrosselt.' @{ type = 'tweak'; value = 'ultimate-power-plan'; label = 'GameBoost-Plan aktivieren' }
}
GB-Out @{ checks = @($checks) }
`;

export async function runChecks() {
  const r = await runPS(CHECKS_PS);
  return r?.checks || [];
}
