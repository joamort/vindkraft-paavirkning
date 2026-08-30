#!/bin/sh
# Entrypoint for Docker-biletet: byggjer turbin-cachen fyrste gong, og
# startar deretter FrankenPHP.
set -e

cd /app

if [ ! -f cache/turbines.json ]; then
	echo "→ Byggjer turbin-cachen (fyrste gong, ~10 s, hentar data frå NVE)…"
	if php cron/fetch_turbines.php; then
		echo "→ Turbin-cache bygd."
	else
		echo "⚠  Klarte ikkje byggje turbin-cachen no (offline?). Appen startar"
		echo "   likevel — prøv «docker compose restart» når du har nett."
	fi
fi

echo "→ Startar FrankenPHP på ${VIND_ADDR:-http://0.0.0.0:8011}"
exec frankenphp run --config /app/Caddyfile
