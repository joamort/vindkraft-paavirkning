/**
 * js/utils/ImpactCalculator.js
 *
 * Orkestrerer synlegheit + visuell dominans + støy for éin turbin, gitt ein
 * terrengprofil frå backend.
 *
 * ===========================================================================
 * SIKTLINJEMETODEN — "høgaste skrapelinje"
 * ===========================================================================
 * Ein naiv metode er å sjekke om terrenget bryt siktlinja til vengetuppen, og
 * svare binært synleg/skjult. Det svarer ikkje på det brukaren faktisk lurer
 * på: "kor mykje av turbinen ser eg?"
 *
 * I staden reknar me ut den HØGASTE SKRAPELINJA: den brattaste strålen frå
 * auget som så vidt skrapar eit terrengpunkt på vegen. Sjølve skanninga ligg i
 * `skannHorisont()` i geo.js, som returnerer HELNINGA på den strålen —
 * ein eigenskap ved terrenget i retninga, ikkje ved turbinen. `horisontMoh`
 * er så berre den helninga lest av i turbinens avstand.
 *
 * Alt på turbinen som ligg UNDER den høgda er skjult; alt over er synleg. Det
 * gir i éin operasjon:
 *
 *   - binær synlegheit        (er vengetuppen over horisonten?)
 *   - kor stor DEL som er synleg  (og dermed "delvis synleg")
 *   - om sjølve navet er synleg   (styrer skjermingsleddet i støymodellen)
 *   - kva terrengpunkt som faktisk er skuld i skjerminga (til grafen)
 *   - kvart einaste hinderlys si synlegheit, utan nye høgdeoppslag
 *
 * Og fordi helninga ikkje veit noko om turbinen, er det NØYAKTIG same storleik
 * 360°-panoramaet byggjer terrengsilhuetten sin av — berre skanna i 96
 * retningar i staden for mot kvar turbin. Sjå js/utils/Horizon.js.
 *
 * BEGRENSNING (PLAN.md §7): profilen er ein terrengmodell (DTM) — bar bakke.
 * Skog, bygningar og andre hindringar er IKKJE med. Modellen er difor
 * systematisk OPTIMISTISK: han vil melde "synleg" for ting som i praksis er
 * skjult bak skog. Dette må seiast tydeleg i UI.
 *
 * Avgrensinga har sidan fått ein målretta KRYSSJEKK mot overflatemodellen
 * (DOM) i akkurat det eine punktet som avgjer saka — sjå
 * js/utils/SurfaceCheck.js og CLAUDE.md §22. Hovudtalet her er framleis bar
 * bakke; DOM-sjekken er eit «men obs» attåt, ikkje ei erstatning.
 */

import { CONFIG } from '../config.js';
import {
    haversine, bearing, kompassretning, synsvinkel, dominanskategori,
    skannHorisont, horisontMohVedAvstand,
} from './geo.js';
import { turbinStoy } from './NoiseModel.js';
import { hinderlysKrav, hinderlysSynlegheit } from './ObstacleLights.js';

/**
 * SYNLEGHEITSVURDERINGA, LØYST FRÅ PROFILEN.
 *
 * ===========================================================================
 * KVIFOR DETTE ER EIN EIGEN FUNKSJON
 * ===========================================================================
 * Alt under er ei rein omrekning frå ÉI helning til ei synlegheitsdom. Han tek
 * ingen profil, gjer ingen skanning og veit ikkje kvar helninga kom frå.
 *
 * Det er nettopp poenget: DOM-kryssjekken (§22) reknar ut ei ANNA helning for
 * same turbin — den ein får når det kritiske terrengpunktet vert heva til
 * overflatemodellens høgd — og skal svare på nøyaktig same spørsmål med
 * nøyaktig same tersklar. Med to kopiar av den fire-delte skalaen ville dei to
 * svara før eller seinare drive frå kvarandre, og då ville ikkje «bar bakke:
 * delvis / med skog: skjult» lenger vera ei samanlikning av det same.
 *
 * @param {object} args
 * @param {number} args.helning        Frå skannHorisont()
 * @param {object|null} args.kritiskPunkt
 * @param {number} args.augeMoh
 * @param {number} args.avstandM
 * @param {number} args.basisMoh       Bakken ved turbinen
 * @param {number} args.navMoh
 * @param {number} args.tuppMoh
 * @returns {object} synlegheitsobjekt (same form som `resultat.synlegheit`)
 */
