# 启动 goclip 智能剪辑助手（两个进程）
#
#   goclip = 剪辑服务（apps/video-agent，Go） + 智能体基座（platform/dsh，TypeScript/Node）
#
# 用法：
#   pwsh -File .\start.ps1              # 两个都起
#   pwsh -File .\start.ps1 -Only dsh    # 只起智能体（服务已在跑时）
#   pwsh -File .\start.ps1 -Only agent  # 只起剪辑服务
#
# 首次使用前请先跑 .\setup.ps1（安装依赖并构建）。

param(
  [ValidateSet('both', 'agent', 'dsh')]
  [string]$Only = 'both',
  [int]$AgentPort = 8090,
  [int]$DshPort = 8099
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$nodeDir = 'C:\Program Files\nodejs'
if (-not (Test-Path "$nodeDir\node.exe")) { throw "找不到 node：$nodeDir\node.exe" }

# ── 与其它 DSH 安装彻底分开 ──────────────────────────────────────────────────
# DSH 的数据目录由 DSH_HOME 决定（默认 ~/.dsh）。指向本包自己的 runtime\home，
# 于是 profiles / sessions / 工作区全部落在包内，不碰用户机器上的任何 DSH。
$env:DSH_HOME = "$root\runtime\home"
$env:GOCLIP_RUNTIME = "$root\runtime"     # profile 读它决定会话工作区落点
New-Item -ItemType Directory -Force -Path $env:DSH_HOME | Out-Null
New-Item -ItemType Directory -Force -Path "$root\runtime\workspace" | Out-Null

# ── 模型配置进环境 ──────────────────────────────────────────────────────────
# 直接 dot-source：.env.ps1 会先用临时变量再赋给 $env:，逐行正则解析会把字面量
# 塞进环境，密钥就废了（实测 keylen=6）。dot-source 让 PowerShell 自己求值。
$envFile = "$root\apps\video-agent\.env.ps1"
if (Test-Path $envFile) {
  . $envFile
} else {
  Write-Warning "缺少 $envFile —— 模型会显示未配置"
}
if (-not $env:AUTOCLIP_TEXT_API_KEY -or $env:AUTOCLIP_TEXT_API_KEY -like '<*') {
  Write-Warning "apps\video-agent\.env.ps1 里还是模板占位符，请填入真实密钥后再启动"
}

$env:PATH = "$nodeDir;$env:PATH"
$env:VIDEO_AGENT_ALLOWED_ORIGINS = "http://127.0.0.1:$DshPort,http://localhost:$DshPort"

# 镜头切分用 PySceneDetect。没配这一项时 shots 会明确报「未配置」，
# 而不是假装「这个视频没有切点」。
$shotsPython = "$root\.venv\Scripts\python.exe"
if (Test-Path $shotsPython) { $env:VIDEO_AGENT_SHOTS_PYTHON = $shotsPython }

"goclip : $root"
"model  : $env:AUTOCLIP_TEXT_MODEL  (key length $($env:AUTOCLIP_TEXT_API_KEY.Length))"
"origin : $env:VIDEO_AGENT_ALLOWED_ORIGINS"
"home   : $env:DSH_HOME"

if ($Only -in @('both', 'agent')) {
  $exe = "$root\apps\video-agent\bin\video-agent.exe"
  if (-not (Test-Path $exe)) { throw "找不到 $exe —— 先跑 .\setup.ps1 或 go build -o bin\video-agent.exe .\cmd\video-agent" }
  Start-Process -FilePath $exe -WindowStyle Hidden `
    -ArgumentList '--data', "$root\apps\video-agent\data", 'serve', '--addr', "127.0.0.1:$AgentPort"
  Start-Sleep -Seconds 3
  $up = [bool](Get-NetTCPConnection -LocalPort $AgentPort -State Listen -ErrorAction SilentlyContinue)
  "agent  : http://127.0.0.1:$AgentPort  up=$up"
}

if ($Only -in @('both', 'dsh')) {
  # profile 已安装在 runtime\home\profiles\video（由 setup.ps1 完成）。
  $dshSrc = "$root\platform\dsh"
  Push-Location $dshSrc
  try {
    "dsh    : $dshSrc"
    & node --import tsx/esm apps/cli/src/bin.ts --profile video `
        --host 127.0.0.1 --port $DshPort --no-open
  } finally {
    Pop-Location
  }
}
