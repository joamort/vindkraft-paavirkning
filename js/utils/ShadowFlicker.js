/**
 * js/utils/ShadowFlicker.js
 *
 * Skyggekast (shadow flicker) — kor mange timar i året rotoren teoretisk kan
 * kaste skugge over brukarens punkt, og når på året/døgnet det skjer.
 *
 * ===========================================================================
 * KVA «TEORETISK» BETYR, OG KVIFOR DET ER HEILE POENGET
 * ===========================================================================
 * NVE skil skarpt mellom to storleikar, og dei har KVAR SIN tilrådde grense:
 *
 *   TEORETISK skyggekast — skyfri himmel heile året, og rotoren alltid vend
 *                          rett mot sola. Rein astronomi og geometri.
 *                          NVE si tilrådde grense: 30 t/år eller 30 min/dag.
 *
 *   FAKTISK   skyggekast — korrigert for skydekke og reell vindretning
 *                          (rotoren står ofte skrått eller i ro).
 *                          NVE si tilrådde grense: 8 t/år.
 *
 * Denne modulen reknar **teoretisk** skyggekast, fordi det er det einaste som
 * kan reknast utan vêr- og vindstatistikk. Difor må resultatet samanliknast
 * med 30-timarsgrensa, ikkje 8-timarsgrensa. Forholdet mellom dei to grensene
 * (30 : 8 ≈ 3,75) er i seg sjølv NVE si eiga vurdering av kor mykje lågare
 * det faktiske skyggekastet ligg — same storleiksorden som «~60 % mindre».
 *
 * NVE understrekar samstundes: «I Norge er det ingen fastsatte grenseverdier
 * for skyggekast fra vindturbiner.» Grensene er forvaltningspraksis frå
 * NVE veileder 2/2014, ikkje forskrift.
 *
 * ===========================================================================
 * GEOMETRIEN — eksakt for ei skive, på tre linjer
 * ===========================================================================
 * Rotoren modellerast som ei ugjennomsiktig SKIVE med radius R, sentrert i
 * navet, som alltid står vinkelrett på sola. Det er verste tenkelege
 * geometri, og same føresetnad som WindFarmer og WindPRO bruker.
 *
 * Sola står i asimut A og høgd θ. Skuggen går altså mot A+180°. Legg
 * observatøren inn i eit koordinatsystem med akse langs skuggeretninga:
 *
 *     langs  = d · cos(Δ)      Δ = vinkelen mellom skuggeretninga og
 *     tvers  = d · sin(Δ)          retninga turbin → observatør
 *
 * Ein stråle som treffer observatørens auge (på høgda `augeMoh`) og kjem inn
 * med helling θ, forlét rotoren i høgda
 *
 *     pMoh = augeMoh + langs · tan(θ)
 *
 * Skuggen dekkjer observatøren nøyaktig når det punktet ligg på skiva:
 *
 *     |pMoh − navMoh| ≤ R      og      |tvers| ≤ √(R² − (pMoh − navMoh)²)
 *
 * Ingen tilnærmingar utover flat bakke lokalt ved observatøren — begge
 * endepunkta bruker EKTE terrenghøgd frå Kartverket.
 *
 * ===========================================================================
 * TRE TING MODELLEN IKKJE VEIT
 * ===========================================================================
 * 1. Skydekke. Vestlandet har langt fleire overskya timar enn Finnmark; den
 *    same teoretiske timen betyr ikkje det same to stader.
 * 2. Vindretninga, som avgjer kva veg rotoren faktisk peikar. Modellen
 *    føreset verste vinkel i kvart einaste minutt av året.
 * 3. Om turbinen går. Ein turbin i ro kastar ein stillestående skugge, som
 *    ikkje er «flicker».
 *
 * Alle tre trekk i same retning: det verkelege talet er LÅGARE.
 */

import { CONFIG } from '../config.js';
import { haversine, bearing } from './geo.js';

const S = CONFIG.skyggekast;
const DEG = Math.PI / 180;
const MIN_PER_DOGN = 1440;

// ===========================================================================
// SOLPOSISJON — NOAA
// ===========================================================================

