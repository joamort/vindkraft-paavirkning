/**
 * js/ui/MapManager.js
 *
 * Alt som har med Leaflet-kartet å gjere: bakgrunnslag, turbinmarkørar med
 * clustering, områdepolygon, brukarens punkt, radius-sirkel og siktlinjer.
 *
 * Manager-mønsteret frå PolitiKartet/StrømbruddKart: klassa eig sin del av
 * DOM-en og eksponerer metodar utetter — ho les aldri global tilstand sjølv.
 */

import { CONFIG } from '../config.js';
import { escHtml, fmtAvstand } from '../utils/dom.js';
import { hinderlysKrav } from '../utils/ObstacleLights.js';
import { kanFlyttast, erJustert } from '../utils/TurbinJustering.js';

/** Farge på siktlinjer etter synlegheitskategori. */
const LINJEFARGE = {
    synleg: '#16a34a',
    delvis: '#65a30d',
    saa_vidt: '#ca8a04',
    skjult: '#94a3b8',
    ukjent: '#cbd5e1',
};

export class MapManager {
    /**
     * @param {string} kartId  Id på kart-containeren
     * @param {object} handlingar Callbacks: { paaKartklikk, paaTurbinklikk }
     */
    constructor(kartId, handlingar = {}) {
        this.kartId = kartId;
        this.handlingar = handlingar;

        this.kart = null;
        this.bakgrunnslag = {};
        this.turbinLag = null;      // MarkerClusterGroup
        this.omradeLag = null;      // LayerGroup med polygon
        this.siktlinjeLag = null;   // LayerGroup med linjer
        this.hinderlysLag = null;   // LayerGroup med lyspunkt
        this.punktMarkor = null;      // analysert punkt
        this.radiusSirkel = null;
        this.kandidatMarkor = null;  // peika på, men ikkje stadfesta
        this.kandidatSirkel = null;

        /** Er nattmodus (hinderlys) slått på? */
        this.nattmodus = false;

        /** @type {Map<string, L.Marker>} id → markør, for utheving. */
        this.turbinMarkorar = new Map();
        this.uthevaId = null;
    }

    // ------------------------------------------------------------ oppsett

    init() {
        this.kart = L.map(this.kartId, {
            center: CONFIG.map.senter,
            zoom: CONFIG.map.zoom,
            minZoom: CONFIG.map.minZoom,
            zoomControl: false,
            attributionControl: true,
        });

        L.control.zoom({ position: 'bottomright' }).addTo(this.kart);

        // Kartverket topo som standard — det er norsk terreng me analyserer,
        // og topografiske fliser gjer terrengforma lesbar direkte på kartet.
        const topo = L.tileLayer(
            'https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png',
            {
                maxNativeZoom: CONFIG.map.maxNativeZoom,
                maxZoom: CONFIG.map.maxOppskalertZoom,
                attribution: '© Kartverket',
            },
        );
        const gratone = L.tileLayer(
            'https://cache.kartverket.no/v1/wmts/1.0.0/topograatone/default/webmercator/{z}/{y}/{x}.png',
            {
                maxNativeZoom: CONFIG.map.maxNativeZoom,
                maxZoom: CONFIG.map.maxOppskalertZoom,
                attribution: '© Kartverket',
            },
        );
        const flybilete = L.layerGroup([
            L.tileLayer(
                'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                {
                    // Esri sitt World_Imagery har ekte dekning til z18 over det
                    // meste av fastlands-Noreg; z19 kjem tilbake som ei generisk
                    // oppatt-skalert flis. Hent z18 og la Leaflet skalere vidare,
                    // så me slepp gråe hol på djup zoom.
                    maxNativeZoom: 18,
                    maxZoom: CONFIG.map.maxOppskalertZoom,
                    attribution: 'Kjelde: Esri',
                },
            ),
            L.tileLayer(
                'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
                { maxNativeZoom: 18, maxZoom: CONFIG.map.maxOppskalertZoom },
            ),
        ]);

