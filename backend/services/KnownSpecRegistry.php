<?php
/**
 * backend/services/KnownSpecRegistry.php
 *
 * Slår opp KURATERTE, KJELDEFØRTE turbinmål for namngjevne anlegg.
 *
 * ---------------------------------------------------------------------------
 * KVIFOR DENNE FINST
 * ---------------------------------------------------------------------------
 * NVE sitt `Vindkraft2`-datasett har ingen felt for navhøgde eller
 * rotordiameter (sjå NveVindkraftFetcher.php). `TurbineSpec` estimerer difor
 * mål ut frå merkeeffekt per turbin — som fungerer godt for anlegg i drift,
 * der turbinmodellen er kjend og effekten er reell.
 *
 * For anlegg UNDER BEHANDLING held ikkje den tilnærminga. Der er `effekt_mw`
 * eit planlagt makstal, `antallturbiner` er ofte tomt, og søknaden opererer med
 * eit SPENN av turbinstorleikar. Dei konkrete måla står berre i søknads- og
 * meldingsdokumenta — som PDF, ikkje som API.
 *
 * Denne fila held difor eit lite, manuelt research-a register: eitt oppslag per
 * anlegg der me faktisk har lese eit offentleg dokument og funne tala. Det er
 * menneskeleg kunnskapsarbeid, ikkje noko cron kan hente, så det ligg
 * versjonskontrollert i repoet (`backend/data/turbine_specs_known.json`) og
 * vert ALDRI regenerert av `cron/fetch_turbines.php`.
 *
 * ---------------------------------------------------------------------------
 * TO REGLAR SOM ER LETTE Å MISTOLKE
 * ---------------------------------------------------------------------------
 * 1. **Øvre ende av spennet er visingsverdien.** Søknadene oppgir gjerne
 *    «totalhøgd 200–260 m». Appen er eit illustrasjonsverktøy for kva ein
 *    utbygging KAN innebere, og det er meir ansvarleg å vise for høgt enn for
 *    lågt. Heile spennet vert likevel teke vare på i `mal_spenn` og vist i UI.
 *
 * 2. **Ei kjelde er ikkje ein fasit.** `kjelde_status` seier om tala er søkte,
 *    meldte, vedtekne eller bygde. Ei melding er eit utgangspunkt for
 *    konsekvensutgreiing — det som faktisk vert bygd, kan bli noko anna.
 */

class KnownSpecRegistry
{
    /** Standardplassering for den kuraterte fila. */
    private const DEFAULT_PATH = __DIR__ . '/../data/turbine_specs_known.json';

    /** @var array<string,mixed>|null Lasta oppføringar, nøkla (memoisert). */
    private static ?array $byAnleggsnr = null;
    /** @var array<string,mixed>|null */
    private static ?array $byName = null;
    /** @var string[] Feil/åtvaringar frå lasting, til logging. */
    private static array $loadLog = [];

    /**
     * Slå opp ei kuratert oppføring for eit anlegg.
     *
     * -----------------------------------------------------------------------
     * PRESEDENS: anleggsnr, og BERRE anleggsnr, når oppføringa har eit.
     * -----------------------------------------------------------------------
     * Namneoppslag er med vilje avgrensa til oppføringar UTAN anleggsnr. Det
     * kostar oss litt robustheit, men alternativet er verre — verifisert
     * eksperimentelt under utviklinga:
     *
     * Fornyingssaker heiter nesten det same som anlegget dei skal fornye. Med
     * namnefallback slo «Kjøllefjord vindkraftverk» (anleggsnr 14835, planlagt,
     * 220 m totalhøgd) gjennom på anleggsnr 9574 «Kjøllefjord» — anlegget som
     * FAKTISK står der og har gjort det sidan 2006, med 17 turbinar på under
     * 100 m. Same feil råka Ytre Vikna, Raggovidda og den eldre
     * Skjøtningberg-saka. Fire anlegg i drift fekk stille tildelt måla til eit
     * planlagt anlegg, utan feilmelding nokon stad.
     *
     * Byter NVE anleggsnr på ei sak, går oppføringa i staden «daud» — og det
     * fangar testen i `tools/verify_model.mjs` §7, som krev at kvar oppføring
     * med anleggsnr faktisk treffer noko i cachen. Ein høglydt testfeil er
     * langt betre enn eit stille feiltreff på feil anlegg.
     *
     * @return array<string,mixed>|null
     */
    public static function lookup(?int $anleggsnr, ?string $navn): ?array
    {
        self::load();

        if ($anleggsnr !== null && isset(self::$byAnleggsnr[$anleggsnr])) {
            return self::$byAnleggsnr[$anleggsnr];
        }

        if ($navn !== null && $navn !== '') {
            $key = self::normaliserNamn($navn);
            if ($key !== '' && isset(self::$byName[$key])) {
                return self::$byName[$key];
            }
        }

        return null;
    }

    /** @return string[] Meldingar frå sist lasting (til cron-loggen). */
    public static function loadLog(): array
    {
        self::load();
        return self::$loadLog;
    }

    /** Tal kuraterte oppføringar som er lasta. */
    public static function count(): int
    {
        self::load();
        return count(self::$byAnleggsnr) + count(array_filter(
            self::$byName,
            static fn($e) => ($e['anleggsnr'] ?? null) === null
        ));
    }

