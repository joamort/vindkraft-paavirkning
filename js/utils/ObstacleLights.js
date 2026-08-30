/**
 * js/utils/ObstacleLights.js
 *
 * Hinderlys (luftfartshindermerking) på vindturbinar — kva forskrifta KREVJER
 * som minimum, kvar lyspunkta sit, og kor synlege dei er frå brukarens punkt
 * om natta.
 *
 * ===========================================================================
 * KJELDA — og kvifor akkurat den kjelda
 * ===========================================================================
 * Regelverket er **forskrift 15. juli 2014 nr. 980 om rapportering,
 * registrering og merking av luftfartshinder** (BSL E 2-1), slik ho lyder
 * etter endringane i kraft 1. januar 2024 og 1. januar 2026.
 *
 * Det er lett å hamne på feil forskrift her. Forskrift 3. desember 2002
 * nr. 1384 (BSL E 2-2) vert framleis sitert i mykje sekundærlitteratur, men
 * 2014-forskrifta står eksplisitt oppført med «Endrer FOR-2002-12-03-1384».
 * Dei materielle krava er ULIKE — 2002-forskrifta hadde ingen reglar om
 * mellom-/høyintensitetslys på turbinar i det heile, og ingen § 7a om
 * behovsstyrt lyssetting. Sjå CLAUDE.md §10.
 *
 * ===========================================================================
 * TO TING SOM ER LETTE Å TA FEIL AV
 * ===========================================================================
 * 1. **Toppmerkinga skiftar FARGE ved 150 m.** Under 150 m totalhøgd er
 *    toppen raud (mellomintensitet type B/C, 2 000 cd). Frå og med 150 m er
 *    han **kvit og alltid blinkande** (høyintensitet type B, 100 000 cd om
 *    dagen, nedsenka til 2 000 cd om natta). Dei største turbinane har altså
 *    ikkje «meir av det same» på toppen — dei har ein annan type lys.
 *
 * 2. **Ikkje alle turbinar treng lys.** § 16(3) f. lèt Luftfartstilsynet
 *    godkjenne at berre turbinane i vindkraftverkets PERIMETER vert merkte,
 *    når avstanden mellom dei merkte turbinane held seg under 900 m
 *    (mellomintensitet) eller 1 500 m (høyintensitet). Me veit ikkje kva
 *    anlegg som har fått slik godkjenning, og modellen viser difor lys på
 *    ALLE merkepliktige turbinar — eit maksimumsbilete.
 *
 * Legg til § 7a: sidan 1. januar 2024 kan konsesjonsinnehavaren søkje om
 * **behovsstyrt tenning av hinderlys (ADLS)**, der eit radar-/transponder-
 * system slår lyset på berre når det faktisk er fly i nærleiken (6 000 m for
 * luftfartøy med transponder, 1 500 m utan). Godkjenninga «gjelder kun for det
 * anlegget som er spesifisert i søknaden». NVE-datasettet inneheld ingen
 * opplysning om kven som har fått slik godkjenning, så modellen kan ikkje
 * seie noko om det — berre ta atterhald.
 */

import { CONFIG } from '../config.js';

const H = CONFIG.hinderlys;

/**
 * Lysklassene i Vedlegg 2 til forskrifta, med verdiane som gjeld OM NATTA
 * (kolonne C: bakgrunnsbelysning under 50 candela per kvadratmeter).
 *
 * `blinkar: null` betyr at forskrifta opnar for begge deler og at me ikkje
 * kan vite kva som faktisk er montert.
 */
