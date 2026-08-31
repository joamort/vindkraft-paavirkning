/**
 * js/ui/PanoramaView.js
 *
 * 3D-panorama: står i punktet og snur deg 360° rundt.
 *
 * ===========================================================================
 * INGEN NYE TAL — BERRE EI ANNA FRAMSTILLING AV DEI SAME
 * ===========================================================================
 * Alt som teiknast her er allereie rekna ut andre stader i appen:
 *
 *   retning         `kurs`      frå bearing()          (geo.js)
 *   avstand         `avstandM`  frå haversine()        (geo.js)
 *   turbinmål       nav/rotor/totalhøgd                (TurbineSpec.php)
 *   kva som er synleg  `synlegheit.horisontMoh`        (ImpactCalculator)
 *   hinderlys       `hinderlys.lyspunkt[]`             (ObstacleLights)
 *   sol             solposisjon()                      (ShadowFlicker)
 *   terreng         72 profilar frå same WPS-en        (Horizon.js)
 *
 * Panoramaet legg ikkje til ei einaste ny modellføresetnad. Det einaste det
 * gjer på eiga hand er å velje FARGAR og å velje kva veg rotoren peikar — og
 * begge deler står det atterhald om i visinga.
 *
 * ===========================================================================
 * DEN SCENEN SOM VERT BYGD — «tilsynelatande» koordinatar
 * ===========================================================================
 * Three.js kjenner ingen jordkrumming. I staden for å byggje ei kule og bøye
 * lyset, legg me scenen i eit koordinatsystem der KRUMMINGA ALLEREIE ER
 * REKNA INN:
 *
 *     x = D · sin(azimut)
 *     z = −D · cos(azimut)          (−Z er nord, slik Three.js ser framover)
 *     y = z_moh − horisontfall(D) − z_auge
 *
 * Eit punkt i avstand D og høgd z hamnar då i nøyaktig den høgdevinkelen auget
 * faktisk ser det i (`terrengHelning()` i geo.js er same uttrykk delt på D).
 * Kameraet står i origo og treng ingen korreksjon i det heile.
 *
 * At heile turbinen deler same D gjer dette til ei rein loddrett forskyving
 * per turbin — forma vert ikkje forvrengd, berre flytta ned dit krumminga
 * seier ho skal stå. På 20 km er det 26,9 m.
 *
 * ===========================================================================
 * KLIPPINGA ER ANALYTISK, IKKJE EIN DJUPNETEST
 * ===========================================================================
 * Det er freistande å la GPU-en avgjere kva som er skjult: teikn terrenget,
 * teikn turbinane, lat djupnebufferen ta resten. Det ville gitt eit BILETE som
 * ikkje stemmer med TALA i sidepanelet, fordi terrengmeshen berre er 72
 * strålar og bommar på ryggen mellom to av dei.
 *
 * I staden får kvar turbin eit `THREE.Plane` i akkurat den høgda
 * `synlegheit.horisontMoh` seier. Står det «70 % synleg» i panelet, er det 70 %
 * av turbinen som stikk opp i panoramaet. Terrengmeshen er kulisse; klippinga
 * er fasit.
 */

import { CONFIG } from '../config.js';
import { escHtml, $, fmtAvstand, settBrytar } from '../utils/dom.js';
import { horisontfall } from '../utils/geo.js';
import { solposisjon, norskUtcOffsetTimar } from '../utils/ShadowFlicker.js';
import { uvIRing } from '../utils/SatelliteTexture.js';

const P = CONFIG.panorama;
const DEG = Math.PI / 180;

/**
 * HIMMELPALETT etter solhøgd.
 *
 * Stega er valde etter dei etablerte skumringsdefinisjonane, ikkje på slump:
 * 0° soloppgang/nedgang, −6° borgarleg skumring (grensa der ein kan lese ute),
 * −12° nautisk, −18° astronomisk natt. Det er òg desse stega hinderlysa skiftar
 * karakter over, så same skala tener begge føremål.
 */
const HIMMEL = [
    { h: -18, topp: '#04060f', horisont: '#080d1c', sol: 0.00 },
    { h: -12, topp: '#070c1c', horisont: '#131b34', sol: 0.00 },
    { h: -6,  topp: '#12203f', horisont: '#38375e', sol: 0.12 },
    { h: -3,  topp: '#1c2f57', horisont: '#7c5068', sol: 0.32 },
    { h: 0,   topp: '#2b4478', horisont: '#d2795a', sol: 0.70 },
    { h: 4,   topp: '#3a63a0', horisont: '#efb075', sol: 1.00 },
    { h: 12,  topp: '#3f7bc8', horisont: '#b9d5ef', sol: 1.00 },
    { h: 60,  topp: '#2f6fd0', horisont: '#c9dcf2', sol: 1.00 },
];

/** Solskiva si eiga farge, som òg fargar gloria og direktelyset. */
const SOLFARGE = [
    { h: -6, farge: '#7a4a5a' },
    { h: 0,  farge: '#ff8a4a' },
    { h: 5,  farge: '#ffc27a' },
    { h: 15, farge: '#fff3d6' },
    { h: 60, farge: '#ffffff' },
];

/**
 * TERRENGFARGAR.
 *
 * Kartverket sin profilteneste gir ein `terreng`-streng per punkt
 * (Havflate, Myr, Skog, ÅpentOmråde, …). Der han finst, styrer han fargen;
 * elles fell me tilbake på ein høgderampe. Fargane er reint illustrative og
 * har ingen modellverdi — dei er der for at auget skal kunne lese landskapet.
 */
const TERRENGFARGE = {
    Havflate: '#1d3a52',
    Innsjø: '#26485f',
    Elv: '#26485f',
    ElvBekk: '#26485f',
    Myr: '#4c4a33',
    Skog: '#2f4429',
    DyrketMark: '#556b34',
    Tettbebyggelse: '#5a564f',
    SnøIsbre: '#d8dee6',
    Steinbrudd: '#6b6459',
};

/** Høgderampe når terrengtypen er ukjend. */
const HOGDERAMPE = [
    { moh: 0,    farge: '#3d5233' },
    { moh: 250,  farge: '#4a5537' },
    { moh: 550,  farge: '#5d5942' },
    { moh: 900,  farge: '#6d6659' },
    { moh: 1300, farge: '#8a8880' },
    { moh: 1800, farge: '#cdd2d6' },
];

/**
 * Deterministisk pseudo-tilfeldig tal i [0,1) frå eit koordinatpar.
 *
 * Reint ein hash, ikkje ein `Math.random()` — same lat/lon skal alltid gi
 * same støyverdi, elles ville terrenget "blinke" ulikt kvar gong panoramaet
 * vert bygd på nytt (t.d. ved kvart tidspunktbyte).
 */
function pseudoStoy(lat, lon) {
    const x = Math.sin(lat * 127.1 + lon * 311.7) * 43758.5453123;
    return x - Math.floor(x);
}

function clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Lineær interpolasjon i ein tabell med `h`-nøkkel. */
function slaaOpp(tabell, h, nokkel) {
    if (h <= tabell[0].h) return tabell[0][nokkel];
    const siste = tabell[tabell.length - 1];
    if (h >= siste.h) return siste[nokkel];
    for (let i = 1; i < tabell.length; i++) {
        if (h <= tabell[i].h) {
            const a = tabell[i - 1];
            const b = tabell[i];
            const f = (h - a.h) / (b.h - a.h);
            return { a: a[nokkel], b: b[nokkel], f };
        }
    }
    return siste[nokkel];
}

export class PanoramaView {
    /**
     * @param {object} handlingar
     * @param {() => void} [handlingar.paaLukk]
     */
    constructor(handlingar = {}) {
        this.handlingar = handlingar;
        this.open = false;
        this.THREE = null;

        /** Kameratilstand. */
        this.yaw = 0;
        this.pitch = 2;
        this.fov = P.startFovGrader;

        /** Valt tidspunkt: dag i året + minutt i døgnet, norsk lokaltid. */
        this.dagIAar = 172;
        this.minuttLokal = 13 * 60;
        this.aar = new Date().getFullYear();

        this.rotorGaar = true;
        /**
         * Talet synlege turbinar. Sett først i `_byggTurbinar()`, som køyrer
         * ETTER `_byggHud()` (HUD-en må finnast i DOM-en før scena kan feste
         * seg til #panorama-lerret). Defensivt initialisert til 0 her, slik at
         * HUD-teksten aldri viser bokstaveleg "undefined" i det vesle vindauget
         * mellom dei to — sjå `_oppdaterHudInfo()` for den faktiske oppdateringa.
         */
        this.talSynlege = 0;

        /**
         * SKOGVISING — AV SOM STANDARD, OG DET ER HEILE POENGET.
         *
         * Scena er rekna på bar bakke, akkurat som hovudtalet i sidepanelet.
         * Å stilt klippe turbinane mot DOM-horisonten i staden ville gjort at
         * 3D-biletet og panelet viste ulikt tal utan at noko forklarte kvifor
         * — det ville lese som ein feil, ikkje som ei ekstra opplysning.
         * Brytaren gjer byttet til noko brukaren gjer og ser at han gjer.
         */
        this.visSkog = false;
        /** Turbingruppene, slik at dei kan byggjast om når brytaren vert slått. */
        this.turbinGrupper = [];
        this.talSkjultAvSkog = 0;

        this._peikarar = new Map();
        this._pinchStart = null;
        /** Memoisert import()-promise for Three.js. Sjå `_lastThree()`. */
        this._threePromise = null;
        this._rafId = null;
        this._sistTid = 0;
        this._urTid = 0;

        /**
         * ØKT-TELJAR — vaktposten for dei ETTERSLEPANDE oppdateringane.
         *
         * Scena opnar på horisonten åleine, og nærfelt og flyfoto kjem
         * drassande etterpå (CLAUDE.md §21). Dei to hentingane veit ingenting
         * om at brukaren kan ha lukka panoramaet, flytta punktet og opna det
         * på nytt i mellomtida. Kvar opning aukar difor telljaren, og
         * `oppdaterNaerTerreng()`/`oppdaterSatellitt()` gjer ingenting med
         * mindre dei kjem frå den økta som framleis står på skjermen.
         */
        this._oktId = 0;

        /** Skjørtet ned frå terrengkanten. Må rivast saman med meshen. */
        this.kantMesh = null;

        /** Er ei ombygging alt planlagd til neste frame? */
        this._byggPlanlagt = false;
    }

    // ===================================================================
    // LASTING AV THREE.JS
    // ===================================================================

