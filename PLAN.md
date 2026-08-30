# Vindkraft-påverknad — prosjektplan

Interaktivt webkart som viser korleis planlagde/eksisterande vindkraftanlegg på land
visuelt og støymessig påverkar eit sjølvvalt punkt (t.d. eigen bustad). Brukaren
klikkar eit punkt på kartet, appen finn alle turbinar i nærleiken, og reknar ut
– basert på terrengdata – kva som faktisk er synleg og kor mykje støy som kan
forventast.

Teknisk grunnlag: vanilla JS (ES6-moduler) + Leaflet i frontend, PHP 8 +
filbasert JSON-cache i backend, delt webhotell (ingen Node/build-steg i
produksjon).

---

## 1. Mål og omfang

- Vise alle vindkraftanlegg på land i Noreg — i drift, under bygging, og
  under konsesjonshandsaming/planlagde — i eitt kartlag.
- La brukaren setje **eitt punkt** (klikk på kart, adressesøk, eller
  "min posisjon") som representerer bustaden/staden dei vil vurdere.
- For kvar turbin innanfor ein relevant radius: rekne ut
  - **Synlegheit** — er turbinen faktisk synleg frå punktet, gitt terrenget
    mellom dei (ikkje berre luftlinje-avstand)?
  - **Visuell dominans** — kor stor/dominerande verkar turbinen i synsfeltet?
  - **Støynivå** — forenkla estimert lydnivå ved punktet.
- Presentere dette visuelt: siktlinjer på kartet, ein høgdeprofil-graf per
  turbin, og eit samandragspanel.
- **Ikkje** eit erstattar for offisiell konsekvensutgreiing (KU) eller
  akustisk fagrapport — eit forenkla, illustrativt verktøy for folk flest.
  Dette skal seiast tydeleg i UI (sjå §7).

---

## 2. Datakjelder (offentlege, norske)

| Data | Kjelde | Format/tilgang | Bruk |
|------|--------|-----------------|------|
| Vindkraftanlegg (i drift, under bygging, konsesjon/planlagt) | NVE — `Vindkraft2` MapServer: `nve.geodataonline.no/arcgis/rest/services/Vindkraft2/MapServer` (også speila på `kart.nve.no/enterprise/rest/services/Vindkraft2/MapServer`) | ArcGIS REST, spør med bbox → JSON/GeoJSON. WMS finst òg. | Turbinposisjonar, status, evt. navhøgde/rotordiameter/tal på turbinar |
| Same datasett, nedlastbart | Geonorge / data.norge.no — datasett "Vindkraftverk" | Shapefile (konverterbar til GeoJSON) | Fallback/backup-kjelde, og til å verifisere feltnamn |
| Nasjonal ramme for vindkraft (bakgrunn/eigna areal) | NVE `NasjonalRammeVindkraft` MapServer | ArcGIS REST/WMS | Valfritt bakgrunnslag i V2 |
| Terrenghøgde — punkt | Kartverket `ws.geonorge.no/hoydedata/v1/punkt` (nyare høgde/dybde-API, JSON) | REST, eitt punkt om gongen | Høgde ved brukarens punkt og ved kvar turbin |
| Terrenghøgde — profil langs linje | Kartverket WPS `wps.geonorge.no/skwms1/wps.elevation2` (`elevationJSON`), inntil ~400 punkt per kall, jamt fordelt | WPS/REST | Høgdeprofil mellom brukarpunkt og kvar turbin — grunnlag for siktlinjeberekning |
| Adressesøk (finn "mitt hus") | Kartverket adresse-API | REST/JSON | Valfri innskyting i staden for/i tillegg til kart-klikk |
| Støygrenser/rettleiing | T-1442 (støy i arealplanlegging) + evt. eigen vindkraft-støyrettleiing frå Miljødirektoratet/NVE | Dokument, ikkje API | Fargekoding av resultat (sjå §4.3) |

> **Handling før koding starter:** verifiser faktiske feltnamn i NVE sitt
> `Vindkraft2`-lag (statuskode, navhøgde, rotordiameter, tal på turbinar —
> desse manglar ofte eller er ufullstendige for planlagde anlegg) og test
> WPS-profiltenesta manuelt med eit par kjende koordinatar, før
> `ElevationProxyService` byggjast. Datakvalitet varierer mykje mellom
> anlegg i tidleg planfase vs. anlegg i drift.

---

## 3. Brukarflyt

1. Kartet opnar med alle vindkraftanlegg synlege, fargekoda etter status
   (grøn = i drift, gul = under bygging, oransje = planlagt/konsesjon).
2. Brukaren klikkar eit punkt på kartet (eller søkjer adresse). Punktet
   vert markert ("Mitt punkt").
3. Appen finn alle turbinar innanfor t.d. **20 km** (visuell relevans-radius;
   støy er normalt berre reelt relevant innanfor 3–5 km, men same radius
   brukast til synlegheitsvisning).
4. For kvar turbin: hent høgdeprofil, rekn ut synlegheit + visuell dominans
   + støyestimat (§4). Vis framdriftsindikator — dette er fleire nettverkskall.
