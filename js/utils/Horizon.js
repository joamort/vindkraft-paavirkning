/**
 * js/utils/Horizon.js
 *
 * 360°-terrenghorisont frå brukarens punkt — grunnlaget for 3D-panoramaet.
 *
 * ===========================================================================
 * KVA DETTE ER, OG KVA DET IKKJE ER
 * ===========================================================================
 * ImpactCalculator spør terrenget «kor høgt ligg horisonten i retning DENNE
 * turbinen». Denne modulen stiller nøyaktig same spørsmål, men i eit jamt
 * rutenett av kompassretningar i staden for berre der det tilfeldigvis står
 * ein turbin. Sjølve skanninga er ikkje kopiert hit: begge kallar
 * `skannHorisont()` i geo.js. Det er heile poenget — panoramaet kan ikkje
 * hamne i utakt med panelet, fordi dei reknar med same funksjon på same data.
 *
 * ===========================================================================
 * KVIFOR HORISONTEN ER EI HELNING OG IKKJE EI HØGD
 * ===========================================================================
 * Ei høgd over havet må lesast av i ein bestemt avstand: «horisonten er 640
 * moh.» er meiningslaust utan «... 12 km unna». Helninga derimot — tangens av
 * høgdevinkelen frå auget — er ein eigenskap ved terrenget i retninga, og er
 * det panoramaet faktisk treng: kor høgt over augehøgde silhuetten ligg når du
 * snur deg den vegen.
 *
 * Det er òg storleiken som lèt seg samanlikne på tvers: helninga denne modulen
 * finn i retning 213°, og helninga ImpactCalculator fann for ein turbin som
 * står i 213°, skal vera det same talet. Testsuiten §11 sjekkar nettopp det.
 *
 * ===========================================================================
 * PROFILANE VERT TEKNE VARE PÅ
 * ===========================================================================
 * Me hentar 72 × ~180 terrengpunkt for å finne 72 tal. Det ville vore sløsing
 * å kaste resten: dei same punkta er eit ferdig radielt rutenett over
 * landskapet, og panoramaet byggjer eit ekte terrengmesh av dei i staden for
 * berre ein silhuett. Sjå PanoramaView._byggTerreng().
 */

import { CONFIG } from '../config.js';
import { hentProfilar } from '../api.js';
import { destinasjon, skannHorisont, horisontfall } from './geo.js';

const P = CONFIG.panorama;
const DEG = Math.PI / 180;

/**
 * Klientside-cache, nøkla på punkt + oppløysing.
 *
 * Terrenget endrar seg aldri, og eit panorama som opnast, lukkast og opnast
 * att skal ikkje koste 34 nye WPS-kall. Serveren har sin eigen permanente
 * fil-cache under, men den sparer berre Kartverket — ikkje rundturen.
 *
 * @type {Map<string, object>}
 */
const cache = new Map();

/** Cache-nøkkel. 5 desimalar ≈ 1 m, altså same punkt for alle praktiske føremål. */
export function horisontNokkel(punkt, maksAvstandM, talRetningar) {
    return `${punkt.lat.toFixed(5)},${punkt.lon.toFixed(5)}`
         + `,${Math.round(maksAvstandM)},${talRetningar}`;
}

/** Finst horisonten allereie for dette punktet? Styrer om UI-et viser framdrift. */
export function harHorisont(punkt, maksAvstandM = P.maksAvstandM, talRetningar = P.talRetningar) {
    return cache.has(horisontNokkel(punkt, maksAvstandM, talRetningar));
}

/** Tøm cachen (brukast av testar). */
export function tomHorisontCache() {
    cache.clear();
}

/**
 * HORISONTEN OVER OPE HAV, som fallback.
 *
 * Fell ein heil retning ut — måljpunktet hamna utanfor Noreg-bboxen til
 * proxyen, eller batchen feila — må silhuetten framleis lukke seg rundt heile
 * kompasset. Naboane er nesten alltid rette svaret, men om det ikkje finst
 * naboar heller, er sjøhorisonten den einaste forsvarlege verdien.
 *
 * For eit auge i høgda H over havflata er horisontavstanden √(2·R_eff·H), og
 * helninga dit ned vert
 *
 *     α = −H/√(2R_eff·H) − √(2R_eff·H)/(2R_eff) = −√(2H/R_eff)
 *
 * altså −6,6·10⁻⁴ (−0,038°) for eit auge 1,6 m over havet.
 *
 * @param {number} augeMoh
 * @returns {number} helning (negativ)
 */
