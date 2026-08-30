<?php
/**
 * backend/services/TurbineSpec.php
 *
 * Estimerer fysiske turbinmål (navhøgde, rotordiameter, lydeffekt) ut frå
 * merkeeffekt per turbin.
 *
 * ---------------------------------------------------------------------------
 * VIKTIG DATAGRUNNLAG-ATTERHALD (jf. PLAN.md §7)
 * ---------------------------------------------------------------------------
 * NVE sitt `Vindkraft2`-datasett inneheld IKKJE navhøgde eller rotordiameter —
 * verken på turbinlaget (lag 4) eller anleggslaget (lag 0). Det er verifisert
 * mot `?f=json` på begge laga; felta finst rett og slett ikkje.
 *
 * Det me faktisk har frå kjelda er `effekt_mw` og `antallturbiner` på
 * anleggsnivå. Merkeeffekt per turbin er ein god prediktor for storleik, sidan
 * rotorareal og effekt heng tett saman for landbaserte turbinar av same
 * generasjon. Difor interpolerer me mot ein tabell av reelle, kjende
 * turbinmodellar som faktisk er i bruk i norske anlegg.
 *
 * Alle verdiar denne klassa produserer er difor ESTIMAT, og vert merkte
 * `mal_kilde = "estimert"` i cachen slik at UI-et alltid kan seie tydeleg frå.
 * Berre bruk dei til illustrasjon — aldri som fasit.
 *
 * ---------------------------------------------------------------------------
 * UNNTAKET: KURATERTE, KJELDEFØRTE MÅL
 * ---------------------------------------------------------------------------
 * For eit lite tal namngjevne anlegg har me lese dei faktiske søknads- eller
 * meldingsdokumenta og funne konkrete tal. Dei ligg i
 * `backend/data/turbine_specs_known.json` og vert slått opp av
 * `KnownSpecRegistry`. `resolve()` sjekkar ALLTID det registeret først, og
 * fell berre tilbake til `estimate()` når anlegget ikkje står der.
 * Kuraterte mål vert merkte `mal_kilde = "kjent_soknad"` og ber kjelde-URL
 * heilt fram til UI.
 */

require_once __DIR__ . '/KnownSpecRegistry.php';

