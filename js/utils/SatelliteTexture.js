/**
 * js/utils/SatelliteTexture.js
 *
 * Ekte flyfoto som tekstur til 3D-panoramaet.
 *
 * ===========================================================================
 * KVIFOR ESRI OG IKKJE KARTVERKET SITT EIGE FLYFOTO
 * ===========================================================================
 * Norge i bilder («Norge i bilder» / `tilecache.norgeibilder.no`) er den
 * openberre kjelda — det er norske ortofoto i mykje betre oppløysing enn noko
 * globalt datasett. Men den WMTS-en er IKKJE open:
 *
 *     GET https://tilecache.norgeibilder.no/wmts/webmercator/...
 *     → {"error":{"code":499,"message":"Token Required"}}
 *
 * Verifisert med curl. Tenesta krev eit abonnement/token som denne appen ikkje
 * har og ikkje kan skaffe seg utan ein avtale. Å leggje inn eit token i
 * frontend-koden ville dessutan vore å publisere det.
 *
 * Esri sitt `World_Imagery` er derimot allereie i bruk i appen — det er eitt av
 * bakgrunnslaga i `MapManager.js` (linje ~85), fritt tilgjengeleg utan nøkkel,
 * med `Access-Control-Allow-Origin: *` (verifisert med curl mot ein ekte flis).
 * Same kjelde i 2D-kartet og i 3D-panoramaet er dessutan eit poeng i seg sjølv:
 * brukaren ser det SAME biletet i begge visingane.
 *
 * ===========================================================================
 * INGEN PROXY, INGEN CSP-ENDRING
 * ===========================================================================
 * Flisane vert henta som `<img crossOrigin="anonymous">`, ikkje med `fetch()`.
 * Det er ikkje ein detalj:
 *
 *  - `fetch()` ville falle under CSP-direktivet `connect-src`, som her berre er
 *    `'self'` (alle eksterne API-kall går gjennom PHP-backenden). Ein
 *    biletehenting fell derimot under `img-src`, som ALLEREIE listar
 *    `server.arcgisonline.com` for Leaflet sin skuld. Null CSP-endring.
 *  - `crossOrigin="anonymous"` er likevel naudsynt: utan det vert lerretet
 *    «taint»-a, og WebGL nektar å laste opp eit taint-a lerret som tekstur.
 *    Esri sitt `Access-Control-Allow-Origin: *` gjer at det går.
 *  - Nettlesaren sin eigen HTTP-cache tek repetisjonar gratis
 *    (`Cache-Control: max-age=86400` frå Esri).
 *
 * ===========================================================================
 * EIN OPPLØYSINGSPYRAMIDE, IKKJE EIN TEKSTUR
 * ===========================================================================
 * Ein einaste tekstur over heile 40 × 40 km-ruta må velje mellom to vonde:
 * anten få flisar og grovt nærfelt, eller fin oppløysing og fleire hundre
 * flisar. Web Mercator har jamn oppløysing, men eit panorama har det ikkje —
 * bakken 200 m unna fyller mange gonger så mange pikslar på skjermen som
 * bakken 15 km unna.
 *
 * Difor fleire teksturar med kvar sin zoom (`CONFIG.panorama.satellitt.ringar`),
 * ved 64° nord:
 *
 *   0–900 m   z=16   ~1,0 m/piksel   ~56 flisar
 *   0–4 km    z=14   ~4,2 m/piksel   ~72 flisar
 *   0–20 km   z=12   ~17 m/piksel   ~121 flisar
 *
 * At z=16 faktisk BER detalj i norsk utmark er kontrollert på ei flis ved
 * Storheia: einskildtre og små tjern er tydelege, altså er det ekte ortofoto
 * og ikkje ei oppskalert z=13-flis.
 *
 * Terrengmeshen vert delt på dei same radiane. Grenseringa av vertexar finst i
 * BEGGE nabomeshane med identiske posisjonar (berre ulike UV-ar), så det er
 * inga sprekk i skøyten — berre eit brått hopp i detaljnivå, som er nøyaktig
 * det auget forventar når noko kjem nærare.
 *
 * Berre den YTTERSTE ringen er obligatorisk: han dekkjer heile scenen. Dei
 * indre er reine forbetringar og kan falle bort kvar for seg.
 */