export function vurderSynlegheit({
    helning, kritiskPunkt, augeMoh, avstandM, basisMoh, navMoh, tuppMoh,
}) {
    const horisontMoh = horisontMohVedAvstand(helning, augeMoh, avstandM);

    const turbinHoyde = tuppMoh - basisMoh;

    // Horisonten kan liggje høgt over turbinen når terrenget stengjer heilt.
    // Til AREAL-rekninga klemmer me han til turbinens eige spenn, slik at
    // "synleg del" held seg i [0,1] og synsvinkelen aldri vert negativ.
    // Den uklemde verdien er framleis tilgjengeleg som `horisontMoh`.
    const lågasteSynlege = Math.min(tuppMoh, Math.max(horisontMoh, basisMoh));
    const synlegHoyde = Math.max(0, tuppMoh - lågasteSynlege);
    const synlegDel = turbinHoyde > 0 ? Math.min(1, synlegHoyde / turbinHoyde) : 0;

    const navSynleg = navMoh > horisontMoh;
    const skjulhoyde = Math.max(0, horisontMoh - navMoh);

    /**
     * FIRE-DELT SYNLEGHEITSSKALA
     *
     * Ein binær synleg/skjult-verdi er for grov, og eit krav om 100 % synleg
     * er meiningslaust i praksis: for eit anlegg på ein fjellrygg, sett
     * nedanfrå, er sjølve TÅRNFOTEN nesten alltid gøymd bak terrenget føre.
     * Verifisert mot Storheia — frå eit ope punkt 3,3 km unna er dei øvste
     * turbinane 70 % synlege med navet i fri sikt, medan dei lågare er heilt
     * borte. Ein terskel på 99 % ville stempla begge som "delvis".
     *
     * Skalaen skil difor på det som faktisk betyr noko visuelt: kor stor del
     * av turbinen som er over horisonten, og om NAVET (og dermed heile
     * rotoren) er synleg — det er rotoren i rørsle som pregar landskapsbiletet.
     */
    let synlegheit;
    if (synlegDel < 0.02) {
        synlegheit = { nokkel: 'skjult', tekst: 'Skjult av terreng', synlegDel: 0 };
    } else if (synlegDel < 0.15) {
        synlegheit = { nokkel: 'saa_vidt', tekst: 'Så vidt synleg', synlegDel };
    } else if (!navSynleg || synlegDel < 0.9) {
        synlegheit = { nokkel: 'delvis', tekst: 'Delvis synleg', synlegDel };
    } else {
        synlegheit = { nokkel: 'synleg', tekst: 'Godt synleg', synlegDel };
    }
    synlegheit.navSynleg = navSynleg;
    synlegheit.skjulhoydeM = skjulhoyde;
    synlegheit.horisontMoh = horisontMoh;
    /**
     * Helninga horisonten vart rekna av — same tal 360°-horisonten produserer
     * for denne retninga. Ligg her fordi det er den D-uavhengige forma, og
     * dermed den som kan samanliknast direkte på tvers av dei to vegane.
     */
    synlegheit.horisontHelning = helning;
    synlegheit.horisontGrader = Math.atan(helning) / (Math.PI / 180);
    synlegheit.kritiskPunkt = kritiskPunkt;
    /** Lågaste punkt på turbinen som er over horisonten (moh.). */
    synlegheit.lagasteSynlegeMoh = lågasteSynlege;

    /**
     * NÆRSKJERMING — viktig atterhald til brukaren.
     *
     * Er det terrenget heilt inntil punktet som stengjer sikta, er resultatet
     * svært følsamt for nøyaktig kvar punktet vart sett: ein liten haug 60 m
     * unna kan skjule ein heil vindpark, og flyttar du punktet 50 m er svaret
     * eit heilt anna. Det er fysisk korrekt, men brukaren MÅ få vite det —
     * elles vert eit tilfeldig museklikk lese som ein konklusjon.
     */
    synlegheit.naerskjerming = Boolean(
        kritiskPunkt
        && synlegDel < 0.995
        && kritiskPunkt.d < 300
        && kritiskPunkt.d < avstandM * 0.1,
    );

    return synlegheit;
}

