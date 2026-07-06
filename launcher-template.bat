@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM  CraftHost One-Click Launcher (template)
REM  Real users: download YOUR personalised .bat from the
REM  CraftHost dashboard (card menu -> "One-Click Starter") -
REM  it comes with your private token already filled in.
REM  To use this template manually, replace the two values below.
REM ============================================================
set "BASE=https://crafthost-production.up.railway.app"
set "TOKEN=PASTE_YOUR_LAUNCHER_TOKEN_HERE"

title CraftHost - Server Launcher
where curl >nul 2>&1 || (echo  This starter needs Windows 10 or newer - curl.exe is missing. & pause & exit /b 1)
set "STATUS_FILE=%TEMP%\crafthost-status-%RANDOM%.txt"

:menu
cls
echo.
echo  ==================================================
echo         CraftHost Launcher
echo  ==================================================
echo.
curl -s -m 10 -o "%STATUS_FILE%" "%BASE%/api/launcher/%TOKEN%/status"
if not exist "%STATUS_FILE%" (echo  Could not reach CraftHost. & pause & goto :menu)
<"%STATUS_FILE%" set /p _S1=
<"%STATUS_FILE%" set /p _S2= & set /p _S2=
<"%STATUS_FILE%" set /p _S3= & set /p _S3= & set /p _S3=
<"%STATUS_FILE%" set /p _S4= & set /p _S4= & set /p _S4= & set /p _S4=
del "%STATUS_FILE%" 2>nul
if not defined _S1 set "_S1=offline"
if not defined _S2 set "_S2=-"
if not defined _S3 set "_S3=?"
if not defined _S4 set "_S4=0/0"
echo    Status : %_S1%
echo    Address: %_S2%
echo    Type   : %_S3%
echo    Players: %_S4%
set "STATUS=%_S1%"
set "_S1=" & set "_S2=" & set "_S3=" & set "_S4="
echo.
echo  --------  Actions  --------
echo.
echo  [1] Start server
echo  [2] Stop server
echo  [3] Restart server
echo  [4] Refresh status
echo  [5] Open dashboard
echo  [0] Exit
echo.
set /p CHOICE=Select an option (0-5):
echo.
if "%CHOICE%"=="1" goto :start
if "%CHOICE%"=="2" goto :stop
if "%CHOICE%"=="3" goto :restart
if "%CHOICE%"=="4" goto :menu
if "%CHOICE%"=="5" start "" "%BASE%" & goto :menu
if "%CHOICE%"=="0" exit /b
echo  Invalid option. & timeout /t 2 /nobreak >nul & goto :menu

:start
if /i "%STATUS%"=="online" (echo  Server is already online! & timeout /t 2 /nobreak >nul & goto :menu)
echo  Starting your server...
for /f "usebackq delims=" %%A in (`curl -s -m 30 -X POST "%BASE%/api/launcher/%TOKEN%/start"`) do set "REPLY=%%A"
if not defined REPLY set "REPLY=ERROR no reply from CraftHost"
echo  %REPLY%
echo %REPLY%| findstr /b /c:"ERROR" >nul && (echo. & pause & goto :menu)
echo  Waiting for server to come online...
set /a TRIES=0
:poll
set /a TRIES+=1
if %TRIES% GTR 60 (echo  Taking longer than usual - check your dashboard. & pause & goto :menu)
timeout /t 5 /nobreak >nul
curl -s -m 15 -o "%STATUS_FILE%" "%BASE%/api/launcher/%TOKEN%/status"
<"%STATUS_FILE%" set /p ST=
if /i "%ST%"=="crashed" (del "%STATUS_FILE%" 2>nul & echo  Server crashed. Auto-heal will retry. & pause & goto :menu)
if /i "%ST%"=="online" (
  <"%STATUS_FILE%" set /p _A= & set /p _A=
  del "%STATUS_FILE%" 2>nul
  echo.
  echo  ========================================
  echo    SERVER IS ONLINE!
  echo    Address: !_A!
  echo    Copied to clipboard - paste in MC!
  echo  ========================================
  echo !_A!| clip
  echo.
  pause
  goto :menu
)
del "%STATUS_FILE%" 2>nul
echo  ... waiting: %ST%  [%TRIES%/60]
goto poll

:stop
echo  Stopping server...
for /f "usebackq delims=" %%A in (`curl -s -m 30 -X POST "%BASE%/api/launcher/%TOKEN%/stop"`) do set "REPLY=%%A"
echo  %REPLY%
pause
goto :menu

:restart
echo  Restarting server...
for /f "usebackq delims=" %%A in (`curl -s -m 30 -X POST "%BASE%/api/launcher/%TOKEN%/restart"`) do set "REPLY=%%A"
echo  %REPLY%
pause
goto :menu