5. Resultat:
   - **Kart:** linje frå punktet til kvar turbin — heiltrekt grøn = synleg,
     stipla grå = skjult av terreng.
   - **Sidepanel:** liste over turbinar sortert på avstand, med
     synleg/skjult-ikon, dominans-kategori, estimert støynivå.
   - **Detaljvising per turbin:** høgdeprofil-graf (sideprofil av terrenget
     mellom punktet og turbinen, med siktlinja og turbintårnet teikna inn) —
     gjer det intuitivt *kvifor* noko er synleg/skjult.
   - **Samandrag øvst:** "N av M turbinar innan 20 km er synlege. Næraste
     synlege turbin: X km, estimert støy Y dB(A)."
6. Tydeleg, alltid synleg fotnote/disclaimer (§7).

---

## 4. Berekningsmetodikk

Alle berekningar kan gjerast **klient-side i JS** (enkel geometri/matte) —
einaste serveravhengige delen er å *hente* høgdedata (proxy+cache, §5).

### 4.1 Synlegheit (siktlinje / viewshed)

For eit brukarpunkt **P** og ein turbin **T**:

1. Hent bakkehøgde ved P (`e_P`) og ved T (`e_T`).
2. Turbinens toppunkt (vengetupp) = `e_T + navhøgde + rotordiameter/2`.
   Observatørhøgd ved P = `e_P + ~1,6 m` (augehøgd).
3. Hent høgdeprofil for terrenget langs den rette linja P→T (WPS,
   jamt fordelte punkt, tettleik avhengig av avstand).
4. For kvart profilpunkt på avstand `d` frå P (total avstand `D` til T):
   - Rekn ut forventa siktlinje-høgd ved lineær interpolasjon mellom
     augehøgd (ved d=0) og vengetupp-høgd (ved d=D).
   - Trekk frå **jordkrumming + refraksjon**: `fall ≈ d·(D−d) / (2·R_eff)`,
     med `R_eff ≈ 7/6 · jordradius` (standard tilnærming for synlegheit over
     lengre avstandar — vesentleg for turbinar >5–10 km unna).
   - Er terrenghøgda på det punktet *høgare* enn den korrigerte
     siktlinja → turbinen er **heilt eller delvis skjult**.
5. Resultat: `synleg` (ingenting blokkerer), `delvis synleg` (t.d. berre
   vengetuppane over ein ås), eller `skjult`. MVP kan forenkle til
   binært synleg/skjult basert berre på vengetupp-høgda; delvis-kategori
   er ei naturleg V2-utviding (rekn òg siktlinje til navhøgd/tårnbase).

Profilen i steg 3 er `dtm1` — **bar bakke**. Skog og bygningar kjem inn som ein
eigen kryssjekk i det punktet som avgjer skrapelinja; sjå **§4.11**.

### 4.2 Visuell dominans (angulær storleik)

- Vertikal vinkel turbinen "tek opp" i synsfeltet:
  `θ_vertikal ≈ atan(total_høgd_relativt_til_auge / avstand)`.
- Ein mykje brukt tommelfingerregel i vindkraft-visuell-analyse er å måle
  avstand **i tal rotordiameter (RD)** i staden for meter — same turbin
  verkar dramatisk annleis på 3 RD enn på 30 RD. Grov kategorisering
  (må kvalitetssikrast mot ei konkret norsk/nordisk kjelde før dette
  visast som "offisielle" tersklar i UI — sjå merknad under):
  - < 3 RD: svært dominerande
  - 3–10 RD: tydeleg/dominerande
  - 10–20 RD: merkbar
  - 20–35 RD: mindre framtredande
  - \> 35 RD: liten visuell påverknad
- **Merknad:** desse tersklane er ein *heuristikk* frå internasjonal
  landskapsanalyse-litteratur, ikkje ein norsk forskriftsverdi. Presenter i
  UI som "rettleiande kategori", med kjelde/atterhald synleg — ikkje som
  ein fasit. Verifiser mot ev. norsk NVE-rettleiar før lansering.

### 4.3 Støy (forenkla modell)

- Kjeldestyrke: bruk ein standard lydeffektverdi (`L_WA`, typisk
  ~105–107 dB(A) for moderne landbaserte turbinar) som default når NVE-data
  ikkje oppgir dette per turbin/modell — synleggjer i UI at dette er eit
  **estimat**, med moglegheit for avansert brukar å justere.
- Utbreiing (forenkla sfærisk spreiing, à la ISO 9613-2 utan full
  diffraksjonsmodell):
  `Lp(d) ≈ L_WA − 20·log₁₀(d) − 11 − A_luft(d) − A_bakke − A_skjerming`
  - `A_skjerming`: ekstra dempingsbonus når §4.1 seier turbinen er heilt/
    delvis skjult av terreng (grov tilnærming, ikkje full Maekawa-diffraksjon).
- Summer bidrag frå fleire turbinar energetisk (`10·log₁₀(Σ 10^(Lp_i/10))`)
  for eit samla estimat, ikkje berre næraste turbin.
- Fargekod resultat mot referanseverdiar frå T-1442 (og eigen
  vindkraft-støyrettleiing der den finst): t.d. grøn < 35 dB(A),
  gul 35–40 dB(A) ("merkbar"), raud > 40 dB(A) ("over vanleg tilrådd grense").