class TurbineSpec
{
    /**
     * Referansepunkt: [merkeeffekt MW, navhøgde m, rotordiameter m].
     *
     * Henta frå spesifikasjonar for turbinmodellar som faktisk er installerte i
     * norske landbaserte anlegg. Tabellen er sortert stigande på effekt, og
     * verdiar mellom punkta vert lineært interpolerte.
     *
     *   0.85 MW  Vestas V52-850            (eldre anlegg)
     *   2.00 MW  Vestas V80-2.0            (t.d. Smøla I)
     *   2.30 MW  Siemens SWT-2.3-93        (t.d. Smøla II)
     *   3.00 MW  Vestas V112-3.0
     *   3.60 MW  Siemens SWT-DD-130        (t.d. Storheia, Roan)
     *   4.20 MW  Vestas V136-4.2
     *   4.30 MW  Vestas V150-4.2
     *   5.60 MW  Nordex N149/5.X           (t.d. Øyfjellet)
     *
     * ---------------------------------------------------------------------
     * DEI TRE ØVERSTE PUNKTA (revidert 2026-08)
     * ---------------------------------------------------------------------
     * Tabellen toppa tidlegare ut på [8.00, 120.0, 170.0] — 205 m totalhøgd —
     * og gav difor altfor låge tal for dei store, nye sakene. Reelle norske
     * søknader i 6–9 MW-klassa ber no om **220–260 m totalhøgd** (sjå
     * `backend/data/turbine_specs_known.json`), som tabellen ikkje kunne nå
     * uansett effekt.
     *
     * Feilen var navhøgda, ikkje rotoren. Gjennomgang av produsentdatablad for
     * heile 6–7 MW-klassa som faktisk vert seld i Europa 2024–2026 viser eit
     * tydeleg mønster:
     *
     *   **Rotordiameteren mettar; det er tårnet som veks.** Kvar einaste modell
     *   frå 6,2 til 7,2 MW ligg i bandet 162–175 m rotor, og INGEN landbasert
     *   turbin i Europa har rotor over ~175 m. Same rotorane vert samstundes
     *   tilbodne med nav på 165–199 m. Eit nav på 120 m er eit 2018-tal.
     *
     *   6.60 MW  Siemens Gamesa SG 6.6-170  – rotor 170 m, tårnportefølje
     *            100–165 m nav. Vestas V162-6.2 EnVentus (rotor 162, nav opp
     *            til 169) og Nordex N175/6.X (rotor 175, nav opp til 179)
     *            ligg i same band. Nav 150 m er midt i øvre halvdel.
     *            https://assets.siemens-energy.com/dam/7f26c8be-cf4e-4698-af5e-b29c0114fb29/2025-Feb-SG-7-0-170_EN-pdf_Original%20file.pdf
     *   7.20 MW  Vestas V172-7.2 EnVentus  – rotor 172 m, nav 114–199 m.
     *            Siemens SG 7.0-170 gir nav opp til 185 m på 170 m rotor.
     *            https://www.vestas.com/en/energy-solutions/onshore-wind-turbines/enventus-platform/V172-7-2-MW
     *   9.00 MW  REINT EKSTRAPOLASJONSPUNKT. Det finst ingen landbasert turbin
     *            over 7,2 MW i sal i Europa — 8–9 MW i norske søknader er
     *            "takhøgd" i konsesjonsramma, ikkje ein katalogvare. Difor
     *            held me rotoren på den fysiske grensa (~175 m, jf. Enercon
     *            E-175 EP5 og Nordex N175/6.X) og lèt navhøgda bere veksten.
     *            Landar på 257,5 m totalhøgd, som svarar til taket i dei
     *            søknadene som faktisk ligg inne no.
     *
     * Punkta til og med 5.60 MW er URØRTE med vilje: dei er kalibrerte mot
     * turbinar som faktisk STÅR i norske anlegg (Storheia → 87/130,
     * Øyfjellet → 105/149), og den treffsikkerheita skal ikkje ofrast for å
     * få opp toppen av tabellen.
     */
    private const REFERENCE_MODELS = [
        [0.15, 30.0,  25.0],
        [0.50, 40.0,  39.0],
        [0.85, 50.0,  52.0],
        [2.00, 70.0,  80.0],
        [2.30, 80.0,  93.0],
        [3.00, 84.0, 112.0],
        [3.60, 87.0, 130.0],
        [4.20, 92.0, 136.0],
        [4.30, 105.0, 150.0],
        [5.60, 105.0, 149.0],
        [6.60, 150.0, 170.0],
        [7.20, 160.0, 172.0],
        [9.00, 170.0, 175.0],
    ];

    /**
     * Default når merkeeffekt per turbin er heilt ukjend.
     * Sett mot ein moderne landbasert turbin (~4 MW-klassa), som er medianen
     * i det norske datasettet (verifisert: median 4.0 MW/turbin over 61 anlegg).
     */
    public const DEFAULT_HUB_HEIGHT_M     = 92.0;
    public const DEFAULT_ROTOR_DIAMETER_M = 136.0;
    public const DEFAULT_SOUND_POWER_DBA  = 106.0;

    /**
     * Minste bakkeklaring under nedste vengetupp, i meter. Brukast berre som
     * plausibilitetsgrense når me utleier navhøgd frå ei kjend totalhøgd.
     * Landbaserte turbinar ligg typisk på 25–40 m; 15 m er ei romsleg nedre
     * grense som berre slår inn når rekninga elles ville gitt noko umogleg.
     */
    private const MIN_BAKKEKLARING_M = 15.0;

    /**
     * Fysisk øvre grense for rotordiameter på LAND, i meter.
     *
     * Gjennomgang av produsentkatalogane for 2024–2026 gir ingen landbasert
     * turbin over ~175 m rotor (Enercon E-175 EP5, Nordex N175/6.X er dei
     * største). 180 m er sett som ei romsleg grense over det.
     *
     * Grensa trengst av di søknadsdokument oppgir SPENN som ikkje skildrar éin
     * bestemt turbin: Nordkyn og Kjøllefjord melder «navhøgd 105–120 m» og
     * «totalhøgd 180–220 m» i same dokument. Tek ein øvre ende av begge, følgjer
     * det ein rotor på 2·(220−120) = 200 m — ein maskin som ikkje finst. Dei to
     * maksimumstala skildrar kvar sin ende av eit moglegheitsrom, ikkje same
     * turbin. Då er totalhøgda det talet som betyr noko for visuell påverknad,
     * og rotoren vert henta frå effektklassa i staden.
     */
    private const MAX_ROTOR_M = 180.0;