    /**
     * Hent Three.js — først når nokon faktisk opnar panoramaet.
     *
     * Dynamisk import() av eit ES-modulbygg frå unpkg. Tre grunnar til at det
     * er gjort slik og ikkje med ein <script>-tagg i index.html:
     *
     *  1. **Ingen kostnad for dei som ikkje bruker det.** 166 KB gzipa er meir
     *     enn Leaflet, Chart.js og heile appen til saman. Dei aller fleste
     *     opnar aldri panoramaet.
     *  2. **Ingen importmap.** CSP-en her har ikkje 'unsafe-inline' i
     *     script-src, og ein <script type="importmap"> ER inline. Ein absolutt
     *     URL i sjølve import-setninga treng ingen kartlegging.
     *  3. **ES-modulen er den støtta vegen.** UMD-bygget (three.min.js) er
     *     merkt deprecated frå r150 og skriv ei åtvaring i konsollen.
     */
    async _lastThree() {
        if (this.THREE) return this.THREE;
        /**
         * PROMISET VERT MEMOISERT, IKKJE BERRE RESULTATET.
         *
         * `forhandslast()` og `opne()` kallar denne uavhengig av kvarandre og
         * ofte samtidig. Utan eit lagra promise ville den andre kallaren sjå
         * `this.THREE` framleis tom og starte importen ein gong til. Nettlesaren
         * dedupliserer riktig nok modulhentinga sjølv, men då ville me stå med
         * to `await`-kjeder som begge skreiv `this.THREE`, og feilhandsaminga
         * ville fyre to gonger for éin nettverksfeil.
         */
        if (!this._threePromise) {
            this._threePromise = import(/* @vite-ignore */ P.threeUrl)
                .then((m) => { this.THREE = m; return m; })
                .catch((e) => {
                    // Nullstill, slik at eit nytt forsøk faktisk får prøve.
                    this._threePromise = null;
                    throw new Error(
                        '3D-biblioteket lét seg ikkje laste. Er du på nett? '
                        + `(${e.message})`,
                    );
                });
        }
        return this._threePromise;
    }

    /**
     * Start nedlastinga av Three.js UTAN å opne noko.
     *
     * ===================================================================
     * 166 KB ER IKKJE GRATIS, MEN VENTETIDA ER DYRARE
     * ===================================================================
     * Importen låg tidlegare inne i `opne()`, altså ETTER at horisonten var
     * henta. På eit kaldt punkt drukna han i dei 60 sekunda terrengdata tok,
     * men på eit VARMT punkt var horisonten inne på 0,1 s — og då var
     * biblioteknedlastinga plutseleg heile ventetida brukaren opplevde:
     * 2,8 s med ingenting på skjermen for eit panorama der alle data låg
     * klare i minnet.
     *
     * Kallast difor to stader, begge utan å binde brukaren til noko:
     *  - når peikaren så vidt strøk over «Vis 3D-panorama»-knappen, og
     *  - i det klikket kjem, parallelt med horisonthentinga.
     *
     * Grunnprinsippet frå §16 står: dei som berre ser på kartet lastar ikkje
     * ned eit einaste byte av Three.js.
     *
     * @returns {Promise<void>} Feilar aldri — feilen kjem att i `opne()`.
     */
    forhandslast() {
        return this._lastThree().then(() => {}, () => {});
    }

    // ===================================================================
    // OPNE / LUKKE
    // ===================================================================

    /**
     * Opne panoramaet med det som er klart NO.
     *
     * ===================================================================
     * BERRE HORISONTEN ER OBLIGATORISK
     * ===================================================================
     * `satellitt` og `naerTerreng` er begge valfrie, og `null` er ein heilt
     * normal verdi — ikkje eit feiltilfelle. Fell dei bort for godt, teiknar
     * `_byggTerreng()` grovmeshen med prosedyrefarge, som er det panoramaet
     * har falle tilbake på sidan §17. Kjem dei etterpå, sender kallaren dei
     * inn med `oppdaterNaerTerreng()` / `oppdaterSatellitt()` og scena byggjer
     * seg opp vidare medan brukaren ser på (CLAUDE.md §21).
     *
     * @param {object} args
     * @param {object} args.punkt     state.punkt
     * @param {object[]} args.resultat state.resultat
     * @param {object} args.horisont  Frå Horizon.hentHorisont()
     * @param {object|null} [args.satellitt] Frå SatelliteTexture.hentSatellittdekke()
     * @param {object|null} [args.naerTerreng] Frå NaerTerreng.hentNaerTerreng()
     * @param {boolean} [args.ventar] Kjem det meir? Styrer statuslinja i HUD-en.
     * @returns {Promise<number|undefined>} Økt-id å sende med seinare oppdateringar.
     */
    async opne({ punkt, resultat, horisont, satellitt = null, naerTerreng = null, ventar = false }) {
        const vert = $('panorama');
        if (!vert) return undefined;

        this.punkt = punkt;
        this.resultat = resultat ?? [];
        this.horisont = horisont;
        this.satellitt = satellitt;
        /**
         * Fortetta retningsrutenett frå `NaerTerreng.js`, eller null.
         *
         * Berre GEOMETRI for biletet: horisont, siktlinjer og klippeplan
         * kjem framleis frå dei lange strålane. Er han null, teiknar
         * `_byggTerreng()` nøyaktig det same meshen som før.
         */
        this.naerTerreng = naerTerreng;
        this.augeMoh = horisont.augeMoh;

        /**
         * Skogbrytaren startar AV ved kvar opning, ikkje der brukaren lét
         * han. Eit nytt punkt har ikkje nødvendigvis køyrd kryssjekken, og ein
         * brytar som stod «på» over eit bilete som likevel var rekna på bar
         * bakke ville vore verre enn ingen brytar.
         */
        this.visSkog = false;
        this._skogHentar = false;

        // Start med å sjå mot den mest dominerande synlege turbinen — det er
        // det brukaren kom hit for å sjå, og eit panorama som opnar mot ein
        // tom himmelretning ser ut som om det ikkje virkar.
        const synlege = this.resultat.filter((r) => r.analysert && r.synlegheit.synlegDel > 0);
        const mest = synlege.length
            ? synlege.reduce((a, b) => (a.dominans.synsvinkelGrader >= b.dominans.synsvinkelGrader ? a : b))
            : null;
        this.yaw = mest ? mest.kurs : 0;
        this.pitch = 2;
        this.fov = P.startFovGrader;

        // Klokka: opne på noverande dato/tid, men flytt til eit tidspunkt der
        // det faktisk er noko å sjå om det er stummande mørkt no.
        const no = new Date();
        this.aar = no.getFullYear();
        this.dagIAar = Math.floor((no - new Date(this.aar, 0, 0)) / 86400000);
        this.minuttLokal = no.getHours() * 60 + no.getMinutes();

        await this._lastThree();

        vert.classList.add('open');
        vert.setAttribute('aria-hidden', 'false');
        this.open = true;
        this._oktId++;

        this._byggHud(vert);
        this._byggScene();
        this._oppdaterHudInfo();
        this._bindKontrollar();
        this._oppdaterSol();
        this._start();
        if (ventar) this.settStatus('Byggjer vidare på terrenget …');
        return this._oktId;
    }

    // ===================================================================
    // ETTERSLEPANDE DATA — SCENA VEKS MEDAN BRUKAREN SER PÅ
    // ===================================================================

    /**
     * Er denne oppdateringa framleis relevant?
     *
     * Ei henting som vart starta for panorama nr. 3 skal ikkje kunne byte om
     * terrenget i panorama nr. 4 — brukaren kan ha lukka, flytta punktet og
     * opna på nytt medan flisane var undervegs, og då gjeld dei eit anna
     * stad. Ingen `AbortController` trengst for dette: hentingane er billege
     * å la fullføre (dei fyller cachen), det er BRUKEN av dei som må stoppast.
     */
    _gjeldEnno(okt) {
        return this.open && okt === this._oktId;
    }

    /**
     * Ein skarpare horisont landa — anten eit nytt delresultat eller det
     * ferdige settet.
     *
     * VIKTIG OM KVA DETTE IKKJE RØRER: turbinane sine klippeplan kjem frå
     * `r.synlegheit.horisontMoh` i analyseresultatet, ikkje herifrå (§16).
     * Ein grovare eller finare panoramahorisont endrar difor ALDRI kva som er
     * rekna som synleg — berre kor nøyaktig bakken er teikna. Panelet og
     * biletet kan ikkje kome i utakt gjennom denne vegen.
     *
     * @param {object|null} horisont
     * @param {number} okt Økt-id frå `opne()`
     */
    oppdaterHorisont(horisont, okt) {
        if (!this._gjeldEnno(okt) || !horisont) return;
        /**
         * BILETET SKAL BERRE GÅ EIN VEG: MOT SKARPARE.
         *
         * Rekkjefølgja er ikkje garantert. Delresultat som venta på at
         * `opne()` skulle bli ferdig, kan alle sleppe laus i same augeblink,
         * og då i den rekkjefølgja promisa vart oppretta — ikkje i den dei
         * vart fylte. To vakter, ikkje ei: eit delresultat kan aldri erstatte
         * det ferdige settet, og eit delresultat med færre ekte retningar kan
         * aldri erstatte eit med fleire.
         */
        if (this.horisont && !this.horisont.delvis && horisont.delvis) return;
        if (this.horisont?.delvis && horisont.delvis
            && (horisont.ekte ?? 0) <= (this.horisont.ekte ?? 0)) return;
        this.horisont = horisont;
        this.augeMoh = horisont.augeMoh;
        this._planleggTerrengbygg();
        this._oppdaterHudTekstar();
    }

    /**
     * Fortetta nærfelt landa. Byt inn den finare geometrien.
     *
     * @param {object|null} naerTerreng
     * @param {number} okt Økt-id frå `opne()`
     */
    oppdaterNaerTerreng(naerTerreng, okt) {
        if (!this._gjeldEnno(okt) || !naerTerreng) return;
        this.naerTerreng = naerTerreng;
        this._planleggTerrengbygg();
        this._oppdaterHudTekstar();
    }

    /**
     * Flyfoto landa — anten éin ferdig ring, eller det endelege dekket.
     *
     * `null` er ikkje ein no-op her, men ei TILBAKEROLLING: den globale
     * «meir enn halvparten av flisane feila»-testen i `hentSatellittdekke()`
     * kan forkaste eit dekke etter at enkeltringar alt er drapert på meshen.
     * Då skal prosedyrefargen tilbake.
     *
     * @param {object|null} satellitt
     * @param {number} okt Økt-id frå `opne()`
     */
    oppdaterSatellitt(satellitt, okt) {
        if (!this._gjeldEnno(okt)) return;
        if (!satellitt && !this.satellitt) return;
        this.satellitt = satellitt;
        this._planleggTerrengbygg();
        this._oppdaterHudTekstar();
    }

    /**
     * OMBYGGINGA SKJER MELLOM TO FRAMES, ALDRI MIDT I EIN.
     *
     * Å rive og byggje meshen frå ein `.then()` ville i prinsippet vore trygt
     * — JS er eintråds, så teikneløkka kan ikkje stå halvvegs inne i
     * `renderer.render()` når promiset løyser seg. Men tre flisringar og eit
     * nærfelt kan lande tett, og fire fulle ombyggingar på rad er fire hakk i
     * animasjonen for eit resultat som uansett berre visast éin gong.
     * `requestAnimationFrame` slår difor saman alt som kjem inn i same frame
     * til éi bygging, og legg henne like før neste teikning.
     */
    _planleggTerrengbygg() {
        if (this._byggPlanlagt || !this.scene) return;
        this._byggPlanlagt = true;
        requestAnimationFrame(() => {
            this._byggPlanlagt = false;
            if (!this.open || !this.scene) return;
            this._byggTerrengPaaNytt();
        });
    }