- **Dette er ein grov illustrasjon, ikkje ein akustisk fagrapport** —
  seiast eksplisitt i UI (§7). Ekte støyvurderingar i konsesjonssaker bruker
  fullstendig ISO 9613-2-modellering med målt kjeldedata per turbinmodell.

### 4.4 Hinderlys (nattsynlegheit)

Vindturbinar er luftfartshinder og skal merkjast med lys etter **forskrift
15. juli 2014 nr. 980** (BSL E 2-1). Merk at den eldre forskrift 3. desember
2002 nr. 1384 (BSL E 2-2) ofte vert sitert, men er **erstatta** — og hadde
ingen reglar om mellom-/høyintensitetslys på turbinar i det heile.

- Merkeplikt frå **60 m totalhøgd** (§ 7 andre ledd). «Høyde på vindturbin» er
  definert i § 3 f. som terreng → vengetupp i høgaste stilling.
- **Under 150 m** (§ 16(3) b): to mellomintensitets hinderlys type B eller C på
  nacellen — raudt, 2 000 cd, fast eller blinkande.
- **Frå 150 m** (§ 16(3) c): to høyintensitets type B på nacellen — **kvitt,
  alltid blinkande**, 100 000 cd dag / 2 000 cd natt — pluss lavintensitets
  type B (raudt, 32 cd) på mellomnivå, høgst 75 m mellom lysa.
- Blinkande lys i same vindpark skal blinke **samtidig** (§ 16(3) a).

Synlegheita for kvart lyspunkt reknast mot **same terrenghorisont** som §4.1
alt har rekna ut — eit lyspunkt på høgda `h` er synleg når
`bakkeVedTurbin + h > horisontMoh`. Ingen nye høgdeoppslag trengst.

Lysstyrke visast som **tilsynelatande stjernemagnitude**, med atmosfærisk
ekstinksjon for klar natt, fordi candela-verdiar ikkje kommuniserer. Eit
2 000 cd-lys er Venus-klasse på 5 km.

**Atterhald som må stå i UI:** dette er forskriftas *minstekrav*, ikkje eit
register over montert utstyr. Sidan 2024 kan konsesjonæren søkje om
**behovsstyrt lyssetting (ADLS)** etter § 7a (radar/transponder slår lyset på
først når fly nærmar seg), og § 16(3) f. opnar for at berre turbinane i
anleggets **perimeter** vert merkte. NVE-datasettet har ingen av delane.

### 4.5 Skyggekast (shadow flicker)

**Noreg har inga fastsett grenseverdi.** NVE har derimot ein forvaltningspraksis
(veileder 2/2014, oppdatert med Norconsult 2022) med to tilrådde grenser for
bygningar med skyggekastfølsam bruk:

| storleik | grense |
|---|---|
| **teoretisk** skyggekast | 30 t/år eller 30 min/dag |
| **faktisk** skyggekast | 8 t/år |

Appen reknar det **teoretiske** talet og må difor målast mot 30-timarsgrensa —
ikkje mot 8-timarsgrensa, som gjeld ein annan storleik.

Metode:

1. Solposisjon frå **NOAA-likningane**, rekna klientside (ingen ekstern
   teneste). Tilsynelatande høgd, altså med refraksjonskorreksjon.
2. Berre minutt med solhøgd **> 3°** (tysk WEA-Schattenwurf-terskel, som NVE
   seier praksisen er i tråd med).
3. Rotoren som ei ugjennomsiktig **skive alltid vend mot sola** — verste
   tenkelege geometri, same føresetnad som WindPRO/WindFarmer.
4. Maks relevant avstand **13,8 · rotordiameter**, klemt til 2 km. Utleidd frå
   NVE sitt 20 %-kriterium for dekking av solskiva; for ein 150 m rotor gir det
   2 070 m, som er NVE si eiga yttergrense.
5. Terrenget frå §4.1 avgjer om det aktuelle punktet på rotoren er synleg.

Punktsummen er ei **union** over turbinar (kvart minutt tel éin gong), fordi
grensa gjeld tida punktet er utsett. Resultatet visast som timar/år, verste
døgn, og eit månad × time-varmekart.

### 4.6 Turbinutplassering for anlegg utan fastsett posisjon

Anlegg under konsesjonshandsaming har ingen turbinkoordinatar hos NVE, men
`areas.json` har det **verkelege planområdet** som polygon (same `anleggsnr`).

Algoritme (`backend/services/TurbineLayout.php`, cacha permanent):

1. Kandidatrutenett i polygonet, forskuve annakvar rad, avstand **1,5 · RD**.
2. Stikkprøve på 12 punkt — er området sjø, hopp over (senterpunkt-fallback).
3. Terrenghøgd for alle kandidatar, batcha gjennom WPS-en.
4. Kast punkt på ueigna grunn (Havflate, Innsjø, Elv, Tettbebyggelse); straff
   Myr og DyrketMark.
5. Score = **lokal prominens** + 0,25 · (høgd − områdemiddel), begge i meter.
6. Grådig utval frå toppen med minst **3 · RD** mellom valde punkt, slakka i
   trinn ned til 2,2 RD om N ikkje får plass.

Turbintalet kjem frå kuratert søknadstal → NVE `antallturbiner` → utleidd frå
effekt (6,0 MW/turbin for planleggingssaker). Berre levande statusar får
utplassering; tilbaketrekte saker med spekulative effekttal ville gitt hundrevis
av fiktive turbinar.

