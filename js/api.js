/**
 * js/api.js
 *
 * Éin modul for alle HTTP-kall (etablert mønster frå RegSøk/TagTrack).
 * Resten av appen skal aldri kalle `fetch` direkte.
 */

import { CONFIG } from './config.js';

/**
 * Feil frå API-laget, med HTTP-status når den finst.
 */
export class ApiFeil extends Error {
    constructor(melding, status = 0) {
        super(melding);
        this.name = 'ApiFeil';
        this.status = status;
    }
}

async function lesJson(respons, kontekst) {
    let data = null;
    try {
        data = await respons.json();
    } catch {
        throw new ApiFeil(`${kontekst}: fekk ikkje gyldig JSON tilbake.`, respons.status);
    }
    if (!respons.ok || data?.ok === false) {
        throw new ApiFeil(data?.error ?? `${kontekst}: HTTP ${respons.status}`, respons.status);
    }
    return data;
}

/**
 * Hent heile turbin-cachen.
 *
 * Lastar den statiske JSON-fila direkte frå Apache — ingen PHP i løkka
 * (jf. TECH_STACK.md). Fila er ~550 KB og komprimerer godt over gzip.
 *
 * @returns {Promise<{generert:string, atterhald:string, turbiner:object[], anlegg:object[]}>}
 */
export async function hentTurbinar() {
    const respons = await fetch(CONFIG.api.turbinCache, { cache: 'default' });
    if (!respons.ok) {
        throw new ApiFeil(
            'Fann ikkje turbindata. Er cachen bygd? Køyr cron/fetch_turbines.php.',
            respons.status,
        );
    }
    return lesJson(respons, 'Turbindata');
}

/**
 * Hent områdepolygon for vindkraftanlegg. Valfritt lag — feilar det, skal
 * appen framleis fungere, så kallaren får null i staden for eit kast.
 */
export async function hentOmrader() {
    try {
        const respons = await fetch(CONFIG.api.omradeCache, { cache: 'default' });
        if (!respons.ok) return null;
        return await respons.json();
    } catch {
        return null;
    }
}

/**
 * Terrenghøgd i eitt punkt.
 *
 * @returns {Promise<{hoyde_m:number, terreng:string, datakilde:string}>}
 */
export async function hentHoyde(lat, lon) {
    const url = `${CONFIG.api.hoydepunkt}?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
    const respons = await fetch(url);
    return lesJson(respons, 'Høgdedata');
}

/**
 * Høgd i vilkårlege punkt frå ei namngjeven datakjelde — i praksis `dom1`,
 * overflatemodellen med skog og bygningar (CLAUDE.md §22).
 *
 * Svaret er ei liste i SAME REKKJEFØLGJE som inndata, der `null` tyder «ikkje
 * målt» (utanfor laserdekninga, eller eit oppstraums-kall som feila) — aldri
 * 0. Kallaren må skilje dei to: 0 ville lese som «ingenting står her».
 *
 * @param {Array<[number, number]>} punkter [[lat, lon], ...] — maks 100
 * @param {string} [datakilde]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{datakilde:string, hoyder:Array<number|null>, stats:object}>}
 */
export async function hentOverflatehoyder(punkter, datakilde = CONFIG.overflate.datakilde, signal) {
    const respons = await fetch(CONFIG.api.overflatepunkt, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datakilde, punkter }),
        signal,
    });
    return lesJson(respons, 'Overflatedata');
}

/**
 * Hent terrengprofilar frå eitt origo til fleire mål.
 *
 * @param {{lat:number, lon:number}} origo
 * @param {Array<{id:string, lat:number, lon:number}>} mal
 * @param {AbortSignal} [signal]
 * @returns {Promise<{origin:object, profiles:Record<string, object[]>, stats:object}>}
 */
export async function hentProfilar(origo, mal, signal) {
    const respons = await fetch(CONFIG.api.hoydeprofil, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: origo, targets: mal }),
        signal,
    });
    return lesJson(respons, 'Høgdeprofil');
}

/**
 * Adressesøk via Kartverket (proxya gjennom backenden). Returnerer ei liste
 * `{tekst, stad, lat, lon}`. Feilar det, får kallaren null og bør syne
 * «ingen treff» heller enn ei feilmelding.
 *
 * @param {string} q
 * @param {AbortSignal} [signal]
 */
export async function sokAdresse(q, signal) {
    try {
        const respons = await fetch(
            `${CONFIG.api.adressesok}?q=${encodeURIComponent(q)}`,
            { signal },
        );
        if (!respons.ok) return null;
        const data = await respons.json();
        return Array.isArray(data?.treff) ? data.treff : null;
    } catch {
        return null;
    }
}

/**
 * Diskré versjonssjekk for den sjølvhosta appen. Backenden spør GitHub (maks
 * éin gong per døgn) og svarar `{naavaerande, siste, nyare, url}`. Feilar det,
 * eller er dette ein web-/kjeldekode-installasjon, får kallaren null og skal
 * ikkje vise noko.
 */
export async function sjekkVersjon() {
    try {
        const respons = await fetch(CONFIG.api.versjonssjekk);
        if (!respons.ok) return null;
        return await respons.json();
    } catch {
        return null;
    }
}

/**
 * Bygg turbin-cachen på nytt frå NVE (den sjølvhosta appen sin «Oppdater
 * no»-knapp). Tek 20–40 s. Kastar ApiFeil om endepunktet er avslege eller
 * hentinga feilar.
 */
export async function oppdaterTurbindata() {
    const respons = await fetch(CONFIG.api.oppdaterTurbindata, { method: 'POST' });
    return lesJson(respons, 'Oppdatering av turbindata');
}
