/**
 * js/state.js
 *
 * Einaste kjelde til appens tilstand (mønster frå RegSøk).
 *
 * Modulen er bevisst "dum": han held data og varslar lyttarar når noko endrar
 * seg. All logikk ligg i Manager-klassene og utils. Det gjer det lett å svare
 * på "kven endra denne verdien?" — svaret er alltid eit `sett*`-kall her.
 */

import { CONFIG } from './config.js';
import { kanFlyttast, erJustert, flyttTurbin, tilbakestillTurbin } from './utils/TurbinJustering.js';

/** Enkel observerbar tilstand med emne-baserte lyttarar. */
class AppState {
    constructor() {
        /** @type {object[]} Alle turbinar frå cachen. */
        this.turbinar = [];
        /** @type {object[]} Alle anlegg (senterpunkt-attributt). */
        this.anlegg = [];
        /** @type {Map<number, object>} anleggsnr → anlegg, sett i settDatagrunnlag(). */
        this.anleggPerNr = new Map();
        /** @type {string|null} Når cachen vart generert. */
        this.datagrunnlagGenerert = null;

        /**
         * Det ANALYSERTE punktet — det resultata i panelet gjeld.
         * @type {{lat:number, lon:number, hoyde:number, terreng:string}|null}
         */
        this.punkt = null;

        /**
         * Eit punkt brukaren har peika ut, men ikkje stadfesta.
         *
         * Skiljet mellom `kandidat` og `punkt` er heile grunnen til at eit
         * feilklikk på kartet ikkje lenger kostar 150 terrengoppslag: så lenge
         * eit punkt berre er kandidat, har appen ikkje gjort eit einaste
         * nettverkskall for det.
         *
         * @type {{lat:number, lon:number}|null}
         */
        this.kandidat = null;

        /** @type {number} Analyseradius i meter. */
        this.radiusM = CONFIG.analyse.standardRadiusM;

        /** @type {Set<string>} Statusar som visast på kartet. */
        this.statusFilter = new Set(CONFIG.standardStatusFilter);

        /** @type {object[]} Utrekna resultat for turbinar i radius. */
        this.resultat = [];

        /** @type {object|null} Samandrag frå ImpactCalculator. */
        this.samandrag = null;

        /** @type {object|null} Samla støyestimat. */
        this.samlaStoy = null;

        /** @type {string|null} Id på turbinen som er vald i panelet. */
        this.valdTurbinId = null;

        /** @type {{aktiv:boolean, ferdig:number, totalt:number}} */
        this.framdrift = { aktiv: false, ferdig: 0, totalt: 0 };

        /** @type {Map<string, Function[]>} */
        this._lyttarar = new Map();
    }

    /** Abonner på eit emne. Returnerer ein funksjon som avsluttar abonnementet. */
    paa(emne, fn) {
        if (!this._lyttarar.has(emne)) this._lyttarar.set(emne, []);
        this._lyttarar.get(emne).push(fn);
        return () => {
            const liste = this._lyttarar.get(emne) ?? [];
            const i = liste.indexOf(fn);
            if (i >= 0) liste.splice(i, 1);
        };
    }

    /** Varsle lyttarane på eit emne. */
    _varsle(emne, data) {
        for (const fn of this._lyttarar.get(emne) ?? []) {
            try {
                fn(data);
            } catch (e) {
                // Ein feilande lyttar skal ikkje stoppe dei andre.
                console.error(`Lyttar for "${emne}" feila:`, e);
            }
        }
    }

    // --------------------------------------------------------------- setjarar

    /**
     * ANLEGGSFELT SOM VERT SLÅTT NED PÅ TURBINNIVÅ.
     *
     * `eier` (og `sakslenke`) finst berre på anleggsobjekta i cachen, ikkje på
     * kvar turbin. Alternativet til å slå dei ned her ville vore å tre eit
     * oppslag gjennom MapManager, AnalyseRunner, ImpactCalculator og
     * ImpactPanel — fire modular som elles ikkje treng å vite at anlegg finst.
     *
     * Samanslåinga skjer difor ÉIN gong ved innlasting, på den staden som
     * allereie har begge listene. Kostnaden er ei løkke over ~1600 objekt.
     * Cachen sjølv held fram med å lagre feltet éin gong per anlegg, ikkje
     * éin gong per turbin.
     */
    static ANLEGGSFELT = ['eier', 'sakslenke', 'kommune', 'fylke'];

