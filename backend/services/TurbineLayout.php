<?php
/**
 * backend/services/TurbineLayout.php
 *
 * Estimerer KVAR turbinane i eit planlagt anlegg truleg kjem til å stå, når
 * NVE ikkje har turbinpunkt for anlegget.
 *
 * ---------------------------------------------------------------------------
 * PROBLEMET
 * ---------------------------------------------------------------------------
 * Lag 4 hos NVE (`Vindturbin`) dekkjer berre anlegg i drift eller under
 * bygging. Eit anlegg under konsesjonshandsaming har INGEN turbinkoordinatar —
 * detaljplanen kjem først etter vedtak, og søkjaren offentleggjer nesten aldri
 * eksakte punkt før det. Appen har difor til no representert slike anlegg med
 * EITT plassholdar-punkt i anleggets senter.
 *
 * Det er ærleg, men lite nyttig: eit senterpunkt kan liggje i ein dal medan
 * turbinane kjem oppe på ryggen, det gir ingen spreiing i avstand, og
 * støymodellen må gripe til eit grovt `+10·log₁₀(N)`-påslag for å kompensere.
 *
 * ---------------------------------------------------------------------------
 * DET ME FAKTISK HAR Å GÅ PÅ
 * ---------------------------------------------------------------------------
 * `cache/areas.json` inneheld det EKTE planområdet frå NVE — polygongrensa
 * søknaden gjeld, kobla på same `anleggsnr`. Turbinane kjem til å stå inne i
 * det polygonet. Det er ikkje ei gjetting; det er ei kjeldefest avgrensing.
 *
 * Innanfor polygonet har me Kartverket sin terrengmodell. Og me har eit
 * empirisk mønster som held nesten unntaksfritt i Noreg: **vindparkar vert
 * lagde langs ås- og fjellryggar**, ikkje i daler og søkk. Vinden er sterkare
 * og jamnare på ein rygg, og det er heile grunnen til at anlegget ligg der.
 *
 * ---------------------------------------------------------------------------
 * ALGORITMEN
 * ---------------------------------------------------------------------------
 *  1. Legg eit kandidatrutenett inne i polygonet.
 *  2. Hent terrenghøgd for kvart kandidatpunkt (batcha gjennom WPS-en).
 *  3. Kast punkt på openbert ueigna grunn (vatn, hav, elv, tettbygd).
 *  4. Gi kvart punkt ein score = kor høgt det ligg over NABOANE sine, pluss
 *     eit mindre tillegg for kor høgt det ligg i området samla.
 *  5. Vel grådig frå toppen, med handheva minsteavstand mellom valde punkt.
 *
 * ---------------------------------------------------------------------------
 * TO VAL SOM ER LETTE Å GJERE FEIL
 * ---------------------------------------------------------------------------
 * **a) Kandidatrutenettet må vere TETTARE enn turbinavstanden.**
 * Det opplagte er å leggje rutenettet med same avstand som turbinane skal ha
 * (3–4 rotordiameter). Då er det ingenting igjen å velje: kvart rutepunkt
 * vert ein turbin, og «heuristikken» er i praksis eit fast rutenett som
 * ignorerer terrenget — nettopp det denne algoritmen skal unngå. Rutenettet
 * ligg difor på ~1,5 rotordiameter, slik at det finst 4–6 kandidatar å velje
 * mellom for kvar turbin som skal plasserast.
 *
 * **b) «Høgt» må målast mot naboane, ikkje absolutt.**
 * Ein rein «vel dei høgaste punkta»-regel legg alle turbinane i den eine enden
 * av eit område som skrår. Prominens (høgd over eit lokalt gjennomsnitt) finn
 * ryggformer uansett kvar i området dei ligg. Eit lite absoluttledd er likevel
 * med, elles vinn ein knaus i ein dal over ein brei rygg.
 *
 * ---------------------------------------------------------------------------
 * KVA DETTE IKKJE ER
 * ---------------------------------------------------------------------------
 * Resultatet er merkt `posisjon_kilde: "estimert_i_omrade"` og skal ALDRI
 * presenterast som ein omsøkt plassering. Me har ingen vinddata, ingen
 * grunnforhold, ingen reindriftsomsyn, ingen naturtypekartlegging, ingen
 * vegplan — alt saman ting som styrer ei verkeleg detaljplassering.
 * Det me kan seie er: «så mange turbinar, spreidde slik, inne i dette
 * området» — og det er langt meir informativt enn eitt punkt i senter.
 */