    /**
     * Riv terrenget og bygg det på nytt av det beste som er tilgjengeleg no.
     *
     * INGEN CROSS-FADE, OG DET ER EIT VAL. To meshar med same geometri i same
     * høgd ville z-fighte gjennom heile overgangen, og ein gjennomsiktig
     * terrengmesh viser himmelen gjennom bakken. Byttet skjer difor rått —
     * men det er usynleg i praksis, fordi heile riv-og-bygg-sekvensen ligg
     * inne i éi og same oppgåve i hendingsløkka: teikneløkka ser aldri ein
     * scene der det gamle er borte og det nye ikkje er der enno.
     *
     * Kamera, sol, klokke, rotorar, turbinar og hinderlys vert ikkje rørte —
     * berre terrengmeshane og skjørtet. Sola vert køyrd på nytt til slutt
     * fordi dei NYE materiala treng `emissiveIntensity` for gjeldande
     * tidspunkt (sjå `_oppdaterSol()`); utan det ville eit flyfoto som landar
     * midt på dagen kome inn kolsvart.
     */
    _byggTerrengPaaNytt() {
        this._ryddTerreng();
        this.terreng = null;
        this.terrengMat = null;
        this.terrengMeshar = [];
        this.terrengFotoMat = [];
        this._byggTerreng();
        this._oppdaterSol();
    }

    /** Fjern og frigjer terrengmeshane og skjørtet — og berre dei. */
    _ryddTerreng() {
        const frigje = (mesh) => {
            if (!mesh) return;
            this.scene.remove(mesh);
            mesh.geometry?.dispose?.();
            const m = mesh.material;
            const eitt = (x) => {
                // `map` og `emissiveMap` peikar på SAME CanvasTexture i
                // `_byggTerrengSegment()`. Å dispose begge er harmlaust
                // (Three.js toler dobbel frigjering), men lerretet bak lever
                // vidare i SatelliteTexture-cachen og skal ikkje røyrast.
                x.map?.dispose?.();
                x.dispose?.();
            };
            if (Array.isArray(m)) m.forEach(eitt);
            else if (m) eitt(m);
        };

        for (const mesh of this.terrengMeshar ?? []) frigje(mesh);
        frigje(this.kantMesh);
        this.kantMesh = null;
    }

    lukk() {
        if (!this.open) return;
        this.open = false;

        if (this._rafId) cancelAnimationFrame(this._rafId);
        this._rafId = null;

        window.removeEventListener('resize', this._paaResize);
        document.removeEventListener('keydown', this._paaTast);

        const vert = $('panorama');
        vert?.classList.remove('open');
        vert?.setAttribute('aria-hidden', 'true');

        this._riv();
        this.handlingar.paaLukk?.();
    }

    /**
     * Frigjer GPU-ressursar.
     *
     * Ein WebGL-kontekst per opning ville gitt «too many active contexts»
     * etter 8–16 opningar i same fane, og geometri/teksturar vert ikkje
     * samla av søppelsamlaren av seg sjølv.
     */
    _riv() {
        if (!this.scene) return;
        this.scene.traverse((o) => {
            o.geometry?.dispose?.();
            const m = o.material;
            if (Array.isArray(m)) m.forEach((x) => { x.map?.dispose?.(); x.dispose?.(); });
            else if (m) { m.map?.dispose?.(); m.dispose?.(); }
        });
        this.renderer?.dispose();
        this.renderer?.forceContextLoss?.();
        this.renderer = null;
        this.scene = null;
        this.terreng = null;
        this.terrengMat = null;
        this.terrengMeshar = [];
        this.terrengFotoMat = [];
        this.kantMesh = null;
        this.lyssprites = [];
        this.rotorar = [];
        this.turbinGrupper = [];
        const lerret = $('panorama-lerret');
        if (lerret) lerret.innerHTML = '';
    }

    // ===================================================================
    // SCENE
    // ===================================================================

    _byggScene() {
        const T = this.THREE;
        const vert = $('panorama-lerret');
        const b = vert.clientWidth || 800;
        const h = vert.clientHeight || 600;

        this.renderer = new T.WebGLRenderer({ antialias: true, alpha: false });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.setSize(b, h);
        // Kvar turbin klippast mot si eiga horisonthøgd — sjå _byggTurbin().
        this.renderer.localClippingEnabled = true;
        vert.appendChild(this.renderer.domElement);

        this.scene = new T.Scene();

        this.kamera = new T.PerspectiveCamera(this.fov, b / h, 1, P.himmelRadiusM * 1.6);
        this.kamera.rotation.order = 'YXZ';

        // Dis. Terreng og turbinar tonar ut mot himmelen ved horisonten, slik
        // dei gjer i røynda. Fargen settast på nytt for kvart tidspunkt.
        this.scene.fog = new T.Fog(0xb9d5ef, 2500, P.maksAvstandM * 1.55);

        this.solLys = new T.DirectionalLight(0xffffff, 1.0);
        this.scene.add(this.solLys);
        this.himmelLys = new T.HemisphereLight(0xbfd4ee, 0x3a3a30, 0.6);
        this.scene.add(this.himmelLys);

        this._byggHimmel();
        this._byggStjerner();
        this.terreng = null;
        this.terrengMat = null;
        this.terrengMeshar = [];
        this.terrengFotoMat = [];
        this._byggTerreng();
        this._byggTurbinar();
    }

    // --------------------------------------------------------------- himmel

    _byggHimmel() {
        const T = this.THREE;

        this.himmelUniformer = {
            uTopp: { value: new T.Color('#3f7bc8') },
            uHorisont: { value: new T.Color('#b9d5ef') },
            uSolFarge: { value: new T.Color('#ffffff') },
            uSol: { value: new T.Vector3(0, 1, 0) },
            uSolStyrke: { value: 1 },
        };

        const mat = new T.ShaderMaterial({
            side: T.BackSide,
            depthWrite: false,
            uniforms: this.himmelUniformer,
            vertexShader: `
                varying vec3 vDir;
                void main() {
                    vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz);
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }`,
            fragmentShader: `
                uniform vec3 uTopp;
                uniform vec3 uHorisont;
                uniform vec3 uSolFarge;
                uniform vec3 uSol;
                uniform float uSolStyrke;
                varying vec3 vDir;

                void main() {
                    vec3 d = normalize(vDir);
                    float hh = clamp(d.y, -1.0, 1.0);

                    // Gradienten er brattast nær horisonten — slik ein ekte
                    // himmel er, fordi luftsøyla er lengst der.
                    vec3 c = mix(uHorisont, uTopp, pow(clamp(hh, 0.0, 1.0), 0.42));
                    c = mix(c, uHorisont * 0.5, clamp(-hh * 2.5, 0.0, 1.0));

                    float ang = acos(clamp(dot(d, uSol), -1.0, 1.0));
                    c += uSolFarge * uSolStyrke * 0.26 * exp(-ang * 5.0);
                    c += uSolFarge * uSolStyrke * 0.50 * exp(-ang * 24.0);

                    // Solskiva: 0,265° radius, same vinkelstorleik som i §4.5.
                    float disk = 1.0 - smoothstep(0.0042, 0.0056, ang);
                    c = mix(c, uSolFarge * 1.7, disk * uSolStyrke);

                    gl_FragColor = vec4(c, 1.0);
                    #include <colorspace_fragment>
                }`,
        });

        this.himmel = new T.Mesh(new T.SphereGeometry(P.himmelRadiusM, 32, 20), mat);
        this.himmel.renderOrder = -1;
        this.scene.add(this.himmel);
    }

    _byggStjerner() {
        const T = this.THREE;
        const n = 900;
        const pos = new Float32Array(n * 3);
        const far = new Float32Array(n * 3);
        const r = P.himmelRadiusM * 0.94;

        for (let i = 0; i < n; i++) {
            // Jamt fordelt på kula, men berre over horisonten.
            const u = Math.random();
            const fi = Math.random() * Math.PI * 2;
            const y = u ** 0.7;
            const rad = Math.sqrt(1 - y * y);
            pos[i * 3] = Math.cos(fi) * rad * r;
            pos[i * 3 + 1] = y * r;
            pos[i * 3 + 2] = Math.sin(fi) * rad * r;

            // Litt fargespreiing, og få sterke mot mange svake.
            const styrke = 0.25 + Math.random() ** 2.2 * 0.75;
            far[i * 3] = styrke;
            far[i * 3 + 1] = styrke * (0.94 + Math.random() * 0.06);
            far[i * 3 + 2] = styrke * (0.9 + Math.random() * 0.1);
        }

        const geo = new T.BufferGeometry();
        geo.setAttribute('position', new T.BufferAttribute(pos, 3));
        geo.setAttribute('color', new T.BufferAttribute(far, 3));

        this.stjerneMat = new T.PointsMaterial({
            size: 2.0,
            sizeAttenuation: false,
            vertexColors: true,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            fog: false,
        });
        this.stjerner = new T.Points(geo, this.stjerneMat);
        this.stjerner.renderOrder = 0;
        this.scene.add(this.stjerner);
    }

    // -------------------------------------------------------------- terreng