Resultatet er merkt `posisjon_kilde: "estimert_i_omrade"` og teikna med eit eige
symbol. **Målt mot vindparkar som faktisk er bygde** ligg kvar verkeleg turbin
typisk 170–180 m (~1,3 RD) frå næraste estimerte punkt — mot 284–378 m for
tilfeldig plassering og 1 733–3 148 m for eittpunkts-plasshaldaren.

### 4.6b Brukarjustering av estimerte turbinposisjonar

Utplasseringa i §4.6 er god på anleggsnivå, men den einskilde koordinaten er ei
gjetning — og brukaren som bur i området kjenner ofte terrenget betre enn
heuristikken. Punkta appen sjølv har plassert (`estimert_i_omrade`) og
eittpunkts-plasshaldarane (`anlegg_senterpunkt`) kan difor **dragast på kartet**,
og analysen for nettopp den turbinen — siktlinje, dominans, støy, hinderlys,
skyggekast — vert rekna om for den nye staden med det same.

**`nve_turbinpunkt` kan ikkje dragast.** Der har NVE oppgitt koordinaten; å la
brukaren flytte han ville vore å forfalske verifisert offentleg data. Sperra er
teknisk absolutt: dei punkta er `L.circleMarker`, som ikkje har Leaflet sin
drag-handterar i det heile, medan dei flyttbare er `L.marker` med divIcon.

Eit flytta punkt får ein **eigen** posisjonskjelde-verdi, `brukerjustert`, ikkje
ei overskriving av den gamle — merkt overalt i UI, tilbakestillbart, og berre
levande i sideøkta. Justeringa lagrast ikkje: dette er eit «kva om»-verktøy, og
ei lagra brukargjetning ville ikkje hatt noko meiningsfullt svar neste gong cron
hentar nye data frå NVE.

Planområdet frå `areas.json` vert framheva medan brukaren drar, og ein toast
seier mildt ifrå når punktet hamnar meir enn 200 m utanfor — men draginga vert
aldri sperra. Skyggekast og samla støy reknast om for **heile** resultatsettet
(unionen over årets minutt kan endre seg når ein turbin flyttar seg), medan
soltabellen for punktet vert gjenbrukt.

### 4.7 Stadfesting før analyse

Ein analyse hentar terrengprofilar for inntil 150 turbinar i fleire parallelle
kall mot Kartverket. Eit kartklikk set difor berre eit **kandidatpunkt** — heilt
utan nettverkskall — og analysen startar først når brukaren trykkjer «Analyser
her» (eller Enter). Eit tidlegare analysert punkt vert ståande med resultata
sine, så eit feilklikk kostar korkje trafikk eller tapt arbeid.

Delbare lenker (`?lat=&lon=`) analyserer med det same: å opne ei slik lenke er
i seg sjølv eit eksplisitt val.

### 4.8 3D-panorama med flyfoto drapert over terrenget

Panoramaet (`js/ui/PanoramaView.js`, `js/utils/Horizon.js`) set brukaren i
punktet og lèt han snu seg 360° rundt. Det legg **ingen nye modellføresetnader**
til — horisonten kjem frå same `skannHorisont()` som sidepanelet bruker per
turbin, berre i eit jamt rutenett av 72 kompassretningar, og kvar turbin vert
klipt analytisk mot si eiga `synlegheit.horisontMoh` i staden for mot ein
djupnebuffer. Står det «70 % synleg» i panelet, er det 70 % som stikk opp i
biletet.

**Bakken er ekte ortofoto** (`js/utils/SatelliteTexture.js`), ikkje ei
prosedyregenerert fargeflate.

*Val av kjelde.* Kartverket sitt eige flyfoto («Norge i bilder») er den
openberre kandidaten og klart best i oppløysing, men WMTS-en krev token —
`tilecache.norgeibilder.no` svarar `{"error":{"code":499,"message":"Token
Required"}}`. Appen har ikkje eit slikt abonnement, og eit token i
frontend-koden ville uansett vore publisert. **Esri `World_Imagery`** er valt i
staden: fritt utan nøkkel, `Access-Control-Allow-Origin: *`, og allereie i bruk
som eit bakgrunnslag i 2D-kartet — same bilete i begge visingane.

*Henting.* Flisane vert henta som `<img crossOrigin="anonymous">`, ikkje med
`fetch()`. Ei biletehenting fell under CSP-direktivet `img-src` (som alt listar
`server.arcgisonline.com` for Leaflet), medan `fetch()` ville falle under
`connect-src`, som her berre er `'self'`. Difor korkje CSP-endring eller
PHP-proxy. `crossOrigin` er likevel naudsynt, elles vert lerretet taint-a og
WebGL nektar å bruke det som tekstur.

*Oppløysing.* Tre ringar med kvar sin zoom, sidan eit panorama ikkje har jamn
skjermoppløysing over bakken slik Web Mercator har. Ved 64° nord:

| Ring | Radius | Zoom | Oppløysing | Flisar |
|---|---|---|---|---|
| nær | 900 m | 16 | ~1,0 m/px | ~56 |
| midt | 4 km | 14 | ~4,2 m/px | ~72 |
| fjern | 20 km | 12 | ~17 m/px | ~121 |

