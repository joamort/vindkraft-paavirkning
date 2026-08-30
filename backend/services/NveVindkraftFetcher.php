<?php
/**
 * backend/services/NveVindkraftFetcher.php
 *
 * Hentar vindkraftdata frå NVE sin `Vindkraft2` ArcGIS REST MapServer,
 * normaliserer det til eitt internt format og skriv filbasert JSON-cache som
 * Apache kan servere direkte (jf. TECH_STACK.md — statiske filer der mogleg).
 *
 * ---------------------------------------------------------------------------
 * DATAMODELL — kva laga faktisk inneheld (verifisert mot live-API 2026-08)
 * ---------------------------------------------------------------------------
 * MapServer-en har to nivå som må handterast ulikt:
 *
 *  - **Lag 4 `Vindturbin`** (1381 objekt) — individuelle turbinpunkt. Dette er
 *    einaste laget med faktiske enkelt-turbin-koordinatar. Det dekkjer BERRE
 *    anlegg som er i drift eller under bygging (status D/U, 61 anlegg).
 *    Planlagde anlegg har ingen turbingeometri i det heile — turbinplassering
 *    er ikkje fastsett før detaljplan.
 *
 *  - **Lag 0/1/2/6/7/8/9 `Vindkraft_*`** — anleggsnivå, eitt senterpunkt per
 *    anlegg, med dei nyttige attributta (`effekt_mw`, `antallturbiner`,
 *    `kommune`, `fylkenavn`, `eier`, `stadium`, ...).
 *
 * **Lag 5 er ikkje ein eigen kategori.** `Vindkraft_konsesjonsbehandling` (302
 * anlegg) er verifisert å vera nøyaktig unionen av lag 6+7+8+9 — altså "alle
 * saker som nokon gong har vore til konsesjonshandsaming". Å behandle det som
 * ein sjølvstendig status ville gitt dublettar. Difor hentar me det ikkje.
 *
 * Anlegg går att i fleire lag (t.d. er alle 65 anlegga i lag 7 "konsesjon
 * gitt" òg i lag 0/1/2). Status vert difor avgjort av LAG-TILHØYRSLE med ein
 * eksplisitt presedens, ikkje av `status`-feltet — som er inkonsistent på
 * tvers av laga (lag 5 inneheld t.d. rader med status "D" og stadium
 * "Søknad trukket" samtidig).
 *
 * ---------------------------------------------------------------------------
 * Feltnamn
 * ---------------------------------------------------------------------------
 * ArcGIS returnerer feltnamna i `attributes` med SMÅ bokstavar
 * (`effekt_mw`, `antallturbiner`, `fylkenavn`), ikkje slik dei står i
 * `fieldAliases` (`effekt_MW`, `AntTurbin`, `fylkeNavn`). Me les difor alltid
 * case-insensitivt via `attr()` slik at koden overlever om NVE skulle endre
 * på det.
 */

require_once __DIR__ . '/Http.php';
require_once __DIR__ . '/TurbineSpec.php';
require_once __DIR__ . '/TurbineLayout.php';

class NveVindkraftFetcher
{
    /**
     * Primærhost. `nve.geodataonline.no` speglar same tenesta, men har vist seg
     * å ha DNS-problem i enkelte nett — difor `kart.nve.no` som primær, med
     * spegelen som fallback.
     */
    private const BASE_URLS = [
        'https://kart.nve.no/enterprise/rest/services/Vindkraft2/MapServer',
        'https://nve.geodataonline.no/arcgis/rest/services/Vindkraft2/MapServer',
    ];

    /** ArcGIS sin maxRecordCount for denne tenesta. */
    private const PAGE_SIZE = 2000;

    /**
     * Anleggslag i PRESEDENSREKKJEFØLGJE — første treff vinn.
     *
     * Rekkjefølgja går frå "mest konkret/realisert" til "minst": eit anlegg som
     * både er utbygd (lag 0) og har konsesjon (lag 7) skal visast som i drift.
     */
    private const PLANT_LAYERS = [
        0 => 'i_drift',
        1 => 'under_bygging',
        2 => 'konsesjon_ikke_bygd',
        6 => 'under_behandling',
        7 => 'konsesjon_gitt',
        8 => 'avslatt',
        9 => 'planlegging_avsluttet',
    ];

    /** Områdepolygon: lag 3 = utbygde/konsesjonsgitte, lag 10 = konsesjonshandsaming. */
    private const AREA_LAYERS = [3, 10];

    /**
     * Generalisering av polygongeometri (grader). ~0.0005° ≈ 50 m, som er rikeleg
     * detalj for eit oversiktskart og held `areas.json` på ein brøkdel av rå
     * storleik.
     */
    private const AREA_SIMPLIFY_DEG = 0.0005;

