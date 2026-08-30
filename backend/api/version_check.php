<?php
/**
 * backend/api/version_check.php
 *
 * Diskré «finst det ei nyare utgåve?»-sjekk for den sjølvhosta appen.
 *
 * - Køyrer BERRE når `version.json` finst i approt (det gjer han berre i
 *   nedlastbare utgåver — ikkje i kjeldekode-oppsett). Manglar fila, er
 *   svaret alltid «ingen nyare versjon», og GitHub vert aldri kontakta.
 * - Nettlesaren snakkar aldri direkte med GitHub: dette endepunktet gjer
 *   kallet server-side, så CSP-en held `connect-src 'self'`.
 * - Resultatet vert cacha i 24 timar (`cache/version_check.json`), so ei
 *   økt = maks eitt GitHub-kall per døgn.
 * - Feilar alt (offline, GitHub nede, rate limit): svar stille at det ikkje
 *   finst noko nytt. Dette skal aldri gi ein feil til brukaren.
 *
 * Slå av heilt: slett `version.json`.
 */

require_once __DIR__ . '/../services/Http.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

const VC_RELEASES_URL = 'https://api.github.com/repos/joamort/vindkraft-paavirkning/releases/latest';
const VC_CACHE_TTL    = 86400;      // 24 t
const VC_TIMEOUT      = 8;          // sekund på GitHub-kallet

$appDir    = dirname(__DIR__, 2);
$naavaerande = null;

try {
    $verFil = $appDir . '/version.json';
    if (is_readable($verFil)) {
        $v = json_decode((string) file_get_contents($verFil), true);
        $naavaerande = is_array($v) ? ($v['versjon'] ?? null) : null;
    }

    // Ingen version.json → kjeldekode-oppsett. Ikkje kontakt GitHub.
    if (!is_string($naavaerande) || $naavaerande === '') {
        echo json_encode(['ok' => true, 'naavaerande' => null, 'nyare' => false], JSON_UNESCAPED_SLASHES);
        exit;
    }

    $cacheFil = $appDir . '/cache/version_check.json';
    $cache    = is_readable($cacheFil)
        ? json_decode((string) file_get_contents($cacheFil), true)
        : null;

    $ferskNok = is_array($cache)
        && isset($cache['sjekka'])
        && (time() - (int) $cache['sjekka']) < VC_CACHE_TTL;

    if (!$ferskNok) {
        $res = Http::get(VC_RELEASES_URL, [
            'Accept: application/vnd.github+json',
            // GitHub avviser kall utan User-Agent.
            'User-Agent: vindkraft-paavirkning-versjonssjekk',
        ], VC_TIMEOUT);

        if (($res['ok'] ?? false) && is_string($res['body'] ?? null)) {
            $rel  = json_decode($res['body'], true);
            $tag  = is_array($rel) ? ($rel['tag_name'] ?? null) : null;
            $url  = is_array($rel) ? ($rel['html_url'] ?? null) : null;
            if (is_string($tag) && $tag !== '') {
                $cache = ['sjekka' => time(), 'siste' => $tag, 'url' => $url];
                @file_put_contents(
                    $cacheFil,
                    json_encode($cache, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES),
                    LOCK_EX
                );
            }
        }

        // Kallet feila og me har ingen tidlegare verdi: cache eit tomt svar,
        // så me ikkje spør på nytt ved kvar sideinnlasting.
        if (!is_array($cache) || !isset($cache['siste'])) {
            $cache = ['sjekka' => time(), 'siste' => null, 'url' => null];
            @file_put_contents($cacheFil, json_encode($cache, JSON_UNESCAPED_SLASHES), LOCK_EX);
        }
    }

    $siste = is_array($cache) ? ($cache['siste'] ?? null) : null;

    echo json_encode([
        'ok'          => true,
        'naavaerande' => $naavaerande,
        'siste'       => $siste,
        'nyare'       => is_string($siste) && vc_nyare($siste, $naavaerande),
        'url'         => is_array($cache) ? ($cache['url'] ?? null) : null,
        'sjekka'      => is_array($cache) ? ($cache['sjekka'] ?? null) : null,
    ], JSON_UNESCAPED_SLASHES);
} catch (\Throwable $e) {
    // Fail-silent — dette er ein bekvemssjekk, ikkje kjernefunksjonalitet.
    echo json_encode(['ok' => true, 'naavaerande' => $naavaerande, 'nyare' => false], JSON_UNESCAPED_SLASHES);
}

/**
 * Er `$a` ein nyare versjon enn `$b`? Samanliknar `vX.Y.Z` numerisk, felt for
 * felt. Ukjent format → false (heller ikkje vise varsel enn å vise feil).
 */
function vc_nyare(string $a, string $b): bool
{
    $pa = vc_parse($a);
    $pb = vc_parse($b);
    if ($pa === null || $pb === null) {
        return false;
    }
    for ($i = 0; $i < 3; $i++) {
        if ($pa[$i] !== $pb[$i]) {
            return $pa[$i] > $pb[$i];
        }
    }
    return false;
}

/** @return array{0:int,1:int,2:int}|null */
function vc_parse(string $v): ?array
{
    if (!preg_match('/v?(\d+)\.(\d+)\.(\d+)/', $v, $m)) {
        return null;
    }
    return [(int) $m[1], (int) $m[2], (int) $m[3]];
}
