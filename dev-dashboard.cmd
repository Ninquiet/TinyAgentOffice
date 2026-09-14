@echo off
setlocal

cd /d "%~dp0"

echo Starting TinyAgentOffice desktop dev dashboard...

if "%~1"=="" (
  echo Project: choose from Start Window
  call npm.cmd run start:desktop:dev
) else (
  echo Project: %~1
  call npm.cmd run start:desktop:dev -- --project "%~1"
)

if errorlevel 1 (
  echo.
  echo TinyAgentOffice failed to start. Review the error above.
  pause
)