require_once __DIR__ . '/ElevationService.php';

class TurbineLayout
{
    /**
     * Kandidatrutenettet sin avstand, i rotordiameter. Sjå (a) over.
     * 1,5 gir 4–6 kandidatar per turbinplass — nok til eit reelt val, utan at
     * talet på høgdeoppslag eksploderer.
     */
    private const KANDIDAT_SPACING_RD = 1.5;

    /**
     * Minste avstand mellom valde turbinar, i rotordiameter.
     *
     * 3 RD er den vanlege nedre enden i norske parkar (turbulens frå
     * naboturbinen gjer tettare plassering lite lønsamt). Verkelege parkar
     * ligg gjerne på 3–5 RD på tvers av hovudvindretninga og meir på langs;
     * utan vinddata har me ikkje grunnlag for å skilje retningane, så me
     * bruker éin isotrop minsteavstand.
     */
    private const MIN_AVSTAND_RD = 3.0;

    /**
     * Absolutt golv for avstanden, i rotordiameter.
     *
     * Får ikkje alle N turbinane plass ved 3 RD, slakkar algoritmen kravet i
     * trinn — men aldri under 2,2 RD. Under det står turbinane så tett at
     * biletet ville vore misvisande uansett kva NVE-tala seier; då er det
     * heller turbintalet eller polygonet som ikkje stemmer, og me viser dei
     * me fekk plass til i staden for å presse inn resten.
     */
    private const GULV_AVSTAND_RD = 2.2;

    /** Absolutte grenser på rutenettavstanden (meter), same kor rar rotoren er. */
    private const MIN_SPACING_M = 120.0;
    private const MAX_SPACING_M = 600.0;

    /**
     * Tak på tal kandidatpunkt per anlegg. Kvart punkt er eit høgdeoppslag;
     * utan tak ville eit 500 km²-havområde åleine kosta tusenvis av dei.
     */
    private const MAKS_KANDIDATAR = 1500;

    /** Tak på tal turbinar me plasserer for eitt anlegg. */
    private const MAKS_TURBINAR = 150;

    /**
     * Naboradius for prominensberekninga, i rutenettavstandar.
     * 2,5 gir eit nabolag på ~20 punkt — stort nok til å skilje ein rygg frå
     * ein tilfeldig ujamnheit, lite nok til å ikkje midle bort heile forma.
     */
    private const NABO_RADIUS_STEG = 2.5;

    /**
     * Vekt på det absolutte høgdeleddet. Begge ledda er i meter, så vekta er
     * direkte tolkbar: 0,25 tyder at 4 m ekstra høgd i området samla er verdt
     * like mykje som 1 m ekstra lokal prominens.
     */
    private const ABSOLUTT_VEKT = 0.25;

    /**
     * Terrengtypar frå Kartverket der ein turbin ikkje kan stå.
     * Verifisert mot faktiske svar i `cache/elevation/` — dette er dei
     * strengane API-et returnerer, ikkje gjetta namn.
     */
    private const UEIGNA_TERRENG = [
        'Havflate', 'Innsjø', 'InnsjøRegulert', 'Elv', 'Tettbebyggelse', 'Gravplass',
    ];

    /**
     * Terrengtypar som gir straff, men ikkje utestenging. Turbinar VERT bygde
     * på myr i Noreg (med masseutskifting), men det er dyrare og omstridd, så
     * ein utbyggjar vel fast mark når han kan.
     */
    private const STRAFFA_TERRENG = ['Myr' => 8.0, 'DyrketMark' => 4.0];

    /** Andel sjøpunkt i stikkprøva før eit område vert rekna som offshore. */
    private const OFFSHORE_TERSKEL = 0.7;

    private ElevationService $elevation;
    /** @var string[] */
    private array $log = [];

    public function __construct(?ElevationService $elevation = null)
    {
        $this->elevation = $elevation ?? new ElevationService();
    }

    /** @return string[] */
    public function log(): array
    {
        return $this->log;
    }