/**
 * Solas deklinasjon og tidsjamning for eit gitt julianske århundre.
 *
 * Implementasjonen følgjer NOAA sin «Solar Calculation» (same likningar som
 * NOAA_Solar_Calculations.xlsx), som er nøyaktig til betre enn 0,01° for
 * åra 1900–2100. Ingen ekstern teneste er involvert — dette er lukka-form
 * matematikk.
 *
 * Begge storleikane endrar seg SEINT (deklinasjonen under 0,4° per døgn), så
 * dei reknast éin gong per dag og gjenbrukast for alle minutta i døgnet. Det
 * er det som gjer eit heilt år på minuttoppløysing praktisk mogleg i
 * nettlesaren.
 *
 * @param {number} t Julianske århundre sidan J2000.0
 * @returns {{deklinasjonRad:number, tidsjamningMin:number}}
 */
export function soldagsverdiar(t) {
    // Geometrisk middellengd og middelanomali (grader).
    const l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
    const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
    const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

    // Midtpunktslikninga.
    const c = Math.sin(m * DEG) * (1.914602 - t * (0.004817 + 0.000014 * t))
            + Math.sin(2 * m * DEG) * (0.019993 - 0.000101 * t)
            + Math.sin(3 * m * DEG) * 0.000289;

    const sannLengd = l0 + c;
    // Tilsynelatande lengd (nutasjon + aberrasjon).
    const lambda = sannLengd - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * t) * DEG);

    const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
    const eps = eps0 + 0.00256 * Math.cos((125.04 - 1934.136 * t) * DEG);

    const deklinasjonRad = Math.asin(Math.sin(eps * DEG) * Math.sin(lambda * DEG));

    // Tidsjamninga (minutt): skilnaden mellom sann og midlere soltid.
    const y = Math.tan((eps / 2) * DEG) ** 2;
    const tidsjamningMin = 4 / DEG * (
        y * Math.sin(2 * l0 * DEG)
        - 2 * e * Math.sin(m * DEG)
        + 4 * e * y * Math.sin(m * DEG) * Math.cos(2 * l0 * DEG)
        - 0.5 * y * y * Math.sin(4 * l0 * DEG)
        - 1.25 * e * e * Math.sin(2 * m * DEG)
    );

    return { deklinasjonRad, tidsjamningMin };
}

/**
 * Atmosfærisk refraksjon i grader, gitt sann (geometrisk) solhøgd.
 *
 * Sola SYNEST høgare enn ho geometrisk står, og det er den tilsynelatande
 * posisjonen som avgjer kvar skuggen fell. Ved 3° høgd er korreksjonen om lag
 * 0,24° — nok til å flytte skuggekanten fleire titals meter, så leddet er
 * ikkje pynt.
 *
 * Formelen er NOAA si standardtilnærming.
 */
export function refraksjonGrader(hoydeGrader) {
    if (hoydeGrader > 85) return 0;
    const te = Math.tan(hoydeGrader * DEG);
    let r;
    if (hoydeGrader > 5) {
        r = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
    } else if (hoydeGrader > -0.575) {
        r = 1735 + hoydeGrader * (-518.2 + hoydeGrader * (103.4 + hoydeGrader * (-12.79 + hoydeGrader * 0.711)));
    } else {
        r = -20.772 / te;
    }
    return r / 3600;
}

/**
 * Solas asimut og (tilsynelatande) høgd for eitt tidspunkt.
 *
 * @param {Date} utc
 * @param {number} lat
 * @param {number} lon
 * @returns {{asimut:number, hoyde:number}} grader; asimut 0 = nord, 90 = aust
 */
export function solposisjon(utc, lat, lon) {
    const jd = utc.getTime() / 86400000 + 2440587.5;
    const t = (jd - 2451545.0) / 36525;
    const { deklinasjonRad, tidsjamningMin } = soldagsverdiar(t);

    const minuttUtc = utc.getUTCHours() * 60 + utc.getUTCMinutes() + utc.getUTCSeconds() / 60;
    return solposisjonFraDagsverdiar(minuttUtc, lat, lon, deklinasjonRad, tidsjamningMin);
}

/**
 * Den indre, raske delen: solposisjon når deklinasjon og tidsjamning alt er
 * kjende for døgnet.
 *
 * @param {number} minuttUtc      Minutt sidan midnatt UTC
 * @param {number} lat            Breiddegrad
 * @param {number} lon            Lengdegrad
 * @param {number} deklinasjonRad
 * @param {number} tidsjamningMin
 */