export const LYSTYPE = {
    mellomintensitet_b_c: {
        nokkel: 'mellomintensitet_b_c',
        tekst: 'Mellomintensitets hinderlys type B eller C',
        kortTekst: 'mellomintensitet B/C',
        farge: 'raudt',
        cssFarge: '#ff2d2d',
        candela: H.cdMellomintensitet,
        blinkar: null,
        blinkPerMinutt: [20, 60],
        merknad: 'Type B kan blinke 20–60 gonger i minuttet, type C er fast lys. '
               + 'Forskrifta opnar for begge, så me kan ikkje vite kva som er montert.',
    },
    hoyintensitet_b: {
        nokkel: 'hoyintensitet_b',
        tekst: 'Høyintensitets hinderlys type B',
        kortTekst: 'høyintensitet B',
        farge: 'kvitt',
        cssFarge: '#ffffff',
        candela: H.cdHoyintensitet,
        candelaDag: 100000,
        candelaSkumring: 20000,
        blinkar: true,
        blinkPerMinutt: [40, 60],
        merknad: 'Kvitt og alltid blinkande, 40–60 gonger i minuttet. '
               + '100 000 cd om dagen, nedsenka til 2 000 cd om natta.',
    },
    lavintensitet_b: {
        nokkel: 'lavintensitet_b',
        tekst: 'Lavintensitets hinderlys type B',
        kortTekst: 'lavintensitet B',
        farge: 'raudt',
        cssFarge: '#ff2d2d',
        candela: H.cdLavintensitet,
        blinkar: null,
        merknad: 'Raudt, fast eller blinkande, 32 cd.',
    },
};

/**
 * Kva forskrifta krev av hinderlys for éin turbin, og kvar lyspunkta sit.
 *
 * Merk at `totalhoydeM` er nøyaktig det forskrifta § 3 f. definerer som
 * «høyde på vindturbin»: frå terrenget til toppen av rotorbladet når det står
 * i høgaste posisjon. Det er same storleiken appen elles kallar totalhøgd.
 *
 * NIVÅFORDELINGA PÅ TÅRNET (turbinar ≥ 150 m)
 * -------------------------------------------
 * § 16(3) c. seier berre to ting: lavintensitetslys «på mellomliggende nivå»,
 * og «Den vertikale avstanden mellom lysene skal ikke overstige 75 meter».
 * Vedlegg 5 (rettleiinga til § 16) presiserer: «På vindturbiner skal lysene
 * fordeles mellom topp nacelle til terreng, totalt 3 sett med lys.»
 *
 * Me tolkar dette som: del strekninga frå nacelletoppen ned til terrenget i
 * `I` like intervall, der `I = max(3, ceil(navhøgd / 75))`. Det gir minst tre
 * sett lys (topp + to mellomnivå), og held automatisk 75 m-kravet òg for dei
 * høgaste tårna. For eit 175 m nav vert det tre nivå med 58 m mellomrom.
 *
 * @param {{totalhoydeM:number, navHoydeM:number}} turbin
 * @returns {{
 *   merkeplikt: boolean,
 *   hoyintensitet: boolean,
 *   toppType: object|null,
 *   mellomType: object|null,
 *   talNivaa: number,
 *   nivaa: Array<{rolle:string, hoydeOverBakkeM:number, type:object}>,
 *   grunngjeving: string,
 * }}
 */
