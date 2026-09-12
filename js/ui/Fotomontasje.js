/**
 * js/ui/Fotomontasje.js
 *
 * Legg turbin-omriss oppå eit foto brukaren har teke frå (om lag)
 * analysepunktet. Til skilnad frå 3D-panoramaet, som utleier kameraretninga
 * frå terrenget, MÅ brukaren her stille inn kameraet sjølv:
 *
 *   - sikt-retning  (kompasskurs midt i biletet)
 *   - synsfelt      (horisontal, i grader)
 *   - horisont      (kor høgt i biletet den sanne horisonten ligg)
 *
 * Difor er dette eit HJELPEMIDDEL, ikkje ei måling: plasseringa er berre så
 * nøyaktig som innstillingane. Same fysikk som resten av appen — augehøgd,
 * jordkrumming/refraksjon (`horisontfall`), og klipping mot
 * `synlegheit.horisontMoh` frå analysen (§16) — men projeksjonen er ein
 * enkel rett-linjes 2D-modell som held for synsfelt opp til ~90°.
 *
 * Ingen bibliotek: eit <canvas> og fotoet som teksturkjelde. Fotoet vert
 * aldri lasta opp — alt skjer i nettlesaren.
 */

import { CONFIG } from '../config.js';
import { horisontfall } from '../utils/geo.js';
import { escHtml, fmtAvstand, $ } from '../utils/dom.js';
import { Toast } from './Toast.js';

const DEG = Math.PI / 180;
const wrap180 = (g) => ((g + 540) % 360) - 180;
const wrap360 = (g) => ((g % 360) + 360) % 360;

export class Fotomontasje {
    constructor() {
        this.rot = null;
        this.bilete = null;      // HTMLImageElement
        this.turbinar = [];      // synlege analyseresultat
        this.augeMoh = 0;
        this.kurs = 0;           // sikt-retning (grader)
        this.fov = 65;           // horisontalt synsfelt (grader)
        this.horisontOffsetGr = 0; // kor mange grader horisonten ligg over/under midten
        this._bygd = false;

        /**
         * TO-PUNKTS-KALIBRERING (PLAN.md TODO).
         *
         * `_kalSteg` er `null` (av), `'a'` (ventar på klikk for fyrste
         * turbinen) eller `'b'` (ventar på det andre). Pikselkoordinatane vert
         * lagra etter kvart klikk og brukt til å løyse ut kurs/synsfelt når
         * begge er i hus — sjå `_fullforKalibrering()`.
         */
        this._kalSteg = null;
        this._kalTurbinA = null;
        this._kalTurbinB = null;
        this._kalXA = null;
        this._kalWA = null;
    }

    _byggSkjelett() {
        if (this._bygd) return;
        this.rot = $('fotomontasje');
        if (!this.rot) return;
        this.rot.innerHTML = `
            <div class="fm-verktoylinje">
                <strong>Fotomontasje</strong>
                <label class="fm-last">
                    <i class="fa-solid fa-image"></i> Vel foto
                    <input type="file" id="fm-fil" accept="image/*" hidden>
                </label>
                <label>Sikt-retning <output id="fm-kurs-ut">0°</output>
                    <input type="range" id="fm-kurs" min="0" max="359" value="0"></label>
                <label>Synsfelt <output id="fm-fov-ut">65°</output>
                    <input type="range" id="fm-fov" min="35" max="100" value="65"></label>
                <label>Horisont <output id="fm-hor-ut">0°</output>
                    <input type="range" id="fm-hor" min="-25" max="25" value="0"></label>
                <label>Kalibrer med
                    <select id="fm-kal-a"></select> og <select id="fm-kal-b"></select>
                </label>
                <button type="button" class="knapp knapp-liten" id="fm-kal-start">
                    <i class="fa-solid fa-crosshairs"></i> Kalibrer</button>
                <button type="button" class="knapp" id="fm-last-ned" disabled>
                    <i class="fa-solid fa-download"></i> Last ned</button>
                <button type="button" class="ikonknapp" id="fm-lukk" aria-label="Lukk">
                    <i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="fm-lerret-boks">
                <canvas id="fm-lerret"></canvas>
                <p id="fm-kal-status" class="fm-kal-status" hidden></p>
                <p id="fm-tomtekst" class="fm-tomtekst">
                    Vel eit foto teke frå (om lag) analysepunktet. Still så inn sikt-retning,
                    synsfelt og horisont til biletet stemmer — eller, om du kjenner att to
                    turbinar i biletet, vel dei i «Kalibrer med» og trykk «Kalibrer»: sikt-retning
                    og synsfelt vert då løyste ut eksakt frå dei to punkta du klikkar. Turbinane
                    vert teikna der modellen seier dei står — så nøyaktig som innstillingane dine.
                </p>
            </div>
            <p class="fm-atterhald">
                Dette er eit <strong>manuelt hjelpemiddel</strong>. Turbinplasseringa er berre så
                rett som sikt-retninga og synsfeltet du stiller inn. Omrissa er ikkje fotorealistiske,
                og turbinar som analysen fann skjulte av terrenget (bar bakke) vert ikkje teikna.
            </p>`;
        this._bindKontrollar();
        this._bygd = true;
    }

