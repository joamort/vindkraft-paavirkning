<?php
/**
 * backend/services/Logger.php
 *
 * Filbasert feillogg — same idé som RegSøk sin manuelle logg-rotering
 * (jf. TECH_STACK.md): sjekk filstorleik ved kvar skriving, `rename()` til
 * ein `.1`-fil når terskelen er nådd. Ingen `logrotate` tilgjengeleg på delt
 * hosting, så dette er den enkle erstatninga.
 *
 * Éin logg dekkjer to kjelder:
 *   - Serverside: PHP-endepunkta kallar Logger::error()/warn() i staden for å
 *     berre svelgje eit Throwable og returnere ei generisk feilmelding.
 *   - Klientside: js/utils/ErrorReporter.js fangar window.onerror/
 *     unhandledrejection og POSTar dei til backend/api/log_error.php, som
 *     igjen kallar denne klassa. Feltet `kilde` skil dei to i loggen.
 *
 * FAIL-SILENT er medvite: sjølve loggforsøket skal ALDRI kunne kaste eller
 * få eit endepunkt til å feile — logging er eit hjelpemiddel, ikkje ein
 * kritisk sti. Feilar skrivinga (t.d. disk full), forsvinn berre den eine
 * loggraden.
 *
 * PERSONVERN: loggar ALDRI koordinatane til brukarens eige punkt (jf.
 * PLAN.md §8 — punktet skal ikkje kunne knytast til ein IP/eit besøk noko
 * stad). IP-adressa hashast (same teknikk som RateLimiter sin identitet),
 * rå IP lagrast aldri.
 */

class Logger
{
    /** Rotér når loggen passerer denne storleiken. */
    private const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

    /** Behald berre éin roterte generasjon — dette er eit feilsøkingsverktøy,
     *  ikkje eit revisjonsspor. */
    private const KEEP_ROTATED = 1;

    private static function path(): string
    {
        return dirname(__DIR__, 2) . '/logs/error.log';
    }

    public static function error(string $context, string $message, array $extra = []): void
    {
        self::write('error', $context, $message, $extra);
    }

    public static function warn(string $context, string $message, array $extra = []): void
    {
        self::write('warn', $context, $message, $extra);
    }

    /**
     * @param string $kilde 'server' eller 'klient'
     */
    private static function write(string $level, string $context, string $message, array $extra): void
    {
        try {
            $dir = dirname(self::path());
            if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
                return;
            }

            self::rotateIfNeeded();

            $row = array_merge([
                'tid'     => date('c'),
                'niva'    => $level,
                'kontekst' => $context,
                'melding' => substr($message, 0, 2000),
            ], self::sanitize($extra));

            // JSON_INVALID_UTF8_SUBSTITUTE: substr() over kappar av og til midt i eit
            // multi-byte UTF-8-teikn (mbstring finst ikkje i dette PHP-bygget, sjå
            // KnownSpecRegistry.php for same avgrensing) — utan dette ville heile
            // rada forsvinne stille i staden for berre det eine teiknet.
            $line = json_encode($row, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE) . "\n";

            $handle = @fopen(self::path(), 'a');
            if ($handle === false) {
                return;
            }
            if (flock($handle, LOCK_EX)) {
                fwrite($handle, $line);
                flock($handle, LOCK_UN);
            }
            fclose($handle);
        } catch (Throwable) {
            // Logging skal aldri kunne velte kallaren.
        }
    }

    /** Trimmer/avgrensar frie felt slik at éin skadeleg klientrapport ikkje kan blåse opp loggen. */
    private static function sanitize(array $extra): array
    {
        $out = [];
        foreach ($extra as $k => $v) {
            $key = substr((string) $k, 0, 40);
            if (is_array($v)) {
                $v = json_encode($v, JSON_UNESCAPED_UNICODE);
            }
            $out[$key] = substr((string) $v, 0, 1000);
        }
        return $out;
    }

    private static function rotateIfNeeded(): void
    {
        $path = self::path();
        if (!is_file($path) || filesize($path) < self::MAX_BYTES) {
            return;
        }
        $rotated = $path . '.1';
        @unlink($rotated); // KEEP_ROTATED = 1 → berre éin generasjon
        @rename($path, $rotated);
    }
}
