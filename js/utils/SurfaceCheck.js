/**
 * js/utils/SurfaceCheck.js
 *
 * DOM-KRYSSJEKK: kva skjer med synlegheita når skog og bygningar vert med?
 *
 * ===========================================================================
 * PROBLEMET
 * ===========================================================================
 * Heile appen reknar på `dtm1` — Kartverkets terrengmodell, altså BAR BAKKE.
 * Ein granskog på ryggen mellom deg og turbinen finst ikkje i den modellen.
 * Det gjer appen systematisk OPTIMISTISK på synlegheit, og det er den
 * avgrensinga som er nemnt flest stader i heile prosjektet (PLAN.md §7).
 *
 * Kartverket har òg `dom1`, ein OVERFLATEmodell frå same laserskanning, der
 * det laseren traff FØRST er høgda — trekrunene, hustaka, mastene. Skilnaden
 * mellom dei to er, i praksis, høgda på det som står på bakken:
 *
 *     Oslo (10,75 / 59,91):      DTM 2,74 m   DOM 9,63 m   → 6,9 m
 *     Storheia (10,14 / 63,84):  DTM 365,33 m DOM 365,35 m → 0,02 m
 *
 * ===========================================================================
 * KVIFOR NOKRE FÅ PUNKT, OG IKKJE HEILE PROFILEN
 * ===========================================================================
 * DOM kan ikkje hentast som profil. WPS-en som heile profilhentinga kviler
 * på tek ingen `datakilde`-parameter i det heile (verifisert mot
 * `DescribeProcess`), så DOM finst berre gjennom punkt-tenesta. Ein profil er
 * ~200 punkt per turbin; 150 turbinar ville vore 30 000 oppslag.
 *
 * Men me treng dei ikkje alle. Punkt-tenesta tek 50 koordinatar per kall, og
 * profilen kan rangerast: legg ein eit tenkt hinder på H meter på kvart
 * punkt, veks helninga med `H/d`. Dei punkta der eit hinder ville heve
 * horisonten MEST er difor kjende før noko som helst er slått opp. Sjå
 * `skannHorisontTopK()` i geo.js.
 *
 * Fyrste versjon slo opp EITT punkt: `synlegheit.kritiskPunkt`, det som gir
 * den høgaste skrapelinja på bar bakke. Det er rett punkt når terrenget sjølv
 * avgjer, men ikkje der eit hinder ville bety mest — eit punkt 60 m unna som
 * ligg langt under den bare skrapelinja treng berre 12 m skog for å slå ein
 * rygg 8 km ute. No vert difor det kritiske punktet slått opp SAMAN MED dei
 * `CONFIG.overflate.toppK` høgast rangerte kandidatane, og den høgaste
 * faktiske skrapelinja blant dei alle er svaret.
 *
 * ===========================================================================
 * SVARET ER EINSIDIG PÅLITELEG — OG DET MÅ SEIAST
 * ===========================================================================
 * DOM ≥ DTM overalt. Substitusjonen kan difor berre HEVE horisonten, aldri
 * senke han. Det gir ein presis, asymmetrisk garanti:
 *
 *   - Seier kryssjekken «skjult», er turbinen skjult (gitt laserdataen).
 *     Me har funne eit konkret hinder som er høgt nok.
 *   - Seier han «framleis synleg», er det IKKJE eit bevis. Skogen kan stå i
 *     eit anna punkt langs profilen — eit av dei me ikkje slo opp.
 *
 * Resultatet er altså framleis ei NEDRE GRENSE for skjermingsverknaden av
 * vegetasjon. Skilnaden topp-K gjer er at det no er leita der hinder KAN stå,
 * ikkje berre der terrenget alt skrapar.
 *
 * `restHelning` frå `skannHorisontTopK()` vert med ut som `restHorisontMoh`:
 * kor høgt eit hinder i eit av dei usjekka punkta kunne løfte horisonten. Det
 * er ei STRENG øvre grense, men ikkje ei stram ein — han er nesten alltid
 * dominert av eit nabopunkt til ein kandidat me faktisk MÅLTE, altså av same
 * knaus, og han er difor ikkje eit tal å vise fram i UI. Han står i dataa
 * fordi han er det einaste kvantifiserte svaret som finst på «kva er att», og
 * fordi ein seinare versjon kan skjerpe han. UI-et må framleis formulere
 * svaret som ei nedre grense, aldri som «då er du fri».
 */

