/**
 * js/ui/ImpactPanel.js
 *
 * Sidepanelet: samandrag øvst, turbinliste sortert på avstand, og detaljvising
 * med høgdeprofil for vald turbin.
 *
 * CSP-TRYGG: ingen inline `onclick=`. All interaksjon går gjennom
 * `data-action`-attributt og ÉIN delegert lyttar (mønster frå TagTrack).
 * All tekst frå datakjelda køyrast gjennom `escHtml()`.
 */

import { CONFIG } from '../config.js';
import { escHtml, fmtAvstand, fmtDb, fmtMoh, fmtProsent, fmtTimar, $ } from '../utils/dom.js';
import { stoykategori, formaterStoy } from '../utils/NoiseModel.js';
import { magnitudeTekst } from '../utils/ObstacleLights.js';
import { MANADER, dagTilDato } from '../utils/ShadowFlicker.js';
import { JUSTERT_KILDE } from '../utils/TurbinJustering.js';
import { overflateSamandrag, kanEndrastAvOverflate } from '../utils/SurfaceCheck.js';
import { ProfileChart } from './ProfileChart.js';

/** Ikon per synlegheitskategori. */
const SYNLEG_IKON = {
    synleg: { ikon: 'fa-eye', klasse: 'syn-synleg' },
    delvis: { ikon: 'fa-eye-low-vision', klasse: 'syn-delvis' },
    saa_vidt: { ikon: 'fa-eye-low-vision', klasse: 'syn-savidt' },
    skjult: { ikon: 'fa-eye-slash', klasse: 'syn-skjult' },
    ukjent: { ikon: 'fa-circle-question', klasse: 'syn-ukjent' },
};

/** Menneskeleg etikett for `kjelde_status` i det kuraterte registeret. */
const KJELDE_STATUS_TEKST = {
    planinitiativ: 'planinitiativ',
    melding: 'melding til NVE',
    planprogram: 'planprogram/melding',
    ku_program_fastsatt: 'KU-program fastsett av NVE',
    soknad: 'konsesjonssøknad',
    vedtak: 'NVE-vedtak',
    bygd: 'som bygd',
};

/** Felt i `mal_spenn` → korleis dei skal lesast i UI. */
const SPENN_ETIKETT = {
    totalhoyde_m: ['totalhøgd', 'm'],
    nav_hoyde_m: ['navhøgd', 'm'],
    rotor_diameter_m: ['rotor', 'm'],
    effekt_mw_per_turbin: ['effekt', 'MW'],
};

/**
 * Kva me kan seie om turbinmåla for eitt resultat.
 *
 * To tilfelle: `kjent_soknad` (tala er lesne ut av eit offentleg søknads- eller
 * meldingsdokument, og kjelda skal visast) og `estimert` (rekna ut frå
 * merkeeffekt). Skiljet må vere synleg i UI — det er forskjellen på eit tal
 * nokon har søkt om og eit tal me har gjetta oss til.
 */
function malOpplysning(r) {
    if (r.malKilde !== 'kjent_soknad' || !r.malKjeldeUrl) {
        return {
            merkeKlasse: 'merke-estimat',
            merkeTekst: 'estimert',
            spennTekst: null,
            kjeldeHtml: '',
            atterhald: `Navhøgd, rotordiameter og lydeffekt finst <strong>ikkje</strong> i NVE sitt
                        datasett og er her rekna ut frå merkeeffekt per turbin.`,
        };
    }

    // Spenn: «søknaden opnar for 200–260 m totalhøgd, 5–8 MW».
    const delar = [];
    for (const [felt, [namn, eining]] of Object.entries(SPENN_ETIKETT)) {
        const par = r.malSpenn?.[felt];
        if (Array.isArray(par) && par.length === 2) {
            delar.push(`${namn} ${par[0]}–${par[1]} ${eining}`);
        }
    }
    const spennTekst = delar.length ? `Søknaden opnar for ${delar.join(', ')} — appen viser øvste ende.` : null;

    // Berre http(s) slepp gjennom som lenke. Registeret er vår eiga fil, men ei
    // href frå data skal aldri kunne bli `javascript:`.
    const trygg = /^https?:\/\//i.test(r.malKjeldeUrl) ? r.malKjeldeUrl : null;
    const statusTekst = r.malKjeldeStatus
        ? (KJELDE_STATUS_TEKST[r.malKjeldeStatus] ?? r.malKjeldeStatus)
        : null;

    const kjeldeHtml = `
        <div class="mal-kjelde">
            ${trygg
                ? `<a href="${escHtml(trygg)}" target="_blank" rel="noopener noreferrer">
                       <i class="fa-solid fa-file-lines"></i> Kjelde${statusTekst ? `: ${escHtml(statusTekst)}` : ''}${
                           r.malKjeldeDato ? ` (${escHtml(r.malKjeldeDato)})` : ''}
                   </a>`
                : `<span class="hint">Kjelde${statusTekst ? `: ${escHtml(statusTekst)}` : ''}</span>`}
            ${r.malNotat ? `<span class="hint">${escHtml(r.malNotat)}</span>` : ''}
        </div>`;

    // Kva som faktisk stod i dokumentet, og kva me har rekna oss fram til.
    const utleidd = Array.isArray(r.malUtleidd) && r.malUtleidd.length
        ? ` Måla som ikkje stod i dokumentet (${r.malUtleidd
              .map((f) => SPENN_ETIKETT[f]?.[0] ?? f).join(', ')}) er rekna ut frå dei som gjorde det.`
        : '';

    return {
        merkeKlasse: 'merke-kjelde',
        merkeTekst: 'frå søknad',
        spennTekst,
        kjeldeHtml,
        atterhald: `Turbinmåla er henta frå eit offentleg planleggings-/søknadsdokument for dette
                    anlegget, ikkje frå NVE sitt kartdatasett (som ikkje har slike felt).
                    <strong>Det som er søkt om, er ikkje nødvendigvis det som vert bygd.</strong>${utleidd}`,
    };
}

export class ImpactPanel {
    /**
     * @param {object} handlingar Callbacks: { paaVeljTurbin, paaLukkDetalj }
     */
    constructor(handlingar = {}) {
        this.handlingar = handlingar;
        this.graf = new ProfileChart('profil-graf');
        this._bindDelegert();
    }

    /**
     * Éin delegert lyttar for heile panelet. Nye knappar treng berre eit
     * `data-action`-attributt — ingen ny lyttar, ingen inline handler.
     */
    _bindDelegert() {
        const panel = $('sidepanel');
        if (!panel) return;

        panel.addEventListener('click', (e) => {
            const el = e.target.closest('[data-action]');
            if (!el) return;

            const { action, id } = el.dataset;
            switch (action) {
                case 'velg-turbin':
                    this.handlingar.paaVeljTurbin?.(id);
                    break;
                case 'vis-panorama':
                    this.handlingar.paaVisPanorama?.();
                    break;
                case 'fotomontasje':
                    this.handlingar.paaFotomontasje?.();
                    break;
                case 'lukk-detalj':
                    this.handlingar.paaLukkDetalj?.();
                    break;
                case 'tilbakestill-posisjon':
                    this.handlingar.paaTilbakestillPosisjon?.(id);
                    break;
                case 'sjekk-overflate':
                    this.handlingar.paaSjekkOverflate?.();
                    break;
                case 'del-lenke':
                    this.handlingar.paaDelLenke?.();
                    break;
                case 'eksporter-analyserte':
                    this.handlingar.paaEksporterAnalyse?.();
                    break;
                case 'skriv-ut':
                    this.handlingar.paaRapport?.();
                    break;
                default:
                    break;
            }
        });
    }

    // -------------------------------------------------------- tomtilstand

    visStartmelding() {
        const el = $('panel-innhald');
        if (!el) return;
        el.innerHTML = `
            <div class="tomtilstand">
                <i class="fa-solid fa-hand-pointer"></i>
                <h2>Vel eit punkt</h2>
                <p>Klikk i kartet der du vil vurdere påverknaden — til dømes på bustaden din.
                   Trykk så <strong>«Analyser her»</strong>. Appen finn då alle vindturbinar i
                   nærleiken og reknar ut kva som faktisk er synleg frå akkurat det punktet,
                   ut frå terrenget mellom.</p>
                <!--
                  Teksten MÅ liggje i eit eige span. .tomtilstand-hint er ein
                  flex-container, så kvar <kbd> og kvar tekstbit mellom dei
                  ville blitt sitt eige flex-element — og på ein smal skjerm
                  braut avsnittet opp i ei stolpe med eitt ord per linje.
                -->
                <p class="tomtilstand-hint">
                    <i class="fa-solid fa-lightbulb"></i>
                    <span>Klikk så mange gonger du vil — analysen startar først når du stadfestar,
                    så eit feilklikk kostar ingenting. <kbd>Enter</kbd> stadfestar,
                    <kbd>Esc</kbd> forkastar.</span>
                </p>
            </div>`;
    }

