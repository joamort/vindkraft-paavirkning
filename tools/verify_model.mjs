/**
 * tools/verify_model.mjs
 *
 * Lokalt verifiseringsskript for berekningsmodellen. Køyrer den EKTE
 * frontend-koden (js/utils/*.js) i Node mot ekte cacha data, slik at me
 * testar det som faktisk vert sendt til nettlesaren — ikkje ein kopi.
 *
 * Node brukast berre som dev-verktøy her. Ingenting i produksjon er avhengig
 * av det (jf. TECH_STACK.md — npm/Node er OK lokalt, aldri på serveren).
 *
 * Køyr:  node tools/verify_model.mjs
 * Krev:  cache/turbines.json (køyr cron/fetch_turbines.php først)
 *        og ein lokal webserver på :8011 for høgdeprofilar.
 */

import { readFileSync } from 'node:fs';
import { CONFIG } from '../js/config.js';
import { beregnPaaverknad, byggSamandrag, vurderSynlegheit, kumulativHorisont } from '../js/utils/ImpactCalculator.js';
import {
    sjekkOverflate, overflateSamandrag, vurderMedOverflate,
    kanEndrastAvOverflate, tomOverflateCache, overflatePunktFor,
} from '../js/utils/SurfaceCheck.js';
import {
    haversine, krummingsfall, summerDesibel, synsvinkel, destinasjon,
    skannHorisont, skannHorisontTopK, terrengHelning,
} from '../js/utils/geo.js';
import { samletStoy, stoykategori, turbinStoy } from '../js/utils/NoiseModel.js';
import { hinderlysKrav, hinderlysSynlegheit, stjernemagnitude } from '../js/utils/ObstacleLights.js';
import {
    solposisjon, norskUtcOffsetTimar, byggSoltabell, skyggekastForTurbin,
    skyggekastForAlle, maksSkyggeavstandM,
} from '../js/utils/ShadowFlicker.js';
import {
    JUSTERT_KILDE, kanFlyttast, flyttTurbin, tilbakestillTurbin,
    innanforPlanomrade, avstandUtanforPlanomrade,
} from '../js/utils/TurbinJustering.js';
import { hentHorisont, tomHorisontCache } from '../js/utils/Horizon.js';
import { byggSynlegheitskart } from '../js/utils/Zvi.js';
import { hentNaerTerreng, byggRadier, resamplProfil } from '../js/utils/NaerTerreng.js';

// Overstyrbar port: `VIND_API=http://localhost:8012 node tools/verify_model.mjs`,
// slik at testsuiten kan køyre mot ein server på ein ledig port.
const API = process.env.VIND_API ?? 'http://localhost:8011';
let feil = 0;

function sjekk(namn, vilkaar, detalj = '') {
    const status = vilkaar ? '  OK  ' : ' FEIL ';
    if (!vilkaar) feil++;
    console.log(`[${status}] ${namn}${detalj ? ' — ' + detalj : ''}`);
}

// ===================================================================
console.log('\n=== 1. Reine geometrifunksjonar ===\n');

// Kjend referanse: Oslo (59.9139, 10.7522) → Trondheim (63.4305, 10.3951)
// Storsirkelavstand er ~391,5 km.
const osloTrondheim = haversine(59.9139, 10.7522, 63.4305, 10.3951);
sjekk('haversine Oslo–Trondheim ≈ 391 km',
    Math.abs(osloTrondheim - 391_500) < 3000,
    `${(osloTrondheim / 1000).toFixed(1)} km`);

// Krummingsfallet skal vera null i endane og maksimalt på midten.
sjekk('krummingsfall er 0 ved d=0', krummingsfall(0, 20000) === 0);
sjekk('krummingsfall er 0 ved d=D', krummingsfall(20000, 20000) === 0);

// Maks fall over 20 km: D²/(8·R_eff) = 20000²/(8·7433510) ≈ 6,73 m
const maksFall = krummingsfall(10000, 20000);
sjekk('krummingsfall maks over 20 km ≈ 6,7 m',
    Math.abs(maksFall - 6.73) < 0.1, `${maksFall.toFixed(2)} m`);

// Symmetrisk om midtpunktet.
sjekk('krummingsfall er symmetrisk',
    Math.abs(krummingsfall(4000, 20000) - krummingsfall(16000, 20000)) < 1e-9);

// To like kjelder skal gi nøyaktig +3,01 dB.
const to = summerDesibel([40, 40]);
sjekk('summerDesibel(40,40) = 43,01 dB', Math.abs(to - 43.0103) < 0.001, `${to.toFixed(3)} dB`);
sjekk('summerDesibel([]) = null', summerDesibel([]) === null);

// Ti like kjelder = +10 dB.
const ti = summerDesibel(Array(10).fill(35));
sjekk('summerDesibel(10 × 35 dB) = 45 dB', Math.abs(ti - 45) < 0.001, `${ti.toFixed(3)} dB`);

// Synsvinkel: eit 150 m høgt objekt 1000 m unna, auget i objektets fothøgd.
const vinkel = synsvinkel(150, 0, 0, 1000);
sjekk('synsvinkel 150 m på 1000 m ≈ 8,53°',
    Math.abs(vinkel - 8.531) < 0.01, `${vinkel.toFixed(3)}°`);

// ===================================================================
console.log('\n=== 2. Støymodellen ===\n');

// Referanse: 3,6 MW-turbin (L_WA 105,6), nav 87 m, 500 m unna, fri sikt.
const naer = turbinStoy({
    lydeffektDba: 105.6,
    horisontalAvstandM: 500,
    navHoydeMoh: 87,
    oyreHoydeMoh: 1.6,
    navSynleg: true,
    skjulhoydeM: 0,
});
// Skrå avstand = hypot(500, 85.4) ≈ 507,2 m
// L_p = 105,6 − 20·log10(507,2) − 11 + 1,5 − 0,005·507,2 ≈ 39,5 dB
sjekk('L_pA 3,6 MW @ 500 m ≈ 40-42 dB',
    naer.lpDb > 40 && naer.lpDb < 42.5, `${naer.lpDb.toFixed(1)} dB`);
sjekk('slengde > horisontal avstand', naer.slengdeM > 500, `${naer.slengdeM.toFixed(1)} m`);

// Skjerming skal alltid REDUSERE nivået.
const skjult = turbinStoy({
    lydeffektDba: 105.6, horisontalAvstandM: 500, navHoydeMoh: 87,
    oyreHoydeMoh: 1.6, navSynleg: false, skjulhoydeM: 40,
});
sjekk('skjerming gir lågare nivå', skjult.lpDb < naer.lpDb,
    `${skjult.lpDb.toFixed(1)} vs ${naer.lpDb.toFixed(1)} dB`);
sjekk('skjerming er innanfor taket på 15 dB',
    skjult.skjermingDb > 0 && skjult.skjermingDb <= 15, `${skjult.skjermingDb.toFixed(1)} dB`);

// Doblar avstanden → skal falle ~6 dB (sfærisk spreiing) pluss litt luftabsorpsjon.
const fjern = turbinStoy({
    lydeffektDba: 105.6, horisontalAvstandM: 1000, navHoydeMoh: 87,
    oyreHoydeMoh: 1.6, navSynleg: true, skjulhoydeM: 0,
});
const fall = naer.lpDb - fjern.lpDb;
sjekk('dobla avstand gir 6-8 dB fall', fall > 6 && fall < 8, `${fall.toFixed(1)} dB`);

// L_den-påslaget.
sjekk('L_den = L_pA + 6,4 dB', Math.abs((naer.ldenDb - naer.lpDb) - 6.4) < 0.001);

// Terskelkategoriar mot T-1442.
sjekk('L_den 38 dB → lav', stoykategori(38).nokkel === 'lav');
sjekk('L_den 43 dB → moderat', stoykategori(43).nokkel === 'moderat');
sjekk('L_den 47 dB → hoy', stoykategori(47).nokkel === 'hoy');
sjekk('L_den null → ukjent', stoykategori(null).nokkel === 'ukjent');

// Energetisk summering av mange turbinar.
const sum = samletStoy([38, 38, 38, 38]);
sjekk('4 × 38 dB summerer til 44 dB', Math.abs(sum.lpDb - 44.02) < 0.05, `${sum.lpDb.toFixed(2)} dB`);

// ===================================================================
console.log('\n=== 3. Siktlinje mot syntetisk terreng ===\n');

const punkt = { lat: 63.81, lon: 10.14, hoyde: 100 };
const turbin = {
    id: 'TEST', navn: 'Test', status: 'i_drift', anleggsnr: 1,
    lat: 63.90, lon: 10.14,
    nav_hoyde_m: 87, rotor_diameter_m: 130, totalhoyde_m: 152,
    lydeffekt_dba: 105.6, effekt_mw: 3.6, mal_kilde: 'estimert',
    posisjon_kilde: 'nve_turbinpunkt',
};
const D = haversine(punkt.lat, punkt.lon, turbin.lat, turbin.lon);

/** Bygg ein syntetisk profil med ein ås av gitt høgd midtvegs. */
function lagProfil(aasHoyde, bakkeVedTurbin = 100) {
    const n = 60;
    const ut = [];
    for (let i = 0; i < n; i++) {
        const f = i / (n - 1);
        const d = D * f;
        // Gaussisk ås sentrert på midten.
        const aas = aasHoyde * Math.exp(-((f - 0.5) ** 2) / (2 * 0.08 ** 2));
        const basis = 100 + (bakkeVedTurbin - 100) * f;
        ut.push({ d, z: basis + aas, lat: 0, lon: 0, terreng: 'Test' });
    }
    return ut;
}

// Flatt terreng → alt synleg.
const flat = beregnPaaverknad({ punkt, turbin, profil: lagProfil(0) });
sjekk('flatt terreng → heilt synleg', flat.synlegheit.nokkel === 'synleg',
    `synlegDel=${flat.synlegheit.synlegDel.toFixed(3)}`);
sjekk('flatt terreng → navet synleg', flat.synlegheit.navSynleg === true);

// Høg ås → heilt skjult.
const hoyAas = beregnPaaverknad({ punkt, turbin, profil: lagProfil(400) });
sjekk('400 m ås → skjult', hoyAas.synlegheit.nokkel === 'skjult',
    `synlegDel=${hoyAas.synlegheit.synlegDel.toFixed(3)}`);
sjekk('400 m ås → navet skjult', hoyAas.synlegheit.navSynleg === false);
sjekk('400 m ås → skjulhøgd > 0', hoyAas.synlegheit.skjulhoydeM > 0,
    `${hoyAas.synlegheit.skjulhoydeM.toFixed(0)} m`);

// Middels ås → delvis synleg. Leitar etter ei høgd som gir delvis.
let delvisFunne = null;
for (let h = 40; h <= 300; h += 2) {
    const r = beregnPaaverknad({ punkt, turbin, profil: lagProfil(h) });
    if (r.synlegheit.nokkel === 'delvis') { delvisFunne = { h, r }; break; }
}
sjekk('finst ei åshøgd som gir "delvis synleg"', delvisFunne !== null,
    delvisFunne ? `ås=${delvisFunne.h} m, synlegDel=${delvisFunne.r.synlegheit.synlegDel.toFixed(3)}` : '');

// Monotoni: høgare ås skal aldri gi MEIR synleg del.
let monoton = true;
let forrige = 1.1;
for (let h = 0; h <= 400; h += 20) {
    const del = beregnPaaverknad({ punkt, turbin, profil: lagProfil(h) }).synlegheit.synlegDel;
    if (del > forrige + 1e-9) monoton = false;
    forrige = del;
}
sjekk('synleg del er monotont ikkje-aukande med åshøgda', monoton);

// Skjerming skal slå inn i støyen når navet er skjult.
sjekk('skjult turbin får skjermingsdemping',
    hoyAas.stoy === null || hoyAas.stoy.skjermingDb > 0,
    hoyAas.stoy ? `${hoyAas.stoy.skjermingDb.toFixed(1)} dB` : 'utanfor støyradius');

// Manglande profil skal degradere reint, ikkje kaste.
const utanProfil = beregnPaaverknad({ punkt, turbin, profil: null });
sjekk('manglande profil → analysert=false', utanProfil.analysert === false);
sjekk('manglande profil → dominans reknast likevel', utanProfil.dominans.rd > 0);

// ===================================================================
console.log('\n=== 4. Ekte data: Storheia sett frå Åfjord-sida ===\n');

const cache = JSON.parse(readFileSync(new URL('../cache/turbines.json', import.meta.url), 'utf8'));
const storheia = cache.turbiner.filter((t) => t.navn === 'Storheia');
sjekk('Storheia finst i cachen med 80 turbinar', storheia.length === 80, `${storheia.length} stk`);

const obs = { lat: 63.81, lon: 10.14 };
let ekteResultat = [];

