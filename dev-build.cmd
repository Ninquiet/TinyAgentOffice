@echo off
setlocal

cd /d "%~dp0"

echo Running TinyAgentOffice checks...
call npm.cmd run check
if errorlevel 1 exit /b %errorlevel%

echo Building TinyAgentOffice web bundle...
call npm.cmd run build:web
if errorlevel 1 exit /b %errorlevel%

echo Build completed.