    // -------------------------------------------------------- stadfesting

    /**
     * Be brukaren stadfeste kandidatpunktet før analysen køyrer.
     *
     * Boksen ligg over kartet, ikkje i sidepanelet. To grunnar: han skal stå
     * rett ved markøren han gjeld, og sidepanelet kan vera skjult på mobil —
     * ein stadfestingsknapp brukaren ikkje ser, er ingen stadfesting.
     *
     * Han overskriv aldri resultata frå eit tidlegare punkt. Det er sjølve
     * poenget: eit feilklikk skal korkje koste nettverkskall eller det
     * arbeidet brukaren allereie har fått gjort.
     */
    visStadfesting({ lat, lon, radiusM, harResultat }) {
        const el = $('stadfest');
        if (!el) return;

        el.innerHTML = `
            <div class="stadfest-boks">
                <div class="stadfest-tekst">
                    <strong>Nytt punkt valt</strong>
                    <span>${lat.toFixed(5)}, ${lon.toFixed(5)} · radius ${Math.round(radiusM / 1000)} km</span>
                    <span class="stadfest-hint">
                        ${harResultat
                            ? 'Resultata under gjeld framleis det førre punktet.'
                            : 'Analysen hentar terrengdata for kvar turbin i radiusen.'}
                        Klikk fritt i kartet for å flytte punktet.
                    </span>
                </div>
                <div class="stadfest-knappar">
                    <button type="button" class="knapp knapp-primaer" data-action="stadfest-punkt">
                        <i class="fa-solid fa-play"></i> Analyser her
                    </button>
                    <button type="button" class="ikonknapp" data-action="avbryt-punkt" aria-label="Forkast punktet">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>`;
        el.classList.add('synleg');
    }

    skjulStadfesting() {
        const el = $('stadfest');
        if (!el) return;
        el.classList.remove('synleg');
        el.innerHTML = '';
    }

    // ----------------------------------------------------------- framdrift

    /**
     * @param {number} ferdig
     * @param {number} totalt
     * @param {string} [tekst] Kva som hentast. DOM-kryssjekken er eit eige
     *                         steg brukaren har bedt om, og må kunne seie kva
     *                         han ventar på — «Hentar terrengdata» ville lese
     *                         som at heile analysen gjekk om att.
     */
    visFramdrift(ferdig, totalt, tekst = 'Hentar terrengdata') {
        const el = $('framdrift');
        if (!el) return;
        if (ferdig >= totalt) {
            el.classList.remove('synleg');
            return;
        }
        el.classList.add('synleg');
        const prosent = totalt > 0 ? Math.round((ferdig / totalt) * 100) : 0;
        el.innerHTML = `
            <div class="framdrift-tekst">${escHtml(tekst)} … ${ferdig} av ${totalt}</div>
            <div class="framdrift-spor"><div class="framdrift-fyll" style="width:${prosent}%"></div></div>`;
    }

    skjulFramdrift() {
        $('framdrift')?.classList.remove('synleg');
    }

    // ---------------------------------------------------------- hovudvising

    /**
     * Teikn samandrag + turbinliste.
     *
     * @param {object} args
     * @param {object} args.punkt
     * @param {object[]} args.resultat
     * @param {object} args.samandrag
     * @param {object|null} args.samlaStoy
     * @param {boolean} args.avkorta
     * @param {number} args.radiusM
     */
    tegn({ punkt, resultat, samandrag, samlaStoy, avkorta, radiusM, overflateKoyrer = false, panoramaKoyrer = false }) {
        const el = $('panel-innhald');
        if (!el) return;

        el.innerHTML = `
            ${this._samandragHtml({ punkt, samandrag, samlaStoy, avkorta, radiusM, resultat, overflateKoyrer, panoramaKoyrer })}
            ${this._listeHtml(resultat)}
        `;
    }

    /**
     * Kor stor del av synsranda turbinane opptek, og kor mange separate anlegg
     * — SNH-guiden legg vekt på begge. Union av synsvinklane, ikkje sum
     * (kumulativHorisont() i ImpactCalculator).
     */
    _horisontbelastningHtml(kh) {
        if (!kh || kh.gradar <= 0) return '';
        const R = ['nord', 'nordaust', 'aust', 'søraust', 'sør', 'sørvest', 'vest', 'nordvest'];
        const retning = kh.midtKurs == null ? '' : ` mot ${R[Math.round(kh.midtKurs / 45) % 8]}`;
        const anlegg = kh.anlegg > 1 ? ` · ${kh.anlegg} anlegg` : '';
        return `<dt>Horisontbelastning</dt>
                <dd>Turbinane fyller <strong>${kh.gradar}°</strong> av synsranda${retning}${anlegg}</dd>`;
    }

    _samandragHtml({ punkt, samandrag, samlaStoy, avkorta, radiusM, resultat, overflateKoyrer, panoramaKoyrer }) {
        const s = samandrag;
        const stoyKat = stoykategori(samlaStoy?.ldenDb ?? null);

        const naermast = s.naermaste
            ? `${fmtAvstand(s.naermaste.avstandM)} mot ${escHtml(s.naermaste.retning)}`
            : '–';

        const naermastSynleg = s.naermasteSynlege
            ? `${escHtml(s.naermasteSynlege.navn)}, ${fmtAvstand(s.naermasteSynlege.avstandM)}`
            : 'Ingen synlege';

        // Nærskjerming er eit viktig atterhald: heng resultatet på terreng
        // like ved punktet, er det svært følsamt for kvar brukaren klikka.
        const naerskjermingVarsel = s.naerskjerma > 0 ? `
            <div class="varsel varsel-info">
                <i class="fa-solid fa-circle-info"></i>
                <div>
                    <strong>${s.naerskjerma} av ${s.analyserte}</strong> turbinar er skjulte av terreng
                    <strong>heilt inntil punktet</strong> (under 300 m unna). Slike resultat endrar seg
                    mykje om du flyttar punktet nokre titals meter — prøv å dra det litt for å sjå
                    kor følsamt det er.
                </div>
            </div>` : '';

        const avkortaVarsel = avkorta ? `
            <div class="varsel varsel-info">
                <i class="fa-solid fa-layer-group"></i>
                <div>Det er fleire turbinar innanfor ${Math.round(radiusM / 1000)} km enn dei
                    ${CONFIG.analyse.maksTurbinar} næraste som er analyserte her. Reduser radius
                    for eit fullstendig bilete av nærområdet.</div>
            </div>` : '';

        return `
            <section class="samandrag" aria-label="Samandrag">
                <div class="samandrag-topp">
                    <div>
                        <h2>Påverknad ved punktet</h2>
                        <p class="punkt-info">
                            ${punkt.lat.toFixed(5)}, ${punkt.lon.toFixed(5)}
                            · bakke ${fmtMoh(punkt.hoyde)}
                            ${punkt.terreng ? `· ${escHtml(punkt.terreng)}` : ''}
                        </p>
                    </div>
                </div>

                <div class="nokkeltal">
                    <div class="nokkeltal-kort">
                        <span class="nt-verdi">${s.synlege}<span class="nt-av">/${s.analyserte}</span></span>
                        <span class="nt-etikett">synlege turbinar</span>
                    </div>
                    <div class="nokkeltal-kort">
                        <span class="nt-verdi">${s.rotorSynlege}</span>
                        <span class="nt-etikett">med rotor i fri sikt</span>
                    </div>
                    <div class="nokkeltal-kort">
                        <span class="nt-verdi">${naermast.split(' ')[0]}<span class="nt-av"> ${naermast.split(' ').slice(1).join(' ')}</span></span>
                        <span class="nt-etikett">næraste turbin</span>
                    </div>
                </div>

                <dl class="samandrag-detaljar">
                    <dt>Næraste synlege</dt><dd>${naermastSynleg}</dd>
                    <dt>Mest dominerande</dt>
                    <dd>${s.mestDominerande
                        ? `${escHtml(s.mestDominerande.navn)} — ${escHtml(s.mestDominerande.dominans.tekst.toLowerCase())}
                           (${s.mestDominerande.dominans.synsvinkelGrader.toFixed(1)}° synsvinkel)`
                        : 'Ingen synlege turbinar'}</dd>
                    ${this._horisontbelastningHtml(s.kumulativHorisont)}
                </dl>

                <div class="stoy-boks ${stoyKat.klasse}">
                    <div class="stoy-topp">
                        <span class="stoy-etikett">Samla støyestimat</span>
                        <span class="stoy-verdi">${samlaStoy ? formaterStoy(samlaStoy.ldenDb) : '–'}</span>
                    </div>
                    <div class="stoy-under">
                        <span>${escHtml(stoyKat.tekst)}</span>
                        ${samlaStoy ? `<span class="stoy-lpa">L<sub>pA</sub> ${fmtDb(samlaStoy.lpDb)}</span>` : ''}
                    </div>
                    <p class="stoy-forklaring">
                        Estimert L<sub>den</sub> frå alle turbinar innanfor
                        ${CONFIG.stoy.maksRelevantAvstandM / 1000} km, summert energetisk.
                        T-1442 sin rettleiande grense for vindkraft er L<sub>den</sub> 45 dB.
                        <strong>Dette er eit grovt estimat, ikkje ein akustisk fagrapport.</strong>
                    </p>
                </div>

                ${this._overflateSamandragHtml(resultat, overflateKoyrer)}
                ${this._hinderlysSamandragHtml(s)}
                ${this._skyggekastSamandragHtml(s)}
                <div class="visualknappar">
                    ${panoramaKoyrer
                        ? `<button type="button" class="knapp brei" data-action="vis-panorama" disabled><i class="fa-solid fa-spinner fa-spin"></i> Byggjer 3D-panorama …</button>`
                        : `<button type="button" class="knapp brei" data-action="vis-panorama"><i class="fa-solid fa-panorama"></i> Vis 3D-panorama</button>`}
                    <button type="button" class="knapp brei" data-action="fotomontasje"><i class="fa-solid fa-images"></i> Fotomontasje</button>
                </div>
                ${this._delEksporterHtml(resultat)}
                ${naerskjermingVarsel}
                ${avkortaVarsel}
            </section>`;
    }

