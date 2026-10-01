# goclip 智能剪辑助手 —— 一次性安装
#
# 做三件事：
#   1) 构建剪辑服务（Go）
#   2) 安装并构建智能体基座（Node + pnpm）
#   3) 把 profile 装进本包自己的 runtime\home
#
# 前置：Go 1.27+、Node ^22.19 || >=24、pnpm、FFmpeg（在 PATH 中）。
# 跑完用 .\start.ps1 启动。

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$nodeDir = 'C:\Program Files\nodejs'
$env:PATH = "$nodeDir;$env:PATH"

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Need($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "缺少 $cmd —— $hint" }
}

Step 1 '检查前置工具'
Need go '安装 Go 1.27+'
Need node '安装 Node ^22.19 或 >=24'
Need pnpm 'npm i -g pnpm'
Need ffmpeg '安装 FFmpeg 并加入 PATH'
foreach ($c in 'go','node','pnpm','ffmpeg') {
  $v = (& $c --version 2>&1 | Select-Object -First 1)
  "  $c : $v"
}

Step 2 '构建剪辑服务'
Push-Location "$root\apps\video-agent"
& go build -o bin\video-agent.exe ./cmd/video-agent
if ($LASTEXITCODE -ne 0) { throw 'go build 失败' }
"  -> apps\video-agent\bin\video-agent.exe"
& go test ./... 2>&1 | Select-String -Pattern '^FAIL' | ForEach-Object { "  $_" }
Pop-Location

Step 3 '安装智能体基座依赖'
Push-Location "$root\platform\dsh"
& pnpm install
if ($LASTEXITCODE -ne 0) { throw 'pnpm install 失败' }
Step 4 '构建智能体基座（tsc + tsdown，约 1-3 分钟）'
& pnpm run build
if ($LASTEXITCODE -ne 0) { throw 'pnpm run build 失败' }
Pop-Location

Step 5 '安装 profile 到本包 runtime\home'
$env:DSH_HOME = "$root\runtime\home"
$profileDir = "$env:DSH_HOME\profiles\video"
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
Copy-Item "$root\config\profile\*" $profileDir -Recurse -Force
Push-Location $profileDir
& pnpm install
if ($LASTEXITCODE -ne 0) { throw 'profile 依赖安装失败' }
Pop-Location
"  -> $profileDir"

Step 6 '验证'
$exe = "$root\apps\video-agent\bin\video-agent.exe"
"  服务二进制: $(Test-Path $exe)"
"  profile   : $(Test-Path "$profileDir\cordis.patch.yml")"
"  插件包    : $(Test-Path "$root\platform\dsh\packages\video\video-workspace\lib\client.js")"

Write-Host @'

安装完成。

接下来：
  1) Copy-Item apps\video-agent\.env.ps1.example apps\video-agent\.env.ps1
     然后编辑 apps\video-agent\.env.ps1，填入你的模型端点与 API Key
  2) 运行 .\start.ps1
  3) 打开脚本输出的地址（带一次性令牌）

可选：
  - 镜头切分需要 PySceneDetect。装了 Python 后：
      pip install scenedetect opencv-python-headless
    然后在 .env.ps1 里设 VIDEO_AGENT_SHOTS_PYTHON 指向该 python.exe。
'@ -ForegroundColor Green
