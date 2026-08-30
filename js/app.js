/**
 * js/app.js
 *
 * Inngangspunkt: koplar saman state, kart, panel og analyse.
 *
 * All UI-interaksjon utanfor sidepanelet går gjennom éin delegert lyttar med
 * `data-action` (CSP-trygt — ingen inline handlers).
 */

import { CONFIG } from './config.js';
import { state } from './state.js';
import {
    hentTurbinar, hentOmrader, hentHoyde, hentProfilar, hentDtmPunkt,
    sokAdresse, sjekkVersjon, oppdaterTurbindata,
} from './api.js';
import { byggSynlegheitskart } from './utils/Zvi.js';
import { Fotomontasje } from './ui/Fotomontasje.js';
import { MapManager } from './ui/MapManager.js';
import { ImpactPanel } from './ui/ImpactPanel.js';
import { Toast } from './ui/Toast.js';
import { finnTurbinarIRadius, koyrAnalyse } from './utils/AnalyseRunner.js';
import { beregnPaaverknad, byggSamandrag } from './utils/ImpactCalculator.js';
import { samletStoy } from './utils/NoiseModel.js';
import { hinderlysKrav } from './utils/ObstacleLights.js';
import { haversine } from './utils/geo.js';
import { byggSoltabell, skyggekastForAlle, maksSkyggeavstandM } from './utils/ShadowFlicker.js';
import { erJustert, avstandUtanforPlanomrade } from './utils/TurbinJustering.js';
import {
    sjekkOverflate, overflateSamandrag, kanEndrastAvOverflate,
} from './utils/SurfaceCheck.js';
import {
    escHtml, fmtDato, fmtAvstand, fmtDb, fmtMoh, fmtTimar, $, debounce,
} from './utils/dom.js';
import { initErrorReporter } from './utils/ErrorReporter.js';
import { PanoramaView } from './ui/PanoramaView.js';
import { hentHorisont, harHorisont } from './utils/Horizon.js';
import { hentNaerTerreng, harNaerTerreng } from './utils/NaerTerreng.js';
import { hentSatellittdekke, harSatellittdekke } from './utils/SatelliteTexture.js';
import { byggKmlAlleTurbinar, byggKmlAnalyserteTurbinar, lastNedFil } from './utils/KmlExport.js';

initErrorReporter();

class VindApp {
    constructor() {
        this.kart = new MapManager('kart', {
            // Eit kartklikk PEIKAR UT eit punkt; det køyrer ingen analyse.
            // Sjå settKandidat() for kvifor.
            paaKartklikk: (lat, lon) => this.settKandidat(lat, lon),
            paaKandidatFlytt: (lat, lon) => this.settKandidat(lat, lon),
            paaTurbinklikk: (t) => this.visTurbinPopup(t),
            paaTurbinDragStart: (t) => this.startTurbinFlytt(t),
            paaTurbinFlytt: (t, lat, lon) => this.fullfoerTurbinFlytt(t, lat, lon),
        });
        this.panel = new ImpactPanel({
            paaVeljTurbin: (id) => this.veljTurbin(id),
            paaLukkDetalj: () => this.panel.lukkDetalj(),
            paaVisPanorama: () => this.visPanorama(),
            paaFotomontasje: () => this.visFotomontasje(),
            paaTilbakestillPosisjon: (id) => this.tilbakestillTurbinPosisjon(id),
            paaSjekkOverflate: () => this.kjoerOverflatesjekk(),
            // Flytta hit frå topplinja: dei gir berre meining med eit resultat.
            paaDelLenke: () => this.delLenke(),
            paaEksporterAnalyse: () => this.eksporterAnalyserteKml(),
            paaRapport: () => this.skrivUt(),
        });
        this.fotomontasje = new Fotomontasje();

        /**
         * Er DOM-kryssjekken undervegs? Styrer både spinnaren i samandraget
         * og at knappen ikkje kan fyrast to gonger.
         */
        this.overflateKoyrer = false;

        /** Turbin-id-ar med eit DOM-oppslag undervegs (frå detaljvisinga). */
        this.overflateVentar = new Set();

        /**
         * Byggjer eit 3D-panorama akkurat no? Eit kaldt panorama kostar ~72
         * terrengprofil-einingar (§21), så knappen MÅ vere sperra medan det
         * står på — elles gir eit dobbeltklikk to fulle horisonthentingar.
         */
        this.panoramaKoyrer = false;

        /** Hentar geoposisjon akkurat no? Sperrar «Min posisjon» (kan ta 12 s). */
        this.posisjonHentar = false;

        /** Lokalt synlegheitskart (ZVI): cache, av/på, og køyrer-flagg. */
        this._zviData = null;
        this._zviPaa = false;
        this._zviKoyrer = false;

        /** Avbryt pågåande analyse når brukaren flyttar punktet. */
        this.analyseAvbrytar = null;

        /** Var siste analyse avkorta av maksTurbinar? Held ved re-teikning. */
        this.sistAvkorta = false;

        /**
         * Soltabellen for det analyserte punktet, gjenbrukt ved re-analyse.
         * Han avheng BERRE av punktet (CLAUDE.md §11), så ei turbinflytting
         * treng ikkje dei ~140 ms det kostar å byggje han på nytt.
         * @type {{nokkel:string, tabell:object}|null}
         */
        this._soltabell = null;

        /** @type {Map<number, string>} anleggsnr → status, for områdepolygon. */
        this.anleggStatus = new Map();

        this.omrader = null;
        this.visOmrader = true;
        this.panorama = new PanoramaView({
            /**
             * Skogbrytaren i panoramaet kan trenge data som ikkje finst enno.
             * Sidepanelet ligg bak overlegget, så brukaren kan ikkje gå og
             * trykkje på knappen der — panoramaet får difor køyre same steget
             * sjølv, mot same funksjon og same tilstand.
             */
            paaSjekkOverflate: () => this.kjoerOverflatesjekk(),
        });
    }

    async start() {
        this.kart.init();
        this.panel.visStartmelding();

        // Utan analyse teiknar nattmodusen lys for turbinane i kartutsnittet,
        // så laget må følgje med når brukaren panorerer. Debouncet, av di
        // `moveend` kjem tett under trege panoreringar.
        this.kart.kart.on('moveend', debounce(() => {
            if (this.kart.nattmodus && state.resultat.length === 0) this._tegnHinderlys();
        }, 150));

        this._bindKontrollar();
        this._byggStatusFilter();

        try {
            const data = await hentTurbinar();
            state.settDatagrunnlag({
                turbiner: data.turbiner,
                anlegg: data.anlegg,
                generert: data.generert,
            });

            for (const a of data.anlegg ?? []) {
                this.anleggStatus.set(a.anleggsnr, a.status);
            }

            this.kart.tegnTurbinar(state.turbinar, state.statusFilter);
            this._oppdaterDatakjelde(data.generert, data.turbiner.length);

            // Områdepolygon er eit tilleggslag — appen fungerer utan.
            this.omrader = await hentOmrader();
            if (this.omrader?.omrader) {
                this.kart.tegnOmrader(this.omrader.omrader, state.statusFilter, this.anleggStatus);
            }

            this._lesUrlPunkt();

            // Sjølvhosta-varsel (gamle data / ny utgåve) — heilt uavhengig av
            // resten, og fullstendig stille i web-versjonen.
            this._sjekkSjolvhostVarsel(data.generert);
        } catch (e) {
            Toast.error(e.message);
            console.error(e);
        }
    }

    /**
     * Berre relevant for den nedlastbare utgåva. Viser ei diskré stripe over
     * ansvarsfråskrivinga når (a) turbindata-snapshotet er gamalt, eller
     * (b) det finst ei nyare utgåve på GitHub. Feilar noko av dette, vert
     * stripa berre ståande tom.
     */
    async _sjekkSjolvhostVarsel(generert) {
        const rader = [];

        const alderDagar = (Date.now() - new Date(generert).getTime()) / 86_400_000;
        if (Number.isFinite(alderDagar) && alderDagar > CONFIG.sjolvhost.turbindataGamleDagar) {
            rader.push(
                `<span><i class="fa-solid fa-database"></i> Turbindata er `
                + `${Math.round(alderDagar)} dagar gamle.</span>`
                + `<button type="button" class="varsel-knapp" data-action="oppdater-turbindata">`
                + `Oppdater no</button>`,
            );
        }

        try {
            const v = await sjekkVersjon();

            // Vis utgåve-id-en ved overskrifta. Berre nedlastbare utgåver har
            // ein (version.json) — web/kjeldekode får tom streng, altså inga
            // vising.
            const vEl = $('app-versjon');
            if (vEl) vEl.textContent = v?.naavaerande ?? '';

            if (v?.nyare && v.siste) {
                const url = escHtml(v.url || 'https://github.com/joamort/vindkraft-paavirkning/releases/latest');
                rader.push(
                    `<span><i class="fa-solid fa-rocket"></i> Ny utgåve `
                    + `${escHtml(v.siste)} finst (du har ${escHtml(v.naavaerande)}).</span>`
                    + `<a class="varsel-knapp" href="${url}" target="_blank" rel="noopener">`
                    + `Sjå på GitHub</a>`,
                );
            }
        } catch { /* fail-silent */ }

        const stripe = $('varselstripe');
        if (!stripe) return;
        if (rader.length === 0) {
            stripe.hidden = true;
            stripe.innerHTML = '';
            return;
        }
        stripe.innerHTML = rader.map((r) => `<div class="varsel-rad">${r}</div>`).join('');
        stripe.hidden = false;
    }