export function sjohorisontHelning(augeMoh) {
    const rEff = CONFIG.sikt.jordradiusM * CONFIG.sikt.refraksjonsfaktor;
    return -Math.sqrt((2 * Math.max(0, augeMoh)) / rEff);
}

/**
 * Hent og rekn ut 360°-horisonten for eit punkt.
 *
 * @param {object} args
 * @param {{lat:number, lon:number, hoyde:number}} args.punkt
 * @param {number} [args.maksAvstandM]
 * @param {number} [args.talRetningar]
 * @param {AbortSignal} [args.signal]
 * @param {(ferdig:number, totalt:number) => void} [args.paaFramdrift]
 * @param {(delvis:object) => void} [args.paaDelvis] Eit brukbart horisontobjekt
 *        etter kvar ferdige batch, med `delvis: true`. Retningar som enno ikkje
 *        har landa er interpolerte frå naboane. Kallast ikkje ved cache-treff
 *        og ikkje for den siste batchen — då er det ferdige svaret rett rundt
 *        hjørnet uansett.
 * @returns {Promise<object>}
 */
export async function hentHorisont({
    punkt,
    maksAvstandM = P.maksAvstandM,
    talRetningar = P.talRetningar,
    signal,
    paaFramdrift,
    paaDelvis,
}) {
    const nokkel = horisontNokkel(punkt, maksAvstandM, talRetningar);
    const treff = cache.get(nokkel);
    if (treff) return treff;

    const augeMoh = punkt.hoyde + CONFIG.sikt.augehoydeM;
    const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // --- Bygg målpunkta -------------------------------------------------
    // Éin per retning, alle i same avstand. Id-en må matche mønsteret
    // elevation_profile.php krev (^[A-Za-z0-9_-]{1,32}$) — difor "hz<n>".
    const mal = [];
    for (let i = 0; i < talRetningar; i++) {
        const azimut = (i * 360) / talRetningar;
        const [lat, lon] = destinasjon(punkt.lat, punkt.lon, azimut, maksAvstandM);
        mal.push({ id: `hz${i}`, lat, lon, azimut, indeks: i });
    }

    /**
     * ===================================================================
     * BATCHANE ER FLETTA RUNDT KOMPASSET, IKKJE SAMANHENGANDE SEKTORAR
     * ===================================================================
     * Med `mal.slice(i, i + batch)` ville den fyrste batchen vore retning
     * 0-5, altså ein 30° brei kile — og sidan panoramaet no teiknar det
     * fyrste delresultatet med det same (§21), ville brukaren fått eitt
     * skarpt utsnitt og 330° utsmurt terreng. Eit bilete som ser ØYDELAGT
     * ut, ikkje grovt.
     *
     * Med steglengd `talBatchar` inneheld batch nr. 0 retningane 0, 12, 24,
     * 36 … — seks strålar jamt fordelte over heile kompasset. Fyrste
     * delresultatet er då ein komplett, grov 360°-horisont, og kvar batch
     * etterpå halverer omtrent mellomrommet. Nøyaktig same tal HTTP-kall og
     * same tal punkt: berre ei anna gruppering.
     *
     * Det kostar ingenting mot WPS-en heller — han er ein BATCH-oppslags-
     * teneste for vilkårlege punkt (CLAUDE.md §1), ikkje ein linjeteneste
     * som ville hatt godt av at punkta låg i nærleiken av kvarandre.
     */
    const talBatchar = Math.ceil(mal.length / P.batchStorleik);
    const batchar = Array.from({ length: talBatchar }, () => []);
    for (let i = 0; i < mal.length; i++) {
        batchar[i % talBatchar].push(mal[i]);
    }

    const profilar = new Map();
    let ferdige = 0;

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
            }
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            // Ein feilande batch skal ikkje velte heile panoramaet — dei
            // retningane vert interpolerte frå naboane i staden.
            console.warn('Horisont-batch feila, held fram:', e.message);
        }
        ferdige += batch.length;
        paaFramdrift?.(ferdige, mal.length);

        /**
         * DELRESULTAT ETTER KVAR BATCH.
         *
         * Ei kald horisonthenting tek 45-60 s, og heile den tida er
         * skjermen tom om kallaren ventar på det ferdige svaret. Kvar
         * fullførte batch er derimot ein brukbar, om enn grov, 360°-horisont
         * — dei retningane som manglar vert interpolerte frå naboane, som er
         * nøyaktig det `fyllHol()`/`fyllProfilhol()` gjer uansett.
         *
         * Den SISTE batchen sender ingenting: då er `hentHorisont()` uansett
         * i ferd med å returnere det ferdige objektet, og eit delresultat
         * rett før ville berre vore ei ekstra ombygging av same mesh.
         */
        if (paaDelvis && ferdige < mal.length && profilar.size > 0) {
            try {
                paaDelvis(byggHorisont({
                    punkt, augeMoh, maksAvstandM, talRetningar, mal, profilar, start,
                    delvis: true,
                }));
            } catch (e) {
                // Ein feil hos MOTTAKAREN av delresultatet skal aldri kunne
                // stoppe sjølve hentinga — det ferdige svaret er viktigare.
                console.warn('Delvis horisont: mottakaren feila:', e.message);
            }
        }
    };

    const kø = [...batchar];
    await Promise.all(Array.from(
        { length: Math.min(P.samtidigeKall, kø.length) },
        async () => {
            while (kø.length > 0) {
                if (signal?.aborted) throw new DOMException('Avbrote', 'AbortError');
                const b = kø.shift();
                if (b) await koyrBatch(b);
            }
        },
    ));

    // --- Skann horisonten i kvar retning --------------------------------
    const horisont = byggHorisont({
        punkt, augeMoh, maksAvstandM, talRetningar, mal, profilar, start,
    });

    cache.set(nokkel, horisont);
    return horisont;
}