    /**
     * Plasser $n turbinar inne i $rings.
     *
     * @param list<list<list<array{0:float,1:float}>>> $polygon
     *        Liste av POLYGON. Kvart polygon er ei liste av ringar, kvar ring
     *        ei liste av [lat, lon]-par. Sjå iNokoPolygon() for kvifor nivået
     *        med polygon ikkje kan flatast ut.
     * @param int   $n                Ønska tal turbinar
     * @param float $rotorDiameterM
     * @return array{
     *   punkt: list<array{lat:float, lon:float, moh:float, terreng:?string, score:float}>,
     *   maal: int, plasserte: int, spacing_m: float, min_avstand_m: float,
     *   kandidatar: int, offshore: bool, notat: string
     * }|null  null når området ikkje kan brukast (offshore, for lite, ingen data)
     */
    public function plasser(array $polygon, int $n, float $rotorDiameterM): ?array
    {
        $n = max(1, min(self::MAKS_TURBINAR, $n));
        $rotor = $rotorDiameterM > 0 ? $rotorDiameterM : 130.0;

        $spacing = max(self::MIN_SPACING_M, min(self::MAX_SPACING_M, self::KANDIDAT_SPACING_RD * $rotor));
        $minAvstand = self::MIN_AVSTAND_RD * $rotor;

        // --- 1. Kandidatrutenett -------------------------------------------
        $kandidatar = self::rutenettIPolygon($polygon, $spacing, self::MAKS_KANDIDATAR);
        if (count($kandidatar) < 1) {
            $this->log[] = 'Ingen kandidatpunkt fekk plass i polygonet.';
            return null;
        }

        // --- 2. Er dette eit havområde? ------------------------------------
        // Ein stikkprøve på ~12 punkt kostar eitt WPS-kall og sparer oss for
        // fleire hundre oppslag over open sjø, der heile ryggheuristikken
        // uansett er meiningslaus (havbotn er ikkje vindeksponering).
        if ($this->erOffshore($kandidatar)) {
            $this->log[] = 'Området ligg på sjø — hoppar over utplassering.';
            return null;
        }

        // --- 3. Terrenghøgd for alle kandidatar ----------------------------
        $hoyder = $this->elevation->points(array_map(
            static fn($p) => [$p[0], $p[1]],
            $kandidatar
        ));

        $punkt = [];
        foreach ($kandidatar as $i => $k) {
            $h = $hoyder[$i] ?? null;
            if ($h === null) {
                continue;   // batchen feila for dette punktet
            }
            $punkt[] = ['lat' => $k[0], 'lon' => $k[1], 'z' => $h['z'], 'terreng' => $h['terreng']];
        }

        if (count($punkt) < 2) {
            $this->log[] = 'Fekk ikkje henta terrengdata for kandidatpunkta.';
            return null;
        }

        // --- 4. Score ------------------------------------------------------
        $brukbare = $this->scoreKandidatar($punkt, $spacing);
        if ($brukbare === []) {
            $this->log[] = 'Alle kandidatpunkt låg på ueigna grunn.';
            return null;
        }

        // --- 5. Grådig utval med minsteavstand ------------------------------
        [$valde, $faktiskMinAvstand] = self::veljMedAvstand(
            $brukbare,
            $n,
            $minAvstand,
            self::GULV_AVSTAND_RD * $rotor,
        );

        return [
            'punkt'         => $valde,
            'maal'          => $n,
            'plasserte'     => count($valde),
            'spacing_m'     => round($spacing, 1),
            'min_avstand_m' => round($faktiskMinAvstand, 1),
            'kandidatar'    => count($brukbare),
            'offshore'      => false,
            'notat'         => count($valde) < $n
                ? 'Det var ikkje plass til alle turbinane i polygonet med den handheva minsteavstanden.'
                : '',
        ];
    }

    // ---------------------------------------------------------------- steg 1

