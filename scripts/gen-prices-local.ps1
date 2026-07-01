# Smart Pantry — local prices.json refresh (Windows / behind Netspark).
#
# In CI, `node scripts/fetch-prices.js` fetches every branch directly. On a
# Netspark-filtered machine Node's TLS to publishedprices.co.il fails, while
# PowerShell (Schannel) trusts the intercepting cert like the browser. So
# locally we download — per chain — the Stores directory + the newest PriceFull
# for the first $N stores, then let the Node script parse them in cache mode.
#
# Run:  powershell -File scripts\gen-prices-local.ps1   (optionally -N 8)

# By default refreshes only the login (cerberus) chains — GitHub Actions can't
# reach publishedprices.co.il, so those come from this Israeli machine while CI
# keeps Shufersal fresh. Pass -IncludeShufersal to fetch Shufersal locally too.
param([int]$N = 1, [switch]$IncludeShufersal)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = 'Stop'
$cache = Join-Path $PSScriptRoot '.cache'
$cfg = (Get-Content (Join-Path $PSScriptRoot 'chains.json') -Raw | ConvertFrom-Json).chains
$SHUF = 'https://prices.shufersal.co.il'; $CERB = 'https://url.publishedprices.co.il'
function Csrf($h) { [regex]::Match($h, 'name="csrftoken"\s+content="([^"]+)"').Groups[1].Value }
function Gunzip([byte[]]$bytes) {
  $ms = New-Object IO.MemoryStream(,$bytes); $gz = New-Object IO.Compression.GZipStream($ms, [IO.Compression.CompressionMode]::Decompress)
  $out = New-Object IO.MemoryStream; $gz.CopyTo($out); $gz.Close(); return $out.ToArray()
}

foreach ($ch in $cfg) {
  if ($ch.type -eq 'shufersal' -and -not $IncludeShufersal) { continue }
  $dir = Join-Path $cache $ch.chainId
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  try {
    if ($ch.type -eq 'shufersal') {
      $grid = (Invoke-WebRequest "$SHUF/FileObject/UpdateCategory?catID=5&storeId=0" -UseBasicParsing -TimeoutSec 60).Content
      $u = @([regex]::Matches($grid, 'href="([^"]+Stores[^"]+\.gz[^"]*)"') | ForEach-Object { $_.Groups[1].Value -replace '&amp;','&' })[0]
      Invoke-WebRequest $u -OutFile (Join-Path $dir 'stores.gz') -TimeoutSec 60
      $sx = [Text.Encoding]::UTF8.GetString((Gunzip ([IO.File]::ReadAllBytes((Join-Path $dir 'stores.gz')))))
      $ids = if ($ch.store) { @($ch.store) } else { @([regex]::Matches($sx, '<StoreID>0*(\d+)</StoreID>') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique -First $N) }
      foreach ($id in $ids) {
        $g2 = (Invoke-WebRequest "$SHUF/FileObject/UpdateCategory?catID=2&storeId=$id" -UseBasicParsing -TimeoutSec 60).Content
        $pf = @([regex]::Matches($g2, 'href="([^"]+PriceFull[^"]+\.gz[^"]*)"') | ForEach-Object { $_.Groups[1].Value -replace '&amp;','&' })[0]
        if ($pf) { Invoke-WebRequest $pf -OutFile (Join-Path $dir ("{0}.gz" -f $id)) -TimeoutSec 90 }
        $g4 = (Invoke-WebRequest "$SHUF/FileObject/UpdateCategory?catID=4&storeId=$id" -UseBasicParsing -TimeoutSec 60).Content
        $pm = @([regex]::Matches($g4, 'href="([^"]+PromoFull[^"]+\.gz[^"]*)"') | ForEach-Object { $_.Groups[1].Value -replace '&amp;','&' })[0]
        if ($pm) { Invoke-WebRequest $pm -OutFile (Join-Path $dir ("{0}.promo.gz" -f $id)) -TimeoutSec 90 }
      }
    } else {
      $r1 = Invoke-WebRequest "$CERB/login" -SessionVariable s -UseBasicParsing -TimeoutSec 30
      Invoke-WebRequest "$CERB/login/user" -Method Post -Body @{ username=$ch.user; password=''; csrftoken=(Csrf $r1.Content) } -WebSession $s -UseBasicParsing | Out-Null
      $rf = Invoke-WebRequest "$CERB/file" -WebSession $s -UseBasicParsing -TimeoutSec 30
      if ($rf.Content -match 'name="username"') { throw "login failed ($($ch.user))" }
      $j = (Invoke-WebRequest "$CERB/file/json/dir" -Method Post -Body @{ sEcho=1; iDisplayStart=0; iDisplayLength=100000; cd='/'; csrftoken=(Csrf $rf.Content) } -WebSession $s -UseBasicParsing -TimeoutSec 90).Content | ConvertFrom-Json
      $stf = ($j.aaData | Where-Object { $_.name -match 'Stores' } | Select-Object -First 1).name
      if ($stf) { Invoke-WebRequest "$CERB/file/d/$stf" -WebSession $s -OutFile (Join-Path $dir 'stores.xml') -TimeoutSec 60 }
      $idFrom = { param($n) [regex]::Match($n, "$($ch.chainId)-(?:\d+-)?0*(\d+)-") }
      $groups = @($j.aaData | Where-Object { $_.name -match '^PriceFull' } | ForEach-Object {
        $m = & $idFrom $_.name; if ($m.Success) { [pscustomobject]@{ id = $m.Groups[1].Value; name = $_.name } }
      } | Group-Object id)
      # newest PromoFull per store id
      $promoByStore = @{}
      foreach ($pg in @($j.aaData | Where-Object { $_.name -match '^PromoFull' } | ForEach-Object {
        $m = & $idFrom $_.name; if ($m.Success) { [pscustomobject]@{ id = $m.Groups[1].Value; name = $_.name } }
      } | Group-Object id)) { $promoByStore[$pg.Name] = @($pg.Group | Sort-Object name)[-1].name }
      $pick = if ($ch.store) { @($groups | Where-Object { $_.Name -eq $ch.store }) } else { @($groups | Select-Object -First $N) }
      foreach ($g in $pick) {
        $name = @($g.Group | Sort-Object name)[-1].name
        Invoke-WebRequest "$CERB/file/d/$name" -WebSession $s -OutFile (Join-Path $dir ("{0}.gz" -f $g.Name)) -TimeoutSec 90
        if ($promoByStore.ContainsKey($g.Name)) {
          Invoke-WebRequest "$CERB/file/d/$($promoByStore[$g.Name])" -WebSession $s -OutFile (Join-Path $dir ("{0}.promo.gz" -f $g.Name)) -TimeoutSec 90
        }
      }
    }
    "$($ch.name): cached $(@(Get-ChildItem $dir -Filter *.gz | Where-Object { $_.Name -notmatch '\.promo\.gz$' }).Count) stores ($(@(Get-ChildItem $dir -Filter *.promo.gz).Count) with promos)"
  } catch { Write-Warning "$($ch.name): $($_.Exception.Message)" }
}

$env:PRICES_CACHE = $cache
node (Join-Path $PSScriptRoot 'fetch-prices.js')
