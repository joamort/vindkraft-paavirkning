# Vindkraft-påverknad

Interaktivt webkart som viser korleis vindkraftanlegg på land visuelt og
støymessig påverkar eit sjølvvalt punkt (t.d. bustaden din). Du klikkar eit
punkt, appen finn turbinar i nærleiken, hentar terrengprofilar frå Kartverket,
og reknar ut kva som **faktisk er synleg** — ikkje berre kor langt unna
turbinane står. I tillegg: forenkla støyestimat (L_den mot T-1442),
teoretisk skyggekast, hinderlys, og eit 3D-panorama med flyfoto.

Arkitektur, datakjelder og modellval: **[PLAN.md](PLAN.md)** og
**[CLAUDE.md](CLAUDE.md)**.

---

## Køyr appen

All datahenting går ut frå **di eiga maskin** — sjå [Personvern](#personvern)
under. Vel den måten som passar deg:

### 1. Last ned ei ferdig utgåve (enklast — ingenting å installere)

Gå til **[Releases](../../releases/latest)** og last ned pakka for
operativsystemet ditt:

| OS | Fil | Start |
|----|-----|-------|
| Windows | `…-windows-x86_64.zip` | dobbeltklikk `start.bat` |
| macOS (Apple Silicon) | `…-mac-arm64.tar.gz` | dobbeltklikk `start.command` |
| Linux (x86_64 / arm64) | `…-linux-*.tar.gz` | køyr `./start.sh` |

Pakk ut og start — nettlesaren opnar `http://localhost:8011` automatisk når
serveren er klar. Turbindata følgjer med pakka (ein snapshot frå då utgåva
vart laga), så oppstarten er rask. Webtenaren (FrankenPHP med PHP innebygd)
ligg i pakka; ingenting vert installert på maskina.

### 2. Docker

```bash
docker compose up
```

Opne så `http://localhost:8011`. `cache/` og `logs/` vert lagra på verten,
så data overlever ombygging.

### 3. Frå kjeldekode (for utvikling)

Krev **PHP 8** (Linux/macOS):

```bash
./scripts/dev.sh          # http://localhost:8011
```

Skriptet byggjer turbin-cachen fyrste gong og startar `php -S` med
`PHP_CLI_SERVER_WORKERS=6` (naudsynt — appen sender parallelle analysekall,
og `php -S` er elles einstråds og deadlockar).

> **Windows frå kjeldekode:** `php -S` har ingen `fork` på Windows og
> deadlockar. Bruk ei ferdig utgåve (1) eller Docker (2).

---

## Personvern

- **Turbindata (NVE)** og **terrengdata (Kartverket WPS)** vert henta av
  PHP-backenden som køyrer **lokalt på maskina di**. Nettlesaren snakkar aldri
  direkte med desse tenestene, og det finst ingen mellomtenar.
- **Punktet du vel** vert aldri sendt nokon stad. Heile analysen skjer lokalt.
  Feilloggen (`logs/`) inneheld aldri koordinatar.
- Nettlesaren lastar nokre bibliotek (Leaflet, MarkerCluster, Chart.js, Font
  Awesome, Three.js) frå offentlege CDN-ar (`unpkg.com`, `cdnjs.cloudflare.com`),
  og kartbakgrunn/flyfoto frå Kartverket og Esri. Dette krev internett, men går
  direkte frå nettlesaren din. `Content-Security-Policy` låser `connect-src`
  til `'self'`, så ingen andre nettverkskall er moglege frå sida.

Serveren bind seg berre til `localhost` (Docker-varianten til containeren).
Ikkje eksponer han mot internett — han har ingen autentisering.

---

## Testing

```bash
# krev at ein server køyrer på :8011 (t.d. ./scripts/dev.sh)
node tools/verify_model.mjs
# ...eller mot annan port:
VIND_API=http://localhost:8012 node tools/verify_model.mjs
```

`tools/verify_model.mjs` importerer dei **ekte** frontend-modulane og køyrer
dei mot ekte cacha data + live Kartverket-kall. Node er berre eit dev-verktøy.

---

## Oppdatere turbindata

Slett `cache/turbines.json` og start på nytt — eller køyr
`php cron/fetch_turbines.php` (henter 11 ArcGIS-lag frå NVE, ~7 s).

---

## Om serverkonfigurasjon

- `.htaccess` gjeld den eksisterande Apache-hostinga.
- `Caddyfile` er den tilsvarande konfigurasjonen for FrankenPHP (utgåvene i
  (1) og Docker i (2)) — same tryggingsheader, CSP og tilgangskontroll.
  Endrar du den eine, hald den andre i synk.

---

## Lisens

[MIT](LICENSE) © 2026 Joar Mortveit

Data: NVE (vindkraftverk) og Kartverket (høgdedata) under eigne opne lisensar.
Kartbakgrunn: Kartverket og Esri.
