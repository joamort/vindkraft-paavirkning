/**
 * js/utils/AnalyseRunner.js
 *
 * Køyrer sjølve analysen: finn turbinar i radius, hentar terrengprofilar i
 * batchar, og reknar ut påverknad per turbin.
 *
 * ===========================================================================
 * KVIFOR STRAUMANDE BATCHAR
 * ===========================================================================
 * Eit punkt kan ha over 200 turbinar innanfor 20 km. Kvar av dei treng ein
 * terrengprofil, og profilane må hentast frå Kartverket. To ting følgjer:
 *
 *  1. Me kan ikkje vente på alt før me viser noko. Difor sender me resultat
 *     tilbake til UI-et batch for batch, slik at lista fyllest opp
 *     framfor auga på brukaren i staden for å stå tom i eit halvt minutt.
 *
 *  2. Turbinane vert sorterte på avstand FØR analysen, slik at dei næraste —
 *     dei brukaren bryr seg mest om — kjem først.
 *
 * Kalla går med avgrensa parallellitet (CONFIG.analyse.samtidigeKall). Fleire
 * samtidige kall gir kortare total tid, men me held talet lågt for ikkje å
 * hamre verken vårt eige endepunkt eller Kartverket.
 */

import { CONFIG } from '../config.js';
import { hentProfilar } from '../api.js';
import { haversine } from './geo.js';
import { beregnPaaverknad, byggSamandrag } from './ImpactCalculator.js';
import { samletStoy } from './NoiseModel.js';
import { byggSoltabell, skyggekastForAlle, maksSkyggeavstandM } from './ShadowFlicker.js';

/**
 * Finn turbinar innanfor radius, sortert på avstand.
 *
 * @param {object[]} turbinar Alle turbinar
 * @param {{lat:number, lon:number}} punkt
 * @param {number} radiusM
 * @param {Set<string>} statusFilter
 * @returns {Array<object & {_avstand:number}>}
 */
export function finnTurbinarIRadius(turbinar, punkt, radiusM, statusFilter) {
    const treff = [];
    for (const t of turbinar) {
        if (statusFilter && statusFilter.size > 0 && !statusFilter.has(t.status)) continue;
        const d = haversine(punkt.lat, punkt.lon, t.lat, t.lon);
        if (d <= radiusM) {
            treff.push({ ...t, _avstand: d });
        }
    }
    treff.sort((a, b) => a._avstand - b._avstand);
    return treff;
}

/**
 * Køyr full analyse.
 *
 * @param {object} args
 * @param {{lat:number, lon:number, hoyde:number}} args.punkt
 * @param {object[]} args.turbinar        Turbinar i radius, sortert på avstand
 * @param {(delresultat:object[], ferdig:number, totalt:number) => void} args.paaFramdrift
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{resultat:object[], samandrag:object, samlaStoy:object|null, avkorta:boolean}>}
 */
export async function koyrAnalyse({ punkt, turbinar, paaFramdrift, signal }) {
    const tak = CONFIG.analyse.maksTurbinar;
    const avkorta = turbinar.length > tak;
    const utval = turbinar.slice(0, tak);

    // Del i batchar som endepunktet aksepterer.
    const batchar = [];
    for (let i = 0; i < utval.length; i += CONFIG.analyse.batchStorleik) {
        batchar.push(utval.slice(i, i + CONFIG.analyse.batchStorleik));
    }

    const resultat = [];
    let ferdige = 0;

    /** Handsam éin batch: hent profilar og rekn ut påverknad. */
    const koyrBatch = async (batch) => {
        let profilar = {};
        try {
            const svar = await hentProfilar(
                { lat: punkt.lat, lon: punkt.lon },
                batch.map((t) => ({ id: t.id, lat: t.lat, lon: t.lon })),
                signal,
            );
            profilar = svar.profiles ?? {};
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            // Ein feilande batch skal ikkje velte heile analysen — turbinane
            // hamnar i lista som "ikkje analysert" i staden.
            console.warn('Batch feila, held fram utan profil:', e.message);
        }

        const delresultat = batch.map((t) => beregnPaaverknad({
            punkt,
            turbin: t,
            profil: profilar[t.id] ?? null,
        }));

        resultat.push(...delresultat);
        ferdige += batch.length;
        paaFramdrift?.(delresultat, ferdige, utval.length);
    };

    // Køyr batchane med avgrensa parallellitet.
    const kø = [...batchar];
    const arbeidarar = Array.from(
        { length: Math.min(CONFIG.analyse.samtidigeKall, kø.length) },
        async () => {
            while (kø.length > 0) {
                if (signal?.aborted) throw new DOMException('Avbrote', 'AbortError');
                const batch = kø.shift();
                if (batch) await koyrBatch(batch);
            }
        },
    );
    await Promise.all(arbeidarar);

    // Hald den avstandssorterte rekkjefølgja — batchane kan bli ferdige i
    // vilkårleg rekkjefølgje når dei køyrer parallelt.
    resultat.sort((a, b) => a.avstandM - b.avstandM);

    /**
     * SKYGGEKAST — eit etterpass, ikkje ein del av per-turbin-rekninga.
     *
     * To grunnar til at det ligg her og ikkje i beregnPaaverknad():
     *
     *  1. **Soltabellen skal byggjast éin gong.** Solas gang gjennom året
     *     avheng av PUNKTET, ikkje av turbinen. Å byggje han inne i
     *     per-turbin-funksjonen ville kosta 40 × så mykje for eit punkt midt
     *     i eit anlegg.
     *
     *  2. **Punktsummen er ei union.** Fleire turbinar kan kaste skugge same
     *     minutt; skal svaret vere «kor lenge står eg i skugge», må minutta
     *     tellast éin gong. Det krev at alle turbinane er kjende samtidig.
     *
     * Steget hoppast heilt over når ingen turbin er nær nok — då er
     * kostnaden null, og det er det vanlege tilfellet.
     */
    const skyggeKandidatar = resultat.filter(
        (r) => r.analysert && r.avstandM <= maksSkyggeavstandM(r.rotorDiameterM),
    );

    let skyggekast = null;
    if (skyggeKandidatar.length > 0) {
        const soltabell = byggSoltabell(punkt);
        const { perTurbin, samla } = skyggekastForAlle(skyggeKandidatar, soltabell);
        for (const r of resultat) {
            const s = perTurbin.get(r.id);
            if (s) r.skyggekast = s;
        }
        skyggekast = samla;
    }

    const samandrag = byggSamandrag(resultat);
    samandrag.skyggekast = skyggekast;

    const stoybidrag = resultat.filter((r) => r.stoy).map((r) => r.stoy.lpDb);
    const samlaStoy = samletStoy(stoybidrag);

    return { resultat, samandrag, samlaStoy, avkorta, skyggekast };
}
