<?php
/**
 * backend/services/Http.php
 *
 * Minimal HTTP-klient for utgåande kall til eksterne tenester (NVE, Kartverket).
 *
 * Bruker cURL når extensionen finst (normalen på delt webhotell), og fell
 * tilbake på stream-wrappers (`file_get_contents` + `stream_context`) når han
 * ikkje gjer det. Fallbacken er ikkje pynt: PHP-CLI-en som brukast til lokal
 * smoke-testing i dette prosjektet er bygd UTAN ext-curl, så utan denne
 * fallbacken kan ingen av endepunkta testast lokalt i det heile.
 *
 * Ingen tredjepartsavhengigheiter (jf. TECH_STACK.md — ingen Composer i runtime).
 */

class Http
{
    /** Standard timeout i sekund for eit enkelt kall. */
    public const DEFAULT_TIMEOUT = 30;

    /**
     * User-Agent identifiserer appen mot offentlege norske API-ar. Kartverket og
     * NVE ber eksplisitt om ein identifiserbar UA med kontaktinfo.
     */
    public const USER_AGENT = 'VindPaaverknad/1.0 (+https://littavalt.no/vind/)';

    /**
     * Utfør ein GET og returner rå responstekst.
     *
     * @param string   $url     Fullt kvalifisert URL (skal alt vera validert av kallaren)
     * @param string[] $headers Ekstra headerlinjer, t.d. ['Accept: application/json']
     * @param int      $timeout Timeout i sekund
     * @return array{ok:bool, status:int, body:string, error:?string}
     */
    public static function get(string $url, array $headers = [], int $timeout = self::DEFAULT_TIMEOUT): array
    {
        return self::request('GET', $url, null, $headers, $timeout);
    }

    /**
     * Utfør ein POST med rå body (t.d. WPS Execute-XML).
     *
     * @return array{ok:bool, status:int, body:string, error:?string}
     */
    public static function post(string $url, string $body, array $headers = [], int $timeout = self::DEFAULT_TIMEOUT): array
    {
        return self::request('POST', $url, $body, $headers, $timeout);
    }

    /**
     * Felles inngang. Vel cURL eller stream-fallback ut frå kva som er tilgjengeleg.
     *
     * @return array{ok:bool, status:int, body:string, error:?string}
     */
    private static function request(string $method, string $url, ?string $body, array $headers, int $timeout): array
    {
        $headers[] = 'User-Agent: ' . self::USER_AGENT;

        if (function_exists('curl_init')) {
            return self::viaCurl($method, $url, $body, $headers, $timeout);
        }
        return self::viaStream($method, $url, $body, $headers, $timeout);
    }

    /**
     * @return array{ok:bool, status:int, body:string, error:?string}
     */
    private static function viaCurl(string $method, string $url, ?string $body, array $headers, int $timeout): array
    {
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
        curl_setopt($ch, CURLOPT_MAXREDIRS, 3);
        curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, min(15, $timeout));
        curl_setopt($ch, CURLOPT_TIMEOUT, $timeout);
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
        // Handterer gzip transparent — NVE-svara er store og komprimerer godt.
        curl_setopt($ch, CURLOPT_ENCODING, '');

        if ($method === 'POST') {
            curl_setopt($ch, CURLOPT_POST, true);
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body ?? '');
        }

        $response = curl_exec($ch);
        $status   = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error    = curl_error($ch) ?: null;
        curl_close($ch);

        if ($response === false) {
            return ['ok' => false, 'status' => $status, 'body' => '', 'error' => $error ?? 'cURL-kallet feila'];
        }

        return [
            'ok'     => $status >= 200 && $status < 300,
            'status' => $status,
            'body'   => (string) $response,
            'error'  => $status >= 400 ? "HTTP $status" : null,
        ];
    }

    /**
     * Stream-fallback for miljø utan ext-curl.
     *
     * `ignore_errors => true` gjer at 4xx/5xx returnerer body i staden for å
     * berre gi `false` — me vil kunne vidareformidle feilmeldinga frå tenesta.
     *
     * @return array{ok:bool, status:int, body:string, error:?string}
     */
    private static function viaStream(string $method, string $url, ?string $body, array $headers, int $timeout): array
    {
        $opts = [
            'http' => [
                'method'        => $method,
                'header'        => implode("\r\n", $headers),
                'timeout'       => $timeout,
                'ignore_errors' => true,
                'follow_location' => 1,
                'max_redirects' => 4,
            ],
            'ssl' => [
                'verify_peer'      => true,
                'verify_peer_name' => true,
            ],
        ];
        if ($method === 'POST') {
            $opts['http']['content'] = $body ?? '';
        }

        $context  = stream_context_create($opts);
        $response = @file_get_contents($url, false, $context);

        // $http_response_header vert sett av stream-wrapperen i lokalt scope.
        $status = 0;
        if (isset($http_response_header) && is_array($http_response_header)) {
            foreach ($http_response_header as $line) {
                if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) {
                    $status = (int) $m[1]; // siste status vinn (etter redirects)
                }
            }
        }

        if ($response === false) {
            return ['ok' => false, 'status' => $status, 'body' => '', 'error' => 'Nettverkskallet feila (stream)'];
        }

        return [
            'ok'     => $status >= 200 && $status < 300,
            'status' => $status,
            'body'   => (string) $response,
            'error'  => $status >= 400 ? "HTTP $status" : null,
        ];
    }

    /**
     * GET som forventar JSON. Returnerer dekoda array, eller null ved feil.
     *
     * @param string|null $error Vert sett til ei forklarande melding ved feil.
     */
    public static function getJson(string $url, ?string &$error = null, int $timeout = self::DEFAULT_TIMEOUT): ?array
    {
        $res = self::get($url, ['Accept: application/json'], $timeout);
        if (!$res['ok']) {
            $error = $res['error'] ?? 'Ukjend nettverksfeil';
            return null;
        }
        $data = json_decode($res['body'], true);
        if (!is_array($data)) {
            $error = 'Ugyldig JSON i svaret';
            return null;
        }
        $error = null;
        return $data;
    }
}