export function solposisjonFraDagsverdiar(minuttUtc, lat, lon, deklinasjonRad, tidsjamningMin) {
    // Sann soltid: UTC + tidsjamning + 4 min per lengdegrad aust.
    const sannSoltid = (minuttUtc + tidsjamningMin + 4 * lon + 1440) % 1440;
    // Timevinkel: negativ før soltidsmiddag, positiv etter.
    const timevinkel = (sannSoltid / 4 - 180) * DEG;

    const latRad = lat * DEG;
    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const sinDek = Math.sin(deklinasjonRad);
    const cosDek = Math.cos(deklinasjonRad);

    const sinHoyde = sinLat * sinDek + cosLat * cosDek * Math.cos(timevinkel);
    const hoydeSann = Math.asin(Math.max(-1, Math.min(1, sinHoyde))) / DEG;
    const hoyde = hoydeSann + refraksjonGrader(hoydeSann);

    const cosHoyde = Math.cos(hoydeSann * DEG);
    let asimut;
    if (Math.abs(cosHoyde) < 1e-9) {
        asimut = 180;
    } else {
        // Asimut frå nord, medsols. atan2-forma er robust i alle kvadrantar,
        // i motsetnad til acos-forma, som mistar forteiknet.
        const sinA = -cosDek * Math.sin(timevinkel) / cosHoyde;
        const cosA = (sinDek - sinLat * Math.sin(hoydeSann * DEG)) / (cosLat * cosHoyde);
        asimut = (Math.atan2(sinA, cosA) / DEG + 360) % 360;
    }

    return { asimut, hoyde };
}

// ===========================================================================
// TIDSSONE
// ===========================================================================

/** Siste søndag i ein månad, som UTC-timestamp for kl. 01:00 UTC. */
function sisteSondag(aar, manad) {
    // Gå bakover frå siste dagen i månaden til me finn ein søndag.
    const d = new Date(Date.UTC(aar, manad + 1, 0, 1, 0, 0));
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    return d.getTime();
}

/**
 * Offset frå UTC til norsk lokaltid, i timar (1 eller 2).
 *
 * Rekna eksplisitt i staden for å bruke `toLocaleString('Europe/Oslo')`, av to
 * grunnar: kallet er tregt nok til å merkast når det skjer 500 000 gonger, og
 * testsuiten skal gi same svar uansett kva tidssone maskina står i.
 *
 * EU-regelen: sommartid frå siste søndag i mars kl. 01:00 UTC til siste
 * søndag i oktober kl. 01:00 UTC.
 */
export function norskUtcOffsetTimar(msUtc, aar) {
    const start = sisteSondag(aar, 2);   // mars
    const slutt = sisteSondag(aar, 9);   // oktober
    return (msUtc >= start && msUtc < slutt) ? 2 : 1;
}

// ===========================================================================
// SOLTABELL
// ===========================================================================

/**
 * Maks avstand der skyggekast er relevant, for ein gitt rotordiameter.
 * Sjå grunngjevinga i CONFIG.skyggekast.avstandPerRotordiameter.
 */
export function maksSkyggeavstandM(rotorDiameterM) {
    if (!(rotorDiameterM > 0)) return 0;
    return Math.min(S.maksAvstandM, S.avstandPerRotordiameter * rotorDiameterM);
}

/**
 * Bygg ein tabell over alle minutt i året der sola står høgt nok til å gi
 * relevant skygge.
 *
 * ===========================================================================
 * KVIFOR TABELLEN BYGGJAST ÉIN GONG, IKKJE PER TURBIN
 * ===========================================================================
 * Solposisjonen avheng berre av punktet og tidspunktet — ikkje av turbinen.
 * Eit punkt kan ha 40 turbinar innanfor skyggekast-radius; å rekne solas gang
 * 40 gonger ville vore 40 gonger for mykje arbeid. Tabellen reknast difor
 * éin gong per punkt, og kvar turbin gjer berre nokre få multiplikasjonar per
 * minutt.
 *
 * Minutta der sola står under terskelen er kasta bort med det same. På 60°N
 * står sola over 3° i under 40 % av årets minutt, så tabellen krympar til
 * ~200 000 oppføringar — 1,6 MB i typede array.
 *
 * @param {{lat:number, lon:number}} punkt
 * @param {number} [aar] Referanseår (skotår gir 366 dagar)
 * @returns {{aar:number, n:number, minuttIAar:Int32Array, asimut:Float32Array,
 *            hoyde:Float32Array, lokalTime:Uint8Array, manad:Uint8Array,
 *            dagIAar:Int16Array, minuttIAaretTotalt:number}}
 */