export function hinderlysKrav({ totalhoydeM, navHoydeM }) {
    const total = Number(totalhoydeM);
    const nav = Number(navHoydeM);

    if (!Number.isFinite(total) || total < H.merkepliktFraTotalhoydeM) {
        return {
            merkeplikt: false,
            hoyintensitet: false,
            toppType: null,
            mellomType: null,
            talNivaa: 0,
            nivaa: [],
            grunngjeving: `Under ${H.merkepliktFraTotalhoydeM} m totalhøgd — ingen merkeplikt (§ 7 andre ledd).`,
        };
    }

    const hoyintensitet = total >= H.hoyintensitetFraTotalhoydeM;
    const toppType = hoyintensitet ? LYSTYPE.hoyintensitet_b : LYSTYPE.mellomintensitet_b_c;

    // Toppen: to lys på nacellen. Dei sit i praksis i same punkt sett frå
    // bakken, så synlegheita reknast éin gong.
    const nivaa = [{
        rolle: 'topp',
        hoydeOverBakkeM: nav,
        type: toppType,
    }];

    if (hoyintensitet && Number.isFinite(nav) && nav > 0) {
        const intervall = Math.max(
            H.minTalNivaa,
            Math.ceil(nav / H.maksVertikalAvstandM),
        );
        for (let k = 1; k < intervall; k++) {
            nivaa.push({
                rolle: 'mellom',
                hoydeOverBakkeM: (nav * (intervall - k)) / intervall,
                type: LYSTYPE.lavintensitet_b,
            });
        }
    }

    return {
        merkeplikt: true,
        hoyintensitet,
        toppType,
        mellomType: hoyintensitet ? LYSTYPE.lavintensitet_b : null,
        talNivaa: nivaa.length,
        nivaa,
        grunngjeving: hoyintensitet
            ? `Totalhøgd ${Math.round(total)} m ≥ 150 m: to høyintensitets hinderlys type B `
              + `(kvitt, blinkande) på nacellen, og lavintensitets type B (raudt) på `
              + `${nivaa.length - 1} mellomnivå — § 16(3) c.`
            : `Totalhøgd ${Math.round(total)} m: to mellomintensitets hinderlys type B eller C `
              + `(raudt, 2 000 cd) på toppen av nacellen — § 16(3) b. Ingen krav om mellomnivå.`,
    };
}

/**
 * Tilsynelatande stjernemagnitude for eit lyspunkt sett frå ein gitt avstand.
 *
 * ===========================================================================
 * KVIFOR REKNE OM TIL MAGNITUDE I DET HEILE
 * ===========================================================================
 * «2 000 candela» seier ingenting til ein lesar. Det gjer derimot «like sterkt
 * som Venus». Omrekninga er rein fotometri og krev ingen føresetnader utover
 * atmosfæren:
 *
 *     E = I / d²                          (illuminans, lux)
 *     m = −2,5 · log₁₀(E / E₀) + ekstinksjon
 *
 * der E₀ = 2,54·10⁻⁶ lux er illuminansen frå ei stjerne med magnitude 0.
 *
 * Ekstinksjonsleddet er ikkje pynt: horisontal sikt nær bakken dempar langt
 * meir per kilometer enn ein zenit-observasjon. Med meteorologisk siktvidde V
 * er dempinga 1,086 · (3,912 / V) magnitude per km — ~0,11 mag/km ved V = 40 km
 * (klar natt). Utan leddet ville modellen systematisk overdrive lysa langt unna.
 *
 * Resultat for eit 2 000 cd-lys ved klar natt:
 *     5 km  → m ≈ −3,2   (mellom Jupiter og Venus)
 *    10 km  → m ≈ −1,6   (om lag Sirius)
 *    20 km  → m ≈ +1,4   (ei tydeleg, men vanleg stjerne)
 *
 * @param {number} candela
 * @param {number} avstandM
 * @returns {number|null} tilsynelatande magnitude (lågare = sterkare)
 */
export function stjernemagnitude(candela, avstandM) {
    if (!(candela > 0) || !(avstandM > 0)) return null;
    const luxUtanDemping = candela / avstandM ** 2;
    const m0 = -2.5 * Math.log10(luxUtanDemping / H.magnitude0Lux);
    const ekstinksjonPerKm = 1.086 * (3.912 / H.siktvidddeKm);
    return m0 + ekstinksjonPerKm * (avstandM / 1000);
}

/**
 * Kjende himmellekamar å samanlikne mot, sortert frå sterkast til svakast.
 * Verdiane er typiske tilsynelatande magnitudar.
 */