        this.bakgrunnslag = { topo, gratone, flybilete };
        topo.addTo(this.kart);

        // Lag-rekkjefølgje: område nedst, så siktlinjer, turbinar, lys øvst.
        this.omradeLag = L.featureGroup().addTo(this.kart);
        // Planområdet til det anlegget brukaren nettopp har teke tak i ein
        // turbin frå — teikna oppå det vanlege områdelaget medan draginga står på.
        this.omradeFramhevLag = L.featureGroup().addTo(this.kart);
        // Lokalt synlegheitskart (ZVI) — under siktlinjene så dei ikkje druknar.
        this.synlegheitskartLag = L.featureGroup().addTo(this.kart);
        this.siktlinjeLag = L.featureGroup().addTo(this.kart);

        /**
         * EIGEN PANE FOR HINDERLYSA.
         *
         * Nattmodusen dempar dei andre vektorlaga for å la lyspunkta stå fram.
         * Låg lysa i den vanlege `overlayPane`, ville same dempinga råka dei
         * sjølve — og heile poenget med modusen forsvann. Ein eigen pane held
         * dei utanfor, og gir dei samstundes ein z-index over siktlinjene.
         */
        this.kart.createPane('hinderlys');
        this.kart.getPane('hinderlys').style.zIndex = 650;
        this.hinderlysLag = L.featureGroup().addTo(this.kart);

        this.turbinLag = L.markerClusterGroup
            ? L.markerClusterGroup({
                showCoverageOnHover: false,
                maxClusterRadius: 50,
                // Clustering av 1600 punkt er naudsynt for yting, men slår seg
                // av på høgt zoom slik at enkeltturbinar kan velgjast.
                disableClusteringAtZoom: 13,
                iconCreateFunction: (cluster) => L.divIcon({
                    html: `<div class="cluster-boble">${cluster.getChildCount()}</div>`,
                    className: 'cluster-ikon',
                    iconSize: [36, 36],
                }),
            })
            : L.layerGroup();
        this.kart.addLayer(this.turbinLag);

        this.kart.on('click', (e) => {
            this.handlingar.paaKartklikk?.(e.latlng.lat, e.latlng.lng);
        });

