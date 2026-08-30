/**
 * js/utils/NaerTerreng.js
 *
 * FORTETTING AV TERRENGMESHEN I NÆRFELTET — fleire kompassretningar der auget
 * faktisk ser facettane.
 *
 * ===========================================================================
 * KVA FACETTEN ER, OG KVIFOR EIT KARTESISK RUTENETT IKKJE ER SVARET
 * ===========================================================================
 * `Horizon.js` hentar 72 profilar rett utover og `PanoramaView._byggTerreng()`
 * triangulerer dei til eit radielt vifte-mesh. Facetteringa auget ser nær
 * observatøren kjem frå den ASIMUTALE oppløysinga: 360/72 = 5°, som er ~1/12
 * av eit vanleg synsfelt — og den vinkelen er den SAME uansett avstand.
 *
 * Det er lett (og var utgangspunktet for denne runden) å lese problemet som
 * «strålane glisnar frå kvarandre i meter nær observatøren» og svare med eit
 * kartesisk rutenett på 40–60 m. Rekn etter, og det viser seg å vera feil veg:
 *
 *     avstand   72 strålar (5°)   eit 50 m-rutenett
 *      50 m        4,4 m              50 m     ← rutenettet 11× GROVARE
 *     100 m        8,7 m              50 m     ← 6× grovare
 *     300 m       26   m              50 m     ← 2× grovare
 *     600 m       52   m              50 m     ← om lag likt
 *    1200 m      105   m              50 m     ← her byrjar rutenettet å vinne
 *
 * Eit rutenett vinn altså først BORTANFOR ~600 m — og det er ikkje der auget
 * ser facettar. I nærfeltet, som er heile poenget, ville det gjort biletet
 * verre. Difor fortettar denne modulen ASIMUTALT: same radielle topologi,
 * berre `naerFaktor` gonger fleire retningar.
 *
 * ===========================================================================
 * WCS/GeoTIFF VART VURDERT OG FORKASTA
 * ===========================================================================
 * Kartverket har ei WCS-teneste (`wcs.geonorge.no/skwms1/wcs.hoyde-dtm-nhm-25833`)
 * som gir eit ekte høgderaster. Ho leverer berre `GeoTIFF` — eit binært
 * rasterformat som måtte parsast i rein PHP, sidan delt webhotell korkje har
 * GDAL eller Imagick (TECH_STACK.md). Det er eit stort og skjørt prosjekt for
 * ein gevinst me får billegare her, og det vart difor forkasta. Sjå CLAUDE.md §18.
 *
 * ===========================================================================
 * INGEN NY MODELLFØRESETNAD
 * ===========================================================================
 * Dette er reint GEOMETRI for biletet. Horisonten, siktlinjene, synlegheita og
 * klippeplana kjem framleis frå `Horizon.js` og `ImpactCalculator` på dei 72
 * lange strålane, heilt uendra. Feilar nærfeltet, fell panoramaet tilbake til
 * det gamle 72-stråle-meshen — same graderande fallback som flyfotoet har.
 */

import { CONFIG } from '../config.js';
import { hentProfilar } from '../api.js';
import { destinasjon } from './geo.js';

const P = CONFIG.panorama;

/** Klientside-cache, same grunngjeving som i Horizon.js. @type {Map<string,object>} */
const cache = new Map();

const naa = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function naerNokkel(punkt, faktor, naerAvstandM) {
    return `${punkt.lat.toFixed(5)},${punkt.lon.toFixed(5)},${faktor},${Math.round(naerAvstandM)}`;
}

/** Finst nærfeltet allereie? Styrer om UI-et melder framdrift. */
export function harNaerTerreng(punkt, faktor = P.naerFaktor, naerAvstandM = P.naerAvstandM) {
    return cache.has(naerNokkel(punkt, faktor, naerAvstandM));
}

/** Tøm cachen (brukast av testar). */
export function tomNaerTerrengCache() {
    cache.clear();
}

/**
 * DET FELLES RADIUSRUTENETTET.
 *
 * Alle retningar — både dei lange og dei nye korte — vert samplast om til
 * NØYAKTIG dei same radiane. Det er sjølve grepet som gjer at meshen kan vera
 * eitt samanhengande rutenett utan skøyt: når kvar retning har same tal punkt
 * i same avstandar, er trianguleringa den same løkka som før, berre med fleire
 * retningar. Ingen stitching, ingen hól, ingen dobbelttalking.
 *
 * Tre soner, i denne rekkjefølgja:
 *
 *   1. Serveren si eiga nærsone (15 m mellom punkta ut til 300 m) vert HALDEN
 *      SOM HO ER. Å samplе om der ville berre kaste bort oppløysing me alt har.
 *   2. Frå der og ut til `naerAvstandM`: `steg` meter. Dei lange strålane har
 *      berre ~124 m der (160 punkt fordelt over 20 km), medan dei korte har
 *      60 m frå serveren — så 60 m er den finaste oppløysinga som FINST.
 *   3. Utanfor `naerAvstandM`: dei lange strålane sine eigne radiar, urørte.
 *
 * @param {number[]} coarseRadier Stigande avstandar frå ein lang stråle
 * @param {number} naerAvstandM
 * @param {number} steg
 * @returns {number[]} stigande, unike radiar
 */
