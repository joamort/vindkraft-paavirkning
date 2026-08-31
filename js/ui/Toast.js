/**
 * js/ui/Toast.js
 *
 * Toast-meldingar. Same singleton-mønster som PolitiKartet/TagTrack.
 */

import { escHtml } from '../utils/dom.js';

const IKON = {
    success: 'fa-circle-check',
    error: 'fa-circle-exclamation',
    info: 'fa-circle-info',
    warning: 'fa-triangle-exclamation',
};

/** Så mange toastar som får stå samtidig — ein 429-storm skal ikkje fylle skjermen. */
const MAKS_SAMTIDIG = 4;

export class Toast {
    static show(melding, type = 'info', varighetMs = 4000) {
        const container = document.getElementById('toast-container');
        if (!container) return;

        // Klipp dei eldste om køen har vakse seg for lang.
        const staaande = container.querySelectorAll('.toast:not(.toast-ut)');
        for (let i = 0; i <= staaande.length - MAKS_SAMTIDIG; i++) {
            staaande[i].remove();
        }

        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.setAttribute('role', type === 'error' ? 'alert' : 'status');
        el.innerHTML = `<i class="fa-solid ${IKON[type] ?? IKON.info}"></i><span>${escHtml(melding)}</span>`;

        // Klikk lukkar tidleg.
        el.addEventListener('click', () => {
            el.classList.add('toast-ut');
            setTimeout(() => el.remove(), 300);
        });

        container.appendChild(el);

        setTimeout(() => {
            el.classList.add('toast-ut');
            setTimeout(() => el.remove(), 300);
        }, varighetMs);
    }

    static success(m) { this.show(m, 'success'); }
    static error(m) { this.show(m, 'error', 6000); }
    static info(m) { this.show(m, 'info'); }
    static warning(m) { this.show(m, 'warning', 5000); }
}