    async _oppdaterTurbindataFraKnapp(knapp) {
        const opphavleg = knapp.textContent;
        knapp.disabled = true;
        knapp.textContent = 'Hentar … (~½ min)';
        try {
            await oppdaterTurbindata();
            Toast.success('Turbindata oppdatert. Lastar sida på nytt …');
            setTimeout(() => location.reload(), 1200);
        } catch (e) {
            Toast.error(e.message);
            knapp.disabled = false;
            knapp.textContent = opphavleg;
        }
    }

    // -------------------------------------------------- lokalt synlegheitskart

    /**
     * Slå synlegheitskartet av/på. Rutenettet vert bygd éin gong per analyse
     * (bakkehøgd i ~169 punkt, 1-2 Kartverket-kall) og cacha; sjølve
     * fargelegginga gjenbruker analysen som alt er gjort. Sjå js/utils/Zvi.js.
     */
    async vekslSynlegheitskart(knapp) {
        if (this._zviKoyrer) return;

        if (this._zviPaa) {
            this.kart.skjulSynlegheitskart();
            this._zviPaa = false;
            $('zvi-teiknforklaring').hidden = true;
            knapp?.classList.remove('aktiv');
            if (knapp) knapp.innerHTML = '<i class="fa-solid fa-border-all"></i> Vis synlegheitskart';
            return;
        }

        if (!state.punkt || state.resultat.length === 0) {
            Toast.info('Analyser eit punkt først.');
            return;
        }

        const ok = await this._byggOgTegnZvi(knapp);
        if (ok) {
            this._zviPaa = true;
            knapp?.classList.add('aktiv');
            if (knapp) knapp.innerHTML = '<i class="fa-solid fa-border-all"></i> Skjul synlegheitskart';
        }
    }

    _zviKnappStandard(knapp) {
        if (knapp) {
            knapp.disabled = false;
            knapp.innerHTML = '<i class="fa-solid fa-border-all"></i> Vis synlegheitskart';
        }
    }

    async _byggOgTegnZvi(knapp) {
        if (!this._zviData) {
            this._zviKoyrer = true;
            if (knapp) {
                knapp.disabled = true;
                knapp.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Bygg …';
            }
            try {
                this._zviData = await byggSynlegheitskart(
                    state.punkt, state.resultat, hentDtmPunkt,
                );
            } catch (e) {
                Toast.error(`Klarte ikkje byggje synlegheitskartet: ${e.message}`);
                this._zviKoyrer = false;
                this._zviKnappStandard(knapp);
                return false;
            }
            this._zviKoyrer = false;
        }

        this._zviKnappStandard(knapp);

        const d = this._zviData;
        const utanData = d.celler.filter((c) => c.tal == null).length;
        if (utanData > d.celler.length * 0.6) {
            Toast.info('Punktet ligg stort sett utanfor laserdekninga (t.d. på sjøen).');
            return false;
        }
        if (d.maks <= 0) {
            Toast.info('Ingen turbinar synlege i nærområdet — ingenting å fargeleggje.');
            return false;
        }

        this.kart.tegnSynlegheitskart(d);
        this._tegnZviForklaring(d);
        return true;
    }

    _tegnZviForklaring(d) {
        const el = $('zvi-teiknforklaring');
        if (!el) return;
        const sval = [0, Math.round(d.maks / 2), d.maks].filter((v, i, a) => a.indexOf(v) === i);
        el.innerHTML = `
            <div class="zvi-skala"></div>
            <div class="zvi-merke">${sval.map((v) => `<span>${v}</span>`).join('')}</div>
            <p class="zvi-hint">synlege turbinar per rute · rutenett ${d.sideM} m ·
                <strong>tilnærming</strong>, sjå «Om modellen»</p>`;
        el.hidden = false;
    }

    // ------------------------------------------------------------ kontrollar

    _bindKontrollar() {
        /**
         * FORHANDSLAST THREE.JS NÅR PEIKAREN NÆRMAR SEG KNAPPEN.
         *
         * `pointerover` og ikkje `pointerenter`, fordi dette er ein delegert
         * lyttar og berre den fyrste boblar. På peikeskjerm fyrer han rett
         * før klikket i staden for før hovringa — framleis nokre hundre
         * millisekund gratis, og aldri eit byte for dei som berre ser på
         * kartet (§16). `forhandslast()` er idempotent.
         */
        document.body.addEventListener('pointerover', (e) => {
            if (e.target.closest?.('[data-action="vis-panorama"]')) {
                this.panorama.forhandslast();
            }
        }, { passive: true });

        // Éin delegert lyttar for heile appskallet.
        document.body.addEventListener('click', (e) => {
            const el = e.target.closest('[data-action]');
            if (!el || el.closest('#sidepanel')) return; // panelet har sin eigen

            switch (el.dataset.action) {
                case 'bakgrunn':
                    this.kart.settBakgrunn(el.dataset.lag);
                    document.querySelectorAll('[data-action="bakgrunn"]')
                        .forEach((b) => b.classList.toggle('aktiv', b === el));
                    break;

                case 'min-posisjon':
                    this.brukMinPosisjon();
                    break;

                case 'veksle-omrader':
                    this.visOmrader = !this.visOmrader;
                    el.classList.toggle('aktiv', this.visOmrader);
                    this._tegnOmrader();
                    break;

                case 'veksle-natt':
                    this.vekslNattmodus(el);
                    break;

                case 'stadfest-punkt':
                    this.stadfestPunkt();
                    break;

                case 'avbryt-punkt':
                    this.avbrytKandidat();
                    break;

                case 'veksle-panel': {
                    const skjult = $('sidepanel')?.classList.toggle('skjult');
                    // Speglar tilstanden på <body>, slik at CSS kan gi
                    // kartkontrollane heile kartet når panelet er skuva bort.
                    // Ein sysken-selektor kjem ikkje til: panelet står ETTER
                    // kartområdet i DOM-en.
                    document.body.classList.toggle('panel-skjult', Boolean(skjult));
                    break;
                }

                case 'zoom-radius':
                    this.kart.zoomTilRadius();
                    break;

                case 'eksporter-alle':
                    this.eksporterAlleKml();
                    break;

                case 'veksle-info':
                    $('info-modal')?.classList.toggle('open');
                    break;

                case 'oppdater-turbindata':
                    this._oppdaterTurbindataFraKnapp(el);
                    break;

                // «del-lenke», «eksporter-analyserte» og «skriv-ut» bur no i
                // sidepanelet (ImpactPanel `_delEksporterHtml`) — dei gir berre
                // meining med eit analysert punkt. Panelet har sin eigen lyttar.

                case 'veksle-synlegheitskart':
                    this.vekslSynlegheitskart(el);
                    break;

                default:
                    break;
            }
        });

        // Radiusvel
        const radius = $('radius-vel');
        if (radius) {
            radius.innerHTML = CONFIG.analyse.valgbareRadiusM
                .map((m) => `<option value="${m}"${m === CONFIG.analyse.standardRadiusM ? ' selected' : ''}>${m / 1000} km</option>`)
                .join('');
            radius.addEventListener('change', () => {
                state.settRadius(Number(radius.value));
                this.kart.oppdaterRadius(state.radiusM);
                this.kart.oppdaterKandidatRadius(state.radiusM);
                // Ein radiusendring medan eit kandidatpunkt ventar skal berre
                // oppdatere forhandsvisinga — ikkje snike seg forbi
                // stadfestingssteget og starte analysen.
                if (state.kandidat) {
                    this.panel.visStadfesting({
                        ...state.kandidat, radiusM: state.radiusM,
                        harResultat: state.resultat.length > 0,
                    });
                } else if (state.punkt) {
                    this.analyser();
                }
            });
        }

        /**
         * Enter stadfestar kandidatpunktet, Escape forkastar det.
         *
         * Utan dette må ein flytte handa frå kartet til ein knapp for kvar
         * einaste stad ein vil samanlikne — som er den vanlege bruken.
         */
        document.addEventListener('keydown', (e) => {
            if (!state.kandidat) return;
            const iSkjema = ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target?.tagName);
            if (iSkjema) return;
            if (e.key === 'Enter') {
                e.preventDefault();
                this.stadfestPunkt();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.avbrytKandidat();
            }
        });

