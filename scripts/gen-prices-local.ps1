# Smart Pantry — local prices.json refresh (Windows / behind Netspark).
#
# In CI, `node scripts/fetch-prices.js` fetches everything directly. But on a
# Netspark-filtered machine Node's TLS handshake to publishedprices.co.il fails,
# while PowerShell (Schannel) trusts the intercepting cert like the browser does.
# So locally we download the newest PriceFull per chain with PowerShell, then let
# the Node script parse/filter them in cache mode.
#
# Run:  powershell -ExecutionPolicy Bypass -File scripts\gen-prices-local.ps1

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = 'Stop'
$root  = Split-Path $PSScriptRoot -Parent
$cache = Join-Path $PSScriptRoot '.cache'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
$cfg = (Get-Content (Join-Path $PSScriptRoot 'chains.json') -Raw | ConvertFrom-Json).chains

$SHUF = 'https://prices.shufersal.co.il'
$CERB = 'https://url.publishedprices.co.il'

function Get-Csrf($html) { [regex]::Match($html, 'name="csrftoken"\s+content="([^"]+)"').Groups[1].Value }

foreach ($ch in $cfg) {
  $dest = Join-Path $cache "$($ch.chainId).gz"
  try {
    if ($ch.type -eq 'shufersal') {
      $grid = (Invoke-WebRequest "$SHUF/FileObject/UpdateCategory?catID=2&storeId=0" -UseBasicParsing -TimeoutSec 60).Content
      $url = ([regex]::Matches($grid, 'href="([^"]+PriceFull[^"]+\.gz[^"]*)"') | ForEach-Object { $_.Groups[1].Value -replace '&amp;','&' })[0]
      Invoke-WebRequest $url -OutFile $dest -TimeoutSec 120
    } else {
      $r1 = Invoke-WebRequest "$CERB/login" -SessionVariable s -UseBasicParsing -TimeoutSec 30
      Invoke-WebRequest "$CERB/login/user" -Method Post -Body @{ username=$ch.user; password=''; csrftoken=(Get-Csrf $r1.Content) } -WebSession $s -UseBasicParsing | Out-Null
      $rf = Invoke-WebRequest "$CERB/file" -WebSession $s -UseBasicParsing -TimeoutSec 30
      if ($rf.Content -match 'name="username"') { throw "login failed ($($ch.user))" }
      $j = (Invoke-WebRequest "$CERB/file/json/dir" -Method Post -Body @{ sEcho=1; iDisplayStart=0; iDisplayLength=100000; cd='/'; csrftoken=(Get-Csrf $rf.Content) } -WebSession $s -UseBasicParsing -TimeoutSec 90).Content | ConvertFrom-Json
      $pfs = $j.aaData | Where-Object { $_.name -match '^PriceFull' } | ForEach-Object { $_.name } | Sort-Object
      if ($ch.store) { $f = $pfs | Where-Object { $_ -match "-$($ch.store)-" }; if ($f) { $pfs = $f } }
      $name = $pfs | Select-Object -Last 1
      Invoke-WebRequest "$CERB/file/d/$name" -WebSession $s -OutFile $dest -TimeoutSec 120
    }
    "$($ch.name): downloaded $([Math]::Round((Get-Item $dest).Length/1KB)) KB"
  } catch { Write-Warning "$($ch.name): $($_.Exception.Message)" }
}

$env:PRICES_CACHE = $cache
node (Join-Path $PSScriptRoot 'fetch-prices.js')
