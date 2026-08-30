<?php
/**
 * backend/services/ElevationService.php
 *
 * Hentar terrenghøgder frå Kartverket og cachar dei permanent på fil.
 *
 * ---------------------------------------------------------------------------
 * KVIFOR DENNE ER BYGD SLIK
 * ---------------------------------------------------------------------------
 * Kartverket sin WPS (`wps.elevation2`, prosess `elevationJSON`) er dokumentert
 * som ei "høgdeprofil langs ei linje"-teneste: du sender ein GPX-track og ber
 * om N jamt fordelte punkt. Men tenesta interpolerer IKKJE sjølv — gir du to
 * trackpunkt og ber om 20, får du to punkt tilbake.
 *
 * Det er verifisert eksperimentelt (sjå CLAUDE.md) at når talet på trackpunkt
 * er NØYAKTIG lik `points`-parameteren, returnerer tenesta høgda i akkurat dei
 * punkta du sende inn — også når punkta utgjer fleire heilt usamanhengande
 * linjestykke i ulike delar av landet.
 *
 * Det gjer WPS-en i praksis til ein **batch-oppslagsteneste for inntil ~400
 * vilkårlege punkt per kall**, ikkje berre ein profilteneste. Det er heilt
 * avgjerande for denne appen: eit punkt kan ha over 200 turbinar innanfor 20 km,
 * og eitt WPS-kall per turbin ville tatt fleire minutt. Ved å pakke fleire
 * turbinprofilar inn i same kall går same jobben ned til ei håndfull kall.
 *
 * `distance`-feltet frå WPS-en er kumulativ avstand langs heile den samansette
 * tracken, og er difor meiningslaust ved batching. Me reknar difor alltid ut
 * avstand sjølv (haversine) og ser heilt bort frå feltet.
 */

require_once __DIR__ . '/Http.php';
require_once __DIR__ . '/Logger.php';

class ElevationService
{
    private const WPS_URL   = 'http://wps.geonorge.no/skwms1/wps.elevation2';
    private const POINT_URL = 'https://ws.geonorge.no/hoydedata/v1/punkt';

    /**
     * OVERFLATEMODELLEN — same teneste, anna datakjelde.
     *
     * -----------------------------------------------------------------------
     * KVIFOR EIN EIGEN VEG INN, OG IKKJE BERRE EIN PARAMETER PÅ WPS-EN
     * -----------------------------------------------------------------------
     * Kartverket har to laserbaserte høgdemodellar med same oppløysing:
     * `dtm1` (terreng — BAR BAKKE) og `dom1` (overflate — med skog, bygningar
     * og alt anna laseren traff først). Heile appen har til no rekna på dtm1,
     * og er difor systematisk optimistisk på synlegheit.
     *
     * WPS-en (`wps.elevation2`) — den batch-tenesta heile profilhentinga
     * kviler på — kan IKKJE be om dom1. Verifisert mot `DescribeProcess`:
     * `elevationJSON` tek berre `gpx`, `points` og `places`; det finst ikkje
     * noko `datakilde`-inngang i det heile. Profilar er difor dtm1, punktum.
     *
     * REST-punkttenesta kan derimot velje kjelde, og — dette er poenget —
     * ho tek inntil **50 punkt i eitt kall** via `punkter=[[ost,nord],...]`.
     * Verifisert eksperimentelt at rekkjefølgja ut svarar til rekkjefølgja
     * inn, og at svaret ekkar koordinatane, slik at det kan kontrollerast.
     *
     * Det gjer ein målretta DOM-kryssjekk billeg: 150 turbinar × eitt kritisk
     * terrengpunkt kvar = 3 kall, ikkje 150.
     */
    private const SOURCE_POINT_URL = 'https://ws.geonorge.no/hoydedata/v1/datakilder/%s/punkt';

    /**
     * KVITLISTE over datakjelder klienten kan be om.
     *
     * `datakilde` går rett inn i ein URL-sti mot Kartverket. Ein vilkårleg
     * streng derifrå ville vore ein open proxy inn i eit anna API — difor er
     * dette ei liste, ikkje ein sanitær-funksjon. Kartverket har fleire
     * kjelder (`hoydekurver`, `dybdekurver`, `innsjohoyde`), men dei to her er
     * dei einaste appen har ei tolking av.
     */
    public const KJELDER = ['dtm1', 'dom1'];