    _bindKontrollar() {
        $('fm-lukk').addEventListener('click', () => this.lukk());
        $('fm-fil').addEventListener('change', (e) => this._lastFoto(e.target.files?.[0]));

        const bind = (id, felt, suffiks, etter) => {
            const inp = $(id);
            inp.addEventListener('input', () => {
                this[felt] = Number(inp.value);
                $(`${id}-ut`).textContent = inp.value + suffiks;
                etter?.();
                this._teikn();
            });
        };
        bind('fm-kurs', 'kurs', '°');
        bind('fm-fov', 'fov', '°');
        bind('fm-hor', 'horisontOffsetGr', '°');

        $('fm-last-ned').addEventListener('click', () => this._lastNed());
        $('fm-kal-start').addEventListener('click', () => this._startKalibrering());
        $('fm-lerret').addEventListener('click', (e) => this._kalibrerKlikk(e));
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this._kalSteg) { this._avbrytKalibrering(); return; }
            if (e.key === 'Escape' && this.rot?.classList.contains('open')) this.lukk();
        });
    }

    /**
     * @param {{punkt:object, resultat:object[]}} arg
     */
    opne({ punkt, resultat }) {
        this._byggSkjelett();
        if (!this.rot) return;

        this.augeMoh = punkt.hoyde + CONFIG.sikt.augehoydeM;
        this.turbinar = resultat.filter(
            (r) => r.analysert && r.synlegheit.synlegDel > 0 && Number.isFinite(r.navMoh),
        );

        // Start peikande mot den mest dominerande synlege turbinen.
        if (this.turbinar.length) {
            const mest = this.turbinar.reduce(
                (a, b) => (a.dominans.synsvinkelGrader >= b.dominans.synsvinkelGrader ? a : b),
            );
            this.kurs = Math.round(mest.kurs);
            $('fm-kurs').value = this.kurs;
            $('fm-kurs-ut').textContent = this.kurs + '°';
        }

        this._avbrytKalibrering();
        this._fyllKalibreringsval();

        this.rot.classList.add('open');
        this.rot.setAttribute('aria-hidden', 'false');
        this._teikn();
    }

    lukk() {
        this.rot?.classList.remove('open');
        this.rot?.setAttribute('aria-hidden', 'true');
    }

    _lastFoto(fil) {
        if (!fil) return;
        const url = URL.createObjectURL(fil);
        const img = new Image();
        img.onload = () => {
            this.bilete = img;
            $('fm-tomtekst').hidden = true;
            $('fm-last-ned').disabled = false;
            this._teikn();
            URL.revokeObjectURL(url);
        };
        img.onerror = () => { URL.revokeObjectURL(url); };
        img.src = url;
    }

    _teikn() {
        const lerret = $('fm-lerret');
        if (!lerret || !this.rot?.classList.contains('open')) return;

        const boks = lerret.parentElement.getBoundingClientRect();
        let w = Math.max(320, Math.floor(boks.width));
        let h = Math.max(240, Math.floor(boks.height));
        if (this.bilete) {
            // Behald biletformatet, «contain» innanfor boksen.
            const forhold = this.bilete.width / this.bilete.height;
            if (w / h > forhold) w = Math.floor(h * forhold);
            else h = Math.floor(w / forhold);
        }
        lerret.width = w;
        lerret.height = h;

        const ctx = lerret.getContext('2d');
        ctx.clearRect(0, 0, w, h);
        if (this.bilete) ctx.drawImage(this.bilete, 0, 0, w, h);
        else { ctx.fillStyle = '#1e293b'; ctx.fillRect(0, 0, w, h); }

        const hfov = this.fov * DEG;
        const vfov = 2 * Math.atan(Math.tan(hfov / 2) * (h / w));
        const yHorisont = h / 2 - (this.horisontOffsetGr * DEG / vfov) * h;

        // Horisontlinje som referanse.
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 5]);
        ctx.beginPath(); ctx.moveTo(0, yHorisont); ctx.lineTo(w, yHorisont); ctx.stroke();
        ctx.setLineDash([]);

        const vinkelTilY = (theta) => yHorisont - (theta / vfov) * h;

        let teikna = 0;
        for (const r of this.turbinar) {
            const daz = wrap180(r.kurs - this.kurs) * DEG;
            const rotorRad = (r.rotorDiameterM / 2) / r.avstandM; // radianar (angulær)
            if (Math.abs(daz) > hfov / 2 + rotorRad) continue;

            const x = w / 2 + (daz / hfov) * w;
            const fall = horisontfall(r.avstandM);
            const tNav = Math.atan2((r.navMoh - fall) - this.augeMoh, r.avstandM);
            const tBasis = Math.atan2((r.basisMoh - fall) - this.augeMoh, r.avstandM);
            const tHorisont = Math.atan2((r.synlegheit.horisontMoh - fall) - this.augeMoh, r.avstandM);

            const yNav = vinkelTilY(tNav);
            const yBasis = vinkelTilY(tBasis);
            const yKlipp = vinkelTilY(tHorisont);        // alt under denne er skjult
            const rotorPx = (rotorRad / vfov) * h;

            ctx.save();
            ctx.beginPath();
            ctx.rect(0, 0, w, Math.min(yKlipp, h));       // klipp bort det terrenget skjuler
            ctx.clip();

            ctx.strokeStyle = 'rgba(30,41,59,0.85)';
            ctx.fillStyle = 'rgba(148,163,184,0.55)';
            ctx.lineWidth = Math.max(1.2, rotorPx * 0.06);

            // Tårn
            ctx.beginPath();
            ctx.moveTo(x, yBasis);
            ctx.lineTo(x, yNav);
            ctx.stroke();

            // Rotor (sirkel om navet)
            ctx.beginPath();
            ctx.arc(x, yNav, Math.max(2, rotorPx), 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            ctx.restore();
            teikna++;
        }

        // Liten HUD nede.
        ctx.fillStyle = 'rgba(15,23,42,0.6)';
        ctx.fillRect(0, h - 22, w, 22);
        ctx.fillStyle = '#fff';
        ctx.font = '12px system-ui, sans-serif';
        ctx.fillText(
            `${teikna} turbin${teikna === 1 ? '' : 'ar'} i biletet · sikt ${this.kurs}° · synsfelt ${this.fov}°`,
            8, h - 7,
        );

        // Merk kvar fyrste kalibreringsklikk landa, medan me ventar på det andre.
        if (this._kalSteg === 'b' && this._kalXA != null) {
            ctx.strokeStyle = '#22d3ee';
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 4]);
            ctx.beginPath();
            ctx.moveTo(this._kalXA, 0);
            ctx.lineTo(this._kalXA, h);
            ctx.stroke();
            ctx.setLineDash([]);
        }
    }

    // -------------------------------------------------- to-punkts-kalibrering

    /** Fyll dei to «Kalibrer med»-vala med dei synlege turbinane i settet. */
    _fyllKalibreringsval() {
        const aSel = $('fm-kal-a');
        const bSel = $('fm-kal-b');
        if (!aSel || !bSel) return;
        const opts = this.turbinar
            // Sortert etter kurs — gjer «den til venstre» / «den til høgre»
            // i biletet lettare å kjenne att i lista.
            .slice()
            .sort((a, b) => a.kurs - b.kurs)
            .map((r) => `<option value="${escHtml(r.id)}">`
                + `${escHtml(r.navn)} (${escHtml(r.retning)}, ${fmtAvstand(r.avstandM)})</option>`)
            .join('');
        aSel.innerHTML = opts;
        bSel.innerHTML = opts;
        // Ulike standardval om det finst minst to å velje mellom.
        if (bSel.options.length > 1) bSel.selectedIndex = 1;
    }

    /**
     * Start kalibreringssteget. Dei to vala må vere ULIKE turbinar — identiske
     * punkt gir ei likning delt på null (§ `_fullforKalibrering`).
     */
    _startKalibrering() {
        if (!this.bilete) {
            Toast.info('Vel eit foto først.');
            return;
        }
        const aId = $('fm-kal-a')?.value;
        const bId = $('fm-kal-b')?.value;
        if (!aId || !bId || aId === bId) {
            Toast.warning('Vel to ULIKE turbinar å kalibrere med.');
            return;
        }
        this._kalTurbinA = this.turbinar.find((t) => t.id === aId) ?? null;
        this._kalTurbinB = this.turbinar.find((t) => t.id === bId) ?? null;
        if (!this._kalTurbinA || !this._kalTurbinB) return;

        this._kalXA = null;
        this._kalWA = null;
        this._kalSteg = 'a';
        this._oppdaterKalStatus();
    }

    _avbrytKalibrering() {
        this._kalSteg = null;
        this._kalXA = null;
        this._kalWA = null;
        const status = $('fm-kal-status');
        if (status) status.hidden = true;
        const lerret = $('fm-lerret');
        if (lerret) lerret.style.cursor = '';
    }

    _oppdaterKalStatus() {
        const status = $('fm-kal-status');
        const lerret = $('fm-lerret');
        if (!status) return;
        if (this._kalSteg === 'a') {
            status.textContent = `Klikk der ${this._kalTurbinA.navn} står i biletet (1 av 2) — Esc avbryt`;
            status.hidden = false;
        } else if (this._kalSteg === 'b') {
            status.textContent = `Klikk der ${this._kalTurbinB.navn} står i biletet (2 av 2) — Esc avbryt`;
            status.hidden = false;
        } else {
            status.hidden = true;
        }
        if (lerret) lerret.style.cursor = this._kalSteg ? 'crosshair' : '';
    }

    /**
     * Eitt klikk i lerretet under kalibrering. Berre x-koordinaten tel — sjå
     * `_fullforKalibrering()`, som løyser BERRE horisontalaksen (kurs og
     * synsfelt), akkurat dei to storleikane TODO-en i PLAN.md etterspør.
     * Horisontlinja stillast framleis for hand: ho er lett å sjå med auget,
     * og treng ikkje ein tredje kalibreringsklikk.
     */
    _kalibrerKlikk(e) {
        if (!this._kalSteg) return;
        const lerret = $('fm-lerret');
        const rect = lerret.getBoundingClientRect();
        // CSS-piksel → canvas-piksel: lerretet kan vere skalert av layouten.
        const x = (e.clientX - rect.left) * (lerret.width / rect.width);

        if (this._kalSteg === 'a') {
            this._kalXA = x;
            this._kalWA = lerret.width;
            this._kalSteg = 'b';
            this._oppdaterKalStatus();
            this._teikn();
            return;
        }

        this._fullforKalibrering(x, lerret.width);
    }

    /**
     * Løys ut sikt-retning og synsfelt frå dei to klikka.
     *
     * `_teikn()` plasserer ein turbin med kompasskurs `r.kurs` i pikselkolonne
     *
     *     x = w/2 + (wrap180(r.kurs − sikt) / fov) · w
     *
     * — ei LINEÆR avbilding frå vinkel til piksel (den enkle rett-linjes
     * projeksjonen filheaderen skildrar). To kjende punkt gir difor to
     * lineære likningar med to ukjende (sikt, fov): løys dei ved å trekkje
     * den eine frå den andre. Ingen iterasjon trengst her — ulikt
     * `stoyRadiusM()` i NoiseModel.js, som MÅ bisecte fordi den likninga
     * ikkje er lineær.
     */
    _fullforKalibrering(xB, w) {
        this._kalSteg = null;
        this._oppdaterKalStatus();

        const xA = this._kalXA;
        const wA = this._kalWA;
        this._kalXA = null;
        this._kalWA = null;

        if (wA !== w) {
            Toast.warning('Vindauget vart endra storleik midt i kalibreringa — prøv på nytt.');
            this._teikn();
            return;
        }

        const dx = xA - xB;
        if (Math.abs(dx) < 4) {
            Toast.warning('Dei to klikka ligg for nær kvarandre til å kalibrere presist. Prøv på nytt.');
            this._teikn();
            return;
        }

        const db = wrap180(this._kalTurbinA.kurs - this._kalTurbinB.kurs);
        const fovRaa = (w * db) / dx;
        if (!Number.isFinite(fovRaa) || fovRaa <= 0 || fovRaa > 150) {
            Toast.error('Fekk ikkje eit truverdig resultat frå desse to punkta — er turbinane '
                + 'rett identifiserte, og klikka i same rekkjefølgje som dei står i biletet?');
            this._teikn();
            return;
        }
        const fov = Math.min(100, Math.max(35, Math.round(fovRaa)));
        const kurs = Math.round(wrap360(this._kalTurbinA.kurs - (fovRaa * (xA - w / 2)) / w));

        this.kurs = kurs;
        this.fov = fov;
        $('fm-kurs').value = kurs;
        $('fm-kurs-ut').textContent = kurs + '°';
        $('fm-fov').value = fov;
        $('fm-fov-ut').textContent = fov + '°';

        const klemt = fov !== Math.round(fovRaa)
            ? ` (klemt frå ${Math.round(fovRaa)}° — glidaren dekkjer berre 35–100°)` : '';
        Toast.success(`Kalibrert: sikt ${kurs}°, synsfelt ${fov}°${klemt}.`);
        this._teikn();
    }

    _lastNed() {
        const lerret = $('fm-lerret');
        if (!lerret) return;
        lerret.toBlob((blob) => {
            if (!blob) return;
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'fotomontasje.png';
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }, 'image/png');
    }
}
