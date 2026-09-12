/**
 * js/utils/TurbinScenario.js
 *
 * «Kva om»-scenario for turbinstorleik på anlegg som ikkje er bygde enno.
 *
 * ===========================================================================
 * KVA DETTE SVARER PÅ
 * ===========================================================================
 * Turbinmåla appen viser for eit anlegg under handsaming er eit ESTIMAT
 * (CLAUDE.md §3), interpolert frå merkeeffekt mot ein tabell av reelle
 * turbinmodellar. Estimatet er kalibrert mot MEDIANEN i det som faktisk står
 * i norske anlegg i dag — men søknader i 2024–2026 ber ofte om vesentleg
 * større maskiner enn det (CLAUDE.md §4a). Spørsmålet «kva om dei bygger
 * 220 m i staden for 150 m?» kan i dag berre svarast ved å opne konsolldøra
 * og endre `turbine_specs_known.json` for hand. Dette gir brukaren same
 * spørsmål som eit verktøy i sidepanelet.
 *
 * ===========================================================================
 * SAME MØNSTER SOM TurbinJustering.js, MEN FOR STORLEIK I STADEN FOR POSISJON
 * ===========================================================================
 * Eit scenario er ein TREDJE kjeldekategori (`mal_kilde: 'kva_om'`), ikkje ei
 * overskriving av det opphavlege estimatet — akkurat som `brukerjustert` for
 * posisjon. Dei opphavlege måla vert verande på objektet (`opphavleg_*`),
 * idempotent på same vis: prøver brukaren tre ulike scenario på rad, peikar
 * nullstillinga framleis attende til APPENS FYRSTE estimat, ikkje det nest
 * siste scenarioet.
 *
 * Verktøyet lever berre i minnet, i denne sideøkta — same grunngjeving som
 * TurbinJustering.js: ei lagra brukargjetning om framtidig turbinstorleik ville
 * ikkje bety noko for cron-jobben som hentar ekte data frå NVE neste natt.
 *
 * ===========================================================================
 * GJELD HEILE ANLEGGET, IKKJE ÉIN TURBIN
 * ===========================================================================
 * Ein vindpark byggjer ikkje ulike turbinmodellar om kvarandre. Eit scenario
 * vald for éin turbin vert difor sett på ALLE turbinane i same anleggsnr —
 * `state.settKvaOmStorleik()` gjer nettopp det. Skilnaden frå posisjons-
 * justeringa (som råkar berre den eine turbinen brukaren drog) er tilsikta.
 */

/** Kva turbinmåla vart før eit scenario vart valt. */
export const KVA_OM_KILDE = 'kva_om';

/**
 * Statusar der turbinstorleiken framleis er open. Same sett som
 * `TurbineLayout.php` sitt statusfilter for estimert utplassering
 * (CLAUDE.md §12) — eit anlegg i drift eller under bygging har alt bestemt
 * kva som vert bygd; eit avslått eller nedlagt anlegg byggjer ingenting.
 */
export const PLANLAGT_STATUS = new Set([
    'under_behandling', 'konsesjon_gitt', 'konsesjon_ikke_bygd', 'under_bygging',
]);

/**
 * Eit vesle utval av referansepunkt frå SAME tabell som
 * `backend/services/TurbineSpec.php` sin `REFERENCE_MODELS` (CLAUDE.md §4a):
 * `[effekt_mw, nav_hoyde_m, rotor_diameter_m]`. Halde i synk FOR HAND, ikkje
 * generert — akkurat som `turbine_specs_known.json` (§4b). Endrar du tabellen
 * i TurbineSpec.php, hugs å oppdatere han her òg.
 *
 * Punkta under 3,6 MW er utelatne med vilje: eit «kva om»-scenario handlar om
 * å SJÅ FOR SEG ei større utbygging enn appens eige estimat, ikkje ei mindre —
 * appens estimat dekkjer allereie heile spennet nedover.
 */
export const STORLEIK_SCENARIO = [
    { mw: 3.60, nav: 87.0, rotor: 130.0 },
    { mw: 4.20, nav: 92.0, rotor: 136.0 },
    { mw: 5.60, nav: 105.0, rotor: 149.0 },
    { mw: 6.60, nav: 150.0, rotor: 170.0 },
    { mw: 7.20, nav: 160.0, rotor: 172.0 },
    { mw: 9.00, nav: 170.0, rotor: 175.0 },
];