    /** Hard grense i tenesta: «maksimum 50 koordinater, minimum 1». */
    private const MAX_SOURCE_POINTS_PER_CALL = 50;

    /**
     * Toleranse når svaret sine ekka koordinatar kontrollerast mot dei me
     * sende. ~11 m — nok til å tole avrunding, altfor lite til å sleppe
     * gjennom ei ombytt rekkjefølgje (punkta våre ligg alltid meir enn eit
     * terrengpunkt frå kvarandre).
     */
    private const SOURCE_ECHO_TOLERANCE_DEG = 1e-4;

    /**
     * Maks trackpunkt per WPS-kall. Tenesta dokumenterer ~400 som tak; me legg
     * oss litt under for å ha margin.
     */
    private const MAX_POINTS_PER_CALL = 380;

    /** Ønska avstand mellom profilpunkt (meter) i hovuddelen av profilen. */
    private const SAMPLE_SPACING_M = 60;

    /** Grenser for tal punkt i éin profil (utanom nærsona under). */
    private const MIN_SAMPLES = 16;
    private const MAX_SAMPLES = 160;

    /**
     * NÆRSONE — tettare punkt like ved observatøren.
     *
     * Siktlinjeberekninga ekstrapolerer frå observatøren gjennom kvart
     * terrengpunkt heilt fram til målet, med faktoren D/d. For eit punkt 60 m
     * unna og eit mål 12 km unna er faktoren 200: éin meter feil i terrenghøgda
     * der vert 200 m feil i den utrekna horisonten.
     *
     * Nøyaktigheita betyr altså MYKJE meir nær observatøren enn langt unna.
     * Difor legg me eit tettare punktsett over dei første NEAR_FIELD_M metrane,
     * i staden for jamn punktavstand heile vegen. Det kostar ~20 ekstra punkt
     * per profil og fjernar den verste følsemda for kvar enkelt sample.
     */
    private const NEAR_FIELD_M         = 300;
    private const NEAR_FIELD_SPACING_M = 15;

    /**
     * Origo vert snappa til dette talet desimalar før profilen genererast og
     * cachast. 4 desimalar ≈ 11 m i nord/sør og ≈ 5 m i aust/vest på 60°N.
     *
     * Poenget er cache-treff: utan snapping ville kvart einaste museklikk gitt
     * ein heilt ny cache-nøkkel, og cachen ville aldri blitt brukt. Ei
     * forskyving på ~10 m er langt under nøyaktigheita i sjølve modellen.
     */
    private const ORIGIN_PRECISION = 4;

    private string $cacheDir;

    public function __construct(?string $cacheDir = null)
    {
        $this->cacheDir = $cacheDir ?? dirname(__DIR__, 2) . '/cache/elevation';
    }

