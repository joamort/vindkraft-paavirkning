/**
 * js/utils/TurbinJustering.js
 *
 * Lèt brukaren dra ein turbin til ein annan stad — men berre dei turbinane der
 * posisjonen aldri var eit faktum i utgangspunktet.
 *
 * ===========================================================================
 * KVIFOR BERRE TO AV DEI TRE POSISJONSKJELDENE KAN FLYTTAST
 * ===========================================================================
 * Datasettet har tre slag turbinpunkt (sjå CLAUDE.md §5 og §12):
 *
 *   nve_turbinpunkt     – NVE har den faktiske koordinaten. Å la brukaren dra
 *                         han ville vere å forfalske verifisert offentleg data:
 *                         panelet ville rapportere «synleg frå bustaden din»
 *                         for ein turbin som i røynda står ein annan stad.
 *                         Desse er difor ALDRI flyttbare.
 *   estimert_i_omrade   – VÅR eigen heuristikk har plassert punktet inne i det
 *                         verkelege planområdet. Typisk feil er ~1,3
 *                         rotordiameter, men på einskildpunkt kan han vere mykje
 *                         større — og brukaren som bur der ser ofte sjølv kva
 *                         rygg turbinane kjem til å stå på.
 *   anlegg_senterpunkt  – eitt punkt for heile anlegget, utan noka plassering i
 *                         det heile. Alt er betre enn ingenting her.
 *
 * Skiljet er difor ikkje «kva er praktisk å tillate», men «kven har sagt at
 * turbinen står her». Har NVE sagt det, står punktet fast.
 *
 * ===========================================================================
 * EI JUSTERING ER EIN TREDJE KJELDEKATEGORI, IKKJE EIT NYTT ESTIMAT
 * ===========================================================================
 * Ein flytta turbin får `posisjon_kilde: 'brukerjustert'`. Det er med vilje ein
 * EIGEN verdi og ikkje ei overskriving av den gamle: eit tal som stammar frå
 * brukarens eige museklikk skal aldri kunne forvekslast med korkje NVE sin
 * koordinat eller vår eigen heuristikk. Den opphavlege posisjonen vert med
 * vidare på objektet, slik at tilbakestilling ikkje treng noko sideregister —
 * og slik at UI-et kan seie kor langt turbinen er flytta.
 *
 * Justeringa lever berre i minnet, i denne sideøkta. Dette er eit
 * «kva om»-verktøy, ikkje ei datakjelde; ville me lagra det, måtte me òg svare
 * på kva ei lagra brukargjetning skulle bety neste gong cron hentar nye data
 * frå NVE. Svaret er «ingenting», og då er minnet rett stad.
 */

import { haversine } from './geo.js';

/** `posisjon_kilde` for eit punkt brukaren sjølv har flytta. */
export const JUSTERT_KILDE = 'brukerjustert';

/**
 * Posisjonskjelder som kan dragast.
 * `JUSTERT_KILDE` er med av di ei justering skal kunne justerast om att —
 * brukaren prøver seg fram.
 */
export const FLYTTBARE_KJELDER = new Set([
    'estimert_i_omrade',
    'anlegg_senterpunkt',
    JUSTERT_KILDE,
]);

/** @returns {boolean} Kan denne turbinen dragast? */
export function kanFlyttast(turbin) {
    return Boolean(turbin) && FLYTTBARE_KJELDER.has(turbin.posisjon_kilde);
}

/** @returns {boolean} Er posisjonen sett av brukaren? */
export function erJustert(turbin) {
    return Boolean(turbin) && turbin.posisjon_kilde === JUSTERT_KILDE;
}

/**
 * Lag ein kopi av turbinen med ny posisjon, merkt som brukarjustert.
 *
 * IDEMPOTENT PÅ OPPHAVET: `opphavleg_*` vert sett berre første gong. Drar
 * brukaren same turbin fem gonger, peikar tilbakestillinga framleis på
 * heuristikkens eige punkt — ikkje på det fjerde drop-punktet hans.
 *
 * @param {object} turbin
 * @param {number} lat
 * @param {number} lon
 * @returns {object} Ny turbin (originalen vert ikkje endra)
 */