import { CONFIG } from '../config.js';
import { hentOverflatehoyder } from '../api.js';
import { terrengHelning, skannHorisontTopK, horisontMohVedAvstand } from './geo.js';
import { vurderSynlegheit } from './ImpactCalculator.js';

/**
 * Klientcache: «lat,lon» → høgd (eller null for «ikkje målt»).
 *
 * Backenden cachar allereie permanent på fil, så dette sparar ikkje
 * Kartverket for noko — det sparar RUNDTUREN. Ein statusfilter-endring
 * reanalyserer heile punktet, og utan denne ville kvar slik endring sendt
 * tre nye HTTP-kall for tal me alt har i minnet.
 *
 * @type {Map<string, number|null>}
 */
const cache = new Map();

const nokkelFor = (lat, lon) => `${lat.toFixed(6)},${lon.toFixed(6)}`;

/** Tøm klientcachen. Berre til testbruk. */
export function tomOverflateCache() {
    cache.clear();
}

/**
 * Kan denne turbinen i det heile endre svar av ein DOM-sjekk?
 *
 * Tre grunnar til nei, og den tredje er den som sparer flest kall:
 *
 *  1. Ingen terrengprofil — då finst det ikkje noko kritisk punkt å slå opp.
 *  2. Ikkje analysert.
 *  3. **Allereie skjult av bar bakke.** Sidan DOM berre kan heve horisonten,
 *     kan ein turbin som er skjult utan skog aldri bli synleg MED skog.
 *     Svaret er kjent på førehand, og oppslaget ville vore bortkasta.
 */
export function kanEndrastAvOverflate(r) {
    return Boolean(
        r?.analysert
        && r.synlegheit?.kritiskPunkt
        && Number.isFinite(r.synlegheit.kritiskPunkt.d)
        && r.synlegheit.nokkel !== 'skjult',
    );
}

/** Turbinane ein DOM-sjekk faktisk vil slå opp, i den rekkjefølgja lista har. */
export function overflateKandidatar(resultat) {
    return (resultat ?? []).filter(kanEndrastAvOverflate);
}

/**
 * PUNKTA som skal slåast opp for ÉIN turbin: det kritiske terrengpunktet frå
 * bar bakke, pluss dei topp-K punkta der eit hinder ville bety mest.
 *
 * Det kritiske punktet står ALLTID fyrst, og alltid med — ikkje av
 * bakoverkompatibilitet, men fordi det er det einaste punktet me veit at
 * terrenget alt skrapar i. Det er òg det punktet profilgrafen teiknar, og
 * `felles`-feltene i resultatet fell tilbake på det når ingen kandidat gir
 * utslag.
 *
 * Er det ingen profil (turbinen kom inn utan høgdedata), er lista berre det
 * kritiske punktet — akkurat som før.
 *
 * @param {object} r
 * @returns {{punkt:object[], restHelning:number}}
 */
export function overflatePunktFor(r) {
    const kritisk = r?.synlegheit?.kritiskPunkt;
    if (!kritisk || !Number.isFinite(kritisk.d)) return { punkt: [], restHelning: -Infinity };

    const { kandidatar, restHelning } = skannHorisontTopK(
        r.profil, r.augeMoh, CONFIG.overflate.toppK,
        {
            hinderM: CONFIG.overflate.kandidatHinderM,
            minSkilnadM: CONFIG.overflate.minKandidatavstandM,
            minAvstandM: CONFIG.sikt.minHindringsavstandM,
            maksAvstandM: r.avstandM,
        },
    );

    /**
     * `toppK` er talet punkt som VERT SLÅTT OPP, det kritiske medrekna — ikkje
     * eit tillegg til det. Å telje slik gjer kostnaden direkte lesbar:
     * K turbinar · toppK punkt er taket på oppslaga, før dedup.
     *
     * Kandidatar som ikkje fekk plass fell ned i `rest`, saman med dei
     * skanninga alt la der. Uvissa som står att skal vere fullstendig — ho er
     * det einaste UI-et kan seie noko presist om når svaret er «framleis
     * synleg».
     */
    const punkt = [kritisk];
    const sett = new Set([nokkelFor(kritisk.lat, kritisk.lon)]);
    let rest = restHelning;
    for (const c of kandidatar) {
        const k = nokkelFor(c.punkt.lat, c.punkt.lon);
        if (sett.has(k)) continue;
        if (punkt.length >= CONFIG.overflate.toppK) {
            rest = Math.max(rest, c.helning);
            continue;
        }
        sett.add(k);
        punkt.push(c.punkt);
    }

    return { punkt, restHelning: rest };
}

