$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell window (Run as administrator). Visual Studio Build Tools requires administrator rights."
}

$winget = Get-Command winget -ErrorAction SilentlyContinue
if (-not $winget) {
    throw "winget was not found. Install 'App Installer' from Microsoft Store, then run this script again."
}

function Install-WingetPackage([string]$Id, [string]$Override = "") {
    Write-Host "Installing $Id..." -ForegroundColor Cyan
    $arguments = @(
        "install", "--exact", "--id", $Id,
        "--source", "winget",
        "--accept-source-agreements", "--accept-package-agreements"
    )
    if ($Override) {
        $arguments += @("--override", $Override)
    } else {
        $arguments += "--silent"
    }

    & $winget.Source @arguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq -1978335189) {
        Write-Host "$Id is already installed; continuing." -ForegroundColor DarkYellow
    } elseif ($exitCode -ne 0) {
        throw "winget failed to install $Id (exit code $exitCode)."
    }
}

function Get-VcBuildToolsPath {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path -LiteralPath $vswhere)) { return $null }
    $path = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($LASTEXITCODE -eq 0 -and $path) { return $path.Trim() }
    return $null
}

Install-WingetPackage "OpenJS.NodeJS.LTS"
Install-WingetPackage "Rustlang.Rustup"
Install-WingetPackage "Microsoft.EdgeWebView2Runtime"
$vsPath = Get-VcBuildToolsPath
if (-not $vsPath) {
    try {
        Install-WingetPackage "Microsoft.VisualStudio.2022.BuildTools" `
            "--wait --quiet --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
        $vsPath = Get-VcBuildToolsPath
        if (-not $vsPath) {
            throw "winget returned, but the Visual C++ tools component is not installed."
        }
    } catch {
        # The VS bootstrapper can report a failure even if the requested workload
        # completed (for example, when it requests a restart). Verify the actual
        # C++ compiler component before treating the installation as successful.
        $vsPath = Get-VcBuildToolsPath
        if (-not $vsPath) {
            $logs = Get-ChildItem -LiteralPath $env:TEMP -Filter "dd_*" -File -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First 3 -ExpandProperty FullName
            $logHint = if ($logs) { " Recent Visual Studio logs: $($logs -join '; ')" } else { " Check Visual Studio Installer for its installation log." }
            throw "Visual Studio C++ Build Tools did not install successfully. Open Visual Studio Installer, select Build Tools 2022 > Modify, and install 'Desktop development with C++'.$logHint Original error: $($_.Exception.Message)"
        }
        Write-Host "Visual Studio C++ tools are present at $vsPath; continuing." -ForegroundColor DarkYellow
    }
}

# Newly installed programs may not yet be in this PowerShell process's PATH.
$env:Path = @(
    [Environment]::GetEnvironmentVariable("Path", "Machine"),
    [Environment]::GetEnvironmentVariable("Path", "User"),
    (Join-Path $HOME ".cargo\bin"),
    (Join-Path $env:ProgramFiles "nodejs")
) -join ";"

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
    throw "Node.js was installed, but npm.cmd was not found. Restart PowerShell and rerun this script."
}
Write-Host "Installing pnpm..." -ForegroundColor Cyan
& $npm.Source install --global pnpm
if ($LASTEXITCODE -ne 0) { throw "Could not install pnpm using npm." }

$rustupPath = Join-Path $HOME ".cargo\bin\rustup.exe"
if (-not (Test-Path -LiteralPath $rustupPath)) {
    throw "rustup was installed, but $rustupPath was not found. Restart PowerShell and rerun this script."
}
& $rustupPath toolchain install stable-x86_64-pc-windows-msvc --profile minimal
if ($LASTEXITCODE -ne 0) { throw "Could not install the Rust MSVC toolchain." }
& $rustupPath default stable-x86_64-pc-windows-msvc
if ($LASTEXITCODE -ne 0) { throw "Could not set the default Rust toolchain." }

Write-Host ""
Write-Host "Windows build prerequisites installed." -ForegroundColor Green
Write-Host "Close and reopen PowerShell, then run from the oLooper repository:"
Write-Host "  .\scripts\build.ps1"
Write-Host "Use .\scripts\build.ps1 -Dev for an unbundled debug executable."