    /**
     * Estimer navhøgde og rotordiameter frå merkeeffekt per turbin.
     *
     * @param float|null $ratedMw Merkeeffekt for EIN turbin, i MW. Null = ukjend.
     * @return array{nav_hoyde_m:float, rotor_diameter_m:float, totalhoyde_m:float, effekt_mw:?float, lydeffekt_dba:float, mal_kilde:string}
     */
    public static function estimate(?float $ratedMw): array
    {
        if ($ratedMw === null || $ratedMw <= 0) {
            $hub   = self::DEFAULT_HUB_HEIGHT_M;
            $rotor = self::DEFAULT_ROTOR_DIAMETER_M;
            $lwa   = self::DEFAULT_SOUND_POWER_DBA;
        } else {
            [$hub, $rotor] = self::interpolate($ratedMw);
            $lwa = self::soundPower($ratedMw);
        }

        return [
            'nav_hoyde_m'      => round($hub, 1),
            'rotor_diameter_m' => round($rotor, 1),
            // Vengetupp-høgde over bakken: nav + halv rotor.
            'totalhoyde_m'     => round($hub + $rotor / 2, 1),
            'effekt_mw'        => $ratedMw !== null ? round($ratedMw, 2) : null,
            'lydeffekt_dba'    => round($lwa, 1),
            'mal_kilde'        => 'estimert',
        ];
    }

    /**
     * Hovudinngangen: kuratert kjeldeført verdi først, generisk estimat elles.
     *
     * @param float|null  $ratedMw   Merkeeffekt for EIN turbin, i MW. Null = ukjend.
     * @param int|null    $anleggsnr NVE-anleggsnr (den pålitelege oppslagsnøkkelen).
     * @param string|null $navn      Anleggnamn (fallback-nøkkel, normalisert).
     * @return array<string,mixed>
     */
    public static function resolve(?float $ratedMw, ?int $anleggsnr = null, ?string $navn = null): array
    {
        $known = KnownSpecRegistry::lookup($anleggsnr, $navn);
        if ($known !== null) {
            $spec = self::fromKnown($known, $ratedMw);
            if ($spec !== null) {
                return $spec;
            }
        }
        return self::estimate($ratedMw);
    }

