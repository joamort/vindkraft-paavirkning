<?php
/**
 * backend/services/RateLimiter.php
 *
 * Enkel filbasert rate limiter per identitet (her: IP-adresse).
 *
 * Prosjektet har ingen database — heile appen er filbasert JSON-cache — så
 * DB-mønsteret frå PolitiKartet/RegSøk passar ikkje. Dette er same idé, berre
 * med ei JSON-fil per identitet og eit glidande tidsvindauge.
 *
 * FAIL-OPEN, medvite valt (jf. TECH_STACK.md om fail-open vs. fail-closed):
 * Klarer me ikkje skrive tellefila, slepp me førespurnaden gjennom. Endepunkta
 * dette vernar er reine leseproxyar mot ei offentleg Kartverket-teneste — det
 * verste som skjer ved for mange kall er at me lastar Kartverket unødig, ikkje
 * at nokon får tilgang til noko dei ikkje skal. Å blokkere ekte brukarar fordi
 * disken er full ville vore verre.
 */

class RateLimiter
{
    private string $dir;

    public function __construct(?string $dir = null)
    {
        $this->dir = $dir ?? dirname(__DIR__, 2) . '/cache/ratelimit';
    }

    /**
     * Registrer eit forsøk og seie om det er innanfor grensa.
     *
     * @param string $identity  T.d. 'ip:1.2.3.4'
     * @param int    $limit     Maks tal "kostnadseiningar" i vindauget
     * @param int    $windowSec Lengda på vindauget i sekund
     * @param int    $cost      Kva denne førespurnaden kostar (t.d. tal WPS-kall)
     * @return array{tillatt:bool, gjenstaaende:int, nullstilles_om:int}
     */
    public function check(string $identity, int $limit, int $windowSec, int $cost = 1): array
    {
        if (!is_dir($this->dir) && !@mkdir($this->dir, 0775, true) && !is_dir($this->dir)) {
            return ['tillatt' => true, 'gjenstaaende' => $limit, 'nullstilles_om' => 0];
        }

        $path = $this->dir . '/' . sha1($identity) . '.json';
        $now  = time();

        $handle = @fopen($path, 'c+');
        if ($handle === false) {
            return ['tillatt' => true, 'gjenstaaende' => $limit, 'nullstilles_om' => 0];
        }

        // Eksklusiv lås: to samtidige kall frå same IP skal ikkje kunne lese
        // same teljar og begge tru dei har plass.
        if (!flock($handle, LOCK_EX)) {
            fclose($handle);
            return ['tillatt' => true, 'gjenstaaende' => $limit, 'nullstilles_om' => 0];
        }

        $raw   = stream_get_contents($handle);
        $state = json_decode((string) $raw, true);
        if (!is_array($state) || !isset($state['start'], $state['count'])) {
            $state = ['start' => $now, 'count' => 0];
        }

        // Vindauget er utløpt → start på nytt.
        if ($now - (int) $state['start'] >= $windowSec) {
            $state = ['start' => $now, 'count' => 0];
        }

        $allowed = ((int) $state['count'] + $cost) <= $limit;
        if ($allowed) {
            $state['count'] = (int) $state['count'] + $cost;
        }

        ftruncate($handle, 0);
        rewind($handle);
        fwrite($handle, json_encode($state));
        fflush($handle);
        flock($handle, LOCK_UN);
        fclose($handle);

        // Rydd av og til, slik at mappa ikkje veks i det uendelege.
        if (random_int(1, 200) === 1) {
            $this->prune($windowSec);
        }

        return [
            'tillatt'        => $allowed,
            'gjenstaaende'   => max(0, $limit - (int) $state['count']),
            'nullstilles_om' => max(0, $windowSec - ($now - (int) $state['start'])),
        ];
    }

    /** Slett tellefiler som er eldre enn eit par vindauge. */
    private function prune(int $windowSec): void
    {
        $cutoff = time() - max(3600, $windowSec * 4);
        foreach (glob($this->dir . '/*.json') ?: [] as $file) {
            if (@filemtime($file) < $cutoff) {
                @unlink($file);
            }
        }
    }

    /**
     * Beste tilgjengelege klient-IP.
     *
     * NB: proxy-headere kan forfalskast. Dei brukast berre til å skilje
     * brukarar bak same delte utgangs-IP, aldri til tilgangskontroll.
     */
    public static function clientIp(): string
    {
        foreach (['HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR'] as $key) {
            if (!empty($_SERVER[$key])) {
                $ip = trim(explode(',', (string) $_SERVER[$key])[0]);
                if (filter_var($ip, FILTER_VALIDATE_IP)) {
                    return $ip;
                }
            }
        }
        return 'ukjent';
    }
}