/**
 * Rekn synlegheita om att med overflatehøgdene substituerte inn i dei
 * oppslåtte punkta. Rein funksjon — ingen nettverk, ingen tilstand.
 *
 * ==========================================================================
 * FRÅ EITT PUNKT TIL K PUNKT — SUBSTITUSJONEN ER FRAMLEIS EKSAKT
 * ==========================================================================
 * Den nye horisonten er per definisjon maksimum av `terrengHelning()` over
 * HEILE profilen. Punkta me ikkje slo opp står med DTM-høgda si, og deira
 * bidrag er nettopp den gamle helninga `gamal.horisontHelning`. Dei me slo
 * opp bidreg med den målte DOM-høgda si. Maksimum av dei to gruppene er difor
 * eksakt den horisonten desse dataa gir — ingen tilnærming, uansett K.
 *
 * `Math.max` mot den opphavlege helninga er ikkje pynt: DOM SKAL vere høgare
 * enn DTM, men dei to modellane er interpolerte kvar for seg, og eit avvik
 * andre vegen på nokre centimeter ville elles kunna gjort ein turbin MEIR
 * synleg av å ta med skogen. Horisonten kan berre gå oppover her.
 *
 * Det AVGJERANDE punktet — det som gir høgast skrapelinje etter
 * substitusjonen — er det som vert rapportert i `kritiskD`/`dtmZ`/`domZ` og
 * teikna i profilgrafen. Er det eit anna enn det bare terrenget peika ut, er
 * `fraToppK` sann; det er den direkte målinga av kva utvidinga er verdt.
 *
 * @param {object} r Resultatobjekt frå beregnPaaverknad()
 * @param {number|null|Array<{punkt:object, domZ:number|null}>} dom
 *        Anten overflatehøgda i det kritiske punktet åleine (den gamle
 *        forma, framleis gyldig), eller ei liste med punkt og målt høgd.
 * @param {object} [opts]
 * @param {number} [opts.restHelning] Høgaste hypotetiske helning blant punkta
 *        som IKKJE vart slått opp, frå `skannHorisontTopK()`.
 * @returns {object|null} `overflate`-objektet, eller null om det ikkje let seg rekne
 */