    /**
     * TERRENGET SOM EIT RADIELT MESH, ikkje berre ein silhuett.
     *
     * Me henta 72 profilar á ~180 punkt for å finne 72 horisontverdiar. Å
     * kaste resten ville vore sløsing: dei same punkta ER eit ferdig radielt
     * rutenett over landskapet, og eit mesh av dei viser dalar, ryggar og
     * vatn i staden for ein flat, svart papirsilhuett.
     *
     * Samplinga er dessutan nettopp den eit panorama vil ha. Strålane står
     * tett i nærfeltet (5° er 26 m på 300 m avstand) og glisnare langt ute
     * (1,7 km på 20 km) — som er same fordeling som synsfeltet sjølv har.
     *
     * ATTERHALD som står i visinga: mellom to strålar er terrenget rett
     * interpolert. Ein smal rygg som ligg mellom dei kan bli utjamna i
     * BILETET. Det påverkar ikkje kva som er rekna som synleg — det avgjer
     * klippeplanet, som kjem frå den ekte profilen mot kvar turbin.
     */
    _byggTerreng() {
        const T = this.THREE;
        /**
         * FORTETTA RUTENETT NÅR DET FINST.
         *
         * `NaerTerreng.js` leverer dei same 72 retningane pluss to nye
         * mellom kvart par, alle samplast om til NØYAKTIG same radiar. Difor
         * er trianguleringa under uendra — berre `nDir` er større. Feila
         * hentinga, står me att med dei lange strålane og det gamle meshen.
         */
        const kjelde = this.naerTerreng?.retningar ?? this.horisont.retningar;
        const retningar = kjelde.filter((r) => r.profil);
        if (retningar.length < 3) return;

        // Alle strålane har same tal punkt (same avstand ⇒ same sampling).
        const nRad = Math.min(...retningar.map((r) => r.profil.length));
        const nDir = retningar.length;

        /**
         * DEL PROFILEN ETTER KVA BILETRING SOM DEKKJER AVSTANDEN.
         *
         * Flyfotoet kjem i fleire ringar med ulik oppløysing (sjå
         * `SatelliteTexture.js`). Ein tekstur per mesh er den enklaste vegen —
         * eit `MeshLambertMaterial` har eitt `map`. Meshen vert difor delt på
         * dei same radiane, innerste ring først.
         *
         * Grenseringa av vertexar finst i BEGGE nabomeshane, med nøyaktig same
         * posisjonar men ulike UV-ar. Difor er det inga sprekk i skøyten,
         * berre eit brått hopp i detaljnivå — som er akkurat det auget ventar
         * seg når noko kjem nærare.
         */
        this.terrengMeshar = [];
        /**
         * RINGANE KAN VERE UFULLSTENDIGE, OG DET ER EIN NORMALTILSTAND.
         *
         * Flisringane vert draperte etter kvart som dei vert ferdige (§21),
         * så her kan det stå berre nærringen, berre fjernringen, eller alle
         * tre. Den ytterste tilgjengelege ringen får difor IKKJE lenger
         * strekke seg ut til meshens kant automatisk — han dekkjer sin eigen
         * radius, og resten av bakken får prosedyrefarge til hans eigen ring
         * landar. Slo ein i staden nærringens tekstur ut over heile scena,
         * ville UV-ane hamna langt utanfor [0,1] og kanten smørt seg over 20 km.
         */
        const ringar = (this.satellitt?.ringar ?? []).slice()
            .sort((a, b) => a.radiusM - b.radiusM);
        const grenser = [];
        // Ein ring som strekkjer seg like langt som meshen sjølv skal dekkje
        // heilt ut til kanten. Utan denne slakken kunne eit avrundingsavvik i
        // siste profilpunkt late att ein hårtynn prosedyrestripe i horisonten.
        const maksD = retningar[0].profil[nRad - 1].d;
        let jFra = 0;
        for (let k = 0; k < ringar.length; k++) {
            // Siste radiale indeks som ligg innanfor ringens radius.
            const R = ringar[k].radiusM;
            let jTil = nRad - 1;
            if (R < maksD - 1) {
                jTil = 0;
                while (jTil + 1 < nRad && retningar[0].profil[jTil + 1].d <= R) jTil++;
            }
            if (jTil > jFra) grenser.push({ jFra, jTil, ring: ringar[k] });
            jFra = jTil;
            if (jFra >= nRad - 1) break;
        }
        // Resten av bakken — anten fordi ingen ring har landa enno, eller
        // fordi den ytterste ikkje heilt når meshens kant.
        if (jFra < nRad - 1) grenser.push({ jFra, jTil: nRad - 1, ring: null });

        for (const g of grenser) {
            this._byggTerrengSegment(retningar, g.jFra, g.jTil, g.ring);
        }

        /**
         * SKØYT MOT HIMMELEN.
         *
         * Terrengmeshen sluttar brått ved 20 km. Utan noko bak vert det ei
         * hard kant mot himmelen der bakken plutseleg tek slutt. Ein enkel
         * skjørt ned frå ytterkanten fyller det, og disen gjer overgangen
         * usynleg.
         */
        const kantPos = new Float32Array(nDir * 2 * 3);
        for (let i = 0; i < nDir; i++) {
            const rad = retningar[i];
            const p = rad.profil[nRad - 1];
            const a = rad.azimut * DEG;
            const yTopp = p.z - horisontfall(p.d) - this.augeMoh;
            kantPos[i * 6] = p.d * Math.sin(a);
            kantPos[i * 6 + 1] = yTopp;
            kantPos[i * 6 + 2] = -p.d * Math.cos(a);
            kantPos[i * 6 + 3] = p.d * Math.sin(a);
            kantPos[i * 6 + 4] = yTopp - 6000;
            kantPos[i * 6 + 5] = -p.d * Math.cos(a);
        }
        const kantIdx = [];
        for (let i = 0; i < nDir; i++) {
            const i2 = (i + 1) % nDir;
            kantIdx.push(i * 2, i * 2 + 1, i2 * 2 + 1, i * 2, i2 * 2 + 1, i2 * 2);
        }
        const kantGeo = new T.BufferGeometry();
        kantGeo.setAttribute('position', new T.BufferAttribute(kantPos, 3));
        kantGeo.setIndex(kantIdx);
        kantGeo.computeVertexNormals();
        this.kantMat = new T.MeshBasicMaterial({ color: 0x3d4a3a, side: T.DoubleSide });
        // Handtaket må takast vare på: ei ombygging (§21) rir berre terrenget,
        // og eit gløymt skjørt ville hopa seg opp for kvar ny datakjelde.
        this.kantMesh = new T.Mesh(kantGeo, this.kantMat);
        this.scene.add(this.kantMesh);
    }

    /**
     * Eitt radielt ringsegment av terrenget, `jFra` … `jTil` inklusive.
     *
     * @param {object[]} retningar
     * @param {number} jFra
     * @param {number} jTil
     * @param {object|null} ring  Biletring frå SatelliteTexture, eller null
     */
    _byggTerrengSegment(retningar, jFra, jTil, ring) {
        const T = this.THREE;
        const nDir = retningar.length;
        const nJ = jTil - jFra + 1;

        const pos = new Float32Array(nDir * nJ * 3);
        const far = new Float32Array(nDir * nJ * 3);
        const uv = ring ? new Float32Array(nDir * nJ * 2) : null;
        const farge = new T.Color();

        const vekt = ring ? CONFIG.panorama.satellitt.prosedyrevekt : 0;
        const amp = ring
            ? CONFIG.panorama.satellitt.stoyAmplitude
            : 0.16;

        for (let i = 0; i < nDir; i++) {
            const rad = retningar[i];
            const a = rad.azimut * DEG;
            const sin = Math.sin(a);
            const cos = Math.cos(a);

            for (let jj = 0; jj < nJ; jj++) {
                const p = rad.profil[jFra + jj];
                const n = i * nJ + jj;
                const k = n * 3;
                pos[k] = p.d * sin;
                pos[k + 1] = p.z - horisontfall(p.d) - this.augeMoh;
                pos[k + 2] = -p.d * cos;

                farge.set(this._terrengfarge(p));

                /**
                 * BRYT OPP DEI FLATE FARGEFELTA — og, med flyfoto, TON NED
                 * SEG SJØLV.
                 *
                 * Utan bilettekstur er dette den einaste fargeinformasjonen
                 * som finst: kvar terrengtype (Skog, DyrketMark, …) gir éin
                 * fast farge, heilt reelt over store areal, men i eit
                 * 3D-panorama les auget det som eit måla, "cartoon"-aktig flak.
                 * Ei DETERMINISTISK per-vertex lysstyrkestøy (same punkt gir
                 * alltid same støy — ikkje eit anna bilete kvar gong scena vert
                 * bygd) gjer flatene teksturerte i staden for måla.
                 *
                 * MED bilettekstur er rollene bytte om. Fotoet skal vera
                 * hovudinntrykket, og vertex-fargen vert ein modulasjon som
                 * multipliserast inn. Då kan han IKKJE brukast rått: ein
                 * skogfarge som `#2f4429` har lysstyrke 0,22, og å gange
                 * fotoet med den ville gjort heile biletet nesten svart.
                 *
                 * Fargen vert difor først normalisert til lysstyrke 1, slik at
                 * han berre ber FARGETONE og ingen mørkning, og deretter blanda
                 * mot kvit med `prosedyrevekt`. Middelverdien av modulasjonen
                 * er då 1 — fotoet slepp gjennom uendra i lysstyrke, men får
                 * ein svak tone frå terrengtypen, som held på det same
                 * djupne-hintet i dis og skodde som den prosedyregenererte
                 * fargelegginga gav.
                 */
                const stoy = 1 + (pseudoStoy(p.lat, p.lon) - 0.5) * amp;
                if (ring) {
                    const lum = Math.max(0.05,
                        0.299 * farge.r + 0.587 * farge.g + 0.114 * farge.b);
                    far[k] = clamp01(((1 - vekt) + vekt * (farge.r / lum)) * stoy);
                    far[k + 1] = clamp01(((1 - vekt) + vekt * (farge.g / lum)) * stoy);
                    far[k + 2] = clamp01(((1 - vekt) + vekt * (farge.b / lum)) * stoy);

                    const [u, v] = uvIRing(ring, p.lat, p.lon);
                    uv[n * 2] = u;
                    uv[n * 2 + 1] = v;
                } else {
                    far[k] = clamp01(farge.r * stoy);
                    far[k + 1] = clamp01(farge.g * stoy);
                    far[k + 2] = clamp01(farge.b * stoy);
                }
            }
        }

        // Indeksar: lukk ringen frå siste retning tilbake til den første.
        const idx = [];
        for (let i = 0; i < nDir; i++) {
            const i2 = (i + 1) % nDir;
            for (let jj = 0; jj < nJ - 1; jj++) {
                const a = i * nJ + jj;
                const b = i * nJ + jj + 1;
                const c = i2 * nJ + jj;
                const d = i2 * nJ + jj + 1;
                idx.push(a, b, d, a, d, c);
            }
        }

        const geo = new T.BufferGeometry();
        geo.setAttribute('position', new T.BufferAttribute(pos, 3));
        geo.setAttribute('color', new T.BufferAttribute(far, 3));
        if (uv) geo.setAttribute('uv', new T.BufferAttribute(uv, 2));
        geo.setIndex(idx);
        geo.computeVertexNormals();

        const mat = new T.MeshLambertMaterial({
            vertexColors: true,
            side: T.DoubleSide,
        });

        if (ring) {
            const tex = new T.CanvasTexture(ring.lerret);
            tex.colorSpace = T.SRGBColorSpace;
            tex.wrapS = T.ClampToEdgeWrapping;
            tex.wrapT = T.ClampToEdgeWrapping;
            /**
             * ANISOTROPI ER IKKJE PYNT HER.
             *
             * Terrenget vert nesten alltid sett i strøkvinkel — det er heile
             * poenget med eit panorama. Utan anisotropisk filtrering vel
             * mipmap-utveljinga etter den GROVASTE av dei to retningane, og
             * bakken smører seg ut til graut nokre hundre meter framfor auget.
             */
            tex.anisotropy = this.renderer?.capabilities?.getMaxAnisotropy?.() ?? 1;
            tex.needsUpdate = true;
            mat.map = tex;

            /**
             * FOTOET HAR ALLEREIE SITT EIGE SOLLYS I SEG.
             *
             * Eit ortofoto er teke ein gitt dag, med sola der ho stod då. Å
             * køyre det gjennom ein Lambert-modell med VÅR sol oppå gir
             * dobbel skuggelegging: ein li som alt ligg i skugge i biletet
             * vert i tillegg mørklagd av at normalen peikar bort frå
             * scenesola, og kollapsar til nesten svart.
             *
             * Ein fast brøkdel av biletet vert difor sendt gjennom som
             * `emissiveMap` — lys som IKKJE avheng av normalen. Fysisk er det
             * ei rimeleg lesing: det er den himmel-/diffuslyssettinga som alt
             * er baka inn i fotoet, og som ikkje skal reknast på nytt.
             *
             * Styrken følgjer dagslyset (`emissiveIntensity` settast i
             * `_oppdaterSol()`), slik at han er 0 om natta. Elles ville
             * terrenget lyst av seg sjølv i mørket og øydelagt heile
             * hinderlys-poenget.
             */
            mat.emissiveMap = tex;
            mat.emissive = new T.Color(0xffffff);
            mat.emissiveIntensity = 0;
            this.terrengFotoMat.push(mat);
        }

        const mesh = new T.Mesh(geo, mat);
        this.scene.add(mesh);
        this.terrengMeshar.push(mesh);
        // Bakoverkompatibelt handtak: fyrste segmentet er «terrenget».
        if (!this.terreng) {
            this.terreng = mesh;
            this.terrengMat = mat;
        }
    }

    /** Farge for eitt terrengpunkt: type om han finst, elles høgd. */
    _terrengfarge(p) {
        const t = TERRENGFARGE[p.terreng];
        if (t) return t;

        const z = p.z;
        if (z <= HOGDERAMPE[0].moh) return HOGDERAMPE[0].farge;
        for (let i = 1; i < HOGDERAMPE.length; i++) {
            if (z <= HOGDERAMPE[i].moh) return HOGDERAMPE[i].farge;
        }
        return HOGDERAMPE[HOGDERAMPE.length - 1].farge;
    }