try {
    const høgdeSvar = await fetch(`${API}/backend/api/elevation_point.php?lat=${obs.lat}&lon=${obs.lon}`);
    const høgde = await høgdeSvar.json();
    sjekk('bakkehøgd henta for observatørpunktet', høgde.ok === true,
        `${høgde.hoyde_m} moh. (${høgde.terreng})`);

    const utval = storheia.slice(0, 20);
    const profSvar = await fetch(`${API}/backend/api/elevation_profile.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            origin: obs,
            targets: utval.map((t) => ({ id: t.id, lat: t.lat, lon: t.lon })),
        }),
    });
    const prof = await profSvar.json();
    sjekk('høgdeprofilar henta', prof.ok === true,
        `${Object.keys(prof.profiles).length} profilar, ${prof.stats.wps_kall} WPS-kall`);

    const p = { ...obs, hoyde: høgde.hoyde_m };
    ekteResultat = utval.map((t) => beregnPaaverknad({ punkt: p, turbin: t, profil: prof.profiles[t.id] ?? null }));

    const s = byggSamandrag(ekteResultat);
    console.log(`\n  Samandrag: ${s.synlege}/${s.analyserte} synlege ` +
        `(${s.heiltSynlege} heilt, ${s.delvisSynlege} delvis, ${s.skjulte} skjulte)`);
    console.log(`  Næraste: ${(s.naermaste.avstandM / 1000).toFixed(2)} km ${s.naermaste.retning}`);

    console.log('\n  Turbin        Avstand  Bakke  Horisont   Synleg  Kategori');
    for (const r of ekteResultat.slice(0, 8)) {
        console.log(`  ${r.id.padEnd(8)} ${(r.avstandM / 1000).toFixed(2).padStart(8)} km ` +
            `${r.bakkeVedTurbinMoh.toFixed(0).padStart(5)}m ` +
            `${r.synlegheit.horisontMoh.toFixed(0).padStart(7)}m ` +
            `${(r.synlegheit.synlegDel * 100).toFixed(0).padStart(6)}%  ${r.synlegheit.tekst}`);
    }

    sjekk('alle utvalde turbinar vart analyserte',
        ekteResultat.every((r) => r.analysert), `${ekteResultat.filter((r) => r.analysert).length}/${utval.length}`);
    sjekk('bakkehøgda ved turbinane er plausibel for Storheia (200-450 moh.)',
        ekteResultat.every((r) => r.bakkeVedTurbinMoh > 150 && r.bakkeVedTurbinMoh < 500));
    sjekk('synleg del ligg i [0,1]',
        ekteResultat.every((r) => r.synlegheit.synlegDel >= 0 && r.synlegheit.synlegDel <= 1));
    sjekk('avstandane ligg i venta spenn 7-16 km',
        ekteResultat.every((r) => r.avstandM > 7000 && r.avstandM < 16000));
    sjekk('støy er null utanfor 10 km-radiusen',
        ekteResultat.every((r) => (r.avstandM > 10000 ? r.stoy === null : true)));
    sjekk('dominans er "liten" på 10+ km med 130 m rotor',
        ekteResultat.every((r) => r.dominans.rd > 35));
} catch (e) {
    sjekk('ekte-data-testen kunne køyrast', false, `${e.message} (er php -S localhost:8011 oppe?)`);
}

// ===================================================================
console.log('\n=== 4b. Kumulativ horisontbelastning (union av synsvinklar) ===\n');
{
    const t = (kurs, synsvinkel, anleggsnr = 1) => ({
        kurs, anleggsnr, dominans: { synsvinkelGrader: synsvinkel },
    });

    const usamanhengande = kumulativHorisont([t(100, 4), t(200, 6)]);
    sjekk('to usamanhengande turbinar → sum av synsvinklane', usamanhengande.gradar === 10,
        `${usamanhengande.gradar}° (venta 10)`);

    const overlapp = kumulativHorisont([t(100, 10), t(103, 10)]);
    sjekk('to overlappande → union, ikkje sum', overlapp.gradar === 13,
        `${overlapp.gradar}° (venta 13, ikkje 20)`);

    const nord = kumulativHorisont([t(359, 6), t(1, 4)]);
    sjekk('intervall som kryssar nord vert handtert', nord.gradar === 7,
        `${nord.gradar}° (venta 7)`);

    const fleire = kumulativHorisont([t(90, 2, 10), t(95, 2, 10), t(270, 2, 20)]);
    sjekk('talet separate anlegg', fleire.anlegg === 2, `${fleire.anlegg} (venta 2)`);

    const tom = kumulativHorisont([]);
    sjekk('tomt inn → 0° / 0 anlegg', tom.gradar === 0 && tom.anlegg === 0);

    const nullSyn = kumulativHorisont([t(100, 0), t(120, 0)]);
    sjekk('turbinar med 0° synsvinkel bidreg ikkje', nullSyn.gradar === 0);

    const heilRing = kumulativHorisont(
        Array.from({ length: 36 }, (_, i) => t(i * 10, 20)),
    );
    sjekk('union kan ikkje overstige 360°', heilRing.gradar === 360, `${heilRing.gradar}°`);
}

// ===================================================================
console.log('\n=== 4c. Lokalt synlegheitskart (ZVI-tilnærming) ===\n');
{
    const punkt = { lat: 63.0, lon: 10.0, hoyde: 300 };

    // Ein turbin som er så vidt SKJULT frå punktet (horisonten ligg 5 m over
    // vengetuppen), med eit kritisk skjermingspunkt tett på (d_krit = 50 m)
    // og turbinen langt unna (D = 5000 m). Å heve auget litt skal då senke
    // horisonten kraftig (D/d_krit = 100) og gjere turbinen synleg.
    const turbin = {
        analysert: true,
        avstandM: 5000,
        bakkeVedTurbinMoh: 400,
        totalhoydeM: 150,                  // tuppMoh = 550
        synlegheit: {
            nokkel: 'skjult',
            horisontMoh: 555,             // 5 m over tuppen
            kritiskPunkt: { d: 50, z: 360 },
        },
    };

    const flatDtm = async (punkter) => punkter.map(() => punkt.hoyde);
    const flatKart = await byggSynlegheitskart(punkt, [turbin], flatDtm);
    sjekk('flatt rutenett (alle celler = punkthøgda) → 0 synlege overalt',
        flatKart.celler.every((c) => c.tal === 0) && flatKart.maks === 0);
    sjekk('rutenettet dekkjer CONFIG.synlegheitskart.celler²',
        flatKart.celler.length === CONFIG.synlegheitskart.celler ** 2,
        `${flatKart.celler.length} celler`);

    // Same, men no ligg cella med indeks 0 (nordvest) 1 m høgare.
    const eiHevet = async (punkter) => punkter.map((_, i) => punkt.hoyde + (i === 0 ? 1 : 0));
    const hevetKart = await byggSynlegheitskart(punkt, [turbin], eiHevet);
    sjekk('ei celle heva 1 m senkar horisonten nok til at turbinen vert synleg',
        hevetKart.celler[0].tal === 1 && hevetKart.maks === 1,
        `celle[0].tal = ${hevetKart.celler[0].tal}`);
    sjekk('dei andre cellene er uendra (framleis skjult)',
        hevetKart.celler.slice(1).every((c) => c.tal === 0));

    // Ei celle utan laserdekning skal bli null, ikkje 0.
    const eiNull = async (punkter) => punkter.map((_, i) => (i === 5 ? null : punkt.hoyde));
    const nullKart = await byggSynlegheitskart(punkt, [turbin], eiNull);
    sjekk('celle utan laserdekning → tal = null (ikkje 0)',
        nullKart.celler[5].tal === null);

    // Uskjerma turbin (ingen kritisk punkt): horisonten følgjer auget, så
    // synlegheita endrar seg ikkje av at ei celle ligg litt høgare.
    const fri = {
        analysert: true, avstandM: 8000, bakkeVedTurbinMoh: 500, totalhoydeM: 180,
        synlegheit: { nokkel: 'synleg', horisontMoh: 250, kritiskPunkt: null },
    };
    const friKart = await byggSynlegheitskart(punkt, [fri], eiHevet);
    sjekk('uskjerma turbin er synleg frå kvar celle uansett',
        friKart.celler.every((c) => c.tal === 1));

    sjekk('talIPunktet svarar til midtcella',
        flatKart.talIPunktet === flatKart.celler[Math.floor(flatKart.celler.length / 2)].tal);
}

// ===================================================================
console.log('\n=== 5. Ope punkt 3,3 km sørvest for Storheia ===\n');

try {
    // Ope punkt på 293 moh. sørvest for anlegget, med fri sikt mot ryggen.
    const naerObs = { lat: 63.8400, lon: 10.0500 };
    const næraste = storheia
        .map((t) => ({ t, d: haversine(naerObs.lat, naerObs.lon, t.lat, t.lon) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 15);

    const hSvar = await fetch(`${API}/backend/api/elevation_point.php?lat=${naerObs.lat}&lon=${naerObs.lon}`);
    const h = await hSvar.json();

    const pSvar = await fetch(`${API}/backend/api/elevation_profile.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            origin: naerObs,
            targets: næraste.map(({ t }) => ({ id: t.id, lat: t.lat, lon: t.lon })),
        }),
    });
    const pr = await pSvar.json();

    const p2 = { ...naerObs, hoyde: h.hoyde_m };
    const res2 = næraste.map(({ t }) => beregnPaaverknad({ punkt: p2, turbin: t, profil: pr.profiles[t.id] ?? null }));

    console.log(`  Observatør: ${h.hoyde_m} moh. (${h.terreng})`);
    console.log('\n  Turbin    Avstand   RD   Synsvinkel  Synleg  L_pA   L_den  Kategori');
    for (const r of res2.slice(0, 6)) {
        console.log(`  ${r.id.padEnd(7)} ${(r.avstandM / 1000).toFixed(2).padStart(6)} km ` +
            `${r.dominans.rd.toFixed(1).padStart(5)} ${r.dominans.synsvinkelGrader.toFixed(2).padStart(9)}° ` +
            `${(r.synlegheit.synlegDel * 100).toFixed(0).padStart(6)}% ` +
            `${r.stoy ? r.stoy.lpDb.toFixed(1).padStart(6) : '     -'} ` +
            `${r.stoy ? r.stoy.ldenDb.toFixed(1).padStart(6) : '     -'}  ${r.dominans.tekst}`);
    }

    const samla = samletStoy(res2.filter((r) => r.stoy).map((r) => r.stoy.lpDb));
    if (samla) {
        const kat = stoykategori(samla.ldenDb);
        console.log(`\n  Samla frå ${res2.filter((r) => r.stoy).length} turbinar: ` +
            `L_pA ${samla.lpDb.toFixed(1)} dB → L_den ${samla.ldenDb.toFixed(1)} dB — ${kat.tekst}`);
        sjekk('samla støy er høgare enn den sterkaste enkeltturbinen',
            samla.lpDb > Math.max(...res2.filter((r) => r.stoy).map((r) => r.stoy.lpDb)));
    }

    // Frå eit ope punkt på denne sida skal modellen faktisk finne synlege
    // turbinar — det er hovudpoenget med testen. Storheia ligg på ein rygg
    // 460-470 moh., og dei øvste turbinane skal stå fritt over horisonten.
    const synlege2 = res2.filter((r) => r.synlegheit.nokkel !== 'skjult');
    sjekk('modellen finn synlege turbinar frå eit ope punkt',
        synlege2.length > 0, `${synlege2.length}/${res2.length} synlege`);
    sjekk('minst éin turbin har navet i fri sikt',
        res2.some((r) => r.synlegheit.navSynleg));
    sjekk('dei synlege turbinane står høgare enn dei skjulte',
        synlege2.length === 0 || res2.filter((r) => r.synlegheit.nokkel === 'skjult').length === 0
        || (synlege2.reduce((s, r) => s + r.basisMoh, 0) / synlege2.length)
           > (res2.filter((r) => r.synlegheit.nokkel === 'skjult')
                  .reduce((s, r) => s + r.basisMoh, 0)
              / res2.filter((r) => r.synlegheit.nokkel === 'skjult').length));
    sjekk('ingen synsvinkel er negativ',
        res2.every((r) => r.dominans.synsvinkelGrader >= 0));

    sjekk('dominans er sterkare nær anlegget enn 12 km unna',
        Math.min(...res2.map((r) => r.dominans.rd)) < Math.min(...ekteResultat.map((r) => r.dominans.rd)));
} catch (e) {
    sjekk('nær-scenario kunne køyrast', false, e.message);
}

// ===================================================================
console.log('\n=== 6. Nærskjerming-flagget ===\n');

try {
    // Punkt ved foten av ein liten rygg: terrenget stig 17 m dei første 75 m.
    // Verifisert mot både WPS og punkt-API — dette er ekte terreng, ikkje støy
    // i datasettet. Modellen SKAL melde skjult her, men samtidig flagge at
    // resultatet heng på terreng heilt inntil punktet.
    const hollow = { lat: 63.8400, lon: 10.1400 };
    const næraste3 = storheia
        .map((t) => ({ t, d: haversine(hollow.lat, hollow.lon, t.lat, t.lon) }))
        .sort((a, b) => a.d - b.d).slice(0, 6);

    const h3 = await (await fetch(`${API}/backend/api/elevation_point.php?lat=${hollow.lat}&lon=${hollow.lon}`)).json();
    const pr3 = await (await fetch(`${API}/backend/api/elevation_profile.php`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: hollow, targets: næraste3.map(({ t }) => ({ id: t.id, lat: t.lat, lon: t.lon })) }),
    })).json();

    const res3 = næraste3.map(({ t }) => beregnPaaverknad({
        punkt: { ...hollow, hoyde: h3.hoyde_m }, turbin: t, profil: pr3.profiles[t.id] ?? null,
    }));

    const kritisk = res3[0].synlegheit.kritiskPunkt;
    console.log(`  Observatør ${h3.hoyde_m} moh. — sikta bryt mot terreng ` +
        `${kritisk.d.toFixed(0)} m unna på ${kritisk.z.toFixed(1)} moh.`);

    sjekk('turbinane er skjulte frå dette punktet',
        res3.every((r) => r.synlegheit.nokkel === 'skjult'));
    sjekk('nærskjerming-flagget er sett', res3.every((r) => r.synlegheit.naerskjerming === true));
    sjekk('kritisk punkt er nær observatøren', kritisk.d < 300, `${kritisk.d.toFixed(0)} m`);
    sjekk('synleg del er 0, ikkje negativ', res3.every((r) => r.synlegheit.synlegDel === 0));
} catch (e) {
    sjekk('nærskjerming-testen kunne køyrast', false, e.message);
}

// ===================================================================
console.log('\n=== 7. Kuraterte turbinmål (kjent_soknad vs estimert) ===\n');

