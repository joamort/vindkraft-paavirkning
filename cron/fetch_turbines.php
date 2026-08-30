<?php
/**
 * cron/fetch_turbines.php
 *
 * Cron-inngang som oppdaterer den filbaserte turbin-cachen frå NVE.
 * Turbindata endrar seg sjeldan — dagleg køyring er rikeleg.
 *
 * cPanel-cron (dagleg 04:15):
 *   15 4 * * * /usr/local/bin/php /home/BRUKAR/public_html/vind/cron/fetch_turbines.php
 *
 * Kan òg kallast over web for manuell trigging, men KREVER då CRON_SECRET frå
 * .env som `?key=` — elles kunne kven som helst tvinge fram tunge NVE-kall:
 *   https://littavalt.no/vind/cron/fetch_turbines.php?key=...
 */

require_once __DIR__ . '/../backend/services/NveVindkraftFetcher.php';
require_once __DIR__ . '/../backend/services/Logger.php';

$isCli = PHP_SAPI === 'cli';

if (!$isCli) {
    header('Content-Type: text/plain; charset=utf-8');

    $expected = trim((string) (parseEnvValue(__DIR__ . '/../.env', 'CRON_SECRET') ?? ''));
    $provided = (string) ($_GET['key'] ?? '');

    // Ingen nøkkel konfigurert = web-trigging heilt av. Betre å stengje enn å
    // stå open fordi nokon gløymde å fylle ut .env.
    if ($expected === '' || !hash_equals($expected, $provided)) {
        http_response_code(403);
        echo "Avvist.\n";
        exit;
    }

    // Hentinga tek typisk 10-30 s (11 ArcGIS-lag).
    set_time_limit(300);
}

$start   = microtime(true);
$fetcher = new NveVindkraftFetcher();
$result  = $fetcher->run();
$elapsed = round(microtime(true) - $start, 1);

foreach ($result['log'] as $line) {
    echo "  $line\n";
}

echo sprintf(
    "\n%s: %d turbinpunkt, %d anlegg, %d områdepolygon på %ss.\n",
    $result['ok'] ? 'OK' : 'FEILA',
    $result['turbiner'],
    $result['anlegg'],
    $result['omrader'],
    $elapsed
);

// Skriv alltid åtvaringar/feil frå fetcheren til den sentrale loggen òg — ein
// cron-jobb som feilar midt på natta vert elles berre synleg om nokon
// faktisk les cPanel sin cron-e-post.
$aatvaringar = array_values(array_filter(
    $result['log'],
    static fn($line) => str_starts_with($line, 'ÅTVARING') || str_starts_with($line, 'FEIL')
));
if ($aatvaringar !== []) {
    Logger::warn('fetch_turbines', implode(' | ', $aatvaringar), [
        'turbiner' => $result['turbiner'],
        'anlegg'   => $result['anlegg'],
    ]);
}
if (!$result['ok']) {
    Logger::error('fetch_turbines', 'Cron-henting frå NVE feila', [
        'turbiner' => $result['turbiner'],
        'anlegg'   => $result['anlegg'],
    ]);
    if ($isCli) {
        exit(1);
    }
    http_response_code(500);
}

/**
 * Minimal .env-lesar. Prosjektet har ingen andre .env-behov, så det er ikkje
 * verdt ei eiga Config-klasse eller ei Composer-avhengigheit for dette.
 */
function parseEnvValue(string $path, string $key): ?string
{
    if (!is_readable($path)) {
        return null;
    }
    foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#')) {
            continue;
        }
        [$k, $v] = array_pad(explode('=', $line, 2), 2, '');
        if (trim($k) === $key) {
            return trim($v, " \t\"'");
        }
    }
    return null;
}