    // ------------------------------------------------------------------ lasting

    private static function load(?string $path = null): void
    {
        if (self::$byAnleggsnr !== null && $path === null) {
            return;
        }

        self::$byAnleggsnr = [];
        self::$byName      = [];
        self::$loadLog     = [];

        $file = $path ?? self::DEFAULT_PATH;
        if (!is_file($file)) {
            self::$loadLog[] = "KnownSpecRegistry: fann ikkje $file — alle mål vert estimerte.";
            return;
        }

        $raw = @file_get_contents($file);
        if ($raw === false) {
            self::$loadLog[] = "KnownSpecRegistry: kunne ikkje lese $file.";
            return;
        }

        $data = json_decode($raw, true);
        if (!is_array($data) || !isset($data['oppforingar']) || !is_array($data['oppforingar'])) {
            self::$loadLog[] = "KnownSpecRegistry: $file er ikkje gyldig JSON med ei 'oppforingar'-liste.";
            return;
        }

        foreach ($data['oppforingar'] as $i => $entry) {
            if (!is_array($entry)) {
                continue;
            }
            if (($entry['kjelde_url'] ?? '') === '') {
                // Ei oppføring utan kjelde er per definisjon ikkje kjeldeført,
                // og skal ikkje få lov til å utgi seg for å vere det.
                self::$loadLog[] = "KnownSpecRegistry: hoppar over oppføring #$i utan kjelde_url.";
                continue;
            }

            $nr = isset($entry['anleggsnr']) && $entry['anleggsnr'] !== null
                ? (int) $entry['anleggsnr']
                : null;
            if ($nr !== null) {
                // Har oppføringa eit anleggsnr, er DET nøkkelen. Namna vert
                // ikkje registrerte i det heile — sjå lookup() for kvifor.
                self::$byAnleggsnr[$nr] = $entry;
                continue;
            }

            // Namn + alle alias peikar på same oppføring. Berre for oppføringar
            // som enno ikkje har eit anleggsnr å slå opp på.
            $names = [];
            if (!empty($entry['anleggnavn'])) {
                $names[] = (string) $entry['anleggnavn'];
            }
            foreach ((array) ($entry['alias'] ?? []) as $alias) {
                $names[] = (string) $alias;
            }
            foreach ($names as $name) {
                $key = self::normaliserNamn($name);
                if ($key !== '') {
                    self::$byName[$key] = $entry;
                }
            }
        }

        self::$loadLog[] = 'KnownSpecRegistry: lasta ' . count($data['oppforingar'])
            . ' kuraterte oppføringar (' . count(self::$byAnleggsnr) . ' med anleggsnr, '
            . count(self::$byName) . ' namnenøklar).';
    }

    /** Til testing: tving ny lasting frå ei alternativ fil. */
    public static function reloadFrom(string $path): void
    {
        self::$byAnleggsnr = null;
        self::load($path);
    }

    // ------------------------------------------------------- namnenormalisering

    /**
     * Normaliser eit anleggnamn til ein samanliknbar nøkkel.
     *
     * Steg: UTF-8-folding av norske teikn (æøå → ae/o/a) → små bokstavar →
     * fjern generiske suffiks («vindkraftverk», «vindpark») → fjern alt som
     * ikkje er a–z eller 0–9.
     *
     *   «Nye Hitra 1 vindkraftverk»  → «nyehitra1»
     *   «Nye Hitra I»                → «nyehitrai»   (difor treng me alias)
     *   «Kjøllefjord vindkraftverk»  → «kjollefjord»
     *
     * Bruker IKKJE mbstring: PHP-CLI-en i dette prosjektet er bygd utan han
     * (sjå CLAUDE.md «Fallgruver»), så all folding skjer med byte-erstatting.
     */
    public static function normaliserNamn(string $navn): string
    {
        $folded = strtr($navn, [
            'Æ' => 'ae', 'æ' => 'ae', 'Ø' => 'o', 'ø' => 'o', 'Å' => 'a', 'å' => 'a',
            'Ä' => 'a', 'ä' => 'a', 'Ö' => 'o', 'ö' => 'o', 'Ü' => 'u', 'ü' => 'u',
            'É' => 'e', 'é' => 'e', 'È' => 'e', 'è' => 'e', 'Ê' => 'e', 'ê' => 'e',
            'Á' => 'a', 'á' => 'a', 'Č' => 'c', 'č' => 'c', 'Š' => 's', 'š' => 's',
            'Ŋ' => 'n', 'ŋ' => 'n', 'Đ' => 'd', 'đ' => 'd', 'Ŧ' => 't', 'ŧ' => 't',
            'Ž' => 'z', 'ž' => 'z',
        ]);

        $lower = strtolower($folded);

        // Generiske suffiks som varierer fritt mellom kjelder.
        $lower = str_replace(
            ['vindkraftverk', 'vindkraftanlegg', 'vindkraftpark', 'vindpark', 'vindmollepark'],
            '',
            $lower
        );

        return (string) preg_replace('/[^a-z0-9]/', '', $lower);
    }
}
