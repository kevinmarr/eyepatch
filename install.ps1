# Install (or update) Eyepatch's Agent Bridge on Windows, in PowerShell:
#
#   irm https://raw.githubusercontent.com/kevinmarr/eyepatch/main/install.ps1 | iex
#
# Downloads the latest release, checks it against the release's SHA256SUMS,
# puts it in %LOCALAPPDATA%\Eyepatch and registers it with every
# Chromium-based browser. Running it again updates Agent Bridge.
# Not yet tested on a real Windows machine.
$ErrorActionPreference = "Stop"

$repo = "kevinmarr/eyepatch"
if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64" -and $env:PROCESSOR_ARCHITEW6432 -ne "AMD64") {
  # Windows on Arm runs the x64 build under emulation.
  Write-Host "Eyepatch: no native build for $env:PROCESSOR_ARCHITECTURE; using x64."
}
$asset = "agent-bridge-windows-x64.zip"
$base = if ($env:EYEPATCH_VERSION) { "https://github.com/$repo/releases/download/v$($env:EYEPATCH_VERSION.TrimStart('v'))" } else { "https://github.com/$repo/releases/latest/download" }
$dir = Join-Path $env:LOCALAPPDATA "Eyepatch"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("eyepatch-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
  Write-Host "Downloading Agent Bridge for windows-x64..."
  $ProgressPreference = "SilentlyContinue" # Invoke-WebRequest is very slow with its progress bar
  Invoke-WebRequest "$base/$asset" -OutFile (Join-Path $tmp $asset) -UseBasicParsing
  Invoke-WebRequest "$base/SHA256SUMS" -OutFile (Join-Path $tmp "SHA256SUMS") -UseBasicParsing

  $line = Get-Content (Join-Path $tmp "SHA256SUMS") | Where-Object { ($_ -split '\s+')[1] -in @($asset, "*$asset") }
  if (-not $line) { throw "$asset isn't listed in SHA256SUMS" }
  $expected = ($line -split '\s+')[0]
  $actual = (Get-FileHash (Join-Path $tmp $asset) -Algorithm SHA256).Hash
  if ($expected -ne $actual.ToLower()) { throw "checksum mismatch for $asset" }

  Expand-Archive (Join-Path $tmp $asset) -DestinationPath $tmp -Force
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $exe = Join-Path $dir "agent-bridge.exe"
  # A running copy can't be overwritten, but it can be renamed out of the way.
  if (Test-Path $exe) {
    Remove-Item "$exe.old" -Force -ErrorAction SilentlyContinue
    Rename-Item $exe "agent-bridge.exe.old" -ErrorAction SilentlyContinue
  }
  Move-Item (Join-Path $tmp "agent-bridge.exe") $exe -Force

  & $exe install
  Write-Host "Installed Agent Bridge $(& $exe version) in $dir"
  Write-Host "Back in Chrome, Eyepatch's Settings page connects to it by itself."
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