/**
 * Rekn ut full påverknad for éin turbin.
 *
 * @param {object} args
 * @param {{lat:number, lon:number, hoyde:number}} args.punkt   Brukarens punkt + bakkehøgd
 * @param {object} args.turbin                                   Turbinobjekt frå cachen
 * @param {Array<{d:number,z:number,lat:number,lon:number,terreng:?string}>|null} args.profil
 * @returns {object} Resultatobjekt klart for UI
 */
export function beregnPaaverknad({ punkt, turbin, profil }) {
    const avstand = haversine(punkt.lat, punkt.lon, turbin.lat, turbin.lon);
    const kurs = bearing(punkt.lat, punkt.lon, turbin.lat, turbin.lon);

    const grunnlag = {
        id: turbin.id,
        navn: turbin.navn,
        status: turbin.status,
        anleggsnr: turbin.anleggsnr,
        lat: turbin.lat,
        lon: turbin.lon,
        avstandM: avstand,
        kurs,
        retning: kompassretning(kurs),
        navHoydeM: turbin.nav_hoyde_m,
        rotorDiameterM: turbin.rotor_diameter_m,
        totalhoydeM: turbin.totalhoyde_m,
        lydeffektDba: turbin.lydeffekt_dba,
        effektMw: turbin.effekt_mw,
        malKilde: turbin.mal_kilde,
        // Kjeldeføring for kuraterte mål (mal_kilde === 'kjent_soknad').
        // Finst ikkje på estimerte turbinar — difor ?? null heile vegen.
        malKjeldeUrl: turbin.mal_kjelde_url ?? null,
        malKjeldeDato: turbin.mal_kjelde_dato ?? null,
        malKjeldeStatus: turbin.mal_kjelde_status ?? null,
        malNotat: turbin.mal_notat ?? null,
        malSpenn: turbin.mal_spenn ?? null,
        malUtleidd: turbin.mal_utleidd ?? null,
        posisjonKilde: turbin.posisjon_kilde,
        /**
         * Sett berre når brukaren sjølv har dratt turbinen til ein annan stad
         * (posisjonKilde === 'brukerjustert'). Dei følgjer med heilt ut i UI,
         * slik at ei brukarjustering aldri kan lesast som ny offisiell data —
         * sjå js/utils/TurbinJustering.js.
         */
        opphavlegLat: turbin.opphavleg_lat ?? null,
        opphavlegLon: turbin.opphavleg_lon ?? null,
        opphavlegPosisjonKilde: turbin.opphavleg_posisjon_kilde ?? null,
        flyttAvstandM: turbin.flytt_avstand_m ?? null,
        representererTurbiner: turbin.representerer_turbiner ?? null,
        // Berre sett på punkt med posisjon_kilde === 'estimert_i_omrade'.
        layoutMaal: turbin.layout_maal ?? null,
        layoutPlasserte: turbin.layout_plasserte ?? null,
        layoutAvstandM: turbin.layout_avstand_m ?? null,
        layoutTerreng: turbin.layout_terreng ?? null,
        // Eigar er slått ned frå anleggsnivå i state.settDatagrunnlag().
        eier: turbin.eier ?? null,
        kommune: turbin.kommune ?? null,
        fylke: turbin.fylke ?? null,
    };

    // Kva forskrifta krev av hinderlys avheng BERRE av turbinmåla, ikkje av
    // terrenget. Krava kan difor stillast opp òg for turbinar utan profil.
    const lysKrav = hinderlysKrav({
        totalhoydeM: turbin.totalhoyde_m,
        navHoydeM: turbin.nav_hoyde_m,
    });

    // Utan profil kan me ikkje seie noko om terreng — men avstand, dominans og
    // eit støyestimat utan skjerming er framleis nyttig informasjon.
    if (!profil || profil.length < 3) {
        return {
            ...grunnlag,
            analysert: false,
            synlegheit: { nokkel: 'ukjent', tekst: 'Ikkje analysert', synlegDel: null },
            dominans: dominanskategori(avstand, turbin.rotor_diameter_m),
            stoy: null,
            // Utan terrengdata veit me kva lys som SKAL vere der, men ikkje om
            // dei er synlege. `synleg: null` skil det frå «skjult».
            hinderlys: hinderlysSynlegheit({
                krav: lysKrav,
                bakkeVedTurbinMoh: null,
                horisontMoh: null,
                avstandM: avstand,
            }),
            skyggekast: null,
            profil: null,
        };
    }

    // --- Høgder ----------------------------------------------------------
    const bakkeVedPunkt = punkt.hoyde;
    // Siste profilpunkt ligg på turbinens posisjon.
    const bakkeVedTurbin = profil[profil.length - 1].z;

    const augeMoh = bakkeVedPunkt + CONFIG.sikt.augehoydeM;
    const basisMoh = bakkeVedTurbin;
    const navMoh = bakkeVedTurbin + turbin.nav_hoyde_m;
    const tuppMoh = bakkeVedTurbin + turbin.totalhoyde_m;

    // --- Høgaste skrapelinje --------------------------------------------
    // Sjølve skanninga ligg i geo.js, slik at ho er ÉIN implementasjon:
    // per-turbin-analysen her, hinderlysa, og 360°-horisonten som
    // panoramaet byggjer på, spør alle det same terrenget om det same.
    // Punkt nærare enn CONFIG.sikt.minHindringsavstandM vert hoppa over, og
    // det siste profilpunktet er per definisjon turbinens eigen fot.
    const { helning, kritiskPunkt } = skannHorisont(profil, augeMoh, {
        minAvstandM: CONFIG.sikt.minHindringsavstandM,
        maksAvstandM: avstand,
    });

    // --- Synlegheit -------------------------------------------------------
    const synlegheit = vurderSynlegheit({
        helning, kritiskPunkt, augeMoh, avstandM: avstand, basisMoh, navMoh, tuppMoh,
    });

    const horisontMoh = synlegheit.horisontMoh;
    const synlegDel = synlegheit.synlegDel;
    const navSynleg = synlegheit.navSynleg;
    const skjulhoyde = synlegheit.skjulhoydeM;
    const lågasteSynlege = synlegheit.lagasteSynlegeMoh;

    // --- Visuell dominans -------------------------------------------------
    const dominans = dominanskategori(avstand, turbin.rotor_diameter_m);
    // Synsvinkelen reknast for den SYNLEGE delen — ein turbin der berre
    // vengetuppen stikk opp dominerer ikkje synsfeltet slik heile tårnet ville.
    dominans.synsvinkelGrader = synlegDel > 0
        ? synsvinkel(tuppMoh, lågasteSynlege, augeMoh, avstand)
        : 0;
    dominans.synsvinkelFullGrader = synsvinkel(tuppMoh, basisMoh, augeMoh, avstand);

    // --- Støy -------------------------------------------------------------
    let stoy = null;
    if (avstand <= CONFIG.stoy.maksRelevantAvstandM) {
        stoy = turbinStoy({
            lydeffektDba: turbin.lydeffekt_dba,
            horisontalAvstandM: avstand,
            navHoydeMoh: navMoh,
            oyreHoydeMoh: augeMoh,
            navSynleg,
            skjulhoydeM: skjulhoyde,
            antallTurbiner: turbin.representerer_turbiner ?? 1,
        });
    }

    return {
        ...grunnlag,
        analysert: true,
        bakkeVedTurbinMoh: bakkeVedTurbin,
        bakkeVedPunktMoh: bakkeVedPunkt,
        augeMoh,
        basisMoh,
        navMoh,
        tuppMoh,
        synlegheit,
        dominans,
        stoy,
        /**
         * HINDERLYS PER LYSPUNKT.
         *
         * Kvart lyspunkt vurderast mot NØYAKTIG SAME terrenghorisont som
         * vengetuppen — `horisontMoh` er ein eigenskap ved terrenget mellom
         * punktet og turbinen, ikkje ved turbinen. Difor kostar det ingen nye
         * høgdeoppslag å svare uavhengig på «ser eg navlyset?» og «ser eg
         * mellomnivålyset?», sjølv når svaret er ulikt frå vengetuppen sitt.
         */
        hinderlys: hinderlysSynlegheit({
            krav: lysKrav,
            bakkeVedTurbinMoh: bakkeVedTurbin,
            horisontMoh,
            avstandM: avstand,
        }),
        /** Fyllast ut av AnalyseRunner — krev soltabellen for heile året. */
        skyggekast: null,
        profil,
    };
}

