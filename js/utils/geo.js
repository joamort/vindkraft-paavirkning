/**
 * js/utils/geo.js
 *
 * Rein geometri og matematikk — ingen DOM, ingen nettverk, ingen tilstand.
 * Alt her er reine funksjonar, slik at dei kan resonnerast om og testast
 * isolert.
 */

import { CONFIG } from '../config.js';

const R = CONFIG.sikt.jordradiusM;
const DEG = Math.PI / 180;

/**
 * Storsirkelavstand mellom to WGS84-punkt, i meter.
 *
 * @param {number} lat1 @param {number} lon1
 * @param {number} lat2 @param {number} lon2
 * @returns {number} meter
 */
export function haversine(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * DEG;
    const p2 = lat2 * DEG;
    const dp = (lat2 - lat1) * DEG;
    const dl = (lon2 - lon1) * DEG;

    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Initiell kompasskurs frå punkt 1 til punkt 2, i grader (0 = nord, 90 = aust).
 *
 * @returns {number} 0–360
 */
export function bearing(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * DEG;
    const p2 = lat2 * DEG;
    const dl = (lon2 - lon1) * DEG;

    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(y, x) / DEG + 360) % 360;
}

/** Kompasskurs som norsk himmelretning, t.d. "nordaust". */
export function kompassretning(grader) {
    const navn = ['nord', 'nordaust', 'aust', 'søraust', 'sør', 'sørvest', 'vest', 'nordvest'];
    return navn[Math.round(((grader % 360) + 360) % 360 / 45) % 8];
}

/** Effektiv jordradius: den verkelege radien blåst opp for standardrefraksjon. */
const R_EFF = R * CONFIG.sikt.refraksjonsfaktor;

/**
 * Jordkrumming + atmosfærisk refraksjon: kor mykje den RETTE siktlinja mellom
 * observatør (d = 0) og mål (d = D) fell under den lineære interpolasjonen
 * mellom endepunkta sine høgder over havet, målt ved avstand `d`.
 *
 * fall ≈ d · (D − d) / (2 · R_eff),  R_eff = 7/6 · R
 *
 * Uttrykket er null i begge endane og maksimalt på midten — nettopp fordi det
 * er definert relativt til korda mellom dei to endepunkta, ikkje til horisonten.
 * For ein turbin 20 km unna er fallet på midten 6,7 m.
 *
 * ===========================================================================
 * KVA STORLEIKEN ER FALL PÅ — og kvifor den skilnaden avgjer forteiknet
 * ===========================================================================
 * Høgder her er meter over havet, altså over ei KRUM flate. I det
 * koordinatsystemet går ikkje ein rett lysstråle vassrett: han stig bort frå
 * datumet. Ein stråle frå auget til turbintoppen ligg difor LÅGARE over havet
 * midtvegs enn ei rett linje mellom dei to høgdetala skulle tilseie — nettopp
 * `krummingsfall` lågare.
 *
 * Terrenget derimot ligg der det ligg. Samanlikninga vert difor
 *
 *     terreng  vs.  lineær interpolasjon − krummingsfall
 *
 * eller like godt, flytta over på venstre side:
 *
 *     terreng + krummingsfall  vs.  lineær interpolasjon
 *
 * Det er lett å snu dette til `terreng − krummingsfall` (og «senke terrenget
 * som fell bort bak krumminga»), men det er feil veg: då forsvinn ikkje berre
 * korreksjonen, ho vert negativ. Sjå `terrengHelning()` for kontrollen mot
 * eksakt sfærisk geometri.
 *
 * @param {number} d Avstand frå observatør (m)
 * @param {number} D Total avstand til målet (m)
 * @returns {number} meter
 */
export function krummingsfall(d, D) {
    if (d <= 0 || d >= D) return 0;
    return (d * (D - d)) / (2 * R_EFF);
}

/**
 * Kor mykje eit punkt i avstand `d` fell under auget sitt VASSRETTE plan,
 * berre på grunn av krumming og refraksjon.
 *
 *     fall(d) = d² / (2 · R_eff)
 *
 * Dette er same fysikk som `krummingsfall()`, men målt mot horisontalplanet i
 * staden for mot korda til eit bestemt mål — og difor uavhengig av kvar målet
 * står. Det er den forma ein treng når spørsmålet ikkje er «ser eg DENNE
 * turbinen», men «kor høgt over horisonten ligg terrenget i DENNE retninga»,
 * slik 360°-panoramaet spør.
 *
 * @param {number} d meter
 * @returns {number} meter
 */