    /**
     * Bygg ein spec frå ei kuratert oppføring.
     *
     * Kjeldene oppgir sjeldan alle tre måla. Reglane for å fylle ut resten er
     * strengt aritmetiske der det går, og elles proporsjonale:
     *
     *   nav + rotor  → total = nav + rotor/2
     *   nav + total  → rotor = 2·(total − nav)
     *   rotor + total→ nav   = total − rotor/2
     *   berre total  → rotor frå generisk tabell for effektklassa, og LEGG HEILE
     *                  resten i tårnet: nav = total − rotor/2.
     *   berre nav /
     *   berre rotor  → det andre målet frå generisk tabell, total reknast ut.
     *
     * **Kvifor «berre total» ikkje skalerer begge måla proporsjonalt:**
     * Rotordiameteren er ein eigenskap ved sjølve maskina — bladlengda er sett
     * av produsenten og finst berre i eit fåtal steg. Tårnhøgda er derimot den
     * frie variabelen: same turbin vert seld med tårn frå ~100 til ~180 m, og
     * det er nettopp tårnet utbyggjarane strekkjer for å nå betre vind. Å skalere
     * begge like mykje gav ein 216 m rotor for eit 260 m-anlegg — ein storleik
     * som ikkje finst på land. Med regelen over gir 260 m totalhøgd i staden
     * nav ≈ 175 m, som stemmer med Høgknøsen-planinitiativet (nav inntil 170 m,
     * totalhøgd inntil 260 m) — eit uavhengig prosjekt som oppgir BEGGE tala.
     *
     * Fell den regelen under den fysiske grensa (navet må vere høgare enn halve
     * rotoren pluss bakkeklaring), skalerer me proporsjonalt likevel.
     *
     * Felt som er utleidde (ikkje lesne i kjelda) vert lista i `mal_utleidd`,
     * slik at UI kan skilje det som står i søknaden frå det me har rekna oss
     * fram til.
     *
     * @param array<string,mixed> $known
     * @return array<string,mixed>|null null om oppføringa manglar alle tre måla
     */
    private static function fromKnown(array $known, ?float $ratedMw): ?array
    {
        $hub   = self::visingsverdi($known['nav_hoyde_m']      ?? null);
        $rotor = self::visingsverdi($known['rotor_diameter_m'] ?? null);
        $tip   = self::visingsverdi($known['totalhoyde_m']     ?? null);

        if ($hub === null && $rotor === null && $tip === null) {
            return null; // ingenting å gå på — la generisk estimering ta over
        }

        // Effekt: kjelda sitt spenn vinn over det me har rekna frå anleggsdata,
        // sidan `effekt_mw / antallturbiner` sjeldan er meiningsfullt for saker
        // under behandling (turbintalet er ofte tomt eller eit maksanslag).
        $mw = self::visingsverdi($known['effekt_mw_per_turbin'] ?? null) ?? $ratedMw;

        // Generisk referanse for same effektklasse, til å fylle hol med.
        [$genHub, $genRotor] = ($mw !== null && $mw > 0)
            ? self::interpolate($mw)
            : [self::DEFAULT_HUB_HEIGHT_M, self::DEFAULT_ROTOR_DIAMETER_M];

        $utleidd = [];

        if ($hub !== null && $rotor !== null) {
            if ($tip === null) { $tip = $hub + $rotor / 2; $utleidd[] = 'totalhoyde_m'; }
        } elseif ($hub !== null && $tip !== null) {
            $rotor = 2 * ($tip - $hub);
            $utleidd[] = 'rotor_diameter_m';
            // Gir dei to maksimumstala ein rotor som ikkje finst på land, er
            // dei henta frå kvar sin ende av moglegheitsrommet (sjå
            // MAX_ROTOR_M). Behald totalhøgda og lat tårnet ta resten.
            if ($rotor > self::MAX_ROTOR_M) {
                $rotor = min($genRotor, self::MAX_ROTOR_M);
                $hub   = $tip - $rotor / 2;
                $utleidd[] = 'nav_hoyde_m';
            }
        } elseif ($rotor !== null && $tip !== null) {
            $hub = $tip - $rotor / 2;
            $utleidd[] = 'nav_hoyde_m';
        } elseif ($tip !== null) {
            $rotor = $genRotor;
            $hub   = $tip - $rotor / 2;
            // Bakkeklaring: navet må stå høgare enn halve rotoren + margin,
            // elles ville blada skrapt bakken. Held ikkje det, er den generiske
            // rotoren for stor for denne totalhøgda — skaler begge i staden.
            if ($hub < $rotor / 2 + self::MIN_BAKKEKLARING_M) {
                $genTip = $genHub + $genRotor / 2;
                $k      = $genTip > 0 ? $tip / $genTip : 1.0;
                $hub    = $genHub * $k;
                $rotor  = $genRotor * $k;
            }
            $utleidd[] = 'nav_hoyde_m';
            $utleidd[] = 'rotor_diameter_m';
        } elseif ($hub !== null) {
            $rotor = $genRotor;
            $tip   = $hub + $rotor / 2;
            $utleidd[] = 'rotor_diameter_m';
            $utleidd[] = 'totalhoyde_m';
        } else { // berre rotor
            $hub = $genHub;
            $tip = $hub + $rotor / 2;
            $utleidd[] = 'nav_hoyde_m';
            $utleidd[] = 'totalhoyde_m';
        }

        // Vern mot ei openbert feilført oppføring (t.d. total < nav).
        if ($hub <= 0 || $rotor <= 0 || $tip <= 0) {
            return null;
        }

        $out = [
            'nav_hoyde_m'      => round($hub, 1),
            'rotor_diameter_m' => round($rotor, 1),
            'totalhoyde_m'     => round($tip, 1),
            'effekt_mw'        => $mw !== null ? round($mw, 2) : null,
            'lydeffekt_dba'    => round($mw !== null && $mw > 0 ? self::soundPower($mw) : self::DEFAULT_SOUND_POWER_DBA, 1),
            'mal_kilde'        => 'kjent_soknad',
            'mal_kjelde_url'   => (string) $known['kjelde_url'],
        ];

        foreach (['kjelde_dato' => 'mal_kjelde_dato', 'kjelde_status' => 'mal_kjelde_status', 'notat' => 'mal_notat'] as $src => $dst) {
            if (!empty($known[$src])) {
                $out[$dst] = (string) $known[$src];
            }
        }

        // Heile spennet, der kjelda oppgav eit. UI viser «inntil X m, jf. søknad».
        $spenn = [];
        foreach (['nav_hoyde_m', 'rotor_diameter_m', 'totalhoyde_m', 'effekt_mw_per_turbin'] as $felt) {
            $r = self::spennPar($known[$felt] ?? null);
            if ($r !== null) {
                $spenn[$felt] = $r;
            }
        }
        if ($spenn !== []) {
            $out['mal_spenn'] = $spenn;
        }
        if ($utleidd !== []) {
            $out['mal_utleidd'] = $utleidd;
        }
        if (!empty($known['antall_turbiner'])) {
            $n = self::spennPar($known['antall_turbiner']);
            $out['mal_antall_turbiner'] = $n ?? [(int) self::visingsverdi($known['antall_turbiner']), (int) self::visingsverdi($known['antall_turbiner'])];
        }

        return $out;
    }

