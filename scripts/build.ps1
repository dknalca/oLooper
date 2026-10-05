param(
    [switch]$Dev
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $Root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is required."
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw "pnpm is required. Install it with: corepack enable"
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "Rust is required. Install the stable MSVC toolchain with rustup."
}

pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw "pnpm install failed." }

node scripts/generate-icons.mjs
if ($LASTEXITCODE -ne 0) { throw "Icon generation failed." }
node scripts/generate-windows-icon.mjs
if ($LASTEXITCODE -ne 0) { throw "Windows icon generation failed." }
foreach ($Icon in @("src-tauri/icons/icon.ico", "src-tauri/icons/icon.png")) {
    if (-not (Test-Path -LiteralPath $Icon) -or (Get-Item -LiteralPath $Icon).Length -eq 0) {
        throw "Required Tauri icon is missing or empty: $Icon"
    }
}

if ($Dev) {
    pnpm run tauri build --debug --no-bundle
} else {
    pnpm run tauri build --bundles nsis
}
if ($LASTEXITCODE -ne 0) { throw "Tauri build failed." }

if ($Dev) {
    Write-Host "Development executable: src-tauri\target\debug\olooper.exe"
} else {
    $installer = Get-ChildItem -LiteralPath "src-tauri\target\release\bundle\nsis" -Filter "*.exe" -File |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $installer) {
        throw "Tauri build completed but no NSIS installer was found in src-tauri\target\release\bundle\nsis."
    }

    $tauriConfig = Get-Content -LiteralPath "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
    $installerDirectory = Join-Path $Root "dist\installers"
    New-Item -ItemType Directory -Path $installerDirectory -Force | Out-Null
    $installerName = "oLooper-$($tauriConfig.version)-windows-x64-setup.exe"
    $installerPath = Join-Path $installerDirectory $installerName
    Copy-Item -LiteralPath $installer.FullName -Destination $installerPath -Force
    Write-Host "Windows installer: $installerPath" -ForegroundColor Green
}
