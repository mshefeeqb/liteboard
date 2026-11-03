import type { Element, Point, Rect } from '../types';

const ID_ALPHABET =
    '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-';

export function nanoid(size = 10): string {
    const bytes = new Uint8Array(size);
    crypto.getRandomValues(bytes);
    let id = '';
    for (let i = 0; i < size; i++) id += ID_ALPHABET[bytes[i] & 63];
    return id;
}

/** Rounds to 0.1 scene units, the precision everything is stored at. */
export function round1(n: number): number {
    return Math.round(n * 10) / 10;
}

export function intersects(a: Rect, b: Rect): boolean {
    return (
        a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y
    );
}

export function containsRect(outer: Rect, inner: Rect): boolean {
    return (
        inner.x >= outer.x &&
        inner.y >= outer.y &&
        inner.x + inner.w <= outer.x + outer.w &&
        inner.y + inner.h <= outer.y + outer.h
    );
}

export function unionRect(rects: Rect[]): Rect | null {
    if (rects.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const r of rects) {
        minX = Math.min(minX, r.x);
        minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + r.w);
        maxY = Math.max(maxY, r.y + r.h);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Rectangle spanned by two corners, in any order. */
export function rectFromPoints(a: Point, b: Point): Rect {
    return {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        w: Math.abs(b.x - a.x),
        h: Math.abs(b.y - a.y),
    };
}

/** Bounding box grown by half the stroke width, for culling and selection. */
export function elementBounds(el: Element): Rect {
    const pad = el.t === 'text' || el.t === 'note' ? 0 : el.sw / 2 + (el.t === 'arrow' ? el.sw * 4 : 0);
    return { x: el.x - pad, y: el.y - pad, w: el.w + pad * 2, h: el.h + pad * 2 };
}

/**
 * Turns absolute points into the stored form: the bounding box plus points
 * relative to its top-left, rounded to 0.1.
 */
export function relativePoints(abs: number[]): Pick<Element, 'x' | 'y' | 'w' | 'h' | 'pts'> {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < abs.length; i += 2) {
        minX = Math.min(minX, abs[i]);
        maxX = Math.max(maxX, abs[i]);
        minY = Math.min(minY, abs[i + 1]);
        maxY = Math.max(maxY, abs[i + 1]);
    }
    const x = round1(minX);
    const y = round1(minY);
    const pts = new Array<number>(abs.length);
    for (let i = 0; i < abs.length; i += 2) {
        pts[i] = round1(abs[i] - x);
        pts[i + 1] = round1(abs[i + 1] - y);
    }
    return { x, y, w: round1(maxX - x), h: round1(maxY - y), pts };
}

export function absolutePoints(el: Element): number[] {
    const pts = el.pts ?? [];
    const abs = new Array<number>(pts.length);
    for (let i = 0; i < pts.length; i += 2) {
        abs[i] = pts[i] + el.x;
        abs[i + 1] = pts[i + 1] + el.y;
    }
    return abs;
}

export function distToSegmentSq(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
): number {
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    let t = len === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx - px;
    const cy = ay + t * dy - py;
    return cx * cx + cy * cy;
}

/**
 * Ramer–Douglas–Peucker on flat [x, y, …] points. Returns the indices (point
 * numbers, not array offsets) to keep, so per-point data such as pressure
 * can be filtered the same way. Iterative, so long strokes cannot overflow
 * the stack.
 */
export function simplify(points: number[], epsilon: number): number[] {
    const n = points.length / 2;
    if (n <= 2) return Array.from({ length: n }, (_, i) => i);
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;
    const stack: [number, number][] = [[0, n - 1]];
    const epsSq = epsilon * epsilon;
    while (stack.length > 0) {
        const [first, last] = stack.pop()!;
        let maxDist = 0;
        let index = -1;
        for (let i = first + 1; i < last; i++) {
            const d = distToSegmentSq(
                points[i * 2],
                points[i * 2 + 1],
                points[first * 2],
                points[first * 2 + 1],
                points[last * 2],
                points[last * 2 + 1],
            );
            if (d > maxDist) {
                maxDist = d;
                index = i;
            }
        }
        if (index !== -1 && maxDist > epsSq) {
            keep[index] = 1;
            stack.push([first, index], [index, last]);
        }
    }
    const kept: number[] = [];
    for (let i = 0; i < n; i++) if (keep[i]) kept.push(i);
    return kept;
}