export function byggSoltabell(punkt, aar = new Date().getUTCFullYear()) {
    const steg = Math.max(1, Math.round(S.stegMinutt));
    const dagarIAar = (new Date(Date.UTC(aar, 11, 31)).getTime()
                     - new Date(Date.UTC(aar, 0, 1)).getTime()) / 86400000 + 1;
    const minuttTotalt = dagarIAar * MIN_PER_DOGN;

    // Overallokerer, kuttar til rett lengd på slutten.
    const tak = Math.ceil(minuttTotalt / steg);
    const minuttIAar = new Int32Array(tak);
    const asimut = new Float32Array(tak);
    const hoyde = new Float32Array(tak);
    const lokalTime = new Uint8Array(tak);
    const manad = new Uint8Array(tak);
    const dagIAar = new Int16Array(tak);

    const start = Date.UTC(aar, 0, 1, 0, 0, 0);
    let n = 0;

    for (let dag = 0; dag < dagarIAar; dag++) {
        const dognStartMs = start + dag * 86400000;
        // Deklinasjon og tidsjamning: éin gong per døgn (sjå soldagsverdiar).
        const jd = (dognStartMs + 43200000) / 86400000 + 2440587.5; // midt på døgnet
        const t = (jd - 2451545.0) / 36525;
        const { deklinasjonRad, tidsjamningMin } = soldagsverdiar(t);

        const d = new Date(dognStartMs);
        const mnd = d.getUTCMonth();
        const offset = norskUtcOffsetTimar(dognStartMs, aar);

        for (let min = 0; min < MIN_PER_DOGN; min += steg) {
            const p = solposisjonFraDagsverdiar(min, punkt.lat, punkt.lon, deklinasjonRad, tidsjamningMin);
            if (p.hoyde < S.minSolhoydeGrader) continue;

            minuttIAar[n] = dag * MIN_PER_DOGN + min;
            asimut[n] = p.asimut;
            hoyde[n] = p.hoyde;
            lokalTime[n] = Math.floor(((min / 60) + offset) % 24);
            manad[n] = mnd;
            dagIAar[n] = dag;
            n++;
        }
    }

    return {
        aar,
        steg,
        n,
        dagarIAar,
        minuttIAaretTotalt: minuttTotalt,
        minuttIAar: minuttIAar.subarray(0, n),
        asimut: asimut.subarray(0, n),
        hoyde: hoyde.subarray(0, n),
        lokalTime: lokalTime.subarray(0, n),
        manad: manad.subarray(0, n),
        dagIAar: dagIAar.subarray(0, n),
    };
}

// ===========================================================================
// SKYGGEKAST PER TURBIN
// ===========================================================================

/**
 * Rekn teoretisk skyggekast frå éin turbin på brukarens punkt.
 *
 * @param {object} args
 * @param {object} args.soltabell    Frå byggSoltabell()
 * @param {object} args.resultat     Resultatobjekt frå beregnPaaverknad()
 * @param {Uint8Array} [args.unionsmaske] Valfri maske over minutt i året som
 *        alt er dekte av ein annan turbin — hindrar dobbelttelling i
 *        punktsummen når fleire turbinar kastar skugge same minutt.
 * @returns {object|null} null når turbinen er utanfor relevant avstand
 */