    /**
     * Hent høgdeprofilar frå eitt origo til mange mål.
     *
     * @param array{lat:float,lon:float}                    $origin
     * @param list<array{id:string,lat:float,lon:float}>    $targets
     * @return array{origin:array{lat:float,lon:float}, profiles:array<string,list<array{d:float,z:float,lat:float,lon:float,terreng:?string}>>, stats:array<string,int>}
     */
    public function profiles(array $origin, array $targets): array
    {
        // Snapp origo for cache-treff (sjå ORIGIN_PRECISION).
        $oLat = round($origin['lat'], self::ORIGIN_PRECISION);
        $oLon = round($origin['lon'], self::ORIGIN_PRECISION);

        $profiles = [];
        $pending  = [];   // målpunkt som må hentast frå WPS
        $stats    = ['cache_treff' => 0, 'hentet' => 0, 'wps_kall' => 0];

        foreach ($targets as $target) {
            $tLat = round((float) $target['lat'], 6);
            $tLon = round((float) $target['lon'], 6);
            $dist      = self::haversine($oLat, $oLon, $tLat, $tLon);
            $fractions = self::sampleFractions($dist);
            $key       = self::cacheKey($oLat, $oLon, $tLat, $tLon, count($fractions));

            $cached = $this->readCache($key);
            if ($cached !== null) {
                $profiles[$target['id']] = $cached;
                $stats['cache_treff']++;
                continue;
            }

            $pending[] = [
                'id'     => $target['id'],
                'key'    => $key,
                'points' => self::interpolate($oLat, $oLon, $tLat, $tLon, $fractions),
            ];
        }

        // Pakk dei manglande profilane i så få WPS-kall som mogleg.
        foreach (self::packBatches($pending) as $batch) {
            $flat = [];
            foreach ($batch as $item) {
                foreach ($item['points'] as $p) {
                    $flat[] = $p;
                }
            }

            $elevations = $this->queryWps($flat);
            $stats['wps_kall']++;

            if ($elevations === null || count($elevations) !== count($flat)) {
                // Delvis feil skal ikkje velte heile analysen — dei råka
                // turbinane vert berre ståande utan profil, og klienten viser
                // dei som "ikkje analysert".
                continue;
            }

            $offset = 0;
            foreach ($batch as $item) {
                $count   = count($item['points']);
                $slice   = array_slice($elevations, $offset, $count);
                $offset += $count;

                $profile = [];
                foreach ($slice as $i => $row) {
                    $lat = (float) $row['lat'];
                    $lon = (float) $row['lon'];
                    $profile[] = [
                        // Avstand frå origo — rekna sjølv, ikkje frå WPS-en.
                        'd'   => round(self::haversine($oLat, $oLon, $lat, $lon), 1),
                        // Havbotn (negative verdiar) er ikkje ei sikthindring.
                        // Klem til havoverflata slik at både siktlinje og graf
                        // oppfører seg fornuftig over vatn.
                        'z'   => round(max(0.0, (float) $row['elevation']), 1),
                        'lat' => round($lat, 6),
                        'lon' => round($lon, 6),
                        'terreng' => $row['terrain'] ?? null,
                    ];
                }

                // Sorter defensivt på avstand — rekkjefølgja frå WPS-en har vore
                // stabil i alle testar, men profilberekninga føreset monotoni.
                usort($profile, static fn($a, $b) => $a['d'] <=> $b['d']);

                $profiles[$item['id']] = $profile;
                $this->writeCache($item['key'], $profile);
                $stats['hentet']++;
            }
        }

        return [
            'origin'   => ['lat' => $oLat, 'lon' => $oLon],
            'profiles' => $profiles,
            'stats'    => $stats,
        ];
    }

    /**
     * Terrenghøgde i eitt enkelt punkt, via Kartverket sitt punkt-API.
     * Brukast til bakkehøgda under brukarens eige punkt.
     *
     * @return array{z:float, terreng:?string, datakilde:?string}|null
     */
    public function point(float $lat, float $lon): ?array
    {
        $key    = self::cacheKey($lat, $lon, $lat, $lon, 1);
        $cached = $this->readCache($key);
        if ($cached !== null && isset($cached[0]['z'])) {
            return [
                'z'         => (float) $cached[0]['z'],
                'terreng'   => $cached[0]['terreng'] ?? null,
                'datakilde' => $cached[0]['datakilde'] ?? null,
            ];
        }

        $url = self::POINT_URL . '?' . http_build_query([
            'ost'      => $lon,   // aust = lengdegrad
            'nord'     => $lat,   // nord = breiddegrad
            'koordsys' => 4258,   // ETRS89 geografisk ≈ WGS84 for vårt føremål
            'geojson'  => 'false',
        ]);

        $data = Http::getJson($url, $error, 20);
        if ($data === null || empty($data['punkter'][0])) {
            Logger::warn('elevation_point_lookup', 'Kartverket punkt-API feila', ['feil' => $error ?? '?']);
            return null;
        }

        $p   = $data['punkter'][0];
        $out = [
            'z'         => max(0.0, (float) ($p['z'] ?? 0)),
            'terreng'   => $p['terreng'] ?? null,
            'datakilde' => $p['datakilde'] ?? null,
        ];

        $this->writeCache($key, [[
            'd' => 0.0, 'z' => $out['z'], 'lat' => $lat, 'lon' => $lon,
            'terreng' => $out['terreng'], 'datakilde' => $out['datakilde'],
        ]]);

        return $out;
    }