    /**
     * DEL OG EKSPORTER — flytta hit frå topplinja.
     *
     * Desse tre handlingane gir berre meining når det finst eit analysert
     * punkt, og «Del punkt» krev berre punktet medan dei to andre krev eit
     * turbinresultat. Dei låg før alltid synlege i topplinja og svarte med
     * ein toast om dei vart trykte for tidleg; her dukkar dei opp når dei
     * faktisk kan brukast, ved sida av 3D-panorama/fotomontasje.
     */
    _delEksporterHtml(resultat) {
        const harResultat = resultat.length > 0;
        return `
            <div class="del-eksporter">
                <button type="button" class="knapp brei" data-action="del-lenke"
                        title="Kopier ei delbar lenke til dette punktet">
                    <i class="fa-solid fa-link"></i> Del punkt
                </button>
                ${harResultat ? `
                <button type="button" class="knapp brei" data-action="eksporter-analyserte"
                        title="Last ned dei analyserte turbinane med siktlinjer som KML (Google Earth)">
                    <i class="fa-solid fa-file-export"></i> Eksporter analyse (KML)
                </button>
                <button type="button" class="knapp brei" data-action="skriv-ut"
                        title="Éin-sides rapport for punktet — skriv ut eller lagre som PDF">
                    <i class="fa-solid fa-file-pdf"></i> Rapport (PDF)
                </button>` : ''}
            </div>`;
    }

    /**
     * SKOG OG BYGNINGAR — DOM-kryssjekken (CLAUDE.md §22).
     *
     * =======================================================================
     * DENNE BOKSEN ER EIN KRYSSJEKK, IKKJE EIT NYTT HOVUDTAL
     * =======================================================================
     * Alt ovanfor i samandraget er rekna på bar bakke, og skal halde fram med
     * å vere det appen svarer. Denne boksen legg til det motsette
     * spørsmålet — «kva om me tek med skogen?» — og han er med vilje
     * plassert ETTER nøkkeltala og støyen, ikkje mellom dei: han skal lesast
     * som eit atterhald med tal, ikkje som ei ny fasit.
     *
     * Han er òg med vilje IKKJE køyrd automatisk. Sjekken kostar eitt
     * Kartverket-oppslag per unike kritiske punkt, og dei aller fleste som
     * klikkar rundt på kartet spør aldri om han. Difor ein knapp.
     */
    _overflateSamandragHtml(resultat, koyrer) {
        const o = overflateSamandrag(resultat);
        if (o.kandidatar === 0 && o.alleredeSkjulte === 0) return '';

        const K = CONFIG.overflate;

        // Ingenting å sjekke: alt er allereie skjult av bar bakke. Sidan DOM
        // berre kan heve horisonten, er svaret kjent utan eit einaste kall.
        if (o.kandidatar === 0) {
            return `
                <div class="skog-boks skog-ingen">
                    <div class="skog-topp">
                        <span class="skog-etikett"><i class="fa-solid fa-tree"></i> Skog og bygningar</span>
                    </div>
                    <div class="skog-under">
                        Alle ${o.alleredeSkjulte} analyserte turbinane er allereie skjulte av sjølve terrenget.
                        Skog og bygningar kan berre gjere synlegheita mindre, aldri større, så her endrar
                        dei ingenting.
                    </div>
                </div>`;
        }

        if (koyrer) {
            return `
                <div class="skog-boks">
                    <div class="skog-topp">
                        <span class="skog-etikett"><i class="fa-solid fa-tree"></i> Skog og bygningar</span>
                        <span class="skog-verdi"><i class="fa-solid fa-spinner fa-spin"></i></span>
                    </div>
                    <div class="skog-under">Slår opp overflatemodellen …</div>
                </div>`;
        }

        // Ikkje køyrd enno — knappen, og kva han vil koste.
        if (o.sjekka === 0) {
            return `
                <div class="skog-boks skog-tilbod">
                    <div class="skog-topp">
                        <span class="skog-etikett"><i class="fa-solid fa-tree"></i> Skog og bygningar</span>
                    </div>
                    <div class="skog-under">
                        Tala over er rekna på <strong>bar bakke</strong> — Kartverkets terrengmodell har
                        korkje skog eller hus. Appen kan slå opp <strong>overflatemodellen</strong> i dei
                        <strong>${K.toppK} punkta</strong> der eit hinder ville bety mest for kvar turbin, og
                        vise kva som skjer når det som står på bakken vert teke med.
                    </div>
                    <button type="button" class="knapp brei" data-action="sjekk-overflate">
                        <i class="fa-solid fa-tree"></i> Sjekk skog og bygningar
                        <span class="knapp-hint">${o.kandidatar} turbinar</span>
                    </button>
                </div>`;
        }

        const endra = o.skjulte + o.reduserte;
        const klasse = o.skjulte > 0 ? 'skog-endrar' : (endra > 0 ? 'skog-noko' : 'skog-ingen');

        return `
            <div class="skog-boks ${klasse}">
                <div class="skog-topp">
                    <span class="skog-etikett"><i class="fa-solid fa-tree"></i> Med skog og bygningar</span>
                    <span class="skog-verdi">${o.skjulte}<span class="skog-eining">/${o.sjekka}</span></span>
                </div>
                <div class="skog-under">
                    ${o.skjulte > 0
                        ? `<strong>${o.skjulte}</strong> av dei ${o.sjekka} synlege turbinane vert
                           <strong>heilt skjulte</strong> når skogen eller bygningen på det avgjerande
                           punktet vert rekna med.`
                        : `Ingen av dei ${o.sjekka} synlege turbinane vert heilt skjulte.`}
                    ${o.reduserte > 0 ? ` ${o.reduserte} til får mindre synleg del.` : ''}
                    ${o.mistarRotor > 0
                        ? ` <strong>${o.mistarRotor}</strong> mistar rotoren ut av fri sikt.`
                        : ''}
                </div>
                ${o.vesentlege > 0 ? `
                    <p class="skog-forklaring">
                        Det høgaste hinderet som vart målt står <strong>${o.stersteHinderM.toFixed(1)} m</strong>
                        over bakken — ${o.stersteHinderM >= K.typiskSkoghoydeM
                            ? 'på høgd med vaksen granskog'
                            : 'ein skogteig, eit einskilt tre eller eit bygg'}.
                        ${o.umalte > 0 ? `${o.umalte} punkt ligg utanfor laserdekninga og er ikkje vurderte.` : ''}
                    </p>` : `
                    <p class="skog-forklaring">
                        Overflata ligg under ${K.terskelM} m over bakken i alle dei avgjerande punkta —
                        altså ope terreng utan skog eller bygningar som betyr noko.
                    </p>`}
                ${o.fraToppK > 0 ? `
                    <p class="skog-forklaring">
                        For <strong>${o.fraToppK}</strong> av dei var det avgjerande hinderet eit
                        <em>anna</em> punkt enn det bare terrenget peikar ut — typisk noko som står
                        nærare deg, der eit tre treng langt mindre høgd for å dekkje like mykje.
                    </p>` : ''}
                ${o.naerskjerma > 0 ? `
                    <div class="varsel varsel-info liten">
                        <i class="fa-solid fa-circle-info"></i>
                        <div>
                            For <strong>${o.naerskjerma}</strong> av dei står hinderet
                            <strong>under 300 m frå punktet</strong>. Eit tre like ved dekkjer alt bak
                            seg, uansett kor langt unna det står — så desse svara endrar seg mykje om
                            du flyttar punktet nokre titals meter. Dra punktet litt for å sjå kor
                            følsamt det er.
                        </div>
                    </div>` : ''}
                <p class="skog-atterhald">
                    <i class="fa-solid fa-circle-info"></i>
                    Sjekken ser på <strong>inntil ${K.toppK} punkt per turbin</strong>: det terrengpunktet
                    som avgjer siktlinja på bar bakke, og dei punkta der eit hinder på
                    ${K.kandidatHinderM} m ville løfte horisonten mest. Blir turbinen skjult der, er han
                    skjult. Men står han framleis som synleg, er det <strong>ikkje eit bevis på fri
                    sikt</strong> — skogen kan stå i eit av dei punkta me ikkje slo opp. Svaret er
                    framleis ei <strong>nedre grense</strong> for kor mykje vegetasjonen skjermar.
                    Laserdataen kan dessutan vere fleire år gammal: er skogen hoggen sidan, står han
                    framleis i modellen.
                </p>
            </div>`;
    }

