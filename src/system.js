// System information.
import { execFile } from "node:child_process";
import { runPS } from "./ps.js";
import { CPU_PS } from "./session.js";

let adminCache = null;
/** True if the current process runs elevated. */
export function isAdmin() {
  if (adminCache !== null) return Promise.resolve(adminCache);
  return new Promise((resolve) => {
    execFile("net", ["session"], { windowsHide: true }, (err) => resolve((adminCache = !err)));
  });
}

export const SYSINFO_PS = CPU_PS + String.raw`
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$cs = Get-CimInstance Win32_ComputerSystem
$cpuMasks = [GBCpu]::Masks()
$gpus = @()
$cls = 'SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
$vram = @{}
$ck = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($cls)
if ($ck) {
  foreach ($n in $ck.GetSubKeyNames()) {
    if ($n -notmatch '^\d{4}$') { continue }
    try { $sk = $ck.OpenSubKey($n) } catch { continue }
    if (-not $sk) { continue }
    $desc = $sk.GetValue('DriverDesc'); $mem = $sk.GetValue('HardwareInformation.qwMemorySize')
    if ($desc -and $mem) { $vram[$desc] = [int64]$mem }
    $sk.Close()
  }
  $ck.Close()
}
foreach ($g in Get-CimInstance Win32_VideoController) {
  if ($g.Name -match 'Basic Display|Remote|Virtual|Parsec|Meta') { continue }
  $mem = if ($vram.ContainsKey($g.Name)) { $vram[$g.Name] } else { [int64]$g.AdapterRAM }
  $gpus += @{ name = $g.Name; driver = $g.DriverVersion; vramGB = [math]::Round($mem / 1GB, 1); refresh = $g.CurrentRefreshRate; resolution = "$($g.CurrentHorizontalResolution)x$($g.CurrentVerticalResolution)" }
}
$disks = @()
foreach ($v in Get-Volume | Where-Object { $_.DriveLetter -and $_.DriveType -eq 'Fixed' -and $_.Size -gt 0 }) {
  $media = try { (Get-Partition -DriveLetter $v.DriveLetter | Get-Disk | ForEach-Object { (Get-PhysicalDisk -DeviceNumber $_.Number).MediaType }) } catch { 'Unknown' }
  $disks += @{ letter = "$($v.DriveLetter):"; label = $v.FileSystemLabel; sizeGB = [math]::Round($v.Size / 1GB); freeGB = [math]::Round($v.SizeRemaining / 1GB); media = "$media" }
}
$schemeOut = "$(powercfg /getactivescheme)"
$schemeName = if ($schemeOut -match '\((.+)\)\s*$') { $Matches[1] } else { '' }
$uptime = (Get-Date) - $os.LastBootUpTime
GB-Out @{
  computer = $env:COMPUTERNAME
  os = @{ name = $os.Caption; version = $os.Version; build = [int]$os.BuildNumber; uptimeHours = [math]::Round($uptime.TotalHours, 1) }
  cpu = @{ name = $cpu.Name.Trim(); cores = $cpu.NumberOfCores; threads = $cpu.NumberOfLogicalProcessors; mhz = $cpu.MaxClockSpeed; load = $cpu.LoadPercentage; pThreads = (GB-BitCount $cpuMasks[0]); eThreads = (GB-BitCount $cpuMasks[1]) }
  ram = @{ totalGB = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1); freeGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1) }
  gpus = $gpus
  disks = $disks
  powerPlan = @{ guid = (GB-ActiveScheme); name = $schemeName }
  isAdmin = (GB-IsAdmin)
  isLaptop = [bool](Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue)
}
`;

export async function sysinfo() {
  return runPS(SYSINFO_PS);
}