    /**
     * Terrenghøgd for ei vilkårleg mengd punkt, batcha gjennom WPS-en.
     *
     * -----------------------------------------------------------------------
     * KVIFOR DENNE FINST VED SIDA AV profiles()
     * -----------------------------------------------------------------------
     * `profiles()` er bygd rundt eit origo og ei rekkje mål — punkta ligg på
     * linjer. Turbinutplasseringa (TurbineLayout) treng noko heilt anna: eit
     * RUTENETT av kandidatpunkt inne i eit polygon, utan noko origo i det heile.
     *
     * Begge lener seg på same eksperimentelt verifiserte eigenskap ved WPS-en:
     * er talet trackpunkt nøyaktig lik `points`, får ein høgda i akkurat dei
     * punkta ein sende inn — òg når dei ikkje heng saman i ei linje. Sjå
     * klassekommentaren over.
     *
     * Cache-nøkkelen er DEN SAME som `point()` bruker, slik at eit punkt henta
     * her seinare vert eit cache-treff for eit vanleg punktoppslag, og omvendt.
     *
     * @param list<array{0:float,1:float}> $points  [[lat, lon], ...]
     * @param callable|null $onProgress  fn(int $ferdig, int $totalt): void
     * @return array<int,array{z:float,terreng:?string}|null> same rekkjefølgje som input
     */
    public function points(array $points, ?callable $onProgress = null): array
    {
        $out     = [];
        $pending = [];   // indeks → [lat, lon, key]

        foreach ($points as $i => $p) {
            $lat = round((float) $p[0], 6);
            $lon = round((float) $p[1], 6);
            $key = self::cacheKey($lat, $lon, $lat, $lon, 1);

            $cached = $this->readCache($key);
            if ($cached !== null && isset($cached[0]['z'])) {
                $out[$i] = ['z' => (float) $cached[0]['z'], 'terreng' => $cached[0]['terreng'] ?? null];
                continue;
            }
            $out[$i]   = null;
            $pending[] = ['i' => $i, 'lat' => $lat, 'lon' => $lon, 'key' => $key];
        }

        $total = count($pending);
        $done  = 0;

        foreach (array_chunk($pending, self::MAX_POINTS_PER_CALL) as $chunk) {
            $flat = array_map(static fn($p) => [$p['lat'], $p['lon']], $chunk);
            $rows = $this->queryWps($flat);

            $done += count($chunk);
            if ($onProgress !== null) {
                $onProgress($done, $total);
            }

            // Ein feilande batch skal ikkje velte heile jobben — dei råka
            // punkta vert ståande som null, og kallaren hoppar over dei.
            if ($rows === null || count($rows) !== count($chunk)) {
                continue;
            }

            foreach ($chunk as $k => $p) {
                $row = $rows[$k];
                $z   = max(0.0, (float) ($row['elevation'] ?? 0));
                $terreng = $row['terrain'] ?? null;

                $out[$p['i']] = ['z' => $z, 'terreng' => $terreng];
                $this->writeCache($p['key'], [[
                    'd' => 0.0, 'z' => round($z, 1), 'lat' => $p['lat'], 'lon' => $p['lon'],
                    'terreng' => $terreng,
                ]]);
            }
        }

        ksort($out);
        return $out;
    }

    // ---------------------------------------------------- overflatemodellen

