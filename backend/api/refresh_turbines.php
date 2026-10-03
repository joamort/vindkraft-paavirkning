<?php
/**
 * backend/api/refresh_turbines.php
 *
 * Byggjer turbin-cachen på nytt frå NVE, trigga av «Oppdater no»-knappen i
 * den sjølvhosta appen. Tek typisk 20–40 s (11 ArcGIS-lag).
 *
 * Tilgang: berre i ei SJØLVHOSTA utgåve (FrankenPHP-serveren i pakkane og
 * Docker, `php -S` frå kjeldekoden, eller `VIND_SELVHOST=1`) — og berre når
 * `CRON_SECRET` er tom. På
 * ein vanleg web-host er endepunktet avslege uansett kva som står i `.env`;
 * der går oppdatering via `cron/fetch_turbines.php` (CLI, eller `?key=…`).
 * Elles kunne kven som helst tvinge fram tunge NVE-kall og overskrive
 * datafilene. Regelen bur i Env::canRefreshOverWeb() — sjå der for kvifor
 * «tom CRON_SECRET» åleine ikkje lenger er nok.
 *
 * POST utan innhald. Samtidige kall vert avviste med ein fillås.
 */

require_once __DIR__ . '/../services/Env.php';
require_once __DIR__ . '/../services/NveVindkraftFetcher.php';
require_once __DIR__ . '/../services/Logger.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'Bruk POST.']);
    exit;
}

// --- Tilgang ----------------------------------------------------------------
if (!Env::canRefreshOverWeb()) {
    http_response_code(403);
    echo json_encode([
        'ok'    => false,
        'error' => 'Avslege på denne installasjonen. Bruk cron/fetch_turbines.php.',
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

// --- Samtidslås -----------------------------------------------------------
$laasFil = dirname(__DIR__, 2) . '/cache/refresh.lock';
$laas    = fopen($laasFil, 'c');
if ($laas === false || !flock($laas, LOCK_EX | LOCK_NB)) {
    http_response_code(409);
    echo json_encode(['ok' => false, 'error' => 'Ei oppdatering køyrer alt. Prøv igjen om litt.'], JSON_UNESCAPED_UNICODE);
    exit;
}

set_time_limit(300);

try {
    $start   = microtime(true);
    $fetcher = new NveVindkraftFetcher();
    $result  = $fetcher->run();
    $elapsed = round(microtime(true) - $start, 1);

    $aatvaringar = array_values(array_filter(
        $result['log'] ?? [],
        static fn($l) => str_starts_with($l, 'ÅTVARING') || str_starts_with($l, 'FEIL')
    ));
    if ($aatvaringar !== []) {
        Logger::warn('refresh_turbines', implode(' | ', $aatvaringar));
    }

    if (!($result['ok'] ?? false)) {
        Logger::error('refresh_turbines', 'Manuell NVE-henting feila');
        http_response_code(502);
        echo json_encode(['ok' => false, 'error' => 'Klarte ikkje hente frå NVE. Sjå logs/error.log.'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    echo json_encode([
        'ok'       => true,
        'antall'   => $result['turbiner'] ?? null,
        'anlegg'   => $result['anlegg'] ?? null,
        'sekund'   => $elapsed,
    ], JSON_UNESCAPED_UNICODE);
} catch (\Throwable $e) {
    Logger::error('refresh_turbines', 'Unntak: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'Uventa feil under oppdateringa.'], JSON_UNESCAPED_UNICODE);
} finally {
    flock($laas, LOCK_UN);
    fclose($laas);
}