    /**
     * MW per turbin lagt til grunn når eit anlegg under planlegging berre har
     * ein total merkeeffekt. Sjå grunngjevinga i estimerTurbintal().
     */
    private const PLANLEGGING_MW_PER_TURBIN = 6.0;

    /**
     * Versjon av utplasseringsalgoritmen. Inngår i cache-signaturen, slik at
     * ei endring i heuristikken automatisk gjer alle lagra utplasseringar
     * ugyldige — utan at nokon må hugse å tømme cachen manuelt.
     */
    private const LAYOUT_VERSJON = 'v2';

    private string $cacheDir;
    /** @var string[] Loggmeldingar frå siste køyring. */
    private array $log = [];
    /** Base-URL som faktisk svarte, sett ved første vellukka kall. */
    private ?string $activeBase = null;

    public function __construct(?string $cacheDir = null)
    {
        $this->cacheDir = $cacheDir ?? dirname(__DIR__, 2) . '/cache';
    }

    /**
     * Køyr full henting og skriv cache-filene.
     *
     * @return array{ok:bool, turbiner:int, anlegg:int, omrader:int, log:string[]}
     */
    public function run(): array
    {
        $this->log = [];

        if (!is_dir($this->cacheDir) && !@mkdir($this->cacheDir, 0775, true)) {
            $this->note("FEIL: kunne ikkje opprette cache-mappa {$this->cacheDir}");
            return ['ok' => false, 'turbiner' => 0, 'anlegg' => 0, 'omrader' => 0, 'log' => $this->log];
        }

        // 0. Kuratert turbinmål-register. Lasta først, slik at ein feil i
        //    JSON-fila står øvst i loggen i staden for å gå stille forbi.
        foreach (KnownSpecRegistry::loadLog() as $line) {
            $this->note($line);
        }

        // 1. Anleggsnivå — byggjer oppslagstabell anleggsnr → attributt.
        $plants = $this->fetchPlants();
        if ($plants === null) {
            $this->note('FEIL: fekk ikkje henta anleggsdata — avbryt utan å røre eksisterande cache.');
            return ['ok' => false, 'turbiner' => 0, 'anlegg' => 0, 'omrader' => 0, 'log' => $this->log];
        }

        // 2. Individuelle turbinar (lag 4), rikt opp med anleggsattributt.
        $turbines = $this->fetchTurbines($plants);
        if ($turbines === null) {
            $this->note('FEIL: fekk ikkje henta turbindata — avbryt utan å røre eksisterande cache.');
            return ['ok' => false, 'turbiner' => 0, 'anlegg' => 0, 'omrader' => 0, 'log' => $this->log];
        }

        // 3. Områdepolygon. Henta FØR plassholdarane, av di utplasseringa i
        //    steg 4 treng dei — polygonet er sjølve grunnlaget for å seie kvar
        //    turbinane i eit planlagt anlegg kjem til å stå.
        //    (Valfritt lag: ei feilande henting her skal ikkje velte resten.)
        $areas = $this->fetchAreas();

        // 4. Pseudo-turbinar for anlegg utan turbingeometri (planlagde m.m.).
        $planned = $this->buildPlannedPlaceholders($plants, $turbines, $areas);
        $this->note('Genererte ' . count($planned) . ' punkt for anlegg utan turbingeometri.');

        $allTurbines = array_merge($turbines, $planned);

        // 5. Skriv cache.
        $generatedAt = gmdate('c');
        $this->writeJson('turbines.json', [
            'generert'  => $generatedAt,
            'kjelde'    => $this->activeBase,
            'atterhald' => 'Navhøgde, rotordiameter og lydeffekt finst IKKJE i NVE-datasettet. Turbinar med mal_kilde="kjent_soknad" har mål lesne ut av eit offentleg søknads-/meldingsdokument (kjelde i mal_kjelde_url); alle andre har mal_kilde="estimert" og er rekna ut frå merkeeffekt per turbin. Sjå PLAN.md §7.',
            'antall'    => count($allTurbines),
            'anlegg'    => array_values($plants),
            'turbiner'  => $allTurbines,
        ]);

        if ($areas !== null) {
            $this->writeJson('areas.json', [
                'generert' => $generatedAt,
                'kjelde'   => $this->activeBase,
                'antall'   => count($areas),
                'omrader'  => $areas,
            ]);
        }

        $this->writeJson('meta.json', [
            'generert' => $generatedAt,
            'kjelde'   => $this->activeBase,
            'turbiner' => count($allTurbines),
            'anlegg'   => count($plants),
            'omrader'  => $areas !== null ? count($areas) : 0,
            'log'      => $this->log,
        ]);

        return [
            'ok'       => true,
            'turbiner' => count($allTurbines),
            'anlegg'   => count($plants),
            'omrader'  => $areas !== null ? count($areas) : 0,
            'log'      => $this->log,
        ];
    }