    /**
     * Visingsverdi frå eit felt som anten er eit tal eller eit spenn.
     *
     * **Øvre ende vinn.** Appen skal illustrere kva ei utbygging KAN innebere;
     * i eit slikt verktøy er det meir ansvarleg å vise for høgt enn for lågt.
     * Spennet vert uansett teke vare på og vist ved sida av.
     *
     * @param mixed $v
     */
    private static function visingsverdi($v): ?float
    {
        if ($v === null || $v === '') {
            return null;
        }
        if (is_array($v)) {
            $max = $v['max'] ?? $v['maks'] ?? null;
            if ($max !== null) return (float) $max;
            $min = $v['min'] ?? null;
            return $min !== null ? (float) $min : null;
        }
        return (float) $v;
    }

    /**
     * [min, max] for eit felt, men BERRE når kjelda faktisk oppgav eit spenn.
     * Eit eksakt tal gir null, så UI slepp å skrive «inntil 130–130 m».
     *
     * @param mixed $v
     * @return array{0:float,1:float}|null
     */
    private static function spennPar($v): ?array
    {
        if (!is_array($v)) {
            return null;
        }
        $min = $v['min'] ?? null;
        $max = $v['max'] ?? $v['maks'] ?? null;
        if ($min === null || $max === null || (float) $min >= (float) $max) {
            return null;
        }
        return [(float) $min, (float) $max];
    }

    /**
     * Lineær interpolasjon i referansetabellen. Klemt til endepunkta utanfor
     * det området tabellen dekkjer.
     *
     * @return array{0:float, 1:float} [navhøgde, rotordiameter]
     */
    private static function interpolate(float $mw): array
    {
        $table = self::REFERENCE_MODELS;
        $first = $table[0];
        $last  = $table[count($table) - 1];

        if ($mw <= $first[0]) return [$first[1], $first[2]];
        if ($mw >= $last[0])  return [$last[1], $last[2]];

        for ($i = 0; $i < count($table) - 1; $i++) {
            [$mw0, $hub0, $rot0] = $table[$i];
            [$mw1, $hub1, $rot1] = $table[$i + 1];
            if ($mw >= $mw0 && $mw <= $mw1) {
                $span = $mw1 - $mw0;
                $f    = $span > 0 ? ($mw - $mw0) / $span : 0.0;
                return [
                    $hub0 + ($hub1 - $hub0) * $f,
                    $rot0 + ($rot1 - $rot0) * $f,
                ];
            }
        }

        return [$last[1], $last[2]]; // uråd å nå, men held returtypen total
    }

    /**
     * Estimert A-vekta lydeffektnivå (L_WA) for turbinen ved referansevind.
     *
     * Tilnærminga `L_WA ≈ 100 + 10·log10(P_MW)` treffer godt mot publiserte
     * datablad for landbaserte turbinar:
     *   0.85 MW → 99.3 dB   (datablad ~99)
     *   2.0 MW  → 103.0 dB  (datablad ~104)
     *   3.6 MW  → 105.6 dB  (datablad ~106.5)
     *   6.0 MW  → 107.8 dB  (datablad ~107.5)
     *
     * Klemt til [95, 108] dB(A) for å unngå urealistiske ytterpunkt ved svært
     * små/store oppgitte effektar (datakvaliteten i kjelda varierer).
     */
    private static function soundPower(float $mw): float
    {
        $lwa = 100.0 + 10.0 * log10($mw);
        return max(95.0, min(108.0, $lwa));
    }
}