export function byggRadier(coarseRadier, naerAvstandM, steg) {
    const inn = coarseRadier
        .filter((d) => Number.isFinite(d) && d >= 0)
        .slice()
        .sort((a, b) => a - b);
    if (inn.length < 2 || !(steg > 0)) return inn;

    const ut = [inn[0]];

    // 1) Behald dei radiane som alt ligg tettare enn `steg`.
    let i = 0;
    while (i + 1 < inn.length
        && inn[i + 1] <= naerAvstandM
        && inn[i + 1] - inn[i] <= steg + 0.5) {
        ut.push(inn[i + 1]);
        i++;
    }

    // 2) Fyll vidare med `steg` fram til nærfeltsgrensa.
    let d = ut[ut.length - 1];
    while (d + steg <= naerAvstandM + 0.5) {
        d += steg;
        ut.push(d);
    }

    // 3) Dei lange strålane sine radiar utanfor. Halvsteget hindrar at det
    //    fyrste av dei landar rett oppå det siste fylte og lagar ein
    //    hårtynn ring.
    for (const c of inn) {
        if (c > d + steg * 0.5) ut.push(c);
    }

    return ut;
}

/**
 * Sampl ein profil om til gitte radiar, lineært i avstand.
 *
 * Returnerer `null` for radiar profilen ikkje rekk ut til — dei vert fylte
 * asimutalt frå naboretningane etterpå.
 *
 * @param {Array<{d:number,z:number,terreng:?string}>} profil
 * @param {number[]} radier
 * @param {number} [maksD] Ikkje sampl lenger ut enn dette
 * @returns {Array<{z:number, terreng:?string}|null>}
 */
export function resamplProfil(profil, radier, maksD = Infinity) {
    const ut = new Array(radier.length).fill(null);
    if (!Array.isArray(profil) || profil.length < 2) return ut;

    const siste = profil[profil.length - 1].d;
    const tak = Math.min(maksD, siste);

    let k = 0;
    for (let j = 0; j < radier.length; j++) {
        const d = radier[j];
        if (d > tak + 0.5) break;

        while (k + 1 < profil.length && profil[k + 1].d < d) k++;
        const a = profil[k];
        const b = profil[Math.min(k + 1, profil.length - 1)];
        const spenn = b.d - a.d;
        const w = spenn > 0 ? Math.min(1, Math.max(0, (d - a.d) / spenn)) : 0;

        ut[j] = {
            z: a.z + (b.z - a.z) * w,
            // Terrengtype er kategorisk og kan ikkje interpolerast — nærmaste
            // sample er det einaste forsvarlege.
            terreng: w < 0.5 ? a.terreng : b.terreng,
        };
    }
    return ut;
}

/**
 * KODAR I `har`-tabellen. Rekkjefølgja er ei prioritering, ikkje berre merkelappar.
 *
 * KORT (1) og LANG (3) er begge ekte målingar — skilnaden er RADIELL
 * oppløysing: ein kort stråle har 60 m mellom punkta i bandet 300–1 200 m,
 * ein lang har ~124 m (160 punkt fordelt over 20 km). Sjå `fyllRing()` for
 * kvifor den skilnaden ikkje kan få stå side om side i same ring.
 */
const UKJEND = 0;
const KORT = 1;
const INTERPOLERT = 2;
const LANG = 3;

