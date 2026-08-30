# Vindkraft-påverknad – Claude-kontekst

## Kva er dette?

Interaktivt webkart som viser korleis vindkraftanlegg på land visuelt og støymessig
påverkar eit sjølvvalt punkt (t.d. brukarens bustad). Brukaren klikkar eit punkt,
appen finn turbinar i nærleiken, hentar terrengprofilar frå Kartverket, og reknar ut
kva som **faktisk er synleg** — ikkje berre kor langt unna turbinane står.

Full arkitektur, datakjelder og fase-inndeling: **[PLAN.md](PLAN.md)**.

Status: **fase 0–3 ferdig** (MVP + støymodell + høgdeprofil-graf + visuell dominans),
**fase 4a ferdig** (eigar, hinderlys/nattmodus, skyggekast, estimert turbinutplassering,
stadfesting før analyse, brukarjustering av estimerte turbinposisjonar),
**3D-panorama med flyfoto og nærfelt-fortetta terrengmesh** (§16–18),
**DOM-kryssjekk mot skog og bygningar** (§22).

## Teknisk stack

- **Frontend:** Vanilla JS (ES6-moduler), Leaflet + MarkerCluster, Chart.js, Font Awesome
- **Backend:** PHP 8, filbasert JSON-cache, ingen database
- **Ingen build-steg.** Node brukast berre lokalt i `tools/` til testing, aldri i produksjon.

## Mappestruktur

```
index.html            – Heile appen (kart + sidepanel + info-modal)
css/styles.css        – All styling (design tokens som CSS-variablar)
js/
  app.js              – VindApp: bootstrap, event-delegation, orkestrering
  config.js           – ALLE modellkonstantar og tersklar, med grunngjeving
  state.js            – Einaste kjelde til appens tilstand (observerbar)
  api.js              – Alle HTTP-kall. Resten av appen kallar aldri fetch direkte
  ui/
    MapManager.js     – Leaflet: bakgrunnslag, turbinar, område, siktlinjer
    ImpactPanel.js    – Sidepanel: samandrag, turbinliste, detaljvising
    ProfileChart.js   – Høgdeprofil-graf per turbin (Chart.js)
    PanoramaView.js   – 3D-panorama (Three.js): terrengmesh med flyfoto, turbinar, sol/tid.
                        Opnar på fyrste horisont-batch og byggjer seg vidare (§21)
    Toast.js          – Toast-meldingar
  utils/
    geo.js            – Rein matte: avstand, kurs, jordkrumming, synsvinkel
    ImpactCalculator.js – Siktlinje + dominans + støy + hinderlys per turbin.
                        `vurderSynlegheit()` er skild ut, so DOM-sjekken (§22)
                        kan bruke NØYAKTIG same skala
    SurfaceCheck.js   – DOM-kryssjekk: skog/bygningar i det kritiske punktet (§22)
    NoiseModel.js     – Forenkla støymodell + T-1442-kategorisering
    ObstacleLights.js – Hinderlys etter FOR-2014-07-15-980 § 16 + magnitude
    ShadowFlicker.js  – NOAA-solposisjon + teoretisk skyggekast + soltabell
    AnalyseRunner.js  – Batching, parallellitet og straumande delresultat
    TurbinJustering.js – Kven kan dragast, flytt/tilbakestill, planområde-test
    Horizon.js        – 360°-terrenghorisont (72 retningar) + profilane til meshen.
                        Leverer brukbare delresultat undervegs (§21)
    NaerTerreng.js    – Asimutal fortetting (216 retningar) av meshen i nærfeltet
    SatelliteTexture.js – Esri-flyfoto som teksturringar til panoramaet
    ErrorReporter.js  – Fangar klientfeil og POSTar til den delte feilloggen
    dom.js            – escHtml(), formatering, debounce (med .avbryt())
backend/
  api/
    turbines.php          – Cacha turbindata, valfritt radius-/statusfiltrert
    elevation_point.php   – Terrenghøgd i eitt punkt
    elevation_profile.php – Terrengprofilar (batch), proxy mot Kartverket WPS
    surface_points.php    – Overflatehøgd (dom1) i inntil 100 punkt, kvitlista kjelde (§22)
  data/
    turbine_specs_known.json – KURATERT: turbinmål lesne ut av søknadsdokument.
                               Handskriven, versjonskontrollert, aldri regenerert.
  services/
    NveVindkraftFetcher.php – Hentar + normaliserer NVE-data → cache
    ElevationService.php    – WPS-batching + permanent fil-cache.
                              `sourcePoints()` gir dtm1/dom1 via punkt-API-et (§22)
    TurbineSpec.php         – Turbinmål: kuratert først, elles estimert frå effekt
    KnownSpecRegistry.php   – Oppslag i den kuraterte JSON-fila (nøkla på anleggsnr)
    TurbineLayout.php       – Estimert turbinutplassering i NVE sitt planområde
    RateLimiter.php         – Filbasert rate limiting per IP
    Http.php                – cURL med stream-fallback
cron/fetch_turbines.php – Cron-inngang (dagleg)
cache/                  – turbines.json, areas.json, layouts.json, elevation/ (gitignored)
tools/verify_model.mjs  – Lokal testsuite som køyrer den EKTE frontend-koden
```

## Dei viktige avgjerdene

### 1. WPS-en er ein batch-oppslagsteneste, ikkje berre ein profilteneste

Kartverket sin `wps.elevation2` er dokumentert som «høgdeprofil langs ei linje».
**Verifisert eksperimentelt:** når talet på GPX-trackpunkt er *nøyaktig* lik
`points`-parameteren, returnerer tenesta høgda i akkurat dei punkta du sende inn —
**også når punkta utgjer fleire heilt usamanhengande linjestykke i ulike delar av landet.**

Det gjer han til ein batch-teneste for inntil ~400 vilkårlege punkt per kall. Utan
dette ville eit punkt med 200 turbinar innanfor 20 km krevd 200 separate kall
(fleire minutt); med batching går det ned til ~10 kall.

`distance`-feltet frå WPS-en er kumulativt langs heile den samansette tracken og
er difor meiningslaust ved batching — me reknar alltid avstand sjølv (haversine).

### 2. Lag 5 hos NVE er ikkje ein eigen statuskategori

`Vindkraft2` MapServer har overlappande lag. **Lag 5 (`konsesjonsbehandling`, 302
anlegg) er verifisert å vera nøyaktig unionen av lag 6+7+8+9.** Å behandle det som
ein sjølvstendig status ville gitt dublettar. Status vert difor avgjort av
**lag-tilhøyrsle med eksplisitt presedens** (sjå `PLANT_LAYERS`), ikkje av
`status`-feltet — som er inkonsistent (lag 5 har rader med status «D» og stadium
«Søknad trukket» samtidig).

Feltnamna i `attributes` er **små bokstavar** (`effekt_mw`, `antallturbiner`,
`fylkenavn`), ikkje slik dei står i `fieldAliases`. Me les alltid case-insensitivt.

### 3. Turbinmål finst ikkje i kjelda og er ESTIMERTE

Verken lag 0 eller lag 4 har navhøgde eller rotordiameter — felta finst ikkje.
`TurbineSpec.php` interpolerer difor mot ein tabell av **reelle turbinmodellar som
faktisk står i norske anlegg**, ut frå merkeeffekt per turbin (`effekt_mw` delt på
faktisk tal turbinpunkt).

Treffsikkerheita er god: Storheia → 87 m nav / 130 m rotor, som er nøyaktig
Siemens SWT-DD-130 som faktisk står der. Øyfjellet → 105/149 = Nordex N149.

**Alt dette er likevel estimat**, merkt `mal_kilde: "estimert"` i cachen og flagga
i UI overalt. Sjå PLAN.md §7. Unntaket er dei 25 anlegga som har ei kuratert
oppføring — sjå §4.

### 4. Kuraterte søknadstal går føre estimat — og tabelltoppen var for låg

To ting vart avdekte då estimata vart haldne opp mot verkelege søknader:

**a) Referansetabellen toppa ut for lågt.** `REFERENCE_MODELS` slutta på
`[8.00, 120.0, 170.0]` — 205 m totalhøgd — medan reelle norske søknader i
6–9 MW-klassa no ber om **220–270 m**. Feilen var navhøgda, ikkje rotoren:
gjennomgang av produsentdatablada for 2024–2026 viser at **rotordiameteren mettar
rundt 175 m** (ingen landbasert turbin i Europa er større), medan **tårnet veks** —
same rotor vert seld med nav frå 100 til 199 m. Dei tre øvste punkta er difor
erstatta med `[6.60, 150, 170]`, `[7.20, 160, 172]` og `[9.00, 170, 175]`, med
kjelder i koden. Punkta til og med 5,60 MW er **urørte**, sidan dei er kalibrerte
mot turbinar som faktisk står i norske anlegg (Storheia 87/130, Øyfjellet 105/149).

Merk at 9,00 MW er eit reint ekstrapolasjonspunkt: det finst ingen landbasert
turbin over 7,2 MW i sal. 8–9 MW i norske søknader er takhøgd i konsesjonsramma,
ikkje ein katalogvare.

**b) For 25 namngjevne anlegg har me lese søknaden.** Turbinmål står berre i
meldings- og søknads-PDF-ane, ikkje i noko API. Dei er difor manuelt research-a
inn i `backend/data/turbine_specs_known.json` — versjonskontrollert, og **aldri
regenerert av cron**. `TurbineSpec::resolve()` sjekkar `KnownSpecRegistry` først
(`mal_kilde: "kjent_soknad"`, med kjelde-URL heilt fram til ei lenke i
detaljvisinga) og fell berre tilbake til generisk estimering elles.

Tre reglar som er lette å mistolke:

- **Øvre ende av eit spenn er visingsverdien.** Appen illustrerer kva ei utbygging
  *kan* innebere; då er det meir ansvarleg å vise for høgt enn for lågt. Heile
  spennet ligg i `mal_spenn` og visast ved sida av.
- **Oppslag skjer på `anleggsnr`, ALDRI på namn når anleggsnr finst.** Verifisert
  eksperimentelt kvifor: fornyingssaker heiter nesten det same som anlegget dei
  skal fornye, og med namnefallback slo «Kjøllefjord vindkraftverk» (14835,
  planlagt, 220 m) gjennom på «Kjøllefjord» (9574) — anlegget som faktisk står der
  frå 2006 med 17 turbinar på 126 m. Ytre Vikna, Raggovidda og den eldre
  Skjøtningberg-saka vart råka likt. Byter NVE eit anleggsnr, går oppføringa heller
  «daud», og `verify_model.mjs` §7 feilar høglydt.
- **Kjelda er ikkje ein fasit.** `kjelde_status` skil melding frå søknad frå
  vedtak. Moldalsknuten gjekk frå 250 m i meldinga til 200 m i søknaden — det som
  vert søkt om er ikkje det som vert bygd.

To korrigeringar av det opphavlege utgangspunktet, verifiserte mot primærkjelde:

- **Kjøllefjord:** Statkraft si prosjektside seier 200–260 m, men NVE-meldinga
  seier **180–220 m**. Me følgjer meldinga.
- **Buheii er med vilje IKKJE kuratert.** Tala 94/112 m (søkt) og 87/126 m (NVE
  sitt brev om effektauke) skildrar begge ein *føresetnad* om ein 3,6 MW-turbin.
  Det som faktisk står der frå 2021 er 19 × Vestas V150-4.2 = 105/150, som den
  generiske tabellen alt treffer. Ei kuratert oppføring ville vore ein regresjon.

