[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LogDir = Join-Path $RootDir "logs"
$PidFile = Join-Path $LogDir "gateway.pid"
$GatewayPath = [System.IO.Path]::GetFullPath((Join-Path $RootDir "gateway.py"))

function Test-GatewayProcess([object]$Process) {
    if (-not $Process.CommandLine) { return $false }
    return $Process.CommandLine.IndexOf($GatewayPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

$targets = @()
if (Test-Path -LiteralPath $PidFile) {
    $pidText = (Get-Content -LiteralPath $PidFile -Raw).Trim()
    if ($pidText -match '^[0-9]+$') {
        $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $pidText" -ErrorAction SilentlyContinue
        if ($candidate -and (Test-GatewayProcess $candidate)) { $targets += $candidate }
    }
}

# Also find instances started outside the launcher when their command line has
# the absolute gateway path. An unrelated Python process is never terminated.
$targets += Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessId -ne $PID -and (Test-GatewayProcess $_) }

foreach ($target in $targets | Sort-Object ProcessId -Unique) {
    Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
Write-Output "网关已停止（如存在可识别的实例）"
