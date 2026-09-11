@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-studio.ps1" %*
if errorlevel 1 (
  echo Inkflow could not start. See the message above and data\server-error.log.
  pause
  exit /b 1
)
exit /b 0
