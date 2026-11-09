@echo off
setlocal
rem CPS3 Studio. With Python 3 installed, the Studio starts its small local server: it finds your game by itself
rem (Fightcade's ROMs, the Infinite client, a folder you chose before) and opens in its own window. Without Python it
rem opens from disk in your browser and asks for sfiii3nr1.zip and sfiii3.zip once.
if defined CPS3_STUDIO_BROWSER (
  start "" "%CPS3_STUDIO_BROWSER%" %CPS3_STUDIO_BROWSER_ARGS% "%~dp0Open CPS3 Studio.html"
  exit /b
)
set "PYW="
for /f "delims=" %%P in ('where pyw 2^>nul') do if not defined PYW set "PYW=%%P"
if not defined PYW for /f "delims=" %%P in ('where pythonw 2^>nul') do if not defined PYW set "PYW=%%P"
if defined PYW (
  start "" "%PYW%" "%~dp0cps3_studio\launch.py" --logs "%LOCALAPPDATA%\CPS3 Studio\logs" --open
  exit /b
)
start "" "%~dp0Open CPS3 Studio.html"
