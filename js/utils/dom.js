/**
 * js/utils/dom.js
 *
 * Små DOM- og formateringshjelparar.
 *
 * `escHtml()` er obligatorisk på ALL data som går inn i `innerHTML`.
 * Turbin- og anleggsnamn kjem frå eit eksternt API (NVE) og skal difor
 * behandlast som utrygg input, sjølv om kjelda er offentleg og truverdig.
 * DOMPurify lastast bevisst ikkje (jf. TECH_STACK.md) — manuell escaping er
 * føreseieleg og har ingen "sanitize hvis lasta, elles raw"-fallgruve.
 */

/** Escape HTML-spesialteikn. Alltid brukt på ekstern/brukarstyrt data. */
export function escHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Kort id-basert oppslag. */
export const $ = (id) => document.getElementById(id);

/**
 * Sett av/på-tilstanden til ein brytar-knapp: både den visuelle `.aktiv`-klassa
 * og `aria-pressed`, slik at skjermlesarar høyrer om t.d. «Anleggsområde» eller
 * «Hinderlys» er på. Éin stad, so dei to aldri kjem ut av takt.
 */
export function settBrytar(el, paa) {
    if (!el) return;
    el.classList.toggle('aktiv', paa);
    el.setAttribute('aria-pressed', String(Boolean(paa)));
}

/**
 * Eit tal slik det skal STÅ I TEKST: desimalkomma og ekte minusteikn.
 *
 * `toFixed()` skriv alltid punktum, og heile grensesnittet er på norsk —
 * «53.4 dB» og «1.75 km» les som engelsk i ei setning som elles ikkje er det.
 * Alt som vert VIST går difor gjennom her. Koordinatar gjer det med vilje
 * ikkje: «63,87000, 10,10000» er to tal som ser ut som fire, og dei skal
 * dessutan kunne limast rett inn i eit kart.
 *
 * `Intl.NumberFormat('nn-NO')` ville gitt det same, men òg tusenskilje og eit
 * resultat som avheng av kva ICU-data nettlesaren har. To `replace` gjer
 * nøyaktig det som trengst, likt overalt.
 *
 * @param {number} verdi
 * @param {number} [desimalar] Fast tal desimalar. Utelate → talet slik det er.
 */
export function fmtTal(verdi, desimalar) {
    if (!Number.isFinite(verdi)) return '–';
    const tekst = desimalar === undefined ? String(verdi) : verdi.toFixed(desimalar);
    return tekst.replace('.', ',').replace('-', '−');
}

/**
 * Vis eller skjul eit overlegg (3D-panoramaet, fotomontasjen) — òg for
 * skjermlesarar og tastatur, ikkje berre for auga.
 *
 * Overlegga er berre gjennomsiktige når dei er lukka (`opacity: 0`), så
 * kontrollane inni dei kunne framleis nåast med Tab. `inert` tek dei ut av
 * både tab-rekkjefølgja og tilgjengetreet.
 *
 * Og FOKUSET MÅ UT FØR overlegget vert skjult. Lukkar brukaren med
 * «Lukk»-knappen, står fokus på han i det `aria-hidden` vert sett, og Chrome
 * blokkerer då `aria-hidden` med ei åtvaring: skjermlesaren ville stått att på
 * eit element som ikkje lenger finst. Fokus går difor tilbake til knappen som
 * opna overlegget — funnen på nytt med `tilbakeTil`, sidan sidepanelet kan ha
 * teikna han på nytt i mellomtida.
 *
 * @param {HTMLElement|null} el
 * @param {boolean} vis
 * @param {string} [tilbakeTil] CSS-veljar for elementet fokus skal tilbake til
 */
export function settOverlegg(el, vis, tilbakeTil) {
    if (!el) return;
    if (!vis && el.contains(document.activeElement)) {
        const maal = tilbakeTil ? document.querySelector(tilbakeTil) : null;
        if (maal && !maal.disabled) maal.focus();
        else document.activeElement.blur();
    }
    el.classList.toggle('open', vis);
    el.inert = !vis;
    el.setAttribute('aria-hidden', String(!vis));
}

/**
 * Formater avstand med fornuftig presisjon: meter under 1 km, elles km.
 */
export function fmtAvstand(meter) {
    if (!Number.isFinite(meter)) return '–';
    if (meter < 1000) return `${Math.round(meter)} m`;
    if (meter < 10000) return `${fmtTal(meter / 1000, 2)} km`;
    return `${fmtTal(meter / 1000, 1)} km`;
}

/** Formater eit desibelnivå. */
export function fmtDb(db) {
    return Number.isFinite(db) ? `${fmtTal(db, 1)} dB` : '–';
}

/** Formater ei høgd i meter over havet. */
export function fmtMoh(m) {
    return Number.isFinite(m) ? `${Math.round(m)} moh.` : '–';
}

/** Formater ein prosentdel frå ein brøk 0–1. */
export function fmtProsent(brok) {
    if (!Number.isFinite(brok)) return '–';
    const p = brok * 100;
    if (p > 0 && p < 1) return '<1 %';
    return `${Math.round(p)} %`;
}

/**
 * Formater eit timetal med presisjon som passar storleiken.
 *
 * Under ein time seier «12 minutt» meir enn «0,2 timar»; over ti timar er
 * desimalen støy. Skyggekast-tal spenner over begge, så formatet må følgje med.
 */
export function fmtTimar(timar) {
    if (!Number.isFinite(timar)) return '–';
    if (timar <= 0) return '0';
    if (timar < 1) return `${Math.round(timar * 60)} min`;
    if (timar < 10) return `${fmtTal(timar, 1)} t`;
    return `${Math.round(timar)} t`;
}

/** Formater ein ISO-dato som norsk dato. */
export function fmtDato(iso) {
    if (!iso) return '–';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '–';
    return d.toLocaleDateString('nn-NO', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * Debounce — ventar til det har gått `ventMs` utan nye kall.
 * Brukast på kart-panorering og andre hendingar som kjem i tette salvar.
 *
 * Den returnerte funksjonen har ein `.avbryt()` som kastar eit ventande kall.
 *
 * KVIFOR `.avbryt()` TRENGST — ein reell feil den fanga:
 * Analysen teiknar panelet på nytt for kvar ferdige batch (debouncet), og ein
 * siste gong når ALT er ferdig. Utan `.avbryt()` låg det framleis eit ventande
 * debounce-kall i kø når den siste teikninga skjedde, og det fyrte 120 ms
 * seinare med det ufullstendige delresultatet — som overskreiv samandraget med
 * ein versjon utan skyggekast. Symptomet var at skyggekast-boksen forsvann frå
 * samandraget, medan ikona på kvar enkelt turbinrad vart ståande.
 */
export function debounce(fn, ventMs) {
    let timer = null;
    const wrapped = (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ventMs);
    };
    wrapped.avbryt = () => {
        clearTimeout(timer);
        timer = null;
    };
    return wrapped;
}