    /**
     * Høgd i vilkårlege punkt frå ei NAMNGJEVEN datakjelde (dtm1 / dom1).
     *
     * -----------------------------------------------------------------------
     * `null` TYDER «VEIT IKKJE», OG DET ER IKKJE DET SAME SOM 0
     * -----------------------------------------------------------------------
     * `profiles()` og `points()` klemmer negative høgder til 0, fordi havbotn
     * ikkje er ei sikthindring. Her gjer me det motsette med manglande data:
     * utanfor laserdekninga svarar tenesta `{"x":3.5,"y":58.0,"z":null}`, og
     * det MÅ komme ut som `null`.
     *
     * Grunnen er kva svaret brukast til. Ein DOM-verdi vert samanlikna med
     * DTM-verdien i same punkt for å svare «står det skog her?». Vart eit
     * manglande svar til 0, ville samanlikninga sagt at overflata ligg
     * LÅGARE enn bakken — altså «her er det hogd», som er ei påstand me ikkje
     * har dekning for. Kallaren må kunne skilje «ingen skog» frå «ikkje målt».
     *
     * @param list<array{0:float,1:float}> $points  [[lat, lon], ...]
     * @param string $datakilde  Må vere i self::KJELDER
     * @return array{
     *     hoyder: array<int, float|null>,
     *     stats: array{cache_treff:int, hentet:int, kall:int, feila:int}
     * }
     */
    public function sourcePoints(array $points, string $datakilde): array
    {
        if (!in_array($datakilde, self::KJELDER, true)) {
            throw new InvalidArgumentException('Ukjend datakilde: ' . $datakilde);
        }

        $out     = [];
        $pending = [];
        $stats   = ['cache_treff' => 0, 'hentet' => 0, 'kall' => 0, 'feila' => 0];

        foreach ($points as $i => $p) {
            $lat = round((float) $p[0], 6);
            $lon = round((float) $p[1], 6);
            $key = self::cacheKey($lat, $lon, $lat, $lon, 1, $datakilde);

            $cached = $this->readCache($key);
            if ($cached !== null && array_key_exists('z', $cached[0])) {
                // Eit cacha «ingen data» ligg som z = null og skal bli null
                // igjen — ikkje hentast på nytt, og ikkje bli 0.
                $z = $cached[0]['z'];
                $out[$i] = $z === null ? null : (float) $z;
                $stats['cache_treff']++;
                continue;
            }
            $out[$i]   = null;
            $pending[] = ['i' => $i, 'lat' => $lat, 'lon' => $lon, 'key' => $key];
        }

        foreach (array_chunk($pending, self::MAX_SOURCE_POINTS_PER_CALL) as $chunk) {
            $rows = $this->querySource($chunk, $datakilde);
            $stats['kall']++;

            if ($rows === null) {
                // Eit feilande kall skal ikkje velte resten — dei råka punkta
                // vert ståande som null, og kallaren hoppar over dei. Dei vert
                // heller ikkje cacha, så neste forsøk prøver på nytt.
                $stats['feila'] += count($chunk);
                continue;
            }

            foreach ($chunk as $k => $p) {
                $row = $rows[$k] ?? null;

                /**
                 * KONTROLLER AT SVARET GJELD PUNKTET VÅRT.
                 *
                 * Tenesta ekkar koordinatane ho slo opp. Med 50 punkt i eitt
                 * kall er ei stille ombytting av rekkjefølgja den einaste
                 * feilen som ville gitt eit *plausibelt* men feil svar — ein
                 * DOM-verdi frå ein heilt annan stad, tolka som skog her.
                 * Difor sjekkast han, i staden for å stolast på.
                 */
                if ($row === null
                    || abs(((float) ($row['x'] ?? 1e9)) - $p['lon']) > self::SOURCE_ECHO_TOLERANCE_DEG
                    || abs(((float) ($row['y'] ?? 1e9)) - $p['lat']) > self::SOURCE_ECHO_TOLERANCE_DEG) {
                    Logger::warn('elevation_source', 'Punktsvaret svarar ikkje til punktet me spurde om', [
                        'datakilde' => $datakilde,
                        'venta'     => $p['lat'] . ',' . $p['lon'],
                        'fekk'      => ($row['y'] ?? '?') . ',' . ($row['x'] ?? '?'),
                    ]);
                    $stats['feila']++;
                    continue;
                }

                $z = array_key_exists('z', $row) && $row['z'] !== null ? (float) $row['z'] : null;

                $out[$p['i']] = $z;
                $this->writeCache($p['key'], [[
                    'd' => 0.0, 'z' => $z === null ? null : round($z, 2),
                    'lat' => $p['lat'], 'lon' => $p['lon'], 'datakilde' => $datakilde,
                ]]);
                $stats['hentet']++;
            }
        }

        ksort($out);
        return ['hoyder' => $out, 'stats' => $stats];
    }