    /**
     * HINDERLYS — samandrag for punktet.
     *
     * Bevisst formulert som «kor mange lyspunkt ser eg», ikkje «kor mange
     * turbinar er merkepliktige». Det er lyspunkta som pregar nattbiletet, og
     * ein turbin kan bidra med opptil fire av dei.
     */
    _hinderlysSamandragHtml(s) {
        const hl = s.hinderlys;
        if (!hl || hl.merkepliktige === 0) return '';

        const mag = hl.sterkasteMagnitude;
        const magTekst = mag !== null ? magnitudeTekst(mag) : null;

        const ingen = hl.lyspunktSynlege === 0;

        return `
            <details class="natt-boks sam-fald ${ingen ? 'natt-ingen' : ''}">
                <summary class="natt-topp">
                    <span class="natt-etikett"><i class="fa-solid fa-moon"></i> Hinderlys om natta</span>
                    <span class="natt-verdi">${hl.lyspunktSynlege}</span>
                    <i class="fa-solid fa-chevron-down sam-fald-pil"></i>
                </summary>
                <div class="natt-under">
                    ${ingen
                        ? 'Ingen av dei påbodne hinderlysa er synlege frå dette punktet.'
                        : `synlege lyspunkt frå <strong>${hl.medSynlegTopplys}</strong> turbinar
                           ${hl.kviteBlinkande > 0
                                ? `· <strong>${hl.kviteBlinkande}</strong> med kvitt blinkande topplys (turbin ≥ 150 m)`
                                : ''}`}
                </div>
                ${!ingen && magTekst ? `
                    <p class="natt-forklaring">
                        Det sterkaste lyspunktet er <strong>${escHtml(magTekst)}</strong> sett frå punktet
                        (tilsynelatande magnitude ${mag.toFixed(1)} ved klar natt).
                        Eit lyspunkt med høg kontrast mot ein mørk himmel er ofte
                        <strong>meir iaugefallande enn rotorblada er om dagen</strong> —
                        dagsynlegheita krev kontrast mot terrenget, medan lyset berre krev mørke.
                    </p>` : ''}
                <p class="natt-atterhald">
                    <i class="fa-solid fa-circle-info"></i>
                    Dette er kva <strong>forskrifta krev som minimum</strong> (FOR-2014-07-15-980 § 16),
                    ikkje ei registrering av kva som står montert. Sidan 2024 kan konsesjonæren søkje om
                    <strong>behovsstyrt lyssetting (ADLS)</strong>, der lyset er avslege til det kjem fly —
                    og for anlegg med fem eller fleire turbinar kan Luftfartstilsynet godkjenne at berre
                    turbinane i <strong>ytterkanten</strong> vert merkte. NVE-datasettet seier ingenting om
                    kva anlegg dette gjeld, så biletet her er eit <strong>maksimum</strong>.
                </p>
            </details>`;
    }

    /**
     * SKYGGEKAST — samandrag for punktet.
     *
     * Talet som visast er UNIONEN over turbinar (kvart minutt tel éin gong),
     * fordi det er tida punktet er utsett som NVE si grense gjeld.
     */
    _skyggekastSamandragHtml(s) {
        const sk = s.skyggekast;
        if (!sk) return '';

        if (sk.turbinarMedSkygge === 0) {
            return `
                <details class="skygge-boks sam-fald skygge-ingen">
                    <summary class="skygge-topp">
                        <span class="skygge-etikett"><i class="fa-solid fa-sun"></i> Skyggekast</span>
                        <span class="skygge-verdi">0</span>
                        <i class="fa-solid fa-chevron-down sam-fald-pil"></i>
                    </summary>
                    <div class="skygge-under">
                        Ingen av dei ${sk.turbinarVurderte} turbinane innanfor skyggekast-avstand
                        kan geometrisk kaste rotorskugge på dette punktet.
                    </div>
                </details>`;
        }

        const K = CONFIG.skyggekast;
        const overAar = sk.overGrenseAar;
        const overDag = sk.overGrenseDag;
        const klasse = (overAar || overDag) ? 'skygge-hoy' : 'skygge-lav';

        return `
            <details class="skygge-boks sam-fald ${klasse}">
                <summary class="skygge-topp">
                    <span class="skygge-etikett"><i class="fa-solid fa-sun"></i> Skyggekast (teoretisk)</span>
                    <span class="skygge-verdi">${fmtTimar(sk.timarPerAar)}<span class="skygge-eining">/år</span></span>
                    <i class="fa-solid fa-chevron-down sam-fald-pil"></i>
                </summary>
                <div class="skygge-under">
                    <span>Verste dag: <strong>${Math.round(sk.maksMinuttPerDag)} min</strong></span>
                    <span>${sk.dagarMedSkygge} dagar i året</span>
                    <span>frå ${sk.turbinarMedSkygge} turbinar</span>
                </div>

                <div class="skygge-terskel">
                    <span class="pille ${overAar ? 'stoy-hoy' : 'stoy-lav'}">
                        ${overAar ? 'over' : 'under'} ${K.grenseTimarPerAar} t/år
                    </span>
                    <span class="pille ${overDag ? 'stoy-hoy' : 'stoy-lav'}">
                        ${overDag ? 'over' : 'under'} ${K.grenseMinuttPerDag} min/dag
                    </span>
                </div>

                <p class="skygge-forklaring">
                    NVE tilrår at bygningar med skyggekastfølsam bruk ikkje vert utsette for
                    <strong>teoretisk</strong> skyggekast meir enn ${K.grenseTimarPerAar} timar i året eller
                    ${K.grenseMinuttPerDag} minutt om dagen. <strong>Noreg har inga fastsett grenseverdi</strong> —
                    dette er forvaltningspraksis frå NVE veileder 2/2014, ikkje forskrift.
                </p>
                <p class="skygge-atterhald">
                    «Teoretisk» tyder skyfri himmel heile året og rotoren alltid vend rett mot sola.
                    Det <em>faktiske</em> skyggekastet er alltid lågare — NVE si grense for faktisk
                    skyggekast er ${K.faktiskGrenseTimarPerAar} t/år, altså om lag ein tredel av den teoretiske.
                    Same forhold på talet over gir grovt <strong>~${fmtTimar(sk.illustrativtFaktiskTimarPerAar)}/år</strong>,
                    men det er ei illustrasjon, ikkje ein prognose: det krev sky- og vindstatistikk me ikkje har.
                </p>
            </details>`;
    }

