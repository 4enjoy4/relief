@echo off
rem Rebuilds FauxCode.exe from ..\workbench.html + ..\app (every profile, the shell, the chrome).
rem Run from any folder. Requires: python, pip install pywebview pyinstaller
cd /d "%~dp0"
python check_build.py
if errorlevel 1 exit /b 1
python -m PyInstaller --noconfirm --clean FauxCode.spec
if errorlevel 1 exit /b 1
copy /Y dist\FauxCode.exe ..\FauxCode.exe
if errorlevel 1 exit /b 1
echo Done: ..\FauxCode.exe
