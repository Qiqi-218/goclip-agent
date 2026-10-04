# 一次跑完 goclip 插件的全部确定性检查
#
# 用法（在 platform/dsh 目录下）：
#   pwsh -File ..\..\scripts\tools\verify\run-all.ps1
#
# 三套探测脚本都直接加载编译后的插件运行时，用网络桩件拦截 OSS 与模型调用，
# 因此不会触碰真实数据。最后一项检查打包产物是否比源码新 —— DSH 加载的是
# 打包产物，只跑 tsc 会让线上继续跑旧代码而测试全绿。

$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
$repo = Resolve-Path (Join-Path $here '..\..\..')
$plugin = Join-Path $repo 'platform\dsh\packages\video\video-workspace'
$runtime = 'file:///' + ((Join-Path $plugin 'lib\types\runtime.js') -replace '\\', '/')

if (-not (Test-Path (Join-Path $plugin 'lib\types\runtime.js'))) {
  throw "找不到 $plugin\lib\types\runtime.js —— 先构建插件"
}

$suites = @('probe-runtime', 'probe-schema', 'probe-roundtrip', 'probe-evidence', 'probe-evidence-view', 'probe-empty-guard', 'probe-sentence-span', 'probe-human-review-tools', 'probe-multi', 'probe-find', 'probe-plan', 'probe-cloud-evidence', 'probe-precision')
$totalBad = 0

foreach ($s in $suites) {
  Write-Host "`n=== $s ===" -ForegroundColor Cyan
  $out = & node (Join-Path $here "$s.mjs") $runtime 2>&1
  $out | ForEach-Object { "  $_" }
  $bad = ($out | Select-String -Pattern '❌' | Measure-Object).Count
  $summary = ($out | Select-String -Pattern '共 \d+ 项' | Select-Object -Last 1).Line
  if ($summary) { Write-Host ($summary.Trim()) -ForegroundColor DarkGray }
  $totalBad += $bad
}

Write-Host ''
if ($totalBad -eq 0) {
  Write-Host '全部检查通过。' -ForegroundColor Green
} else {
  Write-Host "共 $totalBad 处问题。" -ForegroundColor Red
}
exit $totalBad