    settDatagrunnlag({ turbiner, anlegg, generert }) {
        this.anlegg = anlegg ?? [];
        this.datagrunnlagGenerert = generert ?? null;

        /** @type {Map<number, object>} anleggsnr → anlegg. */
        this.anleggPerNr = new Map(this.anlegg.map((a) => [a.anleggsnr, a]));

        this.turbinar = (turbiner ?? []).map((t) => {
            const a = this.anleggPerNr.get(t.anleggsnr);
            if (!a) return t;
            const ut = { ...t };
            for (const felt of AppState.ANLEGGSFELT) {
                if (ut[felt] === undefined && a[felt] != null) ut[felt] = a[felt];
            }
            return ut;
        });

        this._varsle('datagrunnlag', this);
    }

    /** @returns {object|null} Anlegget eit turbinpunkt høyrer til. */
    finnAnlegg(anleggsnr) {
        return this.anleggPerNr?.get(anleggsnr) ?? null;
    }

    /** @returns {object|null} */
    finnTurbin(id) {
        return this.turbinar.find((t) => t.id === id) ?? null;
    }

    // ------------------------------------------------- brukarjustert posisjon

    /**
     * BRUKARJUSTERTE TURBINPOSISJONAR LEVER I `turbinar`, IKKJE I EIT SIDEREGISTER.
     *
     * Alternativet var ein `Map<id, {lat,lon}>` som alle lesarane av
     * `state.turbinar` måtte slå opp i — `finnTurbinarIRadius()`, kartteikninga,
     * analysen, nattmodusen. Fire stader som måtte hugse på det, og éin som
     * gløymer det gir eit panel som reknar på ein annan posisjon enn kartet
     * viser.
     *
     * I staden vert sjølve oppføringa i lista bytt ut. Den opphavlege
     * posisjonen ligg trygt på objektet som `opphavleg_*`, så tilbakestilling
     * treng ingen ekstra tilstand. `turbinar` vert berre fylt av
     * `settDatagrunnlag()` ved oppstart, så justeringa varer så lenge sida er
     * open og forsvinn ved reload — som er nøyaktig levetida ho skal ha.
     *
     * @param {string} id
     * @param {number} lat
     * @param {number} lon
     * @returns {object|null} Den justerte turbinen, eller null om han ikkje kan flyttast
     */
    flyttTurbin(id, lat, lon) {
        const i = this.turbinar.findIndex((t) => t.id === id);
        if (i < 0 || !kanFlyttast(this.turbinar[i])) return null;
        const justert = flyttTurbin(this.turbinar[i], lat, lon);
        this.turbinar[i] = justert;
        this._varsle('turbinflytt', justert);
        return justert;
    }

    /**
     * Sett posisjonen tilbake til det opphavlege estimatet.
     * @returns {object|null} Turbinen med opphavleg posisjon, eller null
     */
    tilbakestillTurbin(id) {
        const i = this.turbinar.findIndex((t) => t.id === id);
        if (i < 0 || !erJustert(this.turbinar[i])) return null;
        const original = tilbakestillTurbin(this.turbinar[i]);
        this.turbinar[i] = original;
        this._varsle('turbinflytt', original);
        return original;
    }

    /** @returns {object[]} Turbinar brukaren har flytta i denne økta. */
    justerteTurbinar() {
        return this.turbinar.filter(erJustert);
    }

    /** @param {{lat:number, lon:number}|null} kandidat */
    settKandidat(kandidat) {
        this.kandidat = kandidat;
        this._varsle('kandidat', kandidat);
    }

    settPunkt(punkt) {
        this.punkt = punkt;
        this.kandidat = null;
        this.resultat = [];
        this.samandrag = null;
        this.samlaStoy = null;
        this.valdTurbinId = null;
        this._varsle('punkt', punkt);
    }

    settRadius(meter) {
        this.radiusM = meter;
        this._varsle('radius', meter);
    }

    vekslStatus(status, paa) {
        if (paa) this.statusFilter.add(status);
        else this.statusFilter.delete(status);
        this._varsle('statusfilter', this.statusFilter);
    }

    settResultat(resultat, samandrag, samlaStoy) {
        this.resultat = resultat;
        this.samandrag = samandrag;
        this.samlaStoy = samlaStoy;
        this._varsle('resultat', this);
    }

    settFramdrift(ferdig, totalt, aktiv = true) {
        this.framdrift = { aktiv, ferdig, totalt };
        this._varsle('framdrift', this.framdrift);
    }

    veljTurbin(id) {
        this.valdTurbinId = id;
        this._varsle('valdTurbin', this.finnResultat(id));
    }

    /** @returns {object|null} */
    finnResultat(id) {
        return this.resultat.find((r) => r.id === id) ?? null;
    }
}

export const state = new AppState();
