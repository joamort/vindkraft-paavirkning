#!/usr/bin/env bash
# Utviklingsserver for dei som har PHP 8 installert (Linux/macOS).
#
#   ./scripts/dev.sh            # port 8011
#   ./scripts/dev.sh 8012       # annan port
#
# Windows: bruk ei nedlastbar utgåve eller «docker compose up». `php -S`
# er einstråds på Windows (ingen fork) og deadlockar på dei parallelle
# analysekalla — sjå CLAUDE.md.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${1:-8011}"

if ! command -v php >/dev/null 2>&1; then
	echo "Fann ikkje php. Installer PHP 8, eller bruk «docker compose up»." >&2
	exit 1
fi

if [ ! -f cache/turbines.json ]; then
	echo "→ Byggjer turbin-cachen (fyrste gong, ~10 s)…"
	php cron/fetch_turbines.php
fi

echo "→ http://localhost:${PORT}   (Ctrl+C for å stoppe)"
# PHP_CLI_SERVER_WORKERS er NAUDSYNT: appen sender parallelle analysekall,
# og php -S er einstråds som standard (deadlock).
PHP_CLI_SERVER_WORKERS="${PHP_CLI_SERVER_WORKERS:-6}" exec php -S "localhost:${PORT}" -t .