Anlegg der researchen ikkje fann konkrete tal (Grøndalsfjellet, Mariafjellet,
Snefjord, Gravdal m.fl.) er medvite utelatne og fell tilbake til estimering.
Grunngjevinga for kvar av dei står i `_utelatne` i JSON-fila.

### 5. Berre 1381 turbinar har eksakt posisjon

Lag 4 dekkjer berre anlegg i drift / under bygging (61 anlegg). Planlagde anlegg
har **ingen** fastsette turbinposisjonar. Dei vert difor representerte med **eitt
plassholdar-punkt** i anleggets senter (`posisjon_kilde: "anlegg_senterpunkt"`,
teikna med stipla ring på kartet, merkt «heile anlegget» i lista).

Støymodellen skalerer slike punkt energetisk med `+10·log₁₀(N)` der N er
`antallturbiner` — grovt, men langt betre enn å late som anlegget har éin turbin.

### 6. Siktlinje: «høgaste skrapelinje», ikkje binær test

For kvart terrengpunkt reknast kva høgd ein stråle frå auget som så vidt skrapar
det punktet ville nå ved turbinen:

```
h_skrape(d) = z_auge + (z_korrigert(d) − z_auge) · (D / d)
```

Maksimum av desse er **terrenghorisonten**. Alt på turbinen over den er synleg.
Éin operasjon gir binær synlegheit, synleg *del*, om navet er synleg, og kva
terrengpunkt som faktisk skjermar (til grafen).

`z_korrigert` = terrenghøgd minus jordkrumming/refraksjon (`R_eff = 7/6 · R`),
som utgjer ~6,7 m på 20 km — nok til å avgjere saka når terrenget skummar linja.

### 7. To ting som følgjer av (6), og som er lette å mistolke som feil

**a) Faktoren D/d forsterkar nærfeltet enormt.** Eit punkt 60 m unna med eit mål
12 km unna har faktor 200: éin meter feil i terrenghøgda gir 200 m feil i
horisonten. Difor samplar `ElevationService` **tettare i dei første 300 m**
(15 m mellomrom) enn i resten av profilen (60 m).

**b) Ein liten haug rett ved punktet kan skjule ein heil vindpark — og det er
fysisk korrekt.** Verifisert mot to uavhengige Kartverket-API-ar: eit punkt ved
Storheia (63.84, 10.14) ligg ved foten av ein rygg som stig 17 m på 75 m (15°),
og skjuler dermed turbinar som berre står 7° over horisonten. Resultatet er rett,
men **svært følsamt for kvar brukaren klikka**. Difor set modellen eit
`naerskjerming`-flagg når det kritiske punktet er < 300 m unna, og UI-et ber
brukaren flytte punktet litt for å teste kor følsamt det er.

### 8. Synlegheitsskalaen er fire-delt av ein grunn

Eit krav om 100 % synleg er meiningslaust i praksis: for eit anlegg på ein
fjellrygg, sett nedanfrå, er **tårnfoten nesten alltid gøymd**. Verifisert mot
Storheia frå eit ope punkt 3,3 km unna: dei øvste turbinane er 70 % synlege med
navet i fri sikt, dei lågare heilt borte. Ein 99 %-terskel ville stempla begge
som «delvis».

Skalaen: `skjult` (<2 %) → `saa_vidt` (<15 %) → `delvis` (nav skjult eller <90 %)
→ `synleg` (nav fritt *og* ≥90 %).

### 9. Støy: L_den mot T-1442, ikkje vilkårlege tersklar

PLAN.md §4.3 foreslo grøn <35 / gul 35–40 / raud >40 dB. Det er **bevisst endra**:
T-1442 sin faktiske rettleiande grense for vindkraft er **L_den 45 dB**, så det er
den appen måler mot.

Modellen reknar L_pA (konstant nivå) og legg på **+6,4 dB** for å få L_den — det
eksakte påslaget for ei kjelde som går jamt heile døgnet:
`10·log₁₀((12 + 4·10^0,5 + 8·10)/24) = 6,4`.

Luftabsorpsjonen er **0,003 dB/m** (ISO 9613-2 for 500–1000 Hz ved norske forhold),
ikkje 0,005. Kalibrering: L_den 45 dB-konturen rundt éin 3,6 MW-turbin hamnar då på
~600 m, L_den 40 dB på ~950 m, som stemmer med publiserte norske støysonekart.

**Rapporteringsgolv 25 dB.** Under det visast «under 25 dB» i staden for eit tal —
bakgrunnsstøy på landet er 25–35 dB, så «7 dB» er matematisk rett men gir eit
falskt inntrykk av presisjon. Den eksakte verdien brukast framleis i summeringa.

### 10. Hinderlys: forskrifta er frå 2014, ikkje 2002 — og fargen skiftar ved 150 m

Det finst to forskrifter om merking av luftfartshinder, og sekundærlitteraturen
siterer ofte feil. **FOR-2014-07-15-980 (BSL E 2-1) er den gjeldande**; ho står
eksplisitt med «Endrer FOR-2002-12-03-1384» (BSL E 2-2). Skilnaden er ikkje
kosmetisk: 2002-forskrifta hadde **ingen** reglar om mellom-/høyintensitetslys på
turbinar, og ingen § 7a om behovsstyrt lyssetting. Ei implementering bygd på 2002
ville vore feil på alle dei punkta som betyr noko her.

Reglane som er implementerte i `ObstacleLights.js` er siterte verbatim i
`CONFIG.hinderlys`. Dei tre som er lette å ta feil av:

- **§ 3 f. definerer «høyde på vindturbin»** som terreng → vengetupp i høgaste
  stilling. Det er nøyaktig vår `totalhoyde_m`, ikkje navhøgda.
- **Toppmerkinga skiftar FARGE ved 150 m.** Under 150 m: to *mellomintensitets*
  type B/C, **raudt**, 2 000 cd. Frå og med 150 m: to *høyintensitets* type B,
  **kvitt og alltid blinkande** (100 000 cd dag / 2 000 cd natt), pluss raude
  lavintensitetslys på mellomnivå. Det er lett å anta «raudt heile vegen, berre
  fleire av dei» — og det er feil. Dei største turbinane har den lysklassen som
  er lettast å sjå om natta.
- **Nivåfordelinga på tårnet.** § 16(3) c. seier berre «maks 75 m mellom lysa»,
  medan vedlegg 5 seier «totalt 3 sett med lys». Me deler difor nacelletopp →
  terreng i `I = max(3, ceil(nav/75))` like intervall, som oppfyller begge.

**Synlegheit per lyspunkt kostar ingen nye høgdeoppslag.** `horisontMoh` frå §6
er ein eigenskap ved *terrenget* mellom punktet og turbinen, ikkje ved turbinen.
Same horisont gjeld difor for kvart punkt på turbinen, og eit lys er synleg når
`bakkeVedTurbin + høgdeOverBakke > horisontMoh`. Det gir uavhengige svar for
navlys og mellomnivålys utan å hente profilen på nytt.

**Lysstyrke vert rekna om til stjernemagnitude,** fordi «2 000 candela» ikkje
kommuniserer. `m = −2,5·log₁₀(I/d² / 2,54·10⁻⁶)` pluss atmosfærisk ekstinksjon
(1,086·3,912/V mag per km, V = 40 km klar natt). Eit 2 000 cd-lys er da
magnitude −3,2 på 5 km (Venus-klasse) og +1,4 på 20 km (framleis ei tydeleg
stjerne). Det er den einaste måten å gjere poenget om nattsynlegheit konkret.

**To atterhald som MÅ stå i UI**, fordi datasettet ikkje kan svare på dei:
ADLS (§ 7a, søknadsbasert sidan 2024 — lyset er avslege til radar/transponder
ser fly) og perimetermerking (§ 16(3) f. — for anlegg med fem eller fleire
turbinar kan berre ytterkanten merkast). Modellen viser difor eit **maksimum**.

### 11. Skyggekast: Noreg HAR ein praksis, og han gjeld teoretisk skyggekast

Utgangspunktet var at Noreg manglar tal og at ein måtte låne tysk/dansk praksis.
Det er halvvegs feil. NVE seier «I Norge er det ingen fastsatte grenseverdier»,
men har sidan **veileder 2/2014** ein forvaltningspraksis med to grenser for
bygningar med skyggekastfølsam bruk:

| | grense |
|---|---|
| **teoretisk** skyggekast | 30 t/år **eller** 30 min/dag |
| **faktisk** skyggekast | 8 t/år |

Skiljet avgjer heile presentasjonen. Modellen reknar det **teoretiske** talet
(skyfri himmel, rotor alltid i verste vinkel) — så han må målast mot 30-timars-
grensa. Å halde vårt tal opp mot 8-timarsgrensa, slik det er freistande når ein
berre har høyrt «åtte timar», ville vore ei systematisk overdriving på ~3,75×.

Geometrien er eksakt for ei skive, ikkje ei tilnærming. Ein stråle inn til auget
med solhøgd θ forlèt rotorplanet i høgda `pMoh = augeMoh + langs·tan(θ)`;
skuggen dekkjer punktet når `|pMoh − navMoh| ≤ R` og `|tvers| ≤ √(R² − dz²)`.
Begge endepunkta bruker ekte Kartverket-høgd, og terrenghorisonten frå §6
avgjer om nettopp det punktet på rotoren er synleg i det heile.

Tre val som er lette å mistolke:

- **Solhøgd-terskelen på 3°** er den tyske WEA-Schattenwurf-verdien (NVE seier
  praksisen er i tråd med Tyskland): under 3° gjer refraksjon og dis skuggen
  irrelevant. Solposisjonen bruker **tilsynelatande** høgd, ikkje geometrisk —
  det er der sola *synest* å stå som avgjer kvar skuggen fell.
- **Maks relevant avstand er utleidd, ikkje gjetta.** NVE sitt 20 %-kriterium
  («når mindre enn 20 prosent av solskiven er dekket…») krev at bladet spenner
  ≥1,45 mrad. Med ei midlere bladkorde på ~RD/50 gir det **13,8 · RD**, klemt
  til NVE si eiga yttergrense på 2 km. For ein 150 m rotor landar utleiinga på
  2 070 m — altså same tal som NVE oppgir. Tommelfingerregelen «10 · RD» gir
  same storleiksorden, men viser ikkje kvifor grensa finst.
- **Punktsummen er ei UNION, ikkje ei addisjon.** Fleire turbinar kan kaste
  skugge same minutt. Legg ein saman timane per turbin, får ein eit tal som ikkje
  svarer til noko (verifisert: tre nære turbinar gav 195 t summert mot 67 t reelt).
  NVE si grense gjeld tida punktet er utsett, så kvart minutt tel éin gong — via
  ei bitmaske over årets 525 600 minutt.

**Soltabellen byggjast éin gong per punkt**, ikkje per turbin: solposisjonen
avheng av punktet, ikkje av turbinen. Deklinasjon og tidsjamning reknast éin
gong per DØGN (dei endrar seg under 0,4°/dag), så berre timevinkelen varierer per
minutt. Det tek eit heilt år på minuttoppløysing ned til ~140 ms.

Solalgoritmen (NOAA) er verifisert mot kjende verdiar: Oslo sommarsolverv 53,54°
(teoretisk 53,53°), vintersolverv 6,78° (6,65° + refraksjon), soltidsmiddag
13:19 CEST, og midnattssol i nord ved Nordkapp.

### 12. Turbinutplassering: polygonet er kjeldefest, plasseringa er vår