/**
 * FYLL EIN RADIUSRING ASIMUTALT — OG HANDHEV AT HEILE RINGEN ER SAMPLA LIKT.
 *
 * ===========================================================================
 * SAGTANNA: EIN RING MÅ HA ÉI OPPLØYSING, IKKJE TO
 * ===========================================================================
 * Fyrste utgåva sparte 72 henteoperasjonar ved å la dei lange strålane dekkje
 * «sine eigne» asimutar heilt inn, og berre hente korte strålar for dei 144
 * nye retningane. Det er tilsynelatande gratis — det er jo ekte data begge
 * stader — men det gav ein tydeleg SAGTANN langs silhuetten i nærfeltet, med
 * periode på nøyaktig tre retningar.
 *
 * Grunnen: i bandet 300–1 200 m har ein kort stråle eit ekte målepunkt kvar
 * 60. meter, medan ein lang stråle må interpolerast mellom punkt som ligg
 * ~124 m frå kvarandre. Kvar tredje retning var altså RADIELT GLATTA medan
 * naboane var skarpe. Der terrenget har relieff på den skalaen — som ein
 * skrånande rygg nær observatøren har — les auget den systematiske skilnaden
 * som ei sagtann, ikkje som detalj.
 *
 * Lærdomen er generell: i eit regulært mesh er det UNIFORMITETEN som avgjer
 * korleis flata les, ikkje kor god kvar enkelt verdi er. Ei ring der to av
 * tre hjørne er skarpe og det tredje er glatta, ser verre ut enn ei ring der
 * alle tre er glatta.
 *
 * Difor: innanfor nærfeltet tel berre KORT som kjent. Manglar ein kort stråle
 * (batchen feila), vert retninga heller interpolert frå naboane 1,67° unna
 * enn å bruke sin eigen, grovare lange stråle. Er det ingen korte i ringen i
 * det heile, fell me tilbake til dei lange — men då er HEILE ringen lang, og
 * uniformiteten er i behald.
 *
 * @returns {boolean} false om heile ringen mangla data
 */
function fyllRing(z, har, terreng, nF, nRad, j, naerRing) {
    let kjende = [];
    if (naerRing) {
        for (let i = 0; i < nF; i++) if (har[i * nRad + j] === KORT) kjende.push(i);
    }
    if (kjende.length === 0) {
        kjende = [];
        for (let i = 0; i < nF; i++) {
            const k = har[i * nRad + j];
            if (k === KORT || k === LANG) kjende.push(i);
        }
    }
    if (kjende.length === 0) return false;
    if (kjende.length === nF) return true;

    for (let a = 0; a < kjende.length; a++) {
        const i0 = kjende[a];
        const i1 = kjende[(a + 1) % kjende.length];
        // Sirkulært steg. Er det berre éin kjend retning, går løkka heile
        // vegen rundt og gir ein konstant ring — rett svar i det tilfellet.
        let steg = (i1 - i0 + nF) % nF;
        if (steg === 0) steg = nF;

        const z0 = z[i0 * nRad + j];
        const z1 = z[i1 * nRad + j];
        for (let s = 1; s < steg; s++) {
            const i = (i0 + s) % nF;
            const w = s / steg;
            const n = i * nRad + j;
            z[n] = z0 + (z1 - z0) * w;
            terreng[n] = w < 0.5 ? terreng[i0 * nRad + j] : terreng[i1 * nRad + j];
            har[n] = INTERPOLERT;
        }
    }
    return true;
}

/**
 * GLATT DEI INNARSTE RINGANE SIRKULÆRT — ikkje pynt, men eit tak på kor fin
 * meshen har LOV til å bli.
 *
 * ===========================================================================
 * KVIFOR DETTE MÅ GJERAST, OG KVIFOR DET FYRST DUKKA OPP NO
 * ===========================================================================
 * Fortettinga frå 72 til 216 retningar gjorde mesteparten av biletet betre,
 * men gjorde bakken RETT VED FØTENE verre: der kom det ei hakkete
 * okklusjonskant der det før var ei glatt kurve. Raycasting gjennom nettopp
 * dei pikslane viste kvifor — flata er terreng 3–36 m unna, og kanten er
 * ryggen i 15 m som skjuler alt ut til 33 m.
 *
 * På den avstanden er forstørringa brutal. Éin meter terrenghøgd 15 m unna er
 * 3,8° synsvinkel; same meteren 500 m unna er 0,11°. Det er nøyaktig same
 * D/d-forsterking som CLAUDE.md §7a skildrar for siktlinjer, og som appen
 * allereie åtvarar brukaren om med `naerskjerming`-flagget.
 *
 * Samtidig ligg 216 strålar berre 0,44 m frå kvarandre på 15 m avstand. Det
 * er finare enn den horisontale oppløysinga terrengmodellen har. Meshen
 * teiknar der ikkje lenger terreng, men modellens eiga uvisse — forstørra
 * til fleire grader. Dei 72 gamle strålane trefte aldri dette, fordi dei låg
 * 4 m frå kvarandre alt på 46 m avstand; problemet er ein FØLGJE av
 * fortettinga og må difor løysast saman med henne.
 *
 * Reglen er den same ein bruker på alle rutenett: ikkje sampl finare enn
 * data har støtte for. Kvar ring vert glatta til `minStegM` effektiv
 * asimutal oppløysing, og glattinga er ein nulloperasjon så snart ringen er
 * vid nok — her frå ~46 m og utover.
 *
 * MERK at dette berre gjeld BILETET. Horisont, siktlinjer og synlegheit vert
 * framleis rekna på dei rå profilane i `ImpactCalculator`/`Horizon`, som
 * ikkje ser denne funksjonen i det heile.
 */
