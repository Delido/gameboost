// Context menu manager: lists third-party right-click entries (shell extensions, shell verbs and
// entries of Store/packaged apps) and hides them per user. Nothing is deleted:
// - shell extensions / app entries: CLSID in HKCU\...\Shell Extensions\Blocked
// - shell verbs: "LegacyDisable" in an HKCU overlay of the verb key
import { runPS } from "./ps.js";
import { updateState, logHistory } from "./state.js";

export const CTX_PS = String.raw`
$blockedKey = 'Software\Microsoft\Windows\CurrentVersion\Shell Extensions\Blocked'
$locations = [ordered]@{
  '*' = 'Dateien'; 'AllFilesystemObjects' = 'Dateien & Ordner'; 'Directory' = 'Ordner'; 'Directory\Background' = 'Ordner-Hintergrund'
  'Folder' = 'Ordner'; 'Drive' = 'Laufwerke'; 'DesktopBackground' = 'Desktop'; 'exefile' = 'Programme'; 'lnkfile' = 'Verknüpfungen'
}
$cr = [Microsoft.Win32.Registry]::ClassesRoot

$GB_PUB = @{}
function GB-Publisher([string]$path) {
  if (-not $path) { return '' }
  $path = [Environment]::ExpandEnvironmentVariables($path.Trim('"'))
  if (-not $GB_PUB.ContainsKey($path)) {
    $pub = ''
    try { if (Test-Path -LiteralPath $path -PathType Leaf) { $pub = [string]([Diagnostics.FileVersionInfo]::GetVersionInfo($path).CompanyName) } } catch {}
    $GB_PUB[$path] = $pub.Trim()
  }
  return $GB_PUB[$path]
}
function GB-Default($key) { if ($key) { return [string]$key.GetValue('') } return '' }
function GB-IsBlocked([string]$clsid) {
  foreach ($h in 'HKCU', 'HKLM') { if ((GB-RegGet $h $blockedKey $clsid).exists) { return $true } }
  return $false
}

function GB-ListCtx([bool]$all) {
  $ext = [ordered]@{}
  $verbs = @()
  foreach ($cls in $locations.Keys) {
    # Shell extensions (COM handlers)
    $hk = $cr.OpenSubKey("$cls\shellex\ContextMenuHandlers")
    if ($hk) {
      foreach ($hn in $hk.GetSubKeyNames()) {
        $sk = $hk.OpenSubKey($hn)
        $clsid = if ($hn -match '^\{[0-9A-Fa-f-]{36}\}$') { $hn } else { GB-Default $sk }
        if ($sk) { $sk.Close() }
        if ($clsid -notmatch '^\{[0-9A-Fa-f-]{36}\}$') { continue }
        $clsid = $clsid.ToUpper()
        if ($ext.Contains($clsid)) { if ($ext[$clsid].locations -notcontains $locations[$cls]) { $ext[$clsid].locations += $locations[$cls] }; continue }
        $ck = $cr.OpenSubKey("CLSID\$clsid")
        $name = GB-Default $ck
        $dll = GB-Default ($cr.OpenSubKey("CLSID\$clsid\InprocServer32"))
        if ($ck) { $ck.Close() }
        $pub = GB-Publisher $dll
        $ms = $pub -match 'Microsoft' -or (-not $pub -and -not $dll)
        if ($ms -and -not $all) { continue }
        if (-not $name -or $name -match '^\{') { $name = $hn }
        $ext[$clsid] = @{ id = "EXT|$clsid"; kind = 'extension'; name = $name.Trim(); publisher = $pub; path = $dll; locations = @($locations[$cls]); enabled = -not (GB-IsBlocked $clsid); microsoft = $ms }
      }
      $hk.Close()
    }
    # Shell verbs (registry commands)
    $vk = $cr.OpenSubKey("$cls\shell")
    if ($vk) {
      foreach ($vn in $vk.GetSubKeyNames()) {
        if ($vn -like 'GameBoost.*') { continue }
        $sk = $vk.OpenSubKey($vn)
        if (-not $sk) { continue }
        $cmd = GB-Default ($sk.OpenSubKey('command'))
        $label = [string]$sk.GetValue('MUIVerb'); if (-not $label) { $label = GB-Default $sk }; if (-not $label -or $label.StartsWith('@')) { $label = $vn }
        $hidden = $null -ne $sk.GetValue('LegacyDisable') -or $null -ne $sk.GetValue('ProgrammaticAccessOnly')
        $sk.Close()
        if (-not $cmd) { continue }
        $ours = (GB-RegGet 'HKCU' "Software\Classes\$cls\shell\$vn" 'LegacyDisable').exists
        if ($hidden -and -not $ours) { continue }
        $exe = $null
        $c = [Environment]::ExpandEnvironmentVariables($cmd.Trim())
        if ($c.StartsWith('"')) { $e = $c.IndexOf('"', 1); if ($e -gt 1) { $exe = $c.Substring(1, $e - 1) } }
        elseif ($c -match '^(.+?\.exe)(\s|$)') { $exe = $Matches[1] }
        if (-not $exe -or -not (Test-Path -LiteralPath $exe -PathType Leaf -ErrorAction SilentlyContinue)) { continue }
        $pub = GB-Publisher $exe
        $ms = $pub -match 'Microsoft'
        if ($ms -and -not $all) { continue }
        $verbs += @{ id = "VERB|$cls|$vn"; kind = 'verb'; name = ($label -replace '&', '').Trim(); publisher = $pub; path = $cmd; locations = @($locations[$cls]); enabled = -not $ours; microsoft = $ms }
      }
      $vk.Close()
    }
  }

  # Entries of packaged apps (Windows 11 menu: e.g. 7-Zip, VS Code, Clipchamp, Paint, Terminal)
  $apps = @()
  foreach ($p in Get-AppxPackage) {
    if ($p.IsFramework -or $p.IsResourcePackage -or -not $p.InstallLocation) { continue }
    $mf = Join-Path $p.InstallLocation 'AppxManifest.xml'
    if (-not (Test-Path -LiteralPath $mf)) { continue }
    $txt = [IO.File]::ReadAllText($mf)
    if ($txt -notmatch 'FileExplorerContextMenus') { continue }
    $pub = if ($p.Publisher -match 'CN=([^,]+)') { $Matches[1].Trim('"') } else { '' }
    $ms = $pub -match 'Microsoft'
    if ($ms -and -not $all -and $p.SignatureKind -eq 'System') { continue }
    $dn = $p.Name
    if ($txt -match '<DisplayName>([^<]+)</DisplayName>' -and $Matches[1] -notlike 'ms-resource*') { $dn = $Matches[1] }
    $seen = @{}
    foreach ($m in [regex]::Matches($txt, '<(?:\w+:)?Verb\b[^>]*\bClsid="(\{[0-9A-Fa-f-]{36}\})"')) {
      $clsid = $m.Groups[1].Value.ToUpper()
      if ($seen.ContainsKey($clsid) -or $ext.Contains($clsid)) { continue }
      $seen[$clsid] = $true
      $apps += @{ id = "EXT|$clsid"; kind = 'app'; name = $dn; publisher = $pub; path = $p.PackageFamilyName; locations = @('Windows-11-Menü'); enabled = -not (GB-IsBlocked $clsid); microsoft = $ms }
    }
  }
  return @($ext.Values) + $verbs + $apps
}

switch ($GB_IN.mode) {
  'list' { GB-Out @{ items = @(GB-ListCtx ([bool]$GB_IN.all)) } }
  'set' {
    $e = [bool]$GB_IN.enabled
    $p = $GB_IN.id.Split('|', 3)
    if ($p[0] -eq 'EXT') {
      if ($e) {
        GB-RegDel 'HKCU' $blockedKey $p[1]
        if ((GB-RegGet 'HKLM' $blockedKey $p[1]).exists) {
          if (-not (GB-IsAdmin)) { throw 'Dieser Eintrag ist systemweit blockiert – zum Freigeben sind Administratorrechte nötig.' }
          GB-RegDel 'HKLM' $blockedKey $p[1]
        }
      } else { GB-RegSet 'HKCU' $blockedKey $p[1] 'String' '' }
    } elseif ($p[0] -eq 'VERB' -and $p.Count -eq 3) {
      $k = "Software\Classes\$($p[1])\shell\$($p[2])"
      if ($e) {
        GB-RegDel 'HKCU' $k 'LegacyDisable'
        $sk = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($k)
        if ($sk) { $empty = $sk.ValueCount -eq 0 -and $sk.SubKeyCount -eq 0; $sk.Close(); if ($empty) { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($k, $false) } }
      } else { GB-RegSet 'HKCU' $k 'LegacyDisable' 'String' '' }
    } else { throw "Ungültiger Kontextmenü-Eintrag: $($GB_IN.id)" }
    GB-Out @{ ok = $true }
  }
}
`;

export async function listContextMenu({ all = false } = {}) {
  const r = await runPS(CTX_PS, { mode: "list", all });
  return (r?.items || []).sort((a, b) => a.name.localeCompare(b.name));
}

export async function setContextMenu(id, enabled, name = null) {
  if (!id) throw new Error("Kein Kontextmenü-Eintrag angegeben");
  await runPS(CTX_PS, { mode: "set", id, enabled });
  updateState((s) => logHistory(s, { action: enabled ? "ctx-enable" : "ctx-disable", name: name || id }));
  return { id, enabled };
}
