/**
 * js/utils/ErrorReporter.js
 *
 * Sentralisert klient-feilrapportering — same mønster som PolitiKartet sin
 * `ErrorReporter.js` (jf. TECH_STACK.md): fangar `window.onerror` og
 * `unhandledrejection`, pluss eksplisitte "stille" feil resten av appen kan
 * melde inn sjølv, og sender alt til éin PHP-endepunkt
 * (`backend/api/log_error.php`).
 *
 * Dedupliserer per sideøkt (same melding+linje rapporterast berre éin gong)
 * og set eit hardt tak på tal rapportar/økt — ein feil i ei render-løkke skal
 * ikkje kunne sende hundrevis av identiske kall.
 *
 * Brukar `navigator.sendBeacon` når det finst (overlever sideavslutning/
 * navigasjon betre enn fetch), med `fetch(..., {keepalive:true})` som
 * fallback.
 */

const MAKS_RAPPORTAR_PER_OKT = 20;
const ENDEPUNKT = 'backend/api/log_error.php';

let sendt = 0;
const settRapporterte = new Set();

function send(payload) {
    if (sendt >= MAKS_RAPPORTAR_PER_OKT) return;

    const nokkel = `${payload.melding}|${payload.url}|${payload.linje}`;
    if (settRapporterte.has(nokkel)) return;
    settRapporterte.add(nokkel);
    sendt++;

    const body = JSON.stringify(payload);
    try {
        if (navigator.sendBeacon) {
            const blob = new Blob([body], { type: 'application/json' });
            navigator.sendBeacon(ENDEPUNKT, blob);
            return;
        }
    } catch {
        // fell gjennom til fetch
    }
    fetch(ENDEPUNKT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
    }).catch(() => {
        // Ein feilrapport som sjølv feilar skal ikkje kaste vidare.
    });
}

/**
 * Meld inn ein feil eksplisitt (t.d. i ein catch-blokk der appen alt handterer
 * feilen for brukaren via Toast, men me framleis vil ha han i loggen).
 */
export function meldFeil(type, error, ekstra = {}) {
    send({
        type,
        melding: error?.message ?? String(error),
        stack: (error?.stack ?? '').slice(0, 4000),
        url: location.pathname,
        linje: ekstra.linje ?? '?',
    });
}

/** Registrer dei globale fangarane. Kall éin gong ved oppstart. */
export function initErrorReporter() {
    window.addEventListener('error', (e) => {
        send({
            type: 'onerror',
            melding: e.message ?? 'Ukjend feil',
            stack: (e.error?.stack ?? '').slice(0, 4000),
            url: e.filename ?? location.pathname,
            linje: e.lineno ?? '?',
        });
    });

    window.addEventListener('unhandledrejection', (e) => {
        const reason = e.reason;
        send({
            type: 'unhandledrejection',
            melding: reason?.message ?? String(reason),
            stack: (reason?.stack ?? '').slice(0, 4000),
            url: location.pathname,
            linje: '?',
        });
    });
}