    /**
     * KALENDER-VARMEKART: 12 månader × 24 timar.
     *
     * Teikna som eit CSS-rutenett med seks intensitetsklassar, ikkje som eit
     * Chart.js-diagram. Chart.js v4 har ingen matrise-/varmekarttype utan
     * tilleggsplugin, og eit rutenett på 288 celler er uansett raskare og meir
     * lesbart som rein DOM — og held seg innanfor CSP-en utan inline-stilar.
     */
    _kalenderHtml(kalender, tittel) {
        const maks = Math.max(...kalender);
        if (!(maks > 0)) return '';

        // Vis berre timane som faktisk har skygge — eit døgn på 24 kolonnar
        // der 17 av dei er tomme er berre støy i eit smalt panel.
        const timarMedVerdi = [];
        for (let h = 0; h < 24; h++) {
            for (let m = 0; m < 12; m++) {
                if (kalender[m * 24 + h] > 0) { timarMedVerdi.push(h); break; }
            }
        }
        if (timarMedVerdi.length === 0) return '';
        const hMin = Math.max(0, Math.min(...timarMedVerdi) - 1);
        const hMaks = Math.min(23, Math.max(...timarMedVerdi) + 1);

        const nivaa = (v) => {
            if (v <= 0) return 0;
            const del = v / maks;
            if (del > 0.75) return 5;
            if (del > 0.5) return 4;
            if (del > 0.25) return 3;
            if (del > 0.08) return 2;
            return 1;
        };

        let rader = '';
        for (let m = 0; m < 12; m++) {
            let celler = '';
            for (let h = hMin; h <= hMaks; h++) {
                const v = kalender[m * 24 + h];
                celler += `<div class="kal-celle kal-n${nivaa(v)}"
                                title="${escHtml(MANADER[m])} kl. ${h}–${h + 1}: ${Math.round(v)} min"></div>`;
            }
            rader += `<div class="kal-rad"><span class="kal-manad">${escHtml(MANADER[m])}</span>
                          <div class="kal-celler">${celler}</div></div>`;
        }

        const timeEtikettar = [];
        for (let h = hMin; h <= hMaks; h++) {
            timeEtikettar.push(`<div class="kal-time">${h}</div>`);
        }

        return `
            <div class="kalender">
                <div class="kal-tittel">${escHtml(tittel)}</div>
                <div class="kal-rutenett" style="--kal-kolonnar:${hMaks - hMin + 1}">
                    ${rader}
                    <div class="kal-rad kal-akse"><span class="kal-manad"></span>
                        <div class="kal-celler">${timeEtikettar.join('')}</div></div>
                </div>
                <div class="kal-forklaring">
                    <span>Lokal tid. Mørkare = fleire minutt.</span>
                    <span class="kal-skala">
                        <i class="kal-celle kal-n1"></i><i class="kal-celle kal-n2"></i>
                        <i class="kal-celle kal-n3"></i><i class="kal-celle kal-n4"></i>
                        <i class="kal-celle kal-n5"></i>
                        <em>maks ${Math.round(maks)} min</em>
                    </span>
                </div>
            </div>`;
    }

    _listeHtml(resultat) {
        if (resultat.length === 0) {
            return `<div class="tomtilstand liten">
                        <i class="fa-solid fa-wind"></i>
                        <p>Ingen turbinar innanfor radiusen med dei valde statusane.</p>
                    </div>`;
        }

        const rader = resultat.map((r) => this._radHtml(r)).join('');
        return `
            <section class="turbinliste" aria-label="Turbinar sortert på avstand">
                <h3>Turbinar <span class="tal">${resultat.length}</span></h3>
                <ul class="turbin-ul">${rader}</ul>
            </section>`;
    }

    _radHtml(r) {
        const syn = SYNLEG_IKON[r.synlegheit.nokkel] ?? SYNLEG_IKON.ukjent;
        const stoyKat = stoykategori(r.stoy?.ldenDb ?? null);
        const erPlassholdar = r.posisjonKilde === 'anlegg_senterpunkt';
        const erEstimert = r.posisjonKilde === 'estimert_i_omrade';
        const erFlytta = r.posisjonKilde === JUSTERT_KILDE;

        // Eigar står i lista fordi det ofte er det første ein lurer på når ein
        // ser eit anleggsnamn ein ikkje kjenner — men han vert korta ned, sidan
        // panelet er smalt og namna er lange («… HOLDING AS»).
        const eier = r.eier
            ? `<span class="rad-eier" title="${escHtml(r.eier)}">${escHtml(kortEigar(r.eier))}</span>`
            : '';

        return `
            <li>
                <button type="button" class="turbin-rad" data-action="velg-turbin" data-id="${escHtml(r.id)}">
                    <span class="rad-ikon ${syn.klasse}" title="${escHtml(r.synlegheit.tekst)}">
                        <i class="fa-solid ${syn.ikon}"></i>
                    </span>
                    <span class="rad-hovud">
                        <span class="rad-namn">
                            ${escHtml(r.navn)}
                            ${erPlassholdar ? '<span class="merke merke-anlegg" title="Posisjonen er anleggets senterpunkt, ikkje ein faktisk turbinposisjon">heile anlegget</span>' : ''}
                            ${erEstimert ? '<span class="merke merke-estimert-pos" title="Posisjonen er estimert av oss inne i det verkelege planområdet — ikkje ein omsøkt turbinposisjon. Dra markøren i kartet for å korrigere.">estimert plassering</span>' : ''}
                            ${erFlytta ? `<span class="merke merke-flytta" title="Du har sjølv dratt denne turbinen${
                                Number.isFinite(r.flyttAvstandM) ? ` ${Math.round(r.flyttAvstandM)} m` : ''
                            } frå plasseringa appen estimerte"><i class="fa-solid fa-arrows-up-down-left-right"></i> flytta av deg</span>` : ''}
                        </span>
                        ${eier}
                        <!--
                          Metalinja held seg kort med vilje. Panelet er smalt, og
                          dominanskategorien ("mindre framtredande" o.l.) er lang
                          nok til å presse ut synlegheitsprosenten — som er det
                          mest informative talet i lista. Dominansen står i
                          detaljvisinga i staden.
                        -->
                        <span class="rad-meta">
                            ${fmtAvstand(r.avstandM)} ${escHtml(r.retning)}
                            ${r.analysert && r.synlegheit.nokkel !== 'skjult'
                                ? `· ${fmtProsent(r.synlegheit.synlegDel)} synleg` : ''}
                            ${r.analysert && r.synlegheit.navSynleg ? ' · rotor fri' : ''}
                            ${r.hinderlys?.toppSynleg
                                ? `<i class="fa-solid fa-circle rad-lys ${r.hinderlys.hoyintensitet ? 'rad-lys-kvit' : 'rad-lys-raud'}"
                                      title="Påbode hinderlys på toppen er synleg herfrå"></i>` : ''}
                            ${r.skyggekast?.minuttPerAar > 0
                                ? `<i class="fa-solid fa-sun rad-skygge"
                                      title="Teoretisk skyggekast ${fmtTimar(r.skyggekast.timarPerAar)}/år"></i>` : ''}
                            ${r.overflate?.endring === 'skjult'
                                ? `<i class="fa-solid fa-tree rad-skog rad-skog-skjult"
                                      title="Skjult når skog/bygningar vert rekna med (${
                                          r.overflate.differanseM.toFixed(1)} m over bakken ${
                                          fmtAvstand(r.overflate.kritiskD)} unna)"></i>`
                                : (r.overflate?.endring === 'redusert'
                                    ? `<i class="fa-solid fa-tree rad-skog"
                                          title="Mindre synleg med skog/bygningar: ${
                                              fmtProsent(r.overflate.synlegheit.synlegDel)} mot ${
                                              fmtProsent(r.synlegheit.synlegDel)} på bar bakke"></i>`
                                    : '')}
                        </span>
                    </span>
                    <span class="rad-hale">
                        ${r.stoy
                            ? `<span class="rad-stoy ${stoyKat.klasse}">${formaterStoy(r.stoy.ldenDb, true)} dB</span>`
                            : '<span class="rad-stoy tom">–</span>'}
                        <i class="fa-solid fa-chevron-right rad-pil"></i>
                    </span>
                </button>
            </li>`;
    }

    // ------------------------------------------------------------- detalj

    /**
     * Vis detaljvisinga for éin turbin, med høgdeprofil.
     *
     * @param {object} r
     * @param {{overflateKoyrer?:boolean}} [opts] Om DOM-oppslaget for nettopp
     *        denne turbinen er undervegs. Skil «me har ikkje svaret enno» frå
     *        «me fekk ikkje svar» — utan det ville ein feila sjekk sett ut som
     *        ein evig spinnar.
     */
    visDetalj(r, opts = {}) {
        const el = $('detalj-panel');
        if (!el || !r) return;

        const syn = SYNLEG_IKON[r.synlegheit.nokkel] ?? SYNLEG_IKON.ukjent;
        const stoyKat = stoykategori(r.stoy?.ldenDb ?? null);
        const erPlassholdar = r.posisjonKilde === 'anlegg_senterpunkt';
        const mal = malOpplysning(r);

        const kritisk = r.synlegheit.kritiskPunkt;
        const blokkering = (r.analysert && r.synlegheit.nokkel !== 'synleg' && kritisk)
            ? `<p class="blokkering">
                   Sikta bryt mot terreng <strong>${fmtAvstand(kritisk.d)}</strong> frå punktet,
                   på <strong>${fmtMoh(kritisk.z)}</strong>${kritisk.terreng ? ` (${escHtml(kritisk.terreng)})` : ''}.
               </p>` : '';

        const naerskjerming = r.synlegheit.naerskjerming
            ? `<div class="varsel varsel-info liten">
                   <i class="fa-solid fa-circle-info"></i>
                   <div>Hinderet ligg heilt inntil punktet. Flytt punktet nokre titals meter
                        for å sjå kor følsamt dette resultatet er.</div>
               </div>` : '';

        el.innerHTML = `
            <div class="detalj-topp">
                <div>
                    <h3>${escHtml(r.navn)}</h3>
                    <p class="detalj-undertittel">
                        ${fmtAvstand(r.avstandM)} mot ${escHtml(r.retning)}
                        · ${escHtml(CONFIG.status[r.status]?.tekst ?? 'Ukjend status')}
                    </p>
                </div>
                <button type="button" class="ikonknapp" data-action="lukk-detalj" aria-label="Lukk detaljar">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>