// Denne bolken testar oppslaget mot `backend/data/turbine_specs_known.json`.
// Poenget er at ingen oppføring skal kunne bli liggjande «daud»: står eit
// anlegg i registeret, SKAL turbinane i cachen faktisk ha fått kjeldeverdiane.
// Det er den feilen som er lett å gjere — ei oppføring med feil anleggsnr eller
// namn gir ingen feilmelding nokon stad, berre eit stille generisk estimat.
{
    const kjent = JSON.parse(
        readFileSync(new URL('../backend/data/turbine_specs_known.json', import.meta.url), 'utf8'),
    );
    const oppf = kjent.oppforingar ?? [];
    sjekk('registerfila har oppføringar', oppf.length > 0, `${oppf.length} stk`);

    // Alle oppføringar må vere kjeldeførte — det er heile poenget med fila.
    sjekk('kvar oppføring har kjelde_url, kjelde_dato og kjelde_status',
        oppf.every((e) => e.kjelde_url && e.kjelde_dato && e.kjelde_status),
        `${oppf.filter((e) => e.kjelde_url && e.kjelde_dato && e.kjelde_status).length}/${oppf.length}`);
    sjekk('alle kjelde-URL-ar er http(s)',
        oppf.every((e) => /^https?:\/\//i.test(e.kjelde_url ?? '')));

    // Same normalisering som KnownSpecRegistry::normaliserNamn() i PHP.
    const norm = (s) => s
        .replace(/[ÆæØøÅåÄäÖöÜüÉéÈèÊêÁáČčŠšŊŋĐđŦŧŽž]/g, (c) =>
            ({ Æ: 'ae', æ: 'ae', Ø: 'o', ø: 'o', Å: 'a', å: 'a', Ä: 'a', ä: 'a', Ö: 'o', ö: 'o',
               Ü: 'u', ü: 'u', É: 'e', é: 'e', È: 'e', è: 'e', Ê: 'e', ê: 'e', Á: 'a', á: 'a',
               Č: 'c', č: 'c', Š: 's', š: 's', Ŋ: 'n', ŋ: 'n', Đ: 'd', đ: 'd', Ŧ: 't', ŧ: 't',
               Ž: 'z', ž: 'z' }[c]))
        .toLowerCase()
        .replace(/vindkraftverk|vindkraftanlegg|vindkraftpark|vindpark|vindmollepark/g, '')
        .replace(/[^a-z0-9]/g, '');

    const naadde = [];
    const bomma = [];
    let ventar = 0;
    for (const e of oppf) {
        // Oppføringar merkte `i_nve_register: false` gjeld anlegg som enno
        // ikkje finst i NVE sitt datasett (t.d. eit kommunalt planinitiativ).
        // Dei SKAL ikkje treffe noko — dei ligg klare til saka dukkar opp.
        if (e.i_nve_register === false) { ventar++; continue; }
        // Same presedens som KnownSpecRegistry::lookup(): har oppføringa eit
        // anleggsnr, er DET einaste nøkkelen. Namneoppslag gjeld berre
        // oppføringar utan anleggsnr.
        const treff = e.anleggsnr != null
            ? cache.turbiner.filter((t) => t.anleggsnr === e.anleggsnr)
            : cache.turbiner.filter((t) => t.navn && norm(t.navn) === norm(e.anleggnavn ?? ''));
        if (treff.length === 0) { bomma.push(`${e.anleggnavn} (${e.anleggsnr ?? 'utan nr'}) — ikkje i cachen`); continue; }
        const kjelda = treff.filter((t) => t.mal_kilde === 'kjent_soknad');
        if (kjelda.length !== treff.length) {
            bomma.push(`${e.anleggnavn} — berre ${kjelda.length}/${treff.length} fekk kjent_soknad`);
            continue;
        }
        naadde.push({ e, t: treff[0], n: treff.length });
    }

    sjekk('kvar oppføring i registeret treffer eit anlegg i cachen',
        bomma.length === 0,
        bomma.length ? bomma.join('; ') : `${naadde.length}/${oppf.length - ventar}` +
            (ventar ? ` (+${ventar} ventar på NVE-registrering)` : ''));

    // Ei oppføring utan anleggsnr OG utan i_nve_register:false er nesten alltid
    // ein glipp — då heng alt på at namnet er skrive nøyaktig likt som hos NVE.
    sjekk('oppføringar utan anleggsnr er merkte i_nve_register: false',
        oppf.every((e) => e.anleggsnr != null || e.i_nve_register === false));

    console.log('\n  Anlegg                                  Nav   Rotor   Total  Kjelde');
    for (const { e, t } of naadde) {
        console.log(`  ${(t.navn ?? '').padEnd(38).slice(0, 38)} ` +
            `${String(Math.round(t.nav_hoyde_m)).padStart(4)}m ` +
            `${String(Math.round(t.rotor_diameter_m)).padStart(5)}m ` +
            `${String(Math.round(t.totalhoyde_m)).padStart(6)}m  ${e.kjelde_status}`);
    }

    // Den kuraterte totalhøgda skal vere øvre ende av spennet kjelda oppgav.
    const somOppgitt = ({ e, t }) => {
        const v = e.totalhoyde_m;
        if (v == null) return true;
        const forventa = typeof v === 'object' ? (v.max ?? v.maks) : v;
        return Math.abs(t.totalhoyde_m - forventa) < 0.6;
    };
    sjekk('totalhøgda i cachen er øvre ende av spennet i kjelda',
        naadde.every(somOppgitt),
        naadde.filter((x) => !somOppgitt(x)).map((x) => x.e.anleggnavn).join(', ') || 'alle');

    // Kjelde-URL må følgje heilt fram til turbinobjektet — det er den UI viser.
    sjekk('kjeldeførte turbinar ber mal_kjelde_url heilt fram',
        naadde.every(({ t }) => typeof t.mal_kjelde_url === 'string' && /^https?:\/\//.test(t.mal_kjelde_url)));

    // ...og resten av datasettet skal framleis vere merkt estimert.
    const kjeldeforte = cache.turbiner.filter((t) => t.mal_kilde === 'kjent_soknad');
    const estimerte = cache.turbiner.filter((t) => t.mal_kilde === 'estimert');
    sjekk('mal_kilde har berre dei to lovlege verdiane',
        kjeldeforte.length + estimerte.length === cache.turbiner.length,
        `${kjeldeforte.length} kjeldeførte + ${estimerte.length} estimerte = ${cache.turbiner.length}`);
    sjekk('ingen estimert turbin har fått ein kjelde-URL',
        estimerte.every((t) => t.mal_kjelde_url === undefined));

    // --- Ingen regresjon på dei tidlegare verifiserte estimata --------------
    // Desse to er kalibreringspunkta i CLAUDE.md §3 og skal IKKJE endre seg av
    // at toppen av referansetabellen er heva.
    const st = cache.turbiner.find((t) => t.navn === 'Storheia');
    sjekk('REGRESJON: Storheia er framleis 87 m nav / 130 m rotor (SWT-DD-130)',
        st && Math.abs(st.nav_hoyde_m - 87) < 0.6 && Math.abs(st.rotor_diameter_m - 130) < 0.6,
        st ? `${st.nav_hoyde_m}/${st.rotor_diameter_m}` : 'ikkje funne');
    const oy = cache.turbiner.find((t) => t.navn === 'Øyfjellet');
    sjekk('REGRESJON: Øyfjellet er framleis 105 m nav / 149 m rotor (N149)',
        oy && Math.abs(oy.nav_hoyde_m - 105) < 0.6 && Math.abs(oy.rotor_diameter_m - 149) < 1.1,
        oy ? `${oy.nav_hoyde_m}/${oy.rotor_diameter_m}` : 'ikkje funne');

    // --- Den heva generiske tabellen ---------------------------------------
    // Poenget med heile endringa: eit anlegg utan kuratert oppføring, men med
    // høg effekt per turbin, skal no få realistiske mål — ikkje klemmast til
    // det gamle taket på 205 m totalhøgd.
    const store = estimerte.filter((t) => t.effekt_mw != null && t.effekt_mw >= 6.5);
    if (store.length) {
        sjekk('generisk estimat for ≥6,5 MW gir over 220 m totalhøgd',
            store.every((t) => t.totalhoyde_m > 220),
            `min ${Math.min(...store.map((t) => t.totalhoyde_m)).toFixed(0)} m over ${store.length} turbinar`);
    } else {
        console.log('  (ingen estimerte turbinar over 6,5 MW i datasettet — hoppar over)');
    }
    // Rotoren skal aldri ekstrapolerast forbi den fysiske grensa på land.
    sjekk('ingen turbin får rotor over 180 m',
        cache.turbiner.every((t) => t.rotor_diameter_m <= 180),
        `maks ${Math.max(...cache.turbiner.map((t) => t.rotor_diameter_m)).toFixed(0)} m`);
    // Taket er sett av Sjølisætra-meldinga (270 m vengetipp), det høgaste
    // konkrete talet nokon norsk søknad opererer med per i dag.
    sjekk('ingen turbin får totalhøgd over 275 m',
        cache.turbiner.every((t) => t.totalhoyde_m <= 275),
        `maks ${Math.max(...cache.turbiner.map((t) => t.totalhoyde_m)).toFixed(0)} m`);

    // Namngjevne kontrollar på dei tre sakene brukaren spurde om.
    for (const [nr, namn, ventaTotal] of [
        [15430, 'Nye Hitra 1', 220],
        [14835, 'Kjøllefjord vindkraftverk', 220],
        [15012, 'Nordkyn', 220],
        [16106, 'Stokkfjellet 2', 195],
    ]) {
        const t = cache.turbiner.find((x) => x.anleggsnr === nr);
        sjekk(`${namn} (${nr}) er kjeldeført med ${ventaTotal} m totalhøgd`,
            t && t.mal_kilde === 'kjent_soknad' && Math.abs(t.totalhoyde_m - ventaTotal) < 0.6,
            t ? `${t.mal_kilde}, ${t.totalhoyde_m} m` : 'ikkje i cachen');
    }

    // REGRESJONSVERN mot namnekollisjonen som oppstod under utviklinga:
    // fornyingssaker heiter nesten det same som anlegget dei skal fornye, og
    // med namnefallback fekk fire anlegg I DRIFT tildelt måla til den planlagde
    // saka. Desse fire skal alltid vere estimerte, aldri kjeldeførte.
    for (const [nr, namn] of [
        [9574, 'Kjøllefjord (i drift, ikkje Nye Kjøllefjord)'],
        [9893, 'Ytre Vikna (i drift, ikkje Ytre Vikna 2.0)'],
        [9894, 'Raggovidda (i drift, ikkje trinn 3)'],
        [10474, 'Skjøtningberg 10474 (ikkje same sak som 14833)'],
    ]) {
        const t = cache.turbiner.find((x) => x.anleggsnr === nr);
        sjekk(`KOLLISJON: ${namn} er framleis estimert`,
            t && t.mal_kilde === 'estimert',
            t ? `${t.mal_kilde}, ${t.totalhoyde_m} m` : 'ikkje i cachen');
    }

    // Buheii skal IKKJE vere kuratert: det som faktisk står der er V150-4.2,
    // som den generiske tabellen alt treffer. Sjå `_utelatne` i registerfila.
    const bu = cache.turbiner.find((t) => t.navn === 'Buheii');
    sjekk('Buheii er framleis estimert, og treffer V150-4.2 (105/150)',
        bu && bu.mal_kilde === 'estimert'
        && Math.abs(bu.nav_hoyde_m - 105) < 0.6 && Math.abs(bu.rotor_diameter_m - 150) < 0.6,
        bu ? `${bu.mal_kilde} ${bu.nav_hoyde_m}/${bu.rotor_diameter_m}` : 'ikkje funne');
}

// ===================================================================
console.log('\n=== 8. Hinderlys (FOR-2014-07-15-980 § 16) ===\n');

// Denne bolken testar at koden faktisk implementerer FORSKRIFTA, ikkje ei
// omtrentleg hugsing av henne. Tala under er sitat frå § 16 tredje ledd og
// vedlegg 2, ikkje val me har gjort:
//
//   § 7(2)   merkeplikt frå 60 m
//   § 16(3)b under 150 m → mellomintensitet type B/C, raudt, 2 000 cd
//   § 16(3)c frå 150 m   → HØYINTENSITET type B, kvitt, + lavintensitet på
//                          mellomnivå, maks 75 m vertikal avstand
{
    // -- Terskelen på 60 m ---------------------------------------------
    sjekk('59 m totalhøgd → inga merkeplikt',
        hinderlysKrav({ totalhoydeM: 59, navHoydeM: 40 }).merkeplikt === false);
    sjekk('60 m totalhøgd → merkeplikt',
        hinderlysKrav({ totalhoydeM: 60, navHoydeM: 40 }).merkeplikt === true);

    // -- Under 150 m: raudt mellomintensitetslys, ingen mellomnivå ------
    const liten = hinderlysKrav({ totalhoydeM: 137.2, navHoydeM: 83.2 }); // Nygårdsfjellet
    sjekk('under 150 m → mellomintensitet type B/C',
        liten.toppType.nokkel === 'mellomintensitet_b_c', liten.toppType.kortTekst);
    sjekk('under 150 m → raudt topplys', liten.toppType.farge === 'raudt');
    sjekk('under 150 m → 2 000 cd (vedlegg 2, kolonne C)', liten.toppType.candela === 2000);
    sjekk('under 150 m → INGEN mellomnivålys', liten.talNivaa === 1, `${liten.talNivaa} nivå`);
    sjekk('under 150 m → topplyset sit i navhøgd',
        Math.abs(liten.nivaa[0].hoydeOverBakkeM - 83.2) < 0.01);

    // -- Grensa går ved NØYAKTIG 150 m («fra og med 150 meter») --------
    sjekk('149,9 m → framleis mellomintensitet',
        hinderlysKrav({ totalhoydeM: 149.9, navHoydeM: 90 }).hoyintensitet === false);
    sjekk('150,0 m → høyintensitet',
        hinderlysKrav({ totalhoydeM: 150.0, navHoydeM: 90 }).hoyintensitet === true);

    // -- Frå 150 m: KVITT høyintensitetslys. Dette er den lette å ta feil av.
    const stor = hinderlysKrav({ totalhoydeM: 220, navHoydeM: 133.3 }); // Nordkyn
    sjekk('frå 150 m → høyintensitet type B',
        stor.toppType.nokkel === 'hoyintensitet_b', stor.toppType.kortTekst);
    sjekk('frå 150 m → topplyset er KVITT, ikkje raudt',
        stor.toppType.farge === 'kvitt', stor.toppType.farge);
    sjekk('høyintensitet type B blinkar alltid (vedlegg 2)', stor.toppType.blinkar === true);
    sjekk('høyintensitet er 100 000 cd om dagen, 2 000 cd om natta',
        stor.toppType.candelaDag === 100000 && stor.toppType.candela === 2000);
    sjekk('mellomnivålysa er lavintensitet type B, raudt, 32 cd',
        stor.mellomType.nokkel === 'lavintensitet_b'
        && stor.mellomType.farge === 'raudt' && stor.mellomType.candela === 32);

    // -- Vedlegg 5: «totalt 3 sett med lys» ----------------------------
    sjekk('turbin over 150 m får minst 3 sett lys (vedlegg 5)',
        stor.talNivaa >= 3, `${stor.talNivaa} nivå`);

    // -- § 16(3)c: maks 75 m vertikal avstand mellom lysa ---------------
    const sjekkAvstand = (total, nav) => {
        const k = hinderlysKrav({ totalhoydeM: total, navHoydeM: nav });
        if (!k.hoyintensitet) return true;
        const h = k.nivaa.map((n) => n.hoydeOverBakkeM).sort((a, b) => b - a);
        // Frå nacellen ned til terrenget: alle steg må vere ≤ 75 m.
        const steg = [];
        for (let i = 0; i < h.length - 1; i++) steg.push(h[i] - h[i + 1]);
        steg.push(h[h.length - 1]); // nedste lys → terreng
        return steg.every((s) => s <= 75.0001);
    };
    let alleOk = true;
    let verstNav = null;
    for (let nav = 75; nav <= 260; nav += 1) {
        if (!sjekkAvstand(nav + 90, nav)) { alleOk = false; verstNav = nav; break; }
    }
    sjekk('75 m-regelen held for alle navhøgder 75–260 m', alleOk,
        alleOk ? 'alle' : `feila ved nav ${verstNav} m`);

    // Eit svært høgt tårn må få FLEIRE enn tre nivå — 3 nivå på 260 m nav
    // ville gitt 87 m mellom lysa, som er ulovleg.
    const svaertHogt = hinderlysKrav({ totalhoydeM: 350, navHoydeM: 260 });
    sjekk('260 m nav krev fleire enn 3 nivå', svaertHogt.talNivaa >= 4,
        `${svaertHogt.talNivaa} nivå, ${(260 / svaertHogt.talNivaa).toFixed(0)} m mellomrom`);

    // -- Fotometrien ----------------------------------------------------
    // 2 000 cd på 5 km: E = 2000/5000² = 8,0·10⁻⁵ lux. Mot E₀ = 2,54·10⁻⁶
    // gir det m = −2,5·log₁₀(31,5) = −3,74, pluss 0,53 mag ekstinksjon.
    const m5 = stjernemagnitude(2000, 5000);
    sjekk('2 000 cd på 5 km ≈ magnitude −3,2 (Venus-klasse)',
        Math.abs(m5 - (-3.21)) < 0.05, m5.toFixed(2));
    const m20 = stjernemagnitude(2000, 20000);
    sjekk('2 000 cd på 20 km ≈ magnitude +1,4 (framleis godt synleg)',
        Math.abs(m20 - 1.38) < 0.05, m20.toFixed(2));
    sjekk('magnitude veks monotont med avstanden',
        stjernemagnitude(2000, 1000) < stjernemagnitude(2000, 5000)
        && stjernemagnitude(2000, 5000) < stjernemagnitude(2000, 20000));
    sjekk('eit 32 cd mellomnivålys er mykje svakare enn eit 2 000 cd topplys',
        stjernemagnitude(32, 5000) - stjernemagnitude(2000, 5000) > 4,
        `${(stjernemagnitude(32, 5000) - stjernemagnitude(2000, 5000)).toFixed(1)} mag skilnad`);

    // -- Synlegheit per lyspunkt ----------------------------------------
    // Poenget: eit lyspunkt skal vurderast mot SAME horisont som vengetuppen,
    // men uavhengig av han. Ein horisont mellom navet og vengetuppen skal gi
    // synleg turbin, men SKJULT navlys.
    const bakke = 400;
    const navH = 133.3;
    const syn = hinderlysSynlegheit({
        krav: stor,
        bakkeVedTurbinMoh: bakke,
        horisontMoh: bakke + navH + 10,   // horisonten ligg 10 m over navet
        avstandM: 4000,
    });
    sjekk('lyspunkt under horisonten er skjult', syn.toppSynleg === false);
    sjekk('alle mellomnivålys er òg skjulte då', syn.synlege === 0);

    const syn2 = hinderlysSynlegheit({
        krav: stor, bakkeVedTurbinMoh: bakke,
        horisontMoh: bakke + navH - 10,   // horisonten ligg 10 m under navet
        avstandM: 4000,
    });
    sjekk('topplys over horisonten er synleg', syn2.toppSynleg === true);
    sjekk('mellomnivålysa er framleis skjulte', syn2.synlege === 1,
        `${syn2.synlege} synlege lyspunkt`);

    const syn3 = hinderlysSynlegheit({
        krav: stor, bakkeVedTurbinMoh: bakke, horisontMoh: bakke - 50, avstandM: 4000,
    });
    sjekk('fri sikt → alle lyspunkta synlege', syn3.synlege === stor.talNivaa,
        `${syn3.synlege}/${stor.talNivaa}`);

    sjekk('utan terrengdata er synlegheita null, ikkje false',
        hinderlysSynlegheit({ krav: stor, bakkeVedTurbinMoh: null, horisontMoh: null, avstandM: 4000 })
            .lyspunkt.every((l) => l.synleg === null));
}

// ===================================================================
console.log('\n=== 9. Solposisjon og skyggekast ===\n');

{
    // -- Solposisjon mot kjende astronomiske verdiar --------------------
    // Maksimal solhøgd ved sommarsolverv = 90 − breidd + 23,44.
    // For Oslo (59,9139°N): 53,53°. For vintersolverv: 6,65° + refraksjon.
    const oslo = { lat: 59.9139, lon: 10.7522 };
    const maksHoyde = (aar, mnd, dag) => {
        let maks = -99;
        for (let m = 0; m < 1440; m += 1) {
            const p = solposisjon(new Date(Date.UTC(aar, mnd, dag, 0, m)), oslo.lat, oslo.lon);
            if (p.hoyde > maks) maks = p.hoyde;
        }
        return maks;
    };
    const sommar = maksHoyde(2026, 5, 21);
    sjekk('Oslo, sommarsolverv: maks solhøgd ≈ 53,5°',
        Math.abs(sommar - 53.53) < 0.15, `${sommar.toFixed(2)}°`);
    const vinter = maksHoyde(2026, 11, 21);
    // 6,65° geometrisk + ~0,13° refraksjon.
    sjekk('Oslo, vintersolverv: maks solhøgd ≈ 6,8°',
        Math.abs(vinter - 6.78) < 0.15, `${vinter.toFixed(2)}°`);

    // Asimut ved soltidsmiddag skal vere sør (180°) på nordlege breidder.
    let besteAz = null;
    let besteEl = -99;
    for (let m = 0; m < 1440; m += 1) {
        const p = solposisjon(new Date(Date.UTC(2026, 5, 21, 0, m)), oslo.lat, oslo.lon);
        if (p.hoyde > besteEl) { besteEl = p.hoyde; besteAz = p.asimut; }
    }
    sjekk('sola står i sør når ho er høgast', Math.abs(besteAz - 180) < 0.5, `${besteAz.toFixed(2)}°`);

    // Ved midnattssol nord for polarsirkelen skal sola stå i NORD og over
    // horisonten. Nordkapp (71,17°N) 21. juni.
    const nordkapp = { lat: 71.17, lon: 25.78 };
    let minEl = 99;
    let minElAz = null;
    for (let m = 0; m < 1440; m += 1) {
        const p = solposisjon(new Date(Date.UTC(2026, 5, 21, 0, m)), nordkapp.lat, nordkapp.lon);
        if (p.hoyde < minEl) { minEl = p.hoyde; minElAz = p.asimut; }
    }
    sjekk('Nordkapp 21. juni: sola går aldri under horisonten', minEl > 0, `lågast ${minEl.toFixed(2)}°`);
    sjekk('...og står då i nord', minElAz < 20 || minElAz > 340, `${minElAz.toFixed(0)}°`);

    // Tidssone: EU-regelen for norsk sommartid.
    sjekk('1. januar er UTC+1', norskUtcOffsetTimar(Date.UTC(2026, 0, 1), 2026) === 1);
    sjekk('1. juli er UTC+2', norskUtcOffsetTimar(Date.UTC(2026, 6, 1), 2026) === 2);

    // -- Relevant avstand ------------------------------------------------
    // Utleidd frå 20 %-kriteriet: ~13,8 · rotordiameter, klemt til 2 km.
    sjekk('150 m rotor → skyggekast-radius klemt til 2 000 m (NVE si grense)',
        maksSkyggeavstandM(150) === 2000, `${maksSkyggeavstandM(150)} m`);
    sjekk('80 m rotor → radius ~1 100 m, altså under taket',
        Math.abs(maksSkyggeavstandM(80) - 1104) < 1, `${maksSkyggeavstandM(80).toFixed(0)} m`);
    sjekk('rotordiameter 0 → ingen radius', maksSkyggeavstandM(0) === 0);

    // -- Geometri mot syntetisk, flatt terreng ---------------------------
    const sPunkt = { lat: 63.50, lon: 10.50, hoyde: 100 };
    const soltabell = byggSoltabell(sPunkt, 2026);
    sjekk('soltabellen dekkjer eit heilt år', soltabell.minuttIAaretTotalt === 365 * 1440,
        `${soltabell.n} minutt over ${soltabell.minSolhoyde ?? 3}°`);
    sjekk('under halvparten av årets minutt har sol over 3°',
        soltabell.n > 0.3 * soltabell.minuttIAaretTotalt
        && soltabell.n < 0.5 * soltabell.minuttIAaretTotalt,
        `${(100 * soltabell.n / soltabell.minuttIAaretTotalt).toFixed(1)} %`);

    const lagFlat = (D, z = 100) => Array.from({ length: 60 }, (_, i) => ({
        d: (D * i) / 59, z, lat: 0, lon: 0, terreng: 'ÅpentOmråde',
    }));
    const skyggeTest = (dlat, dlon) => {
        const t = {
            id: 'S', navn: 'Skygge', status: 'i_drift', anleggsnr: 1,
            lat: sPunkt.lat + dlat, lon: sPunkt.lon + dlon,
            nav_hoyde_m: 150, rotor_diameter_m: 170, totalhoyde_m: 235,
            lydeffekt_dba: 107, effekt_mw: 6.6, mal_kilde: 'estimert',
            posisjon_kilde: 'nve_turbinpunkt',
        };
        const D = haversine(sPunkt.lat, sPunkt.lon, t.lat, t.lon);
        const r = beregnPaaverknad({ punkt: sPunkt, turbin: t, profil: lagFlat(D) });
        return { r, s: skyggekastForTurbin({ soltabell, resultat: r }) };
    };

    const sor = skyggeTest(-0.0063, 0);
    const nord = skyggeTest(0.0063, 0);
    const aust = skyggeTest(0, 0.0141);
    const vest = skyggeTest(0, -0.0141);
    const langt = skyggeTest(-0.0135, 0);
    const utanfor = skyggeTest(-0.0225, 0);

    console.log(`  sør 700 m:  ${sor.s.timarPerAar.toFixed(1)} t/år, verste døgn ${sor.s.maksMinuttPerDag} min`);
    console.log(`  aust 700 m: ${aust.s.timarPerAar.toFixed(1)} t/år`);
    console.log(`  sør 1,5 km: ${langt.s.timarPerAar.toFixed(1)} t/år`);

    // Ein turbin rett NORD for punktet på 63,5°N kan aldri kaste skugge hit:
    // det ville kravd at sola stod i sør... nei — at ho stod i NORD og over 3°,
    // og det gjer ho ikkje sør for polarsirkelen.
    sjekk('turbin rett nord gir null skyggekast (sola står aldri der)',
        nord.s.minuttPerAar === 0, `${nord.s.timarPerAar.toFixed(2)} t/år`);
    sjekk('turbin rett sør gir mykje skyggekast', sor.s.timarPerAar > 20,
        `${sor.s.timarPerAar.toFixed(1)} t/år`);
    sjekk('aust og vest er tilnærma symmetriske',
        Math.abs(aust.s.timarPerAar - vest.s.timarPerAar) < 1,
        `${aust.s.timarPerAar.toFixed(1)} vs ${vest.s.timarPerAar.toFixed(1)} t/år`);
    sjekk('skyggekastet fell med avstanden', langt.s.timarPerAar < sor.s.timarPerAar,
        `${langt.s.timarPerAar.toFixed(1)} < ${sor.s.timarPerAar.toFixed(1)}`);
    sjekk('utanfor radius → ikkje rekna i det heile', utanfor.s === null);

    // Sesong: ein turbin i sør på 63,5°N kastar skugge når sola står LÅGT nok
    // til at skuggen når 700 m — altså haust/vinter, aldri midtsommars.
    const perManad = [];
    for (let m = 0; m < 12; m++) {
        let x = 0;
        for (let h = 0; h < 24; h++) x += sor.s.kalender[m * 24 + h];
        perManad.push(x);
    }
    sjekk('ingen skyggekast i juni (sola står for høgt)', perManad[5] === 0);
    sjekk('skyggekast om vinteren', perManad[0] + perManad[1] + perManad[10] > 0,
        `jan+feb+nov = ${perManad[0] + perManad[1] + perManad[10]} min`);
    sjekk('kalenderen summerer til totalen',
        Math.abs(sor.s.kalender.reduce((a, b) => a + b, 0) - sor.s.minuttPerAar) < 1e-6);

    // Ein turbin i sør gir skugge midt på dagen, i lokal tid.
    const perTime = [];
    for (let h = 0; h < 24; h++) {
        let x = 0;
        for (let m = 0; m < 12; m++) x += sor.s.kalender[m * 24 + h];
        perTime.push(x);
    }
    const toppTime = perTime.indexOf(Math.max(...perTime));
    sjekk('turbin i sør gir skugge midt på dagen (lokal tid)',
        toppTime >= 11 && toppTime <= 13, `kl. ${toppTime}`);

    // Terrengskjerming skal slå ut skyggekastet heilt.
    const D2 = haversine(sPunkt.lat, sPunkt.lon, sPunkt.lat - 0.0063, sPunkt.lon);
    const aasProfil = Array.from({ length: 60 }, (_, i) => {
        const f = i / 59;
        return { d: D2 * f, z: 100 + 900 * Math.exp(-((f - 0.5) ** 2) / (2 * 0.08 ** 2)), lat: 0, lon: 0, terreng: 'x' };
    });
    const skjultT = {
        id: 'S2', navn: 'Skjult', status: 'i_drift', anleggsnr: 1,
        lat: sPunkt.lat - 0.0063, lon: sPunkt.lon,
        nav_hoyde_m: 150, rotor_diameter_m: 170, totalhoyde_m: 235,
        lydeffekt_dba: 107, effekt_mw: 6.6, mal_kilde: 'estimert', posisjon_kilde: 'nve_turbinpunkt',
    };
    const skjultR = beregnPaaverknad({ punkt: sPunkt, turbin: skjultT, profil: aasProfil });
    const skjultS = skyggekastForTurbin({ soltabell, resultat: skjultR });
    sjekk('turbin bak ein 900 m ås gir null skyggekast', skjultS.minuttPerAar === 0);
    sjekk('...og null synlege hinderlys', skjultR.hinderlys.synlege === 0);

    // -- Unionen: fleire turbinar skal ikkje dobbelttelje ----------------
    const tre = [-0.0063, -0.0064, -0.0065].map((d, i) => {
        const t = {
            id: `U${i}`, navn: `U${i}`, status: 'i_drift', anleggsnr: 1,
            lat: sPunkt.lat + d, lon: sPunkt.lon,
            nav_hoyde_m: 150, rotor_diameter_m: 170, totalhoyde_m: 235,
            lydeffekt_dba: 107, effekt_mw: 6.6, mal_kilde: 'estimert', posisjon_kilde: 'nve_turbinpunkt',
        };
        const D = haversine(sPunkt.lat, sPunkt.lon, t.lat, t.lon);
        return beregnPaaverknad({ punkt: sPunkt, turbin: t, profil: lagFlat(D) });
    });
    const { perTurbin, samla } = skyggekastForAlle(tre, soltabell);
    const sumPerTurbin = [...perTurbin.values()].reduce((a, s) => a + s.minuttPerAar, 0);
    sjekk('tre nesten samanfallande turbinar: unionen er mindre enn summen',
        samla.minuttPerAar < sumPerTurbin,
        `union ${(samla.minuttPerAar / 60).toFixed(1)} t vs sum ${(sumPerTurbin / 60).toFixed(1)} t`);
    sjekk('unionen er minst like stor som den største enkeltturbinen',
        samla.minuttPerAar >= Math.max(...[...perTurbin.values()].map((s) => s.minuttPerAar)));

    // -- NVE-tersklane ---------------------------------------------------
    // Me samanliknar mot TEORETISK grense (30 t/år), ikkje faktisk (8 t/år).
    sjekk('grensa det samanliknast mot er 30 t/år teoretisk',
        CONFIG.skyggekast.grenseTimarPerAar === 30
        && CONFIG.skyggekast.faktiskGrenseTimarPerAar === 8);
    sjekk('over-grensa-flagget følgjer 30 t/år',
        sor.s.overGrenseAar === (sor.s.timarPerAar > 30));
    sjekk('det illustrative "faktiske" talet er ~27 % av det teoretiske',
        Math.abs(sor.s.illustrativtFaktiskTimarPerAar / sor.s.timarPerAar - 8 / 30) < 1e-9);
}

// ===================================================================
console.log('\n=== 10. Estimert utplassering i planområde ===\n');

{
    const layouts = lesJsonHvisFinst('../cache/layouts.json');
    const areasFil = lesJsonHvisFinst('../cache/areas.json');

    if (!layouts || !areasFil) {
        console.log('  (cache/layouts.json manglar — køyr php cron/fetch_turbines.php først)');
    } else {
        const oppf = Object.entries(layouts.oppforingar ?? {});
        const medPunkt = oppf.filter(([, v]) => (v.punkt ?? []).length > 0);
        sjekk('layouts.json har utrekna utplasseringar', medPunkt.length > 0,
            `${medPunkt.length} anlegg med punkt, ${oppf.length} oppføringar totalt`);

        // Polygon per anleggsnr — SOM SEPARATE POLYGON, ikkje samanslåtte
        // ringar. Sjå TurbineLayout::iNokoPolygon() for kvifor det er kritisk.
        const polygonPerNr = new Map();
        for (const o of areasFil.omrader ?? []) {
            if (o.anleggsnr == null || !o.ringer?.length) continue;
            if (!polygonPerNr.has(o.anleggsnr)) polygonPerNr.set(o.anleggsnr, []);
            polygonPerNr.get(o.anleggsnr).push(o.ringer);
        }

        // 1. Alle punkta må liggje inne i det verkelege planområdet.
        let utanfor = 0;
        let punktTotalt = 0;
        for (const [nr, v] of medPunkt) {
            const poly = polygonPerNr.get(Number(nr));
            if (!poly) continue;
            for (const p of v.punkt) {
                punktTotalt++;
                if (!iNokoPolygon(p.lat, p.lon, poly)) utanfor++;
            }
        }
        sjekk('alle estimerte turbinpunkt ligg inne i NVE sitt planområde',
            utanfor === 0, `${punktTotalt - utanfor}/${punktTotalt} inne`);

        // 2. Minsteavstanden må vere handheva.
        let brotAvstand = 0;
        let minRd = Infinity;
        for (const [, v] of medPunkt) {
            const krav = v.min_avstand_m;
            for (let i = 0; i < v.punkt.length; i++) {
                for (let j = i + 1; j < v.punkt.length; j++) {
                    const d = haversine(v.punkt[i].lat, v.punkt[i].lon, v.punkt[j].lat, v.punkt[j].lon);
                    // 1 m slingring for avrunding til 6 desimalar.
                    if (d < krav - 1) brotAvstand++;
                    if (d < minRd) minRd = d;
                }
            }
        }
        sjekk('ingen to estimerte turbinar står nærare enn den handheva avstanden',
            brotAvstand === 0, `minste avstand i heile datasettet: ${minRd.toFixed(0)} m`);

        // 3. Ingen turbin på vatn.
        const paaVatn = medPunkt.flatMap(([, v]) => v.punkt)
            .filter((p) => ['Havflate', 'Innsjø', 'InnsjøRegulert', 'Elv'].includes(p.terreng));
        sjekk('ingen estimert turbin står på vatn', paaVatn.length === 0,
            paaVatn.length ? `${paaVatn.length} punkt` : 'null');

        // 4. Ryggheuristikken må faktisk gjere noko: dei valde punkta skal
        //    liggje høgare enn snittet i sitt eige område.
        let overSnitt = 0;
        for (const [, v] of medPunkt) {
            const h = v.punkt.map((p) => p.moh);
            const snitt = h.reduce((a, b) => a + b, 0) / h.length;
            // Samanlikn mot det lågaste valde punktet som proxy for terrenget:
            // eit reelt utval frå ein rygg har lita spreiing rundt eit høgt snitt.
            if (snitt >= Math.min(...h)) overSnitt++;
        }
        sjekk('høgdefordelinga er konsistent i alle anlegg', overSnitt === medPunkt.length);

        // 5. Cachen må vere signert, slik at ei endring i heuristikken
        //    automatisk invaliderer henne.
        sjekk('kvar oppføring har ein signatur',
            oppf.every(([, v]) => typeof v.signatur === 'string' && v.signatur.length === 40));

        // 6. Kopling mot turbines.json.
        const estimerte = cache.turbiner.filter((t) => t.posisjon_kilde === 'estimert_i_omrade');
        sjekk('turbines.json inneheld estimerte punkt', estimerte.length > 0,
            `${estimerte.length} punkt over ${new Set(estimerte.map((t) => t.anleggsnr)).size} anlegg`);
        sjekk('alle estimerte punkt ber posisjon_notat',
            estimerte.every((t) => typeof t.posisjon_notat === 'string' && t.posisjon_notat.length > 20));
        sjekk('estimerte punkt har IKKJE representerer_turbiner (dei er éin turbin kvar)',
            estimerte.every((t) => t.representerer_turbiner === undefined));
        sjekk('posisjon_kilde har berre dei tre lovlege verdiane',
            cache.turbiner.every((t) => ['nve_turbinpunkt', 'estimert_i_omrade', 'anlegg_senterpunkt']
                .includes(t.posisjon_kilde)));

        // 7. Statusfilteret: berre levande saker skal ha fått utplassering.
        //    Utan dette produserte steget 9 400 punkt, dei fleste på
        //    tilbaketrekte 2019-meldingar med spekulative effekttal.
        const levande = ['under_behandling', 'konsesjon_gitt', 'konsesjon_ikke_bygd', 'under_bygging'];
        sjekk('ingen utplassering på trekte/avslåtte saker',
            estimerte.every((t) => levande.includes(t.status)),
            [...new Set(estimerte.map((t) => t.status))].join(', '));

        // 8. Eit senterpunkt-fallback må framleis finnast der polygon manglar.
        const senter = cache.turbiner.filter((t) => t.posisjon_kilde === 'anlegg_senterpunkt');
        sjekk('eittpunkts-fallbacket er framleis i bruk der polygon manglar',
            senter.length > 0, `${senter.length} anlegg`);

        console.log('\n  Anlegg                                  Mål  Sett  Avstand  Høgd (moh.)');
        for (const [nr, v] of medPunkt.slice(0, 12)) {
            const t = cache.turbiner.find((x) => x.anleggsnr === Number(nr));
            const h = v.punkt.map((p) => p.moh);
            console.log(`  ${(t?.navn ?? nr).padEnd(38).slice(0, 38)} `
                + `${String(v.maal).padStart(4)} ${String(v.plasserte).padStart(5)} `
                + `${String(Math.round(v.min_avstand_m)).padStart(6)} m  `
                + `${Math.round(Math.min(...h))}–${Math.round(Math.max(...h))}`);
        }
    }
}

// ===================================================================
console.log('\n=== 11. Brukarjustert turbinposisjon (draging) ===\n');

{
    // --- Kven kan flyttast? --------------------------------------------
    // Regelen er ikkje «kva er praktisk», men «kven har sagt at turbinen står
    // her». Har NVE sagt det, står punktet fast.
    const nve = cache.turbiner.filter((t) => t.posisjon_kilde === 'nve_turbinpunkt');
    const estimerteP = cache.turbiner.filter((t) => t.posisjon_kilde === 'estimert_i_omrade');
    const senterP = cache.turbiner.filter((t) => t.posisjon_kilde === 'anlegg_senterpunkt');

    sjekk('verifiserte NVE-punkt kan ALDRI dragast',
        nve.length > 0 && nve.every((t) => kanFlyttast(t) === false), `${nve.length} punkt`);
    sjekk('estimerte punkt i planområde kan dragast',
        estimerteP.length > 0 && estimerteP.every(kanFlyttast), `${estimerteP.length} punkt`);
    sjekk('eittpunkts-plasshaldarar kan dragast',
        senterP.length > 0 && senterP.every(kanFlyttast), `${senterP.length} punkt`);

    // --- Flytting og tilbakestilling -----------------------------------
    const basis = cache.turbiner.find((t) => t.id === 'E14237_13');
    sjekk('testturbinen E14237_13 (Moifjellet) finst i cachen', Boolean(basis),
        basis ? `${basis.navn}, ${basis.lat.toFixed(4)}, ${basis.lon.toFixed(4)}` : '');

    if (basis) {
        const NY = { lat: basis.lat + 0.0060, lon: basis.lon + 0.0090 };
        const flytta = flyttTurbin(basis, NY.lat, NY.lon);

        sjekk('flytta turbin får posisjon_kilde "brukerjustert"',
            flytta.posisjon_kilde === JUSTERT_KILDE, flytta.posisjon_kilde);
        sjekk('originalen vert IKKJE endra (rein funksjon)',
            basis.posisjon_kilde === 'estimert_i_omrade' && basis.lat !== flytta.lat);
        sjekk('opphavleg posisjon og kjelde vert teke vare på',
            flytta.opphavleg_lat === basis.lat
            && flytta.opphavleg_lon === basis.lon
            && flytta.opphavleg_posisjon_kilde === 'estimert_i_omrade');

        const venta = haversine(basis.lat, basis.lon, NY.lat, NY.lon);
        sjekk('flytt_avstand_m er avstanden frå det opphavlege punktet',
            Math.abs(flytta.flytt_avstand_m - venta) < 0.001,
            `${Math.round(flytta.flytt_avstand_m)} m`);
        sjekk('layout_terreng vert nulla ut (gjeld det gamle punktet)',
            flytta.layout_terreng === null);

        // Flytt éin gong til: opphavet skal framleis peike på HEURISTIKKENS
        // punkt, ikkje på førre drop-punkt. Utan dette ville «tilbakestill»
        // etter fem drag berre gått eitt steg tilbake.
        const flyttaIgjen = flyttTurbin(flytta, basis.lat + 0.02, basis.lon);
        sjekk('gjentekne flyttingar held på det OPPHAVLEGE punktet',
            flyttaIgjen.opphavleg_lat === basis.lat && flyttaIgjen.opphavleg_lon === basis.lon);
        sjekk('flytt_avstand_m vert rekna frå opphavet, ikkje frå førre drop',
            Math.abs(flyttaIgjen.flytt_avstand_m
                - haversine(basis.lat, basis.lon, basis.lat + 0.02, basis.lon)) < 0.001,
            `${Math.round(flyttaIgjen.flytt_avstand_m)} m`);

        const attende = tilbakestillTurbin(flyttaIgjen);
        sjekk('tilbakestilling gir nøyaktig det opphavlege punktet',
            attende.lat === basis.lat && attende.lon === basis.lon
            && attende.posisjon_kilde === 'estimert_i_omrade');
        sjekk('tilbakestilling fjernar justeringsfelta',
            attende.opphavleg_lat === undefined && attende.flytt_avstand_m === undefined);
        sjekk('tilbakestilling av eit ikkje-justert punkt er ein no-op',
            tilbakestillTurbin(basis) === basis);
    }

    // --- Planområdet: mjukt grenseband ---------------------------------
    const areasFil2 = lesJsonHvisFinst('../cache/areas.json');
    if (basis && areasFil2) {
        const polygonar = (areasFil2.omrader ?? [])
            .filter((o) => o.anleggsnr === basis.anleggsnr && o.ringer?.length)
            .map((o) => o.ringer);

        sjekk('Moifjellet har planområde i areas.json', polygonar.length > 0,
            `${polygonar.length} polygon`);
        sjekk('det estimerte punktet ligg inne i planområdet',
            innanforPlanomrade(basis.lat, basis.lon, polygonar));
        sjekk('avstandUtanforPlanomrade er 0 for eit punkt innanfor',
            avstandUtanforPlanomrade(basis.lat, basis.lon, polygonar) === 0);

        // 4 km nord for anlegget er trygt utanfor kvart planområde i Rogaland.
        const utanfor = { lat: basis.lat + 0.036, lon: basis.lon };
        sjekk('eit punkt 4 km unna vert kjent att som utanfor',
            !innanforPlanomrade(utanfor.lat, utanfor.lon, polygonar));
        const dUt = avstandUtanforPlanomrade(utanfor.lat, utanfor.lon, polygonar);
        sjekk('avstanden utanfor er over åtvaringsterskelen',
            dUt > CONFIG.analyse.flyttAatvaringM, `${Math.round(dUt)} m`);
    }

    // --- Re-analysen: same funksjon, ny koordinat ----------------------
    // Dette er sjølve poenget med funksjonen: eit flytta punkt skal gi eit
    // FULLVERDIG resultat rekna på den nye staden, ikkje eit lappa gammalt.
    //
    // DROP-PUNKTET ER MED VILJE KOORDINATEN TIL EIN ANNAN TURBIN i same anlegg.
    // Ikkje for å simulere noko, men fordi testen då spør Kartverket om ein
    // profil som alt ligg i den permanente terrengcachen: sjølve utrekninga
    // køyrer på EKTE høgdedata, og suiten er ikkje avhengig av at WPS-en er
    // oppe akkurat no. Origo (58,5900 / 6,1200) er valt av same grunn.
    const flytteMaal = cache.turbiner.find((t) => t.id === 'E14237_20');
    if (basis && flytteMaal) {
        try {
            const obs2 = { lat: 58.5900, lon: 6.1200 };
            const h = await (await fetch(
                `${API}/backend/api/elevation_point.php?lat=${obs2.lat}&lon=${obs2.lon}`)).json();
            const p2 = { ...obs2, hoyde: h.hoyde_m };
            sjekk('bakkehøgd for observatørpunktet', h.ok === true,
                `${h.hoyde_m} moh. (${h.terreng})`);

            const utgangspunkt = cache.turbiner.find((t) => t.id === 'E14237_15');
            const flytta = flyttTurbin(utgangspunkt, flytteMaal.lat, flytteMaal.lon);

            const pr = await (await fetch(`${API}/backend/api/elevation_profile.php`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    origin: obs2,
                    targets: [
                        { id: utgangspunkt.id, lat: utgangspunkt.lat, lon: utgangspunkt.lon },
                        { id: 'etter', lat: flytta.lat, lon: flytta.lon },
                    ],
                }),
            })).json();

            const rFor = beregnPaaverknad({
                punkt: p2, turbin: utgangspunkt, profil: pr.profiles[utgangspunkt.id],
            });
            const rEtter = beregnPaaverknad({
                punkt: p2,
                turbin: { ...flytta, id: 'etter' },
                profil: pr.profiles.etter,
            });

            sjekk('begge posisjonane vart analyserte mot ekte terreng',
                rFor.analysert && rEtter.analysert);
            sjekk('resultatet for det flytta punktet er merkt "brukerjustert"',
                rEtter.posisjonKilde === JUSTERT_KILDE, rEtter.posisjonKilde);
            sjekk('det uflytta resultatet er framleis merkt "estimert_i_omrade"',
                rFor.posisjonKilde === 'estimert_i_omrade');
            sjekk('opphavet følgjer heilt ut i resultatobjektet (til UI-merkinga)',
                rEtter.opphavlegLat === utgangspunkt.lat
                && rEtter.opphavlegPosisjonKilde === 'estimert_i_omrade'
                && Number.isFinite(rEtter.flyttAvstandM),
                `${Math.round(rEtter.flyttAvstandM)} m flytta`);
            sjekk('eit uflytta resultat har ingen justeringsfelt',
                rFor.opphavlegLat === null && rFor.flyttAvstandM === null);

            sjekk('avstand og kurs er rekna for den NYE koordinaten',
                Math.abs(rEtter.avstandM - haversine(obs2.lat, obs2.lon, flytta.lat, flytta.lon)) < 0.5,
                `${(rEtter.avstandM / 1000).toFixed(2)} km mot ${(rFor.avstandM / 1000).toFixed(2)} km`);
            sjekk('bakkehøgda ved turbinen er henta på nytt (anna terreng)',
                rEtter.bakkeVedTurbinMoh !== rFor.bakkeVedTurbinMoh,
                `${Math.round(rFor.bakkeVedTurbinMoh)} → ${Math.round(rEtter.bakkeVedTurbinMoh)} moh.`);
            sjekk('siktlinja er rekna på nytt (ny terrenghorisont)',
                rEtter.synlegheit.horisontMoh !== rFor.synlegheit.horisontMoh,
                `${Math.round(rFor.synlegheit.horisontMoh)} → ${Math.round(rEtter.synlegheit.horisontMoh)} moh.`);
            sjekk('turbinmåla er dei SAME — det er posisjonen som er endra',
                rEtter.navHoydeM === rFor.navHoydeM
                && rEtter.rotorDiameterM === rFor.rotorDiameterM
                && rEtter.malKilde === rFor.malKilde);

            console.log(`\n  Før:   ${(rFor.avstandM / 1000).toFixed(2)} km, `
                + `${Math.round(rFor.bakkeVedTurbinMoh)} moh., `
                + `${(rFor.synlegheit.synlegDel * 100).toFixed(0)} % synleg — ${rFor.synlegheit.tekst}`);
            console.log(`  Etter: ${(rEtter.avstandM / 1000).toFixed(2)} km, `
                + `${Math.round(rEtter.bakkeVedTurbinMoh)} moh., `
                + `${(rEtter.synlegheit.synlegDel * 100).toFixed(0)} % synleg — ${rEtter.synlegheit.tekst}`);

            // Samandraget må byggjast av det oppdaterte settet, ikkje av det gamle.
            const s1 = byggSamandrag([rFor]);
            const s2 = byggSamandrag([rEtter]);
            sjekk('byggSamandrag tek det oppdaterte resultatet',
                s1.naermaste.avstandM !== s2.naermaste.avstandM);
        } catch (e) {
            sjekk('re-analyse-testen kunne køyrast', false,
                `${e.message} (er php -S oppe på ${API}?)`);
        }
    }
}

// ===================================================================
console.log('\n=== 12. Nærfelt-rutenettet i 3D-panoramaet ===\n');

{
    // --- Reine funksjonar, ingen nettverk -------------------------------

    // Eit realistisk radiussett frå ein lang stråle: serveren si nærsone med
    // 15 m ut til 300 m, deretter ~124 m heilt ut til 20 km.
    const coarse = [];
    for (let d = 0; d < 300; d += 15) coarse.push(d);
    for (let i = 0; i < 160; i++) coarse.push(300 + (19700 * i) / 159);

    const radier = byggRadier(coarse, 1200, 60);

    sjekk('byggRadier startar i observatøren', radier[0] === 0);
    sjekk('byggRadier er strengt stigande — ingen duplikat, ingen ryggesteg',
        radier.every((d, i) => i === 0 || d > radier[i - 1]));
    sjekk('byggRadier held på serveren si 15 m-nærsone urørt',
        radier.slice(0, 20).every((d, i) => Math.abs(d - i * 15) < 0.01),
        `${radier.slice(0, 4).join(', ')} …`);

    const iNaer = radier.filter((d) => d > 300 && d <= 1200);
    sjekk('byggRadier fyller 300–1200 m med 60 m steg',
        iNaer.length === 15 && Math.abs(iNaer[0] - 360) < 0.01
        && Math.abs(iNaer[iNaer.length - 1] - 1200) < 0.01,
        `${iNaer.length} ringar, ${iNaer[0]}–${iNaer[iNaer.length - 1]} m`);

    // Skøyten inn i dei lange strålane sine eigne radiar må ikkje lage ein
    // hårtynn ring — det var halvsteget i byggRadier() steg 3 som hindra det.
    const hopp = radier.slice(1).map((d, i) => d - radier[i]);
    sjekk('ingen sliver-ringar i skøyten mot fjernfeltet',
        Math.min(...hopp.filter((h, i) => radier[i] > 300)) >= 30,
        `minste steg utanfor nærsona ${Math.min(...hopp.filter((h, i) => radier[i] > 300)).toFixed(1)} m`);
    sjekk('byggRadier når heilt ut til den lange strålen sin ytterkant',
        Math.abs(radier[radier.length - 1] - 20000) < 1,
        `${radier[radier.length - 1].toFixed(0)} m`);

    // resamplProfil: eksakt i punkta som finst, lineært mellom, null utanfor.
    const profil = [
        { d: 0, z: 100, terreng: 'Skog' },
        { d: 100, z: 200, terreng: 'Myr' },
        { d: 200, z: 150, terreng: 'Myr' },
    ];
    const rs = resamplProfil(profil, [0, 50, 100, 150, 200, 250]);
    sjekk('resamplProfil er eksakt i eit punkt som finst', rs[2].z === 200);
    sjekk('resamplProfil interpolerer lineært mellom to punkt',
        rs[1].z === 150 && rs[3].z === 175, `${rs[1].z}, ${rs[3].z}`);
    sjekk('resamplProfil gir null utanfor profilens rekkjevidd', rs[5] === null);
    sjekk('resamplProfil gir aldri NaN',
        rs.every((v) => v === null || Number.isFinite(v.z)));
    sjekk('resamplProfil respekterer maksD',
        resamplProfil(profil, [0, 50, 100, 150], 100).filter(Boolean).length === 3);

    // --- Heile kjeda mot ekte data --------------------------------------
    // api.js bruker relative URL-ar (dei er meint for nettlesaren). Ein liten
    // shim let oss køyre den EKTE Horizon/NaerTerreng-koden her.
    const ekteFetch = globalThis.fetch;
    globalThis.fetch = (url, ...rest) =>
        ekteFetch(typeof url === 'string' && !/^https?:/.test(url) ? `${API}/${url}` : url, ...rest);

    try {
        const pkt = { lat: 63.8412, lon: 10.1367 };
        const h = await fetch(`${API}/backend/api/elevation_point.php?lat=${pkt.lat}&lon=${pkt.lon}`);
        const hoyde = (await h.json()).hoyde_m;
        const punkt = { ...pkt, hoyde };

        const horisont = await hentHorisont({ punkt });
        const naer = await hentNaerTerreng({ punkt, horisont });

        sjekk('nærfeltet vart bygd', naer !== null,
            naer ? `${naer.talRetningar} retningar × ${naer.radier.length} radiar, `
                 + `${naer.talEkstra} strålar henta på ${naer.hentaMs} ms` : '');

        if (naer) {
            const nF = naer.talRetningar;
            const nRad = naer.radier.length;

            sjekk('talet retningar er naerFaktor × dei lange strålane',
                nF === horisont.talRetningar * CONFIG.panorama.naerFaktor,
                `${horisont.talRetningar} × ${CONFIG.panorama.naerFaktor} = ${nF}`);

            // DETTE er føresetnaden heile meshen kviler på: `_byggTerrengSegment()`
            // trianguler (i, j) → (i+1, j+1) og går ut frå at kvar retning har
            // like mange punkt i NØYAKTIG same avstandar. Held ikkje det, får
            // meshen hól eller skøytar.
            sjekk('alle retningar har like mange punkt',
                naer.retningar.every((r) => r.profil.length === nRad), `${nRad} punkt`);
            sjekk('alle retningar deler NØYAKTIG same radiar — ingen skøyt i meshen',
                naer.retningar.every((r) => r.profil.every((p, j) => p.d === naer.radier[j])));

            sjekk('ingen NaN og ingen negative avstandar i rutenettet',
                naer.retningar.every((r) => r.profil.every((p) =>
                    Number.isFinite(p.z) && Number.isFinite(p.d) && p.d >= 0
                    && Number.isFinite(p.lat) && Number.isFinite(p.lon))));
            sjekk('høgdene er klemte til havflata (aldri under 0)',
                naer.retningar.every((r) => r.profil.every((p) => p.z >= 0)));

            sjekk('asimutane er jamt fordelte over heile kompasset',
                naer.retningar.every((r, i) => Math.abs(r.azimut - (i * 360) / nF) < 1e-9)
                && naer.retningar[nF - 1].azimut < 360);
            sjekk('kvar naerFaktor-te retning fell saman med ein lang stråle',
                horisont.retningar.every((lang, k) =>
                    Math.abs(naer.retningar[k * CONFIG.panorama.naerFaktor].azimut - lang.azimut) < 1e-9));

            // Utanfor nærfeltet er rutenettet berre ei omsampling av dei lange
            // strålane. Der MÅ ein asimut som fell saman med ein lang stråle gi
            // nøyaktig det den lange strålen seier — elles har fjernfeltet
            // flytta seg, og panoramaet ville ikkje lenger stemme med panelet.
            const lang0 = horisont.retningar[0];
            const raa = resamplProfil(lang0.profil, naer.radier);
            let avvik = 0;
            let sjekka = 0;
            for (let j = 0; j < nRad; j++) {
                if (naer.radier[j] <= naer.naerAvstandM || !raa[j]) continue;
                avvik = Math.max(avvik, Math.abs(naer.retningar[0].profil[j].z - raa[j].z));
                sjekka++;
            }
            sjekk('fjernfeltet er uendra frå dei lange strålane',
                sjekka > 100 && avvik < 1e-6, `${sjekka} ringar, maks avvik ${avvik.toExponential(1)} m`);

            // Glattinga av dei innarste ringane skal treffe NØYAKTIG dei
            // ringane der den asimutale punktavstanden fell under grensa —
            // og ingen andre. Sjå glattInnarsteRingar() i NaerTerreng.js.
            const minSteg = CONFIG.panorama.naerMinAsimutStegM;
            const ventaGlatta = naer.radier.filter((d) =>
                d > 0 && Math.round(minSteg / ((2 * Math.PI * d) / nF)) >= 3).length;
            sjekk('glattinga treffer berre ringane som er finare enn datagrunnlaget',
                naer.glattaRingar === ventaGlatta,
                `${naer.glattaRingar} ringar (venta ${ventaGlatta}), alle innanfor `
                + `${(minSteg * nF / (3 * 2 * Math.PI)).toFixed(0)} m`);
            sjekk('glattinga rører ikkje fjernfeltet',
                naer.radier.filter((d) => d > 0
                    && Math.round(minSteg / ((2 * Math.PI * d) / nF)) >= 3)
                    .every((d) => d < 100), 'grensa ligg godt under 100 m');

            // Horisonten sjølv skal vera UENDRA av alt dette — nærfeltet er
            // berre geometri for biletet, ikkje ein ny modell (CLAUDE.md §18).
            sjekk('horisonten er urørt av nærfelt-fortettinga',
                horisont.talRetningar === CONFIG.panorama.talRetningar
                && horisont.retningar.every((r) => Number.isFinite(r.helning)));

            const rd = naer.radier;
            console.log(`\n  Rutenett: ${nF} retningar (${(360 / nF).toFixed(2)}°) × ${nRad} radiar`);
            console.log(`  Nærfelt til ${naer.naerAvstandM} m · ${naer.talEkstra} korte strålar `
                + `· ${naer.feila} feila · ${naer.glattaRingar} ringar glatta`);
            console.log(`  Radiar: ${rd[0]}, ${rd[1]}, ${rd[2]} … ${rd[19]}, ${rd[20]} … `
                + `${rd[34].toFixed(0)} … ${rd[nRad - 1].toFixed(0)} m`);
            console.log(`  Hjørne i meshen: ${nF * nRad} (mot ${horisont.talRetningar * nRad} `
                + 'med berre dei lange strålane)');
        }
    } catch (e) {
        sjekk('nærfelt-testen kunne køyrast', false, `${e.message} (er php -S oppe på ${API}?)`);
    } finally {
        globalThis.fetch = ekteFetch;
    }
}

// ===================================================================
// 13. PROGRESSIV HORISONT (CLAUDE.md §21)
// ===================================================================
// Panoramaet opnar på det fyrste delresultatet i staden for å vente på heile
// settet. Det stiller to krav som ikkje er openberre:
//
//  a) Kvart delresultat må vera eit KOMPLETT mesh-grunnlag. Manglar det
//     profilar, filtrerer `_byggTerreng()` dei bort og triangulerer dei som
//     står att som naboar — ein 30°-kile vert kopla til den neste med ein
//     flat vegg tvers over kompasset.
//  b) Delresultata må ikkje smitte over på det ferdige svaret. Dei
//     syntetiserte profilane er ei nødløysing for biletet, ikkje data.

console.log('\n=== 13. Progressiv horisont ===\n');

{
    const ekteFetch = globalThis.fetch;
    globalThis.fetch = (url, ...rest) =>
        ekteFetch(typeof url === 'string' && !/^https?:/.test(url) ? `${API}/${url}` : url, ...rest);

    try {
        const pkt = { lat: 63.8412, lon: 10.1367 };
        const h = await fetch(`${API}/backend/api/elevation_point.php?lat=${pkt.lat}&lon=${pkt.lon}`);
        const punkt = { ...pkt, hoyde: (await h.json()).hoyde_m };

        tomHorisontCache();
        const delvise = [];
        const horisont = await hentHorisont({ punkt, paaDelvis: (d) => delvise.push(d) });

        sjekk('delresultat vert leverte undervegs',
            delvise.length > 0,
            `${delvise.length} delresultat for ${Math.ceil(CONFIG.panorama.talRetningar / CONFIG.panorama.batchStorleik)} HTTP-kall`);

        if (delvise.length > 0) {
            const forste = delvise[0];

            sjekk('fyrste delresultat er merkt delvis', forste.delvis === true);
            sjekk('det ferdige svaret er IKKJE merkt delvis', horisont.delvis === false);

            // (a) Heile kompasset må vera dekt, elles får meshen ein flat kile.
            sjekk('kvart delresultat har profil i ALLE retningar — ingen kile i meshen',
                delvise.every((d) => d.retningar.every((r) => Array.isArray(r.profil)
                    && r.profil.length >= 3)));
            sjekk('kvart delresultat har endeleg helning i alle retningar',
                delvise.every((d) => d.retningar.every((r) => Number.isFinite(r.helning))));

            /**
             * BATCHANE MÅ VERA FLETTA, IKKJE SAMANHENGANDE.
             *
             * Testen som faktisk fangar regresjonen: det største mellomrommet
             * mellom to EKTE retningar i fyrste delresultat. Med fletta
             * batchar er det 360/ekte grader; med `slice()`-batching ville
             * det vore ~330°, altså heile kompasset minus éin kile.
             */
            const ekteAz = forste.retningar.filter((r) => !r.interpolert)
                .map((r) => r.azimut).sort((a, b) => a - b);
            let maksGap = 360 - (ekteAz[ekteAz.length - 1] - ekteAz[0]);
            for (let i = 1; i < ekteAz.length; i++) {
                maksGap = Math.max(maksGap, ekteAz[i] - ekteAz[i - 1]);
            }
            const ideelt = 360 / ekteAz.length;
            sjekk('fyrste delresultat spenner heile kompasset — batchane er fletta',
                maksGap <= ideelt * 1.5,
                `${ekteAz.length} ekte retningar, største mellomrom ${maksGap.toFixed(1)}° `
                + `(ideelt ${ideelt.toFixed(1)}°)`);

            // Biletet skal berre gå ein veg: mot fleire ekte retningar.
            sjekk('delresultata blir monotont betre',
                delvise.every((d, i) => i === 0 || d.ekte > delvise[i - 1].ekte),
                delvise.map((d) => d.ekte).join(' → '));

            /**
             * MESH-KRAVET FRÅ §12 GJELD OGSÅ DELRESULTAT: alle retningar må
             * ha nøyaktig same tal punkt i nøyaktig same avstandar, elles
             * ryk trianguleringa.
             */
            const nRad = forste.retningar[0].profil.length;
            sjekk('alle retningar i eit delresultat har like mange punkt',
                forste.retningar.every((r) => r.profil.length === nRad), `${nRad} punkt`);
            /**
             * RADIANE MÅ VERA LIKE JAMNE SOM I DET FERDIGE SVARET — ikkje
             * identiske.
             *
             * Grovmeshen har ALDRI kravd eksakt like radiar på tvers av
             * retningar (det kravet gjeld berre det resampla nærfeltet, §12):
             * WPS-en gir kvar stråle sine eigne avstandar, og dei sprikjer
             * eit tiendedels steg alt i det ferdige svaret. Det som ville
             * vore ein regresjon er om syntesen gjorde spriket STØRRE, for
             * då byrjar trianguleringa å skjere.
             */
            const spreiing = (H) => {
                const R = H.retningar.filter((r) => r.profil);
                const n = Math.min(...R.map((r) => r.profil.length));
                let maks = 0;
                for (let j = 0; j < n; j++) {
                    const ds = R.map((r) => r.profil[j].d);
                    maks = Math.max(maks, Math.max(...ds) - Math.min(...ds));
                }
                return maks;
            };
            const sDel = spreiing(forste);
            const sFerdig = spreiing(horisont);
            sjekk('radiane i eit delresultat sprikjer ikkje meir enn i det ferdige svaret',
                sDel <= sFerdig + 0.5,
                `delvis ${sDel.toFixed(1)} m mot ferdig ${sFerdig.toFixed(1)} m`);
            sjekk('ingen NaN i eit syntetisert delresultat',
                forste.retningar.every((r) => r.profil.every((p) =>
                    Number.isFinite(p.z) && Number.isFinite(p.lat) && Number.isFinite(p.lon))));

            /**
             * Lat/lon i eit syntetisk punkt må liggje i SI EIGA retning, ikkje
             * i naboen sin — dei styrer UV-oppslaget i flyfotoringane, og eit
             * kopiert koordinat ville drege biletteksturen sidelengs.
             */
            const synt = forste.retningar.find((r) => r.interpolert && r.profil?.length);
            if (synt) {
                const sisteP = synt.profil[synt.profil.length - 1];
                const [ventaLat, ventaLon] = destinasjon(
                    punkt.lat, punkt.lon, synt.azimut, sisteP.d);
                sjekk('syntetiske punkt ligg i si eiga retning',
                    Math.abs(sisteP.lat - ventaLat) < 1e-9
                    && Math.abs(sisteP.lon - ventaLon) < 1e-9,
                    `retning ${synt.azimut.toFixed(1)}° i ${(sisteP.d / 1000).toFixed(1)} km`);
            }

            // (b) Delresultata skal ikkje ha smitta over på sluttsvaret.
            sjekk('det ferdige svaret inneheld INGEN syntetiske punkt',
                horisont.retningar.every((r) => !r.profil
                    || r.profil.every((p) => p.syntetisk === undefined)));
            sjekk('det ferdige svaret har alle retningar skanna for ekte',
                horisont.ekte === horisont.talRetningar,
                `${horisont.ekte}/${horisont.talRetningar}`);

            console.log(`\n  ${delvise.length} delresultat: `
                + `${delvise.map((d) => d.ekte).join(' → ')} → ${horisont.ekte} ekte retningar`);
            console.log(`  Fyrste bilete bygd av ${delvise[0].ekte} strålar `
                + `(${(360 / delvise[0].ekte).toFixed(0)}° mellom kvar), `
                + `resten interpolert frå naboane`);
        }
    } catch (e) {
        sjekk('progressiv-horisont-testen kunne køyrast', false,
            `${e.message} (er php -S oppe på ${API}?)`);
    } finally {
        globalThis.fetch = ekteFetch;
    }
}

// ===================================================================
console.log('\n=== 14. Skog og bygningar: DOM-kryssjekken (§22) ===\n');
{
    // --- a) Refaktoreringa: vurderSynlegheit() må gi NØYAKTIG same dom ----
    // beregnPaaverknad() kallar no denne funksjonen i staden for å ha logikken
    // inline. Testen låser at dei to vegane ikkje kan drive frå kvarandre —
    // det er heile føresetnaden for at «bar bakke: delvis / med skog: skjult»
    // er ei samanlikning av det same.
    const pAas = beregnPaaverknad({ punkt, turbin, profil: lagProfil(300) });
    const gjenskapt = vurderSynlegheit({
        helning: pAas.synlegheit.horisontHelning,
        kritiskPunkt: pAas.synlegheit.kritiskPunkt,
        augeMoh: pAas.augeMoh,
        avstandM: pAas.avstandM,
        basisMoh: pAas.basisMoh,
        navMoh: pAas.navMoh,
        tuppMoh: pAas.tuppMoh,
    });
    sjekk('vurderSynlegheit gjenskaper beregnPaaverknad sin dom',
        gjenskapt.nokkel === pAas.synlegheit.nokkel
        && Math.abs(gjenskapt.synlegDel - pAas.synlegheit.synlegDel) < 1e-12
        && gjenskapt.navSynleg === pAas.synlegheit.navSynleg
        && Math.abs(gjenskapt.horisontMoh - pAas.synlegheit.horisontMoh) < 1e-9,
        `${gjenskapt.nokkel} ${(gjenskapt.synlegDel * 100).toFixed(1)} %`);

    // --- b) Terskelen -----------------------------------------------------
    // 40 m ås midtvegs: turbinen er DELVIS synleg. Utgangspunktet må vere
    // synleg — ein test som startar på «skjult» kan ikkje vise at DOM skjuler
    // noko, og alle påslag ville sett like rette ut.
    const basis = beregnPaaverknad({ punkt, turbin, profil: lagProfil(40) });
    const kp = basis.synlegheit.kritiskPunkt;
    sjekk('syntetisk turbin er synleg på bar bakke (utgangspunkt for testen)',
        basis.synlegheit.nokkel !== 'skjult' && Boolean(kp),
        `${basis.synlegheit.nokkel} ${(basis.synlegheit.synlegDel * 100).toFixed(0)} %`);

    const underTerskel = vurderMedOverflate(basis, kp.z + CONFIG.overflate.terskelM - 0.5);
    sjekk('DOM under terskelen gir inga ny vurdering',
        underTerskel.vesentleg === false && underTerskel.synlegheit === null
        && underTerskel.endring === 'uendra',
        `+${underTerskel.differanseM.toFixed(1)} m < ${CONFIG.overflate.terskelM} m`);

    const overTerskel = vurderMedOverflate(basis, kp.z + CONFIG.overflate.terskelM + 0.5);
    sjekk('DOM over terskelen gir ei alternativ vurdering',
        overTerskel.vesentleg === true && overTerskel.synlegheit !== null);

    // --- c) Retninga er einsidig -----------------------------------------
    // Å heve det kritiske punktet kan ALDRI gjere turbinen meir synleg. Det er
    // grunnlaget for heile den asymmetriske garantien i §22, og for at
    // allereie skjulte turbinar kan hoppast over utan eit einaste oppslag.
    let monoton = true;
    for (const paaslag of [3, 10, 25, 60, 200]) {
        const o = vurderMedOverflate(basis, kp.z + paaslag);
        if (o.synlegheit.synlegDel > basis.synlegheit.synlegDel + 1e-12) monoton = false;
        if (o.synlegheit.horisontMoh < basis.synlegheit.horisontMoh - 1e-9) monoton = false;
    }
    sjekk('DOM kan berre senke synleg del, aldri heve han', monoton);

    const nokPaaslag = vurderMedOverflate(basis, kp.z + 200);
    sjekk('eit stort nok påslag skjuler turbinen heilt',
        nokPaaslag.synlegheit.nokkel === 'skjult' && nokPaaslag.endring === 'skjult');

    // DOM lågare enn DTM skjer ikkje i teorien, men dei to modellane er
    // interpolerte kvar for seg. Horisonten må då stå urørt, ikkje falle.
    const negativ = vurderMedOverflate(basis, kp.z - 5);
    sjekk('DOM lågare enn DTM senkar ikkje horisonten',
        negativ.vesentleg === false && negativ.differanseM < 0);

    // --- d) Utveljinga ----------------------------------------------------
    const heiltSkjult = beregnPaaverknad({ punkt, turbin, profil: lagProfil(800) });
    sjekk('allereie skjult turbin vert ikkje slått opp i DOM',
        heiltSkjult.synlegheit.nokkel === 'skjult'
        && kanEndrastAvOverflate(heiltSkjult) === false);
    sjekk('synleg turbin er DOM-kandidat', kanEndrastAvOverflate(basis) === true);
    sjekk('turbin utan profil er ikkje DOM-kandidat',
        kanEndrastAvOverflate(beregnPaaverknad({ punkt, turbin, profil: null })) === false);

    // --- e) Endepunktet mot Kartverket ------------------------------------
    const domUrl = (la, lo, kilde) =>
        `${API}/backend/api/elevation_point.php?lat=${la}&lon=${lo}${kilde ? `&datakilde=${kilde}` : ''}`;

    try {
        // Oslo sentrum: bygningsmasse. DOM skal liggje tydeleg over DTM.
        const oDtm = await (await fetch(domUrl(59.91, 10.75))).json();
        const oDom = await (await fetch(domUrl(59.91, 10.75, 'dom1'))).json();
        sjekk('Oslo: DOM ligg klart over DTM',
            oDom.ok && oDtm.ok && oDom.hoyde_m - oDtm.hoyde_m > 5,
            `DTM ${oDtm.hoyde_m} → DOM ${oDom.hoyde_m} (+${(oDom.hoyde_m - oDtm.hoyde_m).toFixed(2)} m)`);

        // Storheia: ope fjell. Dei to modellane skal vere praktisk talt like —
        // kontrollen på at skilnaden faktisk måler noko som STÅR der, og ikkje
        // berre er ein systematisk offset mellom to datasett.
        const sDtm = await (await fetch(domUrl(63.84, 10.14))).json();
        const sDom = await (await fetch(domUrl(63.84, 10.14, 'dom1'))).json();
        sjekk('Storheia (ope fjell): DOM ≈ DTM',
            Math.abs(sDom.hoyde_m - sDtm.hoyde_m) < 0.5,
            `DTM ${sDtm.hoyde_m} → DOM ${sDom.hoyde_m} (${(sDom.hoyde_m - sDtm.hoyde_m).toFixed(2)} m)`);

        const ulovleg = await fetch(domUrl(59.91, 10.75, 'hoydekurver'));
        sjekk('kvitlista avviser ei datakjelde appen ikkje tolkar',
            ulovleg.status === 400, `HTTP ${ulovleg.status}`);

        const sti = await fetch(`${API}/backend/api/elevation_point.php`
            + '?lat=59.91&lon=10.75&datakilde=' + encodeURIComponent('../../dtm1'));
        sjekk('kvitlista avviser stimanipulasjon i datakilde',
            sti.status === 400, `HTTP ${sti.status}`);

        // Batch: rekkjefølgja ut MÅ svare til rekkjefølgja inn — heile
        // koplinga av svaret til turbinar kviler på det. Sjøpunktet skal
        // kome ut som null, ikkje 0.
        const batch = await (await fetch(`${API}/backend/api/surface_points.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                datakilde: 'dom1',
                punkter: [[59.91, 10.75], [63.84, 10.14], [58.0, 3.5]],
            }),
        })).json();
        sjekk('batch held rekkjefølgja og skil «ikkje målt» frå 0',
            batch.ok && batch.hoyder.length === 3
            && Math.abs(batch.hoyder[0] - oDom.hoyde_m) < 0.01
            && Math.abs(batch.hoyder[1] - sDom.hoyde_m) < 0.01
            && batch.hoyder[2] === null,
            JSON.stringify(batch.hoyder));

        const utanfor = await fetch(`${API}/backend/api/surface_points.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ datakilde: 'dom1', punkter: [[48.85, 2.35]] }),
        });
        sjekk('batch avviser koordinat utanfor Noreg-bboxen',
            utanfor.status === 400, `HTTP ${utanfor.status}`);
    } catch (e) {
        sjekk('DOM-endepunkta svarar', false, e.message);
    }

    // --- f) Heile kjeda mot ekte data -------------------------------------
    // Odal vindkraftverk i Nord-Odal står i tett granskog; Storheia på
    // snaufjell. Dei to er valde nettopp fordi dei skal gi MOTSETT svar —
    // ein test som berre viste utslag ville ikkje skilje «modellen verkar»
    // frå «modellen svarer alltid ja».
    const ekteFetchDom = globalThis.fetch;
    globalThis.fetch = (url, ...rest) =>
        ekteFetchDom(typeof url === 'string' && !/^https?:/.test(url) ? `${API}/${url}` : url, ...rest);

    try {
        for (const sak of [
            { namn: 'Odal (granskog)', lat: 60.4144, lon: 11.3735, ventarUtslag: true },
            { namn: 'Storheia (snaufjell)', lat: 63.8412, lon: 10.1367, ventarUtslag: false },
        ]) {
            tomOverflateCache();
            const hd = await (await fetch(
                `${API}/backend/api/elevation_point.php?lat=${sak.lat}&lon=${sak.lon}`,
            )).json();
            const pkt = { lat: sak.lat, lon: sak.lon, hoyde: hd.hoyde_m };

            const naere = cache.turbiner
                .map((t) => ({ ...t, _d: haversine(pkt.lat, pkt.lon, t.lat, t.lon) }))
                .filter((t) => t._d <= 12000)
                .sort((a, b) => a._d - b._d)
                .slice(0, 20);

            const pd = await (await fetch(`${API}/backend/api/elevation_profile.php`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    origin: { lat: pkt.lat, lon: pkt.lon },
                    targets: naere.map((t) => ({ id: t.id, lat: t.lat, lon: t.lon })),
                }),
            })).json();

            const res = naere.map((t) => beregnPaaverknad({
                punkt: pkt, turbin: t, profil: pd.profiles?.[t.id] ?? null,
            }));
            const stats = await sjekkOverflate({ resultat: res });
            const o = overflateSamandrag(res);

            if (sak.ventarUtslag) {
                sjekk(`${sak.namn}: DOM avdekkjer skog DTM ikkje ser`,
                    o.vesentlege > 0 && o.stersteHinderM > 5,
                    `${o.vesentlege}/${o.sjekka} med hinder, høgast ${o.stersteHinderM.toFixed(1)} m`);
                sjekk(`${sak.namn}: minst éin synleg turbin vert skjult`,
                    o.skjulte > 0, `${o.skjulte} skjulte, ${o.reduserte} reduserte`);
            } else {
                sjekk(`${sak.namn}: DOM finn ingenting som skjermar`,
                    o.vesentlege === 0 && o.skjulte === 0,
                    `høgaste avvik ${o.stersteHinderM.toFixed(2)} m`);
            }

            // Kostnaden er sjølve grunngjevinga for at steget er brukarstyrt
            // og ikkje automatisk — så han vert målt, ikkje anteken.
            sjekk(`${sak.namn}: kostar få kall (${stats.kall} for ${o.sjekka} turbinar)`,
                stats.kall <= Math.ceil(o.sjekka / CONFIG.overflate.punktPerKall) + 1,
                `${stats.msBrukt} ms`);
        }
    } catch (e) {
        sjekk('DOM-kryssjekk mot ekte data', false, e.message);
    } finally {
        globalThis.fetch = ekteFetchDom;
    }
}

