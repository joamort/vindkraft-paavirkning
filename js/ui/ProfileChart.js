/**
 * js/ui/ProfileChart.js
 *
 * Høgdeprofil-graf for éin turbin (Chart.js).
 *
 * Grafen er kjernen i å gjere resultatet INTUITIVT: han viser terrenget
 * mellom punktet og turbinen i sideprofil, med siktlinja og sjølve turbinen
 * teikna inn. Er turbinen skjult, ser du med ein gong kva ås som stengjer.
 *
 * Fem lag i grafen:
 *   1. Terrengprofilen (fylt areal)
 *   2. Siktlinja frå auget til vengetuppen
 *   3. "Skrapelinja" — terrenghorisonten sett frå auget
 *   4. Turbintårnet (loddrett strek ved turbinens avstand)
 *   5. Rotorspennet (markert område rundt navhøgda)
 *
 * Chart.js er lasta frå CDN og er eit godkjent bibliotek (TECH_STACK.md).
 */

import { krummingsfall } from '../utils/geo.js';

export class ProfileChart {
    /** @param {string} canvasId */
    constructor(canvasId) {
        this.canvasId = canvasId;
        this.chart = null;
    }

    /** Fjern grafen (t.d. når ingen turbin er vald). */
    tom() {
        if (this.chart) {
            this.chart.destroy();
            this.chart = null;
        }
    }