    // ------------------------------------------------------------- turbinar

    /**
     * SYNLEGHEITA SLIK BRYTAREN STÅR NO.
     *
     * Éin funksjon, brukt av klippeplanet, av utveljinga i `_byggTurbinar()`
     * og av hinderlysa. At dei tre spør SAME stad er det som gjer at biletet
     * ikkje kan kome i utakt med seg sjølv — ein turbin som er klipt bort
     * skal heller ikkje telje med i «N av M synlege».
     *
     * `overflate.synlegheit` finst berre når kryssjekken fann eit hinder over
     * terskelen; elles er DOM-svaret identisk med bar bakke, og då er det
     * same objekt som skal brukast uansett kva brytaren står på.
     */
    _synlegheitFor(r) {
        return this.visSkog && r.overflate?.vesentleg && r.overflate.synlegheit
            ? r.overflate.synlegheit
            : r.synlegheit;
    }

    /** Har DOM-kryssjekken i det heile køyrt for dette settet? */
    _harSkogdata() {
        return (this.resultat ?? []).some((r) => r.overflate);
    }

    _byggTurbinar() {
        this.rotorar = [];
        this.lyssprites = [];
        this.turbinGrupper = [];
        this.lysTekstur = this._lagLystekstur();

        /**
         * BERRE TURBINAR SOM FAKTISK ER SYNLEGE VERT BYGDE.
         *
         * Ein turbin med `synlegDel === 0` ville uansett vorte klipt heilt
         * bort av sitt eige horisontplan. Å hoppe over dei sparer typisk
         * halvparten til to tredelar av geometrien — og gjer det umogleg for
         * ein feil i klippinga å vise noko som panelet kallar skjult.
         *
         * Hinderlys er eit unntak: eit navlys kan stå fritt sjølv når resten
         * av turbinen er borte. Dei vert difor bygde for alle turbinar med
         * minst eitt synleg lyspunkt.
         */
        const kandidatar = this.resultat
            .filter((r) => r.analysert)
            .slice(0, CONFIG.analyse.maksTurbinar);

        this.talSynlege = 0;
        this.talSkjultAvSkog = 0;
        for (const r of kandidatar) {
            const syn = this._synlegheitFor(r);
            const harKropp = syn.synlegDel > 0;

            // Kor mange som fell bort NÅR brytaren står på — talet HUD-en
            // skriv. Rekna av dei to synlegheitene mot kvarandre, ikkje av
            // `overflate.endring`, slik at det alltid svarer til det biletet
            // faktisk viser.
            if (this.visSkog && r.synlegheit.synlegDel > 0 && !harKropp) this.talSkjultAvSkog++;

            const harLys = (r.hinderlys?.lyspunkt ?? []).some(
                (l) => l.synleg === true && this._lysSynleg(r, l),
            );
            if (!harKropp && !harLys) continue;
            if (harKropp) this.talSynlege++;
            this._byggTurbin(r, harKropp);
        }

        /**
         * HINDERA VERT BYGDE I EIN EIGEN RUNDE, OVER HEILE LISTA.
         *
         * Ikkje inne i `_byggTurbin()`: den køyrer berre for turbinar som
         * framleis har noko å teikne, og det er nettopp dei som forsvann heilt
         * hinderet deira må forklare. Ein klump utan turbin bak seg er det
         * mest talande biletet brytaren kan gi.
         */
        if (this.visSkog) this._byggSkoghinder(kandidatar);
    }

    /**
     * Riv turbinane og bygg dei opp att — det brytaren faktisk gjer.
     *
     * Berre turbingruppene vert rørte. Terreng, himmel, kamera og klokke står
     * urørte, slik at brukaren ser NØYAKTIG same utsnitt før og etter og kan
     * samanlikne dei to bileta direkte. Det er heile grunnen til at dette er
     * ein brytar og ikkje ei ny vising.
     */
    _byggTurbinarPaaNytt() {
        if (!this.scene) return;
        for (const g of this.turbinGrupper) {
            this.scene.remove(g);
            g.traverse((o) => {
                o.geometry?.dispose?.();
                const m = o.material;
                if (Array.isArray(m)) m.forEach((x) => x.dispose?.());
                else m?.dispose?.();
            });
        }
        this.turbinGrupper = [];
        this.lysTekstur?.dispose?.();
        this._byggTurbinar();
        this._oppdaterSol();
        this._oppdaterHudInfo();
        this._oppdaterHudTekstar();
    }

    /**
     * Éin turbin: tårn, nacelle, rotor og hinderlys.
     *
     * @param {object} r        Resultat frå beregnPaaverknad()
     * @param {boolean} harKropp Skal sjølve turbinen teiknast?
     */
    _byggTurbin(r, harKropp) {
        const T = this.THREE;
        const D = r.avstandM;
        const a = r.kurs * DEG;
        const senk = horisontfall(D) + this.augeMoh;

        const gruppe = new T.Group();
        gruppe.position.set(D * Math.sin(a), 0, -D * Math.cos(a));
        this.scene.add(gruppe);
        this.turbinGrupper.push(gruppe);

        if (harKropp) {
            /**
             * Klippeplanet: behald alt med y ≥ horisonthøgda. Normal (0,1,0)
             * og konstant −y gir signert avstand y − yHorisont.
             *
             * MED SKOGBRYTAREN PÅ er det DOM-horisonten som gjeld — elles
             * ville klumpen stått der og skjerma for auget medan turbinen bak
             * henne var klipt mot ein horisont som ikkje veit om henne.
             * Terrengmeshen er kulisse; klippinga er fasit (§16), og det
             * gjeld like fullt når fasiten er flytta.
             */
            const yHorisont = this._synlegheitFor(r).horisontMoh - senk;
            const plan = new T.Plane(new T.Vector3(0, 1, 0), -yHorisont);

            const matKropp = new T.MeshLambertMaterial({
                color: 0xdcdcd6, clippingPlanes: [plan], clipShadows: false,
            });
            const matBlad = new T.MeshLambertMaterial({
                color: 0xf2f2ee, clippingPlanes: [plan], side: T.DoubleSide,
            });

            const nav = r.navHoydeM;
            const rotorR = r.rotorDiameterM / 2;
            const yBasis = r.basisMoh - senk;
            const yNav = r.navMoh - senk;

            // --- Tårn ---------------------------------------------------
            // Konisk, med grunnrisser i realistisk forhold til navhøgda:
            // eit 87 m tårn får ~5,4 m ved foten og ~2,9 m på toppen.
            const taarn = new T.Mesh(
                new T.CylinderGeometry(nav / 60, nav / 32, nav, 10, 1, true),
                matKropp,
            );
            taarn.position.y = yBasis + nav / 2;
            gruppe.add(taarn);

            // --- Nacelle ------------------------------------------------
            const nacelle = new T.Mesh(
                new T.BoxGeometry(rotorR * 0.11, rotorR * 0.10, rotorR * 0.26),
                matKropp,
            );
            nacelle.position.y = yNav;
            nacelle.rotation.y = -a;
            gruppe.add(nacelle);

            // --- Rotor --------------------------------------------------
            const rotor = new T.Group();
            rotor.position.y = yNav;
            rotor.position.z = 0;
            /**
             * Rotorplanet står vinkelrett på den retninga nacellen peikar.
             * Blada byggjast i XY-planet (normal +Z) og heile gruppa vridast
             * om Y. Med rotoren vend mot observatøren er den vridinga −kurs.
             */
            rotor.rotation.y = P.rotorMotObservator ? -a : Math.PI - a;
            // Tilfeldig startfase: verkelege turbinar er ikkje i takt.
            // (Hinderlysa er det derimot — sjå § 16(3) a.)
            rotor.rotation.z = Math.random() * Math.PI * 2;

            const bladLen = rotorR * 0.96;
            const bladGeo = new T.CylinderGeometry(rotorR * 0.008, rotorR * 0.030, bladLen, 4);
            bladGeo.translate(0, bladLen / 2, 0);
            bladGeo.scale(1, 1, 0.28);

            for (let k = 0; k < 3; k++) {
                const blad = new T.Mesh(bladGeo, matBlad);
                blad.rotation.z = (k * Math.PI * 2) / 3;
                rotor.add(blad);
            }
            const hub = new T.Mesh(new T.SphereGeometry(rotorR * 0.045, 8, 6), matKropp);
            rotor.add(hub);

            gruppe.add(rotor);
            this.rotorar.push(rotor);
        }

        this._byggHinderlys(r, gruppe, senk);
    }

    /**
     * ER DETTE LYSPUNKTET SYNLEG SLIK BRYTAREN STÅR?
     *
     * Same test som `hinderlysSynlegheit()` gjer (§10): eit lys er synleg når
     * det ligg over terrenghorisonten. `l.synleg` er svaret for bar bakke;
     * med skogbrytaren på må testen gjerast om att mot den heva horisonten,
     * elles ville navlyset på ein bortklipt turbin bli hengande i lufta.
     */
    _lysSynleg(r, l) {
        if (!this.visSkog) return true;
        const syn = this._synlegheitFor(r);
        if (syn === r.synlegheit) return true;
        return r.bakkeVedTurbinMoh + l.hoydeOverBakkeM > syn.horisontMoh;
    }