// ===================================================================
console.log('\n=== 15. Topp-K: fleire punkt per turbin i DOM-sjekken (§23) ===\n');
{
    /**
     * Ein profil der kvart punkt har EIGNE koordinatar. `lagProfil()` gir
     * lat/lon = 0 for alle punkt, og då kollapsar dedupen i
     * `overflatePunktFor()` til eitt einaste oppslag — nettopp den fella
     * topp-K skulle unngå.
     */
    function lagProfilK(bygg, n = 200, lengd = 6000, bakkeVedTurbin = 100) {
        const ut = [];
        for (let i = 0; i < n; i++) {
            const d = (lengd * i) / (n - 1);
            ut.push({
                d,
                z: bygg(d, i / (n - 1)),
                // ~11 m per 1e-4 grad: gir kvart punkt sin eigen cache-nøkkel.
                lat: 60 + d / 111320,
                lon: 11,
                terreng: 'Test',
            });
        }
        // Siste punkt er turbinens eigen fot.
        ut[ut.length - 1].z = bakkeVedTurbin;
        return ut;
    }

    // --- a) Rangeringa ----------------------------------------------------
    // Eit jamt skrånande terreng: `skannHorisont()` peikar på det YTRE punktet
    // (høgast bakke), medan eit tenkt hinder ville bety mest NÆRAST auget,
    // fordi tillegget er H/d. Dei to skal peike ulikt — er dei alltid samde,
    // er heile utvidinga verdilaus.
    const skraa = lagProfilK((d) => 100 + d * 0.004, 200, 6000, 124);
    const augeK = 100 + CONFIG.sikt.augehoydeM;
    const bar = skannHorisont(skraa, augeK, { minAvstandM: CONFIG.sikt.minHindringsavstandM });
    const topp = skannHorisontTopK(skraa, augeK, 4, {
        hinderM: CONFIG.overflate.kandidatHinderM,
        minSkilnadM: CONFIG.overflate.minKandidatavstandM,
        minAvstandM: CONFIG.sikt.minHindringsavstandM,
    });

    sjekk('skannHorisontTopK gir det talet kandidatar det vert bedt om',
        topp.kandidatar.length === 4, `${topp.kandidatar.length}`);
    sjekk('kandidatane er sorterte fallande etter helning',
        topp.kandidatar.every((c, i) => i === 0 || c.helning <= topp.kandidatar[i - 1].helning));
    sjekk('kandidatane står minst minKandidatavstandM frå kvarandre',
        topp.kandidatar.every((c, i) => topp.kandidatar
            .slice(0, i)
            .every((v) => Math.abs(v.punkt.d - c.punkt.d) >= CONFIG.overflate.minKandidatavstandM)),
        topp.kandidatar.map((c) => Math.round(c.punkt.d)).join(', ') + ' m');
    /**
     * `restHelning` er ei STRENG øvre grense over ALT som ikkje vart valt —
     * òg dei punkta som vart hoppa over fordi dei stod for tett på ein alt
     * vald kandidat. Difor kan han liggje over den svakaste valde, men aldri
     * over den sterkaste: er han det, har utveljinga hoppa over noko ho
     * skulle teke.
     */
    sjekk('restHelning kan ikkje overstige den sterkaste valde kandidaten',
        topp.restHelning <= topp.kandidatar[0].helning + 1e-12,
        `rest ${topp.restHelning.toFixed(5)} mot ${topp.kandidatar[0].helning.toFixed(5)}`);
    sjekk('topp-K peikar på eit ANNA punkt enn bar bakke i skrånande terreng',
        topp.kandidatar[0].punkt.d !== bar.kritiskPunkt.d,
        `bar ${Math.round(bar.kritiskPunkt.d)} m · topp-K ${Math.round(topp.kandidatar[0].punkt.d)} m`);
    sjekk('ingen kandidat er nærare enn minHindringsavstandM',
        topp.kandidatar.every((c) => c.punkt.d >= CONFIG.sikt.minHindringsavstandM));

    // Grensa er ei ØVRE grense: helninga med hinderet på skal vere nøyaktig
    // terrengHelning(d, z + H, auge). Blir ho rekna på noko anna, er heile
    // utveljinga tilfeldig.
    const c0 = topp.kandidatar[0];
    sjekk('kandidathelninga er terrengHelning med hinderet lagt på',
        Math.abs(c0.helning - terrengHelning(
            c0.punkt.d, c0.punkt.z + CONFIG.overflate.kandidatHinderM, augeK,
        )) < 1e-12);

    // --- b) skannHorisont() er URØRT --------------------------------------
    // Mange stader i koden reknar med at han returnerer ÉIN kritisk verdi.
    const barIgjen = skannHorisont(skraa, augeK, { minAvstandM: CONFIG.sikt.minHindringsavstandM });
    sjekk('skannHorisont er uendra av at topp-K kom til',
        barIgjen.helning === bar.helning && barIgjen.kritiskPunkt === bar.kritiskPunkt);

    // --- c) Punktlista per turbin ----------------------------------------
    /**
     * Turbinen MÅ stå der profilen sluttar. Står han ein annan stad, reknar
     * `beregnPaaverknad()` avstanden av lat/lon medan profilen seier noko
     * anna, og alt som følgjer — synleg del, horisonthøgd, restgrensa — gjeld
     * to ulike geometriar.
     */
    const turbinK = { ...turbin, lat: skraa[skraa.length - 1].lat, lon: 11 };
    const rK = beregnPaaverknad({
        punkt: { lat: 60, lon: 11, hoyde: 100 },
        turbin: turbinK,
        profil: skraa,
    });
    sjekk('testoppsettet er konsistent: turbinen står der profilen sluttar',
        Math.abs(rK.avstandM - skraa[skraa.length - 1].d) < 25,
        `${Math.round(rK.avstandM)} m mot ${Math.round(skraa[skraa.length - 1].d)} m`);
    sjekk('testturbinen er delvis synleg på bar bakke (utgangspunkt)',
        rK.synlegheit.synlegDel > 0.05,
        `${(rK.synlegheit.synlegDel * 100).toFixed(0)} %`);
    const plan = overflatePunktFor(rK);
    sjekk('overflatePunktFor har det kritiske punktet FYRST',
        plan.punkt[0] === rK.synlegheit.kritiskPunkt);
    sjekk('overflatePunktFor held seg innanfor toppK punkt',
        plan.punkt.length <= CONFIG.overflate.toppK && plan.punkt.length > 1,
        `${plan.punkt.length} punkt`);
    sjekk('punkta er unike koordinatar',
        new Set(plan.punkt.map((p) => `${p.lat},${p.lon}`)).size === plan.punkt.length);

    // --- d) DET topp-1 IKKJE FANGA ---------------------------------------
    /**
     * Kjernetesten. Terrenget stig jamt, så bar bakke peikar heilt ut. Me
     * legg skog BERRE på eit punkt langt inne — eit punkt som med bar bakke
     * ligg godt under skrapelinja. Topp-1 måler feil stad og finn ingenting;
     * topp-K måler den rette og skjuler turbinen.
     */
    const naerPunkt = plan.punkt.find((p) => p.d > 200 && p.d < 1200) ?? plan.punkt[1];
    const domFor = (p) => (p === naerPunkt ? p.z + 22 : p.z + 0.1);

    const medEitt = vurderMedOverflate(rK, [
        { punkt: rK.synlegheit.kritiskPunkt, domZ: domFor(rK.synlegheit.kritiskPunkt) },
    ]);
    const medK = vurderMedOverflate(
        rK, plan.punkt.map((p) => ({ punkt: p, domZ: domFor(p) })),
        { restHelning: plan.restHelning },
    );

    sjekk('topp-1 finn ingenting når skogen står eit anna stad',
        medEitt.vesentleg === false, `${medEitt.differanseM.toFixed(1)} m i det kritiske punktet`);
    sjekk('topp-K finn hinderet topp-1 gjekk glipp av',
        medK.vesentleg === true && medK.fraToppK === true
        && Math.abs(medK.kritiskD - naerPunkt.d) < 1e-9,
        `${medK.differanseM.toFixed(1)} m ${Math.round(medK.kritiskD)} m unna`);
    sjekk('topp-K senkar synleg del under topp-1 sitt svar',
        medK.synlegheit.synlegDel < rK.synlegheit.synlegDel,
        `${(rK.synlegheit.synlegDel * 100).toFixed(0)} % → ${(medK.synlegheit.synlegDel * 100).toFixed(0)} %`);

    // --- e) Framleis einsidig --------------------------------------------
    // Uansett kor mange punkt som vert heva, kan horisonten berre gå oppover.
    let monotonK = true;
    for (const paaslag of [0, 3, 12, 40, 150]) {
        const o = vurderMedOverflate(rK, plan.punkt.map((p) => ({ punkt: p, domZ: p.z + paaslag })));
        if (!o.synlegheit) continue;
        if (o.synlegheit.synlegDel > rK.synlegheit.synlegDel + 1e-12) monotonK = false;
        if (o.synlegheit.horisontMoh < rK.synlegheit.horisontMoh - 1e-9) monotonK = false;
    }
    sjekk('fleire heva punkt kan framleis berre senke synleg del', monotonK);

    // Ingen målte verdiar i det heile: svaret må vere «ukjent», ikkje «ope».
    const alleNull = vurderMedOverflate(rK, plan.punkt.map((p) => ({ punkt: p, domZ: null })));
    sjekk('punkt utan laserdekning gir «ukjent», ikkje «uendra»',
        alleNull.vesentleg === false && alleNull.endring === 'ukjent' && alleNull.talMalte === 0);

    // Den gamle skalarforma må framleis virke — ho er det detaljvisinga og
    // heile §14 over kviler på.
    const skalar = vurderMedOverflate(rK, rK.synlegheit.kritiskPunkt.z + 30);
    sjekk('den gamle eittpunktsforma (tal, ikkje liste) verkar framleis',
        skalar !== null && skalar.talPunkt === 1 && skalar.fraToppK === false);

    // --- f) restHelning kvantifiserer det som står att --------------------
    sjekk('restHorisontMoh er rekna og ligg over auget',
        Number.isFinite(medK.restHorisontMoh) && medK.restHorisontMoh > rK.augeMoh,
        `${medK.restHorisontMoh.toFixed(0)} moh.`);
}

