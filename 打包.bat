@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-windows.ps1"
echo.
if errorlevel 1 (
  echo 打包失败，请查看上面的错误信息。
) else (
  echo 打包完成，可以关闭此窗口。
)
pause
