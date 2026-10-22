# GameBoost – Installation per Einzeiler:
#   irm https://raw.githubusercontent.com/Delido/gameboost/main/install.ps1 | iex
# Lädt den neuesten Installer aus den GitHub-Releases und startet ihn.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$release = Invoke-RestMethod -Uri 'https://api.github.com/repos/Delido/gameboost/releases/latest' -Headers @{ 'User-Agent' = 'GameBoost-Installer' }
$asset = $release.assets | Where-Object { $_.name -like 'GameBoost-Setup-*.exe' } | Select-Object -First 1
if (-not $asset) { throw 'Im neuesten Release wurde kein Installer gefunden.' }

$file = Join-Path $env:TEMP $asset.name
Write-Host "Lade GameBoost $($release.tag_name) herunter …"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $file -UseBasicParsing
if ($asset.digest -match '^sha256:(.+)$' -and (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $Matches[1]) {
  Remove-Item -LiteralPath $file -Force
  throw 'Prüfsumme stimmt nicht – Download abgebrochen.'
}
Write-Host 'Starte Installer …'
Start-Process -FilePath $file -Wait
Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