    /**
     * SKOGEN OG BYGNINGANE SOM FAKTISK VART MÅLTE — som klumpar, ikkje som skog.
     *
     * Dette er dei punkta DOM-kryssjekken slo opp og fann eit hinder over
     * terskelen i: ein boks frå bakkehøgda (`dtmZ`) opp til overflatehøgda
     * (`domZ`), i rett retning og rett avstand langs profilen til turbinen.
     *
     * Tre val, alle med same grunngjeving — dette skal LESAST som ei måling,
     * ikkje sjåast som ein skog:
     *
     *  - **Flat, halvgjennomsiktig farge med synlege kantar.** Eit forsøk på
     *    fotorealistiske tre ville gitt biletet ein autoritet dataa ikkje har:
     *    me veit HØGDA i eitt punkt, ikkje kvar det står tre. Ein gjennomsiktig
     *    klump seier «her målte me 18 m over bakken», og lèt brukaren sjå kva
     *    som ligg bak.
     *  - **Ingen skugge, ingen dis-fritak.** Klumpen ligg i same atmosfære som
     *    resten av scena, så avstanden til han er lesbar.
     *  - **Breidda veks med avstanden.** Ein fast metermål ville vore
     *    usynleg på 5 km og fylt heile skjermen på 30 m. Klumpen spenner difor
     *    om lag same vinkel uansett — han er ein MARKØR for ein stad, og
     *    breidda hans er ikkje ei måling.
     */
    _byggSkoghinder(resultat) {
        const T = this.THREE;

        /**
         * Same terrengpunkt går att på tvers av turbinar — det er den same
         * skogkanten som stengjer for heile parken. Utan dedup ville 25
         * turbinar gitt 25 klumpar oppå kvarandre i same koordinat, med
         * gjennomsikta lagt 25 gonger over seg sjølv (altså ugjennomsiktig).
         */
        const sett = new Set();
        const punkt = [];
        for (const r of resultat) {
            if (!r.overflate?.vesentleg) continue;
            const a = r.kurs * DEG;
            for (const c of r.overflate.kandidatar ?? []) {
                if (!c.vesentleg) continue;
                const n = `${c.lat.toFixed(5)},${c.lon.toFixed(5)}`;
                if (sett.has(n)) continue;
                sett.add(n);
                punkt.push({ ...c, a });
            }
        }
        if (punkt.length === 0) return;

        for (const c of punkt) {
            const a = c.a;
            const senkC = horisontfall(c.d) + this.augeMoh;
            const yBotn = c.dtmZ - senkC;
            const yTopp = c.domZ - senkC;
            const h = yTopp - yBotn;
            if (!(h > 0)) continue;

            const b = Math.max(10, Math.min(60, c.d * 0.08));
            const geo = new T.BoxGeometry(b, h, b);
            /**
             * `depthWrite: true` sjølv om materialet er gjennomsiktig.
             *
             * Standardrådet for transparente flater er det motsette, fordi
             * dei då ikkje sorterer seg rett mot kvarandre. Her er den feilen
             * den minste: utan djupneskriving vert klumpane teikna OPPÅ
             * terrenget dei står bak, og ein klump 3 km ute svevar då framfor
             * åsen som skjuler han. Det ville ikkje sett ut som eit unøyaktig
             * bilete, men som ein feil.
             */
            const mat = new T.MeshLambertMaterial({
                color: 0x1f5c3a,
                transparent: true,
                /**
                 * DEI NÆRE KLUMPANE MÅ VERE MEIR GJENNOMSIKTIGE.
                 *
                 * Nærfeltet er der eit hinder betyr mest (H/d), så det er
                 * DER kandidatane hopar seg opp — på Odal ni klumpar 30 m
                 * unna, kvar 15° brei, som til saman vert ein vegg. Med same
                 * dekkevne som ein klump 3 km ute ville brytaren skjult
                 * nettopp det biletet han skal forklare. Dekkevna følgjer
                 * difor avstanden, slik at samla dekkevne vert nokolunde lik.
                 */
                opacity: 0.55 * Math.max(0.42, Math.min(1, c.d / 300)),
                depthWrite: true,
            });
            const boks = new T.Mesh(geo, mat);
            boks.position.set(c.d * Math.sin(a), yBotn + h / 2, -c.d * Math.cos(a));

            const kant = new T.LineSegments(
                new T.EdgesGeometry(geo),
                new T.LineBasicMaterial({ color: 0x8ff0bd, transparent: true, opacity: 0.9 }),
            );
            boks.add(kant);

            const gruppe = new T.Group();
            gruppe.add(boks);
            this.scene.add(gruppe);
            this.turbinGrupper.push(gruppe);
        }
    }

    /**
     * HINDERLYSA — dei faktiske lyspunkta frå ObstacleLights, ikkje pynt.
     *
     * Kvart punkt kjem med ferdig `synleg`, `cssFarge`, `magnitude` og
     * `blinkar` frå `hinderlysSynlegheit()`. Panoramaet gjer to ting med dei:
     * plasserer dei i rett høgd, og let magnituden styre kor sterkt dei lyser.
     *
     * Magnitude → styrke er den vanlege fotometriske skalaen: kvart steg på 1
     * magnitude er ein faktor 2,512 i lys. Eit lys på magnitude −3 (Venus,
     * 5 km) vert difor synleg mykje kraftigare enn eit på +4 (20 km), som det
     * skal.
     */
    _byggHinderlys(r, gruppe, senk) {
        const T = this.THREE;
        for (const l of r.hinderlys?.lyspunkt ?? []) {
            if (l.synleg !== true) continue;

            const mat = new T.SpriteMaterial({
                map: this.lysTekstur,
                color: new T.Color(l.cssFarge),
                transparent: true,
                blending: T.AdditiveBlending,
                depthWrite: false,
                depthTest: true,
                fog: false,
                opacity: 0,
            });
            const sprite = new T.Sprite(mat);
            sprite.position.y = r.bakkeVedTurbinMoh + l.hoydeOverBakkeM - senk;

            // Vinkelstorleik: eit lyspunkt er punktforma, men lys smører seg
            // utover i auget. Sterkare lys ⇒ større flekk.
            const m = Number.isFinite(l.magnitude) ? l.magnitude : 4;
            const styrke = Math.min(3.5, Math.max(0.15, 2.512 ** (-(m - 2.5) / 2.5)));
            const vinkel = 0.0016 + 0.0022 * Math.min(1.6, styrke);
            const sc = r.avstandM * vinkel * 2;
            sprite.scale.set(sc, sc, 1);

            gruppe.add(sprite);
            this.lyssprites.push({
                sprite,
                mat,
                styrke,
                // `blinkar === null` = forskrifta opnar for både fast og
                // blinkande, og me veit ikkje kva som er montert. Då viser me
                // fast lys og seier frå i atterhaldet, i staden for å dikte
                // opp ein blink.
                blinkar: l.blinkar === true,
            });
        }
    }

    /** Rund, mjuk lysflekk som sprite-tekstur. */
    _lagLystekstur() {
        const T = this.THREE;
        const s = 64;
        const c = document.createElement('canvas');
        c.width = s;
        c.height = s;
        const g = c.getContext('2d');
        const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
        grad.addColorStop(0.0, 'rgba(255,255,255,1)');
        grad.addColorStop(0.18, 'rgba(255,255,255,0.85)');
        grad.addColorStop(0.45, 'rgba(255,255,255,0.20)');
        grad.addColorStop(1.0, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, s, s);
        const tex = new T.CanvasTexture(c);
        tex.colorSpace = T.SRGBColorSpace;
        return tex;
    }

    // ===================================================================
    // SOL OG TID
    // ===================================================================

    /** Valt tidspunkt som ekte UTC-Date, via den norske tidssoneregelen. */
    _valtUtc() {
        const grov = Date.UTC(this.aar, 0, 1)
            + (this.dagIAar - 1) * 86400000
            + this.minuttLokal * 60000;
        const off = norskUtcOffsetTimar(grov, this.aar);
        return new Date(grov - off * 3600000);
    }

    /**
     * Rekn ut solposisjonen for valt tidspunkt og oppdater alt som heng på
     * den: himmelfargar, dis, retningslys, stjerner og hinderlys.
     */
    _oppdaterSol() {
        const T = this.THREE;
        const utc = this._valtUtc();
        this.sol = solposisjon(utc, this.punkt.lat, this.punkt.lon);

        const hs = this.sol.hoyde;
        const az = this.sol.asimut * DEG;
        const hoRad = hs * DEG;

        // Solretning i scenekoordinatar.
        const solVec = new T.Vector3(
            Math.cos(hoRad) * Math.sin(az),
            Math.sin(hoRad),
            -Math.cos(hoRad) * Math.cos(az),
        ).normalize();

        // --- Fargar ------------------------------------------------------
        const topp = this._blandFarge(HIMMEL, hs, 'topp');
        const hor = this._blandFarge(HIMMEL, hs, 'horisont');
        const solF = this._blandFarge(SOLFARGE, hs, 'farge');
        const solStyrke = this._blandTal(HIMMEL, hs, 'sol');

        this.himmelUniformer.uTopp.value.copy(topp);
        this.himmelUniformer.uHorisont.value.copy(hor);
        this.himmelUniformer.uSolFarge.value.copy(solF);
        this.himmelUniformer.uSol.value.copy(solVec);
        this.himmelUniformer.uSolStyrke.value = solStyrke;

        // Disen skal vera same farge som himmelen ved horisonten, elles vert
        // overgangen ei synleg kant.
        this.scene.fog.color.copy(hor);

        // --- Lys ---------------------------------------------------------
        // Direktelyset slokner raskt under horisonten; skumringslyset kjem
        // frå himmelen (hemisphere), ikkje frå sola.
        const dag = Math.max(0, Math.min(1, (hs + 2) / 8));
        this.solLys.position.copy(solVec).multiplyScalar(10000);
        this.solLys.intensity = 0.15 + 2.0 * dag;
        this.solLys.color.copy(solF);
        this.himmelLys.intensity = 0.10 + 0.75 * Math.max(0, Math.min(1, (hs + 12) / 20));

        // Sjå `_byggTerrengSegment()`: den delen av flyfotoet som slepp
        // gjennom uavhengig av terrengnormalen. Følgjer dagslyset, og er 0 om
        // natta — elles ville bakken lyst av seg sjølv i mørket.
        for (const m of this.terrengFotoMat ?? []) m.emissiveIntensity = 0.30 * dag;

        // --- Natt --------------------------------------------------------
        // 1 = full natt, 0 = full dag. Same skala som hinderlysa bruker.
        this.natt = Math.max(0, Math.min(1,
            (P.lysAvGrader - hs) / (P.lysAvGrader - P.lysPaaGrader)));
        this.stjerneMat.opacity = Math.max(0, (this.natt - 0.55) / 0.45);

        if (this.kantMat) this.kantMat.color.copy(hor).multiplyScalar(0.55);

        this._oppdaterHudSol();
    }

    _blandFarge(tabell, h, nokkel) {
        const T = this.THREE;
        const v = slaaOpp(tabell, h, nokkel);
        if (typeof v === 'string') return new T.Color(v);
        return new T.Color(v.a).lerp(new T.Color(v.b), v.f);
    }

    _blandTal(tabell, h, nokkel) {
        const v = slaaOpp(tabell, h, nokkel);
        if (typeof v === 'number') return v;
        return v.a + (v.b - v.a) * v.f;
    }

    // ===================================================================
    // TEIKNELØKKE
    // ===================================================================

    _start() {
        this._sistTid = performance.now();
        const steg = (no) => {
            if (!this.open) return;
            const dt = Math.min(0.1, (no - this._sistTid) / 1000);
            this._sistTid = no;
            this._urTid += dt;

            // Rotorane går rundt. Kvar har si eiga startfase.
            if (this.rotorGaar) {
                const omPerSek = (P.rotorRpm / 60) * Math.PI * 2;
                for (const r of this.rotorar) r.rotation.z += omPerSek * dt;
            }

            /**
             * BLINKINGA ER SYNKRON PÅ TVERS AV ALLE TURBINAR.
             *
             * § 16(3) a.: «Dersom det benyttes blinkende hinderlys skal disse
             * blinke samtidig.» Éin felles fase for heile scenen er difor ikkje
             * ei forenkling — det er kravet. Asynkron blinking ville vore feil.
             */
            const periode = 60 / P.blinkPerMinutt;
            const fase = (this._urTid % periode) / periode;
            const paa = fase < 0.30;

            for (const l of this.lyssprites) {
                const bl = l.blinkar ? (paa ? 1 : 0.06) : 1;
                l.mat.opacity = Math.min(1, l.styrke * bl * this.natt);
                l.sprite.visible = l.mat.opacity > 0.01;
            }

            this.kamera.fov = this.fov;
            this.kamera.rotation.y = -this.yaw * DEG;
            this.kamera.rotation.x = this.pitch * DEG;
            this.kamera.updateProjectionMatrix();

            this.renderer.render(this.scene, this.kamera);
            this._teiknKompass();
            this._rafId = requestAnimationFrame(steg);
        };
        this._rafId = requestAnimationFrame(steg);
    }

    // ===================================================================
    // HUD
    // ===================================================================

