import type { Element, ElementType, Scene } from '../types';

/**
 * Wire and storage format. Points become integers in tenths of a scene unit,
 * each one stored as the difference from the previous value, which turns
 * `[412.3, 98.7, 413.1, 99.2]` into `[4123, 987, 8, 5]`: about a third of
 * the characters in JSON.
 */

const TYPES: ReadonlySet<ElementType> = new Set([
    'pen',
    'line',
    'arrow',
    'rect',
    'ellipse',
    'text',
    'note',
]);

/** Limits for data from other clients or storage. */
const MAX_POINTS = 40_000;
const MAX_TEXT = 10_000;
const MAX_STRING = 64;

export function encodePoints(pts: number[]): number[] {
    const out = new Array<number>(pts.length);
    let px = 0;
    let py = 0;
    for (let i = 0; i < pts.length; i += 2) {
        const x = Math.round(pts[i] * 10);
        const y = Math.round(pts[i + 1] * 10);
        out[i] = x - px;
        out[i + 1] = y - py;
        px = x;
        py = y;
    }
    return out;
}

export function decodePoints(enc: number[]): number[] {
    const out = new Array<number>(enc.length);
    let x = 0;
    let y = 0;
    for (let i = 0; i < enc.length; i += 2) {
        x += enc[i];
        y += enc[i + 1];
        out[i] = x / 10;
        out[i + 1] = y / 10;
    }
    return out;
}

export function encodeElement(el: Element): Element {
    return el.pts ? { ...el, pts: encodePoints(el.pts) } : el;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown, max = MAX_STRING): v is string =>
    typeof v === 'string' && v.length <= max;
const isNumArray = (v: unknown, max: number): v is number[] =>
    Array.isArray(v) && v.length <= max && v.every(isNum);

/**
 * Validates and decodes one element from untrusted input. Returns null for
 * anything malformed, so one bad record cannot break a board.
 */
export function decodeElement(raw: unknown): Element | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (
        !isStr(r.id) ||
        !TYPES.has(r.t as ElementType) ||
        !isNum(r.x) ||
        !isNum(r.y) ||
        !isNum(r.w) ||
        !isNum(r.h) ||
        !isStr(r.c) ||
        !isNum(r.sw) ||
        !isNum(r.z) ||
        !isNum(r.v) ||
        !isStr(r.by)
    ) {
        return null;
    }
    const el: Element = {
        id: r.id,
        t: r.t as ElementType,
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        c: r.c,
        sw: r.sw,
        z: r.z,
        v: r.v,
        by: r.by,
    };
    if (r.pts !== undefined) {
        if (!isNumArray(r.pts, MAX_POINTS) || r.pts.length % 2 !== 0) return null;
        el.pts = decodePoints(r.pts);
    }
    if (r.pr !== undefined) {
        if (!isNumArray(r.pr, MAX_POINTS / 2)) return null;
        el.pr = r.pr;
    }
    if (r.fill !== undefined) {
        if (!isStr(r.fill)) return null;
        el.fill = r.fill;
    }
    if (r.txt !== undefined) {
        if (!isStr(r.txt, MAX_TEXT)) return null;
        el.txt = r.txt;
    }
    if (r.fs !== undefined) {
        if (!isNum(r.fs)) return null;
        el.fs = r.fs;
    }
    if (r.del) el.del = 1;
    return el;
}

export function encodeScene(elements: Iterable<Element>): Scene {
    const els: Element[] = [];
    for (const el of elements) els.push(encodeElement(el));
    return { v: 1, els };
}

export function decodeScene(scene: unknown): Element[] {
    if (!scene || typeof scene !== 'object') return [];
    const els = (scene as { els?: unknown }).els;
    if (!Array.isArray(els)) return [];
    const out: Element[] = [];
    for (const raw of els) {
        const el = decodeElement(raw);
        if (el) out.push(el);
    }
    return out;
}
