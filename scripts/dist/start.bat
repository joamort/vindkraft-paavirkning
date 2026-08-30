@echo off
REM Vindkraft-paavirkning - start (Windows)
REM
REM Dobbeltklikk denne fila. Alt du treng ligg i denne mappa;
REM ingenting vert installert paa maskina.

cd /d "%~dp0"

REM Produksjons-PHP-innstillingar (elles lek deprecation-varsel inn i JSON-svara).
set "PHPRC=%~dp0php.ini"

if not exist "frankenphp.exe" (
	echo Fann ikkje frankenphp.exe i denne mappa.
	pause
	exit /b 1
)

if not exist "cache\turbines.json" (
	echo   Byggjer turbindata ^(~10 s, berre fyrste gong, hentar fraa NVE^)...
	frankenphp.exe php-cli cron\fetch_turbines.php
)

echo   Opnar http://localhost:8011   ^(lat att dette vindauget for aa stoppe^)
start "" "http://localhost:8011"

frankenphp.exe run --config Caddyfile