            <div class="detalj-status ${syn.klasse}">
                <i class="fa-solid ${syn.ikon}"></i>
                <div>
                    <strong>${escHtml(r.synlegheit.tekst)}</strong>
                    ${r.analysert
                        ? `<span>${fmtProsent(r.synlegheit.synlegDel)} av turbinhøgda over terrenghorisonten${
                            r.synlegheit.navSynleg ? ', rotoren står fritt' : ''}</span>`
                        : '<span>Terrengdata mangla for denne turbinen</span>'}
                </div>
            </div>

            ${blokkering}
            ${this._overflateDetaljHtml(r, opts.overflateKoyrer)}
            ${naerskjerming}
            ${this._justertPosisjonHtml(r)}

            <div class="graf-boks">
                <canvas id="profil-graf" aria-label="Høgdeprofil mellom punktet og turbinen"></canvas>
            </div>

            <dl class="detalj-tabell">
                <dt>Visuell dominans</dt>
                <dd>${escHtml(r.dominans.tekst)}
                    <span class="hint">(${r.dominans.rd.toFixed(1)} rotordiameter unna)</span></dd>

                <dt>Synsvinkel</dt>
                <dd>${Number.isFinite(r.dominans.synsvinkelGrader)
                        ? `${r.dominans.synsvinkelGrader.toFixed(2)}° av synsfeltet`
                        : '<span class="hint">Ikkje rekna — terrengdata mangla</span>'}
                    ${Number.isFinite(r.dominans.synsvinkelFullGrader)
                      && r.dominans.synsvinkelFullGrader > r.dominans.synsvinkelGrader
                        ? `<span class="hint">(${r.dominans.synsvinkelFullGrader.toFixed(2)}° utan terrengskjerming)</span>` : ''}</dd>

                <dt>Støyestimat</dt>
                <dd>${r.stoy
                    ? `<span class="pille ${stoyKat.klasse}">L<sub>den</sub> ${formaterStoy(r.stoy.ldenDb)}</span>
                       <span class="hint">L<sub>pA</sub> ${fmtDb(r.stoy.lpDb)}${
                        r.stoy.skjermingDb > 0 ? `, ${r.stoy.skjermingDb.toFixed(1)} dB terrengskjerming` : ''}</span>`
                    : `<span class="hint">Ikkje rekna — over ${CONFIG.stoy.maksRelevantAvstandM / 1000} km unna</span>`}</dd>

                <dt>Terreng ved turbinen</dt>
                <dd>${fmtMoh(r.bakkeVedTurbinMoh)}
                    <span class="hint">vengetupp ${fmtMoh(r.tuppMoh)}</span></dd>

                <dt>Turbinmål <span class="merke ${mal.merkeKlasse}">${mal.merkeTekst}</span></dt>
                <dd>Navhøgd ${Math.round(r.navHoydeM)} m · rotor ${Math.round(r.rotorDiameterM)} m
                    · totalhøgd ${Math.round(r.totalhoydeM)} m
                    ${r.effektMw ? `<span class="hint">${r.effektMw} MW per turbin</span>` : ''}
                    ${mal.spennTekst ? `<span class="hint">${escHtml(mal.spennTekst)}</span>` : ''}
                    ${mal.kjeldeHtml}</dd>

                <dt>Eigar</dt>
                <dd>${r.eier ? escHtml(r.eier) : '<span class="hint">Ikkje oppgitt i NVE-datasettet</span>'}
                    ${r.kommune || r.fylke
                        ? `<span class="hint">${escHtml([r.kommune, r.fylke].filter(Boolean).join(', '))}</span>`
                        : ''}</dd>
            </dl>

            ${this._hinderlysDetaljHtml(r)}
            ${this._skyggekastDetaljHtml(r)}