Anlegg under handsaming har ingen turbinkoordinatar (§5), men `areas.json` har
det **verkelege planområdet** frå NVE, kobla på same `anleggsnr`. Turbinane
kjem til å stå inne i det polygonet — det er ikkje ei gjetting.

`TurbineLayout.php` legg eit kandidatrutenett i polygonet, hentar terrenghøgd i
kvart punkt, og vel grådig etter ein score som føretrekkjer **høgderyggar**,
med handheva minsteavstand. Resultatet er `posisjon_kilde: "estimert_i_omrade"`.

**Målt treffsikkerheit.** Metoden er halden opp mot vindparkar som FAKTISK er
bygde (der NVE har ekte turbinpunkt, så algoritmen aldri køyrer på dei — eit
reint held-out-sett). Median avstand frå kvar verkeleg turbin til næraste
estimerte punkt:

| Anlegg | ryggheuristikk | tilfeldig i polygon | gamle senterpunktet |
|---|---|---|---|
| Storheia (80) | **173 m** | 371 m | 2 688 m |
| Bjerkreim (37) | **178 m** | 378 m | 1 733 m |
| Roan (71) | **168 m** | 284 m | 3 148 m |

Altså ~1,3 rotordiameter typisk feil — dobbelt så godt som tilfeldig plassering,
og 10–19× betre enn eittpunkts-plasshaldaren det erstattar.

Fem val som er lette å gjere feil:

- **Kandidatrutenettet må vere TETTARE enn turbinavstanden.** Legg ein det med
  same avstand som turbinane skal ha (3–4 RD), er det ingenting igjen å velje:
  kvart rutepunkt vert ein turbin, og «heuristikken» er eit fast rutenett som
  ignorerer terrenget. Rutenettet ligg difor på **1,5 RD**, minsteavstanden på
  **3 RD** — 4–6 kandidatar per turbinplass.
- **«Høgt» må målast mot naboane.** Rein «vel dei høgaste punkta» legg alt i den
  eine enden av eit skrånande område. Scoren er `prominens + 0,25·(z − middel)`,
  begge ledd i meter, så vektinga er direkte tolkbar.
- **Fleire områdeoppføringar må vere SEPARATE polygon.** NVE har to områdelag (3
  og 10), og ei sak under handsaming ligg ofte i begge med same omriss. Slår ein
  ringane saman i éi liste, kansellerer odde/like-testen dei mot kvarandre og
  heile planområdet forsvinn. Verifisert på Moifjellet (14237): samanslått gav
  **null** kandidatpunkt. Odde/like gjeld innanfor eitt polygon (der ein indre
  ring korrekt vert eit hol); fleire polygon kombinerast som ei union.
- **Statusfilteret er viktigare enn det ser ut.** Utan det produserte steget
  ~9 400 punkt; med det ~1 060. Skilnaden er nesten heilt tilbaketrekte saker frå
  «Nasjonal ramme»-runden i 2019 med spekulative effekttal — Slettfjellet står
  med 2 000 MW og stadium «Melding trukket», som ville gitt 500 turbinar. Berre
  `under_behandling`, `konsesjon_gitt`, `konsesjon_ikke_bygd`, `under_bygging`.
- **Planlagde anlegg får 6,0 MW per turbin når turbintalet må utleiast frå
  effekt**, ikkje `TurbineSpec` sin generiske default på ~4 MW. Defaulten er
  kalibrert mot medianen i den parken som ALT STÅR; ei sak til handsaming i
  2024–2026 søkjer om 6–7 MW-maskiner. 4 MW ville gitt ~50 % for mange turbinar
  for nettopp dei anlegga steget gjeld.

**Eksakt haversine der talet vert publisert, planavstand berre i heuristikken.**
Nabosøket for prominens er O(n²) med n opp mot 1 500, så der er kvadrert
planavstand verdt det. Minsteavstanden derimot vert *vist* i UI («minst 520 m
mellom kvar»), og ein plan projeksjon er 0,2–0,4 % for kort i Finnmark
(Nordkyn på 71°N fekk 517,8 m der talet sa 519,9 m). Utvalsløkka går berre mot
alt valde punkt — maks 150 — så haversine kostar ingenting der.

Havområde vert kjende att på ei stikkprøve på 12 punkt (eitt WPS-kall) og
hoppa over: ryggheuristikken er meiningslaus på havbotn. Både positive og
NEGATIVE resultat cachast i `cache/layouts.json`, elles prøver cron det same
forgjeves kvar natt. Signaturen inneheld `LAYOUT_VERSJON`, så ei endring i
heuristikken invaliderer cachen automatisk.

### 13. Kartklikk peikar ut; det er stadfestinga som køyrer analysen

Ein analyse hentar terrengprofilar for inntil 150 turbinar frå Kartverket i
fleire parallelle kall. Til no køyrde han rett på kartklikket — altså for kvart
bomskot og kvar gong nokon berre klikka seg rundt for å sjå seg om.

Eit klikk set no eit **kandidatpunkt**: ingen nettverkskall i det heile, ikkje
eingong det eine oppslaget for bakkehøgd. Analysen startar først på «Analyser
her» (eller <kbd>Enter</kbd>; <kbd>Esc</kbd> forkastar). Verifisert i nettlesar:
fire kartklikk gir **null** kall mot `elevation_profile.php` og
`elevation_point.php`.

Tre detaljar som følgjer av dette:

- **Eit tidlegare analysert punkt vert ståande med resultata sine** medan
  kandidaten flyttar seg. Poenget er at eit feilklikk ikkje skal koste noko —
  verken nettverkskall eller arbeidet brukaren alt har fått gjort.
- **Å dra det analyserte punktet er òg berre å peike.** Markøren hoppar tilbake
  dit analysen faktisk gjeld, og den nye staden vert ein kandidat.
- **Delbare lenker (`?lat=&lon=`) analyserer med det same.** Å opne ei slik
  lenke ER eit eksplisitt val; å krevje eit klikk til ville berre vore friksjon.

Kandidatmarkøren er med vilje visuelt svakare (open, gråblå, roleg puls) enn den
analyserte, slik at det aldri er tvil om kva punkt tala i panelet gjeld.

### 14. Ein trailing debounce kan overskrive det ferdige resultatet

Analysen teiknar panelet på nytt for kvar ferdige batch (debouncet 120 ms), og
ein siste gong når alt er ferdig. Det ventande debounce-kallet fyrte då **etter**
den siste teikninga og overskreiv samandraget med delresultatet sitt — som ikkje
har skyggekast, sidan det reknast i eit etterpass over heile settet.

Symptomet var forvirrande: skyggekast-boksen mangla i samandraget, medan
skyggekast-ikona på kvar enkelt turbinrad var der. `debounce()` har difor ein
`.avbryt()`, som `analyser()` kallar før den siste teikninga.

### 15. Éin sentral feillogg — server OG klient, same fil

Fram til no forsvann feil stille: `elevation_profile.php` sitt
`catch (Throwable)` returnerte berre ei generisk 502-melding utan å ta vare på
`$e->getMessage()` nokon stad, og klientfeil (JS-unntak i nettlesaren til ein
faktisk brukar) synte seg aldri for utviklaren i det heile.

`backend/services/Logger.php` er filbasert (same mønster som RegSøk sin
manuelle loggrotering i TECH_STACK.md: sjekk storleik, `rename()` til `.1` ved
5 MB) og skriv til éi delt `logs/error.log` frå to kjelder:

- **Serverside:** kvart API-endepunkt (`turbines.php`, `elevation_point.php`,
  `elevation_profile.php`) og `ElevationService` sine WPS-/punkt-oppslag kallar
  no `Logger::error()`/`Logger::warn()` med den faktiske feilmeldinga (HTTP-
  status, unntaksklasse, tal målpunkt) FØR dei svarer klienten den same
  generiske meldinga som før. Klienten sitt svar er uendra — dette er reint
  eit tillegg for feilsøking.
- **Klientside:** `js/utils/ErrorReporter.js` fangar `window.onerror` og
  `unhandledrejection` (same mønster som PolitiKartet, jf. TECH_STACK.md) og
  POSTar til det nye `backend/api/log_error.php`, som skriv inn i same logg
  med `kilde: "klient"`. Dedupliserer per sideøkt og har eit hardt tak på 20
  rapportar/økt, slik at éin gjentakande feil i ei render-løkke ikkje kan
  spamme loggen.

**Fail-silent er gjennomgåande medvite** (jf. `RateLimiter` sitt fail-open):
loggforsøket sjølv er pakka i `catch (Throwable)` i `Logger::write()` — ein
feil i sjølve loggskrivinga skal aldri kunne velte kallaren.

**Personvern (PLAN.md §8) er uendra av dette:** loggen inneheld ALDRI
koordinatane til brukarens eige punkt — berre feilmeldingar, HTTP-status og
tekniske kontekstfelt. `RateLimiter::clientIp()` sin rå IP hamnar heller ikkje
i loggen.

`logs/` er gitignored (som `cache/`), men må finnast og vere skrivbar av
webserveren i produksjon — same krav som `cache/`, sjå Hosting-spesifikke
hensyn i TECH_STACK.md.

### 16. 3D-panoramaet: Three.js frå CDN, og analytisk klipping

Panoramaet (`js/ui/PanoramaView.js` + `js/utils/Horizon.js`) legg ikkje til
ei einaste ny modellføresetnad — det er ei anna FRAMSTILLING av tal som alt er
rekna ut. Horisonten kjem frå `skannHorisont()` i geo.js, same funksjon
`ImpactCalculator` kallar per turbin, berre i eit jamt rutenett av 72
kompassretningar i staden for berre der det står ein turbin.

Tre val som er lette å gjere feil:

- **Three.js lastast med `import()` frå unpkg, ikkje ein `<script>`-tagg.**
  166 KB gzipa er meir enn Leaflet, Chart.js og heile appen til saman, og dei
  aller fleste opnar aldri panoramaet. Ein importmap var heller ikkje mogleg:
  `<script type="importmap">` ER inline, og `script-src` her har ingen
  `'unsafe-inline'`. Ein absolutt URL i sjølve import-setninga treng ingen
  kartlegging. UMD-bygget er dessutan deprecated frå r150.
- **Scenen ligg i «tilsynelatande» koordinatar.** Three.js kjenner ingen
  jordkrumming, så i staden for å bøye lyset er krumminga alt rekna inn i
  y-koordinaten (`z_moh − horisontfall(D) − z_auge`). Kameraet står i origo og
  treng ingen korreksjon. På 20 km er forskyvinga 26,9 m.
- **Klippinga er analytisk, ikkje ein djupnetest.** Å la GPU-en avgjere kva som
  er skjult ville gitt eit bilete som ikkje stemmer med tala i sidepanelet,
  fordi terrengmeshen berre er 72 strålar og bommar på ryggen mellom to av dei.
  Kvar turbin får difor eit `THREE.Plane` i akkurat den høgda
  `synlegheit.horisontMoh` seier. Terrengmeshen er kulisse; klippinga er fasit.

### 17. Flyfoto i panoramaet: Esri, fordi Kartverket sitt krev token

Terrenget var farga prosedyremessig (éin farge per terrengtype, pluss ei
deterministisk per-vertex støy). Det les auget som eit måla, «cartoon»-aktig
flak. `js/utils/SatelliteTexture.js` draperer no ekte ortofoto over meshen.

**Kartverket sitt eige flyfoto vart forkasta, ikkje oversett.** «Norge i
bilder» er langt betre enn noko globalt datasett, men WMTS-en er ikkje open —
verifisert med curl:

