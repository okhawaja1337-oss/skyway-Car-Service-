@echo off
REM =====================================================================
REM  Skyway Dispatch Console - local launcher (Windows)
REM  Double-click this file. It serves the app at http://localhost:8080
REM  Running over http://localhost (NOT file://) is what makes the
REM  Google Maps API key work and keeps your data stable.
REM =====================================================================
cd /d "%~dp0"
echo.
echo   Skyway Dispatch Console
echo   Opening http://localhost:8080/index.html ...
echo   (Keep this window open while you use the app. Close it to stop.)
echo.
start "" http://localhost:8080/index.html
python -m http.server 8080 2>nul || py -m http.server 8080 2>nul || npx --yes http-server -p 8080 -c-1
echo.
echo   Could not start a local server.
echo   Install Python from https://www.python.org/downloads/ (tick "Add to PATH"),
echo   then double-click this file again.
echo.
pause
