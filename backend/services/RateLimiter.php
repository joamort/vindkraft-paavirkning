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

require_once __DIR__ . '/Env.php';

class RateLimiter
{
    /**
     * Kor mange gonger den vanlege grensa éi TILKOPLINGSADRESSE får bruke i
     * alt, når klientidentiteten kviler på ein header me ikkje kan stadfeste.
     * Sjå client() for kvifor dette taket finst.
     *
     * 20 er romsleg med vilje: taket skal aldri råke vanleg bruk — heller
     * ikkje om adressa syner seg å vere ein delt proxy med mange ekte
     * brukarar bak — men det gjer «uavgrensa» om til «avgrensa».
     */
    private const UNVERIFIED_CONNECTION_FACTOR = 20;

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
     * Rate-limit klienten bak denne førespurnaden, for eitt endepunkt.
     *
     * Kvart endepunkt har sin eigen teljar (`$endpoint` er prefikset — sjå
     * kommentaren i elevation_profile.php for kva som skjedde då dei delte
     * éin). Identiteten kjem frå client().
     *
     * @param string $endpoint Kort namn, t.d. 'profil'
     * @return array{tillatt:bool, gjenstaaende:int, nullstilles_om:int}
     */
    public function checkClient(string $endpoint, int $limit, int $windowSec, int $cost = 1): array
    {
        $client  = self::client();
        $verdict = $this->check($endpoint . ':ip:' . $client['id'], $limit, $windowSec, $cost);

        if ($verdict['tillatt'] && !$client['verified']) {
            $cap = $this->check(
                $endpoint . ':tilkopling:' . $client['connection'],
                $limit * self::UNVERIFIED_CONNECTION_FACTOR,
                $windowSec,
                $cost
            );
            if (!$cap['tillatt']) {
                return $cap;
            }
        }

        return $verdict;
    }

    /**
     * Kven er klienten?
     *
     * =======================================================================
     * `X-Forwarded-For` ER NOKO KLIENTEN KAN SKRIVE SJØLV
     * =======================================================================
     * Den gamle utgåva tok det FYRSTE leddet i `X-Forwarded-For` som klient-IP,
     * uansett kven som sende førespurnaden. Verifisert lokalt: fem kall frå
     * same maskin med fem ulike headerverdiar gav fem ferske teljarar. Kvar
     * einaste grense i appen kunne altså omgåast med éin header — og det er
     * Kartverket si teneste grensene vernar.
     *
     * Headeren er berre til å stole på når han kjem frå ein proxy me kjenner,
     * og då berre det proxyen sjølv la til — det er leddet lengst til HØGRE.
     * Det gir tre tilfelle:
     *
     *  1. Ingen header (eller han seier det same som tilkoplinga):
     *     klienten er `REMOTE_ADDR`.
     *
     *  2. `REMOTE_ADDR` er ein proxy me stolar på — loopback, privat nett,
     *     eller ei adresse i `TRUSTED_PROXIES` i `.env`: klienten er det
     *     høgre-mest leddet som IKKJE sjølv er ein slik proxy. Det kan
     *     klienten ikkje forfalske; alt han skriv hamnar til venstre.
     *
     *  3. `REMOTE_ADDR` er ei offentleg adresse me ikkje kjenner, og headeren
     *     seier noko anna. Det kan vere ein klient som lyg — eller ein proxy
     *     med offentleg adresse som fortel sanninga. Utanfrå er dei to like.
     *
     * =======================================================================
     * TILFELLE 3 KAN IKKJE AVGJERAST, SÅ BEGGE SVARA MÅ VERE TRYGGE
     * =======================================================================
     * Å stole på headeren gir omgåinga tilbake. Å sjå bort frå han gir ALLE
     * brukarane bak ein slik proxy éin felles teljar, og då stengjer den
     * fyrste analysen ute dei neste. Identiteten vert difor PARET
     * `tilkopling>påstått klient`, og checkClient() legg i tillegg eit romsleg
     * tak på tilkoplinga åleine:
     *
     *  - Lyg klienten, får han ein ny teljar for kvar ny løgn — men alle
     *    saman tel mot taket på hans eiga adresse. Uavgrensa vert avgrensa.
     *  - Er det ein ærleg proxy, er paret unikt per ekte brukar, og taket er
     *    høgt nok til at vanleg trafikk aldri når det.
     *
     * Veit du at tilkoplinga ER ein proxy, legg adressa i `TRUSTED_PROXIES` —
     * då vert tilfelle 3 til tilfelle 2, og svaret er eksakt.
     *
     * @return array{id:string, connection:string, verified:bool}
     */
    public static function client(): array
    {
        $remote  = self::validIp($_SERVER['REMOTE_ADDR'] ?? null);
        $claimed = self::forwardedClient();

        if ($remote === null) {
            return ['id' => $claimed ?? 'ukjent', 'connection' => 'ukjent', 'verified' => true];
        }
        if ($claimed === null || $claimed === $remote) {
            return ['id' => $remote, 'connection' => $remote, 'verified' => true];
        }
        if (self::isTrustedProxy($remote)) {
            return ['id' => $claimed, 'connection' => $remote, 'verified' => true];
        }
        return ['id' => $remote . '>' . $claimed, 'connection' => $remote, 'verified' => false];
    }

