@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found.
  echo Please install Node.js 18 or newer from https://nodejs.org/
  echo Then double-click this file again.
  echo.
  pause
  exit /b 1
)
start "" http://localhost:8787
node server.js
pause