export function flyttTurbin(turbin, lat, lon) {
    const opphavlegLat = turbin.opphavleg_lat ?? turbin.lat;
    const opphavlegLon = turbin.opphavleg_lon ?? turbin.lon;
    const opphavlegKilde = turbin.opphavleg_posisjon_kilde ?? turbin.posisjon_kilde;

    return {
        ...turbin,
        lat,
        lon,
        posisjon_kilde: JUSTERT_KILDE,
        opphavleg_lat: opphavlegLat,
        opphavleg_lon: opphavlegLon,
        opphavleg_posisjon_kilde: opphavlegKilde,
        flytt_avstand_m: haversine(opphavlegLat, opphavlegLon, lat, lon),
        /**
         * Terrengklassen heuristikken fann er ein eigenskap ved DET punktet,
         * ikkje ved turbinen. Etter ei flytting er han rett og slett feil, og
         * ei feil opplysning er verre enn ingen.
         */
        layout_terreng: null,
    };
}

/**
 * Sett posisjonen tilbake til det opphavlege estimatet.
 *
 * @param {object} turbin
 * @returns {object} Turbin med opphavleg posisjon (uendra kopi om han ikkje er justert)
 */
export function tilbakestillTurbin(turbin) {
    if (!erJustert(turbin)) return turbin;

    const ut = { ...turbin };
    ut.lat = turbin.opphavleg_lat;
    ut.lon = turbin.opphavleg_lon;
    ut.posisjon_kilde = turbin.opphavleg_posisjon_kilde;
    delete ut.opphavleg_lat;
    delete ut.opphavleg_lon;
    delete ut.opphavleg_posisjon_kilde;
    delete ut.flytt_avstand_m;
    delete ut.layout_terreng;
    return ut;
}

// ===========================================================================
// PLANOMRÅDE — EIT MJUKT GRENSEBAND, IKKJE EI SPERRE
// ===========================================================================

/** Odde/like-regelen for éin ring-samling (indre ringar vert hol). */
function iPolygon(lat, lon, ringer) {
    let inne = false;
    for (const ring of ringer) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [yi, xi] = ring[i];
            const [yj, xj] = ring[j];
            if ((yi > lat) !== (yj > lat)
                && lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi) {
                inne = !inne;
            }
        }
    }
    return inne;
}

/**
 * Ligg punktet inne i minst eitt av polygona?
 *
 * FLEIRE OMRÅDEOPPFØRINGAR MÅ HANDSAMAST SOM SEPARATE POLYGON, ikkje som éi
 * lang ringliste — same felle som i TurbineLayout.php (CLAUDE.md §12): NVE har
 * to områdelag, og ei sak ligg ofte i begge med same omriss. Slår ein ringane
 * saman, kansellerer odde/like-testen dei mot kvarandre og heile planområdet
 * forsvinn.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {Array<Array<Array<[number,number]>>>} polygonar Liste av ring-samlingar
 * @returns {boolean}
 */
export function innanforPlanomrade(lat, lon, polygonar) {
    return (polygonar ?? []).some((ringer) => iPolygon(lat, lon, ringer));
}

/**
 * Grovt mål på kor langt utanfor planområdet eit punkt ligg.
 *
 * Avstanden er til næraste HJØRNE i omrisset, ikkje til næraste kant. Det er
 * ei overvurdering, men berre i storleiksorden éin ringoppløysing — og
 * funksjonen skal berre avgjere om ei mild åtvaring er verd å vise, ikkje
 * publisere eit tal. Ei eksakt punkt-til-segment-rekning ville vore meir kode
 * for ein terskel som uansett er skjønnsmessig.
 *
 * @returns {number} Meter, eller 0 når punktet er innanfor
 */
export function avstandUtanforPlanomrade(lat, lon, polygonar) {
    if (!polygonar?.length) return 0;
    if (innanforPlanomrade(lat, lon, polygonar)) return 0;

    let naermast = Infinity;
    for (const ringer of polygonar) {
        for (const ring of ringer) {
            for (const [y, x] of ring) {
                const d = haversine(lat, lon, y, x);
                if (d < naermast) naermast = d;
            }
        }
    }
    return Number.isFinite(naermast) ? naermast : 0;
}