```
GET https://tilecache.norgeibilder.no/wmts/webmercator/...
→ {"error":{"code":499,"message":"Token Required"}}
```

Tenesta krev eit abonnement appen ikkje har, og eit token i frontend-koden
ville uansett vore å publisere det. Esri sitt `World_Imagery` er derimot
**allereie i bruk** som eit bakgrunnslag i 2D-kartet (`MapManager.js`), er
fritt utan nøkkel, og svarar `Access-Control-Allow-Origin: *`. At det er same
kjelde i 2D og 3D er eit poeng i seg sjølv: brukaren ser det same biletet.

Fem ting som er lette å gjere feil:

- **`<img crossOrigin="anonymous">`, ikkje `fetch()`.** Det er ikkje ein
  smaksdetalj. Ein `fetch()` fell under CSP-direktivet `connect-src`, som her
  berre er `'self'` (alle eksterne API-kall går gjennom PHP-backenden), og
  ville kravd ei CSP-endring eller ein proxy. Ei biletehenting fell under
  `img-src`, som ALT listar `server.arcgisonline.com` for Leaflet sin skuld.
  **Null CSP-endring, ingen proxy.** `crossOrigin` er likevel naudsynt: utan
  det vert lerretet taint-a, og WebGL nektar å laste opp eit taint-a lerret.
- **Ein oppløysingspyramide, ikkje éin tekstur.** Web Mercator har jamn
  oppløysing over bakken; eit panorama har det ikkje. Bakken 200 m unna fyller
  mange gonger så mange skjermpikslar som bakken 15 km unna. Tre ringar med
  kvar sin zoom (ved 64°N: z=16 ut til 900 m ≈ 1,0 m/px, z=14 ut til 4 km,
  z=12 ut til 20 km) gir ~250 flisar. Éin tekstur måtte anten vore grov nær
  eller kosta fleire hundre flisar for detalj ingen ser.
- **Zoom vert valt etter FLISBUDSJETT, ikkje etter ønska meter-per-piksel.**
  Mercator-oppløysinga går som cos(lat), så eit fast meterkrav ville gitt vilt
  ulike flistal på 58° og 71° nord. Planleggjaren går ovanfrå og ned til
  flisrektangelet er innanfor budsjettet.
- **Vertex-fargen må normaliserast før han multipliserast inn.** Ein skogfarge
  som `#2f4429` har lysstyrke 0,22 — å gange fotoet med den rått gjer heile
  biletet nesten svart. Fargen vert difor først normalisert til lysstyrke 1
  (så han berre ber FARGETONE) og deretter blanda 20 % mot kvit. Middelverdien
  av modulasjonen er 1: fotoet slepp gjennom uendra i lysstyrke, men held på
  det same djupne-hintet i dis som prosedyrefargen gav.
- **Anisotropisk filtrering er ikkje pynt her.** Terrenget vert nesten alltid
  sett i strøkvinkel — det er heile poenget med eit panorama. Utan
  `tex.anisotropy = getMaxAnisotropy()` vel mipmap-utveljinga etter den
  grovaste av dei to retningane, og bakken smører seg ut til graut nokre
  hundre meter framfor auget.

**Flishentinga køyrer PARALLELT med horisonthentinga** (`app.js
visPanorama()`). Dei deler korkje tenar, kø eller data — det einaste dei har
felles er lat/lon. `Promise.all` med `.catch()` på flis-leddet, ikkje utanpå:
eit flyfoto som ikkje kjem inn skal aldri kunne velte panoramaet.

**Fallbacken er graderande, ikkje binær.** Kvar ring er uavhengig; berre den
ytterste (som dekkjer heile scenen) er obligatorisk. Ein tapt flis vert fylt
med `grunnfarge`, ikkje eit hol. Feilar meir enn halvparten av flisane, er
«biletet» meir hol enn foto, og heile dekket vert forkasta til fordel for den
prosedyregenererte fargelegginga — som står urørt i koden nettopp for dette.

**Atterhaldet i HUD-en endrar seg med kva som faktisk vert vist.** Med
prosedyrefarge står det at skog og bygningar MANGLAR. Med flyfoto står det det
motsette og verre: skog og bygningar SYNEST i biletet, men dei ligg flatt på
bakken og skjermar difor ingenting. Eit foto ser meir autoritativt ut enn ei
fargeflate, så atterhaldet må vera skarpare, ikkje svakare.

### 18. Brukaren kan dra turbinane appen sjølv har plassert — og berre dei

1 062 av turbinpunkta er sette av VÅR EIGEN heuristikk (§12), og 212 til er berre
eit senterpunkt for heile anlegget (§5). Heuristikken bommar typisk ~1,3
rotordiameter, men på einskildpunkt mykje meir — og den som bur i dalen ser ofte
sjølv kva rygg turbinane kjem på. `js/utils/TurbinJustering.js` gjer den
kunnskapen brukbar: markøren kan dragast, og heile analysen for nettopp den
turbinen vert rekna om for den nye staden med det same.

**Skiljet er ikkje «kva er praktisk å tillate», men «kven har sagt at turbinen
står her».** `nve_turbinpunkt` (1 381 stk) er verifisert offentleg data og kan
ALDRI dragast — panelet ville elles rapportert «synleg frå bustaden din» for ein
turbin som i røynda står ein annan stad. Dei to andre kjeldene kan.

Fem ting som er lette å gjere feil:

- **`L.circleMarker` kan ikkje dragast i det heile.** Leaflet sin
  drag-funksjonalitet ligg i `L.Handler.MarkerDrag`, som berre `L.marker`
  koplar inn — ein circleMarker med `draggable: true` gjer ingenting. Dei
  flyttbare kjeldene fekk difor eit `L.divIcon` som etterliknar
  circleMarker-stilen, medan NVE-punkta står att som circleMarker. At sperra er
  eit *fråvær av handterar* og ikkje ein `if` er ein fordel: det finst ingen
  kodeveg som kan flytte eit verifisert punkt. Prisen er at markørane no har
  ulike API — `setStyle()` finst berre på circleMarker — så uthevinga går
  gjennom `_settUtheving()`, som tek den skilnaden.
- **Justeringa må bu i `state.turbinar`, ikkje i eit sideregister.** Ein
  `Map<id,{lat,lon}>` ved sida av ville måtte slåast opp av
  `finnTurbinarIRadius()`, kartteikninga, analysen og nattmodusen — fire stader,
  og den eine som gløymer det gir eit panel som reknar på ein annan posisjon enn
  kartet viser. I staden vert sjølve oppføringa bytt ut, med `opphavleg_lat/lon/
  posisjon_kilde` på objektet. Då treng tilbakestillinga ingen ekstra tilstand,
  og levetida vert automatisk rett: `turbinar` fyllast berre ved oppstart, så
  justeringa varer økta ut og forsvinn ved reload. Det er med vilje — dette er
  eit «kva om»-verktøy, ikkje ei datakjelde.
- **`opphavleg_*` vert sett berre FØRSTE gong.** Brukaren drar same turbin fem
  gonger; utan idempotens ville «tilbakestill» berre gått eitt steg tilbake, til
  det fjerde drop-punktet hans.
- **Skyggekastet MÅ reknast om for heile settet, ikkje berre for den flytta
  turbinen.** Punktsummen er ei union over årets minutt (§11): flyttar ein
  turbin seg, kan minutt som før var delte med ein nabo bli einerådande — eller
  motsett. Same gjeld den energetiske støysummen. Soltabellen derimot avheng
  BERRE av punktet og vert gjenbrukt (`_hentSoltabell()`), så den dyre delen
  (~140 ms) betalast éin gong per punkt, ikkje éin gong per drag.
- **Planområdet er eit mjukt grenseband, ikkje ei sperre.** Polygonet vert
  framheva medan brukaren drar, og ein toast seier ifrå når han slepp meir enn
  `CONFIG.analyse.flyttAatvaringM` (200 m) utanfor. Men draginga vert ikkje
  stoppa: brukaren kan tru at avgrensinga vert endra, eller vilje sjå kva ein
  turbin på naboryggen ville gjort. Terskelen ligg litt over rotordiameteren til
  ei stor landturbin, slik at ei justering langs kanten — der omrisset sjølv har
  nokre titals meter slark — ikkje pipar kvar gong.

Eit justert punkt får `posisjon_kilde: 'brukerjustert'` — ein EIGEN kategori, ikkje
ei overskriving — og er merkt med fiolett glorie på kartet, «flytta av deg» i
lista, og ein eigen boks HØGT i detaljvisinga (rett under synlegheitsstatusen,
ikkje nede blant atterhalda: det er ikkje eit atterhald om datakvalitet, men ei
opplysning om kven som har bestemt posisjonen tala under gjeld).

**Verifisert i nettlesar** mot Moifjellet (under handsaming) frå eit punkt 15 km
unna: å dra ein turbin 968 m endra han frå 53 % til 85 % synleg, flytta
«næraste turbin» i samandraget frå 8,38 til 8,62 km, og tilbakestillinga gav
nøyaktig dei opphavlege tala. Ein drag 1,59 km austover la turbinen i ein dal —
0 % synleg, med åtvaringstoast om at punktet låg utanfor planområdet.

### 18. Nærfeltet i panoramaet: facetten er ANGULÆR, ikkje metrisk

Bakken nær observatøren såg kantete ut. Den nærliggjande diagnosen — «72
strålar glisnar frå kvarandre i meter nær deg, legg eit kartesisk rutenett på
40–60 m i nærfeltet» — er **feil, og ville gjort det verre**.

Den asimutale facetten i eit radielt vifte-mesh er `360/72 = 5°` **uansett
avstand**. Rekna om til meter er 5° berre 4,4 m på 50 m og 8,7 m på 100 m,
medan den radiale samplinga der alt er 15 m. Eit 50 m-rutenett ville altså
vore 6–11× grovare enn dagens mesh nettopp der problemet er, og fyrst vunne
noko bortanfor ~600 m:

| avstand | 72 strålar (5°) | 50 m-rutenett |
|---|---|---|
| 50 m | 4,4 m | 50 m ← 11× grovare |
| 100 m | 8,7 m | 50 m ← 6× grovare |
| 300 m | 26 m | 50 m ← 2× grovare |
| 600 m | 52 m | 50 m ← om lag likt |
| 1200 m | 105 m | 50 m ← her byrjar rutenettet å vinne |

`js/utils/NaerTerreng.js` fortettar difor **asimutalt**: 216 retningar
(1,67°) ut til 1 200 m, med same radielle topologi som før. Utanfor
nærfeltet vert dei nye retningane interpolerte frå dei 72 lange — som er
nøyaktig same flate rasteriseraren alt teiknar, så fjernfeltet er
matematisk uendra (testsuiten §12 sjekkar at avviket er 0).

**WCS/GeoTIFF er vurdert og forkasta — ikkje oversett.** Kartverket har eit
ekte høgderaster på `wcs.geonorge.no/skwms1/wcs.hoyde-dtm-nhm-25833`, men det
leverer berre `GeoTIFF`. Å parse eit binært rasterformat i rein PHP, utan
GDAL eller Imagick på delt webhotell, er eit stort og skjørt prosjekt for
noko me får billegare med det JSON-batch-API-et appen alt har. **Ikkje prøv
den vegen på nytt.**

Fire ting som er lette å gjere feil:

- **Eitt felles radiusrutenett er heile trikset.** Alle retningar — lange og
  korte — vert sampla om til nøyaktig dei same radiane (15 m ut til 300 m,
  60 m ut til 1 200 m, så dei lange strålane sine eigne ~124 m). Då er
  trianguleringa den same løkka som før, berre med større `nDir`. Ingen
  stitching, ingen hól, ingen skøyt. Prøver ein i staden å sy eit fint
  nærområde saman med eit grovt fjernområde, må ein handtere 3:1-overgangar
  manuelt — mykje meir kode, og ei sprekk ventar i kvar feil.
- **EIN RING MÅ HA ÉI OPPLØYSING, IKKJE TO.** Fyrste utgåva sparte 72
  hentingar ved å la dei lange strålane dekkje «sine eigne» asimutar heilt
  inn. Resultatet var ein tydeleg **sagtann** langs silhuetten med periode
  nøyaktig tre retningar: i bandet 300–1 200 m har ein kort stråle eit
  målepunkt kvar 60. meter, medan ein lang må interpolerast mellom punkt
  ~124 m frå kvarandre — så kvar tredje retning var radielt glatta og
  naboane skarpe. Lærdomen er generell: i eit regulært mesh er det
  UNIFORMITETEN som avgjer korleis flata les, ikkje kor god kvar enkelt
  verdi er. Difor får alle 216 retningane sin eigen korte stråle, også dei
  72 som alt har ein lang.
- **Meshen må ikkje bli finare enn datagrunnlaget.** Etter fortettinga kom
  det ei hakkete okklusjonskant rett ved føtene. Raycasting gjennom nettopp
  dei pikslane viste kva flata var: terreng **3–36 m** unna, med ryggen i
  15 m som skjuler alt ut til 33 m. På den avstanden ligg 216 strålar berre
  0,44 m frå kvarandre, og éin meter terrenghøgd er 3,8° synsvinkel — same
  D/d-forsterking som §7a skildrar for siktlinjer. Meshen teikna der ikkje
  terreng, men modellens eiga uvisse. Ringar der den asimutale
  punktavstanden fell under `naerMinAsimutStegM` (4 m) vert difor glatta
  sirkulært til den oppløysinga. Det gjeld berre 3 ringar (15, 30 og 45 m);
  utanfor ~46 m er glattinga ein nulloperasjon. Dei 72 gamle strålane trefte
  aldri dette — dei låg 4 m frå kvarandre alt på 46 m — så problemet er ein
  FØLGJE av fortettinga og måtte løysast saman med henne.
- **Diagnostiser med raycasting, ikkje med augemål.** Både sagtanna og
  okklusjonskanten vart fyrst tilskrivne feil årsak ut frå skjermbilete.
  Det som avgjorde saka var å skyte strålar frå kameraet gjennom dei
  aktuelle pikslane og lese av treffavstanden, og å rekne silhuetten
  (maks høgdevinkel per asimut) direkte frå dei henta profilane — der viste
  andredifferansen seg jamn over alle tre restklassene (0,147 / 0,162 /
  0,162°), som avkrefta mesh-hypotesen på under eit minutt.

**Målt kostnad** (nettlesar, kald og varm cache):

| | horisont | nærfelt | total opning |
|---|---|---|---|
| kaldt | 43 s | +9–12 s | ~52 s |
| varmt | ~0,1 s | ~0,13 s | ~3,2 s |

Meshen går frå 13 100 til 40 600 hjørne. Varm opning er heilt dominert av
flyfoto-flisane og Three.js-nedlastinga, ikkje av høgdedata.

> **Merk:** tala over er TOTAL tid, og dei er ikkje lenger tida brukaren
> ventar på å sjå noko. Etter §21 opnar scena på fyrste horisont-batch (940 ms
> varmt, 10–12 s kaldt), og nærfeltet vert bytt inn i eit panorama som alt er
> oppe. Fortettinga er difor ikkje lenger på den kritiske stien.

### 19. WPS-en sender `NaN`, og det er ikkje gyldig JSON

Fann under målinga over, og dette var den STØRSTE praktiske gevinsten i heile
runden — den låg berre gøymd bak eit symptom som såg ut som treg nettverk.

Over sjø utan djupnedata svarar `elevationJSON` med det berre symbolet `NaN`
som talverdi:

```
{"distance": 19.6, "elevation": NaN, "lat": 58.6295, "lon": 5.3922,
 "road": "", "terrain": "Havflate"}
```

JSON-grammatikken har ingen `NaN` (heller ikkje `Infinity`), så
`json_decode()` returnerer null for HEILE svaret. **Eitt einaste ukartlagt
sjøpunkt kasta opptil 380 terrengpunkt** — og sidan ingenting vart cacha,
prøvde kvar nye panoramaopning nøyaktig same dødsdømte kallet på nytt.

Symptomet var ikkje ei feilmelding, men at kystpunkt var PERMANENT trege:
Høg-Jæren brukte 31 s på horisonten **sjølv med varm cache**, kvar gong, for
alltid. Med `ElevationService::sanerJson()` (som byter `: NaN` mot `: null`
før dekodinga) tek same punktet **3,2 s**. Verifisert mot primærkjelda: frå
58,63/5,73 gav strålane 250°, 270° og 290° ut i Nordsjøen alle
`json_last_error_msg() = "Syntax error"`, medan 90° og 180° innover land
dekoda reint.

`null` er rett erstatning fordi `NaN` her tyder «her er det hav, og me har
ikkje djupnetal». Havflata er 0 moh., og klassen klemmer allereie negative
djupner til 0 (havbotn er ikkje ei sikthindring), så `null` fell gjennom
`(float) null` og `?? 0` til nøyaktig same verdi som ei kjend djupne på
−223 m alt får.

Mønsteret `/:\s*-?(?:NaN|Infinity)\b/` treffer berre talverdiar, aldri
innhaldet i ein streng — `"road": "NaN"` har hermeteikn framfor og går fri.

### 20. Tre endepunkt delte éin rate-limit-teljar, med kvar sine grenser

`elevation_profile.php` (grense 400), `elevation_point.php` (120) og
`log_error.php` (30) kalla alle `check('ip:' . clientIp(), …)` — altså ÉIN
felles teljar — medan kvart av dei målte han mot si eiga grense. Den
effektive grensa vart dermed grensa til det endepunktet du tilfeldigvis
kalla, brukt på summen av alle tre.

Eit panorama kostar ~50 einingar. Etter to panorama svarte punktoppslaget
429 sjølv om profil-budsjettet var nesten urørt, og klientfeilloggen (grense
30) var daud alt etter det fyrste — altså nøyaktig den loggen §15 vart
innført for å berge. Verifisert i nettlesar: analysen stoppa på
`elevation_point.php → 429` medan `elevation_profile.php` framleis svarte
200.

Identiteten er no prefiksa per endepunkt (`profil:ip:`, `punkt:ip:`,
`logg:ip:`), så grensene betyr det dei seier.

### 21. Panoramaet byggjer seg opp medan brukaren ser på — og fyrste batch opnar scena

Tilbakemeldinga var presis: «når det trykkes på 3d visning så skjer det
ingenting på lenge for så opner verden etter ei stund». Det stemte bokstavleg.
`visPanorama()` venta med `Promise.all` på **alle tre** hentingane før
`opne()` i det heile vart kalla. Målt kva det kosta i skjerm utan innhald:

| | horisont | nærfelt | flyfoto | **tid før noko synest** |
|---|---|---|---|---|
| Storheia, varm cache | 76 ms | 104 ms | 10 586 ms | **11 600 ms** |
| Høg-Jæren, kald cache | 60 879 ms | 10 500 ms | 9 010 ms | **71 400 ms** |

Legg merke til den varme rada: alle høgdedata låg klare etter 0,2 sekund, og
brukaren venta likevel elleve sekund — på ein TEKSTUR til ein mesh som alt
kunne vore teikna.

Etter omlegginga, same to punkt (og eit kaldt punkt ved Roan):

| | før | etter | |
|---|---|---|---|
| Storheia, varm | 11 600 ms | **940 ms** | 12× |
| kaldt punkt | 71 400 ms | **10–12 s** | 6–7× |

**Rekkjefølgja er styrt av kva kvar kjelde er verdt, ikkje av kva som er
enklast å vente på:**

1. `resultat` og `punkt` er alt klare frå analysen. Turbinar, hinderlys og
   klippeplan treng ingenting meir — dei står der frå fyrste frame.
2. **Fyrste horisont-batch** opnar scena.
3. Resten av retningane, nærfeltet og flisringane vert bytte inn etterpå, i
   eit panorama brukaren alt kan snu seg rundt i.

Ingen av stega legg til ei modellføresetnad: nærfeltet er berre finare
geometri (§18), flyfotoet berre ein tekstur (§17), og **kva som er synleg er
avgjort av analysen, ikkje av panoramahorisonten** — turbinane vert klipte mot
`r.synlegheit.horisontMoh` frå `ImpactCalculator` (§16), som ligg ferdig før
panoramaet i det heile opnar. Eit grovare terreng kan difor aldri få panelet og
biletet ut av takt.

Sju ting som måtte lærast, dei fleste av dei ved måling:

- **Flaskehalsen var ikkje talet HTTP-kall, og det var ikkje mogleg å
  optimalisere seg ut av det.** Målt direkte på kjeda `php -S` →
  `ElevationService` → Kartverket WPS: eitt kall med 6 målpunkt tek 11,1 s,
  **tre samtidige tek 32,2 s til saman** (11 / 22 / 32 — reint sekvensielt).
  Oppstraums gir ikkje meir gjennomstrøyming før det ligg nok kall inne; seks
  samtidige gjorde derimot dobbelt så mykje arbeid på same tid. Ventetida måtte
  altså **omgåast**, ikkje kortast ned. Det er heile grunngjevinga for §21.
- **Batch-storleiken vert no vald etter tid til FYRSTE bilete.** Med
  progressiv teikning er det ikkje lenger totaltida brukaren opplever. Målt
  kaldt, tre lanes: batch 18 → fyrste bilete 27,6 s / ferdig 55,0 s; batch 6 →
  **11,4 s / 44,7 s**; batch 3 → 7,3 s / 54,4 s. `batchStorleik` er sett til
  **6** og `samtidigeKall` heva frå 3 til **6** (snitt over tre kalde punkt:
  fyrste bilete 13,2 → 11,6 s, ferdig 48,0 → 37,1 s). Batch 3 halverer
  fyrstebiletet ein gong til, men legg ~20 % på totalen og gir eit fyrstebilete
  av tre strålar — 120° mellom kvar, altså ein trekant, ikkje ein horisont.
- **BATCHANE MÅ FLETTAST RUNDT KOMPASSET.** `mal.slice(i, i + batch)` gav
  batch nr. 0 = retning 0–5, altså ein 30° brei kile. Teikna med det same ville
  det vore eitt skarpt utsnitt og 330° utsmurt terreng — eit bilete som ser
  ØYDELAGT ut, ikkje grovt. Med steglengd `talBatchar` inneheld fyrste batch
  retningane 0, 12, 24, 36 … — seks strålar 60° frå kvarandre, altså ein
  komplett grov 360°-form. Same tal kall, same tal punkt, berre ei anna
  gruppering; og det kostar ingenting mot WPS-en, som er ein batch-oppslags-
  teneste for vilkårlege punkt (§1), ikkje ein linjeteneste.
