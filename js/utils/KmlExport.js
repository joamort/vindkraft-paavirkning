/**
 * js/utils/KmlExport.js
 *
 * Eksporterer turbindata til KML — ei enkel, opprinneleg XML-fil (ikkje
 * zippa til KMZ). Google Earth og Google My Maps opnar/importerer eit
 * `.kml` heilt likt eit `.kmz` — den einaste skilnaden er at KMZ er ein KML
 * pakka i ein ZIP for å bunte inn bilete/ikon. Turbinane her bruker Google
 * sitt eige, alltid tilgjengelege ikonsett (`maps.google.com/mapfiles/kml/`),
 * så det er ingenting å pakke inn. Å skrive ein ZIP-encoder berre for
 * filendinga ville vore ein ny avhengigheit for null praktisk gevinst — jf.
 * TECH_STACK.md sitt "kvart bibliotek må rettferdiggjerast".
 *
 * To eksportar:
 *   - byggKmlAlleTurbinar()       – heile (filtrerte) datasettet, gruppert i
 *                                   KML-mapper per status, same fargar som kartet.
 *   - byggKmlAnalyserteTurbinar() – berre turbinane i den analyserte radiusen,
 *                                   med full detaljinfo og siktlinjer frå
 *                                   punktet, farga etter synleg/skjult.
 */

import { CONFIG } from '../config.js';
import { escHtml } from './dom.js';

/** `#rrggbb` → KML sin `aabbggrr`-fargerekkjefølgje (heil dekning). */
function kmlFarge(hex, alfaHex = 'ff') {
    const h = hex.replace('#', '');
    const r = h.slice(0, 2);
    const g = h.slice(2, 4);
    const b = h.slice(4, 6);
    return `${alfaHex}${b}${g}${r}`;
}

/** Standard Google-ikon, farga via `<IconStyle><color>`. */
function ikonStil(id, hexFarge) {
    return `<Style id="${id}">
  <IconStyle>
    <color>${kmlFarge(hexFarge)}</color>
    <scale>1.0</scale>
    <Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon>
  </IconStyle>
  <LabelStyle><scale>0</scale></LabelStyle>
</Style>`;
}

function kmlHeader(tittel) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
<name>${escHtml(tittel)}</name>`;
}

const KML_FOOTER = '</Document>\n</kml>\n';

/**
 * Éin `<Placemark>` for ein turbin, med rik `<description>` i CDATA
 * (treng ikkje escapast — CDATA er rå tekst heilt til `]]>`).
 */
function turbinPlacemark(t, styleId, ekstraBeskriving = '') {
    const namn = t.navn ?? t.anleggnavn ?? 'Ukjend';
    const hoyde = Number.isFinite(t.totalhoyde_m ?? t.totalhoydeM)
        ? `${Math.round(t.totalhoyde_m ?? t.totalhoydeM)} m totalhøgd` : 'høgd ukjend';
    const kjelde = (t.mal_kilde ?? t.malKilde) === 'kjent_soknad' ? 'kjelde: søknadsdokument'
        : (t.mal_kilde ?? t.malKilde) === 'estimert' ? 'kjelde: estimert frå merkeeffekt'
        : '';
    const posKjelde = t.posisjon_kilde ?? t.posisjonKilde;
    const posTekst = posKjelde === 'nve_turbinpunkt' ? 'NVE-verifisert posisjon'
        : posKjelde === 'estimert_i_omrade' ? 'estimert plassering i planområde'
        : posKjelde === 'anlegg_senterpunkt' ? 'plasshaldar for heile anlegget'
        : posKjelde === 'brukerjustert' ? 'flytta/justert av brukar'
        : '';
    const eigar = t.eier ? `Eigar: ${t.eier}` : '';

    const linjer = [hoyde, kjelde, posTekst, eigar, ekstraBeskriving]
        .filter(Boolean)
        .map((l) => escHtml(l))
        .join('<br/>');

    return `<Placemark>
  <name>${escHtml(namn)}</name>
  <styleUrl>#${styleId}</styleUrl>
  <description><![CDATA[${linjer}]]></description>
  <Point><coordinates>${t.lon},${t.lat},0</coordinates></Point>