    // ---------------------------------------------------------------- anlegg

    /**
     * Hent alle anleggslag og slå dei saman til éin tabell nøkla på anleggsnr.
     *
     * @return array<int,array<string,mixed>>|null null ved nettverksfeil
     */
    private function fetchPlants(): ?array
    {
        $plants = [];

        foreach (self::PLANT_LAYERS as $layerId => $statusKey) {
            $features = $this->queryLayer($layerId);
            if ($features === null) {
                return null;
            }
            $this->note("Lag $layerId ($statusKey): " . count($features) . ' anlegg.');

            foreach ($features as $feature) {
                $a  = $feature['attributes'] ?? [];
                $nr = self::attr($a, 'anleggsnr');
                if ($nr === null) {
                    continue;
                }
                $nr = (int) $nr;

                // Presedens: første lag som nemner anlegget set statusen.
                // Seinare lag får berre fylle ut felt som manglar.
                if (isset($plants[$nr])) {
                    $this->mergePlantExtras($plants[$nr], $a);
                    continue;
                }

                $geom = $feature['geometry'] ?? null;
                $lat  = isset($geom['y']) ? (float) $geom['y'] : null;
                $lon  = isset($geom['x']) ? (float) $geom['x'] : null;

                $mw       = self::floatAttr($a, 'effekt_mw') ?? self::floatAttr($a, 'effekt_mw_idrift');
                $antTurb  = self::intAttr($a, 'antallturbiner');
                $utAvDrift = self::attr($a, 'utavdriftdato');

                // Eit anlegg som er teke ut av drift skal ikkje visast som "i drift",
                // uansett kva lag det ligg i. NVE held slike i lag 0/2 med status "N".
                $status = $statusKey;
                $raw    = strtoupper((string) (self::attr($a, 'status') ?? ''));
                if ($raw === 'N' || ($utAvDrift !== null && (int) $utAvDrift > 0 && (int) $utAvDrift / 1000 < time())) {
                    $status = 'nedlagt';
                }

                $plants[$nr] = [
                    'anleggsnr'      => $nr,
                    'navn'           => self::attr($a, 'anleggnavn') ?: 'Ukjent anlegg',
                    'status'         => $status,
                    'status_raa'     => $raw !== '' ? $raw : null,
                    'stadium'        => self::attr($a, 'stadium'),
                    'lat'            => $lat,
                    'lon'            => $lon,
                    'effekt_mw'      => $mw,
                    'antall_turbiner' => $antTurb,
                    'produksjon_gwh' => self::floatAttr($a, 'forventetproduksjon_gwh'),
                    'kommune'        => self::attr($a, 'kommune'),
                    'fylke'          => self::attr($a, 'fylkenavn'),
                    'eier'           => self::attr($a, 'eier'),
                    'sakslenke'      => self::attr($a, 'sakslenke'),
                    'forste_drift'   => self::msToDate(self::attr($a, 'forsteidriftdato')),
                    'ut_av_drift'    => self::msToDate($utAvDrift),
                ];
            }
        }

        $this->note('Totalt ' . count($plants) . ' unike anlegg etter samanslåing.');
        return $plants;
    }

    /**
     * Fyll ut felt som mangla i laget med høgast presedens. Eit anlegg kan t.d.
     * ha `effekt_mw` registrert i konsesjonslaget, men null i utbygd-laget.
     *
     * @param array<string,mixed> $plant
     * @param array<string,mixed> $a
     */
    private function mergePlantExtras(array &$plant, array $a): void
    {
        $fill = [
            'effekt_mw'       => self::floatAttr($a, 'effekt_mw'),
            'antall_turbiner' => self::intAttr($a, 'antallturbiner'),
            'produksjon_gwh'  => self::floatAttr($a, 'forventetproduksjon_gwh'),
            'kommune'         => self::attr($a, 'kommune'),
            'fylke'           => self::attr($a, 'fylkenavn'),
            'eier'            => self::attr($a, 'eier'),
            'sakslenke'       => self::attr($a, 'sakslenke'),
            'stadium'         => self::attr($a, 'stadium'),
        ];
        foreach ($fill as $key => $value) {
            if (($plant[$key] ?? null) === null && $value !== null && $value !== '') {
                $plant[$key] = $value;
            }
        }
    }

    // -------------------------------------------------------------- turbinar

