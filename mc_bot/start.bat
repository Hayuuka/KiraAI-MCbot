@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not exist "node_modules\mineflayer\package.json" (
  echo [mc_bot] Dependencies are missing. Run "npm install" in this folder first.
  exit /b 1
)

node "src\index.js"
set "MC_BOT_EXIT=%ERRORLEVEL%"
if not "%MC_BOT_EXIT%"=="0" echo [mc_bot] exited with code %MC_BOT_EXIT%
endlocal & exit /b %MC_BOT_EXIT%