export function horisontfall(d) {
    return (d * d) / (2 * R_EFF);
}

/**
 * Helninga (tangens av høgdevinkelen) frå auget opp til eit terrengpunkt.
 *
 *     helning(d) = [(z − fall(d)) − z_auge] / d
 *
 * ===========================================================================
 * KONTROLLERT MOT EKSAKT SFÆRISK GEOMETRI
 * ===========================================================================
 * Formelen er ei småvinkel-tilnærming, men ei svært god ein. Held ein han opp
 * mot den eksakte tangentstrålen frå eit auge 1,6 m over ei kule med radius
 * R_eff (altså «kor høgt over havet ligg horisonten i avstand D»), stemmer dei
 * på under ein centimeter:
 *
 *     D        eksakt      denne formelen
 *      5 km      0,00 m       0,00 m
 *     10 km      1,77 m       1,77 m
 *     20 km     15,38 m      15,38 m
 *     30 km     42,46 m      42,46 m
 *
 * Horisontavstanden for eit auge i 1,6 m vert 4 877 m, som er nøyaktig
 * √(2·R_eff·h). Det er denne kontrollen som avgjorde forteiknet i
 * `krummingsfall()` — sjå testsuiten §1.
 *
 * @param {number} d       Horisontal avstand frå auget (m)
 * @param {number} z       Terrenghøgd i punktet (moh.)
 * @param {number} augeMoh Observatørens augehøgd (moh.)
 * @returns {number} helning (dimensjonslaus; tan av høgdevinkelen)
 */
export function terrengHelning(d, z, augeMoh) {
    if (d <= 0) return 0;
    return ((z - horisontfall(d)) - augeMoh) / d;
}

/**
 * TERRENGHORISONTEN I ÉI RETNING — «høgaste skrapelinje».
 *
 * Går gjennom ein terrengprofil og finn den brattaste strålen frå auget som
 * så vidt skrapar eit terrengpunkt. Alt som ligg under den strålen er skjult
 * bak terrenget; alt over er synleg.
 *
 * Funksjonen returnerer HELNINGA, ikkje ei høgd. Det er med vilje: helninga er
 * ein eigenskap ved terrenget mellom auget og retninga, uavhengig av kor langt
 * unna det ein spør om står. Same horisont gjeld difor for ein turbin 4 km
 * unna, for eit lyspunkt 200 m over bakken der, og for panoramaet sin
 * silhuett — ein einaste storleik, rekna éin gong.
 *
 * `horisontMohVedAvstand()` gjer helninga om til ei høgd der ein treng det.
 *
 * @param {Array<{d:number, z:number}>} profil
 * @param {number} augeMoh
 * @param {object} [opts]
 * @param {number} [opts.minAvstandM] Punkt nærare enn dette vert ignorerte
 *                                    (sjå CONFIG.sikt.minHindringsavstandM).
 * @param {number} [opts.maksAvstandM] Punkt lenger ute enn dette vert ignorerte.
 * @returns {{helning:number, kritiskPunkt:object|null}}
 */
export function skannHorisont(profil, augeMoh, opts = {}) {
    const min = opts.minAvstandM ?? CONFIG.sikt.minHindringsavstandM;
    const maks = opts.maksAvstandM ?? Infinity;

    let helning = -Infinity;
    let kritiskPunkt = null;

    for (const p of profil ?? []) {
        if (p.d < min || p.d >= maks) continue;
        const h = terrengHelning(p.d, p.z, augeMoh);
        if (h > helning) {
            helning = h;
            kritiskPunkt = p;
        }
    }

    // Fann me ingenting (svært kort avstand, alle punkta filtrerte bort), er
    // horisonten auget sitt eige vassrette plan.
    return { helning: Number.isFinite(helning) ? helning : 0, kritiskPunkt };
}