Zoomnivået vert valt som det høgaste som held seg innanfor eit **flisbudsjett**,
ikkje ut frå ei ønska meter-per-piksel: Mercator-oppløysinga går som cos(lat),
så eit fast meterkrav ville gitt vilt ulike flistal på 58° og 71° nord.
Terrengmeshen vert delt på dei same radiane, med grenseringa av vertexar i
begge nabomeshane, slik at det ikkje vert nokon sprekk i skøyten.

*Yting.* Flishentinga køyrer parallelt med horisonthentinga — dei deler korkje
tenar, kø eller data. Begge er cacha klientside.

*Fallback.* Berre den ytterste ringen er obligatorisk. Ein tapt flis vert fylt
med ei nøytral terrengfarge; feilar over halvparten, vert heile dekket forkasta
og den prosedyregenererte fargelegginga teikna i staden. Aldri ein tom eller
broten mesh.

*Atterhald.* Eit foto ser meir autoritativt ut enn ei fargeflate, så
atterhaldet i HUD-en er skarpare når fotoet er i bruk: skog og bygningar SYNEST
i biletet, men dei ligg flatt på bakken og skjermar difor ingenting. Sjølve
synlegheitsmodellen er framleis rein DTM (§7).

### 4.9 Nærfelt-fortetting av terrengmeshen

`js/utils/NaerTerreng.js` tredoblar den asimutale oppløysinga i meshen —
216 retningar i staden for 72 — for dei fyrste 1 200 metrane. Det legg
**ingen nye modellføresetnader** til: horisont, siktlinjer, synlegheit og
klippeplan kjem framleis frå dei 72 lange strålane. Dette er berre betre
geometri for BILETET.

*Kva facetten faktisk var.* Utgangspunktet var at strålane «glisnar frå
kvarandre i meter» nær observatøren, og at svaret var eit kartesisk rutenett
på 40–60 m. Rekninga sa noko anna: den asimutale facetten er 360/72 = **5°
uansett avstand**, og i meter er 5° berre 4,4 m på 50 m og 8,7 m på 100 m.
Eit 50 m-rutenett ville altså vore 6–11× GROVARE enn dagens mesh nettopp der
problemet er, og fyrst vunne noko bortanfor ~600 m. Fortettinga er difor
asimutal, med same radielle topologi som før.

*Kvifor ikkje WCS/GeoTIFF.* Kartverket har eit ekte høgderaster på
`wcs.geonorge.no/skwms1/wcs.hoyde-dtm-nhm-25833`, men det leverer berre
`GeoTIFF`. Det måtte parsast i rein PHP, sidan delt webhotell korkje har GDAL
eller Imagick — eit stort og skjørt prosjekt for noko me får billegare med
det JSON-API-et appen allereie brukar.

*Eitt felles radiusrutenett.* Alle retningar vert sampla om til nøyaktig dei
same radiane: serveren si 15 m-nærsone urørt ut til 300 m, så 60 m ut til
1 200 m, så dei lange strålane sine eigne ~124 m ut til 20 km. Då er
trianguleringa den same løkka som før, berre med fleire retningar — ingen
stitching, ingen hól, ingen skøyt.

*To ting som måtte lærast undervegs, begge verifiserte i nettlesar:*

- **Ein ring må ha éi oppløysing, ikkje to.** Fyrste utgåva sparte 72
  hentingar ved å la dei lange strålane dekkje sine eigne asimutar heilt inn.
  Det gav ein sagtann med periode nøyaktig tre retningar, fordi kvar tredje
  stråle var radielt glatta (~124 m) medan naboane var skarpe (60 m). I eit
  regulært mesh er det UNIFORMITETEN som avgjer korleis flata les, ikkje kor
  god kvar enkelt verdi er.
- **Meshen må ikkje vera finare enn datagrunnlaget.** På 15 m avstand ligg
  216 strålar berre 0,44 m frå kvarandre, og éin meter terrenghøgd er der
  3,8° synsvinkel — same D/d-forsterking som §7 skildrar for siktlinjer.
  Ringar der den asimutale punktavstanden fell under 4 m vert difor glatta
  sirkulært til den oppløysinga. Grensa slår inn under ~46 m og er ein
  nulloperasjon utanfor.

*Kostnad, målt.* 216 korte profilar (~36 punkt kvar) i 22 HTTP-kall med 6
samtidige. Kaldt punkt: **+9–12 s**. Varmt punkt: **~130 ms**. Meshen går frå
13 100 til 40 600 hjørne. Etter §4.10 ligg denne kostnaden ikkje lenger på den
kritiske stien: nærfeltet vert bytt inn i eit panorama som alt er oppe.

### 4.10 Progressiv oppbygging av panoramaet

Panoramaet venta opphavleg på at horisont, nærfelt og flyfoto ALLE var ferdige
før scena i det heile vart teikna. Målt ventetid med tom skjerm: **11,6 s** på
eit punkt der alle høgdedata låg i cache, og **71,4 s** på eit kaldt punkt.

Scena vert no bygd opp i den rekkjefølgja dataa er verdt:

| steg | kjelde | kva det gir |
|---|---|---|
| 0 | `state.resultat` (alt klart) | turbinar, hinderlys, klippeplan |
| 1 | fyrste horisont-batch (6 av 72 strålar) | **scena opnar** — grov 360°-form |
| 2 | resten av horisont-batchane | silhuetten skjerpar seg, 6 retningar om gongen |
| 3 | `NaerTerreng` (216 retningar) | fortetta geometri dei fyrste 1,2 km |
| 4 | flisringane, kvar for seg | flyfoto erstattar prosedyrefargen, ring for ring |

Resultat: **940 ms** til fyrste bilete på eit varmt punkt (12× raskare) og
**10–12 s** på eit kaldt (6–7×).

*Ingen ny modellføresetnad.* Kva som er synleg er avgjort av analysen —
turbinane vert klipte mot `synlegheit.horisontMoh` frå §4.1, som ligg ferdig
før panoramaet opnar. Panoramahorisonten styrer berre kor nøyaktig BAKKEN er
teikna, så eit grovt mellomsteg kan ikkje få panelet og biletet ut av takt.

*Kvifor ventetida måtte omgåast og ikkje kortast ned.* Kjeda php →
`ElevationService` → Kartverket WPS parallelliserer dårleg: eitt kall med seks
målpunkt tek 11,1 s, og tre samtidige tek 32,2 s til saman (11 / 22 / 32 —
reint sekvensielt). Fleire eller mindre HTTP-kall flyttar ikkje totaltida
nemneverdig; det einaste som hjelper er å slutte å vente på henne.

*Batchane er fletta rundt kompasset.* Batch nr. 0 inneheld retningane
0, 12, 24 … — seks strålar 60° frå kvarandre — ikkje 0–5. Ei samanhengande
gruppe ville gitt eitt skarpt 30°-utsnitt og 330° utsmurt terreng, altså eit
bilete som ser øydelagt ut i staden for grovt. Retningar som enno ikkje har
landa får ein profil blanda frå næraste ferdige nabo på kvar side, slik at
meshen alltid dekkjer heile kompasset. Det gjeld **berre** delresultat; det
ferdige svaret er bit for bit uendra.

*Atterhaldet følgjer tilstanden.* HUD-teksten oppgir det EKTE talet skanna
retningar undervegs («18 av 72 så langt»), seier eksplisitt at terrenget
framleis er under henting, og skjerpar seg til flyfoto-formuleringa i §4.8
først når biletet faktisk er der.

---

### 4.11 Skog og bygningar — DOM-kryssjekk i det kritiske punktet

Siktlinjeberekninga i §4.1 kviler på Kartverkets **terrengmodell** `dtm1` —
bar bakke. Det gjer verktøyet systematisk optimistisk (§7): ein turbin bak ein
granskog vert meld som synleg. Kartverket har òg overflatemodellen **`dom1`**,
der høgda er det laseren traff først (trekruner, hustak).

**DOM kan ikkje hentast som profil.** WPS-en som §4.1 bruker tek ingen
`datakilde`-parameter — berre `gpx`, `points` og `places`. DOM finst berre
gjennom REST-punkttenesta, som til gjengjeld tek **50 punkt per kall**.

Løysinga er difor målretta i staden for uttømmande:

1. Hovudanalysen køyrer som før, på DTM. Han peikar allereie ut **eitt**
   terrengpunkt per turbin — det som gir den høgaste skrapelinja.
2. På brukarens forespurnad («Sjekk skog og bygningar», eller automatisk for
   den eine turbinen ein opnar detaljvisinga på) vert dei punkta slått opp i
   `dom1`, inntil 50 per kall.
3. Er overflata meir enn **2 m** over bakken der, vert horisonten rekna om att
   med den heva høgda substituert inn i akkurat det punktet, og synlegheita
   vurdert på nytt med **same** fire-delte skala som hovudmodellen.

**Resultatet er einsidig påliteleg.** DOM ≥ DTM overalt, så substitusjonen kan
berre heve horisonten. Blir turbinen skjult, er han skjult; står han att som
synleg, kan skogen likevel stå i eit anna punkt langs profilen. Talet er ei
**nedre grense** for skjermingsverknaden, og skal formulerast slik i UI.

Målt på Odal vindkraftverk (tett granskog) frå eit skogspunkt 3 km unna: 9 av
21 turbinar synlege på bar bakke, 6 med skogen rekna med — og ein turbin gjekk
frå 82 % synleg til heilt skjult av 18,2 m skog 90 m frå observatøren. Frå
snaufjellet ved Storheia gir sjekken null utslag (høgaste avvik 1,39 m), som er
kontrollen på at han måler noko som faktisk står der.

**Atterhald som må stå i UI:** at sjekken gjeld eitt punkt og ikkje heile
profilen, og at laserdataen kan vere fleire år gammal — er skogen hoggen sidan,
står han framleis i modellen.

Full grunngjeving: CLAUDE.md §22.

---

## 5. Arkitektur (i tråd med TECH_STACK.md)

### Frontend — vanilla JS, ES6-moduler, Leaflet, Manager-mønster