    /**
     * Klienten slik `X-Forwarded-For` oppgir han, eller null om headeren
     * ikkje seier noko.
     *
     * Les frå høgre og hoppar over ledd som sjølve er proxyar me stolar på
     * (`klient, 127.0.0.1` → `klient`). Er ALLE ledda det, gjeld det som står
     * lengst unna — ein klient på same lokalnett.
     *
     * `CF-Connecting-IP` vert med vilje IKKJE lesen lenger. Det er ein
     * einskild verdi utan kjede, så det finst ingen «høgre ende» å stole på:
     * bak ein proxy som ikkje er Cloudflare slepp han rett gjennom frå
     * klienten. Står appen bak Cloudflare, før opp adressene deira i
     * `TRUSTED_PROXIES` — då gir `X-Forwarded-For` det same svaret, trygt.
     */
    private static function forwardedClient(): ?string
    {
        $header = (string) ($_SERVER['HTTP_X_FORWARDED_FOR'] ?? '');
        if ($header === '') {
            return null;
        }

        // Berre dei siste ledda: resten er uansett klientstyrt, og ein
        // header med tusenvis av ledd skal ikkje koste noko.
        $entries  = array_reverse(array_slice(explode(',', $header), -10));
        $farthest = null;
        foreach ($entries as $entry) {
            $ip = self::validIp($entry);
            if ($ip === null) {
                continue;
            }
            $farthest = $ip;
            if (!self::isTrustedProxy($ip)) {
                return $ip;
            }
        }
        return $farthest;
    }

    /**
     * Er adressa ein proxy me stolar på?
     *
     * Loopback og private nett er det alltid: ei slik adresse kan aldri vere
     * ein framand klient ute på internett, berre noko som står framfor oss på
     * same maskin eller same nett (Varnish, ein container-bru, ein lokal
     * revers-proxy). Offentlege adresser må førast opp i `TRUSTED_PROXIES`
     * (kommaseparert, enkeltadresser eller CIDR).
     */
    private static function isTrustedProxy(string $ip): bool
    {
        $public = filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE);
        if ($public === false) {
            return true;
        }
        foreach (explode(',', Env::get('TRUSTED_PROXIES')) as $range) {
            $range = trim($range);
            if ($range !== '' && self::inRange($ip, $range)) {
                return true;
            }
        }
        return false;
    }

    /** Ligg `$ip` i `$range` (ei enkeltadresse eller eit CIDR-nett, IPv4 eller IPv6)? */
    private static function inRange(string $ip, string $range): bool
    {
        [$net, $bits] = array_pad(explode('/', $range, 2), 2, null);
        $a = @inet_pton($ip);
        $b = @inet_pton(trim((string) $net));
        if ($a === false || $b === false || strlen($a) !== strlen($b)) {
            return false;
        }

        $max   = strlen($a) * 8;
        $bits  = $bits === null ? $max : max(0, min($max, (int) $bits));
        $bytes = intdiv($bits, 8);
        if ($bytes > 0 && strncmp($a, $b, $bytes) !== 0) {
            return false;
        }

        $rest = $bits % 8;
        if ($rest === 0) {
            return true;
        }
        $mask = (0xFF << (8 - $rest)) & 0xFF;
        return (ord($a[$bytes]) & $mask) === (ord($b[$bytes]) & $mask);
    }

    /** Ei gyldig IP-adresse, eller null. IPv4-mappa IPv6 (`::ffff:1.2.3.4`) vert til IPv4. */
    private static function validIp($value): ?string
    {
        $ip = trim((string) ($value ?? ''));
        if (stripos($ip, '::ffff:') === 0 && filter_var(substr($ip, 7), FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            $ip = substr($ip, 7);
        }
        return filter_var($ip, FILTER_VALIDATE_IP) ? $ip : null;
    }
}
