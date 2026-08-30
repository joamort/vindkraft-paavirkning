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

export class Toast {
    static show(melding, type = 'info', varighetMs = 4000) {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.setAttribute('role', type === 'error' ? 'alert' : 'status');
        el.innerHTML = `<i class="fa-solid ${IKON[type] ?? IKON.info}"></i><span>${escHtml(melding)}</span>`;

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
