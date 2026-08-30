/**
 * js/utils/NoiseModel.js
 *
 * Forenkla støymodell for vindturbinar.
 *
 * ===========================================================================
 * KVA DETTE ER — OG IKKJE ER
 * ===========================================================================
 * Modellen bruker grunnforma frå den nordiske/danske berekningsmetoden for
 * vindmøllestøy:
 *
 *     L_p = L_WA − 20·log₁₀(d) − 11 + ΔL_g − ΔL_a·d − A_skjerming
 *
 *   L_WA         lydeffektnivå for turbinen (ESTIMERT frå merkeeffekt)
 *   20·log₁₀(d)  sfærisk spreiing frå ei punktkjelde
 *   −11          10·log₁₀(4π), overgang frå lydeffekt til lydtrykk
 *   ΔL_g         +1,5 dB bakkerefleks over ope terreng
 *   ΔL_a·d       luftabsorpsjon, 0,005 dB/m
 *   A_skjerming  grovt diffraksjonstillegg når terrenget skjuler navet
 *
 * Dette er IKKJE full ISO 9613-2. Reelle støyvurderingar i konsesjonssaker
 * bruker frekvensbandoppløyst modellering med målt kjeldedata per turbinmodell,
 * meteorologisk statistikk og verkeleg terrengdiffraksjon. Avviket mellom denne
 * modellen og ein fagrapport kan lett vera fleire dB.
 *
 * Sjå PLAN.md §4.3 og §7.
 */

import { CONFIG } from '../config.js';
import { summerDesibel } from './geo.js';

const S = CONFIG.stoy;

/**
 * Estimert lydtrykknivå frå éin turbin ved observatørpunktet.
 *
 * @param {object} p
 * @param {number} p.lydeffektDba      L_WA for turbinen (dB)
 * @param {number} p.horisontalAvstandM Horisontal avstand observatør→turbin
 * @param {number} p.navHoydeMoh       Navhøgd i meter over havet
 * @param {number} p.oyreHoydeMoh      Øyrehøgd hos observatøren i meter over havet
 * @param {boolean} p.navSynleg        Er navet synleg (ingen terrengskjerming)?
 * @param {number} p.skjulhoydeM       Kor mange meter under siktlinja navet ligg
 * @param {number} [p.antallTurbiner]  Tal turbinar punktet representerer (plassholdar)
 * @returns {{lpDb:number, ldenDb:number, skjermingDb:number, slengdeM:number}}
 */
export function turbinStoy({
    lydeffektDba,
    horisontalAvstandM,
    navHoydeMoh,
    oyreHoydeMoh,
    navSynleg,
    skjulhoydeM,
    antallTurbiner = 1,
}) {
    // Skrå avstand frå navet (lydkjelda) til øyret — ikkje berre horisontal
    // avstand. For ein turbin 300 m unna er skilnaden vesentleg.
    const hoydeforskjell = navHoydeMoh - oyreHoydeMoh;
    const slengde = Math.max(1, Math.hypot(horisontalAvstandM, hoydeforskjell));

    const skjerming = navSynleg
        ? 0
        : Math.min(S.skjermingMaksDb, S.skjermingGrunnDb + S.skjermingFaktor * Math.log10(1 + Math.max(0, skjulhoydeM)));

    let lp = lydeffektDba
        - 20 * Math.log10(slengde)
        - 11
        + S.bakkereflekssjonDb
        - S.luftabsorpsjonDbPerM * slengde
        - skjerming;

    // Eit plassholdar-punkt representerer heile anlegget. Å behandle det som
    // éin turbin ville undervurdert støyen grovt. N like kjelder på same
    // avstand gir +10·log₁₀(N) dB. Det er ei grov tilnærming — turbinane står
    // spreidde utover, ikkje i same punkt — men langt nærare sanninga enn å
    // late som anlegget berre har éin turbin.
    if (antallTurbiner > 1) {
        lp += 10 * Math.log10(antallTurbiner);
    }

    return {
        lpDb: lp,
        ldenDb: lp + S.ldenPaaslagDb,
        skjermingDb: skjerming,
        slengdeM: slengde,
    };
}

/**
 * Summer støybidraga frå fleire turbinar energetisk.
 *
 * @param {number[]} lpNivaaer L_pA-verdiar (dB) frå kvar turbin
 * @returns {{lpDb:number, ldenDb:number}|null}
 */
export function samletStoy(lpNivaaer) {
    const lp = summerDesibel(lpNivaaer);
    if (lp === null) return null;
    return { lpDb: lp, ldenDb: lp + S.ldenPaaslagDb };
}

/**
 * Formater eit L_den-nivå for vising.
 *
 * Under rapporteringsgolvet (sjå CONFIG.stoy.rapporteringsgolvDb) gir eit
 * konkret tal eit falskt inntrykk av presisjon — nivået er då langt under
 * vanleg bakgrunnsstøy, og modellen har inga oppløysing der nede.
 *
 * @param {number|null} ldenDb
 * @param {boolean} [kort] Kompakt form til listeradene
 * @returns {string}
 */
export function formaterStoy(ldenDb, kort = false) {
    if (ldenDb === null || !Number.isFinite(ldenDb)) return '–';
    if (ldenDb < S.rapporteringsgolvDb) {
        return kort ? `<${S.rapporteringsgolvDb}` : `under ${S.rapporteringsgolvDb} dB`;
    }
    return kort ? `${ldenDb.toFixed(0)}` : `${ldenDb.toFixed(1)} dB`;
}

/**
 * Fargekategori for eit L_den-nivå, mot T-1442 si rettleiande grense.
 *
 * T-1442 (Retningslinje for behandling av støy i arealplanlegging) set
 * L_den 45 dB som rettleiande grenseverdi ved støyfølsam busetnad for
 * vindkraftverk. Merk at grensa gjeld eit fagleg berekna nivå — ikkje eit
 * grovestimat som dette.
 *
 * @param {number|null} ldenDb
 * @returns {{nokkel:string, tekst:string, klasse:string}}
 */
export function stoykategori(ldenDb) {
    if (ldenDb === null || !Number.isFinite(ldenDb)) {
        return { nokkel: 'ukjent', tekst: 'Ikkje berekna', klasse: 'stoy-ukjent' };
    }
    if (ldenDb < S.terskelLavDb) {
        return { nokkel: 'lav', tekst: 'Godt under rettleiande grense', klasse: 'stoy-lav' };
    }
    if (ldenDb <= S.terskelHoyDb) {
        return { nokkel: 'moderat', tekst: 'Nær rettleiande grense', klasse: 'stoy-moderat' };
    }
    return { nokkel: 'hoy', tekst: 'Over rettleiande grense (L_den 45 dB)', klasse: 'stoy-hoy' };
}