| Modul | Ansvar |
|-------|--------|
| `js/ui/MapManager.js` | Kartoppsett, turbinlag (MarkerCluster ved lågt zoom), punktplassering, teikning av siktlinjer |
| `js/utils/geo.js` | Rein matte: avstand, bæring, jordkrumming-korreksjon, vinkelberekning |
| `js/utils/ImpactCalculator.js` | Orkestrerer synlegheit + dominans + støy per turbin, gitt høgdeprofil-data frå API-et |
| `js/ui/ImpactPanel.js` | Sidepanel med turbinliste, samandrag |
| `js/ui/ProfileChart.js` | Høgdeprofil-graf per turbin (Chart.js, alt godkjent bibliotek) |
| `js/ui/PanoramaView.js` | 3D-panorama (Three.js, lasta med `import()` først ved bruk): terrengmesh, turbinar, hinderlys, sol/tid |
| `js/utils/TurbinJustering.js` | Kven kan dragast, flytt/tilbakestill av posisjon, planområde-test (§4.6b) |
| `js/utils/Horizon.js` | 360°-terrenghorisont i 72 retningar — same `skannHorisont()` som sidepanelet. Leverer brukbare delresultat undervegs (§4.10) |
| `js/utils/SatelliteTexture.js` | Esri-flyfoto henta som flisar og sett saman til teksturringar (§4.8) |
| `js/api.js` | Eitt API-abstraksjonsmodul for alle HTTP-kall (etablert mønster frå RegSøk/TagTrack) |

### Backend — PHP 8, filbasert JSON-cache

| Fil | Ansvar |
|-----|--------|
| `backend/api/turbines.php` | Serverer cacha turbindata (GeoJSON) til frontend, filtrert på bbox |
| `backend/api/elevation_profile.php` | CORS-proxy mot Kartverket WPS/punkt-API, **URL-allowlist-mønster** (som StrømbruddKart sine `*_proxy.php`) — validerer input, aldri ope relé |
| `backend/services/NveVindkraftFetcher.php` | Hentar frå NVE `Vindkraft2` ArcGIS REST, normaliserer til internt GeoJSON, skriv `cache/turbines.json` |
| `cron/fetch_turbines.php` | Cron-inngang (cPanel), køyrer fetcheren t.d. dagleg |

### Cache-strategi

- **Turbindata**: endrar seg sjeldan → dagleg/vekentleg cron, filbasert JSON
  (Apache serverer direkte, ingen PHP-overhead ved lesing — same mønster som
  PolitiKartet).
- **Høgdeprofil-kall**: dynamiske (avheng av brukarens punkt), men *terrenget
  endrar seg aldri* → server-side fil-cache nøkla på avrunda
  koordinatpar (t.d. næraste 25–50 m for start/slutt-punkt), i praksis
  permanent cache med enkel opprydding av minst-brukte oppføringar om
  diskbruk vert eit problem.

---

## 6. Filstruktur

```
vind/
  index.html
  css/
  js/
    ui/           MapManager.js, ImpactPanel.js, ProfileChart.js
    utils/        geo.js, ImpactCalculator.js, SurfaceCheck.js
    api.js
  backend/
    api/          turbines.php, elevation_profile.php, surface_points.php
    services/      NveVindkraftFetcher.php
  cron/            fetch_turbines.php
  cache/           turbines.json, elevation/ (fil-cache per koordinatnøkkel)
  assets/
  manifest.json    (PWA — valfritt, fase 4)
  sw.js
  .htaccess
  .env
```

---

## 7. Avgrensingar, presisjon og ansvarsfråskriving

- **Ikkje** ei erstatning for offisiell konsekvensutgreiing eller akustisk
  fagrapport (NS/ISO-standard modellering brukt i reelle konsesjonssaker).
  Skal stå tydeleg og synleg i UI, ikkje gøymd i ei footer-lenke.
- Terrengmodellen fangar ikkje skog, bygningar eller andre
  siktlinje-hindringar utover bar bakke (DTM, ikkje DOM/DSM) — kan gjere
  verktøyet **optimistisk** på synlegheit (viser synleg noko som i praksis
  er skjult av skog). Nemn dette eksplisitt.
  **Delvis adressert i §4.11:** DOM-kryssjekken slår opp overflatemodellen i
  det eine punktet som avgjer siktlinja, og viser kva skogen der gjer med
  svaret. Han er eit tillegg, ikkje ei erstatning — hovudtalet er framleis bar
  bakke, og sjekken er ei **nedre grense** for skjermingsverknaden.
- Støymodellen er ei grov illustrasjon (spredningslov + valfri
  skjermingsbonus), ikkje full ISO 9613-2 med verkeleg vêr-/vind-avhengig
  refraksjon. Reelle turbinstøynivå varierer mykje med turbinmodell og
  driftsmodus.
- Datakvalitet for **planlagde** anlegg er ofte ufullstendig (manglar
  navhøgde/rotordiameter/eksakt turbinposisjon før detaljplan) —
  vis tydeleg når verdiar er antatt/default framfor kjeldefesta.
- Ein **brukarjustert** turbinposisjon (§4.6b) er brukarens eige scenario, ikkje
  ei ny opplysning om kva som er omsøkt. Han må vere merkt som slik overalt tala
  hans visast, og må aldri kunne forvekslast med ein NVE-koordinat.

---

## 8. Personvern