    /**
     * ATTRIBUSJONEN ER EIT LISENSKRAV, IKKJE PYNT.
     *
     * Esri sine vilkår for World_Imagery krev synleg kjeldeoppgiving der
     * biletet vert brukt. Same tekst som 2D-kartet bruker (`MapManager.js`),
     * slik at det er openbert at det er same kjelde. Han står berre når det
     * FAKTISK er eit foto på skjermen — fell hentinga tilbake til
     * prosedyrefarge, ville ei Esri-kreditering vore direkte misvisande.
     *
     * At teksten er ein eigen funksjon og ikkje ein streng i malen, er fordi
     * fotoet no kan kome ETTER at HUD-en er teikna (§21): då må krediteringa
     * dukke opp i same augeblink som biletet gjer.
     */
    _kjeldeHtml() {
        const sat = this.satellitt;
        if (!sat) return '';
        return `<i class="fa-solid fa-satellite"></i> Flyfoto: ${escHtml(sat.attribusjon)}`;
    }

    /**
     * ATTERHALDET MÅ SKILDRE DET BRUKAREN FAKTISK SER NO.
     *
     * Med progressiv oppbygging går same panorama gjennom fleire tilstandar:
     * grovmesh med prosedyrefarge, så flyfoto, så fortetta nærfelt. Eit foto
     * ser meir autoritativt ut enn ei fargeflate, så atterhaldet må skjerpast
     * i det biletet landar — ikkje stå på den svakare varianten frå det
     * augeblinken scena vart opna.
     */
    _atterhaldHtml() {
        const s = this.horisont;
        const sat = this.satellitt;
        const nt = this.naerTerreng;

        /**
         * MED SKOGBRYTAREN PÅ MÅ DENNE SETNINGA SNU.
         *
         * Utan brytaren er poenget at vegetasjonen i fotoet ligg flatt og
         * skjermar ingenting. Med brytaren på skjermar noko av han — nemleg
         * dei få punkta som faktisk er målte — og då ville den gamle
         * formuleringa motseie setninga rett etterpå. Skiljet som må stå er
         * eit anna: mellom skogen ein SER i fotoet (kulisse) og dei grøne
         * klumpane (måling).
         */
        const bilete = sat
            ? `Bakken er <strong>ekte flyfoto</strong> (${escHtml(sat.attribusjon)})
               drapert over ein forenkla terrengmodell: skogen du ser i fotoet ligg
               flatt på bakken${this.visSkog
                   ? ' og skjermar ikkje i seg sjølv — det er berre dei grøne klumpane som gjer det.'
                   : ' og skjermar difor ingenting.'}`
            : `Terrenget er bar bakke frå ein forenkla modell —
               <strong>skog og bygningar manglar</strong>${this.visSkog
                   ? ' bortsett frå dei grøne klumpane'
                   : ''} — og fargane er illustrative.`;

        /**
         * Oppløysinga er TODELT når nærfeltet har landa. Å berre oppgi det
         * eine talet ville vore feil begge vegar: det høge lovar ei
         * oppløysing fjernfeltet ikkje har, og det låge underdriv det
         * brukaren faktisk ser nede framfor seg.
         */
        const oppløysing = nt
            ? `${nt.talRetningar} skanna retningar dei fyrste
               ${(nt.naerAvstandM / 1000).toFixed(1)} km og
               ${s.talRetningar} lenger ute`
            : `${s.delvis ? s.ekte : s.talRetningar} skanna retningar`;

        // Så lenge horisonten er ufullstendig, er store delar av bakken
        // interpolert mellom vidt åtskilde strålar. Det MÅ stå der, ikkje
        // berre i det vesle talet over.
        const uferdig = s.delvis
            ? ` <strong>Terrenget er framleis under henting</strong> — retningane
                som manglar er strekte ut frå naboane, og biletet skjerpar seg
                etter kvart.`
            : '';

        /**
         * DOM-KRYSSJEKKEN, OM HAN ER KØYRD.
         *
         * Scena sjølv er og blir rekna på bar bakke — klippeplana kjem frå
         * `synlegheit.horisontMoh`, akkurat som hovudtalet i sidepanelet
         * (§16). Har brukaren køyrd skogsjekken, kan sidepanelet likevel seie
         * at nokre av dei turbinane som står her er skjulte i røynda, og då
         * MÅ biletet seie frå om det. Alternativet — å stilt klippe dei bort
         * — ville gjort panoramaet usamanliknbart med profilgrafen og med
         * resten av modellen.
         */
        const skjulteAvSkog = (this.resultat ?? [])
            .filter((r) => r.overflate?.endring === 'skjult').length;

        /**
         * MED BRYTAREN PÅ er atterhaldet eit ANNA — og strengare.
         *
         * Då er ikkje lenger problemet at scena manglar vegetasjonen; då er
         * problemet kva dei grøne klumpane faktisk er. Dei er MÅLTE HØGDER i
         * nokre få punkt, ikkje kartlagd skog: alt anna langs profilen står
         * framleis som bar bakke, så dette er ei NEDRE grense for kor mykje
         * som er skjult. Ein klump ser konkret ut, så teksten må vere det òg.
         */
        let skog = '';
        if (this.visSkog) {
            const synlegeBar = this.talSynlege + this.talSkjultAvSkog;
            // Same nærskjermingsatterhald som sidepanelet, talt på dei
            // klumpane som faktisk står i biletet.
            const naere = new Set(
                (this.resultat ?? [])
                    .flatMap((r) => (r.overflate?.vesentleg ? r.overflate.kandidatar ?? [] : []))
                    .filter((c) => c.vesentleg && c.d < 300)
                    .map((c) => `${c.lat.toFixed(5)},${c.lon.toFixed(5)}`),
            ).size;
            skog = ` <strong>Skog og bygningar er no rekna med:</strong>
                ${this.talSkjultAvSkog} av ${synlegeBar} synlege turbinar er skjulte når dei
                målte overflatehøgdene vert tekne med. Dei grøne klumpane er
                <strong>målingar i nokre få punkt</strong> — dei er ikkje kartlagd skog, og
                storleiken deira er ein markør, ikkje eit mål. Resten av profilen er framleis
                bar bakke, så dette er ei <strong>nedre grense</strong>: fleire kan vere
                skjulte, ingen færre. Laserdataen kan vere fleire år gammal — er skogen hoggen
                sidan, står han framleis her.${naere > 0
                    ? ` <strong>${naere} av klumpane står under 300 m frå deg</strong>: eit tre like
                        ved dekkjer alt bak seg, så flyttar du punktet nokre titals meter kan biletet
                        bli eit heilt anna.`
                    : ''}`;
        } else if (skjulteAvSkog > 0) {
            skog = ` <strong>${skjulteAvSkog} av turbinane du ser her er skjulte bak skog eller
                bygningar</strong> etter kryssjekken i sidepanelet — trykk <strong>Skog</strong>
                for å sjå det, den vegetasjonen finst ikkje som geometri i biletet slik det står no.`;
        }

        return `<strong>Illustrasjon, ikkje eit fotografi.</strong>
            ${bilete}${uferdig} Høgdene er interpolerte mellom ${oppløysing}. Turbinmåla er
            <strong>estimerte eller henta frå søknad</strong>, og rotoren er teikna
            vend mot deg (verste tilfelle), sidan vindretninga ikkje er kjend.
            Kva som er synleg, er rekna med same modell som sidepanelet.${skog}`;
    }

    /**
     * Kor mange retningar terrenget er skanna i, nær og fjernt.
     *
     * Medan horisonten framleis kjem inn, står det EKTE talet der — ikkje
     * måltalet. Å skrive «72 retningar» over eit bilete som er bygd av 18
     * ville vore ei påstand appen ikkje kan stå for enno.
     */
    _skannTekst() {
        const s = this.horisont;
        const nt = this.naerTerreng;
        const horisontDel = s.delvis
            ? `horisont skanna i ${s.ekte} av ${s.talRetningar} retningar så langt`
            : `horisont skanna i ${s.talRetningar} retningar`;
        return nt
            ? `${horisontDel} · terreng i ${nt.talRetningar} nær, ${s.talRetningar} fjernt`
            : horisontDel;
    }

    /** Skriv om dei tekstane som avheng av kva data som har landa. */
    _oppdaterHudTekstar() {
        const kjelde = $('panorama-kjelde');
        if (kjelde) kjelde.innerHTML = this._kjeldeHtml();
        const att = $('panorama-atterhald-tekst');
        if (att) att.innerHTML = this._atterhaldHtml();
        const skann = $('panorama-skann');
        if (skann) skann.textContent = this._skannTekst();
    }

    /**
     * STATUSLINJA ERSTATTAR TOASTEN SÅ SNART SCENA ER OPPE.
     *
     * Ein toast ligg bak panoramaoverlegget og er dessutan feil kanal for
     * noko som skjer INNE i visinga brukaren no ser på. Tom streng (eller
     * ingen argument) skjuler linja.
     *
     * @param {string} [tekst]
     * @param {number} [okt] Økt-id frå `opne()`. Er han gitt og forelda, vert
     *        skrivinga kasta — ei melding frå ei tidlegare opning skal ikkje
     *        kunne dukke opp i det panoramaet som står på skjermen no.
     */
    settStatus(tekst = '', okt = undefined) {
        if (okt !== undefined && !this._gjeldEnno(okt)) return;
        const el = $('panorama-status');
        if (!el) return;
        el.textContent = tekst;
        el.classList.toggle('synleg', !!tekst);
    }

    _byggHud(vert) {
        const s = this.horisont;

        vert.innerHTML = `
            <div id="panorama-lerret" class="panorama-lerret"></div>

            <div class="panorama-kompass" aria-hidden="true">
                <div id="panorama-kompass-band" class="panorama-kompass-band"></div>
                <div class="panorama-kompass-naal"></div>
            </div>

            <button type="button" class="panorama-lukk" data-panorama="lukk" aria-label="Lukk 3D-panorama">
                <i class="fa-solid fa-xmark"></i>
            </button>

            <div id="panorama-status" class="panorama-status" role="status" aria-live="polite"></div>

            <div class="panorama-info">
                <div class="panorama-info-rad">
                    <strong id="panorama-retning">–</strong>
                    <span id="panorama-sol" class="panorama-sol">–</span>
                </div>
                <div class="panorama-info-rad panorama-info-svak">
                    <span>
                        <span id="panorama-tal-synlege">Byggjer turbinane …</span>
                        · <span id="panorama-skann">${escHtml(this._skannTekst())}</span>
                        · auge ${Math.round(s.augeMoh)} moh.
                    </span>
                    <span id="panorama-kjelde" class="panorama-kjelde">${this._kjeldeHtml()}</span>
                </div>
            </div>

            <div class="panorama-kontrollar">
                <div class="panorama-skyv">
                    <label for="panorama-tid">Klokke</label>
                    <input type="range" id="panorama-tid" min="0" max="1439" step="5"
                           value="${this.minuttLokal}" aria-label="Klokkeslett">
                    <output id="panorama-tid-ut">–</output>
                </div>
                <div class="panorama-skyv">
                    <label for="panorama-dag">Dato</label>
                    <input type="range" id="panorama-dag" min="1" max="365" step="1"
                           value="${this.dagIAar}" aria-label="Dato">
                    <output id="panorama-dag-ut">–</output>
                </div>
                <div class="panorama-knapperad">
                    <button type="button" class="minknapp" data-panorama="no">No</button>
                    <button type="button" class="minknapp" data-panorama="natt">Natt</button>
                    <button type="button" class="minknapp aktiv" data-panorama="rotor" aria-pressed="true">Rotor</button>
                    <button type="button" class="minknapp${this.visSkog ? ' aktiv' : ''}"
                            id="panorama-skog-knapp" data-panorama="skog"
                            aria-pressed="${this.visSkog ? 'true' : 'false'}"
                            title="Klipp turbinane mot overflatemodellen (skog og bygningar) i staden for bar bakke">
                        <i class="fa-solid fa-tree"></i> Skog
                    </button>
                    <button type="button" class="minknapp" data-panorama="nullstill">Sentrer</button>
                </div>
            </div>

            <p class="panorama-atterhald">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <span id="panorama-atterhald-tekst">${this._atterhaldHtml()}</span>
            </p>`;
    }

