@echo off
rem Oracle-Bruecke fuer die Oracle-Sandbox starten (Windows)
cd /d "%~dp0"
py -m pip install --user --quiet oracledb pyodbc
py oracle_bruecke.py %*
pause
