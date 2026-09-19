[CmdletBinding()]
param(
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectRoot

function Find-Executable {
    param(
        [Parameter(Mandatory)] [string]$Command,
        [Parameter(Mandatory)] [string[]]$Candidates
    )

    $resolved = Get-Command $Command -ErrorAction SilentlyContinue
    if ($resolved) { return $resolved.Source }

    foreach ($candidate in $Candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    throw "Cannot find $Command. Install the prerequisites listed in README.md."
}

$runtimeRoot = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies"
$nodePath = Find-Executable -Command "node" -Candidates @(
    (Join-Path $runtimeRoot "node\bin\node.exe"),
    "C:\Program Files\nodejs\node.exe"
)
$pnpmPath = Find-Executable -Command "pnpm" -Candidates @(
    (Join-Path $runtimeRoot "bin\fallback\pnpm.cmd"),
    "C:\Program Files\nodejs\pnpm.cmd"
)
$cargoPath = Find-Executable -Command "cargo" -Candidates @(
    (Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe")
)

$vcvarsCandidates = @(
    "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
    "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat",
    "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat",
    "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat"
)
$vcvarsPath = $vcvarsCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $vcvarsPath) {
    throw "Cannot find Visual Studio 2022 C++ Build Tools (vcvars64.bat)."
}

$env:Path = "$(Split-Path -Parent $nodePath);$(Split-Path -Parent $cargoPath);$env:Path"

Write-Host ""
Write-Host "Paperlight Windows build" -ForegroundColor Cyan
Write-Host "Project: $projectRoot"
Write-Host "Node: $nodePath"
Write-Host "Cargo: $cargoPath"
Write-Host ""

if (-not $SkipInstall) {
    Write-Host "[1/2] Checking frontend dependencies..." -ForegroundColor Yellow
    & $pnpmPath install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed." }
}

Write-Host "[2/2] Building the NSIS installer..." -ForegroundColor Yellow
$buildCommand = 'call "{0}" && set "PATH={1};{2};%PATH%" && "{3}" tauri build --bundles nsis' -f @(
    $vcvarsPath,
    (Split-Path -Parent $nodePath),
    (Split-Path -Parent $cargoPath),
    $pnpmPath
)
& cmd.exe /d /s /c $buildCommand
if ($LASTEXITCODE -ne 0) { throw "Tauri build failed." }

$bundlePath = Join-Path $projectRoot "src-tauri\target\release\bundle\nsis"
$installer = Get-ChildItem -LiteralPath $bundlePath -Filter "*-setup.exe" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $installer) { throw "Build finished, but no installer was found." }

Write-Host ""
Write-Host "Build succeeded" -ForegroundColor Green
Write-Host "Installer: $($installer.FullName)"
Write-Host "Size: $([math]::Round($installer.Length / 1MB, 2)) MB"
