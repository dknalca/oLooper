param(
    [switch]$Dev
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $Root

function Assert-X64Executable([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Expected target executable was not produced: $Path"
    }
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $reader = [System.IO.BinaryReader]::new($stream)
        if ($reader.ReadUInt16() -ne 0x5A4D) { throw "App output is not a PE executable: $Path" }
        $stream.Position = 0x3C
        $peOffset = $reader.ReadInt32()
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) { throw "App output has an invalid PE signature: $Path" }
        $machine = $reader.ReadUInt16()
        if ($machine -ne 0x8664) {
            throw "Expected an x64 app executable (PE machine 0x8664), found 0x$($machine.ToString('X4'))."
        }
    } finally {
        $stream.Dispose()
    }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is required."
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw "pnpm is required. Install it with: corepack enable"
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "Rust is required. Install the stable MSVC toolchain with rustup."
}
$WindowsTarget = "x86_64-pc-windows-msvc"
$installedTargets = rustup target list --installed
if ($LASTEXITCODE -ne 0 -or $installedTargets -notcontains $WindowsTarget) {
    throw "Rust target $WindowsTarget is required. Install it with: rustup target add $WindowsTarget"
}

pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw "pnpm install failed." }

node scripts/generate-windows-icon.mjs
if ($LASTEXITCODE -ne 0) { throw "Windows icon generation failed." }
foreach ($Icon in @("src-tauri/icons/icon.ico", "src-tauri/icons/icon.png")) {
    if (-not (Test-Path -LiteralPath $Icon) -or (Get-Item -LiteralPath $Icon).Length -eq 0) {
        throw "Required Tauri icon is missing or empty: $Icon"
    }
}

if ($Dev) {
    pnpm run tauri build --target $WindowsTarget --debug --no-bundle
} else {
    $buildStartedAt = Get-Date
    pnpm run tauri build --target $WindowsTarget --bundles nsis
}
if ($LASTEXITCODE -ne 0) { throw "Tauri build failed." }

if ($Dev) {
    Assert-X64Executable (Join-Path $Root "src-tauri\target\$WindowsTarget\debug\olooper.exe")
    Write-Host "Development executable: src-tauri\target\$WindowsTarget\debug\olooper.exe"
} else {
    Assert-X64Executable (Join-Path $Root "src-tauri\target\$WindowsTarget\release\olooper.exe")
    $bundleDirectory = Join-Path $Root "src-tauri\target\$WindowsTarget\release\bundle\nsis"
    $installer = Get-ChildItem -LiteralPath $bundleDirectory -Filter "*.exe" -File |
        Where-Object { $_.LastWriteTime -ge $buildStartedAt } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $installer) {
        throw "Tauri build completed but no fresh NSIS installer was found for $WindowsTarget."
    }

    $tauriConfig = Get-Content -LiteralPath "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
    $installerDirectory = Join-Path $Root "dist\installers"
    New-Item -ItemType Directory -Path $installerDirectory -Force | Out-Null
    $installerName = "oLooper-$($tauriConfig.version)-windows-x64-setup.exe"
    $installerPath = Join-Path $installerDirectory $installerName
    Copy-Item -LiteralPath $installer.FullName -Destination $installerPath -Force
    Write-Host "Windows installer: $installerPath" -ForegroundColor Green
}