        return this.kart;
    }

    settBakgrunn(nokkel) {
        for (const [namn, lag] of Object.entries(this.bakgrunnslag)) {
            if (namn === nokkel) {
                if (!this.kart.hasLayer(lag)) lag.addTo(this.kart);
            } else if (this.kart.hasLayer(lag)) {
                this.kart.removeLayer(lag);
            }
        }
        // Bakgrunnen legg seg over dei andre laga når han byttast — dytt
        // vektorlaga tilbake øvst.
        this.omradeLag?.bringToFront();
        this.omradeFramhevLag?.bringToFront();
        this.siktlinjeLag?.bringToFront();
    }

    // ------------------------------------------------------------ nattmodus

    /**
     * Slå nattmodus av/på.
     *
     * Kartverket har ingen mørk flisstil, og å hoste opp ein eigen ville kravd
     * eit heilt nytt flissett. I staden dempast SJØLVE FLISLAGET med eit
     * CSS-filter (`filter: brightness(...) saturate(...)`) på Leaflet sin
     * `.leaflet-tile-pane`. Vektorlaga ligg i eigne panes og vert ikkje råka,
     * så lyspunkta står att i full styrke mot ein mørk bakgrunn — som er
     * nettopp det poenget nattmodusen skal få fram.
     *
     * @param {boolean} paa
     */
    settNattmodus(paa) {
        this.nattmodus = Boolean(paa);
        const el = this.kart?.getContainer();
        el?.classList.toggle('nattmodus', this.nattmodus);
        if (!this.nattmodus) this.hinderlysLag?.clearLayers();
    }

    /**
     * Teikn hinderlys-punkta.
     *
     * ===================================================================
     * KVIFOR BLINKINGA ER CSS-ANIMASJON OG IKKJE EIN setInterval
     * ===================================================================
     * § 16(3) a. i hindermerkeforskrifta krev at blinkande hinderlys i same
     * vindpark blinkar SAMTIDIG. Ein CSS `animation` med same namn og same
     * varigheit startar i same fase for alle element i same dokument, så
     * synkroniseringa fell ut gratis — og han går på GPU-en i staden for å
     * vekkje hovudtråden 60 gonger i minuttet for kvart av hundrevis av lys.
     *
     * @param {object[]} resultat  Analyserte turbinar (kan vera tom)
     * @param {object[]} [turbinar] Rå turbinar, brukt når ingen analyse finst
     */
    tegnHinderlys(resultat, turbinar = null) {
        this.hinderlysLag.clearLayers();
        if (!this.nattmodus) return;

        // Med analyse: berre lys som FAKTISK er synlege frå punktet.
        if (resultat && resultat.length > 0) {
            for (const r of resultat) {
                const hl = r.hinderlys;
                if (!hl?.merkeplikt) continue;
                for (const lys of hl.lyspunkt) {
                    if (lys.synleg !== true) continue;
                    this._leggLyspunkt(r.lat, r.lon, lys, r, true);
                }
            }
            return;
        }

        // Utan analyse: vis toppslyset for turbinane i biletet, men gjer det
        // tydeleg at synlegheita IKKJE er vurdert. Grensa på 400 held kartet
        // flytande — ei blinkande markør per turbin i heile Noreg ville vore
        // 1 600 animerte element.
        if (!turbinar) return;
        const bounds = this.kart.getBounds();
        let talt = 0;
        for (const t of turbinar) {
            if (talt >= 400) break;
            if (!bounds.contains([t.lat, t.lon])) continue;
            const krav = hinderlysKrav({ totalhoydeM: t.totalhoyde_m, navHoydeM: t.nav_hoyde_m });
            if (!krav.merkeplikt) continue;
            const topp = krav.nivaa[0];
            this._leggLyspunkt(t.lat, t.lon, {
                rolle: 'topp',
                cssFarge: topp.type.cssFarge,
                typeNokkel: topp.type.nokkel,
                hoydeOverBakkeM: topp.hoydeOverBakkeM,
                candela: topp.type.candela,
                magnitudeTekst: null,
            }, t, false);
            talt++;
        }
    }

    _leggLyspunkt(lat, lon, lys, kjelde, vurdert) {
        const erTopp = lys.rolle === 'topp';
        const kvit = lys.typeNokkel === 'hoyintensitet_b';

        const markor = L.circleMarker([lat, lon], {
            pane: 'hinderlys',
            radius: erTopp ? 6 : 3,
            color: lys.cssFarge,
            weight: 1,
            opacity: 0.9,
            fillColor: lys.cssFarge,
            fillOpacity: 0.95,
            className: [
                'hinderlys',
                erTopp ? 'hinderlys-topp' : 'hinderlys-mellom',
                kvit ? 'hinderlys-kvit' : 'hinderlys-raud',
                vurdert ? '' : 'hinderlys-uvurdert',
            ].filter(Boolean).join(' '),
            interactive: true,
        });

        const nivaaTekst = erTopp
            ? `topplys på nacellen (${Math.round(lys.hoydeOverBakkeM)} m over bakken)`
            : `mellomnivålys ${Math.round(lys.hoydeOverBakkeM)} m over bakken`;

        markor.bindTooltip(
            `${escHtml(kjelde.navn)} — ${nivaaTekst}<br>`
            + `${kvit ? 'kvitt blinkande' : 'raudt'}, ${lys.candela} cd`
            + (lys.magnitudeTekst ? `<br>${escHtml(lys.magnitudeTekst)}` : '')
            + (vurdert ? '' : '<br><em>synlegheit ikkje vurdert — vel eit punkt</em>'),
            { direction: 'top' },
        );

        this.hinderlysLag.addLayer(markor);
    }

    // ----------------------------------------------------------- turbinar

    /**
     * Teikn turbinmarkørar.
     *
     * @param {object[]} turbinar
     * @param {Set<string>} statusFilter
     */
    tegnTurbinar(turbinar, statusFilter) {
        this.turbinLag.clearLayers();
        this.turbinMarkorar.clear();

        const markorar = [];
        for (const t of turbinar) {
            if (statusFilter.size > 0 && !statusFilter.has(t.status)) continue;

            const stil = CONFIG.status[t.status] ?? CONFIG.status.ukjent;
            const markor = this._lagTurbinMarkor(t, stil);
            this.turbinMarkorar.set(t.id, markor);
            markorar.push(markor);
        }

        if (markorar.length > 0) {
            this.turbinLag.addLayers ? this.turbinLag.addLayers(markorar) : markorar.forEach((m) => this.turbinLag.addLayer(m));
        }
    }

    /**
     * Lag markøren for éin turbin.
     *
     * ======================================================================
     * FIRE POSISJONSKJELDER, FIRE SYMBOL — OG TO ULIKE LEAFLET-KLASSER
     * ======================================================================
     * Symbolet skal svare på «kor sikkert er det at det står ein turbin akkurat
     * her?» utan at brukaren må klikke:
     *
     *   nve_turbinpunkt    – fylt prikk. NVE har koordinaten.
     *   estimert_i_omrade  – open, stipla prikk. Me har plassert han sjølve
     *                        inne i det verkelege planområdet.
     *   anlegg_senterpunkt – stor, open ring. Eitt punkt for heile anlegget,
     *                        utan noka plassering i det heile.
     *   brukerjustert      – fiolett ring rundt symbolet + eit flytt-ikon.
     *                        Brukaren har dratt punktet sjølv.
     *
     * ======================================================================
     * KVIFOR DEI FLYTTBARE ER `L.marker` OG IKKJE `L.circleMarker`
     * ======================================================================
     * `L.circleMarker` er ein SVG-/canvas-bane, ikkje ein markør: Leaflet sin
     * `draggable`-funksjonalitet ligg i `L.Handler.MarkerDrag`, som berre
     * `L.marker` koplar inn. Ein circleMarker kan altså ikkje dragast uansett
     * kva ein set på han.
     *
     * Dei flyttbare kjeldene får difor eit `L.divIcon` som etterliknar
     * circleMarker-stilen sin (open, stipla kontur i statusfargen), medan
     * `nve_turbinpunkt` vert ståande som circleMarker. Skiljet er ikkje berre
     * teknisk gjeld: det gjer det UMOGELEG å dra eit verifisert NVE-punkt, av
     * di markøren rett og slett ikkje har handteraren.
     *
     * Prisen er at markørane har ulike API — `setStyle()` finst berre på
     * circleMarker. `_settUtheving()` tek den skilnaden.
     */
    _lagTurbinMarkor(t, stil) {
        const erPlassholdar = t.posisjon_kilde === 'anlegg_senterpunkt';
        const erEstimert = t.posisjon_kilde === 'estimert_i_omrade';
        const flyttbar = kanFlyttast(t);
        const justert = erJustert(t);

        const markor = flyttbar
            ? this._flyttbarTurbinMarkor(t, stil, { erPlassholdar, justert })
            : L.circleMarker([t.lat, t.lon], {
                radius: 5,
                color: stil.farge,
                weight: 1.5,
                opacity: 0.9,
                fillColor: stil.farge,
                fillOpacity: 0.75,
                className: 'turbin-punkt',
            });

        if (!flyttbar) {
            markor._opphavlegRadius = 5;
            markor._opphavlegWeight = 1.5;
        }

        const merkelapp = justert
            ? ' (flytta av deg)'
            : (erPlassholdar ? ' (heile anlegget)' : (erEstimert ? ' (estimert plassering)' : ''));

        const dragHint = justert
            ? `<br><span class="tt-drahint">Flytta ${escHtml(fmtAvstand(t.flytt_avstand_m ?? 0))} `
              + 'frå det estimerte punktet — dra på nytt, eller tilbakestill i detaljvisinga.</span>'
            : (flyttbar ? '<br><span class="tt-drahint">Dra for å korrigere plasseringa</span>' : '');

        markor.bindTooltip(`${escHtml(t.navn)}${merkelapp}${dragHint}`, { direction: 'top' });
        markor.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            this.handlingar.paaTurbinklikk?.(t);
        });

        return markor;
    }

    /** Draggbar markør for eit punkt appen sjølv har plassert. */
    _flyttbarTurbinMarkor(t, stil, { erPlassholdar, justert }) {
        const storleik = erPlassholdar ? 20 : 14;
        const klassar = ['tf-prikk'];
        if (erPlassholdar) klassar.push('tf-stor');
        if (justert) klassar.push('tf-justert');

        // Inline farge, ikkje CSS-klasse: statusfargane bur i CONFIG, og eit
        // sett med ni klassepar i stilarket ville vore ein andre kopi av dei.
        // `style-src` her har 'unsafe-inline', jf. .htaccess.
        const fyll = erPlassholdar ? '40' : '24';
        const markor = L.marker([t.lat, t.lon], {
            icon: L.divIcon({
                className: 'turbin-flyttbar',
                html: `<span class="${klassar.join(' ')}" `
                    + `style="border-color:${stil.farge};background:${stil.farge}${fyll}"></span>`
                    + (justert
                        ? '<i class="fa-solid fa-arrows-up-down-left-right tf-merke"></i>'
                        : ''),
                iconSize: [storleik, storleik],
                iconAnchor: [storleik / 2, storleik / 2],
            }),
            draggable: true,
            // Tastaturfokus på 1 000 turbinmarkørar ville gjort tab-rekkjefølgja
            // på sida ubrukeleg. Turbinane veljast frå lista i panelet.
            keyboard: false,
            riseOnHover: true,
            zIndexOffset: justert ? 300 : 0,
        });

        markor.on('dragstart', () => {
            this.handlingar.paaTurbinDragStart?.(t);
        });
        markor.on('dragend', (e) => {
            const p = e.target.getLatLng();
            this.handlingar.paaTurbinFlytt?.(t, p.lat, p.lng);
        });

        return markor;
    }

    /**
     * Byt ut markøren for éin turbin etter ei flytting/tilbakestilling.
     *
     * Å teikne alle markørane på nytt ville vore både 1 600 unødvendige
     * DOM-operasjonar og — verre — ei fjerning av den markøren brukaren nettopp
     * slapp, midt i hans eiga handling. Her vert berre den eine bytt, med eit
     * ferskt turbinobjekt i lukkinga, slik at neste drag ser rett opphav.
     */
    oppdaterTurbinMarkor(turbin) {
        const gamal = this.turbinMarkorar.get(turbin.id);
        if (gamal) this.turbinLag.removeLayer(gamal);

        const stil = CONFIG.status[turbin.status] ?? CONFIG.status.ukjent;
        const ny = this._lagTurbinMarkor(turbin, stil);
        this.turbinMarkorar.set(turbin.id, ny);
        this.turbinLag.addLayer(ny);

        if (this.uthevaId === turbin.id) this._settUtheving(ny, true);
        return ny;
    }

    /**
     * Framhev planområdet til eit anlegg medan brukaren drar ein turbin.
     *
     * Poenget er å vise KVA SØKNADEN FAKTISK GJELD, ikkje å sperre. Polygonet
     * er kjeldefest hos NVE (CLAUDE.md §12) — det er sjølve plasseringa inne i
     * det som er vår gjetning, og som brukaren no korrigerer.
     *
     * @param {Array<Array<Array<[number,number]>>>} polygonar
     */
    framhevOmrade(polygonar) {
        this.omradeFramhevLag.clearLayers();
        for (const ringer of polygonar ?? []) {
            this.omradeFramhevLag.addLayer(L.polygon(ringer, {
                color: '#7c3aed',
                weight: 2,
                opacity: 0.95,
                fillColor: '#7c3aed',
                fillOpacity: 0.1,
                dashArray: '6 4',
                interactive: false,
            }));
        }
    }

    skjulOmradeFramheving() {
        this.omradeFramhevLag?.clearLayers();
    }

    /**
     * Lokalt synlegheitskart: éin farga rute per celle, grøn (få synlege
     * turbinar) → raud (mange). Celler utan laserdekning vert hoppa over.
     * @param {{celler:object[], maks:number, celleM:number}} data
     */
    tegnSynlegheitskart(data) {
        this.synlegheitskartLag.clearLayers();
        if (!data || data.maks <= 0) return;

        const mPerGradLat = 111_320;
        const halvLat = (data.celleM / 2) / mPerGradLat;

        for (const c of data.celler) {
            if (c.tal == null) continue;
            const mPerGradLon = 111_320 * Math.cos(c.lat * Math.PI / 180);
            const halvLon = (data.celleM / 2) / mPerGradLon;
            const brok = data.maks > 0 ? c.tal / data.maks : 0;
            // Grøn (hue 130) → raud (hue 0).
            const hue = 130 * (1 - brok);
            this.synlegheitskartLag.addLayer(L.rectangle(
                [[c.lat - halvLat, c.lon - halvLon], [c.lat + halvLat, c.lon + halvLon]],
                {
                    stroke: false,
                    fillColor: `hsl(${hue}, 78%, 46%)`,
                    fillOpacity: c.tal === 0 ? 0.12 : 0.42,
                    interactive: false,
                },
            ));
        }
    }

    skjulSynlegheitskart() {
        this.synlegheitskartLag?.clearLayers();
    }

    /**
     * Teikn områdepolygon for anlegg.
     * Særleg nyttig for planlagde anlegg, der me berre har eitt senterpunkt —
     * polygonet viser kor stort areal saka faktisk gjeld.
     */
    tegnOmrader(omrader, statusFilter, anleggStatus) {
        this.omradeLag.clearLayers();
        if (!omrader) return;

        for (const o of omrader) {
            const status = anleggStatus.get(o.anleggsnr) ?? 'ukjent';
            if (statusFilter.size > 0 && !statusFilter.has(status)) continue;

            const stil = CONFIG.status[status] ?? CONFIG.status.ukjent;
            const polygon = L.polygon(o.ringer, {
                color: stil.farge,
                weight: 1.5,
                opacity: 0.7,
                fillColor: stil.farge,
                fillOpacity: 0.08,
                interactive: false,
            });
            this.omradeLag.addLayer(polygon);
        }
    }

    // -------------------------------------------------------- brukarpunkt

    /**
     * KANDIDATPUNKT — eit punkt brukaren har peika på, men ikkje stadfesta.
     *
     * =======================================================================
     * KVIFOR DETTE STEGET FINST
     * =======================================================================
     * Ein analyse er ikkje gratis: han hentar terrengprofilar for inntil 150
     * turbinar frå Kartverket, i fleire parallelle kall. Køyrde me han direkte
     * på kartklikket, ville kvart bomskot og kvar utforskande klikk på kartet
     * utløyst heile jobben — mot ei offentleg teneste me ikkje eig.
     *
     * Kandidatmarkøren er difor GRATIS: han flyttar seg fritt, utan eit einaste
     * nettverkskall, til brukaren aktivt seier «bruk dette punktet».
     *
     * Han er visuelt tydeleg forskjellig frå den analyserte markøren (open,
     * stipla, dempa farge mot fylt og sterk), slik at det aldri er tvil om
     * kva punkt resultata i panelet gjeld.
     */
    settKandidat(lat, lon, radiusM) {
        if (this.kandidatMarkor) this.kart.removeLayer(this.kandidatMarkor);
        if (this.kandidatSirkel) this.kart.removeLayer(this.kandidatSirkel);

        this.kandidatMarkor = L.marker([lat, lon], {
            draggable: true,
            icon: L.divIcon({
                className: 'kandidat-punkt-ikon',
                html: '<i class="fa-solid fa-location-dot"></i>',
                iconSize: [32, 32],
                iconAnchor: [16, 30],
            }),
            zIndexOffset: 1100,
        }).addTo(this.kart);

        this.kandidatMarkor.bindTooltip('Ikkje stadfesta — dra fritt, analysen startar først når du trykkjer «Analyser her»',
            { direction: 'top' });
        this.kandidatMarkor.on('dragend', (e) => {
            const p = e.target.getLatLng();
            this.handlingar.paaKandidatFlytt?.(p.lat, p.lng);
        });

        this.kandidatSirkel = L.circle([lat, lon], {
            radius: radiusM,
            color: '#64748b',
            weight: 1.5,
            opacity: 0.5,
            fill: false,
            dashArray: '3 7',
            interactive: false,
        }).addTo(this.kart);
    }

    fjernKandidat() {
        if (this.kandidatMarkor) this.kart.removeLayer(this.kandidatMarkor);
        if (this.kandidatSirkel) this.kart.removeLayer(this.kandidatSirkel);
        this.kandidatMarkor = null;
        this.kandidatSirkel = null;
    }

    oppdaterKandidatRadius(radiusM) {
        this.kandidatSirkel?.setRadius(radiusM);
    }

    settPunkt(lat, lon, radiusM) {
        if (this.punktMarkor) this.kart.removeLayer(this.punktMarkor);
        if (this.radiusSirkel) this.kart.removeLayer(this.radiusSirkel);

        this.punktMarkor = L.marker([lat, lon], {
            draggable: true,
            icon: L.divIcon({
                className: 'mitt-punkt-ikon',
                html: '<i class="fa-solid fa-location-dot"></i>',
                iconSize: [32, 32],
                iconAnchor: [16, 30],
            }),
            zIndexOffset: 1000,
        }).addTo(this.kart);

        this.punktMarkor.bindTooltip('Mitt punkt — dra for å flytte', { direction: 'top' });
        // Å dra det analyserte punktet er same slags handling som eit kartklikk:
        // det peikar ut ein ny stad, men skal ikkje sjølv utløyse ein ny
        // analyse. Resultata for det gamle punktet vert ståande til brukaren
        // stadfestar det nye.
        this.punktMarkor.on('dragend', (e) => {
            const p = e.target.getLatLng();
            // Legg markøren tilbake der analysen faktisk gjeld.
            e.target.setLatLng([lat, lon]);
            this.handlingar.paaKandidatFlytt?.(p.lat, p.lng);
        });

        this.radiusSirkel = L.circle([lat, lon], {
            radius: radiusM,
            color: '#0ea5e9',
            weight: 2,
            opacity: 0.6,
            fillColor: '#0ea5e9',
            fillOpacity: 0.04,
            dashArray: '6 6',
            interactive: false,
        }).addTo(this.kart);
    }

    oppdaterRadius(radiusM) {
        this.radiusSirkel?.setRadius(radiusM);
    }

    /** Zoom slik at heile radius-sirkelen er synleg. */
    zoomTilRadius() {
        if (this.radiusSirkel) {
            this.kart.fitBounds(this.radiusSirkel.getBounds(), { padding: [40, 40] });
        }
    }

    // --------------------------------------------------------- siktlinjer

    /**
     * Teikn siktlinjer frå punktet til kvar analyserte turbin.
     *
     * Heiltrekt grøn = synleg, stipla grå = skjult (jf. PLAN.md §3.5).
     * For å halde kartet lesbart teiknar me berre linjer for eit avgrensa tal
     * turbinar — 150 linjer ut frå same punkt vert ei ugjennomtrengeleg vifte.
     */
    tegnSiktlinjer(punkt, resultat, maksLinjer = 60) {
        this.siktlinjeLag.clearLayers();
        if (!punkt) return;

        // Prioriter dei synlege: det er dei som er interessante å sjå på kartet.
        const sortert = [...resultat].sort((a, b) => {
            const aSyn = a.synlegheit.nokkel !== 'skjult' ? 0 : 1;
            const bSyn = b.synlegheit.nokkel !== 'skjult' ? 0 : 1;
            if (aSyn !== bSyn) return aSyn - bSyn;
            return a.avstandM - b.avstandM;
        });

        for (const r of sortert.slice(0, maksLinjer)) {
            const skjult = r.synlegheit.nokkel === 'skjult' || !r.analysert;
            const linje = L.polyline(
                [[punkt.lat, punkt.lon], [r.lat, r.lon]],
                {
                    color: LINJEFARGE[r.synlegheit.nokkel] ?? LINJEFARGE.ukjent,
                    weight: skjult ? 1 : 2,
                    opacity: skjult ? 0.35 : 0.75,
                    dashArray: skjult ? '4 6' : null,
                    interactive: false,
                },
            );
            this.siktlinjeLag.addLayer(linje);
        }
    }

    /**
     * Uthev éin turbin (når han velgjast i panelet).
     *
     * Den førre markøren får tilbake NØYAKTIG sin eigen stil, ikkje ein
     * hardkoda standard: plassholdar- og estimat-markørane har eigne radiar og
     * strektjukkleikar, og eit fast `{radius: 5}` ville stille gjort dei om til
     * vanlege turbinpunkt så snart brukaren hadde klikka på dei éin gong.
     */
    uthevTurbin(id) {
        if (this.uthevaId && this.turbinMarkorar.has(this.uthevaId)) {
            this._settUtheving(this.turbinMarkorar.get(this.uthevaId), false);
        }
        this.uthevaId = id;

        const markor = this.turbinMarkorar.get(id);
        if (markor) {
            this._settUtheving(markor, true);
            markor.bringToFront?.();
        }
    }

    /**
     * Set/fjern utheving på ein markør, uavhengig av kva Leaflet-klasse han er.
     *
     * `setStyle()` finst berre på circleMarker. Dei flyttbare punkta er
     * `L.marker` med divIcon, og uthevast med ein CSS-klasse på sjølve
     * ikon-elementet i staden. `getElement()` kan vere null når markøren ligg
     * inne i ein kollapsa klynge — då er det heller ingenting å uthevje.
     */
    _settUtheving(markor, paa) {
        if (typeof markor.setStyle === 'function') {
            markor.setStyle(paa
                ? { radius: 9, weight: 3 }
                : {
                    radius: markor._opphavlegRadius ?? 5,
                    weight: markor._opphavlegWeight ?? 1.5,
                });
            return;
        }
        markor.getElement()?.classList.toggle('turbin-utheva', paa);
    }

    /**
     * Panorer til eit punkt. Utan `zoom` vert zoomnivået ståande; med `zoom`
     * vert senter og zoom sett i SAME operasjon — ein `panTo()` følgd av eit
     * eige `setZoom()` startar to konkurrerande animasjonar, og zoomen endar
     * då sentrert på den gamle staden, ikkje på målet.
     */
    panorerTil(lat, lon, zoom) {
        if (typeof zoom === 'number') {
            this.kart.setView([lat, lon], zoom);
        } else {
            this.kart.panTo([lat, lon]);
        }
    }

    /** Vis eit informasjonsvindauge for eit anlegg/turbin. */
    visPopup(lat, lon, html) {
        L.popup({ maxWidth: 320 })
            .setLatLng([lat, lon])
            .setContent(html)
            .openOn(this.kart);
    }
}