export function vurderMedOverflate(r, dom, opts = {}) {
    const kritisk = r?.synlegheit?.kritiskPunkt;
    if (!kritisk || !Number.isFinite(kritisk.d)) return null;

    const rader = Array.isArray(dom)
        ? dom.filter((x) => x?.punkt && Number.isFinite(x.punkt.d))
        : [{ punkt: kritisk, domZ: dom }];
    if (rader.length === 0) return null;

    /**
     * Éi rad per oppslått punkt, med den helninga akkurat det punktet gir.
     * Rekkjefølgja er den henta lista si — det kritiske punktet fyrst.
     */
    const kandidatar = rader.map(({ punkt, domZ }) => {
        const malt = Number.isFinite(domZ);
        const differanseM = malt ? domZ - punkt.z : null;
        return {
            d: punkt.d,
            lat: punkt.lat,
            lon: punkt.lon,
            terreng: punkt.terreng ?? null,
            dtmZ: punkt.z,
            domZ: malt ? domZ : null,
            differanseM,
            malt,
            vesentleg: malt && differanseM >= CONFIG.overflate.terskelM,
            helning: malt ? terrengHelning(punkt.d, domZ, r.augeMoh) : -Infinity,
            _punkt: punkt,
        };
    });

    /**
     * Det avgjerande punktet: høgast skrapelinje blant dei som faktisk har eit
     * hinder over terskelen. Finst ingen slik, fell alt tilbake på det
     * kritiske punktet — same tekst og same tal som før topp-K fanst.
     */
    const vesentlege = kandidatar.filter((c) => c.vesentleg);
    const beste = vesentlege.length > 0
        ? vesentlege.reduce((a, b) => (b.helning > a.helning ? b : a))
        : kandidatar[0];

    const restHorisontMoh = Number.isFinite(opts.restHelning)
        ? horisontMohVedAvstand(opts.restHelning, r.augeMoh, r.avstandM)
        : null;

    const felles = {
        datakilde: CONFIG.overflate.datakilde,
        malt: beste.malt,
        dtmZ: beste.dtmZ,
        domZ: beste.domZ,
        differanseM: beste.differanseM,
        terskelM: CONFIG.overflate.terskelM,
        kritiskD: beste.d,
        kritiskLat: beste.lat,
        kritiskLon: beste.lon,
        kritiskTerreng: beste.terreng,
        /** Alle oppslåtte punkt, til graf, panorama og feilsøking. */
        kandidatar: kandidatar.map(({ _punkt, ...rest }) => rest),
        talPunkt: kandidatar.length,
        talMalte: kandidatar.filter((c) => c.malt).length,
        /** Vart saka avgjord av eit anna punkt enn bar bakke peika ut? */
        fraToppK: beste.d !== kritisk.d,
        /**
         * Kor høgt eit 20 m hinder i eit av dei USJEKKA profilpunkta kunne
         * løfte horisonten ved turbinen. Uvissa som står att, som eit tal.
         */
        restHorisontMoh,
    };

    if (!vesentlege.length) {
        return {
            ...felles,
            vesentleg: false,
            synlegheit: null,
            endring: beste.malt ? 'uendra' : 'ukjent',
            mistarRotor: false,
        };
    }

    const gamal = r.synlegheit;
    const helning = Math.max(gamal.horisontHelning, beste.helning);

    const ny = vurderSynlegheit({
        helning,
        // Same punkt, men med overflatehøgda — slik at grafen og teksten kan
        // vise KVA høgd domen faktisk vart felt på.
        kritiskPunkt: { ...beste._punkt, z: beste.domZ, dtmZ: beste.dtmZ },
        augeMoh: r.augeMoh,
        avstandM: r.avstandM,
        basisMoh: r.basisMoh,
        navMoh: r.navMoh,
        tuppMoh: r.tuppMoh,
    });

    let endring = 'uendra';
    if (ny.nokkel === 'skjult' && gamal.nokkel !== 'skjult') {
        endring = 'skjult';
    } else if (ny.nokkel !== gamal.nokkel || ny.synlegDel < gamal.synlegDel - 0.01) {
        endring = 'redusert';
    }

    return {
        ...felles,
        vesentleg: true,
        synlegheit: ny,
        endring,
        mistarRotor: Boolean(gamal.navSynleg && !ny.navSynleg),
    };
}

/**
 * Køyr DOM-sjekken for eit resultatsett.
 *
 * =========================================================================
 * DETTE STEGET ER ALDRI EIN DEL AV HOVUDANALYSEN
 * =========================================================================
 * Hovudanalysen er den brukaren ventar på, og han skal ikkje bli tregare av
 * ein kryssjekk. Steget her køyrer difor berre når nokon ber om det: anten
 * knappen «Sjekk skog og bygningar» i samandraget (alle kandidatane), eller
 * ei detaljvising som opnast (den eine turbinen).
 *
 * Resultatet vert skrive rett på `r.overflate`, slik at panelet kan teikne
 * det ved sida av hovudtalet utan å halde eit parallelt register.
 *
 * @param {object} args
 * @param {object[]} args.resultat  Heile resultatlista (mutérast)
 * @param {(ferdig:number, totalt:number) => void} [args.paaFramdrift]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{sjekka:number, vesentlege:number, skjulte:number, reduserte:number,
 *                    umalte:number, kall:number, msBrukt:number}>}
 */
