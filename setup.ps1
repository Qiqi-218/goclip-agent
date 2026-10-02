# 安装 goclip DSH 视频剪辑助手
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
foreach ($cmd in @('node','pnpm','ffmpeg')) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "缺少 $cmd" }
}
Push-Location "$root\platform\dsh"
pnpm install
pnpm run build
Pop-Location
$profile = "$root\runtime\home\profiles\video"
New-Item -ItemType Directory -Force -Path $profile | Out-Null
Copy-Item "$root\config\profile\*" $profile -Recurse -Force
Push-Location $profile
pnpm install
Pop-Location
Write-Host '安装完成。请配置 runtime\.env.ps1 后运行 .\start.ps1。' -ForegroundColor Green
