@echo off
rem Launcher: run install-startup-auth.ps1 with UTF-8 code page (ASCII only on purpose)
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-startup-auth.ps1"
if errorlevel 1 pause
