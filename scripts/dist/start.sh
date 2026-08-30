#!/bin/sh
# Vindkraft-påverknad — start (Linux / macOS)
#
# Dobbeltklikk denne, eller køyr «./start.sh» i ein terminal.
# Alt du treng ligg i denne mappa; ingenting vert installert på maskina.
set -e

cd "$(dirname "$0")"
BIN="./frankenphp"

# Produksjons-PHP-innstillingar (elles lek deprecation-varsel inn i JSON-svara).
export PHPRC="$PWD/php.ini"

if [ ! -x "$BIN" ]; then
	echo "Fann ikkje frankenphp-binæren i denne mappa." >&2
	exit 1
fi

# Turbindata følgjer normalt med pakka. Manglar fila (t.d. sletta for å tvinge
# ei oppdatering), hentar vi henne no — det kan ta opptil eit par minutt utan
# nett, og serveren startar uansett etterpå.
if [ ! -f cache/turbines.json ]; then
	echo "→ Turbindata manglar — hentar frå NVE (kan ta opptil eit par minutt)…"
	"$BIN" php-cli cron/fetch_turbines.php \
		|| echo "⚠  Klarte ikkje hente turbindata (er du på nett?). Start på nytt seinare."
fi

URL="http://localhost:8011"
echo "→ Serveren startar. Nettlesaren opnar seg automatisk på $URL"
echo "  (lat att dette vindauget for å stoppe)"

# Opne nettlesaren FYRST når serveren faktisk svarar — ikkje før.
(
	tries=0
	while [ "$tries" -lt 90 ]; do
		if command -v curl >/dev/null 2>&1; then
			curl -sf -o /dev/null "$URL" 2>/dev/null && break
		elif command -v wget >/dev/null 2>&1; then
			wget -q -O /dev/null "$URL" 2>/dev/null && break
		else
			sleep 3
			break
		fi
		sleep 1
		tries=$((tries + 1))
	done
	if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
	elif command -v open >/dev/null 2>&1; then open "$URL"
	fi
) >/dev/null 2>&1 &

exec "$BIN" run --config Caddyfile
