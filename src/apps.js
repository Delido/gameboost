// Installed programs (uninstall + leftover search) and removal of preinstalled Store apps.
import { runPS } from "./ps.js";
import { updateState, logHistory } from "./state.js";

export const PROGRAMS_PS = String.raw`
$roots = @(
  @{ hive = 'HKLM'; key = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'; scope = 'Alle Benutzer' },
  @{ hive = 'HKLM'; key = 'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'; scope = 'Alle Benutzer (32 Bit)' },
  @{ hive = 'HKCU'; key = 'Software\Microsoft\Windows\CurrentVersion\Uninstall'; scope = 'Benutzer' }
)
function GB-Programs {
  $out = @()
  foreach ($r in $roots) {
    $k = (GB-Hive $r.hive).OpenSubKey($r.key)
    if (-not $k) { continue }
    foreach ($n in $k.GetSubKeyNames()) {
      $s = $k.OpenSubKey($n)
      if (-not $s) { continue }
      $name = [string]$s.GetValue('DisplayName')
      $un = [string]$s.GetValue('UninstallString')
      $skip = -not $name -or -not $un -or $s.GetValue('SystemComponent') -eq 1 -or $s.GetValue('ParentKeyName') -or @('Update', 'Hotfix', 'Security Update') -contains [string]$s.GetValue('ReleaseType')
      if (-not $skip) {
        $date = [string]$s.GetValue('InstallDate')
        $out += @{
          id = "$($r.hive)|$($r.key)|$n"; name = $name.Trim(); publisher = ([string]$s.GetValue('Publisher')).Trim(); version = [string]$s.GetValue('DisplayVersion')
          sizeMB = [math]::Round([double]($s.GetValue('EstimatedSize', 0)) / 1024); installDate = if ($date -match '^\d{8}$') { "$($date.Substring(0,4))-$($date.Substring(4,2))-$($date.Substring(6,2))" } else { '' }
          location = ([string]$s.GetValue('InstallLocation')).Trim('"', ' ', '\'); uninstall = $un; quiet = [string]$s.GetValue('QuietUninstallString'); scope = $r.scope
          icon = [string]$s.GetValue('DisplayIcon')
        }
      }
      $s.Close()
    }
    $k.Close()
  }
  return $out
}

switch ($GB_IN.mode) {
  'list' { GB-Out @{ items = @(GB-Programs) } }
  'uninstall' {
    $p = GB-Programs | Where-Object { $_.id -eq $GB_IN.id } | Select-Object -First 1
    if (-not $p) { throw 'Programm nicht gefunden – evtl. bereits deinstalliert.' }
    $cmd = [Environment]::ExpandEnvironmentVariables($p.uninstall.Trim())
    # MSI: /I (repair/modify) -> /X (remove)
    if ($cmd -match '(?i)msiexec(\.exe)?\s+/[IX]\s*(\{[0-9A-F-]{36}\})') { $exe = "$env:SystemRoot\System32\msiexec.exe"; $argl = "/X$($Matches[2])" }
    elseif ($cmd.StartsWith('"')) { $e = $cmd.IndexOf('"', 1); $exe = $cmd.Substring(1, $e - 1); $argl = $cmd.Substring($e + 1).Trim() }
    elseif ($cmd -match '^(.+?\.exe)\s*(.*)$') { $exe = $Matches[1]; $argl = $Matches[2] }
    else { $exe = $cmd; $argl = '' }
    if ($argl) { Start-Process -FilePath $exe -ArgumentList $argl } else { Start-Process -FilePath $exe }
    GB-Out @{ started = $true; name = $p.name }
  }
  'leftovers' {
    $name = [string]$GB_IN.name; $pub = [string]$GB_IN.publisher
    # "Foo Bar 1.2.3 (x64)" -> "Foo Bar"
    $base = ($name -replace '\s*\((x64|x86|64-bit|32-bit|[^)]*bit)\)', '' -replace '\s+v?\d+(\.\d+)+.*$', '').Trim()
    $names = @($name, $base) | Where-Object { $_ -and $_.Length -ge 3 } | Select-Object -Unique
    $pubShort = ($pub -replace '(?i),?\s*(inc|ltd|llc|gmbh|corp|corporation|co|ag|s\.a|b\.v)\.?$', '').Trim()
    $roots = @($env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'), $env:ProgramData, $env:APPDATA, $env:LOCALAPPDATA, (Join-Path $env:LOCALAPPDATA 'Programs')) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
    $cand = @()
    if ($GB_IN.location) { $cand += $GB_IN.location }
    foreach ($r in $roots) {
      foreach ($n in $names) {
        $cand += Join-Path $r $n
        if ($pubShort -and $pubShort.Length -ge 3) { $cand += Join-Path (Join-Path $r $pubShort) $n }
      }
    }
    $found = @()
    foreach ($c in ($cand | Select-Object -Unique)) {
      if (-not (Test-Path -LiteralPath $c -PathType Container)) { continue }
      $size = (Get-ChildItem -LiteralPath $c -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
      $found += @{ path = (Resolve-Path -LiteralPath $c).ProviderPath; sizeMB = [math]::Round([double]$size / 1MB, 1) }
    }
    GB-Out @{ items = $found }
  }
}
`;