    /**
     * Hent lag 4 (individuelle turbinpunkt) og rikt opp med anleggsattributt.
     *
     * @param array<int,array<string,mixed>> $plants
     * @return list<array<string,mixed>>|null
     */
    private function fetchTurbines(array $plants): ?array
    {
        $features = $this->queryLayer(4);
        if ($features === null) {
            return null;
        }
        $this->note('Lag 4 (Vindturbin): ' . count($features) . ' turbinpunkt.');

        $out = [];
        foreach ($features as $feature) {
            $a    = $feature['attributes'] ?? [];
            $geom = $feature['geometry'] ?? null;
            if (!isset($geom['x'], $geom['y'])) {
                continue;
            }

            $nr    = self::intAttr($a, 'anleggsnr');
            $plant = $nr !== null ? ($plants[$nr] ?? null) : null;

            // Merkeeffekt per turbin: anleggets totaleffekt delt på tal turbinar.
            // Me føretrekkjer det FAKTISKE talet turbinpunkt i laget framfor
            // `antallturbiner`-attributtet, som av og til er utdatert (t.d.
            // Kvitfjell: attributt 47, faktiske punkt 67).
            $perTurbineMw = self::perTurbineMw($plant, $features, $nr);
            $navn = self::attr($a, 'anleggnavn') ?: ($plant['navn'] ?? 'Ukjent anlegg');

            // Kuratert kjeldeført mål først, generisk estimat elles.
            $spec = TurbineSpec::resolve($perTurbineMw, $nr, $navn);

            $out[] = array_merge([
                'id'         => 'T' . self::intAttr($a, 'objectid'),
                'anleggsnr'  => $nr,
                'navn'       => $navn,
                // Status frå anleggsnivå er meir påliteleg enn turbinlaget sitt
                // eigne D/U-flagg, og held fargekodinga konsistent på kartet.
                'status'     => $plant['status'] ?? self::statusFromCode(self::attr($a, 'status')),
                'lat'        => round((float) $geom['y'], 6),
                'lon'        => round((float) $geom['x'], 6),
            ], $spec, [
                'posisjon_kilde' => 'nve_turbinpunkt',
            ]);
        }

        return $out;
    }

    /**
     * Rekn ut merkeeffekt per turbin for eit anlegg.
     *
     * @param array<string,mixed>|null $plant
     * @param list<array<string,mixed>> $allFeatures
     */
    private function perTurbineMw(?array $plant, array $allFeatures, ?int $anleggsnr): ?float
    {
        if ($plant === null || $anleggsnr === null) {
            return null;
        }
        $mw = $plant['effekt_mw'] ?? null;
        if ($mw === null || $mw <= 0) {
            return null;
        }

        // Tel faktiske turbinpunkt for dette anlegget (memoisert per køyring).
        static $counts = null;
        if ($counts === null) {
            $counts = [];
            foreach ($allFeatures as $f) {
                $nr = self::intAttr($f['attributes'] ?? [], 'anleggsnr');
                if ($nr !== null) {
                    $counts[$nr] = ($counts[$nr] ?? 0) + 1;
                }
            }
        }

        $n = $counts[$anleggsnr] ?? ($plant['antall_turbiner'] ?? null);
        if ($n === null || $n <= 0) {
            return null;
        }
        return (float) $mw / (int) $n;
    }

