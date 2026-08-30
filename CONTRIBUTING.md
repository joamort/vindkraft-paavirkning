# Bidra til Vindkraft-påverknad

Takk for at du vil bidra. Dette er eit lite prosjekt utan byggesteg — vanilla
JS (ES6-modular) i frontend, PHP 8 med filbasert JSON-cache i backend. Du treng
ingen `npm install` for å køyre appen.

## Kom i gang

```bash
git clone https://github.com/joamort/vindkraft-paavirkning.git
cd vindkraft-paavirkning

# Alternativ A — du har PHP 8 (Linux/macOS):
./scripts/dev.sh                      # http://localhost:8011

# Alternativ B — Docker (alle plattformer, inkl. Windows):
docker compose up
```

Fyrste oppstart byggjer turbin-cachen frå NVE (~30 s). `scripts/dev.sh` startar
`php -S` med `PHP_CLI_SERVER_WORKERS=6` — det er **naudsynt**, appen sender
parallelle analysekall og `php -S` er elles einstråds og deadlockar. På Windows
brukar du Docker eller WSL (ingen `fork`).

## Køyr testane

```bash
# krev at serveren over køyrer på :8011
node tools/verify_model.mjs

# ...eller mot ein annan port:
VIND_API=http://localhost:8012 node tools/verify_model.mjs
```

`tools/verify_model.mjs` importerer dei **ekte** frontend-modulane og køyrer dei
mot cacha data + live Kartverket-kall. Node er berre eit dev-verktøy her — det
går ikkje inn i produksjon.

Alle testar må passere før du sender ein PR. Legg til ein test når du endrar
noko i modellen (`js/utils/*.js`) — mønsteret er i sjølve fila.

## Kva CI sjekkar (`.github/workflows/ci.yml`)

Køyrer automatisk på kvar pull request:

- `php -l` på all PHP
- `node --check` på all JS
- `docker build` + ein HTTP-røyktest (CSP-header på plass, interne stiar gir
  403, `turbines.php` gir reint JSON)

`verify_model.mjs` køyrer **ikkje** i CI (treng live Kartverket + bygd cache) —
køyr han lokalt.

## Kodekonvensjonar

- **Nynorsk** i kode, kommentarar, commit-meldingar og UI-tekst.
- **Ingen inline `<script>` eller `onclick=`.** CSP-en har ikkje
  `'unsafe-inline'` i `script-src`. All interaksjon går via `data-action` og éin
  delegert lyttar.
- **Asynkrone knappar må sperre seg sjølv** medan handlinga køyrer — eit flagg,
  `disabled` + spinnar på utløysaren, valfri statustekst. Sjå `visPanorama()` /
  `kjoerOverflatesjekk()` for mønsteret.
- **Alle HTTP-kall gjennom `js/api.js`.** Resten av appen kallar aldri `fetch`
  direkte.
- **Alle modellkonstantar i `js/config.js`**, med kjelde/grunngjeving i
  kommentaren når verdien er ei fagleg avgjerd.
- **`.htaccess` og `Caddyfile` må haldast i synk.** `.htaccess` gjeld
  Apache-hostinga; `Caddyfile` gjeld dei nedlastbare utgåvene og Docker. Endrar
  du tryggingsheader, CSP eller tilgangskontroll, endrar du begge — og bumpar
  `CONFIG-VERSION` i `.htaccess`.
- **Personvern (PLAN.md §8):** brukarens valde punkt skal aldri sendast eller
  loggast nokon stad. Feilloggen inneheld aldri koordinatar.

Nokre fallgruver som har kosta feilsøkingsrundar (fleire i CLAUDE.md
«Fallgruver»):

- `?>` inne i ein `//`-kommentar avsluttar PHP-modus.
- Backtick inne i ein `<!-- -->`-kommentar i eit template literal avsluttar
  strengen. `node --check` fangar det ikkje.
- `mb_*`-funksjonar: bruk vanleg `substr()` — den lokale PHP-CLI-en manglar
  `ext-mbstring`.

## Design og arkitektur

**Les [`CLAUDE.md`](CLAUDE.md) og [`PLAN.md`](PLAN.md) før større endringar.**
`CLAUDE.md` grunngjev kvar ikkje-opplagde avgjerd i prosjektet — modellval,
tersklar, datakjelde-eigenskapar. Gjer du eit nytt slikt val, skriv grunngjevinga
inn same stad.

## Commit- og PR-stil

- Éi logisk endring per commit. Commit-meldinga forklarar **kvifor**, ikkje berre
  kva — særleg for ikkje-opplagde val.
- Rebase mot `main` før du sender PR. Hald historikka rein.
- Fyll ut PR-malen. Sei kva du har testa.
- Små, fokuserte PR-ar går fortare gjennom enn store.

## Kva slags bidrag

«TODO / neste fasar» nederst i `CLAUDE.md` er ei liste over konkrete
oppgåver — adressesøk, PWA/offline, faktisk-skyggekast med skydekkestatistikk,
vindrose i utplasseringsheuristikken, m.m. Opne gjerne eit issue først for
større ting, så me kan avklare retning før du legg ned mykje arbeid.

Feilrapportar og små rettingar er alltid velkomne utan førehandsprat.