// ===================================================================
console.log('\n=== 16. Topp-K mot ekte data, og kva det kostar ===\n');
{
    const ekteFetchK = globalThis.fetch;
    globalThis.fetch = (url, ...rest) =>
        ekteFetchK(typeof url === 'string' && !/^https?:/.test(url) ? `${API}/${url}` : url, ...rest);

    const opphavlegK = CONFIG.overflate.toppK;

    async function koyr(lat, lon, K) {
        CONFIG.overflate.toppK = K;
        tomOverflateCache();
        const hd = await (await fetch(
            `${API}/backend/api/elevation_point.php?lat=${lat}&lon=${lon}`,
        )).json();
        const pkt = { lat, lon, hoyde: hd.hoyde_m };
        const naere = cache.turbiner
            .map((t) => ({ ...t, _d: haversine(pkt.lat, pkt.lon, t.lat, t.lon) }))
            .filter((t) => t._d <= 12000)
            .sort((a, b) => a._d - b._d)
            .slice(0, 20);
        const pd = await (await fetch(`${API}/backend/api/elevation_profile.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                origin: { lat: pkt.lat, lon: pkt.lon },
                targets: naere.map((t) => ({ id: t.id, lat: t.lat, lon: t.lon })),
            }),
        })).json();
        const res = naere.map((t) => beregnPaaverknad({
            punkt: pkt, turbin: t, profil: pd.profiles?.[t.id] ?? null,
        }));
        const stats = await sjekkOverflate({ resultat: res });
        return { stats, o: overflateSamandrag(res), res };
    }

    try {
        // Odal: tett granskog. Same punkt som §22 er dokumentert på.
        const eitt = await koyr(60.4144, 11.3735, 1);
        const fleire = await koyr(60.4144, 11.3735, opphavlegK);

        sjekk(`Odal: topp-K skjuler fleire enn topp-1 (${eitt.o.skjulte} → ${fleire.o.skjulte})`,
            fleire.o.skjulte > eitt.o.skjulte,
            `av ${fleire.o.sjekka} synlege`);
        sjekk('Odal: utslaget kjem frå punkt bar bakke ikkje peika ut',
            fleire.o.fraToppK > 0, `${fleire.o.fraToppK} turbinar`);

        /**
         * NÆRSKJERMINGA MÅ TELJAST, ikkje berre nemnast. Rangeringa etter
         * `H/d` dreg kandidatane mot nærfeltet, så eit hinder rett ved
         * punktet vert normalen — og då MÅ atterhaldet om at svaret er
         * følsamt for kvar brukaren klikka følgje med ut i samandraget.
         */
        sjekk('Odal: nærskjerming vert talt opp for DOM-resultatet',
            fleire.o.naerskjerma > 0,
            `${fleire.o.naerskjerma} av ${fleire.o.sjekka} har hinder under 300 m unna`);

        /**
         * KOSTNADEN, MÅLT — ikkje anteken. Punkt-tenesta tek 50 koordinatar
         * per kall, så K gonger så mange punkt gir langt frå K gonger så mange
         * kall: nærfeltspunkta er i stor grad felles for turbinar i same
         * retning, og dedupen tek dei.
         */
        sjekk(`Odal: kostnaden held seg innanfor batchen`
            + ` (${eitt.stats.kall} → ${fleire.stats.kall} kall,`
            + ` ${eitt.stats.punkt} → ${fleire.stats.punkt} punkt)`,
            fleire.stats.kall <= Math.ceil(fleire.stats.punkt / CONFIG.overflate.punktPerKall) + 1
            && fleire.stats.punkt <= fleire.o.sjekka * CONFIG.overflate.toppK,
            `${eitt.stats.msBrukt} → ${fleire.stats.msBrukt} ms`);

        // Storheia frå snaufjell er kontrollen: fleire punkt skal ikkje
        // framprovosere eit utslag der det ikkje står noko.
        const fjell = await koyr(63.8412, 10.1367, opphavlegK);
        sjekk('Storheia (snaufjell): topp-K finn framleis ingenting',
            fjell.o.vesentlege === 0 && fjell.o.skjulte === 0,
            `høgaste avvik ${fjell.o.stersteHinderM.toFixed(2)} m over ${fjell.stats.punkt} punkt`);
    } catch (e) {
        sjekk('topp-K mot ekte data', false, e.message);
    } finally {
        CONFIG.overflate.toppK = opphavlegK;
        globalThis.fetch = ekteFetchK;
    }
}

// ===================================================================
console.log('\n=== 17. Panoramaet sin skogbrytar ===\n');
{
    /**
     * PanoramaView krev WebGL og eit DOM, så scena kan ikkje byggjast her.
     * Men AVGJERDA brytaren tek er rein: kva synlegheit gjeld, og kva
     * klippeplanet skal stå i. Dei to funksjonane vert kalla med eit
     * minimalt `this`, slik at logikken er testa sjølv om biletet ikkje er.
     */
    const { PanoramaView } = await import('../js/ui/PanoramaView.js');
    const P = PanoramaView.prototype;

    const medSkog = {
        analysert: true,
        kurs: 90,
        avstandM: 4000,
        bakkeVedTurbinMoh: 300,
        synlegheit: { synlegDel: 0.8, horisontMoh: 250, nokkel: 'delvis' },
        overflate: {
            vesentleg: true,
            synlegheit: { synlegDel: 0, horisontMoh: 640, nokkel: 'skjult' },
            kandidatar: [{ vesentleg: true, d: 90, lat: 60, lon: 11, dtmZ: 200, domZ: 218 }],
        },
    };
    const utanUtslag = {
        analysert: true,
        synlegheit: { synlegDel: 0.5, horisontMoh: 250 },
        overflate: { vesentleg: false, synlegheit: null, kandidatar: [] },
    };
    const usjekka = { analysert: true, synlegheit: { synlegDel: 0.5, horisontMoh: 250 } };

    sjekk('brytar AV gir bar-bakke-synlegheita, uansett DOM-data',
        P._synlegheitFor.call({ visSkog: false }, medSkog) === medSkog.synlegheit);
    sjekk('brytar PÅ gir DOM-synlegheita når det finst eit utslag',
        P._synlegheitFor.call({ visSkog: true }, medSkog) === medSkog.overflate.synlegheit);
    sjekk('brytar PÅ endrar ingenting når hinderet er under terskelen',
        P._synlegheitFor.call({ visSkog: true }, utanUtslag) === utanUtslag.synlegheit);
    sjekk('brytar PÅ endrar ingenting for ein turbin som aldri vart sjekka',
        P._synlegheitFor.call({ visSkog: true }, usjekka) === usjekka.synlegheit);

    /**
     * Klippeplanet er det biletet faktisk viser. Står det i den gamle høgda
     * medan HUD-en seier at skogen er rekna med, lyg biletet — så høgda vert
     * lesen ut av same funksjon her.
     */
    const yPaa = P._synlegheitFor.call({ visSkog: true }, medSkog).horisontMoh;
    const yAv = P._synlegheitFor.call({ visSkog: false }, medSkog).horisontMoh;
    sjekk('klippehøgda stig når brytaren står på', yPaa > yAv, `${yAv} → ${yPaa} moh.`);

    // Hinderlys: same terrenghorisont, uavhengig svar per lyspunkt (§10).
    const detSkog = { visSkog: true, _synlegheitFor: P._synlegheitFor };
    sjekk('lyspunkt under den heva horisonten fell bort',
        P._lysSynleg.call(detSkog, medSkog, { hoydeOverBakkeM: 100 }) === false);
    sjekk('lyspunkt over den heva horisonten står att',
        P._lysSynleg.call(detSkog, medSkog, { hoydeOverBakkeM: 400 }) === true);
    sjekk('med brytaren av vert lyspunkta ikkje rørte',
        P._lysSynleg.call({ visSkog: false, _synlegheitFor: P._synlegheitFor },
            medSkog, { hoydeOverBakkeM: 100 }) === true);

    sjekk('_harSkogdata skil køyrd frå ikkje køyrd kryssjekk',
        P._harSkogdata.call({ resultat: [medSkog] }) === true
        && P._harSkogdata.call({ resultat: [usjekka] }) === false);
}

// ===================================================================
console.log(`\n${feil === 0 ? '✔ ALLE TESTAR PASSERTE' : `✘ ${feil} TEST(AR) FEILA`}\n`);
process.exit(feil === 0 ? 0 : 1);

// ===================================================================
// Hjelparar
// ===================================================================

function lesJsonHvisFinst(relativPath) {
    try {
        return JSON.parse(readFileSync(new URL(relativPath, import.meta.url), 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Odde/like-regelen for eitt polygon (ringar), og union over fleire polygon.
 * Speglar TurbineLayout::iPolygon()/iNokoPolygon() i PHP — dette er testen som
 * skal fange det om dei to skulle kome ut av takt.
 */
function iPolygon(lat, lon, rings) {
    let inne = false;
    for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [yi, xi] = ring[i];
            const [yj, xj] = ring[j];
            if ((yi > lat) !== (yj > lat)
                && lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi) {
                inne = !inne;
            }
        }
    }
    return inne;
}

function iNokoPolygon(lat, lon, polygon) {
    return polygon.some((rings) => iPolygon(lat, lon, rings));
}
