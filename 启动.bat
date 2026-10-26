@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [启动失败] 找不到 node，请先安装 Node.js
  pause
  exit /b 1
)

node "start-all.js"
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo [已退出] code=%CODE%
  pause
)
endlocal & exit /b %CODE%
