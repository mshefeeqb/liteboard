import { elementBounds, unionRect } from './model/geometry';
import {
    arrowHead,
    DEFAULT_FONT,
    drawElement,
    inkColor,
    lastSegment,
    LINE_HEIGHT,
    NOTE_PADDING,
    NOTE_TEXT,
    penPath,
    wrapText,
} from './render/draw';
import type { Element, Rect, Theme } from './types';

export interface ExportOptions {
    /** Area to export, in scene units. Defaults to the drawing plus padding. */
    region?: Rect;
    /** Padding around the drawing when no region is given. Default 20. */
    padding?: number;
    /** Background colour; `null` keeps it transparent. Default white. */
    background?: string | null;
    /** Pixels per scene unit (PNG only). Default 2. */
    scale?: number;
    /** Ink theme. Default light. */
    theme?: Theme;
    fontFamily?: string;
    /**
     * Draws host content (lesson pages, images) under the strokes. The
     * context is already in scene coordinates.
     */
    drawUnderlay?: (ctx: CanvasRenderingContext2D, region: Rect) => void | Promise<void>;
}

/** Largest side of an exported image, to stay inside mobile canvas limits. */
const MAX_SIDE = 4096;

function exportRegion(elements: readonly Element[], opts: ExportOptions): Rect {
    if (opts.region) return opts.region;
    const pad = opts.padding ?? 20;
    const box = unionRect(elements.map(elementBounds)) ?? { x: 0, y: 0, w: 1, h: 1 };
    return { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 };
}

export async function exportPNG(
    elements: readonly Element[],
    opts: ExportOptions = {},
): Promise<Blob> {
    const region = exportRegion(elements, opts);
    let scale = opts.scale ?? 2;
    scale = Math.min(scale, MAX_SIDE / Math.max(region.w, region.h, 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(region.w * scale));
    canvas.height = Math.max(1, Math.ceil(region.h * scale));
    const ctx = canvas.getContext('2d')!;
    const background = opts.background === undefined ? '#ffffff' : opts.background;
    if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.setTransform(scale, 0, 0, scale, -region.x * scale, -region.y * scale);
    if (opts.drawUnderlay) {
        ctx.save();
        await opts.drawUnderlay(ctx, region);
        ctx.restore();
    }
    const drawOpts = { theme: opts.theme ?? 'light', fontFamily: opts.fontFamily };
    for (const el of elements) drawElement(ctx, el, drawOpts);
    return new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png'),
    );
}

const esc = (s: string) =>
    s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const points = (el: Element, pts: number[]) => {
    let s = '';
    for (let i = 0; i < pts.length; i += 2) s += `${pts[i] + el.x},${pts[i + 1] + el.y} `;
    return s.trim();
};

export function exportSVG(elements: readonly Element[], opts: ExportOptions = {}): string {
    const region = exportRegion(elements, opts);
    const theme = opts.theme ?? 'light';
    const background = opts.background === undefined ? '#ffffff' : opts.background;
    const font = esc(opts.fontFamily ?? DEFAULT_FONT);
    const out: string[] = [
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${region.x} ${region.y} ${region.w} ${region.h}" width="${region.w}" height="${region.h}">`,
    ];
    if (background) {
        out.push(
            `<rect x="${region.x}" y="${region.y}" width="${region.w}" height="${region.h}" fill="${esc(background)}"/>`,
        );
    }
    for (const el of elements) {
        const c = esc(inkColor(el.c, theme));
        const stroke = `stroke="${c}" stroke-width="${el.sw}" stroke-linecap="round" stroke-linejoin="round"`;
        const fill = el.fill ? `fill="${esc(el.fill)}"` : 'fill="none"';
        switch (el.t) {
            case 'pen':
                out.push(
                    `<path transform="translate(${el.x} ${el.y})" d="${penPath(el.pts ?? [], el.pr, el.sw)}" fill="${c}"/>`,
                );
                break;
            case 'line':
            case 'arrow': {
                const pts = el.pts ?? [];
                out.push(`<polyline points="${points(el, pts)}" fill="none" ${stroke}/>`);
                const seg = el.t === 'arrow' ? lastSegment(pts) : null;
                if (seg) {
                    const [ax, ay, bx, by] = arrowHead(...seg, el.sw);
                    out.push(
                        `<polyline points="${points(el, [ax, ay, seg[2], seg[3], bx, by])}" fill="none" ${stroke}/>`,
                    );
                }
                break;
            }
            case 'rect':
                out.push(`<rect x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" ${fill} ${stroke}/>`);
                break;
            case 'ellipse':
                out.push(
                    `<ellipse cx="${el.x + el.w / 2}" cy="${el.y + el.h / 2}" rx="${el.w / 2}" ry="${el.h / 2}" ${fill} ${stroke}/>`,
                );
                break;
            case 'note': {
                const fs = el.fs ?? 20;
                const r = Math.min(8, el.w / 8, el.h / 8);
                const lines = wrapText(el.txt ?? '', fs, el.w - NOTE_PADDING * 2, opts.fontFamily)
                    .map(
                        (line, i) =>
                            `<tspan x="${el.x + NOTE_PADDING}" y="${el.y + NOTE_PADDING + i * fs * LINE_HEIGHT + (fs * (LINE_HEIGHT - 1)) / 2}">${esc(line)}</tspan>`,
                    )
                    .join('');
                out.push(
                    `<rect x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" rx="${r}" fill="${esc(el.fill ?? '#ffec99')}"/>`,
                    `<text font-family="${font}" font-size="${fs}" fill="${NOTE_TEXT}" dominant-baseline="text-before-edge" xml:space="preserve">${lines}</text>`,
                );
                break;
            }
            case 'text': {
                const fs = el.fs ?? 20;
                const lines = (el.txt ?? '')
                    .split('\n')
                    .map(
                        (line, i) =>
                            `<tspan x="${el.x}" y="${el.y + i * fs * LINE_HEIGHT + (fs * (LINE_HEIGHT - 1)) / 2}">${esc(line)}</tspan>`,
                    )
                    .join('');
                out.push(
                    `<text font-family="${font}" font-size="${fs}" fill="${c}" dominant-baseline="text-before-edge" xml:space="preserve">${lines}</text>`,
                );
                break;
            }
        }
    }
    out.push('</svg>');
    return out.join('');
}