    /**
     * Teikn profilen for eit resultatobjekt frå ImpactCalculator.
     *
     * @param {object} r Resultat frå beregnPaaverknad()
     */
    tegn(r) {
        const canvas = document.getElementById(this.canvasId);
        if (!canvas || !r?.profil || typeof Chart === 'undefined') return;

        this.tom();

        const D = r.avstandM;
        const kmX = (m) => m / 1000;

        // --- Datasett 1: terrenget --------------------------------------
        // Me teiknar den KRUMMINGSKORRIGERTE terrenghøgda, ikkje den rå.
        // Då vert siktlinja ei rett linje i grafen, slik ho er i røynda sett
        // frå auget — og lesaren kan avgjere synlegheit visuelt ved å sjå om
        // terrenget kryssar linja. Teikna me rå høgder måtte siktlinja vore
        // ei kurve, som er langt vanskelegare å lese.
        //
        // Korreksjonen LEGG TIL krummingsfallet. Ein rett stråle mellom to
        // høgder over havet ligg lågare over havet midtvegs enn den lineære
        // interpolasjonen; skal strålen teiknast rett, må terrenget hevast
        // tilsvarande. Same forteikn som i geo.js — sjå grunngjevinga der.
        const terreng = r.profil.map((p) => ({
            x: kmX(p.d),
            y: +(p.z + krummingsfall(p.d, D)).toFixed(1),
        }));

        // --- Datasett 2: siktlinja auge → vengetupp ----------------------
        const siktlinje = [
            { x: 0, y: +r.augeMoh.toFixed(1) },
            { x: kmX(D), y: +r.tuppMoh.toFixed(1) },
        ];

        // --- Datasett 3: terrenghorisonten (skrapelinja) -----------------
        // Linja frå auget som så vidt skrapar det høgaste hinderet, forlengd
        // heilt fram til turbinen. Alt under denne linja ved turbinen er skjult.
        const horisont = [
            { x: 0, y: +r.augeMoh.toFixed(1) },
            { x: kmX(D), y: +r.synlegheit.horisontMoh.toFixed(1) },
        ];

        // --- Datasett 4+5: turbinen --------------------------------------
        const taarn = [
            { x: kmX(D), y: +r.basisMoh.toFixed(1) },
            { x: kmX(D), y: +r.navMoh.toFixed(1) },
        ];
        const rotor = [
            { x: kmX(D), y: +(r.navMoh - r.rotorDiameterM / 2).toFixed(1) },
            { x: kmX(D), y: +r.tuppMoh.toFixed(1) },
        ];

        /**
         * --- Datasett 6+7: SKOG OG BYGNINGAR (DOM-kryssjekken, §22) -------
         *
         * Berre når kryssjekken er køyrd OG fann eit hinder over terskelen.
         *
         * To ting vert teikna, og dei høyrer saman: ei loddrett SØYLE i det
         * kritiske punktet, frå bakken opp til overflatemodellens høgd — det
         * er skogen eller bygningen, i målestokk — og den ALTERNATIVE
         * skrapelinja som går ut frå toppen av henne. At den lina er brattare
         * enn den oransje er heile poenget: det er nettopp den skilnaden som
         * avgjer om turbinen forsvinn.
         *
         * Søyla får krummingskorreksjonen på begge endepunkta, som terrenget
         * elles — elles ville ho stått i eit anna koordinatsystem enn bakken
         * ho skal vekse ut av.
         */
        const o = r.overflate;
        const domData = [];
        if (o?.vesentleg && o.synlegheit) {
            const korr = krummingsfall(o.kritiskD, D);

            /**
             * DEI ANDRE MÅLTE HINDERA (topp-K).
             *
             * Sjekken slår no opp fleire punkt per turbin, og dei som IKKJE
             * vart avgjerande er verdt å sjå: dei viser at det er leita, ikkje
             * berre funne. Tynne søyler, same farge, teikna FØR den tjukke —
             * slik at det avgjerande hinderet framleis er det auget går til.
             */
            for (const c of o.kandidatar ?? []) {
                if (!c.vesentleg || c.d === o.kritiskD) continue;
                const k2 = krummingsfall(c.d, D);
                domData.push({
                    label: 'Anna målt hinder',
                    data: [
                        { x: kmX(c.d), y: +(c.dtmZ + k2).toFixed(1) },
                        { x: kmX(c.d), y: +(c.domZ + k2).toFixed(1) },
                    ],
                    borderColor: 'rgba(4, 120, 87, 0.45)',
                    borderWidth: 2,
                    pointRadius: 0,
                    fill: false,
                    order: 2,
                });
            }

            domData.push(
                {
                    label: 'Skog / bygning (overflatemodell)',
                    data: [
                        { x: kmX(o.kritiskD), y: +(o.dtmZ + korr).toFixed(1) },
                        { x: kmX(o.kritiskD), y: +(o.domZ + korr).toFixed(1) },
                    ],
                    borderColor: '#047857',
                    borderWidth: 5,
                    pointRadius: 0,
                    fill: false,
                    order: 1,
                },
                {
                    label: 'Horisont med skog/bygningar',
                    data: [
                        { x: 0, y: +r.augeMoh.toFixed(1) },
                        { x: kmX(D), y: +o.synlegheit.horisontMoh.toFixed(1) },
                    ],
                    borderColor: '#047857',
                    borderWidth: 1.5,
                    borderDash: [5, 3],
                    pointRadius: 0,
                    fill: false,
                    order: 3,
                },
            );
        }

        // Y-aksen skal alltid ha plass til heile turbinen og litt luft.
        const alleY = [
            ...terreng.map((p) => p.y),
            r.augeMoh, r.tuppMoh, r.basisMoh,
            // Horisonten kan vere ekstremt høg ved nærskjerming — den skal
            // ikkje få lov til å presse heile grafen flat.
            Math.min(r.synlegheit.horisontMoh, r.tuppMoh * 1.3),
            /**
             * DOM-horisonten får IKKJE utvide aksen i det heile.
             *
             * Han ligg per konstruksjon over den vanlege horisonten, og i
             * nærfeltet kan han vere hundrevis av meter over vengetuppen
             * (90 m unna med faktor D/d = 15). Lét han presse aksen, ville
             * heile terrengprofilen — det lesaren faktisk skal sjå — bli
             * klemt ned i ei tynn stripe nedst. Chart.js klipper linja mot
             * ramma i staden, og at ho går ut av biletet OVER vengetuppen er
             * nettopp den avlesinga som skal gjerast.
             */
            ...(o?.vesentleg && o.synlegheit ? [Math.min(o.synlegheit.horisontMoh, r.tuppMoh)] : []),
        ];
        const yMin = Math.min(...alleY);
        const yMaks = Math.max(...alleY);
        const luft = Math.max(20, (yMaks - yMin) * 0.12);

        const skjult = r.synlegheit.nokkel === 'skjult';

        this.chart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                datasets: [
                    {
                        label: 'Terreng',
                        data: terreng,
                        borderColor: '#78716c',
                        backgroundColor: 'rgba(120, 113, 108, 0.28)',
                        borderWidth: 1.5,
                        fill: 'start',
                        pointRadius: 0,
                        tension: 0.15,
                        order: 5,
                    },
                    {
                        label: 'Siktlinje til vengetupp',
                        data: siktlinje,
                        borderColor: skjult ? '#dc2626' : '#16a34a',
                        borderWidth: 2,
                        borderDash: [6, 4],
                        pointRadius: 0,
                        fill: false,
                        order: 2,
                    },
                    {
                        label: 'Terrenghorisont',
                        data: horisont,
                        borderColor: '#f59e0b',
                        borderWidth: 1.5,
                        borderDash: [2, 3],
                        pointRadius: 0,
                        fill: false,
                        order: 3,
                    },
                    {
                        label: 'Tårn',
                        data: taarn,
                        borderColor: '#334155',
                        borderWidth: 3,
                        pointRadius: 0,
                        fill: false,
                        order: 1,
                    },
                    {
                        label: 'Rotorspenn',
                        data: rotor,
                        borderColor: '#0ea5e9',
                        borderWidth: 6,
                        pointRadius: 0,
                        fill: false,
                        order: 0,
                    },
                    ...domData,
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { mode: 'nearest', axis: 'x', intersect: false },
                scales: {
                    x: {
                        type: 'linear',
                        title: { display: true, text: 'Avstand (km)' },
                        min: 0,
                        // Ekstra luft til høgre: turbinen teiknast som ein
                        // loddrett strek nøyaktig ved x = D, og ville elles
                        // blitt klipt av kanten på plottet.
                        max: kmX(D) * 1.08,
                        ticks: { maxTicksLimit: 8 },
                        grid: { color: 'rgba(0,0,0,0.05)' },
                    },
                    y: {
                        title: { display: true, text: 'Høgd (moh.)' },
                        min: Math.floor(yMin - luft),
                        max: Math.ceil(yMaks + luft),
                        grid: { color: 'rgba(0,0,0,0.05)' },
                    },
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'bottom',
                        labels: { boxWidth: 12, font: { size: 10 }, usePointStyle: true },
                    },
                    tooltip: {
                        callbacks: {
                            title: (items) => `${items[0].parsed.x.toFixed(2)} km frå punktet`,
                            label: (item) => {
                                const p = r.profil[item.dataIndex];
                                if (item.datasetIndex === 0 && p) {
                                    return `Terreng: ${Math.round(p.z)} moh.${p.terreng ? ` (${p.terreng})` : ''}`;
                                }
                                return `${item.dataset.label}: ${Math.round(item.parsed.y)} moh.`;
                            },
                        },
                    },
                },
            },
        });
    }
}
