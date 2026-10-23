// PowerShell bridge: every system change is executed through Windows PowerShell 5.1,
// which is present on every Windows 10/11 install and can compile inline C# (Add-Type).
import { execFile } from "node:child_process";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR } from "./state.js";

// Own temp dir so that the "clean temp files" action never deletes scripts in flight.
const TMP = join(DATA_DIR, "tmp");

const POWERSHELL = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

// Helpers prepended to every script. Registry access goes through .NET directly so that
// value kinds (DWord/String/Binary/...) round-trip exactly for backups.
export const PS_PRELUDE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# Always run the real executables (never e.g. powercfg.cpl, which opens the Control Panel).
foreach ($tool in 'powercfg', 'fsutil', 'ipconfig', 'netsh', 'net') {
  Set-Alias -Name $tool -Value (Join-Path $env:SystemRoot "System32\$tool.exe") -Scope Script
}

# Runs a native program and returns its exit code. Output (incl. stderr) is discarded – with
# $ErrorActionPreference = 'Stop', PowerShell 5.1 would otherwise treat any stderr line as an error.
function GB-Run([string]$exe, [string[]]$arguments) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & $exe @arguments 2>&1 | Out-Null; return $LASTEXITCODE } finally { $ErrorActionPreference = $old }
}

function GB-Hive([string]$h) {
  switch ($h) {
    'HKCU' { return [Microsoft.Win32.Registry]::CurrentUser }
    'HKLM' { return [Microsoft.Win32.Registry]::LocalMachine }
    default { throw "Unbekannter Hive: $h" }
  }
}

function GB-RegGet([string]$h, [string]$p, [string]$n) {
  $k = (GB-Hive $h).OpenSubKey($p)
  if (-not $k) { return @{ exists = $false } }
  try {
    $v = $k.GetValue($n, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($null -eq $v) { return @{ exists = $false } }
    $kind = $k.GetValueKind($n).ToString()
    if ($kind -eq 'DWord') { $v = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$v), 0) }
    elseif ($kind -eq 'Binary') { $v = [Convert]::ToBase64String([byte[]]$v) }
    elseif ($kind -eq 'MultiString') { $v = @($v) }
    return @{ exists = $true; kind = $kind; value = $v }
  } finally { $k.Close() }
}

function GB-RegSet([string]$h, [string]$p, [string]$n, [string]$kind, $v) {
  $k = (GB-Hive $h).CreateSubKey($p)
  try {
    switch ($kind) {
      'DWord'       { $v = [BitConverter]::ToInt32([BitConverter]::GetBytes([uint32]$v), 0) }
      'QWord'       { $v = [int64]$v }
      'Binary'      { $v = [Convert]::FromBase64String([string]$v) }
      'MultiString' { $v = [string[]]@($v) }
      default       { $v = [string]$v }
    }
    $k.SetValue($n, $v, [Microsoft.Win32.RegistryValueKind]$kind)
  } finally { $k.Close() }
}

function GB-RegDel([string]$h, [string]$p, [string]$n) {
  $k = (GB-Hive $h).OpenSubKey($p, $true)
  if ($k) { try { $k.DeleteValue($n, $false) } finally { $k.Close() } }
}

function GB-ActiveScheme {
  $out = powercfg /getactivescheme
  if ("$out" -match '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})') { return $Matches[1].ToLower() }
  return $null
}

# Returns the current AC index of a power setting (last two hex values of the query are AC, DC).
function GB-PowerGet([string]$sub, [string]$setting) {
  $out = powercfg /qh SCHEME_CURRENT $sub $setting 2>$null
  $hex = [regex]::Matches(($out -join "\n"), ':\s*0x([0-9a-fA-F]+)') | ForEach-Object { $_.Groups[1].Value }
  if (@($hex).Count -lt 2) { return $null }
  return [Convert]::ToInt64(@($hex)[-2], 16)
}

function GB-PowerSet([string]$sub, [string]$setting, [int64]$ac) {
  powercfg /setacvalueindex SCHEME_CURRENT $sub $setting $ac | Out-Null
  powercfg /setactive SCHEME_CURRENT | Out-Null
}

function GB-IsAdmin {
  return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function GB-Out($obj) { $obj | ConvertTo-Json -Depth 12 -Compress }
`;

/**
 * Runs a PowerShell script. `input` is made available as $GB_IN (parsed JSON).
 * The script's stdout is expected to be a single JSON document (use GB-Out).
 */
export async function runPS(script, input = null, { timeout = 180000 } = {}) {
  const id = randomBytes(6).toString("hex");
  const scriptFile = join(TMP, `gb-${id}.ps1`);
  const inputFile = join(TMP, `gb-${id}.json`);
  await mkdir(TMP, { recursive: true });
  const header = input !== null
    ? `$GB_IN = Get-Content -Raw -Encoding UTF8 -LiteralPath '${inputFile}' | ConvertFrom-Json\n`
    : "";
  // BOM so PowerShell 5.1 reads the script as UTF-8 (umlauts in messages).
  await writeFile(scriptFile, "\uFEFF" + PS_PRELUDE + header + script, "utf8");
  if (input !== null) await writeFile(inputFile, JSON.stringify(input), "utf8");

  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile(
        POWERSHELL,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptFile],
        { timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
        (err, out, errOut) => {
          if (err) {
            const msg = (errOut || "").trim() || err.message;
            reject(new Error(cleanPsError(msg)));
          } else resolve(out);
        },
      );
    });
    const text = stdout.trim();
    if (!text) return null;
    // The JSON document is the last non-empty line; anything before it is stray output.
    const last = text.split(/\r?\n/).filter(Boolean).pop();
    return JSON.parse(last);
  } finally {
    unlink(scriptFile).catch(() => {});
    if (input !== null) unlink(inputFile).catch(() => {});
  }
}

function cleanPsError(msg) {
  const first = msg.split(/\r?\n/).find((l) => l.trim() && !/^(At|In) /.test(l)) || msg;
  return first.trim();
}

/** Quote a JS string as a PowerShell single-quoted literal. */
export function psq(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}