    /**
     * Eit rutenett av punkt inne i polygonet.
     *
     * Rutenettet er forskuve annakvar rad (kvinkunks/heksagonalt mønster), som
     * pakkar punkta jamnare enn eit kvadratisk rutenett og gjer at
     * minsteavstands-utvalet i steg 5 har fleire brukbare naboar å velje
     * mellom. Same grunn til at ein legg trerekker forskuve.
     *
     * @param list<list<list<array{0:float,1:float}>>> $polygon
     * @return list<array{0:float,1:float}>
     */
    private static function rutenettIPolygon(array $polygon, float $spacingM, int $maks): array
    {
        [$latMin, $latMaks, $lonMin, $lonMaks] = self::bbox($polygon);
        if ($latMin === null) {
            return [];
        }

        $latMidt = ($latMin + $latMaks) / 2;
        // Grader per meter. Lengdegrader vert kortare jo lenger nord ein kjem —
        // på 70°N er ein lengdegrad ein tredel så lang som på ekvator, og eit
        // rutenett som ignorerer det vert kraftig avlangt i Finnmark.
        [$mPerLat, $mPerLon] = self::meterPerGrad($latMidt);
        $dLat = $spacingM / $mPerLat;
        $dLon = $spacingM / $mPerLon;

        $ut  = [];
        $rad = 0;
        for ($lat = $latMin + $dLat / 2; $lat <= $latMaks; $lat += $dLat) {
            $forskyv = ($rad % 2 === 1) ? $dLon / 2 : 0.0;
            for ($lon = $lonMin + $dLon / 2 + $forskyv; $lon <= $lonMaks; $lon += $dLon) {
                if (self::iNokoPolygon($lat, $lon, $polygon)) {
                    $ut[] = [round($lat, 6), round($lon, 6)];
                    if (count($ut) >= $maks) {
                        return $ut;
                    }
                }
            }
            $rad++;
        }

        return $ut;
    }

    /** @return array{0:?float,1:?float,2:?float,3:?float} */
    private static function bbox(array $polygon): array
    {
        $latMin = $lonMin = INF;
        $latMaks = $lonMaks = -INF;
        foreach ($polygon as $rings) {
            foreach ($rings as $ring) {
                foreach ($ring as $p) {
                    $latMin = min($latMin, $p[0]);
                    $latMaks = max($latMaks, $p[0]);
                    $lonMin = min($lonMin, $p[1]);
                    $lonMaks = max($lonMaks, $p[1]);
                }
            }
        }
        return is_finite($latMin)
            ? [$latMin, $latMaks, $lonMin, $lonMaks]
            : [null, null, null, null];
    }

