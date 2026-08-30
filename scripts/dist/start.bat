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

REM Turbindata foelgjer normalt med pakka. Manglar fila, hentar vi henne no
REM (kan ta opptil eit par minutt utan nett; appen opnar uansett etterpaa).
if not exist "cache\turbines.json" (
	echo   Turbindata manglar - hentar fraa NVE ^(kan ta opptil eit par minutt^)...
	frankenphp.exe php-cli cron\fetch_turbines.php
)

echo   Serveren startar. Nettlesaren opnar seg automatisk paa http://localhost:8011
echo   ^(lat att dette vindauget for aa stoppe^)

REM Opne nettlesaren etter 4 sekund, i bakgrunnen, saa serveren rekk aa bli klar.
start "" /b cmd /c "timeout /t 4 /nobreak >nul & start "" http://localhost:8011"

frankenphp.exe run --config Caddyfile