    /**
     * Lag eitt plassholdar-punkt per anlegg som manglar turbingeometri.
     *
     * Planlagde/omsøkte anlegg har ingen fastsette turbinposisjonar i NVE-data.
     * Å utelate dei ville gøymt nettopp dei anlegga ein brukar oftast lurer på.
     * I staden lagar me EITT punkt i anleggets senter som representerer heile
     * anlegget, tydeleg merkt `posisjon_kilde = "anlegg_senterpunkt"` slik at
     * både kart og berekningar kan visa atterhaldet.
     *
     * @param array<int,array<string,mixed>> $plants
     * @param list<array<string,mixed>>      $turbines
     * @return list<array<string,mixed>>
     */
    private function buildPlannedPlaceholders(array $plants, array $turbines, ?array $areas): array
    {
        $withGeometry = [];
        foreach ($turbines as $t) {
            if ($t['anleggsnr'] !== null) {
                $withGeometry[$t['anleggsnr']] = true;
            }
        }

        /**
         * Planområde per anleggsnr.
         *
         * Kvar oppføring i `areas.json` vert eit SJØLVSTENDIG polygon i lista,
         * ikkje ein bunke ringar som vert slått saman. NVE har fleire
         * områdelag (3 og 10), og eit anlegg under handsaming ligg ofte i
         * begge med same omriss — slår ein ringane saman, kansellerer
         * odde/like-testen dei mot kvarandre og heile området forsvinn.
         * Sjå TurbineLayout::iNokoPolygon().
         */
        $polygonByPlant = [];
        foreach ($areas ?? [] as $area) {
            $nr = $area['anleggsnr'] ?? null;
            if ($nr !== null && !empty($area['ringer'])) {
                $polygonByPlant[$nr][] = $area['ringer'];
            }
        }

        $layoutCache = $this->readLayoutCache();
        $layoutOn    = self::layoutEnabled();
        $nyeLayouts  = 0;

        $out = [];
        foreach ($plants as $nr => $plant) {
            if (isset($withGeometry[$nr])) {
                continue;
            }
            if ($plant['lat'] === null || $plant['lon'] === null) {
                continue;
            }

            $n  = $plant['antall_turbiner'] ?? null;
            $mw = $plant['effekt_mw'] ?? null;
            $perTurbine = ($mw !== null && $n !== null && $n > 0) ? (float) $mw / (int) $n : null;

            // Kuratert kjeldeført mål først, generisk estimat elles. Dette er
            // laget der oppslaget betyr mest: saker under behandling manglar
            // som regel `antallturbiner`, så $perTurbine er ofte null og det
            // generiske estimatet fell tilbake på medianturbinen.
            $spec = TurbineSpec::resolve($perTurbine, $nr, $plant['navn'] ?? null);

            // Manglar NVE turbintalet, men søknaden oppgir eit — bruk søknaden
            // sitt, slik at støymodellen sin +10·log₁₀(N) får noko å gå på.
            if (($n === null || $n <= 0) && isset($spec['mal_antall_turbiner'][1])) {
                $n = (int) $spec['mal_antall_turbiner'][1];
            }

            $felles = [
                'anleggsnr' => $nr,
                'navn'      => $plant['navn'],
                'status'    => $plant['status'],
            ];

            // --- Utplassering i polygonet, når det let seg gjere ------------
            $layout = null;
            $polygon = $polygonByPlant[$nr] ?? null;
            $maal   = $this->estimerTurbintal($plant, $spec, $n);

            if ($polygon !== null && $maal !== null && self::skalPlassere($plant['status'])) {
                $sign = self::layoutSignatur($nr, $maal, (float) $spec['rotor_diameter_m'], $polygon);
                $treff = $layoutCache['oppforingar'][(string) $nr] ?? null;

                if (is_array($treff) && ($treff['signatur'] ?? null) === $sign) {
                    $layout = $treff;
                } elseif ($layoutOn) {
                    $beregna = $this->beregnLayout($nr, $plant, $polygon, $maal, (float) $spec['rotor_diameter_m']);
                    if ($beregna !== null) {
                        $beregna['signatur'] = $sign;
                        $layoutCache['oppforingar'][(string) $nr] = $beregna;
                        $layout = $beregna;
                        $nyeLayouts++;
                    } else {
                        // Negativt resultat (t.d. havområde) skal òg hugsast,
                        // elles prøver cron det same forgjeves kvar einaste natt.
                        $layoutCache['oppforingar'][(string) $nr] = [
                            'signatur' => $sign, 'punkt' => [], 'plasserte' => 0,
                            'maal' => $maal, 'avvist' => true,
                        ];
                    }
                }
            }

            if ($layout !== null && !empty($layout['punkt'])) {
                foreach ($layout['punkt'] as $i => $p) {
                    $out[] = array_merge($felles, [
                        'id'  => 'E' . $nr . '_' . $i,
                        'lat' => round((float) $p['lat'], 6),
                        'lon' => round((float) $p['lon'], 6),
                    ], $spec, [
                        'posisjon_kilde'   => 'estimert_i_omrade',
                        'posisjon_notat'   => 'Plassert av oss inne i NVE sitt planområde etter terrengform. '
                                            . 'Ikkje ein omsøkt eller planlagt turbinposisjon.',
                        'layout_maal'      => (int) ($layout['maal'] ?? $maal),
                        'layout_plasserte' => (int) ($layout['plasserte'] ?? count($layout['punkt'])),
                        'layout_avstand_m' => $layout['min_avstand_m'] ?? null,
                        'layout_terreng'   => $p['terreng'] ?? null,
                    ]);
                }
                continue;
            }

            // --- Fallback: det gamle eittpunkts-plassholdaret ---------------
            // Framleis rett svar når polygonet manglar, når området ligg på sjø,
            // eller når me ikkje har grunnlag for å anslå eit turbintal.
            $out[] = array_merge($felles, [
                'id'  => 'P' . $nr,
                'lat' => round((float) $plant['lat'], 6),
                'lon' => round((float) $plant['lon'], 6),
            ], $spec, [
                'posisjon_kilde' => 'anlegg_senterpunkt',
                // Kor mange turbinar punktet representerer — brukast til
                // energetisk oppskalering i støymodellen, med atterhald.
                'representerer_turbiner' => $n !== null && $n > 0 ? (int) $n : null,
            ]);
        }

        if ($nyeLayouts > 0) {
            $this->writeLayoutCache($layoutCache);
        }
        $this->note("Utplassering: $nyeLayouts nye anlegg rekna ut, "
            . count($layoutCache['oppforingar']) . ' i cachen.');

        return $out;
    }

