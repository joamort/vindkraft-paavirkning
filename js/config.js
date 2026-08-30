/**
 * js/config.js
 *
 * Alle justerbare konstantar for appen på éin stad, slik at modellval og
 * tersklar er lette å finne, kvalitetssikre og endre — i staden for å ligge
 * spreidd som magiske tal rundt om i koden.
 *
 * Kvar verdi som er ei FAGLEG avgjerd (og ikkje berre eit UI-val) har ei
 * kjelde eller ei grunngjeving i kommentaren.
 */

export const CONFIG = {
    /** Kartet opnar sentrert på Noreg. */
    map: {
        senter: [64.5, 12.0],
        zoom: 5,
        minZoom: 4,
        maxZoom: 18,
        // Kartverket sine topografiske fliser er native til zoom 18, men lèt
        // seg skalere til 20 (same mønster som PolitiKartet).
        maxNativeZoom: 18,
        maxOppskalertZoom: 20,
    },

    /** Analyse-radius rundt brukarens punkt. */
    analyse: {
        /** Standard radius i meter. Visuell relevans strekk seg lenger enn støy. */
        standardRadiusM: 20000,
        valgbareRadiusM: [5000, 10000, 15000, 20000, 30000],

        /**
         * Maks tal turbinar som vert terrenganalysert i éi køyring.
         * Eit punkt midt i eit stort anlegg kan ha over 200 turbinar innanfor
         * 20 km (verifisert i datasettet: maks 202). Kvar av dei krev
         * høgdedata, så me tek dei nærmaste først og lèt brukaren utvide.
         */
        maksTurbinar: 150,

        /** Målpunkt per HTTP-kall mot elevation_profile.php (må vera ≤ MAX_TARGETS der). */
        batchStorleik: 20,

        /**
         * Kor mange batch-kall som får gå samtidig. Held total tid nede utan å
         * hamre verken vårt eige endepunkt eller Kartverket.
         */
        samtidigeKall: 3,

        /**
         * Kor langt utanfor NVE sitt planområde ein brukarflytta turbin må
         * hamne før appen seier ifrå.
         *
         * Draginga er med vilje IKKJE sperra av polygonet (sjå app.js
         * fullfoerTurbinFlytt) — brukaren kan ha gode grunnar til å teste ein
         * stad utanfor. Men eit punkt langt utanfor er ikkje lenger ei
         * korrigering av vår gjetning; det er eit anna scenario, og det bør
         * seiast. Terskelen er sett litt over rotordiameteren til ei stor
         * landturbin (~175 m), slik at ei justering langs kanten av området —
         * der polygonomrisset sjølv har nokre titals meter slark — ikkje
         * utløyser ei melding kvar gong.
         */
        flyttAatvaringM: 200,
    },

    /** Fysiske konstantar for siktlinjeberekninga. */
    sikt: {
        /** Augehøgd over bakken for ein ståande observatør. */
        augehoydeM: 1.6,

        /**
         * Effektiv jordradius for refraksjonskorreksjon.
         * Standard atmosfærisk refraksjon bøyer lysstrålen litt nedover, slik at
         * ein ser lenger enn rein geometri skulle tilseie. Standardtilnærminga
         * er å rekne med ein forstørra jordradius, R_eff = 7/6 · R.
         */
        jordradiusM: 6371008.8,
        refraksjonsfaktor: 7 / 6,

        /**
         * Profilpunkt nærare observatøren enn dette vert ikkje rekna som
         * sikthindringar. Utan denne grensa kan eitt einaste støyete
         * terrengpunkt rett ved observatøren gi ei falsk "alt er skjult"-dom,
         * fordi ekstrapolasjonsfaktoren D/d går mot uendeleg når d går mot 0.
         */
        minHindringsavstandM: 30,
    },

    /**
     * OVERFLATEMODELLEN (DOM) — kryssjekk mot skog og bygningar.
     *
     * =======================================================================
     * KVA DENNE SVARER PÅ, OG KVA HO IKKJE SVARER PÅ
     * =======================================================================
     * Heile siktlinjemodellen kviler på `dtm1` — bar bakke. Det er den mest
     * omtalte avgrensinga i prosjektet (PLAN.md §7): appen melder «synleg»
     * for turbinar som i praksis står bak ein granskog.
     *
     * Kartverket har òg `dom1`, ein OVERFLATEmodell frå same laserdata, der
     * skog og bygningar er med. Men den kan ikkje hentast som profil — berre
     * som enkeltpunkt (sjå ElevationService). Å hente DOM for kvart av dei
     * ~200 profilpunkta per turbin er uaktuelt.
     *
     * Difor ein MÅLRETTA sjekk: siktlinjeberekninga peikar allereie ut eitt
     * einaste terrengpunkt per turbin — `synlegheit.kritiskPunkt`, det som
     * gir den høgaste skrapelinja. Det er det punktet som avgjer saka. Me
     * slår opp DOM i akkurat det, og reknar horisonten om att med den heva
     * høgda substituert inn.
     *
     * Sidan DOM ≥ DTM overalt, kan substitusjonen berre HEVE horisonten. Det
     * gjer svaret einsidig påliteleg: seier kryssjekken «skjult», er han
     * skjult (gitt laserdataen); seier han «framleis synleg», kan turbinen
     * likevel vera skjult av skog i eit ANNA punkt langs profilen som me ikkje
     * slo opp. Det atterhaldet må stå i UI.
     */
    overflate: {
        /** Kartverket-datakjelda. Må vere kvitlista i ElevationService::KJELDER. */
        datakilde: 'dom1',

        /**
         * Kor mykje høgare DOM må liggje over DTM før me reknar det som eit
         * verkeleg hinder.
         *
         * Laserdata har støy, og dei to modellane er interpolerte kvar for
         * seg — små avvik på nokre titals centimeter er reint rekneverk. Ope
         * fjell gir typisk 0,0-0,1 m (Storheia målt til 0,02 m). To meter er
         * lågare enn nokon skog det er verdt å nemne, og høgt nok til at
         * ingenting av støyen slepp gjennom.
         */
        terskelM: 2.0,

        /**
         * Punkt per HTTP-kall mot vårt eige endepunkt. Kartverket sitt harde
         * tak er 50 per oppstraums-kall («maksimum 50 koordinater»), så eit
         * høgare tal her ville berre flytta oppdelinga eit hakk innover.
         */
        punktPerKall: 50,

        /** Kor mange slike kall som får gå samtidig. */
        samtidigeKall: 2,

        /**
         * Typisk trehøgd, berre til FORMULERING i UI («om lag ein 20 m
         * granskog»). Går ikkje inn i nokon utrekning — det er den målte
         * DOM-høgda som gjeld, ikkje eit anslag.
         */
        typiskSkoghoydeM: 20,

        /**
         * TOPP-K: kor mange punkt per turbin som vert slått opp — DET
         * KRITISKE PUNKTET MEDREKNA, ikkje i tillegg til det.
         *
         * Fyrste versjon av kryssjekken slo opp EITT punkt — det kritiske
         * terrengpunktet frå bar bakke. Det er det punktet som avgjer saka
         * NÅR TERRENGET SJØLV avgjer henne, men ikkje nødvendigvis der eit
         * hinder ville bety mest: tillegget eit hinder gir helninga er `H/d`,
         * altså 170 gonger større 30 m unna enn 5 km unna (sjå
         * `skannHorisontTopK()` i geo.js).
         *
         * K = 4 er valt etter måling, ikkje etter magekjensle. Kandidatane
         * vert deduplisert på koordinat før henting, og punkt-tenesta tek 50
         * per kall, så prisen for K = 4 mot K = 1 på eit typisk sett er ein
         * handfull kall — sjå CLAUDE.md §23 for dei målte tala. Over ~5 flatar
         * gevinsten ut: dei neste kandidatane ligg alt så lågt at eit hinder
         * der sjeldan når over horisonten dei fire fyrste set.
         */
        toppK: 4,

        /**
         * Den tenkte hinderhøgda kandidatane vert RANGERTE etter.
         *
         * Ikkje ein påstand om at det står 20 m skog overalt — det er ei ØVRE
         * GRENSE for kva eit punkt kan bidra med, brukt til å velje kvar det
         * er verdt å måle. Den faktiske høgda kjem frå oppslaget.
         *
         * 20 m er hogstmoden gran i Noreg (bonitet G14-G17). Høgare tal
         * flyttar rangeringa endå meir mot nærfeltet utan å endre kva som
         * faktisk vert MÅLT der.
         */
        kandidatHinderM: 20,

        /**
         * Minste avstand mellom to kandidatpunkt langs same profil.
         *
         * Profilen er sampla kvar 15. m dei fyrste 300 m (CLAUDE.md §7a). Utan
         * denne grensa ville dei fire høgaste kandidatane vore fire nabopunkt
         * på same knaus — fire oppslag i praktisk talt same tre. 120 m er
         * romsleg over den tette samplinga og under den grove (60 m) sin
         * dobbel, slik at kandidatane er reelt ulike stader.
         */
        minKandidatavstandM: 120,
    },

    /**
     * Visuell dominans — avstand målt i rotordiameter (RD).
     *
     * ATTERHALD (PLAN.md §4.2): dette er ein HEURISTIKK frå internasjonal
     * landskapsanalyse-litteratur, ikkje ein norsk forskriftsverdi. UI-et må
     * presentere det som "rettleiande kategori", aldri som ein fasit.
     */
    dominans: [
        { maksRd: 3,        nokkel: 'svaert_dominerande', tekst: 'Svært dominerande', klasse: 'dom-4' },
        { maksRd: 10,       nokkel: 'dominerande',        tekst: 'Tydeleg / dominerande', klasse: 'dom-3' },
        { maksRd: 20,       nokkel: 'merkbar',            tekst: 'Merkbar', klasse: 'dom-2' },
        { maksRd: 35,       nokkel: 'mindre',             tekst: 'Mindre framtredande', klasse: 'dom-1' },
        { maksRd: Infinity, nokkel: 'liten',              tekst: 'Liten visuell påverknad', klasse: 'dom-0' },
    ],

    /**
     * Støymodell — forenkla nordisk/dansk berekningsmetode for vindturbinstøy.
     *
     * L_p = L_WA − 20·log₁₀(d) − 11 + ΔL_g − ΔL_a·d − A_skjerming
     *
     * Dette er den same grunnforma som den danske statutoriske metoden for
     * vindmøllestøy bruker, med sfærisk spreiing, eit fast bakkereflekstillegg
     * og lineær luftabsorpsjon. Det er IKKJE full ISO 9613-2 med
     * frekvensbandoppløysing, meteorologi og reell diffraksjon.
     */
    stoy: {
        /** Bakkereflekstillegg over ope, lyddempande terreng (dB). */
        bakkereflekssjonDb: 1.5,

        /**
         * Luftabsorpsjon i dB per meter.
         *
         * Vindturbinstøy er dominert av bandet ~500-1000 Hz. ISO 9613-2 sine
         * absorpsjonskoeffisientar for norske normalforhold (~10 °C, 70-80 %
         * relativ fukt) ligg der på ca. 1,9 dB/km ved 500 Hz og 3,7 dB/km ved
         * 1 kHz. Me bruker 3 dB/km = 0,003 dB/m som representativ middelverdi.
         *
         * Kalibrering: med denne verdien hamnar L_den 45 dB-konturen rundt éin
         * 3,6 MW-turbin på ~600 m, og L_den 40 dB på ~950 m. Det stemmer godt
         * med publiserte støysonekart for norske anlegg (der konturane ligg
         * lenger ute fordi dei summerer mange turbinar — noko denne appen òg
         * gjer, energetisk).
         */
        luftabsorpsjonDbPerM: 0.003,

        /**
         * Skjermingsdemping når terrenget bryt sikta til navet.
         * Grov tilnærming til diffraksjonstap — ikkje Maekawa/ISO 9613-2.
         * Formel: min(maks, grunn + faktor·log₁₀(1 + skjulhøgde_m)).
         * ISO tillet inntil 20 dB for enkel diffraksjon; me held oss under for
         * å vera konservative (altså heller overvurdere støy enn undervurdere).
         */
        skjermingGrunnDb: 5,
        skjermingFaktor: 5,
        skjermingMaksDb: 15,

        /**
         * Påslag frå L_pA (konstant nivå) til estimert L_den.
         * L_den straffar kveld (+5 dB) og natt (+10 dB). For ei kjelde som går
         * jamt heile døgnet gir det eit fast påslag:
         *   10·log₁₀((12 + 4·10^0,5 + 8·10)/24) = +6,4 dB
         * Vindturbinar går tilnærma kontinuerleg, så dette er ei rimeleg
         * omrekning — men den reelle L_den avheng av vindstatistikk over året.
         */
        ldenPaaslagDb: 6.4,

        /**
         * Fargekoding mot T-1442 (Retningslinje for behandling av støy i
         * arealplanlegging), som set L_den 45 dB som rettleiande grense ved
         * støyfølsam busetnad for vindkraft.
         */
        terskelLavDb: 40,
        terskelHoyDb: 45,

        /**
         * Under denne avstanden er støy i praksis irrelevant å rekne på — og
         * over den vert modellen dominert av meteorologi me ikkje modellerer.
         */
        maksRelevantAvstandM: 10000,

        /**
         * Nedre grense for meiningsfull rapportering av L_den.
         *
         * Bakgrunnsstøy i eit stille landleg område ligg typisk på 25-35 dB.
         * Reknar modellen ut 7 dB, er talet matematisk korrekt, men det gir
         * eit falskt inntrykk av presisjon: nivået er langt under alt anna
         * ein høyrer, og modellen har uansett ingen oppløysing der nede
         * (skjermingsleddet åleine er ei grov tilnærming på ±5 dB).
         *
         * Verdiar under denne grensa visast difor som "under 25 dB" i staden
         * for eit konkret tal. Sjølve berekninga brukar framleis den eksakte
         * verdien i den energetiske summeringa.
         */
        rapporteringsgolvDb: 25,
    },

    /**
     * HINDERLYS — luftfartshindermerking av vindturbinar.
     *
     * KJELDE: forskrift 15. juli 2014 nr. 980 om rapportering, registrering og
     * merking av luftfartshinder (BSL E 2-1), slik ho lyder etter endringane
     * i kraft 1. januar 2024 og 1. januar 2026. Denne forskrifta ERSTATTAR
     * forskrift 3. desember 2002 nr. 1384 (BSL E 2-2), som ofte framleis vert
     * sitert — sjå CLAUDE.md §10 for kvifor skiljet betyr noko her.
     *
     * Dei relevante paragrafane, sitert:
     *
     *   § 3 f  «høyde på vindturbin: Den vertikale avstanden fra terrenget
     *          (middelvannstand for vindturbiner lokalisert til havs) og til
     *          toppen av rotorbladet når det står i høyeste posisjon.»
     *          → altså nøyaktig vår `totalhoyde_m`.
     *
     *   § 7(2) «Alle luftfartshinder med en høyde på 60 meter eller mer, skal
     *          merkes.»
     *
     *   § 16(3) a. «Hinderlys kan være fast eller blinkende. Dersom det
     *              benyttes blinkende hinderlys skal disse blinke samtidig.»
     *           b. «Vindturbiner med høyde inntil 150 meter skal merkes med to
     *              mellomintensitets hinderlys type B eller C, plassert på
     *              toppen av nacellen.»
     *           c. «Vindturbiner med høyde fra og med 150 meter og høyere skal
     *              merkes med to høyintensitets hinderlys type B plassert på
     *              toppen av nacellen, og lavintensitets hinderlys type B på
     *              mellomliggende nivå. Den vertikale avstanden mellom lysene
     *              skal ikke overstige 75 meter.»
     *
     *   Vedlegg 2 (lysstyrke, kolonne C = bakgrunnslys under 50 cd/m², dvs. natt):
     *           mellomintensitet type B – rødt,  fast/blink 20–60/min, 2 000 cd
     *           mellomintensitet type C – rødt,  fast,                 2 000 cd
     *           høyintensitet   type B – HVITT, blinkende 40–60/min,   2 000 cd
     *                                    (100 000 cd om dagen, 20 000 i skumring)
     *           lavintensitet   type B – rødt,  fast/blink,               32 cd
     *
     * MERK at toppmerkinga skiftar FARGE ved 150 m: under 150 m er toppen raud,
     * frå 150 m er han kvit og alltid blinkande. Det er motsett av det ein
     * lett tek for gitt, og gjer at dei største turbinane er dei som er lettast
     * å sjå om natta.
     */
    hinderlys: {
        /** § 7(2): merkeplikt frå 60 m totalhøgd. */
        merkepliktFraTotalhoydeM: 60,
        /** § 16(3) b/c: skiljet mellom mellomintensitet og høyintensitet. */
        hoyintensitetFraTotalhoydeM: 150,
        /** § 16(3) c: maks vertikal avstand mellom lysnivåa på tårnet. */
        maksVertikalAvstandM: 75,
        /**
         * Vedlegg 5 til forskrifta (rettleiing til § 16): «På vindturbiner skal
         * lysene fordeles mellom topp nacelle til terreng, totalt 3 sett med
         * lys.» Me handhevar difor minst 3 nivå på turbinar over 150 m, sjølv
         * når 75 m-regelen åleine ville klart seg med to.
         */
        minTalNivaa: 3,

        /** Lysstyrke om natta (Vedlegg 2, kolonne C), i candela. */
        cdMellomintensitet: 2000,
        cdHoyintensitet: 2000,
        cdLavintensitet: 32,

        /**
         * Illuminans frå ei stjerne med tilsynelatande magnitude 0, i lux.
         * Standard fotometrisk konstant (V-bandet). Brukast til å rekne om
         * lysstyrke + avstand til ein magnitude ein kan samanlikne med kjende
         * himmellekamar — det er den einaste måten å gjere «2000 candela»
         * forståeleg for ein lesar.
         */
        magnitude0Lux: 2.54e-6,
        /**
         * Meteorologisk siktvidde lagt til grunn for atmosfærisk ekstinksjon
         * (klar natt). Ekstinksjonen er 1,086 · (3,912 / V) magnitude per km,
         * altså ~0,11 mag/km ved V = 40 km. Utan dette leddet vert lysa
         * systematisk overvurderte på lang avstand.
         */
        siktvidddeKm: 40,
    },

    /**
     * SKYGGEKAST (shadow flicker).
     *
     * ---------------------------------------------------------------------
     * NORSK PRAKSIS — verifisert mot NVE, ikkje mot tysk/dansk sekundærkjelde
     * ---------------------------------------------------------------------
     * NVE: «I Norge er det ingen fastsatte grenseverdier for skyggekast fra
     * vindturbiner.» Men NVE har sidan veileder 2/2014 ein forvaltningspraksis
     * (oppdatert med Norconsult sin kunnskapsrapport frå 2022) med to
     * tilrådde grenser for bygningar med skyggekastfølsam bruk:
     *
     *     TEORETISK skyggekast:  maks 30 timar/år ELLER 30 minutt/dag
     *     FAKTISK   skyggekast:  maks  8 timar/år
     *
     * Skilnaden er avgjerande for kva appen kan samanlikne mot. «Teoretisk»
     * føreset skyfri himmel heile året og rotor alltid i verste vinkel — det
     * er nøyaktig det denne modellen reknar. «Faktisk» korrigerer for skydekke
     * og reell vindretning, og krev vêr- og vindstatistikk me ikkje har.
     *
     * Appen samanliknar difor MOT 30-TIMARSGRENSA, ikkje mot 8-timarsgrensa.
     * Å halde vårt teoretiske tal opp mot 8-timarsgrensa ville vore ei
     * systematisk overdriving på om lag ein faktor 3,75.
     *
     * ---------------------------------------------------------------------
     * GEOMETRIEN
     * ---------------------------------------------------------------------
     * NVE: «Når mindre enn 20 prosent av solskiven er dekket av turbinbladet,
     * defineres dette ikke lenger som skyggekast.» og «skyggekast fra moderne
     * vindturbiner kan nå mottaker inntil 2 km fra nærmeste vindturbin».
     *
     * Solhøgd-terskelen på 3° er henta frå den tyske WEA-Schattenwurf-
     * rettleiinga (som NVE eksplisitt seier praksisen er i tråd med): under 3°
     * gjer refraksjon og atmosfærisk dis skuggen uskarp og irrelevant.
     */
    skyggekast: {
        /** Solhøgd under dette gir ingen relevant skugge. */
        minSolhoydeGrader: 3,

        /**
         * Tidsoppløysing i minutt. 1 minutt over eit heilt år er 525 600 steg;
         * soltabellen reknast ÉIN gong per punkt og gjenbrukast for alle
         * turbinar, så kostnaden er lineær i tal turbinar, ikkje kvadratisk.
         */
        stegMinutt: 1,

        /**
         * Rotoren modellerast som ei ugjennomsiktig SKIVE som alltid står
         * vinkelrett på sola (verste tenkelege geometri). Det er definisjonen
         * av «teoretisk skyggekast», og same føresetnad som WindFarmer/WindPRO
         * bruker: «the worst case scenario occurs when the rotor is facing 180
         * degrees away from the sun's azimuth».
         */
        rotorAlltidMotSola: true,

        /**
         * Maks relevant avstand = k · rotordiameter, klemt til 2 km.
         *
         * k er UTLEIDD, ikkje gjetta. 20 %-kriteriet til NVE er eit krav om
         * at bladet dekkjer nok av solskiva. Ei stripe med breidd w over ei
         * skive med vinkeldiameter Ds dekkjer ca. 4w/(π·Ds) av arealet; sola
         * har Ds ≈ 0,53° = 9,25 mrad, så w må spenne minst 1,45 mrad.
         * Med ei midlere bladkorde på ~RD/50 (≈3 m for ein 150 m rotor) gir
         * det RD/50 / 1,45e-3 ≈ 13,8 · RD.
         *
         * For ein 150 m rotor landar det på 2 070 m — altså nøyaktig NVE sitt
         * eige tal «inntil 2 km». Den gamle tommelfingerregelen «10 · RD» er
         * same storleiksorden, men utleiinga viser KVIFOR grensa finst.
         */
        avstandPerRotordiameter: 13.8,
        maksAvstandM: 2000,

        /** NVE si tilrådde grense for TEORETISK skyggekast. */
        grenseTimarPerAar: 30,
        grenseMinuttPerDag: 30,
        /** NVE si tilrådde grense for FAKTISK skyggekast (til samanlikning). */
        faktiskGrenseTimarPerAar: 8,
        /**
         * Grov peikepinn på forholdet teoretisk : faktisk i norsk praksis
         * (30 t/år teoretisk ≈ 8 t/år faktisk). Brukast berre til å vise eit
         * illustrativt «faktisk»-anslag ved sida av, aldri som ein prognose.
         */
        faktiskAndel: 8 / 30,
    },

    /**
     * 3D-PANORAMA — «snu deg rundt og sjå».
     *
     * ---------------------------------------------------------------------
     * KVIFOR EIT PANORAMA I DET HEILE
     * ---------------------------------------------------------------------
     * Panelet svarer presist på «kor mykje av turbinen er over horisonten»
     * (70 %) og «kor mange grader tek han i synsfeltet» (1,8°). Begge tala er
     * korrekte, og nesten ingen klarer å gjere dei om til eit bilete i hovudet.
     * Panoramaet teiknar det same talmaterialet i den forma spørsmålet
     * eigentleg vart stilt i: kva ser eg når eg står her og snur meg rundt.
     *
     * Det legg IKKJE til nye data. Kvar turbin står i den retninga
     * `bearing()` gav, i den avstanden `haversine()` gav, med dei måla
     * TurbineSpec fann, klipt mot nøyaktig den `horisontMoh` panelet viser.
     *
     * ---------------------------------------------------------------------
     * TAL RETNINGAR — ei avveging mot Kartverket, ikkje mot GPU-en
     * ---------------------------------------------------------------------
     * Kostnaden ved fleire retningar er nettverk, ikkje teikning. Kvar retning
     * er éin terrengprofil på ~180 punkt, og WPS-en tek ~380 punkt per kall:
     * 72 retningar ≈ 13 000 punkt ≈ 34 WPS-kall. Å doble til 144 ville doble
     * ventetida for ein silhuett som knapt endrar seg — 5° er finare enn
     * terrenget varierer på 20 km avstand (5° er 1,7 km der ute), og finare
     * enn augets eiga oppløysing for ein fjern rygg.
     *
     * Nærfeltet er den kritiske sona (sjå CLAUDE.md §7a), og der er 5° berre
     * 26 m på 300 m avstand — tettare enn terrengmodellen sjølv.
     */
    panorama: {
        /** Tal jamt fordelte kompassretningar horisonten skannast i. */
        talRetningar: 72,

        /**
         * Kor langt ut horisontstrålane går. Held seg til analyseradiusen, men
         * aldri lenger enn dette: bortanfor 20 km er terrenget uansett dis.
         */
        maksAvstandM: 20000,

        /**
         * MÅLPUNKT PER HTTP-KALL — vald etter TID TIL FYRSTE BILETE, ikkje
         * etter total tid.
         *
         * Må vera ≤ MAX_TARGETS i elevation_profile.php.
         *
         * Stod på 18 (= 4 kall for 72 retningar). Etter at panoramaet byrja
         * teikne kvart delresultat med det same (CLAUDE.md §21), er det ikkje
         * lenger totaltida som avgjer kva brukaren opplever, men kor fort den
         * FYRSTE batchen landar. Målt på kalde punkt, tre lanes:
         *
         *   batch 18 → 4 kall:  fyrste bilete 27,6 s · alt ferdig 55,0 s
         *   batch  6 → 12 kall: fyrste bilete 11,4 s · alt ferdig 44,7 s
         *   batch  3 → 24 kall: fyrste bilete  7,3 s · alt ferdig 54,4 s
         *
         * 6 er valt fordi det er det siste steget som gjer BEGGE deler betre.
         * 3 halverer fyrstebiletet ein gong til, men legg ~20 % på totaltida
         * (dobbelt så mange rundturar for same tal punkt) og gir eit
         * fyrstebilete av berre tre strålar — 120° mellom kvar, altså ein
         * trekant, ikkje ein horisont. Med 6 strålar er dei 60° frå kvarandre
         * og biletet les som ei grov, men komplett 360°-form.
         */
        batchStorleik: 6,

        /**
         * SAMTIDIGE KALL FOR DEI LANGE STRÅLANE.
         *
         * Stod på 1 — heilt sekvensielt — for ikkje å hamre Kartverket. Målt
         * kostnad av det: ei KALD panoramaopning brukte 59 s på Høg-Jæren og
         * 172 s på Lista berre på horisonten, fordi 4 HTTP-kall × 9 WPS-kall
         * gjekk etter kvarandre.
         *
         * Nærfelt-hentinga køyrer 216 strålar med `naerSamtidigeKall: 6` og
         * gjorde det på 12 s, mot null feila kall gjennom heile testrunden.
         * Tenesta toler altså fleire samtidige kall frå éin klient utan
         * vidare.
         *
         * Stod deretter ei stund på 3, ut frå at dei lange profilane er fem
         * gonger så tunge per kall. Den vurderinga heldt ikkje mot måling.
         * Med `batchStorleik: 6` er kvart kall no like lett som eit
         * nærfelt-kall, og på kalde punkt (snitt over tre kvar):
         *
         *   samtidigeKall 3: fyrste bilete 13,2 s · alt ferdig 48,0 s
         *   samtidigeKall 6: fyrste bilete 11,6 s · alt ferdig 37,1 s
         *
         * Grunnen ligg oppstraums og er verifisert direkte: eitt kall med 6
         * målpunkt tek 11,1 s, tre samtidige tek 32,2 s til saman (altså
         * ingen gevinst), medan SEKS samtidige gjer dobbelt så mykje arbeid
         * på same tid. Kjeda gir ikkje meir gjennomstrøyming før det ligg
         * nok kall inne til å halde henne i arbeid.
         *
         * Fasane er framleis sekvensielle — horisont, så nærfelt — så toppen
         * i talet samtidige kall er 6, det same som før.
         */
        samtidigeKall: 6,

        /**
         * ===================================================================
         * NÆRFELT-FORTETTING — fleire kompassretningar der auget ser facettane
         * ===================================================================
         * Facetten auget faktisk ser i eit panorama er ANGULÆR, og den
         * asimutale facetten frå eit radielt vifte-mesh er like stor uansett
         * avstand: 360/72 = 5°, altså ~1/12 av eit normalt synsfelt. Det er
         * den som gjer bakken nær observatøren kantete — ikkje at strålane
         * ligg langt frå kvarandre i METER (på 100 m er 5° berre 8,7 m, mens
         * den radiale samplinga der er 15 m).
         *
         * Difor er fortettinga asimutal, ikkje eit kartesisk rutenett. Eit
         * rutenett på 40–60 m ville faktisk gjort NÆRFELTET GROVARE enn i
         * dag: på 100 m avstand er 50 m mellom punkta 6× glisnare enn dei
         * 8,7 m dei 72 strålane alt gir. Sjå CLAUDE.md §18.
         *
         * `naerFaktor` er kor mange gonger fleire retningar nærfeltet får.
         * 3 gir 216 retningar = 1,67°, altså tre gonger så fin silhuett.
         * Kostnaden er (naerFaktor − 1) × talRetningar korte profilar.
         */
        naerFaktor: 3,

        /**
         * Kor langt ut dei ekstra retningane vert henta. Utanfor dette vert
         * dei interpolerte asimutalt frå dei 72 lange strålane — som er
         * nøyaktig same flate rasteriseraren alt teiknar i dag, så
         * fjernfeltet er uendra.
         *
         * 1 200 m er valt fordi terrenget innanfor der er det som fyller
         * nedre halvdel av synsfeltet. Lenger ute tek den radiale samplinga
         * (~124 m) uansett over som den grovaste aksen.
         */
        naerAvstandM: 1200,

        /**
         * Radiell steglengd mellom 300 m og `naerAvstandM` i det felles
         * radiusrutenettet. Dei lange strålane har berre ~124 m der (160
         * punkt fordelt på 20 km); dei korte har 60 m frå serveren, så 60 m
         * er den finaste oppløysinga som faktisk finst i data.
         */
        naerStegM: 60,

        /**
         * MINSTE ASIMUTALE PUNKTAVSTAND I METER — taket på kor fin meshen får
         * lov til å bli like ved observatøren.
         *
         * Same forsterking som CLAUDE.md §7a skildrar for siktlinjer slår inn
         * her, berre vertikalt i biletet: éin meter terrenghøgd 15 m unna er
         * 3,8° synsvinkel, medan same meteren 500 m unna er 0,11°. Med 216
         * retningar ligg nabostrålane berre 0,44 m frå kvarandre på 15 m
         * avstand — godt under den horisontale oppløysinga terrengmodellen
         * faktisk har. Då teiknar meshen ikkje lenger terreng, men
         * modellens eiga uvisse, forstørra til fleire grader.
         *
         * Ringar der den asimutale punktavstanden fell under dette vert
         * difor glatta sirkulært til akkurat denne oppløysinga. Grensa slår
         * berre inn innanfor ~46 m; utanfor er glattinga ein nulloperasjon.
         * Dei 72 gamle strålane trefte aldri dette (dei låg 4 m frå
         * kvarandre alt på 46 m), som er grunnen til at problemet fyrst kom
         * til syne med fortettinga.
         */
        naerMinAsimutStegM: 4,

        /** Profilar per HTTP-kall for nærfeltet, og kor mange kall samtidig. */
        naerBatchStorleik: 10,
        naerSamtidigeKall: 6,

        /**
         * Three.js, pinna versjon, ES-modulbygget frå unpkg.
         *
         * Lastast med dynamisk import() FØRST når brukaren opnar panoramaet —
         * 166 KB gzipa skal ikkje belaste dei som berre ser på kartet.
         *
         * CSP: `script-src` tillèt allereie unpkg.com (same opphav som Leaflet
         * og MarkerCluster). Modulbygget er sjølvhaldande — ingen bare
         * imports — så det trengst korkje importmap eller 'unsafe-inline'.
         * Sjå CLAUDE.md §16.
         */
        threeUrl: 'https://unpkg.com/three@0.160.0/build/three.module.min.js',

        /** Synsfelt (vertikalt) i grader: start, og grensene for zoom. */
        startFovGrader: 60,
        minFovGrader: 10,
        maksFovGrader: 100,

        /**
         * Radius på himmelkula og på terrengmeshen sin ytterkant. Terrenget
         * må liggje innanfor himmelen, og begge innanfor kameraets far-plan.
         */
        himmelRadiusM: 60000,

        /**
         * Rotoren teiknast vend mot observatøren.
         *
         * Datasettet har ingen vindretning, så nacelle-asimut er ukjend. Av dei
         * tre moglege vala — fast retning, tilfeldig, eller mot observatøren —
         * er «mot observatøren» det einaste som er DEFINERT verste tilfelle,
         * og det er same prinsipp som resten av appen følgjer (øvre ende av
         * målspenn, maksimum hinderlys, teoretisk skyggekast). Ein rotor sett
         * frå sida dekkjer ~1/3 av arealet han gjer sett rett framanfrå.
         */
        rotorMotObservator: true,

        /** Rotasjon, omdreiingar per minutt. Typisk for ein stor landturbin. */
        rotorRpm: 11,

        /**
         * Solhøgd (grader) der hinderlysa går frå å vera irrelevante til å
         * dominere biletet. Over `lysAvGrader` er dagslyset så sterkt at lysa
         * ikkje syner; under `lysPaaGrader` er natta full.
         */
        lysAvGrader: 3,
        lysPaaGrader: -6,

        /** Blinkfrekvens, blink per minutt. § 16(3) a: alle blinkar SAMTIDIG. */
        blinkPerMinutt: 45,

        /**
         * FLYFOTO DRAPERT OVER TERRENGMESHEN.
         *
         * Kjelda er Esri sitt `World_Imagery`, same laget som allereie er eit
         * bakgrunnsval i 2D-kartet (`MapManager.js`). Kartverket sitt eige
         * ortofoto («Norge i bilder») er betre, men WMTS-en krev token —
         * verifisert: `tilecache.norgeibilder.no` svarar
         * `{"error":{"code":499,"message":"Token Required"}}`. Sjå
         * `SatelliteTexture.js` for heile grunngjevinga.
         */
        satellitt: {
            paa: true,

            /**
             * Flismal. Merk `{z}/{y}/{x}` — ArgGIS-endepunktet tek RAD før
             * KOLONNE, motsett av OSM-konvensjonen. Same URL som i MapManager.
             */
            urlMal: 'https://server.arcgisonline.com/ArcGIS/rest/services/'
                  + 'World_Imagery/MapServer/tile/{z}/{y}/{x}',

            /** Lisenskrav, ikkje pynt. Same tekst som 2D-kartet bruker. */
            attribusjon: 'Kjelde: Esri',

            /**
             * EIN OPPLØYSINGSPYRAMIDE, IKKJE EIN TEKSTUR.
             *
             * Web Mercator har jamn oppløysing over bakken. Eit panorama har
             * det ikkje: bakken 200 m unna fyller mange gonger så mange
             * skjermpikslar som bakken 15 km unna. Ein einaste tekstur måtte
             * difor anten vore grov i nærfeltet eller kosta fleire hundre
             * flisar for detalj ingen ser.
             *
             * Kvar ring får eige zoomnivå, valt som det HØGASTE som held seg
             * innanfor flisbudsjettet sitt. Ved 64° nord landar det på:
             *
             *   0–900 m     z=16   ~1,0 m/px   ~56 flisar   (einskildtre synlege)
             *   0–4 km      z=14   ~4,2 m/px   ~72 flisar
             *   0–20 km     z=12   ~17 m/px   ~121 flisar
             *
             * Til saman ~250 flisar á ~16 KB ≈ 4 MB. Ringane overlappar med
             * vilje — den ytre dekkjer heile scenen og er den einaste som MÅ
             * lukkast; dei indre er reine forbetringar som kan falle bort kvar
             * for seg utan at noko vert borte.
             *
             * `radiusM: null` = «heilt ut til `maksAvstandM`».
             */
            ringar: [
                { radiusM: 900,   maksFlisar: 64 },
                { radiusM: 4000,  maksFlisar: 100 },
                { radiusM: null,  maksFlisar: 144 },
            ],

            /**
             * Zoom-spennet planleggjaren søkjer i. Han går ovanfrå og ned til
             * flistalet er innanfor budsjettet, i staden for å rekne ut zoom
             * frå ei ønska meter-per-piksel — Mercator-oppløysinga går som
             * cos(lat), så eit fast meterkrav ville gitt vilt ulike flistal
             * på 58° og 71° nord.
             */
            minZoom: 9,
            maksZoom: 16,

            /** Øvre kant for lerretstorleik, av omsyn til GPU-teksturgrenser. */
            maksPiksel: 4096,

            /** Samtidige biletehentingar. 8 er innanfor h2-multipleksinga. */
            samtidigeKall: 8,
            flisTimeoutMs: 9000,

            /** Farge under flisane, slik at ein tapt flis ikkje vert eit hol. */
            grunnfarge: '#46503c',

            /**
             * Kor mykje av den prosedyregenererte terrengfargen som vert
             * multiplisert inn over fotoet. Fargen vert først normalisert til
             * lysstyrke 1, så han berre ber FARGETONE — elles ville dei mørke
             * skogfargane gjort fotoet nesten svart. 0 = reint foto.
             */
            prosedyrevekt: 0.20,

            /** Per-vertex lysstyrkestøy over fotoet. Mykje svakare enn utan. */
            stoyAmplitude: 0.08,
        },
    },

    /** Statuskategoriar frå NVE-normaliseringa: farge + etikett. */
    status: {
        i_drift:                { tekst: 'I drift',              farge: '#16a34a' },
        under_bygging:          { tekst: 'Under bygging',        farge: '#ca8a04' },
        konsesjon_ikke_bygd:    { tekst: 'Konsesjon, ikkje bygd', farge: '#ea580c' },
        konsesjon_gitt:         { tekst: 'Konsesjon gitt',       farge: '#ea580c' },
        under_behandling:       { tekst: 'Under behandling',     farge: '#2563eb' },
        avslatt:                { tekst: 'Avslått',              farge: '#dc2626' },
        planlegging_avsluttet:  { tekst: 'Planlegging avslutta',  farge: '#6b7280' },
        nedlagt:                { tekst: 'Nedlagt',              farge: '#78716c' },
        ukjent:                 { tekst: 'Ukjend status',        farge: '#9ca3af' },
    },

    /** Kva statusar som er påslegne når appen opnar. */
    standardStatusFilter: ['i_drift', 'under_bygging', 'konsesjon_ikke_bygd', 'konsesjon_gitt', 'under_behandling'],

    api: {
        turbinCache: 'cache/turbines.json',
        omradeCache: 'cache/areas.json',
        hoydeprofil: 'backend/api/elevation_profile.php',
        hoydepunkt: 'backend/api/elevation_point.php',
        overflatepunkt: 'backend/api/surface_points.php',
        adressesok: 'backend/api/adressesok.php',
        versjonssjekk: 'backend/api/version_check.php',
        oppdaterTurbindata: 'backend/api/refresh_turbines.php',
    },

    /**
     * Varsel i den sjølvhosta appen (nedlastbar utgåve). Ingen effekt på
     * web-versjonen: version_check.php svarar «ingen nyare versjon» utan ei
     * `version.json`, og refresh-endepunktet er avslege når CRON_SECRET er sett.
     */
    sjolvhost: {
        /** Vis «turbindata er gamle»-varsel når snapshotet er eldre enn dette. */
        turbindataGamleDagar: 45,
    },

    /**
     * Synlegheitskart (lokal ZVI): eit rutenett rundt punktet, farga etter kor
     * mange turbinar som er synlege frå kvar celle.
     *
     * Metoden er ei TILNÆRMING: for kvar celle vert terrenghorisonten mot kvar
     * turbin justert for cella si eiga bakkehøgd, med same kritiske
     * skjermingspunkt som analysepunktet (`horisontMoh + Δz·(1 − D/d_krit)`).
     * Det held berre når cella er nær punktet — difor eit lite rutenett. Sjå
     * js/utils/Zvi.js.
     */
    synlegheitskart: {
        /** Sidelengd på rutenettet i meter (punktet i midten). */
        sideM: 480,
        /** Celler per side (odde tal → punktet får si eiga celle). 13² = 169. */
        celler: 13,
    },
};