import { CONFIG } from '../config.js';
import { destinasjon } from './geo.js';

const S = CONFIG.panorama.satellitt;
const FLIS = 256;

/**
 * Klientside-cache, same grunn som `Horizon.js` sin: å opne, lukke og opne
 * panoramaet att skal ikkje koste 170 nye flishentingar.
 *
 * Cachen held LERRETA, ikkje THREE-teksturane — dei siste vert `dispose()`-a
 * når panoramaet lukkast, medan eit lerret er billeg å lage ein ny tekstur av.
 * Kvart lerret er 20–40 MB, så cachen er hard-avgrensa til to punkt.
 *
 * @type {Map<string, object>}
 */
const cache = new Map();
const MAKS_CACHE = 2;

/** Tøm cachen (brukast av testar). */
export function tomSatellittCache() {
    cache.clear();
}

function nokkelFor(punkt) {
    return `${punkt.lat.toFixed(5)},${punkt.lon.toFixed(5)}`;
}

/** Finst dekket allereie? Styrer om UI-et melder framdrift. */
export function harSatellittdekke(punkt) {
    return cache.has(nokkelFor(punkt));
}

// =======================================================================
// WEB MERCATOR
// =======================================================================

/**
 * Lat/lon → «verdspiksel» i Web Mercator (EPSG:3857) på gitt zoom.
 *
 * Dette er den standardiserte slippy-map-formelen som Leaflet, OSM og alle
 * WMTS-klientar bruker — ikkje ein ny projeksjon. Ein flis er 256 × 256 av
 * desse pikslane, så flisindeksen er berre `floor(px / 256)`.
 */