    // ------------------------------------------------------- utplassering

    /**
     * Er utplasseringssteget påslege?
     *
     * Steget er tungt første gongen (fleire minutt og hundrevis av
     * WPS-oppslag), men resultatet er PERMANENT cacha: terrenget endrar seg
     * aldri, og eit planområde sjeldan. Etter første køyring er steget gratis.
     * `VIND_LAYOUT=0` slår det heilt av, til bruk når ein berre vil oppdatere
     * anleggsdata raskt.
     */
    private static function layoutEnabled(): bool
    {
        $v = getenv('VIND_LAYOUT');
        return $v === false || !in_array(strtolower((string) $v), ['0', 'off', 'false', 'no'], true);
    }

    /**
     * Kva statusar det er meiningsfullt å plassere turbinar for.
     *
     * -----------------------------------------------------------------------
     * KVIFOR DETTE FILTERET ER VIKTIGARE ENN DET SER UT
     * -----------------------------------------------------------------------
     * Utan filteret ville steget produsert ~9 400 turbinpunkt. Med det vert det
     * ~1 000. Skilnaden er nesten heilt saker frå «Nasjonal ramme»-runden rundt
     * 2019 som seinare vart trekte eller lagde i bero, og som ber
     * spekulative effekttal: Slettfjellet står med 2 000 MW og stadium
     * «Melding trukket», som ville gitt 500 turbinar i eit polygon på 75 km².
     *
     * Å teikne 500 estimerte turbinar på ei sak som ikkje finst lenger ville
     * vore aktivt villeiande — og dei statusane er uansett avslegne i
     * standardfilteret i UI-et.
     */
    private static function skalPlassere(string $status): bool
    {
        return in_array($status, [
            'under_behandling', 'konsesjon_gitt', 'konsesjon_ikke_bygd', 'under_bygging',
        ], true);
    }

    /**
     * Anslå kor mange turbinar anlegget får.
     *
     * PRESEDENS:
     *   1. Kuratert tal frå søknadsdokumentet (`mal_antall_turbiner`, øvre ende)
     *   2. NVE sitt eige `antallturbiner`
     *   3. Utleidd frå total merkeeffekt
     *
     * For (3) treng me ein MW per turbin. Er han kjend frå spec-en, brukast
     * den. Elles bruker me 6,0 MW og IKKJE `TurbineSpec` sin generiske default
     * på ~4 MW: den defaulten er kalibrert mot medianen i den norske parken
     * som ALT STÅR, medan eit anlegg til konsesjonshandsaming i 2024–2026
     * søkjer om maskiner i 6–7 MW-klassa. Brukte me 4 MW her, ville turbintalet
     * blitt om lag 50 % for høgt for nettopp dei anlegga steget gjeld.
     */
    private function estimerTurbintal(array $plant, array $spec, ?int $n): ?int
    {
        if (isset($spec['mal_antall_turbiner'][1]) && (int) $spec['mal_antall_turbiner'][1] > 0) {
            return (int) $spec['mal_antall_turbiner'][1];
        }
        if ($n !== null && $n > 0) {
            return (int) $n;
        }

        $mw = $plant['effekt_mw'] ?? null;
        if ($mw === null || $mw <= 0) {
            return null;
        }
        $perTurbin = ($spec['effekt_mw'] ?? null) > 0 ? (float) $spec['effekt_mw'] : self::PLANLEGGING_MW_PER_TURBIN;
        $tal = (int) round((float) $mw / $perTurbin);

        return $tal > 0 ? $tal : null;
    }

    /** Signatur over alt som kan endre resultatet av ei utplassering. */
    private static function layoutSignatur(int $nr, int $maal, float $rotor, array $polygon): string
    {
        $geo = '';
        foreach ($polygon as $rings) {
            foreach ($rings as $ring) {
                $geo .= count($ring) . ':' . ($ring[0][0] ?? '') . ',' . ($ring[0][1] ?? '') . '|';
            }
            $geo .= ';';
        }
        return sha1(sprintf('%d|%d|%.1f|%s|%s', $nr, $maal, $rotor, $geo, self::LAYOUT_VERSJON));
    }

