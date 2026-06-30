@echo off
REM Smart Pantry - one-click price refresh for the login (cerberus) chains.
REM Double-click this from the repo root. It must run on an Israeli IP
REM (Rami Levi / Osher Ad / Yochananof are geo-blocked elsewhere).
REM Optional args pass through, e.g.:  refresh-prices.cmd -N 50 -IncludeShufersal
cd /d "%~dp0"
echo ============================================================
echo  Smart Pantry - refreshing prices (Rami Levi / Osher Ad / Yochananof)
echo  Regular prices + active sales (PriceFull + PromoFull).
echo ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\gen-prices-local.ps1" %*
if errorlevel 1 (
  echo.
  echo *** refresh FAILED - prices.json was not changed. ***
  pause
  exit /b 1
)
echo.
git add prices.json
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "chore(prices): refresh login chains [skip ci]"
  git push
  echo.
  echo ===== Done. New prices pushed to main - live within ~1 minute. =====
) else (
  echo No price changes since last refresh - nothing to commit.
)
echo.
pause