/**
 * KVAR KUNNE EIT HINDER STÅ OG BETY NOKO? — topp-K-kandidatar.
 *
 * ===========================================================================
 * KVIFOR EI ANNA RANGERING ENN `skannHorisont()`
 * ===========================================================================
 * `skannHorisont()` svarer på «kva punkt SKRAPAR høgast med bar bakke».
 * DOM-kryssjekken (SurfaceCheck.js) spør om noko anna: «kvar ville eit hinder
 * som IKKJE står i terrengmodellen — ein granskog, eit hustak — heve
 * horisonten mest?»
 *
 * Dei to spørsmåla har ulikt svar, og skilnaden er nærfeltet. Legg ein eit
 * tenkt hinder på `H` meter på kvart profilpunkt, vert helninga
 *
 *     helning_H(d) = terrengHelning(d, z + H, augeMoh) = terrengHelning(d, z, augeMoh) + H/d
 *
 * Tillegget `H/d` er 0,67 for eit punkt 30 m unna og 0,004 for eitt 5 km unna
 * — ein faktor 170. Eit terrengpunkt som ligg langt under den bare
 * skrapelinja kan difor bli det som avgjer alt, berre det står nær nok.
 * Nettopp det skjedde på Odal: 18,2 m skog 90 m frå observatøren skjulte ein
 * turbin 1,34 km unna som var 82 % synleg på bar bakke.
 *
 * ===========================================================================
 * RANGERINGA ER EI ØVRE GRENSE, OG DET GJER RESTEN MÅLBAR
 * ===========================================================================
 * Den verkelege overflatehøgda er ukjend før oppslaget, men er avgrensa:
 * `z_dom ≤ z + H` for eit hinder på høgst `H`. `helning_H` er difor ei ØVRE
 * GRENSE for kva kvart punkt kan bidra med, og dei K høgaste er nøyaktig dei
 * K punkta der eit hinder kan flytte horisonten mest.
 *
 * Difor returnerer funksjonen òg `restHelning`: den høgaste grensa blant
 * punkta som IKKJE vart valde. Etter at dei K er slått opp, er det den —
 * ikkje «noko ukjent» — som er att av uvissa, og ho kan skrivast som eit tal
 * i UI i staden for eit atterhald i ord.
 *
 * `minSkilnadM` finst fordi profilen er sampla kvar 15. meter i dei fyrste
 * 300 m: dei tre høgaste punkta ville elles vore tre nabopunkt på same
 * knaus, altså tre oppslag i praktisk talt same tre.
 *
 * @param {Array<{d:number, z:number}>} profil
 * @param {number} augeMoh
 * @param {number} k                       Kor mange kandidatar
 * @param {object} [opts]
 * @param {number} [opts.hinderM]          Tenkt hinderhøgd (m)
 * @param {number} [opts.minSkilnadM]      Minste avstand mellom to kandidatar (m)
 * @param {number} [opts.minAvstandM]
 * @param {number} [opts.maksAvstandM]
 * @returns {{kandidatar: Array<{punkt:object, helning:number}>, restHelning:number}}
 */
export function skannHorisontTopK(profil, augeMoh, k = 3, opts = {}) {
    const min = opts.minAvstandM ?? CONFIG.sikt.minHindringsavstandM;
    const maks = opts.maksAvstandM ?? Infinity;
    const hinder = opts.hinderM ?? 20;
    const skilnad = opts.minSkilnadM ?? 0;

    const rangert = [];
    for (const p of profil ?? []) {
        if (p.d < min || p.d >= maks) continue;
        rangert.push({ punkt: p, helning: terrengHelning(p.d, p.z + hinder, augeMoh) });
    }
    rangert.sort((a, b) => b.helning - a.helning);

    const kandidatar = [];
    let restHelning = -Infinity;
    for (const c of rangert) {
        const forNaer = kandidatar.some((v) => Math.abs(v.punkt.d - c.punkt.d) < skilnad);
        if (kandidatar.length < k && !forNaer) {
            kandidatar.push(c);
        } else if (c.helning > restHelning) {
            // Alt som ikkje vart valt — anten fordi lista er full eller fordi
            // det står for tett på ein alt vald kandidat — er det som er att
            // av uvissa etter oppslaget.
            restHelning = c.helning;
        }
    }

    return { kandidatar, restHelning: Number.isFinite(restHelning) ? restHelning : -Infinity };
}

