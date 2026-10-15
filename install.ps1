# Codex WorkBuddy Suite - Windows bootstrap.
# Downloads a fixed, checksum-verified release, then runs the local installer.
$ErrorActionPreference = 'Stop'
$SuiteVersion = '0.3.1'
$Repo = 'ztg-pty/codex-workbuddy-suite'
$NodeVersion = '24.15.0'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$arch = if ([Environment]::Is64BitOperatingSystem) {
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
} else { throw 'Codex WorkBuddy Suite requires a 64-bit Windows installation.' }

$nodeFolder = "node-v$NodeVersion-win-$arch"
$nodeZip = "$nodeFolder.zip"
$root = Join-Path $env:LOCALAPPDATA 'CodexWorkBuddySuite'
$tools = Join-Path $root 'node'
$nodeExe = Join-Path $tools "$nodeFolder\node.exe"

if (-not (Test-Path -LiteralPath $nodeExe)) {
    Write-Host "Downloading Node.js $NodeVersion ($arch)..."
    New-Item -ItemType Directory -Force -Path $tools | Out-Null
    $zipPath = Join-Path $tools $nodeZip
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$NodeVersion/$nodeZip" -OutFile $zipPath
    $toolchain = Invoke-RestMethod -UseBasicParsing -Uri "https://raw.githubusercontent.com/$Repo/main/toolchain.json"
    $expected = $toolchain.sha256.$nodeZip
    if (-not $expected) { throw "toolchain.json has no checksum for $nodeZip" }
    $actual = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected.ToLower()) { throw "Node.js archive checksum mismatch for $nodeZip" }
    Expand-Archive -LiteralPath $zipPath -DestinationPath $tools -Force
    Remove-Item -LiteralPath $zipPath
}

$archive = Join-Path $env:TEMP "codex-workbuddy-suite-$SuiteVersion.tar.gz"
$srcRoot = Join-Path $root 'src'
$srcArchive = Join-Path $srcRoot 'suite.tar.gz'
New-Item -ItemType Directory -Force -Path $srcRoot | Out-Null
Write-Host "Downloading Codex WorkBuddy Suite $SuiteVersion..."
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$Repo/archive/refs/tags/v$SuiteVersion.tar.gz" -OutFile $srcArchive
if (Test-Path -LiteralPath $srcRoot\codex-workbuddy-suite-$SuiteVersion) { Remove-Item -Recurse -Force -LiteralPath $srcRoot\codex-workbuddy-suite-$SuiteVersion }
& tar.exe -xzf $srcArchive -C $srcRoot
if ($LASTEXITCODE -ne 0) { throw 'Failed to extract the release archive (tar.exe).' }

$suiteRoot = Join-Path $srcRoot "codex-workbuddy-suite-$SuiteVersion"
$env:PATH = (Split-Path $nodeExe -Parent) + [IO.Path]::PathSeparator + $env:PATH
Write-Host 'Starting Codex WorkBuddy Suite setup...'
& $nodeExe (Join-Path $suiteRoot 'scripts\bootstrap-runtime.mjs')
exit $LASTEXITCODE