export function verdspiksel(lat, lon, z) {
    const n = FLIS * 2 ** z;
    const la = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const s = Math.sin((la * Math.PI) / 180);
    return [
        ((lon + 180) / 360) * n,
        (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n,
    ];
}

/**
 * UV-koordinat for eit lat/lon-punkt i ein ferdig bygd ring.
 *
 * `flipY` på ein `CanvasTexture` er `true` som standard, altså peikar v = 0 mot
 * NEDRE kant av biletet, medan lerretets y veks nedover. Difor `1 −`.
 */
export function uvIRing(ring, lat, lon) {
    const [px, py] = verdspiksel(lat, lon, ring.z);
    return [
        (px - ring.origoPx.x) / ring.breddePx,
        1 - (py - ring.origoPx.y) / ring.hogdPx,
    ];
}

// =======================================================================
// PLANLEGGING
// =======================================================================

/**
 * Vel zoomnivå og flisrektangel for ein ring.
 *
 * Går frå høgast tillate zoom og nedover til flisrekninga og lerretstorleiken
 * er innanfor budsjettet. Å velje zoom ut frå ei ønska meter-per-piksel i
 * staden ville gitt vilt ulike flistal på 58° og 71° nord, sidan
 * Mercator-oppløysinga går som cos(lat).
 *
 * @returns {object|null} null om ringen ikkje lèt seg dekkje forsvarleg
 */
function planleggRing(punkt, radiusM, maksFlisar) {
    const [nordLat] = destinasjon(punkt.lat, punkt.lon, 0, radiusM);
    const [sorLat] = destinasjon(punkt.lat, punkt.lon, 180, radiusM);
    const [, austLon] = destinasjon(punkt.lat, punkt.lon, 90, radiusM);
    const [, vestLon] = destinasjon(punkt.lat, punkt.lon, 270, radiusM);

    // Datolinja. Gjeld ingen norsk lokalitet, men eit stille feil bilete er
    // verre enn ein ærleg fallback.
    if (austLon <= vestLon) return null;

    for (let z = S.maksZoom; z >= S.minZoom; z--) {
        const grense = 2 ** z - 1;
        const [xV] = verdspiksel(punkt.lat, vestLon, z);
        const [xA] = verdspiksel(punkt.lat, austLon, z);
        const [, yN] = verdspiksel(nordLat, punkt.lon, z);
        const [, yS] = verdspiksel(sorLat, punkt.lon, z);

        const tx0 = Math.max(0, Math.floor(xV / FLIS));
        const tx1 = Math.min(grense, Math.floor(xA / FLIS));
        const ty0 = Math.max(0, Math.floor(yN / FLIS));
        const ty1 = Math.min(grense, Math.floor(yS / FLIS));

        const nx = tx1 - tx0 + 1;
        const ny = ty1 - ty0 + 1;
        if (nx < 1 || ny < 1) continue;
        if (nx * ny > maksFlisar) continue;
        if (nx * FLIS > S.maksPiksel || ny * FLIS > S.maksPiksel) continue;

        return {
            z,
            radiusM,
            tx0, ty0, nx, ny,
            origoPx: { x: tx0 * FLIS, y: ty0 * FLIS },
            breddePx: nx * FLIS,
            hogdPx: ny * FLIS,
            talFlisar: nx * ny,
            /** Meter per piksel ved punktets breiddegrad — går i HUD-teksten. */
            mPerPiksel: (40075016.686 * Math.cos((punkt.lat * Math.PI) / 180))
                / (FLIS * 2 ** z),
        };
    }
    return null;
}

// =======================================================================
// HENTING
// =======================================================================

/** Éin flis som `<img>`, med tidsavbrot. Resolvar til null ved feil. */
function hentFlis(url, signal) {
    return new Promise((resolve) => {
        const img = new Image();
        let ferdig = false;
        const svar = (v) => {
            if (ferdig) return;
            ferdig = true;
            clearTimeout(t);
            resolve(v);
        };
        const t = setTimeout(() => {
            img.src = '';
            svar(null);
        }, S.flisTimeoutMs);

        // MÅ stå FØR .src, elles gjeld han ikkje for den forespurnaden.
        img.crossOrigin = 'anonymous';
        img.decoding = 'async';
        img.onload = () => svar(img);
        img.onerror = () => svar(null);
        signal?.addEventListener('abort', () => { img.src = ''; svar(null); }, { once: true });
        img.src = url;
    });
}

function flisUrl(z, x, y) {
    // Merk rekkefølgja: Esri sitt ArcGIS-endepunkt er .../{z}/{y}/{x} — RAD før
    // KOLONNE, motsett av OSM sitt /{z}/{x}/{y}. Same mal som MapManager.js.
    return S.urlMal.replace('{z}', z).replace('{y}', y).replace('{x}', x);
}

/**
 * Teikn alle flisane i ein ring inn på eitt lerret.
 *
 * @returns {Promise<{feila:number}>}
 */
async function byggRing(ring, signal, paaFlis) {
    const c = document.createElement('canvas');
    c.width = ring.breddePx;
    c.height = ring.hogdPx;
    const g = c.getContext('2d');

    // Grunnfyll FØRST. Feilar ein flis, står det ei nøytral terrengfarge der i
    // staden for gjennomsiktig svart — «fail visibly degraded», ikkje eit hol.
    g.fillStyle = S.grunnfarge;
    g.fillRect(0, 0, c.width, c.height);

    const oppgaver = [];
    for (let iy = 0; iy < ring.ny; iy++) {
        for (let ix = 0; ix < ring.nx; ix++) {
            oppgaver.push({ ix, iy, x: ring.tx0 + ix, y: ring.ty0 + iy });
        }
    }

    let feila = 0;
    const ko = [...oppgaver];
    await Promise.all(Array.from(
        { length: Math.min(S.samtidigeKall, ko.length) },
        async () => {
            while (ko.length > 0) {
                if (signal?.aborted) return;
                const o = ko.shift();
                if (!o) return;
                const img = await hentFlis(flisUrl(ring.z, o.x, o.y), signal);
                if (img) {
                    try {
                        g.drawImage(img, o.ix * FLIS, o.iy * FLIS, FLIS, FLIS);
                    } catch { feila++; }
                } else {
                    feila++;
                }
                paaFlis?.();
            }
        },
    ));

    ring.lerret = c;
    ring.feila = feila;
    return { feila };
}

/**
 * Hent flyfotodekke rundt eit punkt.
 *
 * Kastar ALDRI på nettverksfeil — returnerer `null` i staden, og panoramaet
 * fell tilbake til den prosedyregenererte fargelegginga. Same «fail visibly
 * degraded, never fail closed»-linje som resten av appen.
 *
 * @param {object} args
 * @param {{lat:number, lon:number}} args.punkt
 * @param {number} [args.maksAvstandM]
 * @param {AbortSignal} [args.signal]
 * @param {(ferdig:number, totalt:number) => void} [args.paaFramdrift]
 * @param {(ring:object) => void} [args.paaRing] Kvar ring når HO er ferdig,
 *        ikkje når heile dekket er det. Ringane er uavhengige lerret, så ein
 *        ferdig ring kan drapérast på meshen med det same — sjå
 *        `PanoramaView.oppdaterSatellitt()`. Kallast ALDRI for ein ring som
 *        ikkje lét seg planleggje, og heller ikkje frå cache-treffet: der er
 *        heile dekket klart uansett.
 * @returns {Promise<object|null>}
 */
export async function hentSatellittdekke({
    punkt,
    maksAvstandM = CONFIG.panorama.maksAvstandM,
    signal,
    paaFramdrift,
    paaRing,
} = {}) {
    if (!S?.paa) return null;

    const nokkel = nokkelFor(punkt);
    const treff = cache.get(nokkel);
    if (treff) return treff;

    const start = performance.now();

    // Ringane er alt sorterte frå innerst til ytterst i CONFIG, og
    // `_byggTerreng()` reknar med den rekkefølgja når han deler meshen.
    const planlagt = S.ringar.map((spek, i) => ({
        ...planleggRing(punkt, spek.radiusM ?? maksAvstandM, spek.maksFlisar) ?? {},
        _ytterst: i === S.ringar.length - 1,
    }));

    // Den ytterste ringen dekkjer heile scenen og kan ikkje manglast. Dei
    // indre er forbetringar; fell ein av dei bort, vert det berre grovare der.
    const ytterst = planlagt[planlagt.length - 1];
    if (!ytterst?.z) return null;

    const ringar = planlagt.filter((r) => r.z);
    const totalt = ringar.reduce((n, r) => n + r.talFlisar, 0);
    let ferdige = 0;
    const tell = () => { paaFramdrift?.(++ferdige, totalt); };

    try {
        await Promise.all(ringar.map(async (r) => {
            await byggRing(r, signal, tell);
            if (signal?.aborted) return;
            /**
             * EIN RING VERT LEVERT NÅR HAN ER FERDIG, IKKJE NÅR ALLE ER DET.
             *
             * Same terskel som det globale kravet under, berre målt på
             * ringen sjølv: er meir enn halvparten av flisane borte, er
             * «biletet» meir hol enn foto, og prosedyrefargen er ærlegare.
             * Den globale testen står framleis — ho kan forkaste eit dekke
             * som alt er drapert, og då fell panoramaet tilbake.
             */
            if (r.feila > r.talFlisar / 2) return;
            paaRing?.(r);
        }));
    } catch (e) {
        console.warn('Flyfoto: henting feila heilt, fell tilbake:', e.message);
        return null;
    }
    if (signal?.aborted) return null;

    const feila = ringar.reduce((n, r) => n + r.feila, 0);

    // Gjekk meir enn halvparten av flisane tapt, er «biletet» meir hol enn
    // foto. Då er den prosedyregenererte fargelegginga ærlegare.
    if (feila > totalt / 2) {
        console.warn(`Flyfoto: ${feila} av ${totalt} flisar feila — fell tilbake.`);
        return null;
    }

    const dekke = {
        ringar,
        talFlisar: totalt,
        feila,
        attribusjon: S.attribusjon,
        hentaMs: Math.round(performance.now() - start),
    };

    if (cache.size >= MAKS_CACHE) cache.delete(cache.keys().next().value);
    cache.set(nokkel, dekke);
    return dekke;
}
