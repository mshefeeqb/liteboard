import { hitTest } from '../model/geometry';
import { drawElement } from '../render/draw';
import type { Point } from '../types';
import type { Tool, ToolContext } from './types';

/** Erases whole elements the pointer passes over, committed as one undo step. */
export function eraserTool(ctx: ToolContext): Tool {
    const erasing = new Set<string>();
    let last: Point | null = null;
    let cursor: Point | null = null;

    const radius = () => ctx.px(ctx.pointerType === 'touch' ? 14 : 8);

    const eraseAt = (p: Point) => {
        const r = radius();
        // Sample the path since the last event so a fast swipe misses nothing.
        const from = last ?? p;
        const steps = Math.max(1, Math.ceil(Math.hypot(p.x - from.x, p.y - from.y) / r));
        let found = false;
        for (let s = 1; s <= steps; s++) {
            const q = {
                x: from.x + ((p.x - from.x) * s) / steps,
                y: from.y + ((p.y - from.y) * s) / steps,
            };
            for (const el of ctx.store.elements()) {
                if (!erasing.has(el.id) && hitTest(el, q, r, 'stroke')) {
                    erasing.add(el.id);
                    found = true;
                }
            }
        }
        if (found) ctx.hide(erasing);
        last = p;
    };

    const reset = () => {
        erasing.clear();
        last = null;
        ctx.unhide();
        ctx.invalidate(true);
    };

    return {
        cursor: 'crosshair',
        down(p) {
            last = null;
            cursor = p;
            eraseAt(p);
            ctx.invalidate();
        },
        move(p) {
            cursor = p;
            if (last) eraseAt(p);
            ctx.invalidate();
        },
        up() {
            if (erasing.size > 0) ctx.history.commit([], [...erasing]);
            cursor = null;
            reset();
        },
        cancel() {
            cursor = null;
            reset();
        },
        hover(p) {
            cursor = p;
            ctx.invalidate();
            return undefined;
        },
        drawLive(c) {
            if (erasing.size > 0) {
                c.globalAlpha = 0.25;
                for (const id of erasing) {
                    const el = ctx.store.get(id);
                    if (el && !el.del) drawElement(c, el, { theme: ctx.theme });
                }
                c.globalAlpha = 1;
            }
            if (cursor) {
                c.beginPath();
                c.arc(cursor.x, cursor.y, radius(), 0, Math.PI * 2);
                c.lineWidth = ctx.px(1);
                c.strokeStyle = ctx.theme === 'dark' ? '#adb5bd' : '#868e96';
                c.stroke();
            }
            return false;
        },
        deactivate() {
            cursor = null;
            ctx.invalidate();
        },
    };
}