export async function sjekkOverflate({ resultat, paaFramdrift, signal }) {
    const start = performance.now();
    const kandidatar = overflateKandidatar(resultat);

    const stats = {
        sjekka: 0, vesentlege: 0, skjulte: 0, reduserte: 0,
        umalte: 0, kall: 0, msBrukt: 0,
        /** Unike koordinatar som faktisk vart henta over nett. */
        punkt: 0,
        /** Punkt topp-K-utvidinga ba om, før dedup og cache. */
        punktBedne: 0,
        /**
         * Turbinar der eit ANNA punkt enn det bare terrenget peika ut vart
         * avgjerande. Dette talet ER meirverdien av topp-K, målt.
         */
        toppKTreff: 0,
    };
    if (kandidatar.length === 0) {
        stats.msBrukt = Math.round(performance.now() - start);
        return stats;
    }

    /**
     * Punktlista per turbin, rekna éin gong. `skannHorisontTopK()` går
     * gjennom heile profilen (~200 punkt), og turbinlista kan vere 150 lang —
     * å rekne henne på nytt i påføringsløkka ville vore 30 000 unødige
     * gjennomgangar.
     */
    const planPerTurbin = new Map();
    const maaHentast = [];
    for (const r of kandidatar) {
        const plan = overflatePunktFor(r);
        planPerTurbin.set(r, plan);
        stats.punktBedne += plan.punkt.length;
        for (const p of plan.punkt) {
            if (!cache.has(nokkelFor(p.lat, p.lon))) maaHentast.push([p.lat, p.lon]);
        }
    }

    /**
     * Dei unike koordinatane, ikkje dei unike turbinane.
     *
     * To turbinar i same anlegg, sett frå same punkt, deler ofte nøyaktig
     * same kritiske terrengpunkt — det er den same ryggen som stengjer for
     * begge. På eit punkt med 40 turbinar i ei retning kan 40 oppslag krympe
     * til ei handfull. Med topp-K gjeld det same nærfeltspunkta: dei fyrste
     * hundre metrane er så godt som felles for alle turbinar i same retning.
     */
    const unike = [];
    const sett = new Set();
    for (const [lat, lon] of maaHentast) {
        const k = nokkelFor(lat, lon);
        if (sett.has(k)) continue;
        sett.add(k);
        unike.push([lat, lon]);
    }
    stats.punkt = unike.length;

    const bitar = [];
    for (let i = 0; i < unike.length; i += CONFIG.overflate.punktPerKall) {
        bitar.push(unike.slice(i, i + CONFIG.overflate.punktPerKall));
    }

    let ferdige = 0;
    const kø = [...bitar];
    const arbeidarar = Array.from(
        { length: Math.min(CONFIG.overflate.samtidigeKall, kø.length) },
        async () => {
            while (kø.length > 0) {
                if (signal?.aborted) throw new DOMException('Avbrote', 'AbortError');
                const bit = kø.shift();
                if (!bit) continue;
                try {
                    const svar = await hentOverflatehoyder(bit, CONFIG.overflate.datakilde, signal);
                    stats.kall++;
                    bit.forEach(([lat, lon], i) => {
                        const z = svar.hoyder?.[i];
                        cache.set(nokkelFor(lat, lon), Number.isFinite(z) ? z : null);
                    });
                } catch (e) {
                    if (e.name === 'AbortError') throw e;
                    stats.kall++;
                    /**
                     * Ein feilande bit skal ikkje velte kryssjekken. Punkta
                     * vert IKKJE cacha som null — då ville eit forbigåande
                     * nettverksbrot blitt til ein permanent «ikkje målt» for
                     * resten av økta. Dei vert ståande ukjende, og eit nytt
                     * forsøk hentar dei på nytt.
                     */
                    console.warn('DOM-batch feila, held fram:', e.message);
                }
                ferdige += bit.length;
                paaFramdrift?.(Math.min(ferdige, unike.length), unike.length);
            }
        },
    );
    await Promise.all(arbeidarar);

    for (const r of kandidatar) {
        const plan = planPerTurbin.get(r);
        if (!plan || plan.punkt.length === 0) continue;

        /**
         * Ein bit kan ha feila. Det kritiske punktet er det einaste som MÅ
         * vere der — utan det er svaret ikkje samanliknbart med den gamle
         * eittpunktsversjonen, og turbinen står heller usjekka. Manglar ein
         * av topp-K-kandidatane, held me fram med dei me har: horisonten vert
         * då berre ei litt svakare nedre grense, som er heile premissen.
         */
        const rader = plan.punkt
            .filter((p) => cache.has(nokkelFor(p.lat, p.lon)))
            .map((p) => ({ punkt: p, domZ: cache.get(nokkelFor(p.lat, p.lon)) }));
        if (rader.length === 0 || rader[0].punkt !== plan.punkt[0]) continue;

        const o = vurderMedOverflate(r, rader, { restHelning: plan.restHelning });
        if (!o) continue;
        r.overflate = o;

        stats.sjekka++;
        if (!o.malt) stats.umalte++;
        if (o.vesentleg) stats.vesentlege++;
        if (o.endring === 'skjult') stats.skjulte++;
        if (o.endring === 'redusert') stats.reduserte++;
        if (o.vesentleg && o.fraToppK) stats.toppKTreff++;
    }

    stats.msBrukt = Math.round(performance.now() - start);
    return stats;
}

