<?php
/**
 * backend/api/turbines.php
 *
 * Serverer den cacha turbinlista, valfritt filtrert på radius rundt eit punkt
 * eller på bbox.
 *
 * MERK: for sjølve kartet lastar frontend `cache/turbines.json` DIREKTE frå
 * Apache — ingen PHP i løkka (jf. TECH_STACK.md "statiske filer der mogleg").
 * Dette endepunktet finst for kall der ein liten, filtrert payload er poenget
 * (t.d. ein delbar lenke som berre treng turbinane nær eitt punkt), og som eit
 * stabilt API for eventuelle andre konsumentar.
 */

require_once __DIR__ . '/../services/ElevationService.php';
require_once __DIR__ . '/../services/Logger.php';

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
// Turbindata endrar seg dagleg i beste fall — la nettlesaren halde på det ei stund.
header('Cache-Control: public, max-age=3600');

$cacheFile = dirname(__DIR__, 2) . '/cache/turbines.json';

if (!is_readable($cacheFile)) {
    Logger::error('turbines', 'Turbin-cachen manglar', ['fil' => $cacheFile]);
    http_response_code(503);
    echo json_encode([
        'ok'    => false,
        'error' => 'Turbin-cachen er ikkje bygd enno. Køyr cron/fetch_turbines.php.',
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

$data = json_decode((string) file_get_contents($cacheFile), true);
if (!is_array($data) || !isset($data['turbiner'])) {
    Logger::error('turbines', 'Turbin-cachen er korrupt', ['json_feil' => json_last_error_msg()]);
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'Cachen er korrupt.'], JSON_UNESCAPED_UNICODE);
    exit;
}

$turbines = $data['turbiner'];

// --- Valfritt radiusfilter ----------------------------------------------
$lat    = filter_var($_GET['lat'] ?? null, FILTER_VALIDATE_FLOAT);
$lon    = filter_var($_GET['lon'] ?? null, FILTER_VALIDATE_FLOAT);
$radius = filter_var($_GET['radius'] ?? null, FILTER_VALIDATE_FLOAT);

if ($lat !== false && $lon !== false && $radius !== false && $radius > 0) {
    $radius   = min($radius, 100000); // hard øvre grense
    $filtered = [];
    foreach ($turbines as $t) {
        $d = ElevationService::haversine($lat, $lon, (float) $t['lat'], (float) $t['lon']);
        if ($d <= $radius) {
            $t['avstand_m'] = round($d);
            $filtered[] = $t;
        }
    }
    usort($filtered, static fn($a, $b) => $a['avstand_m'] <=> $b['avstand_m']);
    $turbines = $filtered;
}

// --- Valfritt statusfilter ----------------------------------------------
$status = $_GET['status'] ?? null;
if (is_string($status) && $status !== '') {
    $wanted   = array_filter(array_map('trim', explode(',', $status)));
    $turbines = array_values(array_filter(
        $turbines,
        static fn($t) => in_array($t['status'] ?? '', $wanted, true)
    ));
}

echo json_encode([
    'ok'        => true,
    'generert'  => $data['generert'] ?? null,
    'atterhald' => $data['atterhald'] ?? null,
    'antall'    => count($turbines),
    'turbiner'  => array_values($turbines),
], JSON_UNESCAPED_UNICODE);
