@echo off
setlocal
title Scrum Studio Launcher

set "APP_DIR=%~dp0"
cd /d "%APP_DIR%"

echo.
echo Scrum Studio
echo ------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on this computer.
  echo Install the LTS version from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js with npm enabled, then run this file again.
  echo.
  pause
  exit /b 1
)

call :NeedsInstall "." "package-lock.json"
if errorlevel 1 (
  echo Installing Scrum Studio server dependencies...
  call npm.cmd install
  if errorlevel 1 goto install_failed
) else (
  echo Server dependencies are ready.
)

if exist "apps\lobby\package.json" (
  call :NeedsInstall "apps\lobby" "apps\lobby\package-lock.json"
  if errorlevel 1 (
    echo Installing Lobby dependencies...
    call npm.cmd --prefix apps/lobby install
    if errorlevel 1 goto install_failed
  ) else (
    echo Lobby dependencies are ready.
  )

  if not exist "apps\lobby\dist\index.html" (
    echo Building Lobby assets...
    call npm.cmd run build:lobby
    if errorlevel 1 goto build_failed
  ) else (
    echo Lobby assets are ready.
  )
)

call :IsRunning
if not errorlevel 1 (
  echo Scrum Studio is already running. Opening the browser...
  start "" "http://127.0.0.1:3000/"
  exit /b 0
)

echo Starting Scrum Studio server...
start "Scrum Studio Server" /D "%APP_DIR%" cmd /k npm.cmd start

echo Waiting for Scrum Studio to be ready...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$deadline=(Get-Date).AddSeconds(25); do { try { Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3000/' -TimeoutSec 2 | Out-Null; exit 0 } catch { Start-Sleep -Milliseconds 750 } } while ((Get-Date) -lt $deadline); exit 1"
if errorlevel 1 (
  echo Scrum Studio is still starting. Opening the browser anyway; refresh in a moment if needed.
) else (
  echo Scrum Studio is ready.
)

start "" "http://127.0.0.1:3000/"
exit /b 0

:NeedsInstall
set "CHECK_DIR=%~1"
set "LOCK_FILE=%~2"
if not exist "%CHECK_DIR%\node_modules" exit /b 1
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (!(Test-Path '%LOCK_FILE%')) { exit 0 }; if ((Get-Item '%LOCK_FILE%').LastWriteTime -gt (Get-Item '%CHECK_DIR%\node_modules').LastWriteTime) { exit 1 } else { exit 0 }"
exit /b %errorlevel%

:IsRunning
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $response = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3000/' -TimeoutSec 2; if ($response.Content -match 'Scrum Studio|SprintGen') { exit 0 } else { exit 1 } } catch { exit 1 }"
exit /b %errorlevel%

:install_failed
echo.
echo Dependency install failed. Check the messages above, then run this file again.
echo.
pause
exit /b 1

:build_failed
echo.
echo Lobby build failed. Check the messages above, then run this file again.
echo.
pause
exit /b 1
