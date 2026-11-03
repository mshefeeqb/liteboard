import { getStroke } from 'perfect-freehand';
import type { Element, Theme } from '../types';
import { inkColor } from './color';

export { inkColor };

export const LINE_HEIGHT = 1.25;
/** Space between a sticky note's edge and its text, in scene units. */
export const NOTE_PADDING = 14;
/** Notes are light paper in both themes, so their text stays dark. */
export const NOTE_TEXT = '#1e1e1e';
export const NOTE_SIZE = 200;
export const DEFAULT_FONT =
    'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif';

export function textFont(fontSize: number, family = DEFAULT_FONT): string {
    return `${fontSize}px ${family}`;
}

// ---- Pen strokes -------------------------------------------------------------

/** Diameter perfect-freehand draws for a stroke width. */
const penSize = (sw: number) => sw * 2 + 1;

function strokeInput(pts: number[], pr: number[] | undefined): number[][] {
    const input = new Array<number[]>(pts.length / 2);
    for (let i = 0; i < input.length; i++) {
        input[i] = [pts[i * 2], pts[i * 2 + 1], pr ? pr[i] / 255 : 0.5];
    }
    return input;
}

/** Outline polygon of a pen stroke as SVG path data. */
export function penPath(pts: number[], pr: number[] | undefined, sw: number, done = true): string {
    const outline = getStroke(strokeInput(pts, pr), {
        size: penSize(sw),
        // Without real pressure the line keeps one width. Simulated pressure
        // depends on point spacing, so the stroke would change shape when it
        // is simplified at pointer-up.
        thinning: pr ? 0.6 : 0,
        smoothing: 0.5,
        streamline: 0.4,
        simulatePressure: false,
        last: done,
    });
    const n = outline.length;
    if (n < 3) return '';
    const f = (v: number) => Math.round(v * 100) / 100;
    let d = `M${f(outline[0][0])},${f(outline[0][1])}Q`;
    for (let i = 0; i < n; i++) {
        const [x0, y0] = outline[i];
        const [x1, y1] = outline[(i + 1) % n];
        d += `${f(x0)},${f(y0)} ${f((x0 + x1) / 2)},${f((y0 + y1) / 2)} `;
    }
    return d + 'Z';
}

/** Built paths, keyed by the points array: moving a stroke keeps the array. */
const pathCache = new WeakMap<number[], { sw: number; path: Path2D }>();

function cachedPenPath(el: Element): Path2D {
    const pts = el.pts!;
    const hit = pathCache.get(pts);
    if (hit && hit.sw === el.sw) return hit.path;
    const path = new Path2D(penPath(pts, el.pr, el.sw));
    pathCache.set(pts, { sw: el.sw, path });
    return path;
}

// ---- Arrows --------------------------------------------------------------------

/** The two wing tips of an arrow head ending at (x2, y2). */
export function arrowHead(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    sw: number,
): [number, number, number, number] {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const len = Math.min(Math.max(10, sw * 4), Math.hypot(x2 - x1, y2 - y1) * 0.5);
    const spread = Math.PI / 7;
    return [
        x2 - len * Math.cos(angle - spread),
        y2 - len * Math.sin(angle - spread),
        x2 - len * Math.cos(angle + spread),
        y2 - len * Math.sin(angle + spread),
    ];
}

/** Last two distinct points of a polyline, for the arrow direction. */
export function lastSegment(pts: number[]): [number, number, number, number] | null {
    const n = pts.length;
    if (n < 4) return null;
    const x2 = pts[n - 2];
    const y2 = pts[n - 1];
    for (let i = n - 4; i >= 0; i -= 2) {
        if (pts[i] !== x2 || pts[i + 1] !== y2) return [pts[i], pts[i + 1], x2, y2];
    }
    return null;
}

// ---- Drawing -------------------------------------------------------------------

export interface DrawOptions {
    theme: Theme;
    fontFamily?: string;
    /** Draws a live stroke without caching its path. */
    live?: boolean;
}

