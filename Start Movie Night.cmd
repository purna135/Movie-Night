@echo off
title Movie Night
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
call npm start
pause