            <div class="varsel varsel-aatvaring liten">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <div>
                    ${mal.atterhald}
                    ${r.overflate?.vesentleg
                        ? `Terrengprofilen og grafen er bar bakke —
                           <strong>skog og bygningar er ikkje med i dei</strong>. Kryssjekken over
                           slår dei opp i det avgjerande punktet, men berre der.`
                        : `Terrengmodellen er bar bakke —
                           <strong>skog og bygningar er ikkje med</strong>, så synlegheita er truleg overvurdert.`}
                    ${erPlassholdar ? '<br>Posisjonen er anleggets senterpunkt — dei faktiske turbinane står spreidde utover området.' : ''}
                    ${r.posisjonKilde === JUSTERT_KILDE ? `
                        <br><strong>Posisjonen er din eigen.</strong> Terrengprofilen, støyen og
                        skyggekastet er henta og rekna ut på nytt for staden du dro markøren til, men
                        <em>turbinen sjølv</em> — navhøgd, rotor, lydeffekt — er dei same estimerte
                        måla som før. Utbyggjaren har ikkje offentleggjort turbinkoordinatar for dette
                        anlegget i det heile; både appens gjetning og di eiga er illustrasjonar.` : ''}
                    ${r.posisjonKilde === 'estimert_i_omrade' ? `
                        <br><strong>Denne posisjonen er estimert av oss</strong>, ikkje omsøkt. Utbyggjaren har
                        ikkje offentleggjort turbinkoordinatar på dette stadiet. Punktet ligg inne i det
                        <em>verkelege</em> planområdet frå NVE, plassert på ein høgderygg etter same mønster
                        som norske vindparkar faktisk vert lagde ut — men den einskilde koordinaten er ei
                        illustrasjon, ikkje ein plan.
                        <br>Ser du at punktet står openbert feil, kan du <strong>dra markøren i kartet</strong> —
                        analysen vert rekna om for den nye staden med det same.
                        ${r.layoutPlasserte ? `<br>Anlegget er teikna med <strong>${r.layoutPlasserte}</strong>
                            turbinar${r.layoutMaal && r.layoutMaal !== r.layoutPlasserte
                                ? ` (anslaget var ${r.layoutMaal} — resten fekk ikkje plass i planområdet
                                    med forsvarleg innbyrdes avstand, så anten turbintalet eller
                                    områdeavgrensinga er usikker)` : ''}
                            ${r.layoutAvstandM ? `, med minst ${Math.round(r.layoutAvstandM)} m mellom kvar` : ''}.` : ''}` : ''}
                </div>
            </div>`;

        el.classList.add('open');
        this.graf.tegn(r);
    }

    // ---------------------------------------- detalj: brukarjustert posisjon

    /**
     * «Du har flytta denne turbinen.»
     *
     * Boksen står HØGT i detaljvisinga, rett under synlegheitsstatusen, og
     * ikkje nede blant atterhalda. Grunnen er at han ikkje er eit atterhald om
     * datakvalitet, men ei opplysning om KVEN som har bestemt posisjonen tala
     * under gjeld: alt som står nedanfor — synleg del, støy, skyggekast, kva
     * hinderlys som er synlege — er rekna for brukarens eige punkt, ikkje for
     * det appen sjølv gjetta. Ligg den opplysninga under fem skjermhøgder med
     * tal, er ho i praksis ikkje der.
     *
     * Tilbakestillingsknappen står i same boks, av di det er her spørsmålet
     * «kva var det opphavlege då?» oppstår.
     */
    _justertPosisjonHtml(r) {
        if (r.posisjonKilde !== JUSTERT_KILDE) return '';

        const frå = r.opphavlegPosisjonKilde === 'anlegg_senterpunkt'
            ? 'anleggets senterpunkt'
            : 'plasseringa appen estimerte i planområdet';

        return `
            <div class="justert-boks">
                <div class="justert-topp">
                    <i class="fa-solid fa-arrows-up-down-left-right"></i>
                    <strong>Du har flytta denne turbinen</strong>
                </div>
                <p class="justert-tekst">
                    Alle tala under gjeld posisjonen <strong>du</strong> har dratt markøren til
                    ${Number.isFinite(r.flyttAvstandM)
                        ? `— <strong>${fmtAvstand(r.flyttAvstandM)}</strong> frå ${escHtml(frå)}` : ''}.
                    Dette er <strong>di eiga justering</strong>, ikkje ei ny offisiell opplysning:
                    ingen har søkt om ein turbin akkurat her, og justeringa forsvinn når du lastar
                    sida på nytt.
                </p>
                <button type="button" class="knapp knapp-liten" data-action="tilbakestill-posisjon"
                        data-id="${escHtml(r.id)}">
                    <i class="fa-solid fa-rotate-left"></i> Tilbakestill til appens estimat
                </button>
            </div>`;
    }

    // ------------------------------------------- detalj: skog og bygningar

    /**
     * «Med skog og bygningar» — ved sida av hovudtalet, ikkje i staden for.
     *
     * =======================================================================
     * KVIFOR BEGGE TALA STÅR SAMTIDIG, MED KVAR SI ETIKETT
     * =======================================================================
     * Det freistande hadde vore å berre erstatte synlegheitsprosenten med den
     * DOM-korrigerte, sidan han er «betre». Det ville vore feil på to måtar:
     *
     *  1. Hovudmodellen er bar bakke, og alt anna i appen — støy, hinderlys,
     *     skyggekast, panoramaet — reknar framleis på den. Eit einsleg
     *     korrigert synlegheitstal ville ikkje lenger stemme med resten.
     *  2. Dei to tala svarer på ulike spørsmål. «Bar bakke» er kva landskapet
     *     sjølv gjer, og endrar seg aldri. «Med skog» er kva som står der NO —
     *     og skog vert hoggen.
     *
     * Difor to rader, med DTM-verdien først og DOM-verdien som eit tillegg.
     */
    _overflateDetaljHtml(r, koyrer) {
        if (!r.analysert) return '';

        if (!r.overflate) {
            if (koyrer) {
                return `
                    <div class="skog-detalj skog-ventar">
                        <i class="fa-solid fa-spinner fa-spin"></i>
                        <div>Slår opp skog og bygningar i det avgjerande terrengpunktet …</div>
                    </div>`;
            }
            if (!kanEndrastAvOverflate(r)) {
                // Allereie skjult av bar bakke: svaret er kjent utan oppslag.
                return r.synlegheit.nokkel === 'skjult' ? `
                    <div class="skog-detalj skog-uaktuell">
                        <i class="fa-solid fa-tree"></i>
                        <div>Turbinen er allereie skjult av sjølve terrenget. Skog og bygningar
                             kan berre skjerme meir, aldri mindre — så dei endrar ikkje svaret her.</div>
                    </div>` : '';
            }
            return '';
        }

        const o = r.overflate;
        const K = CONFIG.overflate;

        if (!o.malt) {
            return `
                <div class="skog-detalj skog-uaktuell">
                    <i class="fa-solid fa-tree"></i>
                    <div>Det avgjerande terrengpunktet ligg utanfor Kartverkets laserdekning
                         (${escHtml(o.datakilde)}), så me kan ikkje seie noko om skog eller
                         bygningar der.</div>
                </div>`;
        }

        if (!o.vesentleg) {
            return `
                <div class="skog-detalj skog-open">
                    <i class="fa-solid fa-mountain-sun"></i>
                    <div>
                        <strong>Ope i alle dei ${o.talPunkt ?? 1} punkta som vart sjekka.</strong>
                        Overflatemodellen ligg under terskelen på ${K.terskelM} m over bakken i kvart
                        av dei — i det avgjerande punktet ${fmtAvstand(o.kritiskD)} frå deg berre
                        <strong>${o.differanseM.toFixed(1)} m</strong>. Altså ingen skog eller bygning
                        som betyr noko der eit hinder ville betydd mest.
                    </div>
                </div>`;
        }

        const ny = o.synlegheit;
        const nySyn = SYNLEG_IKON[ny.nokkel] ?? SYNLEG_IKON.ukjent;
        const blir = o.endring === 'skjult';

        /**
         * «Skjult av TERRENG» ville vore direkte feil her.
         *
         * Etiketten kjem frå den felles skalaen i vurderSynlegheit(), som er
         * skriven for bar bakke. I denne boksen er det nettopp IKKJE terrenget
         * som er årsaka — det er skogen eller bygningen oppå det. Same tal,
         * anna årsak, så teksten må byttast.
         */
        const nyTekst = ny.nokkel === 'skjult' ? 'Heilt skjult' : ny.tekst;

        return `
            <div class="skog-detalj ${blir ? 'skog-detalj-skjult' : 'skog-detalj-redusert'}">
                <div class="skog-detalj-topp">
                    <span class="skog-merke"><i class="fa-solid fa-tree"></i> med skog og bygningar</span>
                    <span class="skog-dom ${nySyn.klasse}">
                        <i class="fa-solid ${nySyn.ikon}"></i> ${escHtml(nyTekst)}
                        · ${fmtProsent(ny.synlegDel)}
                    </span>
                </div>

                <p class="skog-detalj-tekst">
                    ${o.fraToppK
                        ? `Av dei ${o.talPunkt} punkta som vart slått opp, er det
                           <strong>ikkje</strong> det bare terrenget sitt eige kritiske punkt som
                           avgjer — det er eit hinder`
                        : 'Det terrengpunktet som avgjer sikta ligg'}
                    <strong>${fmtAvstand(o.kritiskD)}</strong>
                    frå deg. Bakken der er <strong>${fmtMoh(o.dtmZ)}</strong>, men
                    <strong>overflata er ${fmtMoh(o.domZ)}</strong> —
                    <strong>${o.differanseM.toFixed(1)} m</strong> med skog, bygning eller anna
                    som står på bakken.
                    ${blir
                        ? `Med det høgdepåslaget kjem heile turbinen under horisonten:
                           <strong>frå ${fmtProsent(r.synlegheit.synlegDel)} synleg på bar bakke
                           til heilt skjult</strong>.`
                        : `Synleg del går frå <strong>${fmtProsent(r.synlegheit.synlegDel)}</strong>
                           til <strong>${fmtProsent(ny.synlegDel)}</strong>.`}
                    ${o.mistarRotor
                        ? ' <strong>Rotoren mistar den frie sikta</strong> — det er rotoren i rørsle som pregar landskapsbiletet mest.'
                        : ''}
                </p>

                ${ny.naerskjerming ? `
                    <div class="varsel varsel-info liten">
                        <i class="fa-solid fa-circle-info"></i>
                        <div>Hinderet står <strong>heilt inntil punktet</strong>. Eit tre 30 m unna
                             dekkjer alt bak seg uansett avstand — men flyttar du punktet nokre
                             titals meter, kan svaret bli eit heilt anna. Dra punktet litt for å sjå
                             kor følsamt det er.</div>
                    </div>` : ''}