</Placemark>`;
}

/**
 * Eksporter HEILE (filtrerte) turbindatasettet, gruppert i éi KML-mappe per
 * status — same fargekoding som kartet (`CONFIG.status`).
 *
 * @param {object[]} turbinar
 * @param {Set<string>} statusFilter Tomt sett = alle statusar.
 * @returns {string} KML-dokument
 */
export function byggKmlAlleTurbinar(turbinar, statusFilter) {
    const filtrerte = statusFilter && statusFilter.size > 0
        ? turbinar.filter((t) => statusFilter.has(t.status))
        : turbinar;

    const perStatus = new Map();
    for (const t of filtrerte) {
        const s = t.status ?? 'ukjent';
        if (!perStatus.has(s)) perStatus.set(s, []);
        perStatus.get(s).push(t);
    }

    const stilar = [];
    const mapper = [];
    for (const [status, liste] of perStatus) {
        const stil = CONFIG.status[status] ?? CONFIG.status.ukjent;
        const styleId = `s-${status}`;
        stilar.push(ikonStil(styleId, stil.farge));

        const placemarks = liste.map((t) => turbinPlacemark(t, styleId)).join('\n');
        mapper.push(`<Folder>
<name>${escHtml(stil.tekst)} (${liste.length})</name>
${placemarks}
</Folder>`);
    }

    return kmlHeader('Vindturbinar i Noreg')
        + '\n' + stilar.join('\n')
        + '\n' + mapper.join('\n')
        + '\n' + KML_FOOTER;
}

/**
 * Eksporter dei ANALYSERTE turbinane (`state.resultat`) frå eit gitt punkt,
 * med full detaljinfo og siktlinjer farga etter synleg/skjult — same idé
 * som linjene på sjølve kartet.
 *
 * @param {{lat:number, lon:number}} punkt
 * @param {object[]} resultat Frå `beregnPaaverknad()`/`state.resultat`
 * @returns {string} KML-dokument
 */
export function byggKmlAnalyserteTurbinar(punkt, resultat) {
    const stilSynleg = `<Style id="linje-synleg"><LineStyle><color>${kmlFarge('#16a34a')}</color><width>2</width></LineStyle></Style>`;
    const stilSkjult = `<Style id="linje-skjult"><LineStyle><color>${kmlFarge('#9ca3af', '99')}</color><width>1</width></LineStyle></Style>`;
    const stilPunkt = `<Style id="mitt-punkt"><IconStyle><color>${kmlFarge('#2563eb')}</color><scale>1.3</scale>
    <Icon><href>http://maps.google.com/mapfiles/kml/shapes/star.png</href></Icon></IconStyle></Style>`;

    const statusarIBruk = new Set(resultat.map((r) => r.status));
    const statusStilar = Array.from(statusarIBruk).map((status) => {
        const stil = CONFIG.status[status] ?? CONFIG.status.ukjent;
        return ikonStil(`s-${status}`, stil.farge);
    });

    const puntPlacemark = `<Placemark>
  <name>Mitt punkt</name>
  <styleUrl>#mitt-punkt</styleUrl>
  <Point><coordinates>${punkt.lon},${punkt.lat},0</coordinates></Point>
</Placemark>`;

    const delar = resultat.map((r) => {
        const synleg = r.analysert && r.synlegheit?.synlegDel > 0.02;
        const ekstra = r.analysert
            ? `${r.synlegheit?.tekst ?? ''}${r.avstandM ? ` · ${(r.avstandM / 1000).toFixed(1)} km` : ''}`
            : 'Ikkje analysert (manglar terrengprofil)';

        const styleId = `s-${r.status ?? 'ukjent'}`;
        const placemark = turbinPlacemark(r, styleId, ekstra);

        let linje = '';
        if (r.analysert && Number.isFinite(r.lat) && Number.isFinite(r.lon)) {
            linje = `<Placemark>
  <styleUrl>#${synleg ? 'linje-synleg' : 'linje-skjult'}</styleUrl>
  <LineString>
    <tessellate>1</tessellate>
    <coordinates>${punkt.lon},${punkt.lat},0 ${r.lon},${r.lat},0</coordinates>
  </LineString>
</Placemark>`;
        }
        return `${placemark}\n${linje}`;
    }).join('\n');

    return kmlHeader('Vindturbinar — analysert frå mitt punkt')
        + '\n' + stilSynleg + '\n' + stilSkjult + '\n' + stilPunkt
        + '\n' + statusStilar.join('\n')
        + '\n' + puntPlacemark
        + '\n' + delar
        + '\n' + KML_FOOTER;
}

/** Trigg ei filnedlasting av ein tekststreng, utan noka server-tur. */
export function lastNedFil(filnamn, innhald, mime = 'application/vnd.google-earth.kml+xml') {
    const blob = new Blob([innhald], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filnamn;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Ikkje riv ned url-en synkront — Firefox har trunkert nedlastinga om
    // objectURL-en vert oppheva før nettlesaren har lese ferdig blob-en.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