/** @returns {boolean} Kan turbinstorleiken for dette anlegget prøvast som scenario? */
export function kanEndrastAvKvaOm(turbin) {
    return Boolean(turbin) && PLANLAGT_STATUS.has(turbin.status);
}

/** @returns {boolean} Viser desse måla eit «kva om»-scenario, ikkje appens eige estimat? */
export function erKvaOm(turbin) {
    return Boolean(turbin) && turbin.mal_kilde === KVA_OM_KILDE;
}

/**
 * L_WA frå merkeeffekt — SAME formel som `TurbineSpec::soundPower()` i PHP,
 * halden i synk manuelt (som tabellen over). Klemt til same [95, 108] dB som
 * der, av same grunn: modellen har ikkje dekning utanfor det spennet.
 */
function lydeffektFraEffekt(mw) {
    const lwa = 100 + 10 * Math.log10(mw);
    return Math.round(Math.min(108, Math.max(95, lwa)) * 10) / 10;
}

/**
 * Lag ein kopi av turbinen med hypotetisk storleik.
 *
 * @param {object} turbin
 * @param {{mw:number, nav:number, rotor:number}} scenario
 * @returns {object} Ny turbin (originalen vert ikkje endra)
 */
export function settKvaOmStorleik(turbin, scenario) {
    const opphavlegNav = turbin.opphavleg_nav_hoyde_m ?? turbin.nav_hoyde_m;
    const opphavlegRotor = turbin.opphavleg_rotor_diameter_m ?? turbin.rotor_diameter_m;
    const opphavlegTotal = turbin.opphavleg_totalhoyde_m ?? turbin.totalhoyde_m;
    const opphavlegEffekt = turbin.opphavleg_effekt_mw ?? turbin.effekt_mw;
    const opphavlegLydeffekt = turbin.opphavleg_lydeffekt_dba ?? turbin.lydeffekt_dba;
    const opphavlegMalKilde = turbin.opphavleg_mal_kilde ?? turbin.mal_kilde;

    return {
        ...turbin,
        nav_hoyde_m: scenario.nav,
        rotor_diameter_m: scenario.rotor,
        // Same uttrykk som TurbineSpec.php: vengetupp i høgaste stilling.
        totalhoyde_m: Math.round((scenario.nav + scenario.rotor / 2) * 10) / 10,
        effekt_mw: scenario.mw,
        lydeffekt_dba: lydeffektFraEffekt(scenario.mw),
        mal_kilde: KVA_OM_KILDE,
        opphavleg_nav_hoyde_m: opphavlegNav,
        opphavleg_rotor_diameter_m: opphavlegRotor,
        opphavleg_totalhoyde_m: opphavlegTotal,
        opphavleg_effekt_mw: opphavlegEffekt,
        opphavleg_lydeffekt_dba: opphavlegLydeffekt,
        opphavleg_mal_kilde: opphavlegMalKilde,
    };
}

/**
 * Set turbinmåla tilbake til appens eige estimat.
 *
 * @param {object} turbin
 * @returns {object} Turbin med opphavlege mål (uendra kopi om ikkje eit scenario er aktivt)
 */
export function tilbakestillKvaOmStorleik(turbin) {
    if (!erKvaOm(turbin)) return turbin;

    const ut = { ...turbin };
    ut.nav_hoyde_m = turbin.opphavleg_nav_hoyde_m;
    ut.rotor_diameter_m = turbin.opphavleg_rotor_diameter_m;
    ut.totalhoyde_m = turbin.opphavleg_totalhoyde_m;
    ut.effekt_mw = turbin.opphavleg_effekt_mw;
    ut.lydeffekt_dba = turbin.opphavleg_lydeffekt_dba;
    ut.mal_kilde = turbin.opphavleg_mal_kilde;
    delete ut.opphavleg_nav_hoyde_m;
    delete ut.opphavleg_rotor_diameter_m;
    delete ut.opphavleg_totalhoyde_m;
    delete ut.opphavleg_effekt_mw;
    delete ut.opphavleg_lydeffekt_dba;
    delete ut.opphavleg_mal_kilde;
    return ut;
}
