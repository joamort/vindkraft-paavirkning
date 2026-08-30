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

if [ ! -f cache/turbines.json ]; then
	echo "→ Byggjer turbindata (~10 s, berre fyrste gong, hentar frå NVE)…"
	"$BIN" php-cli cron/fetch_turbines.php &
	fetch_pid=$!
	i=0
	while kill -0 "$fetch_pid" 2>/dev/null && [ "$i" -lt 75 ]; do
		sleep 1
		i=$((i + 1))
	done
	if kill -0 "$fetch_pid" 2>/dev/null; then
		echo "⚠  Turbindata tek uventa lang tid (er du på nett?). Serveren startar"
		echo "   no — hentinga held fram i bakgrunnen. Last sida på nytt når ho"
		echo "   er ferdig, eller start på nytt seinare."
	fi
fi

URL="http://localhost:8011"
echo "→ Opnar $URL   (lat att dette vindauget for å stoppe)"

# Opne nettlesaren når serveren er oppe.
( sleep 2
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  elif command -v open >/dev/null 2>&1; then open "$URL"
  fi ) >/dev/null 2>&1 &

exec "$BIN" run --config Caddyfile