export function skyggekastForTurbin({ soltabell, resultat, unionsmaske = null }) {
    const R = resultat.rotorDiameterM / 2;
    const maksAvstand = maksSkyggeavstandM(resultat.rotorDiameterM);

    if (!(resultat.avstandM <= maksAvstand) || !(R > 0)) {
        return null;
    }
    // Utan terrengprofil har me verken navhøgd over havet eller horisont.
    if (!resultat.analysert || !Number.isFinite(resultat.navMoh) || !Number.isFinite(resultat.augeMoh)) {
        return null;
    }

    const d = resultat.avstandM;
    const navMoh = resultat.navMoh;
    const augeMoh = resultat.augeMoh;
    const horisontMoh = resultat.synlegheit.horisontMoh;
    // Kurs frå TURBINEN til punktet — det er den retninga skuggen må gå.
    const kursTilPunkt = (resultat.kurs + 180) % 360;

    const { n, asimut, hoyde, lokalTime, manad, minuttIAar, dagIAar, steg } = soltabell;

    // Kalender: minutt per (månad × lokal time).
    const kalender = new Float64Array(12 * 24);
    const perDag = new Float64Array(soltabell.dagarIAar);
    let minutt = 0;
    let minuttUnikt = 0;
    let forsteDag = -1;
    let sisteDag = -1;

    for (let i = 0; i < n; i++) {
        // Skuggen går motsett veg av sola.
        const skuggeretning = asimut[i] + 180;
        // Vinkelen mellom skuggeretninga og retninga turbin → punkt.
        let delta = (kursTilPunkt - skuggeretning) % 360;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        // Meir enn 90° unna: punktet ligg på solsida av turbinen.
        if (delta > 90 || delta < -90) continue;

        const deltaRad = delta * DEG;
        const tvers = d * Math.sin(deltaRad);
        if (tvers > R || tvers < -R) continue;

        const langs = d * Math.cos(deltaRad);
        if (langs <= 0) continue;

        // Høgda strålen forlèt rotorplanet i.
        const pMoh = augeMoh + langs * Math.tan(hoyde[i] * DEG);
        const dz = pMoh - navMoh;
        if (dz > R || dz < -R) continue;

        const halvbreidd = Math.sqrt(R * R - dz * dz);
        if (tvers > halvbreidd || tvers < -halvbreidd) continue;

        // Terrenget må ikkje stengje for nettopp det punktet på rotoren.
        if (Number.isFinite(horisontMoh) && pMoh <= horisontMoh) continue;

        minutt += steg;
        kalender[manad[i] * 24 + lokalTime[i]] += steg;
        const dag = dagIAar[i];
        perDag[dag] += steg;
        if (forsteDag < 0) forsteDag = dag;
        sisteDag = dag;

        if (unionsmaske) {
            const mi = minuttIAar[i];
            if (unionsmaske[mi] === 0) {
                unionsmaske[mi] = 1;
                minuttUnikt += steg;
            }
        }
    }

    if (minutt === 0) return { ...tomtResultat(soltabell), avstandM: d, maksAvstandM: maksAvstand };

    let maksPerDag = 0;
    let dagarMedSkygge = 0;
    for (let i = 0; i < perDag.length; i++) {
        if (perDag[i] > 0) dagarMedSkygge++;
        if (perDag[i] > maksPerDag) maksPerDag = perDag[i];
    }

    return {
        avstandM: d,
        maksAvstandM: maksAvstand,
        minuttPerAar: minutt,
        timarPerAar: minutt / 60,
        minuttUnikt,
        maksMinuttPerDag: maksPerDag,
        dagarMedSkygge,
        forsteDag,
        sisteDag,
        kalender: Array.from(kalender),
        /**
         * Illustrativt «faktisk»-anslag. IKKJE ein prognose — berre NVE sitt
         * eige forhold mellom dei to tilrådde grensene (8/30) brukt på vårt
         * teoretiske tal, slik at lesaren ser storleiksordenen.
         */
        illustrativtFaktiskTimarPerAar: (minutt / 60) * S.faktiskAndel,
        overGrenseAar: minutt / 60 > S.grenseTimarPerAar,
        overGrenseDag: maksPerDag > S.grenseMinuttPerDag,
    };
}

function tomtResultat(soltabell) {
    return {
        minuttPerAar: 0,
        timarPerAar: 0,
        minuttUnikt: 0,
        maksMinuttPerDag: 0,
        dagarMedSkygge: 0,
        forsteDag: -1,
        sisteDag: -1,
        kalender: new Array(12 * 24).fill(0),
        illustrativtFaktiskTimarPerAar: 0,
        overGrenseAar: false,
        overGrenseDag: false,
        aar: soltabell.aar,
    };
}

