import type { Theme } from '../types';

const inkCache = new Map<string, string>();

function luminance(hex: string): number | null {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

/**
 * Stored colours are theme-neutral. Near-black ink is drawn light on a dark
 * board and near-white ink dark on a light one, so nothing disappears when
 * the theme changes.
 */
export function inkColor(color: string, theme: Theme): string {
    const key = theme + color;
    let out = inkCache.get(key);
    if (out === undefined) {
        const lum = luminance(color);
        out = color;
        if (lum !== null) {
            if (theme === 'dark' && lum < 0.2) out = '#e9ecef';
            else if (theme === 'light' && lum > 0.92) out = '#1e1e1e';
        }
        inkCache.set(key, out);
    }
    return out;
}
