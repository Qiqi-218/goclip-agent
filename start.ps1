# 启动 goclip DSH 视频剪辑助手
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '找不到 node' }
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { throw '找不到 ffmpeg' }
$env:DSH_HOME = "$root\runtime\home"
$env:GOCLIP_RUNTIME = "$root\runtime"
$envFile = "$root\runtime\.env.ps1"
if (-not (Test-Path $envFile)) { throw "缺少 $envFile" }
. $envFile
& node "$root\runtime\start-dsh.mjs"