function glattInnarsteRingar(z, nF, nRad, radier, minStegM) {
    if (!(minStegM > 0)) return 0;
    let glatta = 0;
    const buffer = new Float64Array(nF);

    for (let j = 0; j < nRad; j++) {
        const d = radier[j];
        if (!(d > 0)) continue;

        // Kor mange strålar må slåast saman for å nå `minStegM` boglengd?
        const steg = (2 * Math.PI * d) / nF;
        let k = Math.round(minStegM / steg);
        if (k < 3) continue;                       // ringen er alt vid nok
        if (k % 2 === 0) k += 1;                   // symmetrisk vindauge
        k = Math.min(k, Math.max(3, Math.floor(nF / 8)));

        const halv = (k - 1) / 2;
        for (let i = 0; i < nF; i++) {
            let sum = 0;
            for (let o = -halv; o <= halv; o++) {
                sum += z[(((i + o) % nF + nF) % nF) * nRad + j];
            }
            buffer[i] = sum / k;
        }
        for (let i = 0; i < nF; i++) z[i * nRad + j] = buffer[i];
        glatta++;
    }
    return glatta;
}

/**
 * Hent nærfeltet og bygg det felles retningsrutenettet for terrengmeshen.
 *
 * @param {object} args
 * @param {{lat:number, lon:number, hoyde:number}} args.punkt
 * @param {object} args.horisont Frå hentHorisont()
 * @param {number} [args.faktor]
 * @param {number} [args.naerAvstandM]
 * @param {AbortSignal} [args.signal]
 * @param {(ferdig:number, totalt:number) => void} [args.paaFramdrift]
 * @returns {Promise<object|null>} null ⇒ bruk dei 72 lange strålane som før
 */