/**
 * Sett saman eit horisontobjekt av dei profilane som ligg føre NO.
 *
 * Same funksjon for delresultat og for det ferdige svaret — den einaste
 * skilnaden er `delvis`, som slår på profil-syntesen for retningar som enno
 * ikkje har landa. Å ha to kodevegar her ville vore ein garanti for at
 * delbiletet og sluttbiletet før eller seinare vart rekna ulikt.
 */
function byggHorisont({
    punkt, augeMoh, maksAvstandM, talRetningar, mal, profilar, start, delvis = false,
}) {
    const retningar = mal.map((m) => {
        const profil = profilar.get(m.indeks) ?? null;
        if (!profil) {
            return {
                indeks: m.indeks,
                azimut: m.azimut,
                helning: null,
                profil: null,
                kritiskPunkt: null,
                interpolert: true,
            };
        }

        // NØYAKTIG same kall som ImpactCalculator gjer per turbin.
        const { helning, kritiskPunkt } = skannHorisont(profil, augeMoh, {
            minAvstandM: CONFIG.sikt.minHindringsavstandM,
            maksAvstandM,
        });

        return {
            indeks: m.indeks,
            azimut: m.azimut,
            helning,
            grader: Math.atan(helning) / DEG,
            profil,
            kritiskPunkt,
            /** Kor langt unna det som faktisk stengjer sikta står. */
            kritiskAvstandM: kritiskPunkt?.d ?? null,
            interpolert: false,
        };
    });

    // --- Fyll hòl -------------------------------------------------------
    const manglande = retningar.filter((r) => r.helning === null).length;
    if (manglande > 0) fyllHol(retningar, augeMoh);
    if (delvis && manglande > 0) fyllProfilhol(retningar, punkt);

    return {
        lat: punkt.lat,
        lon: punkt.lon,
        bakkeMoh: punkt.hoyde,
        augeMoh,
        maksAvstandM,
        talRetningar,
        retningar,
        manglande,
        /** Er dette eit delresultat som framleis vil bli betre? */
        delvis,
        /** Kor mange av retningane som har ekte, henta terreng. */
        ekte: talRetningar - manglande,
        hentaMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - start),
    };
}

/**
 * ===========================================================================
 * SYNTETISERTE PROFILAR FOR EIT HORISONTBILETE SOM ENNO ER UFERDIG
 * ===========================================================================
 * `fyllHol()` over fyller HELNINGA i retningar som manglar — nok for
 * silhuetten, men ikkje for meshen: `PanoramaView._byggTerreng()` filtrerer
 * bort retningar utan `profil` og triangulerer dei som står att som om dei låg
 * side om side. Med berre kvart tolvte kompassutsnitt inne (som midt i ei
 * progressiv henting) ville nabo nr. 17 og nabo nr. 36 vorte kopla saman med
 * ein einaste 90°-brei kile av flatt terreng. Ikkje eit grovt bilete — eit
 * FEIL eitt.
 *
 * Difor får ei uferdig retning ein profil som er blanda frå den næraste
 * ferdige naboen på kvar side, radius for radius. Det er nøyaktig same
 * operasjon rasteriseraren allereie gjer mellom to strålar (§16), berre
 * eksplisitt og med større mellomrom — så biletet er ærleg: det viser den
 * oppløysinga me faktisk har akkurat no, og skjerpar seg for kvar batch som
 * landar.
 *
 * Brukast BERRE på delresultat. Den ferdige horisonten er uendra: der står ei
 * retning utan profil framleis utan profil, og meshen hoppar over henne som før.
 */