/**
 * Samandrag over ei ferdig sjekka liste.
 *
 * Reknar over HEILE lista, ikkje berre over kandidatane, slik at
 * «uaktuelle» (allereie skjulte av bar bakke) kan namngjevast i UI i staden
 * for å blande seg inn i «ingen endring».
 */
export function overflateSamandrag(resultat) {
    const alle = resultat ?? [];
    const analyserte = alle.filter((r) => r.analysert);
    const kandidatar = analyserte.filter(kanEndrastAvOverflate);
    const sjekka = kandidatar.filter((r) => r.overflate);

    return {
        kandidatar: kandidatar.length,
        sjekka: sjekka.length,
        ferdig: kandidatar.length > 0 && sjekka.length === kandidatar.length,
        alleredeSkjulte: analyserte.length - kandidatar.length,
        vesentlege: sjekka.filter((r) => r.overflate.vesentleg).length,
        skjulte: sjekka.filter((r) => r.overflate.endring === 'skjult').length,
        reduserte: sjekka.filter((r) => r.overflate.endring === 'redusert').length,
        mistarRotor: sjekka.filter((r) => r.overflate.mistarRotor).length,
        umalte: sjekka.filter((r) => !r.overflate.malt).length,
        /**
         * Turbinar der utslaget kom frå eit anna punkt enn det bare terrenget
         * peika ut. Med den gamle eittpunktssjekken ville desse stått som
         * «ingen endring» — talet er difor eit direkte mål på kva topp-K
         * faktisk fangar, ikkje eit anslag.
         */
        fraToppK: sjekka.filter((r) => r.overflate.vesentleg && r.overflate.fraToppK).length,
        /**
         * Turbinar der DOM-hinderet står HEILT INNTIL punktet (< 300 m).
         *
         * Topp-K gjer dette til normalen, ikkje unntaket: tillegget eit hinder
         * gir helninga er `H/d`, så nærfeltet vinn rangeringa nesten alltid.
         * Verifisert på Odal — ein turbin 8,6 km unna som er 99 % synleg på
         * bar bakke vart heilt skjult av 6,5 m vegetasjon 30 m frå
         * observatøren. Det er fysisk rett, og samstundes ekstremt følsamt for
         * kvar brukaren klikka. Same atterhald som `naerskjerming` i
         * hovudmodellen (CLAUDE.md §7b) MÅ difor følgje dette talet.
         */
        naerskjerma: sjekka.filter((r) => r.overflate.synlegheit?.naerskjerming).length,
        /** Kor mange punkt per turbin sjekken faktisk såg på (typisk verdi). */
        punktPerTurbin: sjekka.length > 0
            ? Math.round(sjekka.reduce((s, r) => s + (r.overflate.talPunkt ?? 1), 0) / sjekka.length)
            : 0,
        // Høgaste målte hinder over bakken — det konkrete talet som gjer
        // «skog» til noko anna enn eit ord.
        stersteHinderM: sjekka.reduce(
            (m, r) => (Number.isFinite(r.overflate.differanseM) && r.overflate.differanseM > m
                ? r.overflate.differanseM : m),
            0,
        ),
    };
}
