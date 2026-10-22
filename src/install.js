// Creates Start menu (and optionally desktop) shortcuts that launch the UI elevated and
// without a console window. Being in the Start menu also makes GameBoost findable in Raycast.
import { fileURLToPath } from "node:url";
import { runPS } from "./ps.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

export const INSTALL_PS = String.raw`
$targets = @([Environment]::GetFolderPath('Programs'))
if ($GB_IN.desktop) { $targets += [Environment]::GetFolderPath('Desktop') }
$sh = New-Object -ComObject WScript.Shell
$made = @()
foreach ($dir in $targets) {
  $lnk = Join-Path $dir 'GameBoost.lnk'
  $s = $sh.CreateShortcut($lnk)
  $s.TargetPath = "$env:SystemRoot\System32\conhost.exe"
  $s.Arguments = '--headless "' + $GB_IN.node + '" "' + $GB_IN.cli + '" ui'
  $s.WorkingDirectory = $GB_IN.root
  $s.IconLocation = $GB_IN.icon
  $s.Description = 'GameBoost – Gaming-Optimierer'
  $s.Save()
  # Set the "Run as administrator" flag (byte 0x15, bit 0x20 of the shell link header)
  $bytes = [IO.File]::ReadAllBytes($lnk)
  $bytes[0x15] = $bytes[0x15] -bor 0x20
  [IO.File]::WriteAllBytes($lnk, $bytes)
  $made += $lnk
}
GB-Out @{ shortcuts = $made }
`;

export async function installShortcuts({ desktop = false } = {}) {
  return runPS(INSTALL_PS, {
    desktop,
    node: process.execPath,
    cli: fileURLToPath(new URL("../bin/gameboost.js", import.meta.url)),
    root: ROOT,
    icon: fileURLToPath(new URL("../ui/icon.ico", import.meta.url)),
  });
}

// Removes what the installation added outside the app folder (shortcuts and the own context menu
// verbs). Scheduled tasks are removed by the `cleanup` command, optimizations by `revert --all`.
export const UNINSTALL_PS = String.raw`
$removed = @()
foreach ($dir in [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop')) {
  $lnk = Join-Path $dir 'GameBoost.lnk'
  if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force; $removed += $lnk }
}
foreach ($cls in 'exefile', 'lnkfile', '*', 'Directory') {
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Software\Classes\$cls\shell")
  if (-not $k) { continue }
  $names = @($k.GetSubKeyNames() | Where-Object { $_ -like 'GameBoost.*' }); $k.Close()
  foreach ($n in $names) { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree("Software\Classes\$cls\shell\$n", $false); $removed += "HKCU\Software\Classes\$cls\shell\$n" }
}
GB-Out @{ removed = $removed }
`;

export async function removeShortcuts() {
  return runPS(UNINSTALL_PS);
}
