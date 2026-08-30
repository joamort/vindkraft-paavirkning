<?php
/**
 * backend/api/surface_points.php
 *
 * Høgd i vilkårlege punkt frå ei NAMNGJEVEN Kartverket-datakjelde — i praksis
 * `dom1`, den digitale OVERFLATEmodellen (skog og bygningar med), til skilnad
 * frå `dtm1` (bar bakke) som all annan høgdedata i appen kviler på.
 *
 * Brukast av DOM-kryssjekken (CLAUDE.md §22): for kvar analyserte turbin vert
 * det EINE terrengpunktet som avgjer siktlinja slått opp i overflatemodellen,
 * og siktlinja rekna om med den heva høgda. Klienten sender difor typisk 20-50
 * punkt i eitt kall, ikkje eitt.
 *
 * SIKKERHET — same lagdeling som elevation_profile.php:
 *
 *   1. Berre POST med JSON-body.
 *   2. `datakilde` mot KVITLISTE (ElevationService::KJELDER). Verdien går inn
 *      i ein URL-sti mot Kartverket; ein vilkårleg streng derifrå ville gjort
 *      endepunktet til ein open proxy inn i eit anna API.
 *   3. Koordinatar må liggje innanfor Noreg-bboxen.
 *   4. Maks tal punkt per kall, og rate limiting per IP med EIGEN teljar
 *      (sjå kommentaren i elevation_profile.php om kvifor prefikset må vere
 *      unikt per endepunkt).
 *
 * PERSONVERN (PLAN.md §8): punkta her er terrengpunkt mellom brukaren og ein
 * turbin. Dei vert brukte til oppslag og cache-nøkkel, aldri logga knytt til
 * IP eller lagra som eit besøk.
 */

require_once __DIR__ . '/../services/ElevationService.php';
require_once __DIR__ . '/../services/RateLimiter.php';
require_once __DIR__ . '/../services/Logger.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

/** Grovt bbox for Noreg inkl. havområde. */
const BBOX = ['lat_min' => 56.0, 'lat_max' => 72.0, 'lon_min' => 3.0, 'lon_max' => 33.0];

/**
 * Maks punkt per kall.
 *
 * Kartverket tek 50 per oppstraums-kall, og klienten deler sjølv på 50.
 * Taket her er sett til to slike kall, slik at ein litt ujamn klientbatch
 * ikkje vert avvist — men ingen kan be om 150 punkt og få eit svar som tek
 * eit halvt minutt.
 */
const MAX_POINTS = 100;

/** Rate limit: eitt punkt-kall (≈50 punkt) kostar éi eining. */
const RATE_LIMIT      = 120;
const RATE_WINDOW_SEC = 600;

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'Berre POST er støtta.');
}

$raw   = file_get_contents('php://input');
$input = json_decode((string) $raw, true);
if (!is_array($input)) {
    fail(400, 'Forventa ein JSON-body.');
}

// --- Datakjelde (kvitliste) ----------------------------------------------
$datakilde = (string) ($input['datakilde'] ?? 'dom1');
if (!in_array($datakilde, ElevationService::KJELDER, true)) {
    fail(400, 'Ukjend datakilde. Lovlege: ' . implode(', ', ElevationService::KJELDER) . '.');
}

// --- Punkt ----------------------------------------------------------------
$rawPoints = $input['punkter'] ?? null;
if (!is_array($rawPoints) || $rawPoints === []) {
    fail(400, 'Feltet "punkter" må vera ei ikkje-tom liste.');
}
if (count($rawPoints) > MAX_POINTS) {
    fail(400, 'For mange punkt i eitt kall (maks ' . MAX_POINTS . ').');
}

/**
 * Ugyldige punkt vert IKKJE stille hoppa over her, slik dei vert i
 * elevation_profile.php. Der er svaret nøkla på ein id, så eit mål som fell
 * bort berre manglar i kartet. Her er svaret ei LISTE i same rekkjefølgje som
 * inndata, og klienten parar han med turbinane sine på indeks — eit hopp ville
 * forskjøve heile resten og gitt kvar turbin ein DOM-verdi frå naboen.
 */
$points = [];
foreach ($rawPoints as $p) {
    if (!is_array($p) || count($p) < 2) {
        fail(400, 'Kvart punkt må vera [lat, lon].');
    }
    $lat = filter_var($p[0] ?? null, FILTER_VALIDATE_FLOAT);
    $lon = filter_var($p[1] ?? null, FILTER_VALIDATE_FLOAT);
    if ($lat === false || $lon === false || !inNorway($lat, $lon)) {
        fail(400, 'Ugyldig eller utanforliggjande koordinat.');
    }
    $points[] = [$lat, $lon];
}

// --- Rate limiting --------------------------------------------------------
$cost    = max(1, (int) ceil(count($points) / 50));
$limiter = new RateLimiter();
$verdict = $limiter->check('overflate:ip:' . RateLimiter::clientIp(), RATE_LIMIT, RATE_WINDOW_SEC, $cost);

if (!$verdict['tillatt']) {
    header('Retry-After: ' . $verdict['nullstilles_om']);
    fail(429, 'For mange førespurnader. Prøv igjen om ' . $verdict['nullstilles_om'] . ' sekund.');
}

// --- Køyr -----------------------------------------------------------------
set_time_limit(60);

try {
    $service = new ElevationService();
    $result  = $service->sourcePoints($points, $datakilde);
} catch (Throwable $e) {
    Logger::error('surface_points', $e->getMessage(), [
        'datakilde' => $datakilde,
        'tal_punkt' => count($points),
        'klasse'    => get_class($e),
    ]);
    fail(502, 'Kunne ikkje hente overflatedata frå Kartverket.');
}

echo json_encode([
    'ok'        => true,
    'datakilde' => $datakilde,
    // Same rekkjefølgje som inndata. `null` = ikkje målt (utanfor laserdekning
    // eller eit kall som feila), ALDRI 0 — sjå ElevationService::sourcePoints().
    'hoyder'    => array_values($result['hoyder']),
    'stats'     => $result['stats'],
], JSON_UNESCAPED_UNICODE);

// -------------------------------------------------------------------------

function inNorway(float $lat, float $lon): bool
{
    return $lat >= BBOX['lat_min'] && $lat <= BBOX['lat_max']
        && $lon >= BBOX['lon_min'] && $lon <= BBOX['lon_max'];
}

function fail(int $status, string $message): never
{
    http_response_code($status);
    echo json_encode(['ok' => false, 'error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}
