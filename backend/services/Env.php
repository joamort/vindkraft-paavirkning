<?php
/**
 * backend/services/Env.php
 *
 * To spørsmål om INSTALLASJONEN som fleire endepunkt må vere samde om:
 *
 *   1. Kva står i `.env`?
 *   2. Er dette ei sjølvhosta utgåve (nedlastbar pakke / Docker), eller ein
 *      open web-host?
 *
 * Begge vart før svara på kvar for seg, i kvar si fil — og med motsett
 * forteikn. `cron/fetch_turbines.php` las ein tom `CRON_SECRET` som «stengt»,
 * medan `refresh_turbines.php` las den same tomme verdien som «ope». På ein
 * host som følgde `.env.example` («tom = web-trigging av») stod dermed
 * oppdaterings-endepunktet ope for heile internett. Verifisert på
 * littavalt.no: ein POST utan nøkkel bygde turbin-cachen på nytt frå NVE.
 * Sjå CLAUDE.md §32.
 *
 * Ingen tredjepartsavhengigheiter, og med vilje ingen «Config»-ramme: appen
 * har to innstillingar.
 */

class Env
{
    /** @var array<string,string>|null `.env`, lese éin gong per førespurnad. */
    private static ?array $values = null;

    /**
     * Verdien av ein nøkkel i `.env`, eller `$default` om han manglar/er tom.
     */
    public static function get(string $key, string $default = ''): string
    {
        self::$values ??= self::parse(dirname(__DIR__, 2) . '/.env');
        $value = self::$values[$key] ?? '';
        return $value !== '' ? $value : $default;
    }

    /**
     * Køyrer appen som ei SJØLVHOSTA utgåve?
     *
     * -----------------------------------------------------------------------
     * EKSPLISITT SIGNAL, IKKJE FRÅVÆRET AV EIN INNSTILLING
     * -----------------------------------------------------------------------
     * Det gamle kriteriet var «`CRON_SECRET` er tom». Men ein tom verdi er òg
     * det ein får når nokon aldri har oppretta `.env` i det heile — altså
     * standardtilstanden på ein fersk web-host. Eit endepunkt som opnar seg
     * av at noko MANGLAR, står ope som standard.
     *
     * Tre signal tel no, og alle seier noko om KVAR appen køyrer — ikkje om
     * kva som manglar:
     *
     *  - SAPI-en er `frankenphp`: serveren som følgjer med dei nedlastbare
     *    pakkane og Docker-biletet (Caddyfile). Han køyrer aldri på eit
     *    vanleg Apache-webhotell.
     *  - SAPI-en er `cli-server`: `php -S`, som `scripts/dev.sh` og den som
     *    køyrer frå kjeldekoden brukar. PHP sjølv åtvarar mot å sleppe han
     *    ut på eit ope nett; han er ein lokal utviklingsserver.
     *  - Miljøvariabelen `VIND_SELVHOST=1`, for andre lokale oppsett (t.d.
     *    XAMPP/MAMP, der det er Apache som køyrer på eigen maskin).
     *
     * Slik verkar «Oppdater no» for alle som lastar ned eller klonar appen frå
     * GitHub og køyrer han sjølv — utan oppsett, og utan å vere avhengig av
     * nokon annan sin server.
     */
    public static function isSelfHosted(): bool
    {
        if (PHP_SAPI === 'frankenphp' || PHP_SAPI === 'cli-server') {
            return true;
        }
        return getenv('VIND_SELVHOST') === '1';
    }

    /**
     * Kan turbin-cachen byggjast på nytt over web UTAN nøkkel
     * («Oppdater no»-knappen)?
     *
     * Berre i ei sjølvhosta utgåve, og berre når eigaren ikkje har sett ein
     * `CRON_SECRET`. Ein sett nøkkel tyder «denne installasjonen står ope på
     * nett» — då går oppdatering via `cron/fetch_turbines.php?key=…`.
     */
    public static function canRefreshOverWeb(): bool
    {
        return self::isSelfHosted() && self::get('CRON_SECRET') === '';
    }

    /**
     * Minimal `.env`-lesar: `NØKKEL=verdi`, `#` for kommentarar, valfrie
     * hermeteikn rundt verdien.
     *
     * @return array<string,string>
     */
    private static function parse(string $path): array
    {
        if (!is_readable($path)) {
            return [];
        }
        $out = [];
        foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
            $line = trim($line);
            if ($line === '' || $line[0] === '#') {
                continue;
            }
            [$k, $v] = array_pad(explode('=', $line, 2), 2, '');
            $out[trim($k)] = trim($v, " \t\"'");
        }
        return $out;
    }
}