    /**
     * Eitt kall mot punkt-tenesta for ei namngjeven datakjelde.
     *
     * @param list<array{i:int,lat:float,lon:float,key:string}> $chunk
     * @return list<array<string,mixed>>|null
     */
    private function querySource(array $chunk, string $datakilde): ?array
    {
        // [ost, nord] — tenesta krev den rekkjefølgja (som GeoJSON), altså
        // lon før lat. Byter ein om, får ein høgder frå Sibir utan feilmelding.
        $koordinatar = array_map(
            static fn($p) => [$p['lon'], $p['lat']],
            $chunk,
        );

        $url = sprintf(self::SOURCE_POINT_URL, rawurlencode($datakilde)) . '?' . http_build_query([
            'koordsys' => 4258,
            'punkter'  => json_encode($koordinatar),
            'geojson'  => 'false',
        ]);

        $data = Http::getJson($url, $error, 30);
        if ($data === null || !isset($data['punkter']) || !is_array($data['punkter'])) {
            Logger::warn('elevation_source', 'Kartverket punkt-API feila', [
                'datakilde' => $datakilde,
                'tal_punkt' => count($chunk),
                'feil'      => $error ?? '?',
            ]);
            return null;
        }

        if (count($data['punkter']) !== count($chunk)) {
            Logger::warn('elevation_source', 'Fekk feil tal punkt tilbake', [
                'datakilde' => $datakilde,
                'sende'     => count($chunk),
                'fekk'      => count($data['punkter']),
            ]);
            return null;
        }

        return array_values($data['punkter']);
    }

    // ------------------------------------------------------------------ WPS

    /**
     * Send eitt WPS Execute-kall og returner rådene i same rekkjefølgje.
     *
     * @param list<array{0:float,1:float}> $points
     * @return list<array<string,mixed>>|null
     */
    private function queryWps(array $points): ?array
    {
        if ($points === []) {
            return [];
        }

        $trkpts = '';
        foreach ($points as $p) {
            $trkpts .= sprintf('<trkpt lat="%.6f" lon="%.6f"></trkpt>', $p[0], $p[1]);
        }

        // GPX-en skal limast inn midt i eit anna XML-dokument og må difor IKKJE
        // ha si eiga XML-deklarasjon på toppen.
        $gpx = '<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">'
             . '<trk><trkseg>' . $trkpts . '</trkseg></trk></gpx>';

        $count = count($points);
        $xml = '<wps:Execute xmlns:wps="http://www.opengis.net/wps/1.0.0" '
             . 'xmlns:ows="http://www.opengis.net/ows/1.1" service="WPS" version="1.0.0">'
             . '<ows:Identifier>elevationJSON</ows:Identifier>'
             . '<wps:DataInputs>'
             . '<wps:Input><ows:Identifier>gpx</ows:Identifier><wps:Data>'
             . '<wps:ComplexData mimeType="application/gpx+xml">' . $gpx . '</wps:ComplexData>'
             . '</wps:Data></wps:Input>'
             // points === talet på trackpunkt: det er dette som gjer at me får
             // høgda i akkurat våre eigne punkt tilbake.
             . '<wps:Input><ows:Identifier>points</ows:Identifier><wps:Data>'
             . '<wps:LiteralData>' . $count . '</wps:LiteralData>'
             . '</wps:Data></wps:Input>'
             . '</wps:DataInputs>'
             . '<wps:ResponseForm>'
             . '<wps:RawDataOutput mimeType="application/json"><ows:Identifier>json</ows:Identifier></wps:RawDataOutput>'
             . '</wps:ResponseForm>'
             . '</wps:Execute>';

        $res = Http::post(self::WPS_URL, $xml, ['Content-Type: text/xml'], 60);
        if (!$res['ok']) {
            Logger::warn('elevation_wps', 'WPS-kall feila', [
                'tal_punkt' => $count,
                'http_status' => $res['status'] ?? '?',
                'feil' => $res['error'] ?? '?',
            ]);
            return null;
        }

        $data = json_decode(self::sanerJson($res['body']), true);
        if (!is_array($data) || $data === []) {
            Logger::warn('elevation_wps', 'WPS svarte, men ikkje med gyldig JSON-array', [
                'tal_punkt' => $count,
                'body_start' => substr($res['body'], 0, 300),
            ]);
            return null;
        }
        return $data;
    }

