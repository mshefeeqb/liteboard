import {
    containsRect,
    elementBounds,
    hitTest,
    rectFromPoints,
    scaleElement,
    translateElement,
    unionRect,
} from '../model/geometry';
import { drawElement } from '../render/draw';
import type { Element, Point, Rect } from '../types';
import type { Tool, ToolContext, ToolPointer } from './types';

type Corner = 0 | 1 | 2 | 3; // top-left, top-right, bottom-right, bottom-left

const ACCENT = '#4c6ef5';
const CURSORS = ['nwse-resize', 'nesw-resize', 'nwse-resize', 'nesw-resize'];

function corners(r: Rect): Point[] {
    return [
        { x: r.x, y: r.y },
        { x: r.x + r.w, y: r.y },
        { x: r.x + r.w, y: r.y + r.h },
        { x: r.x, y: r.y + r.h },
    ];
}

/** Box around the elements' own geometry, which resizing maps. */
function geometryBox(els: Element[]): Rect | null {
    return unionRect(els.map((e) => ({ x: e.x, y: e.y, w: e.w, h: e.h })));
}

export function selectTool(ctx: ToolContext): Tool {
    type Drag =
        | { kind: 'move'; start: Point; dx: number; dy: number }
        | { kind: 'resize'; anchor: Point; from: Rect; to: Rect }
        | { kind: 'box'; start: Point; end: Point; additive: boolean };
    let drag: Drag | null = null;

    const selected = (): Element[] => {
        const out: Element[] = [];
        for (const id of ctx.selection) {
            const el = ctx.store.get(id);
            if (el && !el.del) out.push(el);
        }
        return out;
    };

    const outline = (els: Element[]): Rect | null => {
        const box = unionRect(els.map(elementBounds));
        if (!box) return null;
        const pad = ctx.px(4);
        return { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 };
    };

    const handleSize = () => ctx.px(ctx.pointerType === 'touch' ? 18 : 10);

    const cornerAt = (p: Point): Corner | null => {
        const box = outline(selected());
        if (!box) return null;
        const reach = handleSize();
        const pts = corners(box);
        for (let i = 0; i < 4; i++) {
            if (Math.abs(p.x - pts[i].x) <= reach && Math.abs(p.y - pts[i].y) <= reach) {
                return i as Corner;
            }
        }
        return null;
    };

    const elementAt = (p: Point): Element | null => {
        const els = ctx.store.elements();
        const tolerance = ctx.px(ctx.pointerType === 'touch' ? 10 : 5);
        for (let i = els.length - 1; i >= 0; i--) {
            if (hitTest(els[i], p, tolerance, 'area')) return els[i];
        }
        return null;
    };

    /** Elements as they look mid-drag. */
    const preview = (): Element[] => {
        if (!drag || drag.kind === 'box') return selected();
        const d = drag;
        return selected().map((el) =>
            d.kind === 'move' ? translateElement(el, d.dx, d.dy) : scaleElement(el, d.from, d.to),
        );
    };

    const commit = (els: Element[]) => {
        ctx.history.commit(els);
    };

    const end = () => {
        drag = null;
        ctx.unhide();
        ctx.invalidate(true);
    };

    return {
        cursor: 'default',
        down(p) {
            const corner = cornerAt(p);
            if (corner !== null) {
                const from = geometryBox(selected())!;
                const anchor = corners(from)[(corner + 2) % 4];
                drag = { kind: 'resize', anchor, from, to: from };
                ctx.hide(ctx.selection);
                return;
            }
            const hit = elementAt(p);
            if (hit) {
                if (p.shiftKey) {
                    const next = new Set(ctx.selection);
                    if (next.has(hit.id)) next.delete(hit.id);
                    else next.add(hit.id);
                    ctx.setSelection(next);
                } else if (!ctx.selection.has(hit.id)) {
                    ctx.setSelection([hit.id]);
                }
                if (ctx.selection.has(hit.id)) {
                    drag = { kind: 'move', start: p, dx: 0, dy: 0 };
                }
                return;
            }
            const box = outline(selected());
            if (box && !p.shiftKey && containsRect(box, { x: p.x, y: p.y, w: 0, h: 0 })) {
                drag = { kind: 'move', start: p, dx: 0, dy: 0 };
                return;
            }
            if (!p.shiftKey) ctx.setSelection([]);
            drag = { kind: 'box', start: p, end: p, additive: p.shiftKey };
        },
        move(p: ToolPointer) {
            if (!drag) return;
            if (drag.kind === 'move') {
                drag.dx = p.x - drag.start.x;
                drag.dy = p.y - drag.start.y;
                ctx.hide(ctx.selection);
            } else if (drag.kind === 'resize') {
                let to = rectFromPoints(drag.anchor, p);
                if (p.shiftKey && drag.from.w > 0 && drag.from.h > 0) {
                    const s = Math.max(to.w / drag.from.w, to.h / drag.from.h);
                    const w = drag.from.w * s;
                    const h = drag.from.h * s;
                    to = {
                        x: p.x < drag.anchor.x ? drag.anchor.x - w : drag.anchor.x,
                        y: p.y < drag.anchor.y ? drag.anchor.y - h : drag.anchor.y,
                        w,
                        h,
                    };
                }
                drag.to = to;
            } else {
                drag.end = p;
            }
            ctx.invalidate();
        },
        up() {
            if (!drag) return;
            if (drag.kind === 'move') {
                if (drag.dx !== 0 || drag.dy !== 0) commit(preview());
            } else if (drag.kind === 'resize') {
                if (drag.to.w > 0 || drag.to.h > 0) commit(preview());
            } else {
                const area = rectFromPoints(drag.start, drag.end);
                const inside = ctx.store
                    .elements()
                    .filter((el) => containsRect(area, elementBounds(el)))
                    .map((el) => el.id);
                ctx.setSelection(drag.additive ? [...ctx.selection, ...inside] : inside);
            }
            end();
        },
        cancel: end,
        hover(p) {
            const corner = cornerAt(p);
            if (corner !== null) return CURSORS[corner];
            return elementAt(p) ? 'move' : 'default';
        },
        doubleClick(p) {
            const hit = elementAt(p);
            if (hit?.t === 'text' || hit?.t === 'note') ctx.editText(hit);
            else if (!hit) ctx.editText(null, p);
        },
        keyDown(e) {
            const step = e.shiftKey ? 10 : 1;
            const moves: Record<string, [number, number]> = {
                ArrowLeft: [-step, 0],
                ArrowRight: [step, 0],
                ArrowUp: [0, -step],
                ArrowDown: [0, step],
            };
            const delta = moves[e.key];
            if (!delta || ctx.selection.size === 0) return false;
            commit(selected().map((el) => translateElement(el, delta[0], delta[1])));
            return true;
        },
        deactivate() {
            drag = null;
            ctx.unhide();
        },
        drawLive(c) {
            const els = preview();
            if (drag && drag.kind !== 'box') {
                for (const el of els) drawElement(c, el, { theme: ctx.theme });
            }
            c.lineWidth = ctx.px(1);
            c.strokeStyle = ACCENT;
            if (els.length > 1) {
                c.setLineDash([ctx.px(4), ctx.px(3)]);
                for (const el of els) {
                    const b = elementBounds(el);
                    c.strokeRect(b.x, b.y, b.w, b.h);
                }
                c.setLineDash([]);
            }
            const box = outline(els);
            if (box) {
                c.strokeRect(box.x, box.y, box.w, box.h);
                const s = handleSize() * 0.8;
                c.fillStyle = '#ffffff';
                for (const q of corners(box)) {
                    c.fillRect(q.x - s / 2, q.y - s / 2, s, s);
                    c.strokeRect(q.x - s / 2, q.y - s / 2, s, s);
                }
            }
            if (drag?.kind === 'box') {
                const r = rectFromPoints(drag.start, drag.end);
                c.fillStyle = 'rgba(76, 110, 245, 0.08)';
                c.fillRect(r.x, r.y, r.w, r.h);
                c.strokeRect(r.x, r.y, r.w, r.h);
            }
            return false;
        },
    };
}