    /** @return array<string,mixed>|null */
    private function beregnLayout(int $nr, array $plant, array $polygon, int $maal, float $rotor): ?array
    {
        $layout = (new TurbineLayout())->plasser($polygon, $maal, $rotor);
        if ($layout === null) {
            $this->note("  Utplassering avvist for $nr ({$plant['navn']}).");
            return null;
        }
        // TurbineLayout klemmer talet til sitt eige tak. Det ANSLEGNE talet er
        // det brukaren skal sjå, slik at «150 av 160 plasserte» framleis les
        // som eit avvik og ikkje som ein perfekt treff.
        $layout['maal'] = $maal;
        $this->note(sprintf(
            '  %s (%d): %d/%d turbinar plasserte, %.0f m minsteavstand, %d kandidatar.',
            $plant['navn'], $nr, $layout['plasserte'], $layout['maal'],
            $layout['min_avstand_m'], $layout['kandidatar'],
        ));
        return $layout;
    }

    /** @return array{generert:?string, oppforingar:array<string,mixed>} */
    private function readLayoutCache(): array
    {
        $path = $this->cacheDir . '/layouts.json';
        if (is_readable($path)) {
            $data = json_decode((string) file_get_contents($path), true);
            if (is_array($data) && isset($data['oppforingar']) && is_array($data['oppforingar'])) {
                return $data;
            }
        }
        return ['generert' => null, 'oppforingar' => []];
    }

    private function writeLayoutCache(array $cache): void
    {
        $cache['generert'] = gmdate('c');
        $cache['versjon']  = self::LAYOUT_VERSJON;
        $this->writeJson('layouts.json', $cache);
    }

    // --------------------------------------------------------------- område

    /**
     * Hent områdepolygon (lag 3 og 10). Returnerer null berre om alle laga feila.
     *
     * @return list<array<string,mixed>>|null
     */
    private function fetchAreas(): ?array
    {
        $out = [];
        $any = false;

        foreach (self::AREA_LAYERS as $layerId) {
            $features = $this->queryLayer($layerId, ['maxAllowableOffset' => self::AREA_SIMPLIFY_DEG]);
            if ($features === null) {
                $this->note("ÅTVARING: lag $layerId (område) kunne ikkje hentast — hoppar over.");
                continue;
            }
            $any = true;
            $this->note("Lag $layerId (område): " . count($features) . ' polygon.');

            foreach ($features as $feature) {
                $a     = $feature['attributes'] ?? [];
                $rings = $feature['geometry']['rings'] ?? null;
                if (!is_array($rings) || $rings === []) {
                    continue;
                }

                // ArcGIS gir [[x,y], ...] per ring. Leaflet vil ha [lat, lon].
                $latlngRings = [];
                foreach ($rings as $ring) {
                    $pts = [];
                    foreach ($ring as $pt) {
                        if (isset($pt[0], $pt[1])) {
                            $pts[] = [round((float) $pt[1], 5), round((float) $pt[0], 5)];
                        }
                    }
                    if (count($pts) >= 3) {
                        $latlngRings[] = $pts;
                    }
                }
                if ($latlngRings === []) {
                    continue;
                }

                $out[] = [
                    'anleggsnr' => self::intAttr($a, 'anleggsnr'),
                    'navn'      => self::attr($a, 'anleggnavn') ?: 'Ukjent område',
                    'stadium'   => self::attr($a, 'stadium'),
                    'kilde_lag' => $layerId,
                    'ringer'    => $latlngRings,
                ];
            }
        }

        return $any ? $out : null;
    }

    // ------------------------------------------------------------- ArcGIS-IO

    /**
     * Spør eit lag med paginering til `exceededTransferLimit` ikkje lenger er sett.
     *
     * @param array<string,mixed> $extraParams
     * @return list<array<string,mixed>>|null null ved nettverks-/parsefeil
     */
    private function queryLayer(int $layerId, array $extraParams = []): ?array
    {
        $features = [];
        $offset   = 0;

        // Hard øvre grense på tal sider — vern mot uendeleg loop om tenesta
        // skulle returnere `exceededTransferLimit` for alltid.
        for ($page = 0; $page < 50; $page++) {
            $params = array_merge([
                'where'             => '1=1',
                'outFields'         => '*',
                'f'                 => 'json',
                'outSR'             => 4326,
                'returnGeometry'    => 'true',
                'resultRecordCount' => self::PAGE_SIZE,
                'resultOffset'      => $offset,
            ], $extraParams);

            $data = $this->requestWithFallback("/$layerId/query", $params);
            if ($data === null) {
                return null;
            }

            // ArcGIS signaliserer feil i sjølve JSON-en, med HTTP 200.
            if (isset($data['error'])) {
                $msg = $data['error']['message'] ?? 'ukjend ArcGIS-feil';
                $this->note("FEIL frå ArcGIS på lag $layerId: $msg");
                return null;
            }

            $batch = $data['features'] ?? [];
            if (!is_array($batch)) {
                return null;
            }
            $features = array_merge($features, $batch);

            if (empty($data['exceededTransferLimit']) || count($batch) === 0) {
                break;
            }
            $offset += count($batch);
        }

        return $features;
    }