    /**
     * WPS-EN SENDER `NaN`, OG DET ER IKKJE GYLDIG JSON.
     *
     * -----------------------------------------------------------------------
     * KVA SOM SKJER
     * -----------------------------------------------------------------------
     * Over sjø utan djupnedata svarar `elevationJSON` med den berre symbolet
     * `NaN` som talverdi:
     *
     *     {"distance": 19.6, "elevation": NaN, "lat": 58.6295, "lon": 5.3922,
     *      "road": "", "terrain": "Havflate"}
     *
     * JSON-grammatikken har ingen `NaN` (heller ikkje `Infinity`), så
     * `json_decode()` returnerer null for HEILE svaret. Eitt einaste
     * ukartlagt sjøpunkt kasta dermed opptil 380 terrengpunkt — og sidan
     * ingenting vart cacha, prøvde kvar nye panoramaopning nøyaktig same
     * dødsdømte kallet på nytt.
     *
     * Verifisert mot primærkjelda: eit punkt på Høg-Jæren (58,63 / 5,73) med
     * strålar 250°, 270° og 290° ut i Nordsjøen gav alle
     * `json_last_error_msg() = "Syntax error"`, medan 90° og 180° (innover
     * land) dekoda reint. Symptomet var ikkje ein feilmelding, men at
     * kystpunkt var PERMANENT trege: horisonten tok 30 s sjølv med varm
     * cache, fordi dei same kalla feila kvar gong.
     *
     * -----------------------------------------------------------------------
     * KVIFOR `null` OG IKKJE NOKO ANNA
     * -----------------------------------------------------------------------
     * `NaN` her tyder «her er det hav, og me har ikkje djupnetal». Havflata
     * er 0 moh., og resten av klassen klemmer allereie negative djupner til 0
     * (sjå `profiles()`) fordi havbotn ikkje er ei sikthindring. `null` fell
     * gjennom `(float) null` og `?? 0` til nøyaktig same 0 — altså same
     * handsaming som ei kjend djupne på −223 m alt får.
     *
     * Mønsteret treffer berre talverdiar (`: NaN`), aldri innhaldet i ein
     * streng: `"road": "NaNsen gate"` har ikkje kolon-mellomrom-NaN utan
     * hermeteikn framfor, og `\b` hindrar treff inne i eit lengre ord.
     */
    private static function sanerJson(string $body): string
    {
        return preg_replace('/:\s*-?(?:NaN|Infinity)\b/', ': null', $body) ?? $body;
    }

    /**
     * Grupper ventande profilar i kall som held seg under punktgrensa.
     *
     * @param list<array{id:string,key:string,points:list<array{0:float,1:float}>}> $pending
     * @return list<list<array{id:string,key:string,points:list<array{0:float,1:float}>}>>
     */
    private static function packBatches(array $pending): array
    {
        $batches = [];
        $current = [];
        $size    = 0;

        foreach ($pending as $item) {
            $n = count($item['points']);
            if ($current !== [] && $size + $n > self::MAX_POINTS_PER_CALL) {
                $batches[] = $current;
                $current   = [];
                $size      = 0;
            }
            $current[] = $item;
            $size     += $n;
        }
        if ($current !== []) {
            $batches[] = $current;
        }

        return $batches;
    }

    // -------------------------------------------------------------- geometri

    /**
     * Avstandsbrøkane (0..1) profilen skal samplast i.
     *
     * Todelt: eit tett sett over nærsona (sjå NEAR_FIELD_M), og eit jamt sett
     * over resten. Returnerer alltid både 0.0 og 1.0, slik at profilen startar
     * nøyaktig på observatøren og endar nøyaktig på målet — begge er
     * føresetnader for berekninga i ImpactCalculator.
     *
     * @return list<float> stigande, unike brøkar
     */
    public static function sampleFractions(float $distanceM): array
    {
        if ($distanceM <= 0) {
            return [0.0];
        }

        $fractions = [];

        // Nærsone: fast punktavstand fram til NEAR_FIELD_M (eller målet).
        $nearLimit = min(self::NEAR_FIELD_M, $distanceM);
        for ($d = 0.0; $d < $nearLimit; $d += self::NEAR_FIELD_SPACING_M) {
            $fractions[] = $d / $distanceM;
        }

        // Hovuddel: jamt fordelt over resten.
        $remaining = $distanceM - $nearLimit;
        if ($remaining > 0) {
            $n = (int) ceil($remaining / self::SAMPLE_SPACING_M) + 1;
            $n = max(self::MIN_SAMPLES, min(self::MAX_SAMPLES, $n));
            for ($i = 0; $i < $n; $i++) {
                $f = $n > 1 ? $i / ($n - 1) : 1.0;
                $fractions[] = ($nearLimit + $remaining * $f) / $distanceM;
            }
        }

        $fractions[] = 1.0;

        // Fjern duplikat (kan oppstå i overgangen mellom sonene) og sorter.
        $fractions = array_values(array_unique(array_map(
            static fn($f) => round(max(0.0, min(1.0, $f)), 6),
            $fractions
        )));
        sort($fractions);

        return $fractions;
    }

