@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Doctolib Monitor - Installation

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js n'est pas installe. Installation en cours...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  echo.
  echo ============================================================
  echo  Node.js est installe. FERME cette fenetre, puis
  echo  double-clique a nouveau sur install.bat.
  echo ============================================================
  echo.
  pause
  exit /b
)

node scripts\install.mjs
echo.
pause
