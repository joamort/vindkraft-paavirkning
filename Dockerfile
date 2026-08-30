# Vindkraft-påverknad — sjølvhosta med FrankenPHP.
#
# FrankenPHP er ein enkeltbinær webtenar med PHP innebygd. Han handterer
# samtidige førespurnader med ein trådpool, så deadlocken som `php -S` får
# under parallelle analysekall (sjå CLAUDE.md) oppstår ikkje her.

FROM dunglas/frankenphp:1-php8.3

# Appen forventar berre standard-ekstensjonar + curl (Http.php).
# curl følgjer med basisbiletet.

WORKDIR /app
COPY . /app

# cache/ og logs/ vert normalt mappa inn som volum (sjå docker-compose.yml),
# men må finnast og vere skrivbare også utan volum.
RUN set -eux; \
	mkdir -p cache/elevation cache/ratelimit logs; \
	chown -R www-data:www-data cache logs; \
	chmod +x /app/scripts/docker-entrypoint.sh

# Lytt på alle grensesnitt inne i containeren; port vert mappa i compose.
ENV VIND_ADDR="http://0.0.0.0:8011" \
	VIND_ROOT="/app"

EXPOSE 8011

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
