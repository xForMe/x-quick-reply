[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LogDir = Join-Path $RootDir "logs"
$PidFile = Join-Path $LogDir "gateway.pid"
$GatewayPath = [System.IO.Path]::GetFullPath((Join-Path $RootDir "gateway.py"))
$EnvFile = Join-Path $RootDir ".env"

function Get-ConfiguredPort {
    if (-not (Test-Path -LiteralPath $EnvFile)) { return 8787 }
    $line = Get-Content -LiteralPath $EnvFile | Where-Object { $_ -match '^[\s]*QUICK_REPLY_PORT[\s]*=' } | Select-Object -Last 1
    if ($line -and $line -match '^[\s]*QUICK_REPLY_PORT[\s]*=\s*([0-9]+)') { return [int]$Matches[1] }
    return 8787
}

function Test-GatewayProcess([object]$Process) {
    if (-not $Process.CommandLine) { return $false }
    if ($Process.CommandLine.IndexOf($GatewayPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    return $listeningPids -contains [int]$Process.ProcessId -and $Process.CommandLine -match '(?i)(^|[\s"\\/])gateway\.py([\s"]|$)'
}

$port = Get-ConfiguredPort
$listeningPids = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
$targets = @()
if (Test-Path -LiteralPath $PidFile) {
    $pidText = (Get-Content -LiteralPath $PidFile -Raw).Trim()
    if ($pidText -match '^[0-9]+$') {
        $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $pidText" -ErrorAction SilentlyContinue
        if ($candidate -and (Test-GatewayProcess $candidate)) { $targets += $candidate }
    }
}

# Also find instances started outside the launcher when their command line has
# a gateway.py basename and it owns the configured listening port.
$targets += Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessId -ne $PID -and (Test-GatewayProcess $_) }

foreach ($target in $targets | Sort-Object ProcessId -Unique) {
    Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
Write-Output "网关已停止（如存在可识别的实例）"
