# Packages the built planche.exe as an MSIX for the Microsoft Store.
# Run after `npm run tauri build`. The package is unsigned: the Store signs it.
# Identity values come from Partner Center (Product identity page); the
# defaults only suit local tests. -Register installs the unpacked layout for a
# local test (needs Windows developer mode).
param(
  [string]$IdentityName = $(if ($env:MSSTORE_IDENTITY_NAME) { $env:MSSTORE_IDENTITY_NAME } else { "Planche.Dev" }),
  [string]$Publisher = $(if ($env:MSSTORE_PUBLISHER) { $env:MSSTORE_PUBLISHER } else { "CN=Planche Dev" }),
  [string]$PublisherDisplayName = $(if ($env:MSSTORE_PUBLISHER_DISPLAY_NAME) { $env:MSSTORE_PUBLISHER_DISPLAY_NAME } else { "catzguy" }),
  [switch]$Register
)
$ErrorActionPreference = "Stop"

$tauri = Join-Path $PSScriptRoot "..\src-tauri" | Resolve-Path
$config = Get-Content (Join-Path $tauri "tauri.conf.json") -Raw | ConvertFrom-Json
# The Store wants four parts with a zero revision: 1.2.3 -> 1.2.3.0.
$version = "$($config.version).0"
$exe = Join-Path $tauri "target\release\planche.exe"
if (-not (Test-Path $exe)) { throw "Build the app first (npm run tauri build): $exe not found" }

$makeappx = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\makeappx.exe" |
  Sort-Object { [version]$_.Directory.Parent.Name } | Select-Object -Last 1
if (-not $makeappx) { throw "makeappx.exe not found: install the Windows SDK" }

$out = Join-Path $tauri "target\release\bundle\msix"
$layout = Join-Path $out "layout"
Remove-Item $layout -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory (Join-Path $layout "Assets") -Force | Out-Null

Copy-Item $exe $layout
foreach ($logo in "StoreLogo", "Square44x44Logo", "Square71x71Logo", "Square150x150Logo") {
  Copy-Item (Join-Path $tauri "icons\$logo.png") (Join-Path $layout "Assets")
}

$values = @{
  IdentityName = $IdentityName
  Publisher = $Publisher
  PublisherDisplayName = $PublisherDisplayName
  Version = $version
}
$manifest = Get-Content (Join-Path $tauri "msix\AppxManifest.xml") -Raw
foreach ($key in $values.Keys) {
  $manifest = $manifest.Replace("`$($key)", [Security.SecurityElement]::Escape($values[$key]))
}
Set-Content (Join-Path $layout "AppxManifest.xml") $manifest -Encoding utf8

$package = Join-Path $out "Planche_$($config.version)_x64.msix"
& $makeappx.FullName pack /o /h SHA256 /d $layout /p $package
if ($LASTEXITCODE -ne 0) { throw "makeappx failed ($LASTEXITCODE)" }
Write-Host "MSIX: $package ($IdentityName $version, $Publisher)"

if ($Register) {
  Add-AppxPackage -Register (Join-Path $layout "AppxManifest.xml")
  Write-Host "Registered for testing; remove with: Get-AppxPackage $IdentityName | Remove-AppxPackage"
}