                <p class="skog-detalj-atterhald">
                    <i class="fa-solid fa-circle-info"></i>
                    Rekna av Kartverkets <strong>overflatemodell (${escHtml(o.datakilde)})</strong> i
                    <strong>${o.talPunkt ?? 1} punkt</strong> langs profilen — det som avgjer siktlinja
                    på bar bakke, og dei der eit hinder ville bety mest. Resten av profilen er
                    framleis bar bakke, så verknaden av skog kan vere <em>større</em> enn dette, aldri
                    mindre. Laserdataen er frå ei skanning som kan vere fleire år gammal:
                    <strong>er skogen hoggen sidan, står han framleis i modellen</strong> — og motsett,
                    ung skog har vakse.
                </p>
            </div>`;
    }

    // ------------------------------------------------- detalj: hinderlys

    /**
     * Kva forskrifta krev av hinderlys på nettopp denne turbinen, og kva av
     * det som er synleg herfrå. Står ALLTID der når turbinen er merkepliktig,
     * slik at ingen kan gå glipp av at det finst lys i det heile. (Samandraget
     * sin hinderlys-bolk er derimot samanleggbar — sjå `_hinderlysSamandragHtml`.)
     */
    _hinderlysDetaljHtml(r) {
        const hl = r.hinderlys;
        if (!hl) return '';

        if (!hl.merkeplikt) {
            return `
                <div class="detalj-seksjon">
                    <h4><i class="fa-solid fa-moon"></i> Hinderlys</h4>
                    <p class="hint">${escHtml(hl.grunngjeving)}</p>
                </div>`;
        }

        const topp = hl.lyspunkt.find((l) => l.rolle === 'topp');
        const mellom = hl.lyspunkt.filter((l) => l.rolle === 'mellom');

        const lysRad = (l, namn) => {
            const status = l.synleg === null
                ? '<span class="lys-status lys-ukjent">ikkje vurdert</span>'
                : (l.synleg
                    ? '<span class="lys-status lys-synleg">synleg herfrå</span>'
                    : '<span class="lys-status lys-skjult">skjult av terreng</span>');
            return `
                <li class="lys-rad">
                    <span class="lys-prikk ${l.typeNokkel === 'hoyintensitet_b' ? 'lys-kvit' : 'lys-raud'}"></span>
                    <span class="lys-tekst">
                        <strong>${escHtml(namn)}</strong>
                        <span class="hint">${Math.round(l.hoydeOverBakkeM)} m over bakken
                            · ${escHtml(l.farge)} · ${l.candela} cd om natta</span>
                        ${l.synleg === true && l.magnitudeTekst
                            ? `<span class="hint lys-mag">${escHtml(l.magnitudeTekst)}
                                   (magnitude ${l.magnitude.toFixed(1)})</span>`
                            : ''}
                    </span>
                    ${status}
                </li>`;
        };

        return `
            <div class="detalj-seksjon">
                <h4><i class="fa-solid fa-moon"></i> Hinderlys
                    <span class="merke ${hl.hoyintensitet ? 'merke-hoyint' : 'merke-mellomint'}">
                        ${escHtml(hl.toppType.kortTekst)}
                    </span>
                </h4>

                <p class="lys-grunngjeving">${escHtml(hl.grunngjeving)}</p>

                <ul class="lys-liste">
                    ${topp ? lysRad(topp, `Topplys (2 stk på nacellen)`) : ''}
                    ${mellom.map((l, i) => lysRad(l, `Mellomnivålys ${i + 1}`)).join('')}
                </ul>

                <p class="hint">${escHtml(hl.toppType.merknad)}</p>

                <div class="varsel varsel-aatvaring liten">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                    <div>
                        Dette er <strong>minstekravet i forskrifta</strong>
                        (FOR-2014-07-15-980 § 16 tredje ledd), ikkje ei registrering av kva som
                        faktisk er montert. To ting kan gjere det verkelege biletet mildare:
                        <strong>behovsstyrt lyssetting (ADLS)</strong> etter § 7a, der lyset står
                        avslege til radar/transponder oppdagar fly, og <strong>perimetermerking</strong>
                        etter § 16(3) f., der berre turbinane i ytterkanten av anlegget vert merkte.
                        <strong>NVE-datasettet inneheld ikkje opplysningar om kva anlegg som har
                        slike godkjenningar</strong>, så me kan ikkje vite om denne turbinen har lys i det heile.
                    </div>
                </div>
            </div>`;
    }

    // ------------------------------------------------ detalj: skyggekast

    _skyggekastDetaljHtml(r) {
        const sk = r.skyggekast;
        const K = CONFIG.skyggekast;

        // Utanfor relevant avstand: sei det, i staden for å teie.
        if (!sk) {
            const grense = Math.min(K.maksAvstandM, K.avstandPerRotordiameter * (r.rotorDiameterM || 0));
            if (!(grense > 0) || !r.analysert) return '';
            if (r.avstandM > grense) {
                return `
                    <div class="detalj-seksjon">
                        <h4><i class="fa-solid fa-sun"></i> Skyggekast</h4>
                        <p class="hint">
                            ${fmtAvstand(r.avstandM)} unna — utanfor den relevante avstanden på
                            ${fmtAvstand(grense)} for ein ${Math.round(r.rotorDiameterM)} m rotor.
                            Så langt unna dekkjer bladet mindre enn 20 % av solskiva, og skuggen
                            er per definisjon ikkje lenger skyggekast.
                        </p>
                    </div>`;
            }
            return '';
        }

        if (sk.minuttPerAar === 0) {
            return `
                <div class="detalj-seksjon">
                    <h4><i class="fa-solid fa-sun"></i> Skyggekast</h4>
                    <p class="hint">
                        Turbinen står nær nok (${fmtAvstand(r.avstandM)}), men geometrien går ikkje opp:
                        sola står aldri slik at rotorskuggen når fram til akkurat dette punktet.
                    </p>
                </div>`;
        }

        const overAar = sk.overGrenseAar;
        const overDag = sk.overGrenseDag;

        return `
            <div class="detalj-seksjon">
                <h4><i class="fa-solid fa-sun"></i> Skyggekast <span class="merke merke-estimat">teoretisk</span></h4>

                <dl class="detalj-tabell tett">
                    <dt>Timar per år</dt>
                    <dd><span class="pille ${overAar ? 'stoy-hoy' : 'stoy-lav'}">${fmtTimar(sk.timarPerAar)}</span>
                        <span class="hint">NVE tilrår høgst ${K.grenseTimarPerAar} t/år teoretisk</span></dd>

                    <dt>Verste døgn</dt>
                    <dd><span class="pille ${overDag ? 'stoy-hoy' : 'stoy-lav'}">${Math.round(sk.maksMinuttPerDag)} min</span>
                        <span class="hint">NVE tilrår høgst ${K.grenseMinuttPerDag} min/dag</span></dd>

                    <dt>Sesong</dt>
                    <dd>${sk.dagarMedSkygge} dagar i året
                        ${sk.forsteDag >= 0
                            ? `<span class="hint">frå ${escHtml(dagTilDato(sk.forsteDag, sk.aar ?? new Date().getUTCFullYear()))}
                                   til ${escHtml(dagTilDato(sk.sisteDag, sk.aar ?? new Date().getUTCFullYear()))}</span>`
                            : ''}</dd>
                </dl>

                ${this._kalenderHtml(sk.kalender, 'Når på året og døgnet')}

                <p class="hint">
                    Rotoren er modellert som ei skive som alltid står vinkelrett på sola — verste
                    tenkelege geometri. Terrenget mellom er teke med: eit lyspunkt på rotoren som er
                    skjult bak ein ås kan ikkje kaste skugge hit.
                </p>
            </div>`;
    }

    lukkDetalj() {
        const el = $('detalj-panel');
        el?.classList.remove('open');
        this.graf.tom();
    }
}

/**
 * Kort form av eit eigarnamn til listevisinga.
 *
 * NVE-feltet er reine føretaksnamn i store bokstavar («SØRMARKFJELLET AS»,
 * «FRØYA VIND AS»). Selskapsforma seier ingenting i ei liste der plassen er
 * knapp, så ho fell bort — men berre i lista; detaljvisinga og tooltipen viser
 * namnet uavkorta.
 */
function kortEigar(navn) {
    const reint = String(navn)
        .replace(/\s+(AS|ASA|DA|ANS|SA|BA|NUF)\.?$/i, '')
        .trim();
    // Store bokstavar heile vegen er ropande i eit smalt panel.
    const pent = reint === reint.toUpperCase()
        ? reint.toLowerCase().replace(/(^|[\s\-/])(\p{L})/gu, (m, p, c) => p + c.toUpperCase())
        : reint;
    return pent.length > 34 ? `${pent.slice(0, 33)}…` : pent;
}
