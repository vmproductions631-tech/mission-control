@echo off
title Mission Control
rem Prefer Node on PATH; fall back to the default Windows install location.
rem Override with:  set MC_NODE=D:\path\to\node.exe
setlocal
cd /d "%~dp0"

if defined MC_NODE goto :run
where node >nul 2>&1 && (set "MC_NODE=node" & goto :run)
if exist "%ProgramFiles%\nodejs\node.exe" (set "MC_NODE=%ProgramFiles%\nodejs\node.exe" & goto :run)
if exist "%ProgramFiles(x86)%\nodejs\node.exe" (set "MC_NODE=%ProgramFiles(x86)%\nodejs\node.exe" & goto :run)

echo Node.js not found on PATH or in the usual install locations.
echo Install Node 18+, or set MC_NODE to the full path of node.exe.
pause
exit /b 1

:run
"%MC_NODE%" server.js --open
if errorlevel 1 pause