const SAMANLIKNING = [
    { maks: -4.0, tekst: 'sterkare enn Venus på sitt klaraste' },
    { maks: -2.5, tekst: 'om lag som Venus' },
    { maks: -1.5, tekst: 'om lag som Jupiter' },
    { maks: -0.5, tekst: 'om lag som Sirius, den klaraste stjerna på himmelen' },
    { maks: 0.6, tekst: 'om lag som Vega' },
    { maks: 1.7, tekst: 'om lag som ei stjerne i Karlsvogna' },
    { maks: 2.6, tekst: 'om lag som Polarstjerna' },
    { maks: 4.0, tekst: 'ei svak, men tydeleg stjerne' },
    { maks: 6.0, tekst: 'på grensa av kva auget kan sjå' },
    { maks: Infinity, tekst: 'under grensa for kva auget kan sjå' },
];

/** Menneskeleg samanlikning for ein magnitude. */
export function magnitudeTekst(m) {
    if (m === null || !Number.isFinite(m)) return null;
    return SAMANLIKNING.find((s) => m < s.maks).tekst;
}

/**
 * Synlegheit for kvart lyspunkt på éin turbin, gitt terrenghorisonten som
 * allereie er rekna ut for turbinen.
 *
 * ===========================================================================
 * KVIFOR DETTE IKKJE KREV EIT EINASTE NYTT HØGDEOPPSLAG
 * ===========================================================================
 * ImpactCalculator reknar allereie ut `horisontMoh` — høgda den høgaste
 * skrapelinja frå auget når ved turbinen. Den storleiken er ein eigenskap ved
 * TERRENGET mellom punktet og turbinen, ikkje ved turbinen. Difor gjeld
 * nøyaktig same horisont for kvart einaste punkt på turbinen:
 *
 *     eit lyspunkt er synleg  ⟺  bakkeVedTurbin + høgdeOverBakke > horisontMoh
 *
 * Det gir presis, uavhengig synlegheit per lyspunkt — eit navlys kan vere
 * skjult sjølv om vengetuppen står fritt, og eit mellomnivålys kan vere skjult
 * sjølv om navlyset er synleg — utan å hente profilen på nytt.
 *
 * @param {object} args
 * @param {object} args.krav              Frå hinderlysKrav()
 * @param {number} args.bakkeVedTurbinMoh
 * @param {number} args.horisontMoh
 * @param {number} args.avstandM
 * @returns {object}
 */
export function hinderlysSynlegheit({ krav, bakkeVedTurbinMoh, horisontMoh, avstandM }) {
    if (!krav.merkeplikt) {
        return { ...krav, lyspunkt: [], synlege: 0, toppSynleg: false, sterkasteMagnitude: null };
    }

    const kanVurdere = Number.isFinite(bakkeVedTurbinMoh) && Number.isFinite(horisontMoh);

    const lyspunkt = krav.nivaa.map((n) => {
        const moh = kanVurdere ? bakkeVedTurbinMoh + n.hoydeOverBakkeM : null;
        // Utan terrengdata veit me ikkje — då er `synleg` null, ikkje false.
        const synleg = kanVurdere ? moh > horisontMoh : null;
        // Skrå avstand: eit lys 200 m over auget 800 m unna står merkbart
        // lenger vekk enn den horisontale avstanden tilseier.
        const magnitude = stjernemagnitude(n.type.candela, avstandM);

        return {
            rolle: n.rolle,
            hoydeOverBakkeM: Math.round(n.hoydeOverBakkeM * 10) / 10,
            moh,
            synleg,
            typeNokkel: n.type.nokkel,
            farge: n.type.farge,
            cssFarge: n.type.cssFarge,
            candela: n.type.candela,
            blinkar: n.type.blinkar,
            magnitude,
            magnitudeTekst: magnitudeTekst(magnitude),
        };
    });

    const synlege = lyspunkt.filter((l) => l.synleg === true);
    const topp = lyspunkt.find((l) => l.rolle === 'topp') ?? null;

    return {
        ...krav,
        lyspunkt,
        synlege: synlege.length,
        toppSynleg: topp?.synleg === true,
        /** Sterkaste (lågaste) magnitude blant dei SYNLEGE lyspunkta. */
        sterkasteMagnitude: synlege.length
            ? Math.min(...synlege.map((l) => l.magnitude).filter(Number.isFinite))
            : null,
    };
}
