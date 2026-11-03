import type { Element, ElementType } from '../types';
import { ProtocolError, Reader, Writer } from './buffer';

/**
 * Binary form of one element. The header (id, version, author) comes first,
 * so the server can merge stored records without decoding the rest.
 *
 *   id · v · by · type · flags · z · x · y · w · h · sw · colour · [optional…]
 *
 * Coordinates are tenths as zigzag varints; points are deltas, which are
 * almost always one byte each. A handwritten stroke is about 60–100 bytes.
 */

const TYPES: readonly ElementType[] = ['pen', 'line', 'arrow', 'rect', 'ellipse', 'text', 'note'];

const PTS = 1;
const PR = 2;
const FILL = 4;
const TXT = 8;
const FS = 16;
const DEL = 32;

const MAX_POINTS = 20_000;
const MAX_TEXT = 10_000;

const HEX = /^#[0-9a-f]{6}$/;

function writeColor(w: Writer, c: string): void {
    const lower = c.toLowerCase();
    if (HEX.test(lower)) {
        const n = parseInt(lower.slice(1), 16);
        w.byte(0).byte(n >> 16).byte((n >> 8) & 255).byte(n & 255);
    } else {
        w.byte(1).str(c);
    }
}

function readColor(r: Reader): string {
    if (r.byte() === 0) {
        const n = (r.byte() << 16) | (r.byte() << 8) | r.byte();
        return '#' + n.toString(16).padStart(6, '0');
    }
    return r.str(64);
}

export function writeElement(w: Writer, el: Element): void {
    let flags = 0;
    if (el.pts) flags |= PTS;
    if (el.pr) flags |= PR;
    if (el.fill !== undefined) flags |= FILL;
    if (el.txt !== undefined) flags |= TXT;
    if (el.fs !== undefined) flags |= FS;
    if (el.del) flags |= DEL;

    w.str(el.id).uint(el.v).str(el.by);
    w.byte(TYPES.indexOf(el.t)).byte(flags).uint(el.z);
    w.tenth(el.x).tenth(el.y).tenth(el.w).tenth(el.h).tenth(el.sw);
    writeColor(w, el.c);
    if (el.pts) {
        const pts = el.pts;
        w.uint(pts.length / 2);
        let px = 0;
        let py = 0;
        for (let i = 0; i < pts.length; i += 2) {
            const x = Math.round(pts[i] * 10);
            const y = Math.round(pts[i + 1] * 10);
            w.int(x - px).int(y - py);
            px = x;
            py = y;
        }
    }
    if (el.pr) {
        w.uint(el.pr.length);
        for (const p of el.pr) w.byte(p);
    }
    if (el.fill !== undefined) writeColor(w, el.fill);
    if (el.txt !== undefined) w.str(el.txt);
    if (el.fs !== undefined) w.tenth(el.fs);
}

/** Encodes one element on its own (what the server stores per row). */
export function encodeElementBinary(el: Element): Uint8Array {
    const w = new Writer(64 + (el.pts?.length ?? 0) * 2);
    writeElement(w, el);
    return w.finish();
}

/** Decodes and validates one element; throws ProtocolError on bad input. */
export function readElement(r: Reader): Element {
    const id = r.str(64);
    const v = r.uint();
    const by = r.str(64);
    const t = TYPES[r.byte()];
    if (!t) throw new ProtocolError('Unknown element type');
    const flags = r.byte();
    const el: Element = {
        id,
        v,
        by,
        t,
        z: r.uint(),
        x: r.tenth(),
        y: r.tenth(),
        w: r.tenth(),
        h: r.tenth(),
        sw: r.tenth(),
        c: readColor(r),
    };
    if (flags & PTS) {
        const n = r.uint();
        if (n > MAX_POINTS) throw new ProtocolError('Too many points');
        const pts = new Array<number>(n * 2);
        let x = 0;
        let y = 0;
        for (let i = 0; i < n; i++) {
            x += r.int();
            y += r.int();
            pts[i * 2] = x / 10;
            pts[i * 2 + 1] = y / 10;
        }
        el.pts = pts;
    }
    if (flags & PR) {
        const n = r.uint();
        if (n > MAX_POINTS) throw new ProtocolError('Too many points');
        el.pr = Array.from(r.bytes(n));
    }
    if (flags & FILL) el.fill = readColor(r);
    if (flags & TXT) el.txt = r.str(MAX_TEXT * 4);
    if (flags & FS) el.fs = r.tenth();
    if (flags & DEL) el.del = 1;
    return el;
}

export function decodeElementBinary(bytes: Uint8Array): Element {
    return readElement(new Reader(bytes));
}

/** Just the merge key of an encoded element: enough for the server. */
export function readElementHeader(bytes: Uint8Array): { id: string; v: number; by: string } {
    const r = new Reader(bytes);
    return { id: r.str(64), v: r.uint(), by: r.str(64) };
}
