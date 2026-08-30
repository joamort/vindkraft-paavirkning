<?php
/**
 * backend/api/elevation_profile.php
 *
 * Proxy mot Kartverket sin WPS-høgdeprofilteneste.
 *
 * Tek imot eitt origo og ei liste med målpunkt, og returnerer ein terrengprofil
 * per mål. Sjølve batchinga og fil-cachinga skjer i ElevationService.
 *
 * SIKKERHET — dette er eit ope endepunkt utan innlogging, så det er stramma
 * inn på fleire nivå (same tankegang som `*_proxy.php`-mønsteret i
 * StrømbruddKart, men her er URL-en hardkoda i tenesta i staden for kvitlista,
 * som er endå strammare: klienten kan ikkje påverke kva host me kallar i det
 * heile — berre koordinatane):
 *
 *   1. Berre POST med JSON-body.
 *   2. Koordinatar må liggje innanfor eit Noreg-bbox.
 *   3. Maks tal målpunkt per kall, og maks avstand per mål.
 *   4. Rate limiting per IP, med kostnad etter kor mange WPS-kall jobben
 *      faktisk vil utløyse — ikkje flat per request.
 *
 * PERSONVERN (PLAN.md §8): brukarens punkt vert brukt til å slå opp terreng og
 * til cache-nøkkelen, men aldri logga knytt til IP eller lagra som "eit besøk".
 * Cache-filene er anonyme sha1-nøklar av koordinatar.
 */

require_once __DIR__ . '/../services/ElevationService.php';
require_once __DIR__ . '/../services/RateLimiter.php';
require_once __DIR__ . '/../services/Logger.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

/** Grovt bbox for Noreg inkl. havområde — held proxyen på norsk jord. */
const BBOX = ['lat_min' => 56.0, 'lat_max' => 72.0, 'lon_min' => 3.0, 'lon_max' => 33.0];

/** Maks tal profilar klienten kan be om i eitt kall. */
const MAX_TARGETS = 40;

/** Maks avstand origo→mål. Lenger enn dette er uansett ikkje visuelt relevant. */
const MAX_DISTANCE_M = 50000;

/** Rate limit: kostnadseiningar (≈ WPS-kall) per IP per vindauge. */
const RATE_LIMIT      = 400;
const RATE_WINDOW_SEC = 600;

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'Berre POST er støtta.');
}

$raw   = file_get_contents('php://input');
$input = json_decode((string) $raw, true);
if (!is_array($input)) {
    fail(400, 'Forventa ein JSON-body.');
}

// --- Origo ---------------------------------------------------------------
$oLat = filter_var($input['origin']['lat'] ?? null, FILTER_VALIDATE_FLOAT);
$oLon = filter_var($input['origin']['lon'] ?? null, FILTER_VALIDATE_FLOAT);
if ($oLat === false || $oLon === false || !inNorway($oLat, $oLon)) {
    fail(400, 'Ugyldig eller utanforliggjande origo-koordinat.');
}

// --- Målpunkt ------------------------------------------------------------
$rawTargets = $input['targets'] ?? null;
if (!is_array($rawTargets) || $rawTargets === []) {
    fail(400, 'Feltet "targets" må vera ei ikkje-tom liste.');
}
if (count($rawTargets) > MAX_TARGETS) {
    fail(400, 'For mange målpunkt i eitt kall (maks ' . MAX_TARGETS . ').');
}

$targets      = [];
$estimatedPts = 0;
foreach ($rawTargets as $t) {
    if (!is_array($t)) {
        continue;
    }
    $lat = filter_var($t['lat'] ?? null, FILTER_VALIDATE_FLOAT);
    $lon = filter_var($t['lon'] ?? null, FILTER_VALIDATE_FLOAT);
    $id  = (string) ($t['id'] ?? '');

    if ($lat === false || $lon === false || $id === '' || !inNorway($lat, $lon)) {
        continue;
    }
    // Id-en vert berre brukt som nøkkel i svaret, men me held han stram uansett.
    if (!preg_match('/^[A-Za-z0-9_-]{1,32}$/', $id)) {
        continue;
    }

    $dist = ElevationService::haversine($oLat, $oLon, $lat, $lon);
    if ($dist > MAX_DISTANCE_M) {
        continue;
    }

    $targets[] = ['id' => $id, 'lat' => $lat, 'lon' => $lon];
    $estimatedPts += ElevationService::sampleCount($dist);
}

if ($targets === []) {
    fail(400, 'Ingen gyldige målpunkt etter validering.');
}

// --- Rate limiting -------------------------------------------------------
// Kostnaden speglar kor mange WPS-kall jobben i verste fall utløyser (alt
// utan cache-treff), slik at ein klient ikkje kan omgå grensa ved å pakke
// maksimalt med tunge profilar inn i få førespurnader.
//
// TELJAREN MÅ VERA EIGEN PER ENDEPUNKT.
//
// Alle tre endepunkta brukte til no identiteten `ip:<ip>` — altså ÉIN felles
// teljar — medan kvart av dei målte han mot si eiga grense (400 her, 120 i
// `elevation_point.php`, 30 i `log_error.php`). Den effektive grensa vart
// dermed grensa til det endepunktet du tilfeldigvis kalla, brukt på summen av
// alle tre. Eit einaste panorama kostar ~50 einingar, så etter to panorama
// svarte punktoppslaget 429 sjølv om profil-budsjettet var nesten urørt, og
// klientfeilloggen (grense 30) var daud etter det fyrste. Verifisert i
// nettlesar: analysen stoppa på `elevation_point.php → 429` medan
// `elevation_profile.php` framleis svarte 200.
//
// Prefikset gir kvart endepunkt sin eigen fil, og grensene betyr det dei seier.
$cost    = max(1, (int) ceil($estimatedPts / 380));
$limiter = new RateLimiter();
$verdict = $limiter->check('profil:ip:' . RateLimiter::clientIp(), RATE_LIMIT, RATE_WINDOW_SEC, $cost);

if (!$verdict['tillatt']) {
    header('Retry-After: ' . $verdict['nullstilles_om']);
    fail(429, 'For mange førespurnader. Prøv igjen om ' . $verdict['nullstilles_om'] . ' sekund.');
}

// --- Køyr ----------------------------------------------------------------
// Eit fullt batch-kall mot WPS tek typisk 2-4 s; fleire batchar kan gi 30 s+.
set_time_limit(120);

try {
    $service = new ElevationService();
    $result  = $service->profiles(['lat' => $oLat, 'lon' => $oLon], $targets);
} catch (Throwable $e) {
    Logger::error('elevation_profile', $e->getMessage(), [
        'tal_mal' => count($targets),
        'klasse'  => get_class($e),
    ]);
    fail(502, 'Kunne ikkje hente høgdedata frå Kartverket.');
}

echo json_encode([
    'ok'       => true,
    'origin'   => $result['origin'],
    'profiles' => $result['profiles'],
    'stats'    => $result['stats'],
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
