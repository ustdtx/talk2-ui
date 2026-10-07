@echo off
REM Talk2 UI - free the port, install deps, start dev server (for human testing).
REM Usage: double-click or run start-ui.bat
REM Needs: Node.js 18+ (https://nodejs.org/). API should run first (see talk2-api\start-api.bat).
setlocal
cd /d "%~dp0"

REM --- Find Node (PATH or default install locations) ---
where node >nul 2>nul
if %errorlevel% neq 0 (
  if exist "C:\Program Files\nodejs\node.exe" (
    set "PATH=C:\Program Files\nodejs;%PATH%"
  ) else if exist "C:\nvm4w\nodejs\node.exe" (
    set "PATH=C:\nvm4w\nodejs;%PATH%"
  ) else (
    echo [ERROR] Node.js not found. Install it from https://nodejs.org/ and re-run.
    exit /b 1
  )
)

if "%PORT%"=="" set PORT=3000

echo [1/3] Freeing port %PORT% if occupied...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
  echo   Killing PID %%p on port %PORT%...
  taskkill /F /PID %%p >nul 2>nul
)
timeout /t 2 /nobreak >nul

echo [2/3] Installing dependencies...
call npm install
if %errorlevel% neq 0 (
  echo [ERROR] npm install failed.
  exit /b 1
)

echo [3/3] Starting talk2-ui dev server on port %PORT%...
echo Open this link to test (Ctrl+click in most terminals):
echo   App:  http://localhost:%PORT%/
echo API must be running too (talk2-api\start-api.bat).
echo Press Ctrl+C to stop.
call npm run dev -- --port %PORT%