    /**
     * Tal profilpunkt for ein gitt avstand. Brukast av API-laget til å
     * estimere kor mange WPS-kall ein førespurnad vil koste.
     */
    public static function sampleCount(float $distanceM): int
    {
        return count(self::sampleFractions($distanceM));
    }

    /**
     * Punkt langs linja frå origo til mål, i dei gitte avstandsbrøkane.
     *
     * Lineær interpolasjon i lat/lon er nøyaktig nok her: avviket frå
     * storsirkelen er under ein meter for dei avstandane appen bruker (<50 km).
     *
     * @param list<float> $fractions
     * @return list<array{0:float,1:float}>
     */
    private static function interpolate(float $lat1, float $lon1, float $lat2, float $lon2, array $fractions): array
    {
        $points = [];
        foreach ($fractions as $f) {
            $points[] = [
                $lat1 + ($lat2 - $lat1) * $f,
                $lon1 + ($lon2 - $lon1) * $f,
            ];
        }
        return $points;
    }

    /** Avstand i meter mellom to WGS84-punkt. */
    public static function haversine(float $lat1, float $lon1, float $lat2, float $lon2): float
    {
        $r  = 6371008.8; // IUGG middelradius
        $p1 = deg2rad($lat1);
        $p2 = deg2rad($lat2);
        $dp = $p2 - $p1;
        $dl = deg2rad($lon2 - $lon1);

        $a = sin($dp / 2) ** 2 + cos($p1) * cos($p2) * sin($dl / 2) ** 2;
        return 2 * $r * asin(min(1.0, sqrt($a)));
    }

    // ----------------------------------------------------------------- cache

    /**
     * `$kilde` vert lagt til FØRST når han ikkje er tom.
     *
     * Det er ikkje kosmetikk: alle eksisterande cache-filer (titusenvis av
     * terrengpunkt og profilar) er skrivne med den gamle femdelte strengen.
     * Ein ubetinga sjette del ville endra kvar einaste nøkkel og gjort heile
     * den permanente cachen kald på ein deploy — for ei endring som berre
     * legg til ei NY datakjelde ved sida av. DTM-nøklane er difor bokstavleg
     * uendra, og `dom1` får sitt eige nøkkelrom.
     */
    private static function cacheKey(float $oLat, float $oLon, float $tLat, float $tLon, int $n, string $kilde = ''): string
    {
        $s = sprintf('%.4f,%.4f|%.6f,%.6f|%d', $oLat, $oLon, $tLat, $tLon, $n);
        return sha1($kilde === '' ? $s : $s . '|' . $kilde);
    }

    /**
     * Cache-filene vert lagt i undermapper etter dei to første hex-teikna.
     * Utan det ville éi mappe kunne få hundretusenvis av filer, noko mange
     * filsystem handterer dårleg.
     */
    private function cachePath(string $key): string
    {
        return $this->cacheDir . '/' . substr($key, 0, 2) . '/' . $key . '.json';
    }

    /** @return list<array<string,mixed>>|null */
    private function readCache(string $key): ?array
    {
        $path = $this->cachePath($key);
        if (!is_readable($path)) {
            return null;
        }
        $data = json_decode((string) file_get_contents($path), true);
        return is_array($data) && $data !== [] ? $data : null;
    }

    /** @param list<array<string,mixed>> $profile */
    private function writeCache(string $key, array $profile): void
    {
        $path = $this->cachePath($key);
        $dir  = dirname($path);
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            return; // cache er ein optimalisering — feil her skal ikkje kaste
        }
        $json = json_encode($profile, JSON_UNESCAPED_UNICODE);
        if ($json !== false) {
            @file_put_contents($path, $json, LOCK_EX);
        }
    }
}