- **Eit delresultat må ha profil i ALLE retningar, ikkje berre dei henta.**
  `_byggTerreng()` filtrerer bort retningar utan `profil` og triangulerer dei
  som står att som naboar. Med 6 av 72 inne ville nabo nr. 0 og nr. 12 vorte
  kopla med ein 60° brei vegg av flatt terreng. `fyllProfilhol()` gir difor
  uferdige retningar ein profil blanda frå næraste ferdige nabo på kvar side —
  same operasjon rasteriseraren alt gjer mellom to strålar, berre eksplisitt.
  **Berre på delresultat:** det ferdige svaret er bit for bit uendra, og
  testsuiten §13 sjekkar at det ikkje inneheld eit einaste syntetisk punkt.
- **Lat/lon i eit syntetisk punkt må reknast for SI EIGA retning.** Å kopiere
  naboen sitt koordinat ville drege flyfoto-UV-ane sidelengs gjennom heile den
  syntetiske sektoren. `destinasjon(punkt, azimut, d)` kostar ingenting her.
- **Three.js-nedlastinga var den nest største flaskehalsen, og synte seg
  først etter at den fyrste var borte.** `import()` låg inne i `opne()`, altså
  ETTER horisonten. På eit kaldt punkt drukna dei 166 KB i seksti sekund
  terrengdata; på eit varmt punkt var dei plutseleg **heile ventetida** (2,8 s
  mot 0,1 s for horisonten). Importen startar no parallelt med hentinga, og i
  tillegg på `pointerover` over sjølve knappen. Prinsippet frå §16 står: den
  som berre ser på kartet lastar framleis ikkje ned eit byte av Three.js.
  Promiset — ikkje berre resultatet — er memoisert, elles ville to samtidige
  kallarar fyrt feilhandsaminga to gonger for éin nettverksfeil.
- **Ombygginga skjer i `requestAnimationFrame`, og utan cross-fade.** JS er
  eintråds, så eit bytte frå ein `.then()` kan ikkje treffe midt i
  `renderer.render()`. rAF-en er der for å **slå saman**: tre flisringar og eit
  nærfelt kan lande tett, og fire fulle ombyggingar på rad er fire hakk i
  animasjonen. Cross-fade vart prøvd tenkt og forkasta: to meshar med same
  geometri i same høgd z-fightar gjennom heile overgangen, og eit
  gjennomsiktig terreng viser himmelen gjennom bakken. Det rå byttet er
  usynleg i praksis — verifisert med skjermbilete rett før og rett etter, der
  silhuetten står stille og berre detaljnivået endrar seg — fordi heile
  riv-og-bygg-sekvensen ligg inne i éi og same oppgåve i hendingsløkka.

**Ein feil som er lett å gjere om att:** fyrste utgåva brukte eit boolsk
«opning er starta»-flagg for å hindre to `opne()`-kall. Men `opne()` ventar på
Three.js, og på eit varmt punkt rakk HEILE horisonten å bli ferdig i
mellomtida. Det siste kallet såg at ei opning var i gang, returnerte, og `okt`
var framleis `undefined` når `visPanorama()` skulle gå vidare — så funksjonen
gav opp før nærfeltet i det heile vart henta. Symptomet var forvirrande: scena
stod der og flisane kom inn (dei hadde sin eigen referanse til `okt`), men
terrenget vart aldri fortetta og sluttlogga kom aldri. Flagget er difor
erstatta med sjølve **promiset**, som dei andre ventar på.

**Økt-id, ikkje AbortController.** Kvar opning aukar ein teljar, og alle
etterslepande oppdateringar må oppgi han. Hentingane vert med vilje IKKJE
avbrotne når brukaren lukkar panoramaet — dei fyller klientcachen, så neste
opning er gratis. Det er BRUKEN av dei som må vaktast. Vakta er dobbel: eit
delresultat kan aldri erstatte det ferdige settet, og eit delresultat med
færre ekte retningar kan aldri erstatte eit med fleire (rekkjefølgja er ikkje
garantert når fleire batchar slepp laus i same augeblink).

**Atterhaldet i HUD-en endrar seg tre gonger** under ei kald opning, fordi det
skal skildre det brukaren faktisk ser: «terrenget er framleis under henting …
18 av 72 retningar» → «bar bakke, skog og bygningar manglar» → «ekte flyfoto,
skog og bygningar SYNEST men skjermar ingenting». Talet retningar er det EKTE
talet undervegs, ikkje måltalet 72 — å skrive 72 over eit bilete bygd av 18
ville vore ei påstand appen ikkje kan stå for enno.

**Statuslinja ligg i panoramaet, ikkje i ein toast.** Ein toast ligg bak
overlegget når scena fyrst er oppe, og er uansett feil kanal for noko som
skjer inne i visinga brukaren no ser på. Toasten lever difor berre fram til
scena opnar; deretter tek `#panorama-status` over («Skjerpar terrenget …
42/72 retningar», «Fortettar nærterreng …», «Legg på flyfoto … 140/246
flisar»). Skrivinga er strupa til 400 ms, men ei TOM melding går alltid
gjennom, slik at linja garantert forsvinn til slutt.

### 22. Skog og bygningar: DOM i ÉITT punkt slår den mest siterte avgrensinga

Heile siktlinjemodellen har kvilt på `dtm1` — Kartverkets terrengmodell, altså
**bar bakke**. Det står som atterhald i PLAN.md §7, i detaljvisinga, i
panoramaets HUD og i toppbanneret: appen melder «synleg» for turbinar som i
praksis står bak ein granskog. Det er den avgrensinga prosjektet har nemnt
flest gonger, og til no den einaste det ikkje fanst eit tal for.

Kartverket har òg **`dom1`**, ein digital OVERFLATEmodell frå same
laserskanning, der høgda er det laseren traff **først** — trekruner, hustak,
master. Skilnaden mellom dei to er, i praksis, høgda på det som står på bakken:

| punkt | DTM | DOM | skilnad |
|---|---|---|---|
| Oslo (10,75 / 59,91) | 2,74 m | 9,63 m | **6,89 m** (eit hus eller eit tre) |
| Storheia (10,14 / 63,84) | 365,33 m | 365,35 m | **0,02 m** (snaufjell) |

**WPS-en kan ikkje gi DOM.** Batch-tenesta heile profilhentinga kviler på
(§1) tek berre `gpx`, `points` og `places` — verifisert mot `DescribeProcess`;
det finst ikkje noko `datakilde`-inngang i det heile. DOM finst berre gjennom
REST-punkttenesta.

#### Det avgjerande: me treng berre eitt punkt per turbin

> **Rettelse frå §23:** dette resonnementet er rett så langt det går, men det
> går kortare enn det ser ut til — sjå §23. Det kritiske punktet er rett når
> TERRENGET avgjer; det er ikkje der eit HINDER ville bety mest. Sjekken slår
> no opp fleire punkt per turbin, og på Odal går talet skjulte frå 3 til 5 av
> det. Resten av §22 står som han er.

`skannHorisont()` peikar allereie ut nøyaktig **eitt** terrengpunkt per
turbin — `synlegheit.kritiskPunkt`, det som gir den høgaste skrapelinja. Alt
anna langs profilen ligg per definisjon under den strålen. Å heve nettopp det
punktet til DOM-høgd og rekne horisonten om att er difor det mest treffsikre
eine oppslaget som finst.

Og substitusjonen er **eksakt**, ikkje ei tilnærming. Sidan det kritiske
punktet alt var argmax med DTM-høgda si, og DOM ≥ DTM, er den nye maksimum-
helninga berre `terrengHelning(d_kritisk, z_dom, augeMoh)` — ingen ny skanning
av profilen. `Math.max` mot den gamle helninga står der likevel, fordi dei to
modellane er interpolerte kvar for seg og eit avvik andre vegen på nokre
centimeter elles ville kunna gjort ein turbin MEIR synleg av å ta med skogen.

#### Punkttenesta tek 50 punkt i eitt kall

Det var det som gjorde funksjonen praktisk i det heile. `punkter=[[ost,nord],…]`
er dokumentert med «maksimum 50 koordinater» og verifisert til å halde
rekkjefølgja og ekke koordinatane tilbake. 150 turbinar vert dermed **3 kall**,
ikkje 150. Målt på Odal med varm profilcache: **1 kall, ~500 ms kaldt / ~5 ms
varmt** for ni turbinar.

Ekkoet vert kontrollert mot det me sende (toleranse 1e-4°). Med 50 punkt i
same kall er ei stille ombytting av rekkjefølgja den einaste feilen som ville
gitt eit *plausibelt* men feil svar — ein DOM-verdi frå ein heilt annan stad,
lesen som skog her.

#### Svaret er EINSIDIG påliteleg, og det må UI-et seie

DOM ≥ DTM overalt, så substitusjonen kan berre **heve** horisonten. Det gir ein
presis, asymmetrisk garanti:

- Seier kryssjekken **«skjult», er turbinen skjult** (gitt laserdataen) — me
  har funne eit konkret hinder som er høgt nok.
- Seier han **«framleis synleg», er det ikkje eit bevis.** Skogen kan stå i eit
  anna punkt langs profilen — eit punkt som med bar bakke låg godt under
  skrapelinja, men som med 25 m gran stikk over henne.

Resultatet er altså ei **nedre grense** for kor mykje vegetasjonen skjermar.
Det er formulert slik i både samandraget og detaljvisinga, aldri som «då er du
fri». Same asymmetri gjer at ein turbin som alt er **skjult av bar bakke aldri
vert slått opp**: DOM kan ikkje gjere han synleg, så svaret er kjent på
førehand. På Odal-punktet sparte det 15 av 24 oppslag.

#### Fire val som er lette å gjere feil

- **Terskelen på 2 m er reell, ikkje pynt.** Laserdata har støy og dei to
  modellane er interpolerte kvar for seg; ope fjell gir 0,0–0,1 m og Storheia
  målte 0,02 m. Under 2 m er det rekneverk, ikkje skog.
- **`null` frå tenesta MÅ ut som `null`, aldri 0.** Utanfor laserdekninga
  svarar ho `{"x":3.5,"y":58.0,"z":null}`. Resten av `ElevationService`
  klemmer negative høgder til 0 (havbotn er ikkje ei sikthindring), men her
  ville 0 sagt at overflata ligg LÅGARE enn bakken — altså «her er det hogd»,
  ein påstand me ikkje har dekning for. Eit feila kall vert heller ikkje cacha,
  så eit forbigåande nettverksbrot ikkje blir til ein permanent «ikkje målt».
- **Cache-nøkkelen fekk kjelda lagt til BETINGA.** Ein ubetinga sjette del i
  `cacheKey()` ville endra kvar einaste eksisterande nøkkel og gjort heile den
  permanente cachen — titusenvis av terrengpunkt og profilar — kald på ein
  deploy, for ei endring som berre legg til ei ny kjelde ved sida av.
  DTM-nøklane er difor bokstavleg uendra, og `dom1` har sitt eige nøkkelrom.
- **Etiketten «Skjult av terreng» måtte byttast i DOM-boksen.** Teksten kjem
  frå den felles fire-delte skalaen, som er skriven for bar bakke. Her er det
  nettopp ikkje terrenget som er årsaka, men det som står oppå det. Same tal,
  anna årsak.

#### Kryssjekk, ikkje erstatning

Hovudtalet er framleis bar bakke, overalt. Grunnen er ikkje forsiktigheit:

1. Alt anna i appen — støy, hinderlys, skyggekast, panoramaets klippeplan —
   reknar på DTM-horisonten. Eit einsleg korrigert synlegheitstal ville ikkje
   lenger stemme med resten.
