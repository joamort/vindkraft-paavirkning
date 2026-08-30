#!/bin/sh
# Vindkraft-påverknad — start (Linux / macOS)
#
# Dobbeltklikk denne, eller køyr «./start.sh» i ein terminal.
# Alt du treng ligg i denne mappa; ingenting vert installert på maskina.
set -e

cd "$(dirname "$0")"
BIN="./frankenphp"

if [ ! -x "$BIN" ]; then
	echo "Fann ikkje frankenphp-binæren i denne mappa." >&2
	exit 1
fi

if [ ! -f cache/turbines.json ]; then
	echo "→ Byggjer turbindata (~10 s, berre fyrste gong, hentar frå NVE)…"
	"$BIN" php-cli cron/fetch_turbines.php || \
		echo "⚠  Klarte ikkje byggje turbindata no. Sjekk nettet og prøv igjen."
fi

URL="http://localhost:8011"
echo "→ Opnar $URL   (lat att dette vindauget for å stoppe)"

# Opne nettlesaren når serveren er oppe.
( sleep 2
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  elif command -v open >/dev/null 2>&1; then open "$URL"
  fi ) >/dev/null 2>&1 &

exec "$BIN" run --config Caddyfile
