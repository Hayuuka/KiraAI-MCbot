@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto no_node

node "start-all.js"
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" goto failed
goto done

:no_node
echo.
echo [启动失败] 找不到 node，请先安装 Node.js
echo.
pause
exit /b 1

:failed
echo.
echo [已退出] code=%CODE%
echo.
pause
exit /b %CODE%

:done
echo.
echo [已退出]
pause
exit /b 0