/**
 * Rekn skyggekast for alle turbinar i eit resultatsett, og summer opp for
 * punktet.
 *
 * ===========================================================================
 * KVIFOR SUMMEN ER EI UNION, IKKJE EI ADDISJON
 * ===========================================================================
 * Står du i eit anlegg med tjue turbinar, kan fleire av dei kaste skugge på
 * deg i same minutt. Legg ein saman timane per turbin, får ein eit tal som
 * ikkje svarer til noko: «45 timar/år» når du faktisk står i skugge 12 timar.
 * NVE si grense gjeld TIDA punktet er utsett, så me tel kvart minutt ÉIN gong
 * — med ei bitmaske over årets minutt.
 *
 * @param {object[]} resultat  Resultat frå beregnPaaverknad()
 * @param {object} soltabell
 * @returns {{perTurbin:Map<string,object>, samla:object}}
 */
export function skyggekastForAlle(resultat, soltabell) {
    const maske = new Uint8Array(soltabell.minuttIAaretTotalt);
    const perTurbin = new Map();

    const kalender = new Float64Array(12 * 24);
    const perDag = new Float64Array(soltabell.dagarIAar);

    // Nærast først: rekkjefølgja påverkar ikkje unionen, men gjer at
    // «kven bidreg mest»-lista vert stabil.
    const sortert = [...resultat].sort((a, b) => a.avstandM - b.avstandM);

    for (const r of sortert) {
        const s = skyggekastForTurbin({ soltabell, resultat: r, unionsmaske: maske });
        if (s && s.minuttPerAar > 0) {
            perTurbin.set(r.id, s);
            for (let i = 0; i < kalender.length; i++) kalender[i] += s.kalender[i];
        } else if (s) {
            perTurbin.set(r.id, s);
        }
    }

    // Unionen: tel minutta i maska, fordelt på dag.
    let totaltMinutt = 0;
    for (let mi = 0; mi < maske.length; mi++) {
        if (maske[mi]) {
            totaltMinutt++;
            perDag[Math.floor(mi / MIN_PER_DOGN)]++;
        }
    }

    let maksPerDag = 0;
    let dagarMedSkygge = 0;
    for (let i = 0; i < perDag.length; i++) {
        if (perDag[i] > 0) dagarMedSkygge++;
        if (perDag[i] > maksPerDag) maksPerDag = perDag[i];
    }

    const bidragsytarar = [...perTurbin.entries()]
        .filter(([, s]) => s.minuttPerAar > 0)
        .sort((a, b) => b[1].minuttPerAar - a[1].minuttPerAar);

    return {
        perTurbin,
        samla: {
            aar: soltabell.aar,
            turbinarVurderte: perTurbin.size,
            turbinarMedSkygge: bidragsytarar.length,
            minuttPerAar: totaltMinutt,
            timarPerAar: totaltMinutt / 60,
            maksMinuttPerDag: maksPerDag,
            dagarMedSkygge,
            // Kalenderen er SUMMEN over turbinar, ikkje unionen — han skal vise
            // kva tider på året/døgnet risikoen ligg, ikkje eit timetal.
            kalender: Array.from(kalender),
            illustrativtFaktiskTimarPerAar: (totaltMinutt / 60) * S.faktiskAndel,
            overGrenseAar: totaltMinutt / 60 > S.grenseTimarPerAar,
            overGrenseDag: maksPerDag > S.grenseMinuttPerDag,
            sterkasteBidrag: bidragsytarar.slice(0, 5).map(([id, s]) => ({ id, timarPerAar: s.timarPerAar })),
        },
    };
}

/** Månadsnamn til kalendervisinga. */
export const MANADER = ['jan', 'feb', 'mar', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'des'];

/** Dag-i-året → «15. mars». */
export function dagTilDato(dagIAar, aar) {
    if (dagIAar < 0) return null;
    const d = new Date(Date.UTC(aar, 0, 1 + dagIAar));
    return `${d.getUTCDate()}. ${['januar', 'februar', 'mars', 'april', 'mai', 'juni',
        'juli', 'august', 'september', 'oktober', 'november', 'desember'][d.getUTCMonth()]}`;
}
