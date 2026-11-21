@echo off
title Movie Night
cd /d "%~dp0"
rem Always run npm install: it takes a second when nothing changed, and picks up new dependencies after an update.
echo Checking dependencies...
call npm install --no-audit --no-fund --loglevel=error
if errorlevel 1 (
  echo.
  echo Could not install dependencies. Check your internet connection and that Node.js is installed.
  pause
  exit /b 1
)
call npm start
pause