/**
 * Høgda over havet terrenghorisonten når i ein gitt avstand.
 *
 *     h(D) = z_auge + helning · D + fall(D)
 *
 * Fall-leddet kjem tilbake her fordi svaret skal uttrykkjast i moh. igjen.
 * Uttrykket er algebraisk identisk med den gamle skrapelinje-forma
 * `z_auge + (z + krummingsfall(d,D) − z_auge) · (D/d)`, berre skrive slik at
 * terrengdelen kan reknast éin gong og brukast om att.
 *
 * @param {number} helning Frå skannHorisont()
 * @param {number} augeMoh
 * @param {number} D       Avstand (m)
 * @returns {number} moh.
 */
export function horisontMohVedAvstand(helning, augeMoh, D) {
    return augeMoh + helning * D + horisontfall(D);
}

/**
 * Høgda på siktlinja mellom to punkt, ved avstand `d`.
 *
 * @param {number} d      Avstand frå observatør (m)
 * @param {number} D      Total avstand (m)
 * @param {number} zStart Høgd ved observatør (moh.)
 * @param {number} zSlutt Høgd ved målet (moh.)
 */
export function siktlinjeHoyde(d, D, zStart, zSlutt) {
    if (D <= 0) return zStart;
    return zStart + (zSlutt - zStart) * (d / D);
}

/**
 * Vertikal synsvinkel eit objekt tek opp i synsfeltet, i grader.
 *
 * Rekna som differansen mellom vinkelen til toppen og vinkelen til botnen —
 * ikkje som atan(høgd/avstand), som berre stemmer når observatøren står i
 * same høgd som objektets fot.
 *
 * @param {number} zTopp   Høgd på objektets topp (moh.)
 * @param {number} zBotn   Høgd på objektets fot (moh.)
 * @param {number} zAuge   Observatørens augehøgd (moh.)
 * @param {number} avstand Horisontal avstand (m)
 * @returns {number} grader
 */
export function synsvinkel(zTopp, zBotn, zAuge, avstand) {
    if (avstand <= 0) return 90;
    const vinkelTopp = Math.atan((zTopp - zAuge) / avstand);
    const vinkelBotn = Math.atan((zBotn - zAuge) / avstand);
    return (vinkelTopp - vinkelBotn) / DEG;
}

/**
 * Kategoriser visuell dominans ut frå avstand målt i rotordiameter.
 * Sjå CONFIG.dominans for tersklane og atterhaldet som følgjer dei.
 *
 * @param {number} avstandM        Avstand til turbinen (m)
 * @param {number} rotordiameterM  Rotordiameter (m)
 */
export function dominanskategori(avstandM, rotordiameterM) {
    const rd = rotordiameterM > 0 ? avstandM / rotordiameterM : Infinity;
    const treff = CONFIG.dominans.find((k) => rd < k.maksRd) ?? CONFIG.dominans[CONFIG.dominans.length - 1];
    return { ...treff, rd };
}

/**
 * Punkt på ein storsirkel gitt startpunkt, kurs og avstand.
 * Brukast til å teikne radius-sirkelen rundt brukarpunktet.
 */
export function destinasjon(lat, lon, kursGrader, avstandM) {
    const d = avstandM / R;
    const b = kursGrader * DEG;
    const p1 = lat * DEG;
    const l1 = lon * DEG;

    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(
        Math.sin(b) * Math.sin(d) * Math.cos(p1),
        Math.cos(d) - Math.sin(p1) * Math.sin(p2),
    );

    return [p2 / DEG, ((l2 / DEG + 540) % 360) - 180];
}

/**
 * Energetisk summering av lydnivå: 10·log₁₀(Σ 10^(Lᵢ/10)).
 *
 * Lydnivå i desibel er logaritmiske og kan ikkje leggjast saman direkte —
 * to like kjelder gir +3 dB, ikkje dobbelt tal.
 *
 * @param {number[]} nivaaer dB-verdiar
 * @returns {number|null} null om lista er tom
 */
export function summerDesibel(nivaaer) {
    const gyldige = nivaaer.filter((n) => Number.isFinite(n));
    if (gyldige.length === 0) return null;
    const sum = gyldige.reduce((acc, n) => acc + 10 ** (n / 10), 0);
    return sum > 0 ? 10 * Math.log10(sum) : null;
}
