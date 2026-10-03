# 安装 goclip DSH 视频剪辑助手
#
# 三件事：
#   1) 安装并构建 DSH 基座（platform/dsh）
#   2) 把 config/profile 装进 runtime/home/profiles/video，并把插件的 link 路径改对
#   3) 把启动器摆到 runtime/start-dsh.mjs
#
# 修过的两处（原来 clone 下来跑不起来）：
#   · config/profile/package.json 里的 link 是相对 config/profile 写的（4 层 ..），
#     复制到 runtime/home/profiles/video 后只该有 3 层 —— 这里在安装时改写。
#   · README 与 start.ps1 都引用 runtime/start-dsh.mjs，但它原本不在仓库里，
#     而 runtime/ 被 .gitignore 忽略 —— 现在由 config/start-dsh.mjs 安装过去。

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

foreach ($cmd in @('node', 'pnpm', 'ffmpeg')) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "缺少 $cmd" }
}

# 烧字幕用的字体必须先确认存在 —— 与 setup.sh 里那条同样的理由。
#
# 实测过：FontName 指向一个没装的字体时 ffmpeg 走 libass **不报错**，
# 只是什么都不画。退出码 0、文件正常、时长正常，但画面里一个字都没有，
# 于是一份静默残缺的成片看起来像成功了。Windows 上默认字体 'Microsoft YaHei'
# 通常存在，这条检查在 Windows 上基本总会通过，它存在的意义是和 Linux 那份对称。
$fontFamilies = @()
try {
  $fontFamilies = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts' -ErrorAction Stop).PSObject.Properties.Name
} catch { }
$hasCjkFont = ($fontFamilies -match 'YaHei|SimHei|SimSun|Noto Sans CJK|Source Han') -or
  (Test-Path "$env:WINDIR\Fonts\msyh.ttc") -or (Test-Path "$env:WINDIR\Fonts\simhei.ttf")
if (-not $hasCjkFont) {
  throw '缺少中文字体：烧进画面的中文字幕会变成一片空白，而且 ffmpeg 不会报错。请先安装中文字体，并把 config/profile/cordis.patch.yml 里 video-workspace 的 subtitleFont 改成实际字体名。'
}

Write-Host '[1/3] 安装并构建基座' -ForegroundColor Cyan
Push-Location "$root\platform\dsh"
pnpm install
if ($LASTEXITCODE -ne 0) { throw 'pnpm install 失败' }
pnpm run build
if ($LASTEXITCODE -ne 0) { throw 'pnpm run build 失败' }
Pop-Location

Write-Host '[2/3] 安装 profile' -ForegroundColor Cyan
$profile = "$root\runtime\home\profiles\video"
New-Item -ItemType Directory -Force -Path $profile | Out-Null
Copy-Item "$root\config\profile\*" $profile -Recurse -Force

# 两个包的 link 都是相对路径，按 config/profile 的位置写着 4 层 ..；
# 装到 runtime/home/profiles/video 后只该有 3 层，否则 pnpm 装完解析不到。
# 证据面板必须单独链接一次：它是**独立的客户端插件包**，不是 video-workspace
# 的一部分，而客户端 bundle 的清单由服务端按 loader 行扫包名得到。
$manifestPath = Join-Path $profile 'package.json'
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$packages = @{
  'dsh-video-workspace'                  = 'platform\dsh\packages\video\video-workspace'
  '@deepseek-ai/dsh-client-ui-evidence'  = 'platform\dsh\packages\client\ui-evidence'
}
foreach ($name in $packages.Keys) {
  $plugin = Join-Path $root $packages[$name]
  if (-not (Test-Path $plugin)) { throw "找不到插件包：$plugin" }
  $rel = [System.IO.Path]::GetRelativePath($profile, $plugin) -replace '\\', '/'
  $manifest.dependencies.$name = "link:$rel"
  Write-Host "      $name -> link:$rel"
}
$manifest | ConvertTo-Json -Depth 20 | Set-Content $manifestPath -Encoding utf8

Push-Location $profile
pnpm install
if ($LASTEXITCODE -ne 0) { throw 'profile 依赖安装失败' }
Pop-Location

foreach ($name in $packages.Keys) {
  if (-not (Test-Path "$profile\node_modules\$name\package.json")) {
    throw "profile 装完了但 $name 链接解析不到，检查 $manifestPath"
  }
}

Write-Host '[3/3] 安装启动器' -ForegroundColor Cyan
Copy-Item "$root\config\start-dsh.mjs" "$root\runtime\start-dsh.mjs" -Force

if (-not (Test-Path "$root\runtime\.env.ps1")) {
  Write-Host '注意：还没有 runtime\.env.ps1 —— 按 README 的「配置」一节填写后再启动。' -ForegroundColor Yellow
}

Write-Host '安装完成。配置 runtime\.env.ps1 后运行 .\start.ps1' -ForegroundColor Green