export async function hentNaerTerreng({
    punkt,
    horisont,
    faktor = P.naerFaktor,
    naerAvstandM = P.naerAvstandM,
    signal,
    paaFramdrift,
}) {
    if (!horisont || !(faktor > 1)) return null;

    const nokkel = naerNokkel(punkt, faktor, naerAvstandM);
    const treff = cache.get(nokkel);
    if (treff) return treff;

    const start = naa();

    // --- Radiusmalen frå dei lange strålane -----------------------------
    const medProfil = horisont.retningar.filter((r) => Array.isArray(r.profil) && r.profil.length >= 3);
    if (medProfil.length === 0) return null;

    // Alle lange strålar går like langt ⇒ same sampling. Den kortaste
    // avgjer likevel, slik at kvar radius finst i alle.
    const nRadC = Math.min(...medProfil.map((r) => r.profil.length));
    const coarseRadier = medProfil[0].profil.slice(0, nRadC).map((p) => p.d);
    const ytterst = coarseRadier[coarseRadier.length - 1];

    // Nærfeltet må liggje godt innanfor dei lange strålane, elles finst det
    // ikkje noko fjernfelt å interpolere mot.
    const naer = Math.min(naerAvstandM, ytterst * 0.5);
    const radier = byggRadier(coarseRadier, naer, P.naerStegM);
    const nRad = radier.length;

    const nC = horisont.talRetningar;
    const nF = nC * faktor;

    // --- Målpunkt for nærfeltet -----------------------------------------
    // ALLE nF retningane får ein kort stråle — også dei som fell saman med
    // ein lang. Det ser ut som sløsing (den lange dekkjer jo strekninga
    // allereie), men det er nettopp det som fjernar sagtanna: sjå
    // `fyllRing()`. Prisen er 72 ekstra korte profilar; gevinsten er at kvar
    // ring har éi og same radielle oppløysing heile vegen rundt.
    const mal = [];
    for (let i = 0; i < nF; i++) {
        const azimut = (i * 360) / nF;
        const [lat, lon] = destinasjon(punkt.lat, punkt.lon, azimut, naer);
        mal.push({ id: `nf${i}`, lat, lon, indeks: i, azimut });
    }

    // --- Hent i batchar, med avgrensa parallellitet ----------------------
    // Profilane her er korte (~36 punkt mot ~180 for dei lange), så fleire
    // samtidige kall kostar Kartverket mindre enn eit tilsvarande tal lange.
    const batchar = [];
    for (let i = 0; i < mal.length; i += P.naerBatchStorleik) {
        batchar.push(mal.slice(i, i + P.naerBatchStorleik));
    }

    const profilar = new Map();
    let ferdige = 0;
    let feila = 0;

    const koyrBatch = async (batch) => {
        try {
            const svar = await hentProfilar(
                { lat: punkt.lat, lon: punkt.lon },
                batch.map((m) => ({ id: m.id, lat: m.lat, lon: m.lon })),
                signal,
            );
            for (const m of batch) {
                const p = svar.profiles?.[m.id];
                if (Array.isArray(p) && p.length >= 3) profilar.set(m.indeks, p);
                else feila++;
            }
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            // Ein feilande batch skal ikkje velte panoramaet — dei retningane
            // vert interpolerte frå naboane, som er dagens oppførsel uansett.
            feila += batch.length;
            console.warn('Nærfelt-batch feila, held fram:', e.message);
        }
        ferdige += batch.length;
        paaFramdrift?.(ferdige, mal.length);
    };

    const kø = [...batchar];
    await Promise.all(Array.from(
        { length: Math.min(P.naerSamtidigeKall, kø.length) },
        async () => {
            while (kø.length > 0) {
                if (signal?.aborted) throw new DOMException('Avbrote', 'AbortError');
                const b = kø.shift();
                if (b) await koyrBatch(b);
            }
        },
    ));

    // Kom det ingenting i det heile, er det betre å bruke det gamle meshen enn
    // eit tettare mesh utan ny informasjon i seg.
    if (profilar.size === 0) return null;

    // --- Legg alt inn i eitt (retning × radius)-rutenett ------------------
    const z = new Float64Array(nF * nRad);
    const har = new Uint8Array(nF * nRad);
    const terreng = new Array(nF * nRad).fill(null);

    const settRad = (i, prover, kode) => {
        for (let j = 0; j < nRad; j++) {
            const v = prover[j];
            if (!v || !Number.isFinite(v.z)) continue;
            const n = i * nRad + j;
            z[n] = v.z;
            terreng[n] = v.terreng ?? null;
            har[n] = kode;
        }
    };

    // Lange strålar først: dei dekkjer heile radiusspennet, og er einaste
    // kjelde utanfor nærfeltet.
    for (let i = 0; i < nF; i += faktor) {
        const lang = horisont.retningar[i / faktor];
        if (lang?.profil) settRad(i, resamplProfil(lang.profil, radier), LANG);
    }
    // Korte strålar over: dei har finare radiell oppløysing i nærfeltet og
    // skal difor vinne der dei to overlappar.
    for (const [i, profil] of profilar) {
        settRad(i, resamplProfil(profil, radier, naer), KORT);
    }

    let tommeRingar = 0;
    for (let j = 0; j < nRad; j++) {
        if (!fyllRing(z, har, terreng, nF, nRad, j, radier[j] <= naer + 0.5)) tommeRingar++;
    }
    if (tommeRingar > 0) return null;   // for hòlete til å teikne trygt

    const glattaRingar = glattInnarsteRingar(z, nF, nRad, radier, P.naerMinAsimutStegM);

    // --- Bygg retningsobjekta meshen konsumerer --------------------------
    // lat/lon vert rekna frå (asimut, avstand) i staden for å arvast frå
    // profilane. Det gjer at ALLE hjørne — henta som interpolerte — kjem frå
    // éin og same formel, slik at flyfoto-UV-ane ikkje kan hoppe i skøyten
    // mellom ein ekte og ein interpolert stråle.
    const retningar = new Array(nF);
    for (let i = 0; i < nF; i++) {
        const azimut = (i * 360) / nF;
        const profil = new Array(nRad);
        for (let j = 0; j < nRad; j++) {
            const d = radier[j];
            const [lat, lon] = d > 0
                ? destinasjon(punkt.lat, punkt.lon, azimut, d)
                : [punkt.lat, punkt.lon];
            const n = i * nRad + j;
            profil[j] = { d, z: z[n], lat, lon, terreng: terreng[n] };
        }
        retningar[i] = {
            indeks: i,
            azimut,
            profil,
            /** true når retninga har ein eigen kort stråle i nærfeltet. */
            ekte: profilar.has(i),
        };
    }

    const ut = {
        retningar,
        talRetningar: nF,
        talLange: nC,
        faktor,
        naerAvstandM: naer,
        radier,
        talEkstra: mal.length,
        glattaRingar,
        feila,
        hentaMs: Math.round(naa() - start),
    };

    cache.set(nokkel, ut);
    return ut;
}