- Brukarens valde punkt handsamast **berre klient-side + i sjølve
  API-kallet** for å hente terrengdata — **lagrast ikkje server-side**.
- Ingen kontobruk/innlogging naudsynt for kjernefunksjonen.
- Geolocation API brukast berre etter eksplisitt brukarhandling (knapp),
  aldri automatisk ved sideinnlasting.
- Ei eventuell "lagre/del vurdering"-funksjon (fase 4, t.d. delbar lenke med
  koordinatar i URL) er opt-in og inneheld ikkje persondata utover eit
  koordinatpunkt brukaren sjølv valde å dele.

---

## 9. Fasar

| Fase | Innhald |
|------|---------|
| **0 — Verifisering** | Test NVE `Vindkraft2`-endepunkt og Kartverket WPS-profiltenesta manuelt, avklar faktiske feltnamn/datakvalitet |
| **1 — MVP** | Kart med turbinlag frå cache, punktplassering, avstandsliste, binær synleg/skjult-berekning (§4.1), ingen støy enno |
| **2 — Støy** | Legg til forenkla støymodell (§4.3), fargekoda resultat |
| **3 — Visualisering** | Høgdeprofil-graf per turbin (Chart.js), visuell dominans-kategori (§4.2) |
| **4a — Nattbilete, sol og plassering** | Eigar-etikett, hinderlys + nattmodus (§4.4), skyggekast (§4.5), estimert turbinutplassering i planområde (§4.6), brukarjustering av dei estimerte posisjonane (§4.6b), stadfesting før analyse (§4.7) |
| **4c — 3D-panorama** | Three.js-panorama med analytisk klipping (§4.8), ekte ortofoto drapert over terrenget (§4.8), asimutal nærfelt-fortetting av meshen (§4.9), progressiv oppbygging av scena (§4.10) |
| **4d — Skog og bygningar** | DOM-kryssjekk i det kritiske siktlinjepunktet (§4.11) — den fyrste konkrete motvekta mot bar-bakke-avgrensinga i §7 |
| **4b — Finpuss** | Adressesøk, PWA/offline for turbinlaget, skjermbilete-eksport. Delbar lenke er alt på plass |
| **5 — Utviding (valfri)** | Nærare ISO 9613-2-modell, per-turbinmodell lydeffektdata, "kva om"-scenario for turbinstørrelse på planlagde anlegg, *faktisk* skyggekast med skydekke-/vindstatistikk, vindrose i utplasseringsheuristikken |

---

## Kjelder

- [NVE Vindkraft temakart](https://temakart.nve.no/tema/vindkraftverk)
- [NVE Vindkraft2 MapServer](https://nve.geodataonline.no/arcgis/rest/services/Vindkraft2/MapServer)
- [Vindkraftverk-datasett, data.norge.no](https://data.norge.no/en/datasets/49d58bce-7a28-4b3c-9e6a-cef0df042fd6/vindkraftverk)
- [Kartverket — Høydedata og dybdedata](https://www.kartverket.no/en/api-and-data/terrengdata)
- [Kartverket — Høydeprofil](https://www.kartverket.no/en/api-and-data/friluftsliv/hoydeprofil)

**Hinderlys (§4.4)**

- [Forskrift 15. juli 2014 nr. 980 om rapportering, registrering og merking av luftfartshinder (BSL E 2-1)](https://lovdata.no/dokument/SF/forskrift/2014-07-15-980) — § 3 f., § 7, § 7a, § 16, vedlegg 2 og 5. **Denne erstattar** forskrift 2002-12-03-1384 (BSL E 2-2), som framleis vert feilsitert mange stader.
- [Luftfartstilsynet — merking av luftfartshinder i vindkraftverk](https://www.luftfartstilsynet.no/aktorer/luftfartshinder/merking-av-luftfartshinder-i-vindkraftverk/)
- [Luftfartstilsynet — endringar i forskrift om luftfartshinder (ADLS frå 2024)](https://www.luftfartstilsynet.no/om-oss/nyheter/nyheter-2024/endringer-i-forskrift-om-luftfartshinder/)

**Skyggekast (§4.5)**

- [NVE — skyggekast fra vindturbiner](https://www.nve.no/energi/energisystem/vindkraft-paa-land/kunnskapsgrunnlag-om-virkninger-av-vindkraft-paa-land/skyggekast-fra-vindturbiner/) — grenseverdiane, 20 %-kriteriet, 2 km-avgrensinga
- [NVE — ny norsk praksis for skyggekast (veileder 2/2014)](https://kommunikasjon.ntb.no/pressemelding/ny-norsk-praksis-for-skyggekast-fra-vindkraftverk?publisherId=89280&releaseId=3629612)
- [Videnomvind.dk — beregning af skyggekast fra vindmøller](https://videnomvind.dk/wiki/beregning-af-skyggekast-fra-vindmoller/)
- [DNV WindFarmer — Shadow Flicker calculation reference](https://mysoftware.dnv.com/download/public/renewables/windfarmer/manuals/latest/CalcRef/ShadowFlicker/shadowFlicker.html)
- [WindPRO — SHADOW-Berechnungsmethode](https://help.emd.dk/mediawiki/index.php/SHADOW-Berechnungsmethode) — 3°-terskelen og 20 %-dekkingskriteriet