    _oppdaterHudSol() {
        const ut = $('panorama-sol');
        if (ut) {
            const h = this.sol.hoyde;
            const ord = h > 0 ? 'over' : 'under';
            ut.innerHTML = `<i class="fa-solid fa-sun"></i> Sol ${Math.abs(h).toFixed(1)}° ${ord} horisonten`
                + ` · asimut ${Math.round(this.sol.asimut)}°`;
        }

        const tid = $('panorama-tid-ut');
        if (tid) {
            const t = String(Math.floor(this.minuttLokal / 60)).padStart(2, '0');
            const m = String(this.minuttLokal % 60).padStart(2, '0');
            tid.textContent = `${t}:${m}`;
        }

        const dag = $('panorama-dag-ut');
        if (dag) {
            const d = new Date(this.aar, 0, this.dagIAar);
            dag.textContent = d.toLocaleDateString('nn-NO', { day: 'numeric', month: 'short' });
        }
    }

    /**
     * Talet synlege turbinar er ikkje kjent før `_byggTurbinar()` har køyrt
     * (som skjer etter at HUD-en alt er teikna, sjå konstruktøren sin
     * kommentar om `talSynlege`) — difor ei eiga oppdatering her, i staden
     * for å prøve å ha talet klart i `_byggHud()` sjølv.
     */
    _oppdaterHudInfo() {
        const ut = $('panorama-tal-synlege');
        if (!ut) return;
        const analyserte = this.resultat.filter((r) => r.analysert).length;
        const bar = `${this.talSynlege} av ${analyserte} analyserte turbinar er synlege herifrå`;
        ut.textContent = this.visSkog
            ? `${bar} · ${this.talSkjultAvSkog} fell bort med skog og bygningar`
            : bar;
    }

    /**
     * SKOGBRYTAREN — og kva som skjer når det ikkje finst skogdata enno.
     *
     * Kryssjekken køyrer aldri av seg sjølv (§22): han kostar ekte
     * Kartverket-oppslag. Er han ikkje køyrd, ville ein brytar som berre var
     * grå vore ein blindveg — sidepanelet ligg bak overlegget, så brukaren kan
     * ikkje gå og trykkje på knappen der utan å lukke panoramaet fyrst.
     * Brytaren startar difor sjekken sjølv, og slår seg på når han er ferdig.
     *
     * @param {HTMLElement} el Knappen, som skal spegle tilstanden
     */
    async _vekslSkog(el) {
        if (this._skogHentar) return;

        if (!this._harSkogdata()) {
            if (!this.handlingar.paaSjekkOverflate) {
                this.settStatus('Skogsjekken er ikkje tilgjengeleg her.');
                return;
            }
            this._skogHentar = true;
            el.classList.add('lastar');
            this.settStatus('Slår opp skog og bygningar hos Kartverket …');
            try {
                await this.handlingar.paaSjekkOverflate();
            } catch (e) {
                this.settStatus(`Kunne ikkje hente overflatedata: ${e.message}`);
                return;
            } finally {
                this._skogHentar = false;
                el.classList.remove('lastar');
            }
            if (!this.open) return;
            if (!this._harSkogdata()) {
                this.settStatus('Ingen av turbinane kunne sjekkast mot overflatemodellen.');
                return;
            }
        }

        this.visSkog = !this.visSkog;
        settBrytar(el, this.visSkog);
        this._byggTurbinarPaaNytt();

        this.settStatus(this.visSkog
            ? `Skog og bygningar er rekna med — ${this.talSkjultAvSkog} turbin`
              + `${this.talSkjultAvSkog === 1 ? '' : 'ar'} fell bort. Nedre grense; sjå atterhaldet.`
            : 'Tilbake til bar bakke — same modell som sidepanelet.');
    }

    /** Kompassbandet øvst, som følgjer yaw. */
    _teiknKompass() {
        const band = $('panorama-kompass-band');
        if (!band) return;

        const yaw = ((this.yaw % 360) + 360) % 360;
        if (this._sistKompass === Math.round(yaw) && this._sistKompassFov === Math.round(this.fov)) return;
        this._sistKompass = Math.round(yaw);
        this._sistKompassFov = Math.round(this.fov);

        const navn = ['N', 'NØ', 'A', 'SA', 'S', 'SV', 'V', 'NV'];
        // Horisontalt synsfelt frå det vertikale, gitt lerretets sideforhold.
        const vert = $('panorama-lerret');
        const aspekt = (vert?.clientWidth || 1) / (vert?.clientHeight || 1);
        const fovH = 2 * Math.atan(Math.tan((this.fov / 2) * DEG) * aspekt) / DEG;

        let html = '';
        for (let i = 0; i < 8; i++) {
            const a = i * 45;
            let rel = a - yaw;
            while (rel > 180) rel -= 360;
            while (rel < -180) rel += 360;
            if (Math.abs(rel) > fovH / 2) continue;
            const pst = 50 + (rel / fovH) * 100;
            html += `<span class="panorama-kompass-merke${a === 0 ? ' er-nord' : ''}"`
                  + ` style="left:${pst.toFixed(2)}%">${navn[i]}</span>`;
        }
        band.innerHTML = html;

        const r = $('panorama-retning');
        if (r) r.textContent = `${Math.round(yaw)}° · ${this._retningsnamn(yaw)}`;
    }

    _retningsnamn(g) {
        const navn = ['nord', 'nordaust', 'aust', 'søraust', 'sør', 'sørvest', 'vest', 'nordvest'];
        return navn[Math.round(g / 45) % 8];
    }

    // ===================================================================
    // KONTROLLAR
    // ===================================================================

    _bindKontrollar() {
        const vert = $('panorama');
        const lerret = $('panorama-lerret');

        // --- Knappar og skyvarar ---------------------------------------
        vert.addEventListener('click', (e) => {
            const el = e.target.closest('[data-panorama]');
            if (!el) return;
            switch (el.dataset.panorama) {
                case 'lukk':
                    this.lukk();
                    break;
                case 'no': {
                    const n = new Date();
                    this.dagIAar = Math.floor((n - new Date(this.aar, 0, 0)) / 86400000);
                    this.minuttLokal = n.getHours() * 60 + n.getMinutes();
                    this._synkSkyvarar();
                    this._oppdaterSol();
                    break;
                }
                case 'natt':
                    // Midt på natta lokal tid — det er der hinderlysa er poenget.
                    this.minuttLokal = 60;
                    this._synkSkyvarar();
                    this._oppdaterSol();
                    break;
                case 'rotor':
                    this.rotorGaar = !this.rotorGaar;
                    settBrytar(el, this.rotorGaar);
                    break;
                case 'skog':
                    this._vekslSkog(el);
                    break;
                case 'nullstill':
                    this.pitch = 2;
                    this.fov = P.startFovGrader;
                    break;
                default:
                    break;
            }
        });

        $('panorama-tid')?.addEventListener('input', (e) => {
            this.minuttLokal = Number(e.target.value);
            this._oppdaterSol();
        });
        $('panorama-dag')?.addEventListener('input', (e) => {
            this.dagIAar = Number(e.target.value);
            this._oppdaterSol();
        });

        /**
         * SJÅ SEG RUNDT — pointer events, ikkje pointer lock.
         *
         * Pointer lock ville gitt finare musestyring, men krev eit løyve,
         * fungerer ikkje på mobil, og fangar peikaren slik at brukaren må
         * trykkje Escape for å kome ut. Eit panorama skal kunne dragast med
         * fingeren utan noko som helst dialog. Pointer events dekkjer mus,
         * touch og penn i éin kodeveg, og to samtidige peikarar gir knip.
         */
        lerret.addEventListener('pointerdown', (e) => {
            lerret.setPointerCapture?.(e.pointerId);
            this._peikarar.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (this._peikarar.size === 2) this._pinchStart = this._pinchAvstand() ;
        });

        lerret.addEventListener('pointermove', (e) => {
            const forrige = this._peikarar.get(e.pointerId);
            if (!forrige) return;
            const dx = e.clientX - forrige.x;
            const dy = e.clientY - forrige.y;
            this._peikarar.set(e.pointerId, { x: e.clientX, y: e.clientY });

            if (this._peikarar.size >= 2) {
                // Knip: forholdet mellom fingeravstandane styrer synsfeltet.
                const no = this._pinchAvstand();
                if (this._pinchStart > 0 && no > 0) {
                    this._settFov(this.fov * (this._pinchStart / no));
                    this._pinchStart = no;
                }
                return;
            }

            // Éin grad per piksel ville vore feil ved zoom: same drag skal
            // flytte biletet like mykje uansett synsfelt. Skaleringa går
            // difor på grader per piksel i det GJELDANDE synsfeltet.
            const k = this.fov / (lerret.clientHeight || 600);
            this.yaw = ((this.yaw - dx * k) % 360 + 360) % 360;
            this.pitch = Math.max(-85, Math.min(85, this.pitch + dy * k));
        });

        const slepp = (e) => {
            this._peikarar.delete(e.pointerId);
            if (this._peikarar.size < 2) this._pinchStart = null;
        };
        lerret.addEventListener('pointerup', slepp);
        lerret.addEventListener('pointercancel', slepp);
        lerret.addEventListener('pointerleave', slepp);

        lerret.addEventListener('wheel', (e) => {
            e.preventDefault();
            this._settFov(this.fov * Math.exp(e.deltaY * 0.0012));
        }, { passive: false });

        this._paaTast = (e) => {
            if (!this.open) return;
            const steg = this.fov / 12;
            switch (e.key) {
                case 'Escape': this.lukk(); break;
                case 'ArrowLeft': this.yaw = ((this.yaw - steg) % 360 + 360) % 360; break;
                case 'ArrowRight': this.yaw = ((this.yaw + steg) % 360 + 360) % 360; break;
                case 'ArrowUp': this.pitch = Math.min(85, this.pitch + steg / 2); break;
                case 'ArrowDown': this.pitch = Math.max(-85, this.pitch - steg / 2); break;
                case '+': case '=': this._settFov(this.fov / 1.2); break;
                case '-': this._settFov(this.fov * 1.2); break;
                default: return;
            }
            e.preventDefault();
        };
        document.addEventListener('keydown', this._paaTast);

        this._paaResize = () => {
            if (!this.open || !this.renderer) return;
            const b = lerret.clientWidth || 800;
            const h = lerret.clientHeight || 600;
            this.renderer.setSize(b, h);
            this.kamera.aspect = b / h;
            this.kamera.updateProjectionMatrix();
            this._sistKompass = null;
        };
        window.addEventListener('resize', this._paaResize);

        this._synkSkyvarar();
    }

    _settFov(v) {
        this.fov = Math.max(P.minFovGrader, Math.min(P.maksFovGrader, v));
    }

    _pinchAvstand() {
        const [a, b] = [...this._peikarar.values()];
        if (!a || !b) return 0;
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    _synkSkyvarar() {
        const t = $('panorama-tid');
        const d = $('panorama-dag');
        if (t) t.value = String(this.minuttLokal);
        if (d) d.value = String(this.dagIAar);
    }
}
