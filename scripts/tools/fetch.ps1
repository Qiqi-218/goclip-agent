param(
  [Parameter(Mandatory=$true)][string]$Url,
  [string]$Out,
  [int]$Max = 200000,
  [string]$Grep = ""
)
$ErrorActionPreference = "Stop"
try {
  $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 45 -MaximumRedirection 6 -Headers @{
    "User-Agent" = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    "Accept-Language" = "zh-CN,zh;q=0.9,en;q=0.8"
  }
} catch {
  "FETCH_ERR $Url :: $($_.Exception.Message)"
  exit 0
}
$h = $r.Content
if ($h -isnot [string]) { $h = [string]$h }
$h = [regex]::Replace($h, '(?is)<script.*?</script>', ' ')
$h = [regex]::Replace($h, '(?is)<style.*?</style>', ' ')
$h = [regex]::Replace($h, '(?is)<noscript.*?</noscript>', ' ')
$h = [regex]::Replace($h, '(?is)<svg.*?</svg>', ' ')
$h = [regex]::Replace($h, '(?is)<(br|/p|/div|/tr|/li|/h[1-6]|/table)[^>]*>', "`n")
$h = [regex]::Replace($h, '(?is)</t[dh]>', " | ")
$h = [regex]::Replace($h, '(?s)<[^>]+>', ' ')
$h = [System.Net.WebUtility]::HtmlDecode($h)
$h = [regex]::Replace($h, '[ \t\u00a0]+', ' ')
$h = [regex]::Replace($h, '(\r?\n[ \t]*){2,}', "`n")
$h = $h.Trim()
if ($Grep -ne "") {
  $lines = $h -split "`n" | Where-Object { $_ -match $Grep }
  $h = ($lines -join "`n")
}
if ($h.Length -gt $Max) { $h = $h.Substring(0, $Max) }
if ($Out) {
  Set-Content -Path $Out -Value $h -Encoding UTF8
  "WROTE $Out  status=$($r.StatusCode)  len=$($h.Length)  from=$Url"
} else {
  "=== $Url  status=$($r.StatusCode) len=$($h.Length) ==="
  $h
}
