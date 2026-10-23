@echo off
rem Run DSH Web without writing its launch token to a log, and stay alive while
rem port 3080 exists so Task Scheduler can restart it.
cd /d "%USERPROFILE%"
call "%~dp0start-dsh-web.cmd" 1>nul 2>>"%~dp0dsh-web.err.log"

:wait
timeout /t 10 /nobreak >nul
netstat -ano | findstr /C:":3080" >nul
if errorlevel 1 exit /b 1
goto wait
