import { encodeScene } from '../model/codec';
import { relativePoints, round1 } from '../model/geometry';
import type { Element, Scene } from '../types';

/** The parts of an Excalidraw element the import reads. */
interface ExcalidrawElement {
    id: string;
    type: string;
    x: number;
    y: number;
    width: number;
    height: number;
    strokeColor?: string;
    backgroundColor?: string;
    strokeWidth?: number;
    isDeleted?: boolean;
    points?: [number, number][];
    pressures?: number[];
    simulatePressure?: boolean;
    text?: string;
    originalText?: string;
    fontSize?: number;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

function convert(el: ExcalidrawElement, z: number): Element | null {
    if (el.isDeleted || !finite(el.x) || !finite(el.y)) return null;
    const base = {
        id: String(el.id),
        c: el.strokeColor && el.strokeColor !== 'transparent' ? el.strokeColor : '#1e1e1e',
        sw: finite(el.strokeWidth) ? el.strokeWidth : 2,
        z,
        v: 1,
        by: 'import',
    };
    const fill =
        el.backgroundColor && el.backgroundColor !== 'transparent'
            ? { fill: el.backgroundColor }
            : {};
    const absolute = (pts: [number, number][]) => pts.flatMap(([px, py]) => [el.x + px, el.y + py]);

    switch (el.type) {
        case 'freedraw':
        case 'line':
        case 'arrow': {
            const pts = (el.points ?? []).filter((p) => finite(p[0]) && finite(p[1]));
            if (pts.length === 0) return null;
            const t = el.type === 'freedraw' ? 'pen' : el.type;
            const out: Element = { ...base, t, ...relativePoints(absolute(pts)) };
            if (
                t === 'pen' &&
                !el.simulatePressure &&
                el.pressures?.length === pts.length &&
                el.pressures.some((p) => p !== el.pressures![0])
            ) {
                out.pr = el.pressures.map((p) => Math.round(Math.min(1, Math.max(0, p)) * 255));
            }
            return out;
        }
        case 'diamond': {
            const { width: w, height: h } = el;
            const pts: [number, number][] = [
                [w / 2, 0],
                [w, h / 2],
                [w / 2, h],
                [0, h / 2],
                [w / 2, 0],
            ];
            return { ...base, t: 'line', ...relativePoints(absolute(pts)) };
        }
        case 'rectangle':
        case 'ellipse':
            return {
                ...base,
                ...fill,
                t: el.type === 'rectangle' ? 'rect' : 'ellipse',
                x: round1(el.x),
                y: round1(el.y),
                w: round1(Math.abs(el.width)),
                h: round1(Math.abs(el.height)),
            };
        case 'text': {
            const txt = el.text ?? el.originalText ?? '';
            if (!txt) return null;
            return {
                ...base,
                t: 'text',
                x: round1(el.x),
                y: round1(el.y),
                w: round1(el.width),
                h: round1(el.height),
                txt,
                fs: finite(el.fontSize) ? el.fontSize : 20,
                sw: 1,
            };
        }
        default:
            // Images, frames, embeds and other types have no equivalent.
            return null;
    }
}

/**
 * Converts a saved Excalidraw scene (`{ elements, appState, files }`) into a
 * board scene. Rotation, roughness and images are not carried over.
 */
export function fromExcalidraw(data: unknown): Scene {
    const raw = (data as { elements?: unknown })?.elements;
    const elements: Element[] = [];
    if (Array.isArray(raw)) {
        raw.forEach((el, i) => {
            if (!el || typeof el !== 'object') return;
            const converted = convert(el as ExcalidrawElement, i + 1);
            if (converted) elements.push(converted);
        });
    }
    return encodeScene(elements);
}
