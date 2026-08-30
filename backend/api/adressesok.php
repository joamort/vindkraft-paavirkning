<?php
/**
 * backend/api/adressesok.php
 *
 * Proxy mot Kartverket sitt opne adresse-API (`ws.geonorge.no/adresser/v1`),
 * so nettlesaren slepp å snakke direkte med ei ekstern teneste — CSP-en held
 * `connect-src 'self'`. Same prinsipp som terrengoppslaga.
 *
 * Søkjestrengen blir send vidare til Kartverket for geokoding (akkurat som
 * koordinatane alt blir sende dit for høgdedata). Han blir ikkje lagra eller
 * logga her.
 *
 * NB: berre `strlen`/`substr`, ikkje `mb_*` — sjå CLAUDE.md «Fallgruver».
 */

require_once __DIR__ . '/../services/Http.php';
require_once __DIR__ . '/../services/RateLimiter.php';
require_once __DIR__ . '/../services/Logger.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

const AS_RATE_LIMIT      = 120;
const AS_RATE_WINDOW_SEC = 600;
const AS_TREFF           = 8;

$q = trim((string) ($_GET['q'] ?? ''));
if (strlen($q) < 3) {
    echo json_encode(['ok' => true, 'treff' => []], JSON_UNESCAPED_UNICODE);
    exit;
}
if (strlen($q) > 150) {
    $q = substr($q, 0, 150);
}

$limiter = new RateLimiter();
$verdict = $limiter->check('adr:ip:' . RateLimiter::clientIp(), AS_RATE_LIMIT, AS_RATE_WINDOW_SEC);
if (!$verdict['tillatt']) {
    http_response_code(429);
    header('Retry-After: ' . $verdict['nullstilles_om']);
    echo json_encode(['ok' => false, 'error' => 'For mange søk. Vent litt.'], JSON_UNESCAPED_UNICODE);
    exit;
}

$url = 'https://ws.geonorge.no/adresser/v1/sok?' . http_build_query([
    'sok'             => $q,
    'fuzzy'           => 'true',
    'treffPerSide'    => AS_TREFF,
    'side'            => 0,
    'asciiKompatibel' => 'true',
    'filtrer'         => 'adresser.adressetekst,adresser.kommunenavn,adresser.poststed,adresser.representasjonspunkt',
]);

$res = Http::get($url, ['Accept: application/json'], 8);
if (!($res['ok'] ?? false) || !is_string($res['body'] ?? null)) {
    Logger::warn('adressesok', 'Kartverket svara ikkje', ['status' => $res['status'] ?? 0]);
    http_response_code(502);
    echo json_encode(['ok' => false, 'error' => 'Adressesøket er ikkje tilgjengeleg no.'], JSON_UNESCAPED_UNICODE);
    exit;
}

$data  = json_decode($res['body'], true);
$treff = [];
foreach (($data['adresser'] ?? []) as $a) {
    $pt = $a['representasjonspunkt'] ?? null;
    if (!isset($pt['lat'], $pt['lon'])) {
        continue;
    }
    $stad = (string) ($a['poststed'] ?? $a['kommunenavn'] ?? '');
    $treff[] = [
        'tekst' => (string) ($a['adressetekst'] ?? ''),
        'stad'  => $stad,
        'lat'   => (float) $pt['lat'],
        'lon'   => (float) $pt['lon'],
    ];
}

echo json_encode(
    ['ok' => true, 'treff' => $treff],
    JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE
);
