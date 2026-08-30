#!/bin/sh
# Entrypoint for Docker-biletet: byggjer turbin-cachen fyrste gong, og
# startar deretter FrankenPHP.
set -e

cd /app

if [ ! -f cache/turbines.json ] && [ -z "$VIND_SKIP_CACHE_BUILD" ]; then
	echo "→ Byggjer turbin-cachen (fyrste gong, ~10 s, hentar data frå NVE)…"
	# timeout så eit tregt/blokkert NVE-kall ikkje held serveren nede for evig.
	if timeout 120 php cron/fetch_turbines.php; then
		echo "→ Turbin-cache bygd."
	else
		echo "⚠  Klarte ikkje byggje turbin-cachen no (offline / NVE nede?)."
		echo "   Appen startar likevel — køyr «docker compose restart» når du"
		echo "   har nett, eller slett cache/turbines.json og prøv på nytt."
	fi
fi

echo "→ Startar FrankenPHP (bind ${VIND_BIND:-0.0.0.0}:${VIND_PORT:-8011})"
exec frankenphp run --config /app/Caddyfile