/**
 * Whether `p` touches the element. `area` treats the inside of shapes and
 * text as hits (selection); `stroke` only counts the outline, unless the
 * shape is filled (eraser).
 */
export function hitTest(
    el: Element,
    p: Point,
    tolerance: number,
    mode: 'stroke' | 'area',
): boolean {
    const b = elementBounds(el);
    if (
        p.x < b.x - tolerance ||
        p.y < b.y - tolerance ||
        p.x > b.x + b.w + tolerance ||
        p.y > b.y + b.h + tolerance
    ) {
        return false;
    }
    const reach = tolerance + el.sw / 2;
    switch (el.t) {
        case 'text':
        case 'note':
            return true;
        case 'pen':
        case 'line':
        case 'arrow': {
            const pts = el.pts ?? [];
            const px = p.x - el.x;
            const py = p.y - el.y;
            const reachSq = reach * reach;
            if (pts.length === 2) {
                return (px - pts[0]) ** 2 + (py - pts[1]) ** 2 <= reachSq;
            }
            for (let i = 0; i + 3 < pts.length; i += 2) {
                if (
                    distToSegmentSq(px, py, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]) <=
                    reachSq
                ) {
                    return true;
                }
            }
            return false;
        }
        case 'rect': {
            if (mode === 'area' || el.fill) return true;
            const insideInner =
                p.x > el.x + reach &&
                p.x < el.x + el.w - reach &&
                p.y > el.y + reach &&
                p.y < el.y + el.h - reach;
            return !insideInner;
        }
        case 'ellipse': {
            const a = el.w / 2;
            const bb = el.h / 2;
            const dx = p.x - (el.x + a);
            const dy = p.y - (el.y + bb);
            const outer = (dx / (a + reach)) ** 2 + (dy / (bb + reach)) ** 2 <= 1;
            if (!outer) return false;
            if (mode === 'area' || el.fill) return true;
            if (a <= reach || bb <= reach) return true;
            return (dx / (a - reach)) ** 2 + (dy / (bb - reach)) ** 2 >= 1;
        }
    }
}

export function translateElement(el: Element, dx: number, dy: number): Element {
    return { ...el, x: round1(el.x + dx), y: round1(el.y + dy) };
}

/** Maps an element from one bounding box onto another (resize). */
export function scaleElement(el: Element, from: Rect, to: Rect): Element {
    const sx = from.w === 0 ? 1 : to.w / from.w;
    const sy = from.h === 0 ? 1 : to.h / from.h;
    const mapX = (x: number) => to.x + (x - from.x) * sx;
    const mapY = (y: number) => to.y + (y - from.y) * sy;

    if (el.pts) {
        const abs = absolutePoints(el);
        for (let i = 0; i < abs.length; i += 2) {
            abs[i] = mapX(abs[i]);
            abs[i + 1] = mapY(abs[i + 1]);
        }
        return { ...el, ...relativePoints(abs) };
    }
    if (el.t === 'text') {
        const s = Math.abs(sy) || 1;
        return {
            ...el,
            x: round1(mapX(el.x)),
            y: round1(mapY(el.y)),
            w: round1(el.w * s),
            h: round1(el.h * s),
            fs: round1((el.fs ?? 20) * s),
        };
    }
    const r = rectFromPoints(
        { x: mapX(el.x), y: mapY(el.y) },
        { x: mapX(el.x + el.w), y: mapY(el.y + el.h) },
    );
    return { ...el, x: round1(r.x), y: round1(r.y), w: round1(r.w), h: round1(r.h) };
}
