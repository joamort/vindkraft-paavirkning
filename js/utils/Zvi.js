/**
 * js/utils/Zvi.js
 *
 * Lokalt synlegheitskart («zone of visual influence» i det små): eit rutenett
 * rundt analysepunktet, der kvar celle får talet turbinar som er synlege
 * DERFRÅ.
 *
 * =========================================================================
 * KVIFOR DETTE ER EI TILNÆRMING — OG KVIFOR DEN HELD
 * =========================================================================
 * Ei eksakt utrekning ville kravd ein ny terrengprofil frå kvar celle til
 * kvar turbin — hundrevis av Kartverket-kall. I staden gjenbruker me
 * analysen som alt er gjort for PUNKTET:
 *
 *   `skannHorisont()` gir, per turbin, ei maksimal skrålinje-HELNING og det
 *   kritiske terrengpunktet `{d, z}` som set henne. Terrenghorisonten ved
 *   turbinen er då `horisontMoh = augeMoh + helning · D`.
 *
 *   Flyttar auget Δz opp (cella ligg høgare enn punktet), endrar helninga
 *   til det kritiske punktet seg med `−Δz/d_krit`, så:
 *
 *       horisontMoh_celle = horisontMoh_punkt + Δz · (1 − D / d_krit)
 *
 *   D/d_krit er typisk ≫ 1 (turbinen langt unna, skjeringa nær), så å heve
 *   auget litt SENKER horisonten mykje — same D/d-forsterking som §7 i
 *   CLAUDE.md. Føresetnaden er at det kritiske punktet er DET SAME for cella
 *   som for punktet, og det held berre når cella er nær. Difor eit lite
 *   rutenett (CONFIG.synlegheitskart.sideM).
 *
 * Same substitusjonslogikk som DOM-sjekken (§22) og hinderlys-testen (§10)
 * alt byggjer på: `horisontMoh` er ein eigenskap ved terrenget MELLOM, ikkje
 * ved den nøyaktige augeposisjonen.
 */

import { CONFIG } from '../config.js';

/** Ein turbin tel som «synleg» frå ei celle når meir enn denne brøkdelen av
 *  totalhøgda stikk over den justerte horisonten (same 2 %-golv som
 *  ImpactCalculator sin `skjult`-terskel). */
const SYNLEG_GOLV = 0.02;

/**
 * @param {{lat:number, lon:number, hoyde:number}} punkt Analysepunktet
 * @param {object[]} resultat  state.resultat — utrekna turbinresultat
 * @param {(punkter:Array<[number,number]>, signal?:AbortSignal)=>Promise<Array<number|null>>} hentDtm
 * @param {AbortSignal} [signal]
 * @returns {Promise<{celler:Array<{lat:number,lon:number,rad:number,kol:number,tal:number|null}>,
 *                    maks:number, sideM:number, celleM:number, nPerSide:number,
 *                    talIPunktet:number}>}
 */
export async function byggSynlegheitskart(punkt, resultat, hentDtm, signal) {
    const n = CONFIG.synlegheitskart.celler;
    const sideM = CONFIG.synlegheitskart.sideM;
    const celleM = sideM / (n - 1);
    const halv = (n - 1) / 2;

    const analyserte = resultat.filter(
        (r) => r.analysert && Number.isFinite(r.synlegheit?.horisontMoh),
    );

    // Rutenett-koordinatar (nord/aust-forskyving → lat/lon; berre nokre hundre
    // meter, så plan projeksjon er meir enn nøyaktig nok).
    const mPerGradLat = 111_320;
    const mPerGradLon = 111_320 * Math.cos(punkt.lat * Math.PI / 180);

    const celler = [];
    const punkter = [];
    for (let rad = 0; rad < n; rad++) {
        for (let kol = 0; kol < n; kol++) {
            const nord = (halv - rad) * celleM;   // rad 0 = nordlegast
            const aust = (kol - halv) * celleM;
            const lat = punkt.lat + nord / mPerGradLat;
            const lon = punkt.lon + aust / mPerGradLon;
            celler.push({ lat, lon, rad, kol, tal: null });
            punkter.push([lat, lon]);
        }
    }

    const bakke = await hentDtm(punkter, signal);

    let maks = 0;
    let talIPunktet = 0;
    const midtIndeks = Math.round(halv) * n + Math.round(halv);

    celler.forEach((celle, i) => {
        const zCelle = bakke[i];
        if (zCelle == null || !Number.isFinite(zCelle)) {
            celle.tal = null;               // utanfor laserdekning
            return;
        }
        const dz = zCelle - punkt.hoyde;

        let tal = 0;
        for (const r of analyserte) {
            const dKrit = r.synlegheit.kritiskPunkt?.d;
            // Uskjerma turbin (ingen kritisk punkt): horisonten følgjer auget
            // 1:1, altså ingen praktisk endring i synlegheit.
            const faktor = (dKrit && dKrit > 0) ? (1 - r.avstandM / dKrit) : 1;
            const horisontCelle = r.synlegheit.horisontMoh + dz * faktor;
            const tuppMoh = r.bakkeVedTurbinMoh + r.totalhoydeM;
            if (tuppMoh - horisontCelle > SYNLEG_GOLV * r.totalhoydeM) tal++;
        }
        celle.tal = tal;
        if (tal > maks) maks = tal;
        if (i === midtIndeks) talIPunktet = tal;
    });

    return { celler, maks, sideM, celleM, nPerSide: n, talIPunktet };
}
