<?php
/**
 * backend/api/elevation_point.php
 *
 * Terrenghøgde i eitt enkelt punkt (Kartverket `hoydedata/v1/punkt`).
 * Brukast til bakkehøgda under brukarens eige punkt — grunnlaget for augehøgda
 * i siktlinjeberekninga.
 *
 * Same valideringsprinsipp som elevation_profile.php: klienten kan berre
 * påverke koordinatane, aldri kva teneste me kallar.
 */

require_once __DIR__ . '/../services/ElevationService.php';
require_once __DIR__ . '/../services/RateLimiter.php';
require_once __DIR__ . '/../services/Logger.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

const BBOX = ['lat_min' => 56.0, 'lat_max' => 72.0, 'lon_min' => 3.0, 'lon_max' => 33.0];

const RATE_LIMIT      = 120;
const RATE_WINDOW_SEC = 600;

$lat = filter_var($_GET['lat'] ?? null, FILTER_VALIDATE_FLOAT);
$lon = filter_var($_GET['lon'] ?? null, FILTER_VALIDATE_FLOAT);

if ($lat === false || $lon === false
    || $lat < BBOX['lat_min'] || $lat > BBOX['lat_max']
    || $lon < BBOX['lon_min'] || $lon > BBOX['lon_max']) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Ugyldig koordinat.'], JSON_UNESCAPED_UNICODE);
    exit;
}

$limiter = new RateLimiter();
// EIGEN TELJAR PER ENDEPUNKT — sjå kommentaren i elevation_profile.php.
$verdict = $limiter->check('punkt:ip:' . RateLimiter::clientIp(), RATE_LIMIT, RATE_WINDOW_SEC);
if (!$verdict['tillatt']) {
    http_response_code(429);
    header('Retry-After: ' . $verdict['nullstilles_om']);
    echo json_encode(['ok' => false, 'error' => 'For mange førespurnader.'], JSON_UNESCAPED_UNICODE);
    exit;
}

/**
 * VALFRI DATAKJELDE — mot kvitliste, aldri fritt vidare til Kartverket.
 *
 * Utan parameteren svarer endepunktet nøyaktig som før: «beste tilgjengelege
 * høgd», som i praksis er dtm1 (bar bakke), og med `terreng`/`datakilde`-felta
 * frå tenesta. Med `?datakilde=dom1` svarer det frå overflatemodellen, som har
 * skog og bygningar med — då finst ikkje dei to felta i kjelda, og `hoyde_m`
 * kan vera `null` utanfor laserdekninga.
 *
 * Det er BATCH-endepunktet (surface_points.php) som gjer den verkelege jobben
 * i appen; denne vegen finst for eitt enkelt oppslag og for smoke-testing.
 */
$datakilde = trim((string) ($_GET['datakilde'] ?? ''));
if ($datakilde !== '' && !in_array($datakilde, ElevationService::KJELDER, true)) {
    http_response_code(400);
    echo json_encode([
        'ok'    => false,
        'error' => 'Ukjend datakilde. Lovlege: ' . implode(', ', ElevationService::KJELDER) . '.',
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

try {
    $service = new ElevationService();
    if ($datakilde !== '') {
        $svar = $service->sourcePoints([[$lat, $lon]], $datakilde);
        $z    = $svar['hoyder'][0] ?? null;
        // Eit `null` her tyder «ikkje målt», og skal ut som eit svar — ikkje
        // som ein 502. Difor eit eige tidleg utskriv i staden for $point.
        echo json_encode([
            'ok'        => true,
            'lat'       => $lat,
            'lon'       => $lon,
            'hoyde_m'   => $z,
            'terreng'   => null,
            'datakilde' => $datakilde,
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }
    $point = $service->point($lat, $lon);
} catch (Throwable $e) {
    Logger::error('elevation_point', $e->getMessage(), ['klasse' => get_class($e)]);
    $point = null;
}

if ($point === null) {
    Logger::warn('elevation_point', 'Kartverket returnerte ikkje punktdata.');
    http_response_code(502);
    echo json_encode(['ok' => false, 'error' => 'Fekk ikkje høgdedata frå Kartverket.'], JSON_UNESCAPED_UNICODE);
    exit;
}

echo json_encode([
    'ok'        => true,
    'lat'       => $lat,
    'lon'       => $lon,
    'hoyde_m'   => $point['z'],
    'terreng'   => $point['terreng'],
    'datakilde' => $point['datakilde'],
], JSON_UNESCAPED_UNICODE);
