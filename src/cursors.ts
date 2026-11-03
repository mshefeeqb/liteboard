/**
 * Small SVG cursors that show what a tool will do: the pen shows its ink
 * colour and real size, the laser a red dot. Cached by their inputs.
 */

const cache = new Map<string, string>();

function svgCursor(svg: string, hotspot: number, fallback: string): string {
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotspot} ${hotspot}, ${fallback}`;
}

/** A dot the size and colour of the stroke the pen will draw. */
export function penCursor(color: string, diameter: number): string {
    const d = Math.round(Math.max(4, Math.min(40, diameter)));
    const key = `pen${color}${d}`;
    let c = cache.get(key);
    if (!c) {
        const size = d + 6;
        const mid = size / 2;
        c = svgCursor(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
                `<circle cx="${mid}" cy="${mid}" r="${d / 2 + 1.5}" fill="none" stroke="rgba(0,0,0,0.35)"/>` +
                `<circle cx="${mid}" cy="${mid}" r="${d / 2}" fill="${color}" stroke="#fff" stroke-width="1"/>` +
                `</svg>`,
            Math.round(mid),
            'crosshair',
        );
        cache.set(key, c);
    }
    return c;
}

export const LASER_CURSOR = svgCursor(
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">' +
        '<circle cx="10" cy="10" r="8" fill="rgba(255,59,48,0.25)"/>' +
        '<circle cx="10" cy="10" r="4" fill="#ff3b30" stroke="#fff" stroke-width="1"/>' +
        '</svg>',
    10,
    'crosshair',
);
