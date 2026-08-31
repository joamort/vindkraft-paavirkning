#!/bin/sh
# Vindkraft-påverknad — start (Linux / macOS)
#
# Dobbeltklikk denne, eller køyr «./start.sh» i ein terminal.
# Alt du treng ligg i denne mappa; ingenting vert installert på maskina.

# MEDVITE INGA «set -e»: skriptet skal aldri berre forsvinne. Feilar noko,
# skal terminalvindauget bli ståande med ei forklaring — elles lukkar eit
# dobbeltklikk-vindauge seg for raskt til at nokon rekk å lese kva som gjekk gale.

cd "$(dirname "$0")" || {
	echo "Klarte ikkje byte til mappa skriptet ligg i." >&2
	exit 1
}

BIN="./frankenphp"
PORT="${VIND_PORT:-8011}"
URL="http://localhost:$PORT"

# Produksjons-PHP-innstillingar (elles lek deprecation-varsel inn i JSON-svara).
export PHPRC="$PWD/php.ini"

# Blir ståande for å vise ei feilmelding før eit dobbeltklikk-vindauge lukkar seg.
stopp() {
	echo >&2
	echo "── $1" >&2
	if [ -t 0 ]; then
		echo >&2
		printf "Trykk Enter for å lukke …" >&2
		read -r _
	fi
	exit 1
}

# --- Binæren -------------------------------------------------------------
# Pakka blir ofte pakka ut med eit grafisk arkivverktøy som misser
# køyre-rettane. Set dei sjølv i staden for å gi opp.
[ -f "$BIN" ] || stopp "Fann ikkje «frankenphp» i denne mappa. Er heile pakka pakka ut hit?"
[ -x "$BIN" ] || chmod +x "$BIN" 2>/dev/null
[ -x "$BIN" ] || stopp "«frankenphp» er ikkje køyrbar, og eg fekk ikkje sett rettane. Prøv:  chmod +x frankenphp"

if ! "$BIN" version >/dev/null 2>&1; then
	echo "Testkøyring av «frankenphp version»:" >&2
	"$BIN" version >&2 2>&1
	stopp "«frankenphp» starta ikkje på denne maskina (sjå meldinga over)."
fi

# --- Er porten ledig? -------------------------------------------------
opptatt=""
if command -v curl >/dev/null 2>&1; then
	curl -s -o /dev/null "$URL" 2>/dev/null && opptatt=1
elif command -v wget >/dev/null 2>&1; then
	wget -q -O /dev/null "$URL" 2>/dev/null && opptatt=1
fi
[ -n "$opptatt" ] && stopp "Noko svarar allereie på port $PORT. Lat att den andre serveren, eller start med ein annan port:  VIND_PORT=8012 ./start.sh"

# --- Turbindata -----------------------------------------------------
# Følgjer normalt med pakka. Manglar fila (t.d. sletta for å tvinge ei
# oppdatering), hentar vi henne no — kan ta opptil eit par minutt.
if [ ! -f cache/turbines.json ]; then
	echo "→ Turbindata manglar — hentar frå NVE (kan ta opptil eit par minutt)…"
	"$BIN" php-cli cron/fetch_turbines.php \
		|| echo "⚠  Klarte ikkje hente turbindata (er du på nett?). Serveren startar likevel; prøv «Oppdater no» i appen seinare."
fi

echo "→ Serveren startar på $URL"
echo "  Nettlesaren opnar seg automatisk når han svarar."
echo "  (lat att dette vindauget, eller trykk Ctrl+C, for å stoppe)"

# --- Opne nettlesaren når — og BERRE når — serveren faktisk svarar ---
(
	i=0
	while [ "$i" -lt 90 ]; do
		if command -v curl >/dev/null 2>&1; then
			curl -sf -o /dev/null "$URL" 2>/dev/null && break
		elif command -v wget >/dev/null 2>&1; then
			wget -q -O /dev/null "$URL" 2>/dev/null && break
		else
			sleep 3
			break
		fi
		sleep 1
		i=$((i + 1))
	done
	[ "$i" -ge 90 ] && exit 0   # gav opp — ikkje opne ein daud URL
	if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
	elif command -v open >/dev/null 2>&1; then open "$URL"
	else echo "→ Opne $URL i nettlesaren." >&2
	fi
) >/dev/null 2>&1 &

# IKKJE «exec» — vi vil ha kontrollen tilbake for å kunne forklare ein
# tidleg exit i staden for at vindauget berre lukkar seg.
"$BIN" run --config Caddyfile
kode=$?
[ "$kode" -ne 0 ] && [ "$kode" -ne 130 ] \
	&& stopp "Serveren stoppa uventa (exit $kode). Sjå meldinga over."
