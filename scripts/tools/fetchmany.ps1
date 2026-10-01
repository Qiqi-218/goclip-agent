param([string]$ListFile, [string]$OutDir = "E:\huabei\research")
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$lines = Get-Content $ListFile | Where-Object { $_.Trim() -ne "" -and -not $_.StartsWith("#") }
$i = 0
foreach ($line in $lines) {
  $i++
  $parts = $line -split '\s*\|\s*'
  $url = $parts[0].Trim()
  $name = if ($parts.Count -ge 2) { $parts[1].Trim() } else { "page$i" }
  $out = Join-Path $OutDir "$name.txt"
  $res = & "$PSScriptRoot\fetch.ps1" -Url $url -Out $out
  Write-Host $res
}