function fyllProfilhol(retningar, punkt) {
    const n = retningar.length;
    const harProfil = (i) => retningar[((i % n) + n) % n].profil !== null;
    if (!retningar.some((r) => r.profil)) return;

    for (let i = 0; i < n; i++) {
        if (retningar[i].profil) continue;

        let fram = 1;
        let bak = 1;
        while (fram < n && !harProfil(i + fram)) fram++;
        while (bak < n && !harProfil(i - bak)) bak++;

        const a = fram < n ? retningar[(i + fram) % n].profil : null;
        const b = bak < n ? retningar[((i - bak) % n + n) % n].profil : null;
        const kjelde = a && b ? (fram <= bak ? a : b) : (a ?? b);
        if (!kjelde) continue;

        // Vekta mot den næraste naboen, same lineære vekting som fyllHol().
        const vekt = a && b ? bak / (bak + fram) : (a ? 1 : 0);
        const az = retningar[i].azimut;

        retningar[i].profil = kjelde.map((p, j) => {
            const zA = a?.[j]?.z;
            const zB = b?.[j]?.z;
            const z = (zA !== undefined && zB !== undefined)
                ? zB + (zA - zB) * vekt
                : (zA ?? zB ?? p.z);
            // Ekte lat/lon, ikkje naboen sine: dei styrer UV-oppslaget i
            // flyfotoringane, og eit kopiert koordinat ville drege
            // biletteksturen sidelengs i heile den syntetiske sektoren.
            const [lat, lon] = destinasjon(punkt.lat, punkt.lon, az, p.d);
            return { ...p, z, lat, lon, syntetisk: true };
        });
    }
}

/**
 * Erstatt retningar utan profil med eit snitt av næraste gyldige naboar på
 * kvar side (sirkulært), eller sjøhorisonten om ingen finst.
 */
function fyllHol(retningar, augeMoh) {
    const n = retningar.length;
    const gyldig = (i) => retningar[((i % n) + n) % n].helning !== null;

    for (let i = 0; i < n; i++) {
        if (retningar[i].helning !== null) continue;

        let fram = 1;
        let bak = 1;
        while (fram < n && !gyldig(i + fram)) fram++;
        while (bak < n && !gyldig(i - bak)) bak++;

        if (fram >= n && bak >= n) {
            retningar[i].helning = sjohorisontHelning(augeMoh);
        } else if (fram >= n) {
            retningar[i].helning = retningar[((i - bak) % n + n) % n].helning;
        } else if (bak >= n) {
            retningar[i].helning = retningar[(i + fram) % n].helning;
        } else {
            // Lineær vekting: nærast nabo veg mest.
            const a = retningar[((i - bak) % n + n) % n].helning;
            const b = retningar[(i + fram) % n].helning;
            retningar[i].helning = a + (b - a) * (bak / (bak + fram));
        }
        retningar[i].grader = Math.atan(retningar[i].helning) / DEG;
    }
}

/**
 * Horisonthelninga i ein vilkårleg kompassretning, lineært interpolert mellom
 * dei to skanna naboretningane.
 *
 * @param {object} horisont Frå hentHorisont()
 * @param {number} azimutGrader
 * @returns {number} helning
 */
export function helningIRetning(horisont, azimutGrader) {
    const n = horisont.talRetningar;
    const pos = (((azimutGrader % 360) + 360) % 360) / (360 / n);
    const i = Math.floor(pos);
    const f = pos - i;
    const a = horisont.retningar[i % n].helning;
    const b = horisont.retningar[(i + 1) % n].helning;
    return a + (b - a) * f;
}

/**
 * Horisonten uttrykt som høgd over havet i ein gitt avstand og retning —
 * altså same storleik som `synlegheit.horisontMoh` i eit turbinresultat.
 *
 * Finst berre for verifikasjon og for tooltips; sjølve teikninga bruker
 * helninga direkte.
 */
export function horisontMohIRetning(horisont, azimutGrader, avstandM) {
    return horisont.augeMoh
        + helningIRetning(horisont, azimutGrader) * avstandM
        + horisontfall(avstandM);
}