export function drawElement(
    ctx: CanvasRenderingContext2D,
    el: Element,
    opts: DrawOptions,
): void {
    const color = inkColor(el.c, opts.theme);
    ctx.save();
    ctx.translate(el.x, el.y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = el.sw;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;

    switch (el.t) {
        case 'pen': {
            const pts = el.pts ?? [];
            if (pts.length >= 2) {
                ctx.fill(
                    opts.live ? new Path2D(penPath(pts, el.pr, el.sw, false)) : cachedPenPath(el),
                );
            }
            break;
        }
        case 'line':
        case 'arrow': {
            const pts = el.pts ?? [];
            if (pts.length < 4) break;
            ctx.beginPath();
            ctx.moveTo(pts[0], pts[1]);
            for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
            if (el.t === 'arrow') {
                const seg = lastSegment(pts);
                if (seg) {
                    const [ax, ay, bx, by] = arrowHead(...seg, el.sw);
                    ctx.moveTo(ax, ay);
                    ctx.lineTo(seg[2], seg[3]);
                    ctx.lineTo(bx, by);
                }
            }
            ctx.stroke();
            break;
        }
        case 'rect':
            ctx.beginPath();
            ctx.rect(0, 0, el.w, el.h);
            if (el.fill) {
                ctx.fillStyle = el.fill;
                ctx.fill();
            }
            ctx.stroke();
            break;
        case 'ellipse':
            ctx.beginPath();
            ctx.ellipse(el.w / 2, el.h / 2, el.w / 2, el.h / 2, 0, 0, Math.PI * 2);
            if (el.fill) {
                ctx.fillStyle = el.fill;
                ctx.fill();
            }
            ctx.stroke();
            break;
        case 'note': {
            const r = Math.min(8, el.w / 8, el.h / 8);
            // An offset shade instead of shadowBlur, which is slow on
            // low-end GPUs when many notes are on screen.
            ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
            roundRect(ctx, 1.5, 3, el.w, el.h, r);
            ctx.fill();
            ctx.fillStyle = el.fill ?? '#ffec99';
            roundRect(ctx, 0, 0, el.w, el.h, r);
            ctx.fill();
            const fs = el.fs ?? 20;
            ctx.font = textFont(fs, opts.fontFamily);
            ctx.textBaseline = 'top';
            ctx.fillStyle = NOTE_TEXT;
            const lines = wrapText(el.txt ?? '', fs, el.w - NOTE_PADDING * 2, opts.fontFamily);
            const lineHeight = fs * LINE_HEIGHT;
            const maxLines = Math.floor((el.h - NOTE_PADDING * 2) / lineHeight);
            for (let i = 0; i < lines.length && i < Math.max(1, maxLines); i++) {
                ctx.fillText(
                    lines[i],
                    NOTE_PADDING,
                    NOTE_PADDING + i * lineHeight + (fs * (LINE_HEIGHT - 1)) / 2,
                );
            }
            break;
        }
        case 'text': {
            const fs = el.fs ?? 20;
            ctx.font = textFont(fs, opts.fontFamily);
            ctx.textBaseline = 'top';
            const lines = (el.txt ?? '').split('\n');
            for (let i = 0; i < lines.length; i++) {
                // Centre each line in its line box, like the editing textarea.
                ctx.fillText(lines[i], 0, i * fs * LINE_HEIGHT + (fs * (LINE_HEIGHT - 1)) / 2);
            }
            break;
        }
    }
    ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
}

// ---- Text measurement ------------------------------------------------------------

let measureCtx: CanvasRenderingContext2D | null = null;

function measurer(fontSize: number, family?: string): CanvasRenderingContext2D | null {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    if (measureCtx) measureCtx.font = textFont(fontSize, family);
    return measureCtx;
}

/** Wrapped lines by text, size and width. Small: notes rarely change. */
const wrapCache = new Map<string, string[]>();

/**
 * Breaks text into lines no wider than `width`, at spaces where possible.
 * Cached, so drawing a note does not measure text every frame.
 */
export function wrapText(txt: string, fontSize: number, width: number, family?: string): string[] {
    const key = `${fontSize}|${width}|${family ?? ''}|${txt}`;
    const hit = wrapCache.get(key);
    if (hit) return hit;
    const ctx = measurer(fontSize, family);
    const out: string[] = [];
    for (const para of txt.split('\n')) {
        if (!ctx) {
            out.push(para);
            continue;
        }
        let line = '';
        for (const word of para.split(/(\s+)/)) {
            const next = line + word;
            if (line && ctx.measureText(next).width > width && word.trim()) {
                out.push(line.trimEnd());
                line = word;
            } else {
                line = next;
            }
            // A single word wider than the note is broken by characters.
            while (ctx.measureText(line).width > width && line.length > 1) {
                let cut = line.length - 1;
                while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > width) cut--;
                out.push(line.slice(0, cut));
                line = line.slice(cut);
            }
        }
        out.push(line.trimEnd());
    }
    if (wrapCache.size > 500) wrapCache.clear();
    wrapCache.set(key, out);
    return out;
}

export function measureText(
    txt: string,
    fontSize: number,
    family?: string,
): { w: number; h: number } {
    const ctx = measurer(fontSize, family);
    const lines = txt.split('\n');
    let w = 0;
    if (ctx) for (const line of lines) w = Math.max(w, ctx.measureText(line).width);
    return { w: Math.ceil(w), h: Math.ceil(lines.length * fontSize * LINE_HEIGHT) };
}