/**
 * Byggjer samandraget som visast øvst i panelet.
 *
 * @param {object[]} resultat Liste med utrekna turbinresultat
 * @returns {object}
 */
export function byggSamandrag(resultat) {
    const analyserte = resultat.filter((r) => r.analysert);
    const synlege = analyserte.filter((r) => r.synlegheit.nokkel !== 'skjult');
    const heiltSynlege = analyserte.filter((r) => r.synlegheit.nokkel === 'synleg');
    // Turbinar der rotoren står fritt i sikte — det er dei som faktisk pregar
    // landskapsbiletet, og eit meir meiningsfullt tal enn "heilt synleg".
    const rotorSynlege = analyserte.filter((r) => r.synlegheit.navSynleg);
    // Resultat som heng på terreng heilt inntil punktet, og difor er svært
    // følsame for kvar brukaren klikka.
    const naerskjerma = analyserte.filter((r) => r.synlegheit.naerskjerming);

    // Næraste synlege turbin — det er den som pregar utsikta mest.
    const naermasteSynlege = synlege.length > 0
        ? synlege.reduce((a, b) => (a.avstandM <= b.avstandM ? a : b))
        : null;

    const naermaste = resultat.length > 0
        ? resultat.reduce((a, b) => (a.avstandM <= b.avstandM ? a : b))
        : null;

    // Mest dominerande = størst synsvinkel på den synlege delen.
    const mestDominerande = synlege.length > 0
        ? synlege.reduce((a, b) => (a.dominans.synsvinkelGrader >= b.dominans.synsvinkelGrader ? a : b))
        : null;

    /**
     * HINDERLYS OM NATTA.
     *
     * Talet som betyr noko er ikkje «kor mange turbinar er merkepliktige», men
     * «kor mange raude/kvite lyspunkt ser eg frå stova mi når det er mørkt».
     * Eit lyspunkt kan vere synleg sjølv når turbinen elles er nesten heilt
     * skjult — det er berre navhøgda som må stikke over horisonten.
     */
    const medLys = analyserte.filter((r) => r.hinderlys?.merkeplikt);
    const medSynlegTopplys = medLys.filter((r) => r.hinderlys.toppSynleg);
    const lyspunktSynlege = medLys.reduce((s, r) => s + r.hinderlys.synlege, 0);
    const hoyintensitet = medSynlegTopplys.filter((r) => r.hinderlys.hoyintensitet);
    // Sterkaste (lågaste) magnitude blant alle synlege lyspunkt.
    const magnitudar = medLys
        .flatMap((r) => r.hinderlys.lyspunkt.filter((l) => l.synleg === true).map((l) => l.magnitude))
        .filter(Number.isFinite);

    return {
        totalt: resultat.length,
        analyserte: analyserte.length,
        synlege: synlege.length,
        hinderlys: {
            merkepliktige: medLys.length,
            medSynlegTopplys: medSynlegTopplys.length,
            lyspunktSynlege,
            kviteBlinkande: hoyintensitet.length,
            sterkasteMagnitude: magnitudar.length ? Math.min(...magnitudar) : null,
        },
        heiltSynlege: heiltSynlege.length,
        rotorSynlege: rotorSynlege.length,
        delvisSynlege: synlege.length - heiltSynlege.length,
        skjulte: analyserte.length - synlege.length,
        naerskjerma: naerskjerma.length,
        naermaste,
        naermasteSynlege,
        mestDominerande,
    };
}
