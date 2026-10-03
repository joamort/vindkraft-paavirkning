# Endringslogg

Alle merkbare endringar i Vindkraft-påverknad. Nyaste fyrst.

Nedlastbare pakkar for kvar utgåve ligg under
[Releases](https://github.com/joamort/vindkraft-paavirkning/releases). Kvifor ting
er gjort som dei er, står i [CLAUDE.md](CLAUDE.md) (paragrafane `§` det vert vist
til under).

---

## [v0.4.0] — 2026-10-03

Ein gjennomgang av appen slik han faktisk vert servert på nett, ikkje berre
lokalt. Det meste her er tryggleik, fart og mobil. Sjå CLAUDE.md §32.

### Tryggleik

- **«Oppdater no» er berre tilgjengeleg når du køyrer appen sjølv**: den
  nedlastbare pakka, Docker eller `php -S` frå kjeldekoden. På ein vanleg
  webhost er knappen alltid stengd, same kva som står i `.env`. Før var han
  open på kvar host som ikkje hadde sett `CRON_SECRET`, slik at kven som helst
  kunne setje i gang NVE-hentingar.
- **Rate-limiten kan ikkje lenger omgåast** med ein forfalska
  `X-Forwarded-For`-header. Headeren vert berre lesen frå proxyar appen stolar
  på (lokale/private adresser, eller dei du fører opp i `TRUSTED_PROXIES`).
- **Terrengoppslaga mot Kartverket går over HTTPS.** Punktet ditt gjekk før i
  klartekst.
- **Feilloggen inneheld ikkje lenger koordinatar** frå terrengoppslaga.
- **Integritetssjekk (SRI)** på alle bibliotek som vert lasta frå CDN.

### Nytt

- **Adressesøket verkar på telefon.** På smale skjermar er det eit ikon som
  breier seg over heile topplinja når du trykkjer på det. Før hadde feltet
  plass til 0–3 teikn.
- **Større kart før fyrste analyse** på mobil: panelet er lågt til det finst
  eit resultat.
- **Desimalkomma** i alle tal som vert viste (`53,4 dB`, `1,75 km`), òg på
  grafaksane. Koordinatar har framleis punktum.
- **Ekte ikon** i fanen og på heimeskjermen, og **førehandsvising** når ei
  lenke til eit punkt vert delt.
- **Valfri nattleg oppdatering av turbindata** for den som hostar appen sjølv
  på ein webhost utan cron (`.github/workflows/oppdater-turbindata.yml`).

### Raskare

- **JavaScript vert komprimert** på Apache-hostar. Apache sender `.js` som
  `text/javascript`, som regelen i `.htaccess` ikkje fanga: 566 KB i staden for
  188 KB ved kvar kalde lasting.
- **Kortare serversvar**: flyttal vert alltid skrivne i kortaste form, uansett
  PHP-oppsettet på hosten (opptil 3× mindre).
- **Chart.js vert lasta først når det trengst** (69 KB spart på kvar
  sidevising).
- **Turbinar og område vert henta parallelt** ved oppstart.

### Retta

- **Enter på ein knapp trykkjer den knappen.** Medan eit nytt punkt venta på
  stadfesting, starta Enter analysen same kva som hadde fokus — også på
  «Forkast punktet».
- **Ny CSS/JS etter ei oppdatering vert alltid henta.** Før kunne stilarket
  vere opptil ei veke gammalt.
- **Feila høgdeoppslag** set kartet tilbake til det analyserte punktet, og
  staden du valde står att med «Analyser her», så du kan prøve igjen med eitt
  trykk. Tidsgrensa mot Kartverket er auka frå 20 til 30 sekund.
- **Panoramaet og fotomontasjen** fører fokus ut når dei vert lukka, og
  kontrollane i eit lukka overlegg kan ikkje lenger nåast med Tab.
- **Bakgrunnsknappane** («Topo / Gråtone / Flyfoto») sprengde kortet sitt på
  mobil.
- Terrengoppslag med **berre eitt punkt** feila alltid hos Kartverket.
- Feil som appen sjølv fangar, kjem no med i den sentrale feilloggen.

### For deg som hostar appen sjølv

- **Docker publiserer no berre på `127.0.0.1:8011`**, same standard som
  pakkane. Vil du nå appen frå andre einingar, byt til `"8011:8011"` i
  `docker-compose.yml` — og set då `CRON_SECRET`.
- **Ny innstilling `TRUSTED_PROXIES`** i `.env` for proxyar med offentleg
  adresse framfor appen. Sjå `.env.example`.
- **`.htaccess` er endra (CONFIG-VERSION 6).** Last han opp på nytt. Han
  blokkerer òg låsefiler frå FreeFileSync (`*.ffs_lock`).

---

## [v0.3.0] — 2026-09-12

### Nytt

- **Støykonturar på kartet**: ringar rundt kvar turbin der L<sub>den</sub>
  fell til 45 og 40 dB.
- **Skjermbilete-eksport** av kartutsnittet som PNG.
- **To-punkts-kalibrering i fotomontasjen**: peik ut to turbinar i fotoet, så
  vert kameraretning og synsfelt rekna ut.
- **«Kva om»-scenario for turbinstorleik** på anlegg under handsaming.

### Endra

- Lasteindikatorar overalt der appen ventar på nettet, med tikkande sekundtal
  når Kartverket er tregt.
- Skog-markørane i panoramaet er rolegare og stengjer ikkje lenger utsynet.

---

## [v0.2.4] — 2026-08-31

- `start.sh` tilbyr å stoppe ein gammal server som held porten.

## [v0.2.3] — 2026-08-31

- Den nedlastbare utgåva forsvinn ikkje lenger stille ved feil: vindauget
  står att med ei forklaring.

## [v0.2.2] — 2026-08-31

- Skarpare flyfoto i panoramaet og på kartet.
- Hinderlyset i panoramaet sit på rotorhuset.
- Tilgjenge: `aria-pressed` på brytarknappar, fokusfelle i «Om modellen»,
  Escape lukkar dialogen.

## [v0.2.1] — 2026-08-30

- Opprydda topplinje: handlingar som krev eit analysert punkt, er flytta til
  sidepanelet.
- Statusflagga i turbinlista står i ei fast, synleg klynge.

## [v0.2.0] — 2026-08-30

### Nytt

- **Adressesøk** (Kartverket, via backenden).
- **Lokalt synlegheitskart**: eit rutenett rundt punktet farga etter kor mange
  turbinar som er synlege frå kvar rute.
- **Fotomontasje**: turbin-omriss oppå eit eige foto.
- **Éin-sides PDF-rapport** for punktet.
- **Kumulativ horisontbelastning**: kor stor del av synsranda turbinane
  fyller.

## [v0.1.6] — 2026-08-30

- Utgåve-id ved overskrifta; knappar sperrar seg medan dei arbeider.

## [v0.1.5] — 2026-08-30

- Diskré varsel om gamle turbindata (med «Oppdater no») og om nye utgåver.

## [v0.1.4] — 2026-08-30

- Turbindata følgjer med pakka; nettlesaren opnar seg når serveren er klar.

## [v0.1.1 – v0.1.3] — 2026-08-30

- Pakkar for Linux, macOS og Windows, med eige produksjonsoppsett for PHP.

## [v0.1.0] — 2026-08-30

Fyrste nedlastbare utgåve. Klikk eit punkt på kartet og sjå kva vindturbinar
som **faktisk er synlege** derifrå, ut frå terrengprofilar frå Kartverket, med
støyestimat mot T-1442, hinderlys om natta, teoretisk skyggekast,
3D-panorama med flyfoto, og kryssjekk mot skog og bygningar.

[v0.4.0]: https://github.com/joamort/vindkraft-paavirkning/releases/tag/v0.4.0
[v0.3.0]: https://github.com/joamort/vindkraft-paavirkning/releases/tag/v0.3.0
[v0.2.4]: https://github.com/joamort/vindkraft-paavirkning/releases/tag/v0.2.4
[v0.2.3]: https://github.com/joamort/vindkraft-paavirkning/releases/tag/v0.2.3
[v0.2.2]: https://github.com/joamort/vindkraft-paavirkning/releases/tag/v0.2.2
[v0.2.1]: https://github.com/joamort/vindkraft-paavirkning/releases/tag/v0.2.1
[v0.2.0]: https://github.com/joamort/vindkraft-paavirkning/releases/tag/v0.2.0
[v0.1.6]: https://github.com/joamort/vindkraft-paavirkning/releases/tag/v0.1.6
[v0.1.5]: https://github.com/joamort/vindkraft-paavirkning/releases/tag/v0.1.5
[v0.1.4]: https://github.com/joamort/vindkraft-paavirkning/releases/tag/v0.1.4
[v0.1.1 – v0.1.3]: https://github.com/joamort/vindkraft-paavirkning/releases
[v0.1.0]: https://github.com/joamort/vindkraft-paavirkning/releases/tag/v0.1.0