        this._bindAdressesok();
    }

    /**
     * Adressesøk i topplinja. Debouncar mot backenden (som proxyar Kartverket),
     * viser ei trefliste, og set punktet + startar analysen når brukaren vel
     * eit treff — same veg som ei delbar `?lat=&lon=`-lenke.
     */
    _bindAdressesok() {
        const felt = $('adresse-input');
        const liste = $('adresse-treff');
        if (!felt || !liste) return;

        let avbrytar = null;
        let aktivIndeks = -1;

        const lukk = () => {
            liste.hidden = true;
            liste.innerHTML = '';
            aktivIndeks = -1;
            felt.setAttribute('aria-expanded', 'false');
        };

        const velg = (lat, lon, tekst) => {
            lukk();
            felt.value = tekst;
            felt.blur();
            this.kart.panorerTil(lat, lon, 13);
            this.settPunkt(lat, lon);
            // Etter settPunkt (som nullstiller han for alle andre vegar inn).
            this.sisteAdresse = tekst || null;
        };

        const tegn = (treff) => {
            if (!treff || treff.length === 0) { lukk(); return; }
            liste.innerHTML = treff.map((t, i) => `
                <li role="option" id="adr-${i}" data-action="velg-adresse"
                    data-lat="${t.lat}" data-lon="${t.lon}" data-tekst="${escHtml(t.tekst)}">
                    <i class="fa-solid fa-location-dot"></i>
                    <span><strong>${escHtml(t.tekst)}</strong>${t.stad ? `<span class="adr-stad">${escHtml(t.stad)}</span>` : ''}</span>
                </li>`).join('');
            liste.hidden = false;
            aktivIndeks = -1;
            felt.setAttribute('aria-expanded', 'true');
        };

        const sok = debounce(async () => {
            const q = felt.value.trim();
            if (q.length < 3) { lukk(); return; }
            avbrytar?.abort();
            avbrytar = new AbortController();
            const treff = await sokAdresse(q, avbrytar.signal);
            if (felt.value.trim() === q) tegn(treff);
        }, 250);

        felt.addEventListener('input', sok);
        felt.addEventListener('focus', () => { if (felt.value.trim().length >= 3) sok(); });

        felt.addEventListener('keydown', (e) => {
            const val = [...liste.querySelectorAll('li')];
            if (e.key === 'ArrowDown' && val.length) {
                e.preventDefault();
                aktivIndeks = Math.min(aktivIndeks + 1, val.length - 1);
            } else if (e.key === 'ArrowUp' && val.length) {
                e.preventDefault();
                aktivIndeks = Math.max(aktivIndeks - 1, 0);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const li = val[aktivIndeks] ?? val[0];
                if (li) velg(Number(li.dataset.lat), Number(li.dataset.lon), li.dataset.tekst);
                return;
            } else if (e.key === 'Escape') {
                lukk();
                return;
            } else {
                return;
            }
            val.forEach((li, i) => li.classList.toggle('aktiv', i === aktivIndeks));
            if (val[aktivIndeks]) felt.setAttribute('aria-activedescendant', val[aktivIndeks].id);
        });

        liste.addEventListener('click', (e) => {
            const li = e.target.closest('[data-action="velg-adresse"]');
            if (li) velg(Number(li.dataset.lat), Number(li.dataset.lon), li.dataset.tekst);
        });

        // Klikk utanfor lukkar lista.
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.adressesok')) lukk();
        });
    }

    _byggStatusFilter() {
        const boks = $('status-filter');
        if (!boks) return;

        boks.innerHTML = Object.entries(CONFIG.status)
            .filter(([n]) => n !== 'ukjent')
            .map(([nokkel, s]) => `
                <label class="status-val">
                    <input type="checkbox" value="${escHtml(nokkel)}"
                           ${state.statusFilter.has(nokkel) ? 'checked' : ''}>
                    <span class="status-prikk" style="background:${s.farge}"></span>
                    <span>${escHtml(s.tekst)}</span>
                </label>`)
            .join('');

        boks.addEventListener('change', (e) => {
            const inp = e.target;
            if (inp.type !== 'checkbox') return;
            state.vekslStatus(inp.value, inp.checked);
            this.kart.tegnTurbinar(state.turbinar, state.statusFilter);
            this._tegnOmrader();
            this._tegnHinderlys();
            if (state.punkt) this.analyser();
        });
    }

    _tegnOmrader() {
        if (!this.omrader?.omrader) return;
        this.kart.tegnOmrader(
            this.visOmrader ? this.omrader.omrader : [],
            state.statusFilter,
            this.anleggStatus,
        );
    }

    _oppdaterDatakjelde(generert, antall) {
        const el = $('datakjelde');
        if (el) {
            el.innerHTML = `${antall} punkt · NVE ${escHtml(fmtDato(generert))}`;
        }
    }

    // ----------------------------------------------------------------- punkt

    /**
     * PEIK UT eit punkt — utan å køyre noko.
     *
     * =======================================================================
     * KVIFOR EIT STADFESTINGSSTEG
     * =======================================================================
     * Ein analyse hentar terrengprofilar for inntil 150 turbinar frå
     * Kartverket, i fleire parallelle kall. Køyrde appen han rett på
     * kartklikket — slik han gjorde til no — betalte både brukaren og
     * Kartverket for kvart bomskot og kvar gong nokon berre klikka seg rundt
     * på kartet for å sjå seg om.
     *
     * Kandidatpunktet er difor heilt gratis: ingen nettverkskall i det heile,
     * heller ikkje det eine oppslaget for bakkehøgd. Brukaren kan flytte det
     * så mykje han vil, og eit eventuelt tidlegare analysert punkt vert
     * ståande urørt med resultata sine — nettopp slik at eit feilklikk ikkje
     * kostar noko som helst, verken i tid eller i tapt arbeid.
     *
     * Unntaket er delbare lenker (`?lat=&lon=`): å opne ei slik lenke ER eit
     * eksplisitt val, og då startar analysen med det same. Sjå _lesUrlPunkt().
     */
    settKandidat(lat, lon) {
        state.settKandidat({ lat, lon });
        this.kart.settKandidat(lat, lon, state.radiusM);
        this.panel.visStadfesting({ lat, lon, radiusM: state.radiusM, harResultat: state.resultat.length > 0 });
    }

    /** Forkast kandidatpunktet utan å analysere. */
    avbrytKandidat() {
        state.settKandidat(null);
        this.kart.fjernKandidat();
        this.panel.skjulStadfesting();
    }

    /** Brukaren har trykt «Analyser her» — no, og først no, køyrer me. */
    async stadfestPunkt() {
        const k = state.kandidat;
        if (!k) return;
        this.kart.fjernKandidat();
        this.panel.skjulStadfesting();
        state.settKandidat(null);
        await this.settPunkt(k.lat, k.lon);
    }

    /**
     * Set brukarens punkt og start analysen.
     * Punktet lagrast aldri server-side (PLAN.md §8) — det finst berre i
     * nettlesaren og i sjølve API-kallet for terrengdata.
     */
    async settPunkt(lat, lon) {
        this.kart.settPunkt(lat, lon, state.radiusM);
        this.panel.lukkDetalj();
        // Gjeld berre om punktet vart valt via adressesøk — sett på nytt der.
        this.sisteAdresse = null;

        // Hent bakkehøgda før analysen — heile siktlinjeberekninga hengjer på
        // den, så me har ikkje noko å rekne med utan.
        let hoyde = null;
        try {
            hoyde = await hentHoyde(lat, lon);
        } catch (e) {
            Toast.error(`Fekk ikkje henta terrenghøgd: ${e.message}`);
            return;
        }

        state.settPunkt({
            lat, lon,
            hoyde: hoyde.hoyde_m,
            terreng: hoyde.terreng,
        });

        this._oppdaterUrl(lat, lon);
        this.analyser();
    }

    /** Geolocation berre etter eksplisitt brukarhandling (PLAN.md §8). */
    brukMinPosisjon() {
        if (this.posisjonHentar) return;
        if (!navigator.geolocation) {
            Toast.warning('Nettlesaren din støttar ikkje posisjonering.');
            return;
        }

        // Sperr knappen medan me ventar (timeout er 12 s) — og vis at det skjer
        // noko. Utan dette stablar gjentekne klikk opp fleire posisjonsdialogar
        // og fleire analysar.
        const knapp = document.querySelector('[data-action="min-posisjon"]');
        const ikon = knapp?.querySelector('i');
        const opphavlegIkon = ikon?.className;
        this.posisjonHentar = true;
        if (knapp) knapp.disabled = true;
        if (ikon) ikon.className = 'fa-solid fa-spinner fa-spin';
        Toast.info('Hentar posisjonen din …');

        const ferdig = () => {
            this.posisjonHentar = false;
            if (knapp) knapp.disabled = false;
            if (ikon && opphavlegIkon) ikon.className = opphavlegIkon;
        };

        navigator.geolocation.getCurrentPosition(
            (pos) => {
                ferdig();
                const { latitude, longitude } = pos.coords;
                this.kart.panorerTil(latitude, longitude, 12);
                this.settPunkt(latitude, longitude);
            },
            (err) => {
                ferdig();
                Toast.error(`Fekk ikkje posisjonen din: ${err.message}`);
            },
            { enableHighAccuracy: true, timeout: 12000 },
        );
    }

    // --------------------------------------------------------------- analyse

    async analyser() {
        if (!state.punkt) return;

        // Avbryt ei eventuell pågåande analyse — brukaren har flytta punktet.
        this.analyseAvbrytar?.abort();
        this.analyseAvbrytar = new AbortController();
        const signal = this.analyseAvbrytar.signal;

        // Synlegheitskartet gjeld det førre punktet/settet — kast det.
        this._zviData = null;
        this.kart.skjulSynlegheitskart();

        const iRadius = finnTurbinarIRadius(
            state.turbinar, state.punkt, state.radiusM, state.statusFilter,
        );

        if (iRadius.length === 0) {
            this.sistAvkorta = false;
            state.settResultat([], byggSamandrag([]), null);
            this.panel.tegn({
                punkt: state.punkt, resultat: [], samandrag: byggSamandrag([]),
                samlaStoy: null, avkorta: false, radiusM: state.radiusM,
            });
            this.kart.tegnSiktlinjer(state.punkt, []);
            return;
        }

        this.panel.visFramdrift(0, Math.min(iRadius.length, CONFIG.analyse.maksTurbinar));

        // Straumande delresultat: teikn panelet på nytt for kvar batch, slik at
        // lista fyllest opp medan resten framleis hentast.
        const samla = [];
        const oppdaterStraumande = debounce(() => {
            samla.sort((a, b) => a.avstandM - b.avstandM);
            const samandrag = byggSamandrag(samla);
            const stoy = samletStoy(samla.filter((r) => r.stoy).map((r) => r.stoy.lpDb));
            /**
             * Delresultatet må inn i `state` òg, ikkje berre i DOM-en.
             *
             * `veljTurbin()` slår opp turbinen i `state.resultat`. Vart den
             * berre sett når HEILE analysen var ferdig, peika radene i den
             * straumande lista på tomme luft: brukaren klikka ein turbin som
             * stod rett framfor han, og ingenting skjedde — verst for punkt
             * med mange turbinar, altså nettopp der lista fyllest seinast.
             */
            state.settResultat(samla, samandrag, stoy);
            this.panel.tegn({
                punkt: state.punkt, resultat: samla, samandrag, samlaStoy: stoy,
                avkorta: iRadius.length > CONFIG.analyse.maksTurbinar,
                radiusM: state.radiusM, overflateKoyrer: this.overflateKoyrer,
                panoramaKoyrer: this.panoramaKoyrer,
            });
            this.kart.tegnSiktlinjer(state.punkt, samla);
            if (this.kart.nattmodus) this.kart.tegnHinderlys(samla);
        }, 120);

        try {
            const { resultat, samandrag, samlaStoy, avkorta } = await koyrAnalyse({
                punkt: state.punkt,
                turbinar: iRadius,
                signal,
                paaFramdrift: (delresultat, ferdig, totalt) => {
                    samla.push(...delresultat);
                    this.panel.visFramdrift(ferdig, totalt);
                    oppdaterStraumande();
                },
            });

            if (signal.aborted) return;

            // Kast eit eventuelt ventande straumande-kall. Elles fyrer det
            // etter denne teikninga og overskriv det ferdige samandraget med
            // eit ufullstendig eitt — sjå debounce() i utils/dom.js.
            oppdaterStraumande.avbryt();

            state.settResultat(resultat, samandrag, samlaStoy);
            this.sistAvkorta = avkorta;
            this.panel.skjulFramdrift();
            this.panel.tegn({
                punkt: state.punkt, resultat, samandrag, samlaStoy, avkorta,
                radiusM: state.radiusM, overflateKoyrer: this.overflateKoyrer,
                panoramaKoyrer: this.panoramaKoyrer,
            });
            this.kart.tegnSiktlinjer(state.punkt, resultat);
            this._tegnHinderlys();

            const utanProfil = resultat.filter((r) => !r.analysert).length;
            if (utanProfil > 0) {
                Toast.warning(`${utanProfil} turbinar mangla terrengdata og er ikkje synlegheitsvurderte.`);
            }

            // Var synlegheitskartet på? Bygg det på nytt for det nye settet.
            if (this._zviPaa) this._byggOgTegnZvi($('zvi-knapp'));
        } catch (e) {
            if (e.name === 'AbortError') return;
            this.panel.skjulFramdrift();
            Toast.error(`Analysen feila: ${e.message}`);
            console.error(e);
        }
    }

    // ------------------------------------------------- skog og bygningar (DOM)

    /**
     * =======================================================================
     * DOM-KRYSSJEKKEN ER EIT EIGE STEG, OG DET ER EIT VAL
     * =======================================================================
     * Hovudanalysen er rekna på bar bakke (dtm1) og skal halde fram med å
     * vere det appen svarer. Denne sjekken slår opp overflatemodellen
     * (dom1 — skog og bygningar med) i det EINE terrengpunktet som avgjer
     * siktlinja til kvar turbin, og reknar synlegheita om att med den heva
     * høgda. Sjå js/utils/SurfaceCheck.js og CLAUDE.md §22.
     *
     * Han køyrer ALDRI av seg sjølv for heile settet. Tre grunnar:
     *
     *  1. Han kostar ekte Kartverket-oppslag (~1 kall per 50 unike kritiske
     *     punkt), og dei aller fleste som klikkar rundt på kartet spør aldri
     *     om han.
     *  2. Hovudanalysen er rask og svarer med det same. Å henge eit steg til
     *     bakpå ville gjort heile opplevinga tregare for alle, for eit svar
     *     dei fleste ikkje bad om.
     *  3. Det er eit ANNA spørsmål enn det appen elles svarer på, og det bør
     *     brukaren sjå at han stiller.
     *
     * Unntaket er detaljvisinga: opnar du éin turbin, har du peika på nettopp
     * han, og eitt oppslag er det billegaste som finst. Sjå veljTurbin().
     */
    async kjoerOverflatesjekk() {
        if (this.overflateKoyrer || state.resultat.length === 0) return;

        this.overflateKoyrer = true;
        this._tegnPanelPaaNytt();

        try {
            const stats = await sjekkOverflate({
                resultat: state.resultat,
                paaFramdrift: (f, t) => this.panel.visFramdrift(f, t, 'Slår opp skog og bygningar'),
            });
            this.panel.skjulFramdrift();

            const o = overflateSamandrag(state.resultat);
            console.info(
                `[overflate] ${stats.sjekka} turbinar · ${stats.kall} kall · ${stats.msBrukt} ms`
                + ` · ${o.vesentlege} med hinder over ${CONFIG.overflate.terskelM} m`
                + ` · ${o.skjulte} vert skjulte · ${o.reduserte} reduserte`
                + ` · ${o.fraToppK} avgjorde av eit anna punkt enn bar bakke peika ut`
                + ` · ${stats.punkt} unike punkt av ${stats.punktBedne} bedne`,
            );

            if (o.skjulte > 0) {
                Toast.warning(
                    `${o.skjulte} av ${o.sjekka} synlege turbinar er skjulte når skog og `
                    + `bygningar vert rekna med. Sjå atterhaldet — sjekken gjeld inntil `
                    + `${CONFIG.overflate.toppK} punkt per turbin, ikkje heile profilen.`,
                );
            } else if (o.vesentlege === 0) {
                Toast.info('Ope terreng i alle dei avgjerande punkta — ingen skog eller bygningar som skjermar.');
            } else {
                Toast.info(`Ingen turbinar vert heilt skjulte, men ${o.reduserte} får mindre synleg del.`);
            }
        } catch (e) {
            if (e.name !== 'AbortError') {
                this.panel.skjulFramdrift();
                Toast.error(`Kunne ikkje hente overflatedata: ${e.message}`);
            }
        } finally {
            this.overflateKoyrer = false;
            this._tegnPanelPaaNytt();
            const vald = state.valdTurbinId ? state.finnResultat(state.valdTurbinId) : null;
            if (vald) this.panel.visDetalj(vald);
        }
    }

    /**
     * DOM-oppslag for ÉIN turbin — den brukaren nettopp opna.
     *
     * Eitt punkt, eitt kall, typisk 300-600 ms. Feilar det, seier me
     * ingenting: kryssjekken er eit tillegg, og eit tillegg som ikkje kom
     * fram skal ikkje sende ein feilmelding oppi ansiktet på nokon som berre
     * ville sjå på ein turbin.
     */
    async _sjekkOverflateFor(r) {
        if (!kanEndrastAvOverflate(r) || r.overflate || this.overflateVentar.has(r.id)) return;

        this.overflateVentar.add(r.id);
        try {
            await sjekkOverflate({ resultat: [r] });
        } catch {
            // Stille — sjå kommentaren over.
        } finally {
            this.overflateVentar.delete(r.id);
        }

        // Berre teikn på nytt om brukaren framleis står på same turbin.
        if (state.valdTurbinId === r.id) {
            this.panel.visDetalj(r, { overflateKoyrer: false });
        }
        // Rada i lista kan ha fått eit nytt merke.
        this._tegnPanelPaaNytt();
    }

    /** Teikn samandrag + liste på nytt frå gjeldande tilstand. */
    _tegnPanelPaaNytt() {
        if (!state.punkt) return;
        this.panel.tegn({
            punkt: state.punkt,
            resultat: state.resultat,
            samandrag: state.samandrag ?? byggSamandrag(state.resultat),
            samlaStoy: state.samlaStoy ?? null,
            avkorta: this.sistAvkorta,
            radiusM: state.radiusM,
            overflateKoyrer: this.overflateKoyrer,
            panoramaKoyrer: this.panoramaKoyrer,
        });
    }

    // ------------------------------------------------ brukarjustert posisjon

    /**
     * =======================================================================
     * KVIFOR EIN TURBIN KAN DRAGAST — OG KVA DET IKKJE ER
     * =======================================================================
     * 1 062 av turbinpunkta i appen er plasserte av VÅR EIGEN heuristikk inne i
     * NVE sitt planområde, og 212 til er berre eit senterpunkt for heile
     * anlegget. Målt mot vindparkar som faktisk er bygde bommar heuristikken
     * typisk ~1,3 rotordiameter (CLAUDE.md §12) — men på einskildpunkt langt
     * meir, og den som bur i dalen ser ofte sjølv kva rygg turbinane kjem på.
     *
     * Draginga gjer den kunnskapen brukbar: han flyttar punktet, og heile
     * analysen for nettopp den turbinen — siktlinje, dominans, støy, hinderlys,
     * skyggekast — vert rekna om for den nye staden med det same. Ingen
     * «Analyser»-knapp; det er akkurat den friksjonen dette skal fjerne.
     *
     * Det er derimot IKKJE ei retting av datasettet. Resultatet får
     * `posisjonKilde: 'brukerjustert'` og eit eige merke overalt i UI, det
     * lever berre i denne sideøkta, og det kan tilbakestillast. Sjå
     * js/utils/TurbinJustering.js for kvifor verifiserte NVE-punkt aldri kan
     * dragast i det heile.
     */

    /** Vis planområdet medan brukaren har tak i turbinen. */
    startTurbinFlytt(t) {
        const polygonar = this._planomrade(t.anleggsnr);
        if (polygonar.length > 0) this.kart.framhevOmrade(polygonar);
    }

    /** Brukaren har sleppt turbinen ein ny stad. */
    async fullfoerTurbinFlytt(t, lat, lon) {
        this.kart.skjulOmradeFramheving();

        const justert = state.flyttTurbin(t.id, lat, lon);
        if (!justert) return;
        this.kart.oppdaterTurbinMarkor(justert);

        /**
         * MJUKT GRENSEBAND, IKKJE SPERRE.
         *
         * Planområdet er kjeldefest hos NVE, så eit punkt langt utanfor er verd
         * å nemne. Men det finst gode grunnar til å teste eitt: brukaren kan
         * tru at avgrensinga vert endra, eller vilje sjå kva ein turbin på
         * naboryggen ville gjort. Difor ein toast, ikkje eit nei — og berre når
         * avviket er stort nok til å bety noko.
         */
        const utanfor = avstandUtanforPlanomrade(lat, lon, this._planomrade(justert.anleggsnr));
        if (utanfor > CONFIG.analyse.flyttAatvaringM) {
            Toast.warning(
                `Punktet ligg no rundt ${Math.round(utanfor / 10) * 10} m utanfor planområdet `
                + 'NVE har registrert for anlegget. Det er lov å teste — men søknaden gjeld arealet innanfor.',
            );
        }

        await this.reanalyserTurbin(justert);
    }

    /** Sett posisjonen tilbake til appens eige estimat. */
    async tilbakestillTurbinPosisjon(id) {
        const original = state.tilbakestillTurbin(id);
        if (!original) return;
        this.kart.oppdaterTurbinMarkor(original);
        Toast.info('Posisjonen er sett tilbake til den appen sjølv estimerte.');
        await this.reanalyserTurbin(original);
    }

    /**
     * Rekn analysen om att for ÉIN turbin, og oppdater heile biletet.
     *
     * =======================================================================
     * KVA SOM MÅ REKNAST PÅ NYTT — OG KVA SOM IKKJE MÅ
     * =======================================================================
     * Alt som gjeld den einskilde turbinen (siktlinje, dominans, støy,
     * hinderlys) heng berre saman med den eine terrengprofilen, så det er eitt
     * profil-kall og eitt `beregnPaaverknad()`.
     *
     * To ting går derimot på tvers av heile settet, og MÅ reknast om for alle:
     *
     *  - **Skyggekastet er ei UNION** over årets minutt (CLAUDE.md §11). Flyttar
     *    ein turbin seg, kan minutt som før var delte med ein nabo bli
     *    einerådande — eller motsett. Å berre byte ut den eine oppføringa ville
     *    gitt eit punktsum som ikkje svarer til noko.
     *  - **Samla støy** er ein energetisk sum; han må byggjast av heile lista.
     *
     * Soltabellen sjølv avheng berre av PUNKTET og vert gjenbrukt, så den dyre
     * delen av skyggekastet (~140 ms) betalast berre éin gong per punkt.
     */
    async reanalyserTurbin(turbin) {
        const punkt = state.punkt;
        if (!punkt) return; // Ingen analyse å oppdatere — markøren er berre flytta.

        const utan = state.resultat.filter((r) => r.id !== turbin.id);
        const varMed = utan.length !== state.resultat.length;

        const iFilter = state.statusFilter.size === 0 || state.statusFilter.has(turbin.status);
        const avstand = haversine(punkt.lat, punkt.lon, turbin.lat, turbin.lon);

        // Dratt ut av radiusen: ta han ut av resultatet i staden for å la ein
        // turbin utanfor analyseområdet bli ståande i lista med gamle tal.
        if (avstand > state.radiusM || !iFilter) {
            if (varMed) {
                Toast.info(`${turbin.navn} er no utanfor analyseradiusen og er teken ut av resultatet.`);
                this.panel.lukkDetalj();
                this._settOppdatertResultat(utan);
            }
            return;
        }

        this.panel.visFramdrift(0, 1);
        let profil = null;
        try {
            const svar = await hentProfilar(
                { lat: punkt.lat, lon: punkt.lon },
                [{ id: turbin.id, lat: turbin.lat, lon: turbin.lon }],
            );
            profil = svar.profiles?.[turbin.id] ?? null;
        } catch (e) {
            Toast.error(`Fekk ikkje terrengdata for den nye plasseringa: ${e.message}`);
        }
        this.panel.skjulFramdrift();

        const nytt = beregnPaaverknad({ punkt, turbin, profil });

        // Utan profil er avstand og dominans framleis rette, men synlegheita er
        // ikkje vurdert i det heile. Det MÅ seiast: ei rad som berre mistar
        // synlegheitsprosenten sin ser ut som «ingenting er synleg», og det er
        // eit heilt anna svar enn «me veit ikkje».
        if (!nytt.analysert) {
            Toast.warning('Fekk ikkje terrengdata for den nye plasseringa — '
                + 'turbinen står som ikkje synlegheitsvurdert. Prøv å dra han litt på nytt.');
        }

        this._settOppdatertResultat([...utan, nytt], nytt.id);
    }

    /**
     * Set eit endra resultatsett og teikn alt som heng på det.
     *
     * @param {object[]} liste
     * @param {string|null} veljId Turbinen detaljvisinga skal stå på etterpå
     */
    _settOppdatertResultat(liste, veljId = null) {
        const punkt = state.punkt;
        liste.sort((a, b) => a.avstandM - b.avstandM);

        // Skyggekast: heile unionen på nytt, men med gjenbrukt soltabell.
        for (const r of liste) r.skyggekast = null;
        const kandidatar = liste.filter(
            (r) => r.analysert && r.avstandM <= maksSkyggeavstandM(r.rotorDiameterM),
        );
        let skyggekast = null;
        if (kandidatar.length > 0) {
            const { perTurbin, samla } = skyggekastForAlle(kandidatar, this._hentSoltabell(punkt));
            for (const r of liste) {
                const s = perTurbin.get(r.id);
                if (s) r.skyggekast = s;
            }
            skyggekast = samla;
        }

        const samandrag = byggSamandrag(liste);
        samandrag.skyggekast = skyggekast;
        const samlaStoy = samletStoy(liste.filter((r) => r.stoy).map((r) => r.stoy.lpDb));

        state.settResultat(liste, samandrag, samlaStoy);
        this.panel.tegn({
            punkt, resultat: liste, samandrag, samlaStoy,
            avkorta: this.sistAvkorta, radiusM: state.radiusM,
            overflateKoyrer: this.overflateKoyrer,
            panoramaKoyrer: this.panoramaKoyrer,
        });
        this.kart.tegnSiktlinjer(punkt, liste);
        this._tegnHinderlys();

        if (veljId) {
            const r = state.finnResultat(veljId);
            if (r) {
                state.veljTurbin(veljId);
                this.kart.uthevTurbin(veljId);
                // Ein flytta turbin har ein heilt ny profil og dermed eit nytt
                // kritisk punkt — den gamle DOM-domen gjeld ikkje lenger, og
                // objektet er uansett bytt ut. Slå opp på nytt for den nye staden.
                const ventar = kanEndrastAvOverflate(r) && !r.overflate;
                this.panel.visDetalj(r, { overflateKoyrer: ventar });
                if (ventar) this._sjekkOverflateFor(r);
            }
        }
    }

    /** Soltabell for punktet, bygd éin gong. */
    _hentSoltabell(punkt) {
        const nokkel = `${punkt.lat.toFixed(4)},${punkt.lon.toFixed(4)}`;
        if (this._soltabell?.nokkel !== nokkel) {
            this._soltabell = { nokkel, tabell: byggSoltabell(punkt) };
        }
        return this._soltabell.tabell;
    }

    /** Planområde-polygona for eit anlegg, som liste av ring-samlingar. */
    _planomrade(anleggsnr) {
        return (this.omrader?.omrader ?? [])
            .filter((o) => o.anleggsnr === anleggsnr)
            .map((o) => o.ringer);
    }

    // -------------------------------------------------------------- panorama

    /**
     * Opne 3D-panoramaet — PROGRESSIVT.
     *
     * =====================================================================
     * SCENA OPNAR PÅ DET BILLEGASTE DATASETTET, IKKJE PÅ DET SISTE
     * =====================================================================
     * Til og med versjonen før denne venta `Promise.all` på ALLE tre
     * hentingane før `opne()` i det heile vart kalla. Målt kva det kosta
     * brukaren i skjerm utan innhald:
     *
     *   Storheia, varm cache:   horisont 76 ms · nærfelt 104 ms
     *                           · flyfoto 10 586 ms  →  11,6 s svart skjerm
     *   Høg-Jæren, kald cache:  horisont 60 879 ms · nærfelt 10 500 ms
     *                           · flyfoto 9 010 ms  →  71,4 s svart skjerm
     *
     * Legg merke til det varme tilfellet: alle høgdedata låg klare på 0,2
     * sekund, og brukaren venta likevel elleve sekund — på eit flyfoto som
     * berre er ei TEKSTUR på ein mesh som alt kunne vore teikna.
     *
     * Difor er rekkjefølgja no styrt av kva kvar kjelde er verdt:
     *
     *   1. `resultat` og `punkt` er klare frå analysen. Turbinane, hinderlysa
     *      og klippeplana treng ingenting anna.
     *   2. HORISONTEN er det einaste obligatoriske — han gir både silhuetten,
     *      grovmeshen og `augeMoh`. Så snart han er inne, opnar scena.
     *   3. NÆRFELTET og FLYFOTOET vert drassa inn etterpå, kvar for seg, i
     *      eit panorama brukaren alt kan snu seg rundt i.
     *
     * Ingen av dei tre er ei ny modellføresetnad: nærfeltet er berre finare
     * geometri (§18) og flyfotoet berre ein tekstur (§17). Kva som er
     * SYNLEG er avgjort av horisonten i steg 2 og endrar seg aldri undervegs.
     *
     * Hentingane vert IKKJE avbrotne om brukaren lukkar panoramaet — dei
     * fyller klientcachen, så neste opning er gratis. Det er BRUKEN av dei
     * som er vakta, med økt-id-en frå `opne()`.
     */
    visFotomontasje() {
        if (!state.punkt || state.resultat.length === 0) {
            Toast.info('Analyser eit punkt først.');
            return;
        }
        this.fotomontasje.opne({ punkt: state.punkt, resultat: state.resultat });
    }

    async visPanorama() {
        const punkt = state.punkt;
        if (!punkt || this.panoramaKoyrer) return;

        // Sperr «Vis 3D-panorama» til scena er oppe (ei kald henting tek
        // 10-60 s). Flagget vert lese av _samandragHtml, så knappen står som
        // «Byggjer …» også om panelet vert teikna på nytt undervegs.
        this.panoramaKoyrer = true;
        this._tegnPanelPaaNytt();

        const start = performance.now();
        const trengHorisont = !harHorisont(punkt);
        const trengNaer = !harNaerTerreng(punkt);
        const trengFoto = !harSatellittdekke(punkt);

        // Toasten lever berre FRAM TIL scena opnar. Etter det ligg han bak
        // panoramaoverlegget uansett, og statuslinja i HUD-en tek over.
        if (trengHorisont) Toast.info('Byggjer 3D-panorama... hentar 360° terreng');

        /**
         * BIBLIOTEKET NED SAMTIDIG MED DATA, IKKJE ETTER.
         *
         * `opne()` kan ikkje byggje ei scene før Three.js er inne, og på eit
         * varmt punkt er den nedlastinga heile ventetida (målt 2,8 s mot
         * 0,1 s for horisonten). Å starte henne her - før det fyrste `await`
         * - gjer at ho går parallelt med terrenghentinga i staden for å
         * leggje seg oppå henne.
         */
        this.panorama.forhandslast();

        /** Måletal til den oppsummerande konsollinja heilt til slutt. */
        const maalt = { open: null, naer: null, foto: null };

        /**
         * ØKT-ID-EN ER DEN EINE DELTE TILSTANDEN.
         *
         * `undefined` tyder «scena er ikkje oppe enno», og alle dei
         * etterslepande handlingane sjekkar han. Han vert sett EIN gong, av
         * den fyrste horisonten som landar.
         */
        let okt;
        /**
         * Opninga sjølv, som eit promise.
         *
         * Å berre ha eit boolsk «opning er starta»-flagg her var ein reell
         * feil: `opne()` ventar på Three.js, og på eit varmt punkt rakk HEILE
         * horisonten å bli ferdig i mellomtida. Det siste kallet såg då at ei
         * opning var i gang, returnerte med det same, og `okt` var framleis
         * `undefined` når `visPanorama()` skulle gå vidare — så funksjonen
         * gav opp før nærfeltet i det heile vart henta. Symptomet var
         * forvirrande: scena stod der og flisane kom inn (dei hadde sin eigen
         * referanse til `okt`), men terrenget vart aldri fortetta og
         * sluttlogga kom aldri.
         */
        let opning = null;

        /** Flisringar som har landa, i den rekkjefølgja dei kom. */
        const landa = [];
        const dekke = () => (landa.length
            ? { ringar: [...landa], attribusjon: CONFIG.panorama.satellitt.attribusjon }
            : null);

        try {
            /**
             * ===========================================================
             * KVA SOM OPNAR SCENA, OG KVA SOM BERRE GJER HENNE BETRE
             * ===========================================================
             * Ei kald horisonthenting tek 45-60 s, og ho lèt seg ikkje
             * parallellisere bort: målt på kjeda php -S -> ElevationService
             * -> Kartverket WPS gjekk tre samtidige profilkall reint
             * SEKVENSIELT (11 s, 22 s, 32 s). Flaskehalsen er oppstraums, ikkje
             * talet HTTP-kall — så ventetida må omgåast, ikkje optimaliserast.
             *
             * Fyrste ferdige batch er alt ein brukbar 360°-horisont
             * (`paaDelvis`), og den opnar scena. Alt anna — resten av
             * retningane, nærfeltet, flisringane — kjem inn i eit panorama
             * brukaren alt kan snu seg rundt i.
             *
             * Alle som kjem medan opninga går, VENTAR på henne og bruker
             * horisonten sin etterpå — dei returnerer ikkje. Sjå kommentaren
             * ved `opning` for kva som gjekk gale då dei gjorde det.
             */
            const opneEllerOppdater = async (h) => {
                if (opning) {
                    await opning;
                    this.panorama.oppdaterHorisont(h, okt);
                    return;
                }
                maalt.open = Math.round(performance.now() - start);
                opning = this.panorama.opne({
                    punkt,
                    resultat: state.resultat,
                    horisont: h,
                    // Ein flisring kan ha landa alt medan horisonten var undervegs.
                    satellitt: dekke(),
                    naerTerreng: null,
                    ventar: h.delvis || trengNaer || trengFoto,
                });
                okt = await opning;
            };

            const pHorisont = hentHorisont({
                punkt,
                paaFramdrift: (f, t) => {
                    if (f >= t) return;
                    if (okt === undefined) {
                        Toast.info(`Byggjer 3D-panorama... terreng ${f}/${t} retningar`);
                    } else {
                        this._panoramaStatus(okt, `Skjerpar terrenget ... ${f}/${t} retningar`);
                    }
                },
                paaDelvis: (delvis) => {
                    opneEllerOppdater(delvis).catch((e) => {
                        console.warn('Kunne ikkje vise delvis horisont:', e.message);
                    });
                },
            });

            /**
             * FLISANE GÅR HEILT FOR SEG SJØLV.
             *
             * Dei deler korkje tenar, kø eller data med høgdedata — berre
             * lat/lon — og startar difor i same augeblink som horisonten.
             * Kvar ferdig ring vert drapert med det same.
             *
             * `oppdaterSatellitt()` får ein KOPI av lista kvar gong: han held
             * på referansen sin til neste ombygging, og ei liste som veks
             * under føtene på han ville gitt eit mesh delt etter ein annan
             * ringtilstand enn den han faktisk teiknar.
             */
            const pFoto = hentSatellittdekke({
                punkt,
                paaFramdrift: (f, t) => {
                    if (okt === undefined || !trengFoto || f >= t) return;
                    this._panoramaStatus(okt, `Legg på flyfoto ... ${f}/${t} flisar`);
                },
                paaRing: (ring) => {
                    landa.push(ring);
                    if (okt !== undefined) this.panorama.oppdaterSatellitt(dekke(), okt);
                },
            }).catch((e) => {
                console.warn('Flyfoto feila, bruker prosedyrefarge:', e.message);
                return null;
            });

            // ---- Den ferdige horisonten -------------------------------
            const horisont = await pHorisont;
            await opneEllerOppdater(horisont);
            if (okt === undefined) return; // #panorama fanst ikkje i DOM-en

            /**
             * NÆRFELTET MÅ VENTE PÅ HORISONTEN, og på HEILE han: det er dei
             * lange strålane sine radiar som gir det felles radiusrutenettet
             * begge terrengsetta samplast om til (NaerTerreng.js, §18). Eit
             * delvis radiusrutenett ville gitt ein mesh med skøyt.
             */
            if (trengNaer) this._panoramaStatus(okt, 'Fortettar nærterreng ...');
            const pNaer = hentNaerTerreng({ punkt, horisont })
                .then((nt) => {
                    maalt.naer = Math.round(performance.now() - start);
                    this.panorama.oppdaterNaerTerreng(nt, okt);
                    return nt;
                })
                .catch((e) => {
                    console.warn('Nærfelt feila, bruker grovmeshen:', e.message);
                    return null;
                });

            const [naerTerreng, satellitt] = await Promise.all([pNaer, pFoto]);
            maalt.foto = Math.round(performance.now() - start);

            /**
             * Det ENDELEGE dekket kan vere `null` sjølv om enkeltringar alt er
             * draperte: `hentSatellittdekke()` forkastar heile dekket når meir
             * enn halvparten av flisane feila. Då må prosedyrefargen tilbake,
             * og `oppdaterSatellitt(null, ...)` er nettopp den tilbakerullinga.
             */
            this.panorama.oppdaterSatellitt(satellitt, okt);
            this.panorama.settStatus('', okt);

            const ringInfo = satellitt
                ? satellitt.ringar
                    .map((r) => `${Math.round(r.radiusM / 100) / 10}km@z${r.z}`
                              + `(${r.mPerPiksel.toFixed(1)}m/px, ${r.talFlisar}fl)`)
                    .join(' ')
                : 'ikkje tilgjengeleg';
            console.info(
                `[panorama] SYNLEG etter ${maalt.open} ms`
                + ` · horisont ferdig ${horisont.hentaMs} ms`
                + ` · nærfelt inne ${maalt.naer ?? '-'} ms: ${naerTerreng
                    ? `${naerTerreng.hentaMs} ms henta, ${naerTerreng.talEkstra} strålar`
                      + ` → ${naerTerreng.talRetningar} retningar`
                      + ` × ${naerTerreng.radier.length} radiar`
                      + `${naerTerreng.feila ? ` (${naerTerreng.feila} feila)` : ''}`
                    : '- (grovmesh)'}`
                + ` · flyfoto inne ${maalt.foto} ms: ${satellitt
                    ? `${satellitt.hentaMs} ms henta, ${satellitt.talFlisar} flisar`
                      + `${satellitt.feila ? ` (${satellitt.feila} feila)` : ''}` : '-'}`
                + ` · ringar ${ringInfo}`
                + ` · totalt ${Math.round(performance.now() - start)} ms`,
            );
        } catch (e) {
            Toast.error('Klarte ikkje hente horisont: ' + e.message);
        } finally {
            this.panoramaKoyrer = false;
            this._tegnPanelPaaNytt();
        }
    }

    /**
     * Skriv statuslinja i panoramaet, men berre om økta framleis gjeld.
     *
     * Strupa til eitt kall per 400 ms: flisframdrifta kjem med nokre titals
     * millisekund mellom seg, og eit `textContent`-skriv per flis ville vore
     * 250 DOM-skriv for eit tal auget ikkje rekk å lese. Ei tom melding (og
     * kvar melding etter ein pause) går alltid gjennom, slik at linja
     * garantert forsvinn når alt er ferdig.
     */
    _panoramaStatus(okt, tekst) {
        const no = performance.now();
        if (tekst && no - (this._sistPanoramaStatus ?? 0) < 400) return;
        this._sistPanoramaStatus = no;
        this.panorama.settStatus(tekst, okt);
    }

    // ---------------------------------------------------------------- detalj

    veljTurbin(id) {
        const r = state.finnResultat(id);
        if (!r) return;
        state.veljTurbin(id);
        this.kart.uthevTurbin(id);
        this.kart.panorerTil(r.lat, r.lon);

        /**
         * DOM-KRYSSJEKK FOR NETTOPP DENNE TURBINEN.
         *
         * Å opne ein detalj er å peike på éin turbin, og eitt punktoppslag er
         * det billegaste kallet appen har. Difor går det automatisk her, medan
         * heile settet krev eit trykk (sjå kjoerOverflatesjekk()).
         *
         * `visDetalj` vert kalla FØR ventinga med `overflateKoyrer: true`, slik
         * at panelet opnar med det same og viser at oppslaget er i gang — i
         * staden for å stå tomt eller, verre, vise «ingen skog» i eit halvt
         * sekund før svaret kjem.
         */
        const ventar = kanEndrastAvOverflate(r) && !r.overflate;
        this.panel.visDetalj(r, { overflateKoyrer: ventar });
        if (ventar) this._sjekkOverflateFor(r);
    }

    visTurbinPopup(t) {
        const status = CONFIG.status[t.status] ?? CONFIG.status.ukjent;
        const erPlassholdar = t.posisjon_kilde === 'anlegg_senterpunkt';
        const erEstimert = t.posisjon_kilde === 'estimert_i_omrade';
        const krav = hinderlysKrav({ totalhoydeM: t.totalhoyde_m, navHoydeM: t.nav_hoyde_m });

        this.kart.visPopup(t.lat, t.lon, `
            <div class="kart-popup">
                <strong>${escHtml(t.navn)}</strong>
                <div class="popup-status" style="color:${status.farge}">${escHtml(status.tekst)}</div>
                ${t.eier ? `<div class="popup-eier"><i class="fa-solid fa-building"></i> ${escHtml(t.eier)}</div>` : ''}
                <div class="popup-meta">
                    Navhøgd ~${Math.round(t.nav_hoyde_m)} m · rotor ~${Math.round(t.rotor_diameter_m)} m
                    · totalhøgd ~${Math.round(t.totalhoyde_m)} m
                    <em>(${t.mal_kilde === 'kjent_soknad' ? 'frå søknad' : 'estimert'})</em>
                </div>
                ${krav.merkeplikt ? `
                    <div class="popup-lys">
                        <i class="fa-solid fa-circle ${krav.hoyintensitet ? 'popup-lys-kvit' : 'popup-lys-raud'}"></i>
                        ${escHtml(krav.toppType.kortTekst)} på nacellen${krav.talNivaa > 1
                            ? ` + ${krav.talNivaa - 1} mellomnivå` : ''}
                    </div>` : ''}
                ${erPlassholdar
                    ? '<div class="popup-aatvaring">Senterpunkt for heile anlegget — turbinposisjonar er ikkje fastsette.</div>'
                    : ''}
                ${erEstimert
                    ? '<div class="popup-aatvaring">Estimert plassering inne i det verkelege planområdet — ikkje ein omsøkt turbinposisjon. <strong>Dra markøren</strong> om du veit betre.</div>'
                    : ''}
                ${erJustert(t)
                    ? `<div class="popup-aatvaring popup-justert">
                           <i class="fa-solid fa-arrows-up-down-left-right"></i>
                           <strong>Du har flytta denne turbinen</strong>
                           ${Number.isFinite(t.flytt_avstand_m)
                               ? ` ${Math.round(t.flytt_avstand_m)} m` : ''}
                           frå plasseringa appen estimerte. Tala gjeld din posisjon, ikkje NVE sin.
                       </div>`
                    : ''}
            </div>`);
    }

    // ------------------------------------------------------------- nattmodus

    /**
     * Slå nattmodus av/på.
     *
     * Med ei fullført analyse teiknar me berre dei lyspunkta som FAKTISK er
     * synlege frå punktet. Utan analyse har me ingen terrengdata, og då viser
     * me toppslysa for turbinane i kartutsnittet med eit tydeleg atterhald —
     * det er betre enn ein tom skjerm, men skal ikkje forvekslast med eit svar.
     */
    vekslNattmodus(knapp) {
        const paa = !this.kart.nattmodus;
        this.kart.settNattmodus(paa);
        knapp?.classList.toggle('aktiv', paa);
        this._tegnHinderlys();

        if (paa && !state.punkt) {
            Toast.info('Vel eit punkt i kartet for å sjå kva hinderlys som faktisk er synlege derifrå.');
        }
    }

    _tegnHinderlys() {
        if (!this.kart.nattmodus) return;
        const analyserte = state.resultat.filter((r) => r.analysert);
        this.kart.tegnHinderlys(
            analyserte,
            analyserte.length === 0 ? this._synlegeTurbinar() : null,
        );
    }

    /** Turbinane som er påslegne i statusfilteret. */
    _synlegeTurbinar() {
        return state.turbinar.filter(
            (t) => state.statusFilter.size === 0 || state.statusFilter.has(t.status),
        );
    }

    // ------------------------------------------------------------ delbar URL

    _oppdaterUrl(lat, lon) {
        const url = new URL(window.location.href);
        url.searchParams.set('lat', lat.toFixed(5));
        url.searchParams.set('lon', lon.toFixed(5));
        url.searchParams.set('r', String(state.radiusM));
        window.history.replaceState(null, '', url);
    }

    _lesUrlPunkt() {
        const p = new URLSearchParams(window.location.search);
        const lat = Number.parseFloat(p.get('lat'));
        const lon = Number.parseFloat(p.get('lon'));
        const r = Number.parseInt(p.get('r'), 10);

        if (Number.isFinite(r) && CONFIG.analyse.valgbareRadiusM.includes(r)) {
            state.settRadius(r);
            const vel = $('radius-vel');
            if (vel) vel.value = String(r);
        }
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
            this.kart.kart.setView([lat, lon], 12);
            this.settPunkt(lat, lon);
        }
    }

    async delLenke() {
        if (!state.punkt) {
            Toast.info('Vel eit punkt først.');
            return;
        }
        const url = window.location.href;
        try {
            if (navigator.share) {
                await navigator.share({ title: 'Vindkraft-påverknad', url });
            } else {
                await navigator.clipboard.writeText(url);
                Toast.success('Lenka er kopiert.');
            }
        } catch {
            // Brukaren avbraut delinga — ikkje ein feil å melde frå om.
        }
    }

    /**
     * Eksporter dei analyserte turbinane (state.resultat) til KML, med
     * siktlinjer frå punktet farga etter synleg/skjult. Til bruk i Google
     * Earth / Google My Maps.
     */
    eksporterAnalyserteKml() {
        if (!state.punkt || state.resultat.length === 0) {
            Toast.info('Analyser eit punkt først.');
            return;
        }
        const kml = byggKmlAnalyserteTurbinar(state.punkt, state.resultat);
        lastNedFil('vindkraft-analyse.kml', kml);
        Toast.success(`Eksporterte ${state.resultat.length} turbinar til KML.`);
    }

    /**
     * Eksporter heile det (statusfiltrerte) turbindatasettet til KML —
     * uavhengig av om noko er analysert.
     */
    eksporterAlleKml() {
        if (state.turbinar.length === 0) {
            Toast.info('Turbindata er ikkje lasta enno.');
            return;
        }
        const kml = byggKmlAlleTurbinar(state.turbinar, state.statusFilter);
        lastNedFil('vindturbinar-noreg.kml', kml);
        Toast.success('Eksporterte heile datasettet til KML.');
    }

    // ------------------------------------------------------------ PDF-rapport

    /**
     * Éin-sides rapport for punktet. Fyller #utskrift og opnar
     * utskriftsdialogen — brukaren vel «Lagre som PDF». Ingen bibliotek:
     * `@media print` viser berre #utskrift, `@media screen` skjuler han.
     */
    skrivUt() {
        if (!state.punkt || state.resultat.length === 0) {
            Toast.info('Analyser eit punkt først.');
            return;
        }
        const el = $('utskrift');
        if (!el) return;
        el.innerHTML = this._byggUtskrift();
        // Layouten treng éin frame før utskriftsdialogen les han.
        requestAnimationFrame(() => window.print());
    }

    _byggUtskrift() {
        const p = state.punkt;
        const s = state.samandrag ?? byggSamandrag(state.resultat);
        const stoy = state.samlaStoy;
        const kh = s.kumulativHorisont;
        const sk = s.skyggekast;
        const hl = s.hinderlys;
        const o = overflateSamandrag(state.resultat);
        const naa = new Date();

        const tittel = this.sisteAdresse
            ? escHtml(this.sisteAdresse)
            : `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;

        const rad = (dt, dd) => `<tr><th>${dt}</th><td>${dd}</td></tr>`;

        // Per anlegg: kor mange turbinar analyserte / synlege.
        const perAnlegg = new Map();
        for (const r of state.resultat) {
            const a = perAnlegg.get(r.anleggsnr) ?? { analyserte: 0, synlege: 0 };
            a.analyserte += 1;
            if (r.analysert && r.synlegheit.nokkel !== 'skjult') a.synlege += 1;
            perAnlegg.set(r.anleggsnr, a);
        }
        const anleggRader = [...perAnlegg.entries()]
            .map(([nr, a]) => {
                const anlegg = state.finnAnlegg(nr);
                const namn = anlegg?.navn ?? `Anlegg ${nr}`;
                const stad = anlegg?.kommune && anlegg.kommune.toLowerCase() !== namn.toLowerCase()
                    ? ` (${escHtml(anlegg.kommune)})` : '';
                const status = anlegg?.status ? CONFIG.status[anlegg.status]?.tekst ?? '' : '';
                return `<tr><td>${escHtml(namn)}${stad}</td><td>${escHtml(status)}</td>`
                     + `<td>${a.synlege} / ${a.analyserte}</td></tr>`;
            }).join('');

        const delelenke = `${location.origin}${location.pathname}`
            + `?lat=${p.lat.toFixed(5)}&lon=${p.lon.toFixed(5)}&r=${state.radiusM}`;

        return `
        <header class="u-topp">
            <h1>Vindkraft-påverknad</h1>
            <p class="u-undertittel">Vurdering for <strong>${tittel}</strong></p>
            <p class="u-meta">Radius ${Math.round(state.radiusM / 1000)} km ·
                utskrift ${fmtDato(naa.toISOString())} ${naa.toTimeString().slice(0, 5)}</p>
        </header>

        <table class="u-tabell">
            ${rad('Punkt', `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)} · bakke ${fmtMoh(p.hoyde)}${p.terreng ? ` · ${escHtml(p.terreng)}` : ''}`)}
            ${rad('Synlege turbinar', `<strong>${s.synlege}</strong> av ${s.analyserte} analyserte`)}
            ${rad('Rotor i fri sikt', `${s.rotorSynlege}`)}
            ${rad('Næraste turbin', s.naermaste ? `${fmtAvstand(s.naermaste.avstandM)} mot ${escHtml(s.naermaste.retning)}` : '–')}
            ${rad('Næraste synlege', s.naermasteSynlege ? `${escHtml(s.naermasteSynlege.navn)}, ${fmtAvstand(s.naermasteSynlege.avstandM)}` : 'Ingen synlege')}
            ${rad('Mest dominerande', s.mestDominerande
                ? `${escHtml(s.mestDominerande.navn)} — ${escHtml(s.mestDominerande.dominans.tekst.toLowerCase())} (${s.mestDominerande.dominans.synsvinkelGrader.toFixed(1)}° synsvinkel)`
                : 'Ingen synlege turbinar')}
            ${kh && kh.gradar > 0 ? rad('Horisontbelastning', `Turbinane fyller <strong>${kh.gradar}°</strong> av synsranda${kh.anlegg > 1 ? ` · ${kh.anlegg} anlegg` : ''}`) : ''}
            ${rad('Samla støyestimat', stoy
                ? `L<sub>den</sub> <strong>${fmtDb(stoy.ldenDb)}</strong> (L<sub>pA</sub> ${fmtDb(stoy.lpDb)}) · T-1442 rettleiande grense 45 dB`
                : '–')}
            ${sk ? rad('Skyggekast (teoretisk)', sk.turbinarMedSkygge === 0
                ? 'Ingen turbinar kan geometrisk kaste skugge på punktet'
                : `<strong>${fmtTimar(sk.timarPerAar)}/år</strong>, verste dag ${Math.round(sk.maksMinuttPerDag)} min · NVE-praksis: 30 t/år / 30 min/dag (teoretisk)`) : ''}
            ${hl && hl.merkepliktige > 0 ? rad('Hinderlys om natta',
                `${hl.lyspunktSynlege} synlege lyspunkt frå ${hl.merkepliktige} merkepliktige turbinar`) : ''}
            ${o.sjekka > 0 ? rad('Skog og bygningar (DOM)',
                `${o.skjulte} av ${o.sjekka} synlege turbinar skjulte når vegetasjon/hus vert rekna med (nedre grense)`)
                : rad('Skog og bygningar (DOM)', 'Ikkje sjekka — hovudtala er bar bakke')}
        </table>

        ${anleggRader ? `
        <h2>Anlegg i analysen</h2>
        <table class="u-tabell u-anlegg">
            <tr><th>Anlegg</th><th>Status</th><th>Synlege / analyserte</th></tr>
            ${anleggRader}
        </table>` : ''}

        <div class="u-atterhald">
            <strong>Forenkla illustrasjon — ikkje ei konsekvensutgreiing.</strong>
            Terrengmodellen er bar bakke (Kartverket DTM); skog og bygningar er ikkje med i
            hovudtala. Turbinmål og lydeffekt finst ikkje i NVE-datasettet — dei er estimerte
            frå merkeeffekt eller henta frå søknadsdokument. Støytala er grove overslag, ikkje
            ein akustisk fagrapport. Skyggekastet er teoretisk (skyfri himmel, rotor alltid mot
            sola). For planlagde anlegg er turbinposisjonane estimerte innanfor NVE sitt
            planområde. Sjå «Om modellen» i appen for detaljar.
        </div>

        <footer class="u-bunn">
            <span>Datakjelde: NVE (vindkraftanlegg, ${fmtDato(state.datagrunnlagGenerert)}) og Kartverket (høgdedata).</span>
            <span>Gjenskap: ${escHtml(delelenke)}</span>
        </footer>`;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new VindApp().start();
});