2. Dei to tala svarer på ulike spørsmål. «Bar bakke» er kva landskapet sjølv
   gjer, og det endrar seg aldri. «Med skog» er kva som står der no — og skog
   vert hoggen. **Laserdataen kan vere fleire år gammal**, så modellen kan vise
   ein skog som er borte, eller mangle ein som har vakse. Det atterhaldet står
   både i samandraget og i detaljvisinga.

Steget køyrer difor **aldri automatisk for heile settet** — det er ein knapp
(«Sjekk skog og bygningar», med tal på kor mange turbinar det gjeld). Unntaket
er detaljvisinga: opnar du éin turbin, har du peika på nettopp han, og eitt
punktoppslag er det billegaste kallet appen har. Verifisert i nettlesar: ei
full analyse gir **null** kall mot `surface_points.php` før knappen, og
nøyaktig **eitt** etter.

#### Målt på ekte data

Odal vindkraftverk (Nord-Odal, 34 turbinar i tett granskog) frå eit punkt i
skogen 478 moh. (60,4144 / 11,3735), 21 turbinar innanfor 10 km:

| | bar bakke | med skog/bygningar |
|---|---|---|
| synlege turbinar | 9 av 21 | 6 av 21 |
| med rotor i fri sikt | 6 | 2 |

Ein turbin 1,34 km unna gjekk frå **82 % synleg med rotoren fritt** til **heilt
skjult**, av 18,2 m skog i eit punkt **90 m** frå observatøren. Ein rundgang på
24 kandidatpunkt rundt anlegget (3/5/7 km, åtte kompassretningar) gav utslag på
**23 av 24**, med 8–18 m målt vegetasjonshøgd. Storheia frå snaufjell er
kontrollen: 10 kandidatar, **null** over terskelen, høgaste avvik 1,39 m.

Grafen i detaljvisinga teiknar begge: ei loddrett mørkegrøn søyle i det
kritiske punktet (skogen, i målestokk) og den alternative skrapelinja ut frå
toppen av henne. At den lina er brattare enn den oransje er heile poenget.
Ho får med vilje **ikkje** utvide y-aksen — i nærfeltet kan ho liggje
hundrevis av meter over vengetuppen (faktor D/d = 15 på 90 m), og lét ein
henne presse aksen, vert terrengprofilen klemt ned i ei stripe. Chart.js
klipper henne mot ramma i staden, og at ho går ut av biletet over vengetuppen
er nettopp den avlesinga som skal gjerast.

### 23. Topp-K: det kritiske punktet er ikkje der eit HINDER betyr mest

§22 slo opp **eitt** punkt per turbin — `synlegheit.kritiskPunkt`, det bare
terrenget skrapar høgast i. Resonnementet var at alt anna langs profilen per
definisjon ligg under den strålen. Det er sant, og likevel feil premiss for
spørsmålet: DOM-sjekken spør ikkje kvar terrenget skrapar, men **kvar noko som
ikkje står i terrengmodellen ville heve horisonten mest**.

Legg eit tenkt hinder på `H` meter på kvart profilpunkt, så vert helninga

```
helning_H(d) = terrengHelning(d, z, auge) + H/d
```

Tillegget `H/d` er **0,67 for eit punkt 30 m unna og 0,004 for eitt 5 km
unna** — ein faktor 170. Eit terrengpunkt som ligg langt under den bare
skrapelinja kan difor avgjere heile saka, berre det står nær nok. Det er
nøyaktig same D/d-forsterking som §7a handlar om, snudd andre vegen.

`skannHorisontTopK()` i geo.js rangerer difor heile profilen etter
`helning_H` og returnerer dei K høgaste. `skannHorisont()` er **urørt** —
hinderlysa, panoramahorisonten og hovudanalysen er alle avhengige av at han
returnerer éin kritisk verdi, og testsuiten §15b låser det.

#### Målt: kva topp-K faktisk fangar

Odal vindkraftverk, same punkt som §22 er dokumentert på (60,4144 / 11,3735),
9 kandidatturbinar:

| | K = 1 | K = 4 |
|---|---|---|
| heilt skjulte | 3 | **5** |
| avgjord av eit anna punkt enn bar bakke peikar ut | 0 | 5 |
| unike DOM-punkt henta | 9 | 36 |
| HTTP-kall | 1 | 1 |

Dei to som kom til er konkrete: **T1323** (1,47 km, 34 % synleg på bar bakke)
og **T1330** (8,9 km, 75 %), begge felte av eit punkt **30 m** frå
observatøren med 10,4 og 8,9 m vegetasjon — eit punkt topp-1 aldri såg på.

Frå eit anna Odal-punkt (60,4211 / 11,3902) er utslaget større: 10 av 17
turbinar endrar kategori, og **T1310 går frå 99 % synleg til heilt skjult** av
6,5 m vegetasjon 30 m unna.

Kontrollen står: Storheia frå snaufjell gir **null** utslag ved K = 4, med
høgaste avvik 1,39 m over 40 punkt. Ved K = 8 begynner han å plukke opp skog i
lågare terreng 285–1 300 m unna — eit av fleire argument for at K ikkje skal
vere stort.

#### Kostnaden, målt kaldt

Same punkt, ingen cache nokon stad:

| | kall | unike punkt | tid |
|---|---|---|---|
| K = 1 | 1 | 17 | 721 ms |
| K = 4 | **2** | 67 | **1 046 ms** |

Altså **+1 kall og +325 ms** for fire gonger så mange punkt. Grunnen er at
punkt-tenesta tek 50 koordinatar per kall (§22) og at nærfeltspunkta i stor
grad er **felles** for turbinar i same retning, så dedupen tek dei. På 25
turbinar er talet 2–3 kall mot 1.

#### Fire val som er lette å gjere feil

- **K tel det kritiske punktet MED, ikkje i tillegg.** `CONFIG.overflate.toppK
  = 4` er taket på oppslag per turbin, ikkje «4 pluss eitt». Elles er kostnaden
  ikkje lesbar av konstanten.
- **Kandidatane må stå frå kvarandre.** Profilen er sampla kvar 15. m dei
  fyrste 300 m (§7a). Utan `minKandidatavstandM` (120 m) ville dei fire høgaste
  vore fire nabopunkt på same knaus — fire oppslag i praktisk talt same tre.
- **Substitusjonen er framleis EKSAKT.** Den nye horisonten er maksimum over
  heile profilen; punkta me ikkje slo opp bidreg med DTM-høgda si, altså med
  den gamle helninga. `Math.max(gamal.horisontHelning, beste.helning)` er difor
  ikkje ei tilnærming, uansett K.
- **K = 5 og oppover kostar meir enn det gir.** K = 3 tek mesteparten, K = 4
  eit lite hakk til, K = 5 tippar mange sett over i eit tredje kall. Over det
  flatar det ut og kontrollen på Storheia begynner å svikte.

#### Det ubehagelege som følgjer: nærfeltet vinn nesten alltid

Rangeringa etter `H/d` betyr at det avgjerande punktet oftast ligg **30–300 m
frå observatøren**. Det er fysisk korrekt — eit tre 30 m unna dekkjer alt bak
seg, uansett om turbinen står 1 eller 9 km ute — men det gjer svaret **ekstremt
følsamt for kvar brukaren klikka**, akkurat som §7b åtvarar om for bar bakke.

Det er difor `overflateSamandrag()` no tel `naerskjerma`, og både samandraget,
detaljvisinga og panoramaets HUD ber brukaren flytte punktet nokre titals meter
for å teste kor følsamt resultatet er. Talet er ikkje pynt: på Odal er det 5 av
9. Utan det ville topp-K gjort appen meir presis og samtidig meir
sjølvsikker enn dataa held til.

#### `restHelning` — det som står att, som eit tal

`skannHorisontTopK()` returnerer òg den høgaste `helning_H` blant punkta som
**ikkje** vart valde, og ho vert med ut som `overflate.restHorisontMoh`: kor
høgt eit 20 m hinder i eit usjekka punkt kunne løfte horisonten ved turbinen.

Det er ei **streng, men ikkje stram** øvre grense: han er nesten alltid
dominert av eit nabopunkt til ein kandidat me faktisk målte — altså same
knaus. Difor står han i dataa og i testsuiten, men **ikkje i UI**: eit tal som
seier «horisonten kunne teoretisk vore 1 957 moh.» ville vore sant og
verdilaust. Svaret er framleis ei **nedre grense**, og alle atterhalda frå §22
står uendra.

### 24. Panoramaets skogbrytar: eit bytte brukaren gjer, ikkje ei stille endring

Panoramaet klipte kvar turbin mot DTM-horisonten (§16) og nemnde berre i
HUD-teksten at sidepanelet hadde funne nokre av dei skjulte. Brukaren kunne
ikkje **sjå** skogen som skjermar.

Å berre byte klippeplanet til DOM-horisonten var aldri eit alternativ: då ville
3D-biletet og sidepanelet vist ulikt tal utan at noko forklarte kvifor, og det
les som ein feil, ikkje som ei ekstra opplysning. Løysinga er ein **eksplisitt
brytar** («Skog») ved sida av No/Natt/Rotor/Sentrer, **av som standard**.

Fire ting som ber heile funksjonen:

- **Klippeplanet må flyttast, ikkje berre pyntast.** `_synlegheitFor(r)` er
  den einaste staden som svarer på «kva synlegheit gjeld no», og han vert spurd
  av klippeplanet, av utveljinga i `_byggTurbinar()` og av hinderlysa. At dei
  tre spør same stad er det som gjer at biletet ikkje kan kome i utakt med seg
  sjølv: ein turbin som er klipt bort skal heller ikkje telje i «N av M».
- **Hinderlysa må testast om att.** `l.synleg` er svaret for bar bakke. Med
  brytaren på gjeld same test som § 16 i forskrifta, berre mot den heva
  horisonten (`bakkeVedTurbin + høgdeOverBakke > horisontMoh`) — elles ville
  navlyset på ein bortklipt turbin hengt att i lufta.
- **Klumpane må byggjast i ein EIGEN runde over heile lista.** `_byggTurbin()`
  køyrer berre for turbinar som framleis har noko å teikne, og det er nettopp
  dei som forsvann heilt hinderet skal forklare. Ein grøn klump utan turbin bak
  seg er det mest talande biletet brytaren kan gi.
- **`depthWrite: true` sjølv om materialet er transparent.** Standardrådet er
  det motsette, men her er sorteringsfeilen mellom to klumpar den minste: utan
  djupneskriving vert dei teikna oppå terrenget dei står bak, og ein klump 3 km
  ute svevar framfor åsen som skjuler han. Verifisert i nettlesar — det såg
  ikkje ut som eit unøyaktig bilete, det såg ut som ein bug.

**Klumpane er markørar, ikkje skog.** Flat farge, synlege kantar, halv
gjennomsikt — ingen forsøk på fotorealisme. Grunnen er ikkje smak: me veit
HØGDA i eit punkt, ikkje kvar det står tre. Storleiken deira er difor med vilje
ikkje ei måling, og HUD-en seier det. Dekkevna følgjer avstanden
(`0,55 · clamp(d/300; 0,42; 1)`) fordi nærfeltet er der kandidatane hopar seg
opp: på Odal ni klumpar 30 m unna, kvar ~15° brei, som med full dekkevne vart
ein vegg som skjulte nettopp det biletet skulle forklare.

**Brytaren startar sjekken sjølv om han ikkje er køyrd.** Sidepanelet ligg bak
overlegget, så ein grå knapp ville vore ein blindveg — brukaren måtte lukka
panoramaet, trykt i panelet og opna på nytt. `paaSjekkOverflate` går til same
`kjoerOverflatesjekk()` som knappen i panelet, mot same tilstand.