    /**
     * Utfør eit kall mot primærhost, og prøv spegelen om han feilar.
     *
     * @param array<string,mixed> $params
     * @return array<string,mixed>|null
     */
    private function requestWithFallback(string $path, array $params): ?array
    {
        // Har me alt funne ein host som svarer, hald oss til han.
        $bases = $this->activeBase !== null
            ? [$this->activeBase]
            : self::BASE_URLS;

        foreach ($bases as $base) {
            $url  = $base . $path . '?' . http_build_query($params);
            $data = Http::getJson($url, $error, 60);
            if ($data !== null) {
                $this->activeBase = $base;
                return $data;
            }
            $this->note("ÅTVARING: $base svarte ikkje ($error) — prøver neste kjelde.");
        }

        // Primærhost var alt vald men feila no — prøv spegelen likevel.
        if ($this->activeBase !== null) {
            foreach (self::BASE_URLS as $base) {
                if ($base === $this->activeBase) {
                    continue;
                }
                $url  = $base . $path . '?' . http_build_query($params);
                $data = Http::getJson($url, $error, 60);
                if ($data !== null) {
                    $this->note("Byttar til fallback-kjelde $base.");
                    $this->activeBase = $base;
                    return $data;
                }
            }
        }

        return null;
    }

    // --------------------------------------------------------------- hjelpar

    /**
     * Les eit attributt case-insensitivt.
     *
     * @param array<string,mixed> $attrs
     * @return mixed|null
     */
    private static function attr(array $attrs, string $name)
    {
        if (array_key_exists($name, $attrs)) {
            return $attrs[$name];
        }
        $lower = strtolower($name);
        foreach ($attrs as $key => $value) {
            if (strtolower((string) $key) === $lower) {
                return $value;
            }
        }
        return null;
    }

    /** @param array<string,mixed> $attrs */
    private static function floatAttr(array $attrs, string $name): ?float
    {
        $v = self::attr($attrs, $name);
        return ($v === null || $v === '') ? null : (float) $v;
    }

    /** @param array<string,mixed> $attrs */
    private static function intAttr(array $attrs, string $name): ?int
    {
        $v = self::attr($attrs, $name);
        return ($v === null || $v === '') ? null : (int) $v;
    }

    /** ArcGIS leverer datoar som millisekund sidan epoch. */
    private static function msToDate($ms): ?string
    {
        if ($ms === null || $ms === '' || (int) $ms === 0) {
            return null;
        }
        return gmdate('Y-m-d', (int) ((int) $ms / 1000));
    }

    /**
     * Fallback-mapping frå NVE sin `status`-kode når anlegget ikkje vart funne.
     * Kodane er verifiserte mot live-data: D=drift, U=under bygging,
     * P2=planlagd/under behandling, V=vedtak (avslag), N=nedlagt, FJ=fjerna sak.
     */
    private static function statusFromCode(?string $code): string
    {
        return match (strtoupper((string) $code)) {
            'D'  => 'i_drift',
            'U'  => 'under_bygging',
            'P2' => 'under_behandling',
            'V'  => 'avslatt',
            'N'  => 'nedlagt',
            'FJ' => 'planlegging_avsluttet',
            default => 'ukjent',
        };
    }

    /** Skriv JSON atomisk, slik at Apache aldri serverer ei halvskriven fil. */
    private function writeJson(string $filename, array $payload): void
    {
        $path = $this->cacheDir . '/' . $filename;
        $tmp  = $path . '.tmp';
        $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        if ($json === false) {
            $this->note("FEIL: kunne ikkje JSON-kode $filename");
            return;
        }
        if (file_put_contents($tmp, $json, LOCK_EX) === false || !@rename($tmp, $path)) {
            $this->note("FEIL: kunne ikkje skrive $path");
            return;
        }
        $this->note("Skreiv $filename (" . number_format(strlen($json) / 1024, 1) . ' KB).');
    }

    private function note(string $message): void
    {
        $this->log[] = $message;
    }
}