// Preinstalled Store apps that are safe to remove. Xbox/Gaming Services and the Store are never listed.
const BLOAT = [
  ["Clipchamp.Clipchamp", "Clipchamp (Videoeditor)"],
  ["Microsoft.BingNews", "Microsoft News"],
  ["Microsoft.BingWeather", "Wetter"],
  ["Microsoft.BingSearch", "Bing-Suche"],
  ["Microsoft.GetHelp", "Hilfe anfordern"],
  ["Microsoft.Getstarted", "Tipps"],
  ["Microsoft.MicrosoftSolitaireCollection", "Solitaire Collection"],
  ["Microsoft.MicrosoftOfficeHub", "Microsoft 365 (Office)"],
  ["Microsoft.People", "Kontakte"],
  ["Microsoft.WindowsFeedbackHub", "Feedback-Hub"],
  ["Microsoft.WindowsMaps", "Karten"],
  ["Microsoft.ZuneVideo", "Filme & TV"],
  ["Microsoft.549981C3F5F10", "Cortana"],
  ["Microsoft.MixedReality.Portal", "Mixed Reality-Portal"],
  ["Microsoft.Microsoft3DViewer", "3D-Viewer"],
  ["Microsoft.SkypeApp", "Skype"],
  ["Microsoft.Todos", "Microsoft To Do"],
  ["Microsoft.PowerAutomateDesktop", "Power Automate"],
  ["Microsoft.Windows.DevHome", "Dev Home"],
  ["Microsoft.OutlookForWindows", "Outlook (neu)"],
  ["microsoft.windowscommunicationsapps", "Mail und Kalender"],
  ["MicrosoftCorporationII.MicrosoftFamily", "Microsoft Family Safety"],
  ["Microsoft.YourPhone", "Smartphone-Link"],
  ["MSTeams", "Microsoft Teams (privat)"],
  ["MicrosoftTeams", "Microsoft Teams (privat, alt)"],
  ["Microsoft.Copilot", "Copilot"],
  ["Microsoft.Windows.Ai.Copilot.Provider", "Copilot-Anbieter"],
  ["*CandyCrush*", "Candy Crush"],
  ["*BubbleWitch*", "Bubble Witch"],
  ["king.com.*", "King-Spiele"],
  ["*Disney*", "Disney+"],
  ["*Facebook*", "Facebook"],
  ["*Instagram*", "Instagram"],
  ["*TikTok*", "TikTok"],
  ["AmazonVideo.PrimeVideo", "Prime Video"],
  ["*LinkedInforWindows*", "LinkedIn"],
];

export const BLOAT_PS = String.raw`
$list = @()
$pkgs = @(Get-AppxPackage | Where-Object { -not $_.IsFramework -and $_.SignatureKind -ne 'System' -and $_.Name -notmatch 'Xbox|GamingApp|GamingServices|WindowsStore|StorePurchaseApp|DesktopAppInstaller' })
if ($GB_IN.mode -eq 'remove') {
  $p = $pkgs | Where-Object { $_.PackageFullName -eq $GB_IN.fullName } | Select-Object -First 1
  if (-not $p) { throw 'App nicht gefunden.' }
  Remove-AppxPackage -Package $p.PackageFullName
  GB-Out @{ ok = $true; name = $p.Name; family = $p.PackageFamilyName }
  return
}
foreach ($b in $GB_IN.bloat) {
  foreach ($p in ($pkgs | Where-Object { $_.Name -like $b[0] })) {
    $list += @{ name = $b[1]; package = $p.Name; fullName = $p.PackageFullName; family = $p.PackageFamilyName; version = [string]$p.Version }
  }
}
GB-Out @{ items = $list }
`;

export async function listPrograms() {
  const r = await runPS(PROGRAMS_PS, { mode: "list" });
  const seen = new Set();
  return (r?.items || [])
    .filter((p) => { const k = `${p.name}|${p.version}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function uninstallProgram(id) {
  const r = await runPS(PROGRAMS_PS, { mode: "uninstall", id });
  updateState((s) => logHistory(s, { action: "app-uninstall", name: r.name }));
  return r;
}

export async function findLeftovers({ name, publisher = "", location = "" }) {
  if (!name) throw new Error("Programmname fehlt (--name)");
  const r = await runPS(PROGRAMS_PS, { mode: "leftovers", name, publisher, location });
  return r?.items || [];
}

export async function listBloat() {
  const r = await runPS(BLOAT_PS, { mode: "list", bloat: BLOAT });
  return r?.items || [];
}

export async function removeBloat(fullName) {
  const r = await runPS(BLOAT_PS, { mode: "remove", fullName });
  const name = BLOAT.find(([pattern]) => new RegExp(`^${pattern.replace(/[.]/g, "\\.").replace(/\*/g, ".*")}$`, "i").test(r.name))?.[1] || r.name;
  updateState((s) => logHistory(s, { action: "appx-remove", name, family: r.family }));
  return { ...r, name, store: `ms-windows-store://pdp/?PFN=${r.family}` };
}
