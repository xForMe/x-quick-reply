[CmdletBinding()]
param(
    [string]$PythonCommand = "python"
)

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

& (Join-Path $PSScriptRoot "stop-gateway.ps1") | Out-Null
if (-not (Get-Command $PythonCommand -ErrorAction SilentlyContinue)) {
    throw "启动失败：找不到 Python 命令 $PythonCommand"
}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$port = Get-ConfiguredPort
$stdout = Join-Path $LogDir "gateway.log"
$stderr = Join-Path $LogDir "gateway.error.log"
$process = Start-Process -FilePath $PythonCommand -ArgumentList @($GatewayPath) -WorkingDirectory $RootDir -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
$process.Id | Set-Content -LiteralPath $PidFile -NoNewline

for ($attempt = 0; $attempt -lt 50; $attempt++) {
    if ($process.HasExited) {
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
        throw "启动失败：网关进程已退出"
    }
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/health" -Headers @{ Origin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } -TimeoutSec 1
        $health = $response.Content | ConvertFrom-Json
        if ($response.StatusCode -eq 200 -and $health.ok -eq $true) {
            Write-Output "网关已启动：http://127.0.0.1:$port（PID $($process.Id)）"
            exit 0
        }
    } catch { }
    Start-Sleep -Milliseconds 100
}

& (Join-Path $PSScriptRoot "stop-gateway.ps1") | Out-Null
throw "启动失败：网关未在预期时间内通过健康检查"
