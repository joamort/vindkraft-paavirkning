<?php
/**
 * backend/api/log_error.php
 *
 * Tek imot feilrapportar frå js/utils/ErrorReporter.js (window.onerror,
 * unhandledrejection, og eksplisitte "stille" feil appen fangar sjølv) og
 * skriv dei til den same fillogga som serverfeil, via Logger.
 *
 * Same sikringsprinsipp som elevation_profile.php: ope endepunkt utan
 * innlogging, så stramma inn på fleire nivå — POST-only, hardt tak på
 * feltlengder (Logger trimmar uansett, men avvis grovt feil input tidleg),
 * og rate-limiting per IP (eit skript i ein evig onerror-løkke skal ikkje
 * kunne fylle disken).
 *
 * Svarer alltid 204 uansett utfall — ein feilrapportar skal aldri sjølv
 * skape ein synleg feil for brukaren, og klienten treng ikkje svaret.
 */

require_once __DIR__ . '/../services/Logger.php';
require_once __DIR__ . '/../services/RateLimiter.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

const RATE_LIMIT      = 30;   // rapportar
const RATE_WINDOW_SEC = 300;  // per 5 minutt per IP

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    exit;
}

$limiter = new RateLimiter();
// EIGEN TELJAR PER ENDEPUNKT — sjå kommentaren i elevation_profile.php.
// Med felles teljar var denne (grense 30) daud etter det fyrste panoramaet.
$verdict = $limiter->check('logg:ip:' . RateLimiter::clientIp(), RATE_LIMIT, RATE_WINDOW_SEC);
if (!$verdict['tillatt']) {
    // Ikkje 429 med feilmelding — ein klient som allereie spammar feil skal
    // ikkje få enda ein grunn til å logge noko. Berre svar tomt og stopp.
    http_response_code(204);
    exit;
}

$input = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($input)) {
    http_response_code(204);
    exit;
}

Logger::error('klient', (string) ($input['melding'] ?? 'Ukjend klientfeil'), [
    'kilde'    => 'klient',
    'type'     => $input['type'] ?? '?',
    'url'      => $input['url'] ?? '?',
    'linje'    => $input['linje'] ?? '?',
    'stack'    => $input['stack'] ?? '',
    'brukaragent' => $_SERVER['HTTP_USER_AGENT'] ?? '?',
]);

http_response_code(204);