**Atterhaldet snur når brytaren står på.** Med brytaren av er poenget at
vegetasjonen i flyfotoet ligg flatt og skjermar ingenting. Med brytaren på
ville den setninga motsagt seg sjølv, så skiljet vert eit anna: mellom skogen
ein SER i fotoet (kulisse) og dei grøne klumpane (måling). Og teksten seier kor
mange turbinar som fell bort, at det er ei nedre grense, at laserdataen kan
vere gammal, og kor mange av klumpane som står under 300 m unna.

Verifisert i nettlesar på Odal: **9 av 21 synlege med brytaren av, 4 av 21 med
han på** — fem turbinar forsvinn, og dei grøne klumpane står att der dei stod.

## Køyre lokalt

```bash
# 1. Bygg turbin-cachen (~7 s, hentar 11 ArcGIS-lag)
php cron/fetch_turbines.php

# 2. Start server. PHP_CLI_SERVER_WORKERS er NAUDSYNT — appen sender fleire
#    samtidige analysekall, og php -S er einstråds som standard (deadlock).
PHP_CLI_SERVER_WORKERS=6 php -S localhost:8011 -t .

# 3. Køyr testsuiten (krev at serveren over er oppe)
node tools/verify_model.mjs

# ...eller mot ein annan port om 8011 er oppteken:
VIND_API=http://localhost:8012 node tools/verify_model.mjs
```

`tools/verify_model.mjs` importerer dei **ekte** frontend-modulane og køyrer dei mot
ekte cacha data + live Kartverket-kall — den testar det som faktisk vert sendt til
nettlesaren, ikkje ein kopi. Node er berre eit dev-verktøy her.

## Fallgruver

- **`?>` inne i ein `//`-kommentar avsluttar PHP-modus.** Kosta ein feilsøkingsrunde
  i `ElevationService.php` (kommentaren nemnde XML-deklarasjonen).
- **Backtick inne i ein `<!-- -->`-kommentar i eit template literal avsluttar
  strengen.** Same felle, andre språk. Ein HTML-kommentar inne i eit
  template literal er berre tekst for JS — så ein «\`.tomtilstand-hint\`» i
  kommentaren lukka strengen, og resten vart tolka som kode
  (`ReferenceError: hint is not defined`).
  **`node --check` fangar det IKKJE** — fila er framleis gyldig JavaScript.
  Berre nettlesar-smoketesten fann han. Skriv klassenamn i slike kommentarar
  utan backtick.
- **PHP-CLI-en lokalt er bygd utan ext-curl.** `Http.php` har difor ein
  stream-fallback; utan han kan ingen endepunkt smoke-testast lokalt.
- **PHP-CLI-en lokalt manglar òg `ext-mbstring`** — `function_exists('mb_substr')`
  er `false`. `mb_*`-funksjonar kastar då ein `Error` (ein `Throwable`), som i
  `Logger::write()` vart svelgd stille av klassen sitt eige
  `catch (Throwable)` — loggfunksjonen "verka" (ingen feilmelding, ingen
  krasj), men skreiv aldri ei linje. Fann det berre ved å faktisk lese
  `logs/error.log` etter eit testkall, ikkje ved å stole på fråveret av ein
  feil. Bruk vanleg `substr()` (med `JSON_INVALID_UTF8_SUBSTITUTE` på
  `json_encode` for å tole ei avkutting midt i eit multi-byte-teikn) i staden
  for `mb_substr()` alle stader i dette prosjektet — same avgrensing som alt
  gjaldt `KnownSpecRegistry.php` sin namne-normalisering.
- **`php -S` utan `PHP_CLI_SERVER_WORKERS` heng** når appen sender parallelle kall.
- Elevation-cachen er nøkla på **origo runda til 4 desimalar** (~11 m). Endrar du
  samplinga i `ElevationService`, endrar nøkkelen seg og heile cachen vert kald.
- Turbin-cachen skrivast **atomisk** (tmp + rename). Feilar hentinga, vert den
  gamle cachen ståande urørt — appen skal aldri stå med halve data.
- **Kartverket sin WPS sender `NaN` som talverdi over sjø**, og det er ikkje
  gyldig JSON. `ElevationService::sanerJson()` må køyre FØR `json_decode()`.
  Sjå §19 — symptomet er ikkje ein feil, men eit kystpunkt som er permanent
  tregt fordi ingenting vert cacha.
- **Ein feil som berre SYNEST kan ikkje diagnostiserast med augemål.** Bruk
  `THREE.Raycaster` frå kameraet gjennom dei aktuelle pikslane og les av
  treffavstanden, eller rekn storleiken direkte frå rådata. Sjå §18: to
  gonger på rad peika det opplagte svaret feil veg, og begge vart avgjorde
  på minutt med ei måling.
- **Pass på `sed` mot `js/config.js`.** Både `analyse` og `panorama` har ein
  nøkkel som heiter `samtidigeKall` med same innrykk, så eit mønster som
  `^        samtidigeKall:` treffer BEGGE. Rediger dei kvar for seg.
  (`analyse.samtidigeKall` er 3, `panorama.samtidigeKall` er 6 — dei ER ulike,
  så eit uhell her endrar stille noko heilt anna enn du trur.)
- **Rate-limitaren stengjer deg ute under benchmarking.** Ei kald
  horisonthenting kostar 72 einingar av dei 400 `elevation_profile.php` gir per
  10-minuttsvindauge, så fem–seks målingar på rad gir 429 — og symptomet er
  ikkje ei feilmelding, men at alle 72 retningane kjem tilbake som
  `interpolert: true` på 20 millisekund. Slett `cache/ratelimit/*.json` mellom
  målingane, og sjekk `interpolerte retningar: 0` før du trur på eit tal.
- **Skjermbilete av ei WebGL-side under swiftshader tek 1–2 sekund**, og
  blokkerer polleløkka i Playwright. Ei «tid til fyrste bilete» målt frå Node
  seier då meir om skjermbileteutstyret enn om appen — 2 203 ms målt utanfrå
  mot 936 ms målt i sida. Legg ein `requestAnimationFrame`-løkke i sjølve sida
  og les av `performance.now()` der.
- **Profilar frå WPS-en har IKKJE identiske radiar på tvers av retningar.**
  Kvar stråle får sine eigne avstandar, og dei sprikjer opp mot 12 m (ein
  tiendedels steg) alt i eit ferdig horisontsvar. Grovmeshen har alltid
  tolt det; det er berre det resampla nærfeltet (§18) som krev eksakt like
  radiar. Ein test som krev `p.d === radier[j]` på rå horisontdata feilar med
  rette.

## TODO / neste fasar

- **Fase 4 (resten):** adressesøk (Kartverket adresse-API), PWA/offline for
  turbinlaget, skjermbilete-eksport. Delbar lenke er alt på plass (`?lat=&lon=&r=`).
- Skyggekast: vurder eit *faktisk*-estimat med skydekkestatistikk (met.no
  frost-API har soltimar per stasjon) og vindrose. Modellen reknar berre det
  teoretiske i dag, og NVE si 8-timarsgrense kan difor ikkje målast mot.
- Hinderlys: om Luftfartstilsynet nokon gong publiserer kva anlegg som har fått
  ADLS eller perimetermerking godkjent, kan §10 sitt maksimumsatterhald byttast
  med faktiske data. Per i dag finst ingen slik kjelde.
- **DOM-sjekken (§22) ser eitt punkt per turbin, og det er ei nedre grense.**
  Den billegaste utvidinga er **topp-K i staden for topp-1**: rekn
  `terrengHelning(d, z + 20, augeMoh)` for kvart profilpunkt (altså «kva ville
  vore kritisk om det stod 20 m skog her») og slå opp dei 3–5 høgaste. Med 50
  punkt per kall kostar K = 3 for 40 turbinar framleis berre 3 kall.
  Substitusjonen er like eksakt: den nye helninga er maks over dei punkta som
  faktisk vart heva, og resten ligg framleis under. Det ville flytta svaret frå
  «me fann eit hinder» mot «me leitte der hinder kunne stå».
- DOM-sjekken har ingen aldersinformasjon om laserdataen. `hoydedata/v1` har eit
  `/datakilder/{kilde}`-endepunkt med metadata; finst det skanningsår per
  område der, kan atterhaldet «kan vere fleire år gammal» byttast med ei årstal.
- Panoramaet klipper framleis på DTM-horisonten (§16), og seier berre i HUD-en
  kor mange turbinar DOM-sjekken har funne skjulte. Ei DOM-klipping ville
  trenge ein synleg av/på-brytar — elles ville brukaren ikkje forstå kvifor 3D
  og sidepanel viser ulikt.
- Utplassering: heuristikken har ingen vinddata. Ei vindrose (NVE sitt
  vindressurskart) ville late oss bruke ulik avstand på langs og på tvers av
  hovudvindretninga, slik verkelege parkar gjer.
- **Fase 5:** nærare ISO 9613-2, per-turbinmodell lydeffektdata, «kva om»-scenario
  for turbinstorleik på planlagde anlegg.
- Vurder å kvalitetssikre dominansterskelane (§4.2) mot ein konkret norsk
  NVE-rettleiar før dei presenterast som meir enn ein heuristikk.
- Flyfoto (§17): Esri sitt `World_Imagery` har varierande alder og oppløysing i
  norsk utmark, og gamle flisar kan vise eit anlegg som ALT er bygd — eller
  mangle eit. Får appen nokon gong tilgang til Kartverket sitt eige ortofoto
  (token), er `SatelliteTexture.js` bygd slik at berre `urlMal` og
  `attribusjon` må byttast; ringlogikken og UV-matten er projeksjonen sin, ikkje
  leverandøren sin.
- Horisonten sin kalde kostnad er framleis 30–55 s i TOTAL tid, men han er
  ikkje lenger ventetid brukaren ser (§21 opnar scena på fyrste batch, etter
  10–12 s). Å korte ned totalen krev noko oppstraums — målinga i §21 viser at
  kjeda serialiserer, så fleire eller mindre kall gir ikkje meir. Eit reelt
  steg vidare ville vore å hente dei fyrste kilometrane i høgare radiell
  oppløysing og resten grovare, altså færre punkt per stråle.
- **Progressiv nærfelt-fortetting.** Nærfeltet (216 strålar, 22 kall) kjem
  framleis som éin blokk etter at heile horisonten er ferdig, fordi han treng
  det ferdige radiusrutenettet frå dei lange strålane (§18). Å levere han i
  delar — t.d. kvar tredje retning fyrst — ville krevd at rutenettet vart
  fastsett av fyrste horisont-batch i staden. Gevinsten er dei 8–13 sekunda
  mellom «horisont ferdig» og «nærfelt inne», i eit panorama som alt er oppe.
- **Skarpare fyrstebilete utan å vente lenger.** Fyrste batch gir 6 strålar,
  60° frå kvarandre. Ein kunne hente dei 6 fyrste med kortare rekkjevidd
  (t.d. 5 km i staden for 20 km) og dermed færre punkt per stråle, og så
  forlenge dei seinare — då ville fyrstebiletet kome på under fem sekund. Det
  krev at profilar med ulik lengd kan blandast i same mesh, som `nRad =
  Math.min(...)` i dag gjer ved å klippe alle til den kortaste.
- Ingen opprydding av `cache/elevation/` er implementert. Terreng endrar seg aldri,
  så cachen er permanent med vilje — men han veks. Legg til LRU-sletting om
  diskbruk vert eit problem.