    /**
     * Ligg punktet inne i minst EITT av polygona?
     *
     * =======================================================================
     * KVIFOR POLYGONA IKKJE KAN SLÅAST SAMAN TIL ÉI RINGLISTE
     * =======================================================================
     * Det opplagte er å hive alle ringane frå alle områdeoppføringane i éi
     * liste og køyre odde/like-regelen over dei. Det er FEIL, og feilen er
     * stille: NVE har fleire områdelag (lag 3 og lag 10), og eit anlegg under
     * konsesjonshandsaming ligg ofte i begge — med same eller overlappande
     * omriss. To ringar som dekkjer same areal kryssast to gonger av kvar
     * stråle, odde/like-teljinga går tilbake til «utanfor», og heile
     * planområdet forsvinn. Verifisert på Moifjellet (anleggsnr 14237), som
     * har to oppføringar: samanslått gav polygonet NULL kandidatpunkt.
     *
     * Odde/like-regelen gjeld difor INNANFOR eitt polygon (der han er nøyaktig
     * det ein vil ha — ein indre ring vert eit hol), medan fleire polygon
     * kombinerast som ei UNION.
     *
     * @param list<list<list<array{0:float,1:float}>>> $polygon
     */
    public static function iNokoPolygon(float $lat, float $lon, array $polygon): bool
    {
        foreach ($polygon as $rings) {
            if (self::iPolygon($lat, $lon, $rings)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Odde/like-regelen (crossing number) over ringane i EITT polygon.
     * Ein indre ring snur svaret og vert dermed eit hol — akkurat slik ArcGIS
     * meiner det når ytterring og hol kjem i same `rings`-liste.
     */
    public static function iPolygon(float $lat, float $lon, array $rings): bool
    {
        $inne = false;
        foreach ($rings as $ring) {
            $n = count($ring);
            for ($i = 0, $j = $n - 1; $i < $n; $j = $i++) {
                $yi = $ring[$i][0]; $xi = $ring[$i][1];
                $yj = $ring[$j][0]; $xj = $ring[$j][1];
                if ((($yi > $lat) !== ($yj > $lat))
                    && ($lon < ($xj - $xi) * ($lat - $yi) / (($yj - $yi) ?: 1e-12) + $xi)) {
                    $inne = !$inne;
                }
            }
        }
        return $inne;
    }

    // ---------------------------------------------------------------- steg 2

    /**
     * Stikkprøve for å avgjere om polygonet i hovudsak ligg på sjø.
     *
     * @param list<array{0:float,1:float}> $kandidatar
     */
    private function erOffshore(array $kandidatar): bool
    {
        $n = count($kandidatar);
        $tal = min(12, $n);
        $steg = max(1, (int) floor($n / $tal));

        $proeve = [];
        for ($i = 0; $i < $n && count($proeve) < $tal; $i += $steg) {
            $proeve[] = $kandidatar[$i];
        }

        $svar = $this->elevation->points($proeve);
        $sjo = 0;
        $gyldige = 0;
        foreach ($svar as $s) {
            if ($s === null) {
                continue;
            }
            $gyldige++;
            if ($s['terreng'] === 'Havflate' || $s['z'] <= 0.5) {
                $sjo++;
            }
        }

        return $gyldige > 0 && ($sjo / $gyldige) >= self::OFFSHORE_TERSKEL;
    }

    // ---------------------------------------------------------------- steg 4

    /**
     * Gi kvart brukbare kandidatpunkt ein score.
     *
     * score = (z − middel av naboane) + 0,25 · (z − middel av heile området) − terrengstraff
     *
     * Begge ledda er i meter, så vektinga er direkte tolkbar. Første ledd
     * finn ryggformer; andre ledd hindrar at ein knaus nede i ein dal slår ein
     * brei rygg oppe.
     *
     * @param list<array{lat:float,lon:float,z:float,terreng:?string}> $punkt
     * @return list<array{lat:float,lon:float,moh:float,terreng:?string,score:float}>
     */
    private function scoreKandidatar(array $punkt, float $spacingM): array
    {
        $sum = 0.0;
        foreach ($punkt as $p) {
            $sum += $p['z'];
        }
        $middelAlle = $sum / count($punkt);

        // Lokale meterkoordinatar til NABOSØKET.
        //
        // Nabosøket er O(n²) med n opp mot 1 500, så kvadrert planavstand
        // (~15× raskare enn haversine) er verdt det her. Feilen i ein plan
        // projeksjon er nokre tidels prosent på tvers av eit planområde — og
        // ein tidels prosent på ein naboradius har ingen verknad på ein score
        // som uansett er ein heuristikk.
        //
        // Merk at det MOTSETTE gjeld for minsteavstanden i steg 5: den vert
        // publisert som eit tal («minst 520 m mellom kvar»), og då må ho vere
        // eksakt. Der bruker me haversine. Sjå veljMedAvstand().
        $lat0 = 0.0;
        $lon0 = 0.0;
        foreach ($punkt as $p) {
            $lat0 += $p['lat'];
            $lon0 += $p['lon'];
        }
        $lat0 /= count($punkt);
        $lon0 /= count($punkt);

        [$mPerLat, $mPerLon] = self::meterPerGrad($lat0);
        $xy = [];
        foreach ($punkt as $p) {
            $xy[] = [($p['lon'] - $lon0) * $mPerLon, ($p['lat'] - $lat0) * $mPerLat];
        }

        $naboR2 = (self::NABO_RADIUS_STEG * $spacingM) ** 2;
        $ut = [];
        $n = count($punkt);

        for ($i = 0; $i < $n; $i++) {
            $p = $punkt[$i];
            if (in_array($p['terreng'], self::UEIGNA_TERRENG, true)) {
                continue;
            }

            $naboSum = 0.0;
            $naboTal = 0;
            for ($j = 0; $j < $n; $j++) {
                if ($i === $j) {
                    continue;
                }
                $dx = $xy[$i][0] - $xy[$j][0];
                $dy = $xy[$i][1] - $xy[$j][1];
                if ($dx * $dx + $dy * $dy <= $naboR2) {
                    $naboSum += $punkt[$j]['z'];
                    $naboTal++;
                }
            }

            $prominens = $naboTal > 0 ? $p['z'] - ($naboSum / $naboTal) : 0.0;
            $straff = self::STRAFFA_TERRENG[$p['terreng']] ?? 0.0;

            $ut[] = [
                'lat'     => $p['lat'],
                'lon'     => $p['lon'],
                'moh'     => round($p['z'], 1),
                'terreng' => $p['terreng'],
                'score'   => round($prominens + self::ABSOLUTT_VEKT * ($p['z'] - $middelAlle) - $straff, 2),
                '_x'      => $xy[$i][0],
                '_y'      => $xy[$i][1],
            ];
        }

        return $ut;
    }

    // ---------------------------------------------------------------- steg 5

    /**
     * Grådig utval frå toppen av score-lista, med handheva minsteavstand.
     *
     * Får me ikkje plass til alle N, slakkar me avstandskravet i trinn i
     * staden for å gi opp. Eit anlegg der NVE oppgir 40 turbinar i eit
     * polygon som berre rommar 25 ved 3 RD fortel oss at eitt av tala er
     * usikkert — men å vise 25 turbinar er framleis meir informativt enn å
     * vise eitt senterpunkt, og den FAKTISK handheva avstanden vert
     * rapportert ut slik at det kan seiast i UI.
     *
     * @param list<array<string,mixed>> $kandidatar
     * @return array{0:list<array<string,mixed>>, 1:float}
     */
    private static function veljMedAvstand(array $kandidatar, int $n, float $minAvstand, float $gulvAvstand): array
    {
        usort($kandidatar, static fn($a, $b) => $b['score'] <=> $a['score']);

        $avstand = $minAvstand;
        $beste = [];
        $besteAvstand = $minAvstand;

        while (true) {
            $valde = [];
            foreach ($kandidatar as $k) {
                $ok = true;
                foreach ($valde as $v) {
                    // EKSAKT haversine, ikkje planavstand.
                    //
                    // Denne avstanden vert rapportert ut som «minst X m mellom
                    // kvar turbin» og visast i UI. Ein plan projeksjon er
                    // 0,2–0,4 % for kort i Finnmark (verifisert: Nordkyn på
                    // 71°N fekk 517,8 m der talet sa 519,9 m), og eit publisert
                    // tal skal ikkje vere feil i det heile. Løkka går berre mot
                    // dei ALT VALDE punkta — maks 150 — så haversine kostar
                    // ingenting her, i motsetnad til i det kvadratiske nabosøket.
                    if (ElevationService::haversine($k['lat'], $k['lon'], $v['lat'], $v['lon']) < $avstand) {
                        $ok = false;
                        break;
                    }
                }
                if ($ok) {
                    $valde[] = $k;
                    if (count($valde) >= $n) {
                        return [self::reinsk($valde), $avstand];
                    }
                }
            }

            if (count($valde) > count($beste)) {
                $beste = $valde;
                $besteAvstand = $avstand;
            }

            // Slakk kravet — men aldri under golvet. Ein «utplassering» der
            // turbinane står to rotordiameter frå kvarandre ville ikkje vore
            // ei illustrasjon av noko som helst; då er det heller turbintalet
            // eller polygonet som er feil, og me viser dei me fekk plass til.
            $neste = $avstand * 0.85;
            if ($neste < $gulvAvstand) {
                return [self::reinsk($beste), $besteAvstand];
            }
            $avstand = $neste;
        }
    }

    /**
     * Meter per grad breidd og lengd på ein gitt breiddegrad (WGS84).
     *
     * Dei vanlege «111 320 m per grad»-tala er ekvatorverdiar. Ei meridiangrad
     * er 110,57 km ved ekvator og 111,69 km ved polen, og ei lengdegrad
     * krympar med cos(breidd) korrigert for ellipsoiden. På 71°N gir dei
     * konstante tala 0,3–0,4 % feil — nok til å merkast når resultatet vert
     * halde opp mot ein publisert minsteavstand.
     *
     * @return array{0:float,1:float}
     */
    private static function meterPerGrad(float $lat): array
    {
        $p = deg2rad($lat);
        // Standardrekker (WGS84), nøyaktige til under ein meter per grad.
        $mLat = 111132.92 - 559.82 * cos(2 * $p) + 1.175 * cos(4 * $p) - 0.0023 * cos(6 * $p);
        $mLon = 111412.84 * cos($p) - 93.5 * cos(3 * $p) + 0.118 * cos(5 * $p);
        return [$mLat, max(1.0, $mLon)];
    }

    /** Fjern dei interne meterkoordinatane før resultatet går ut av klassa. */
    private static function reinsk(array $valde): array
    {
        return array_map(static function ($v) {
            unset($v['_x'], $v['_y']);
            return $v;
        }, $valde);
    }
}
