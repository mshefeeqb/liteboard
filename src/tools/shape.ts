import { nanoid, rectFromPoints, relativePoints, round1 } from '../model/geometry';
import { drawElement } from '../render/draw';
import type { Element, Point } from '../types';
import type { Tool, ToolContext, ToolPointer } from './types';
import { previewElement } from './types';

type ShapeType = 'line' | 'arrow' | 'rect' | 'ellipse';

/** Shift: lines snap to 15° steps, boxes become squares and circles. */
function constrain(type: ShapeType, start: Point, p: ToolPointer): Point {
    if (!p.shiftKey) return p;
    const dx = p.x - start.x;
    const dy = p.y - start.y;
    if (type === 'line' || type === 'arrow') {
        const step = Math.PI / 12;
        const angle = Math.round(Math.atan2(dy, dx) / step) * step;
        const len = Math.hypot(dx, dy);
        return { x: start.x + Math.cos(angle) * len, y: start.y + Math.sin(angle) * len };
    }
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    return { x: start.x + Math.sign(dx || 1) * side, y: start.y + Math.sign(dy || 1) * side };
}

export function shapeTool(ctx: ToolContext, type: ShapeType): Tool {
    let start: Point | null = null;
    let end: Point | null = null;
    let id = '';

    const build = (): Element | null => {
        if (!start || !end) return null;
        const base = { id, t: type, c: ctx.style.color, sw: ctx.style.strokeWidth };
        if (type === 'line' || type === 'arrow') {
            return previewElement({
                ...base,
                ...relativePoints([start.x, start.y, end.x, end.y]),
            });
        }
        const r = rectFromPoints(start, end);
        return previewElement({
            ...base,
            x: round1(r.x),
            y: round1(r.y),
            w: round1(r.w),
            h: round1(r.h),
            ...(ctx.style.fill && { fill: ctx.style.fill }),
        });
    };

    const reset = () => {
        start = end = null;
        ctx.invalidate();
    };

    const discard = () => {
        if (start) ctx.emitLive({ kind: 'shape', el: null });
        reset();
    };

    return {
        cursor: 'crosshair',
        down(p) {
            id = nanoid();
            start = end = { x: p.x, y: p.y };
        },
        move(p) {
            if (!start) return;
            end = constrain(type, start, p);
            ctx.emitLive({ kind: 'shape', el: build() });
            ctx.invalidate();
        },
        up() {
            const el = build();
            // A tap, or a drag too small to see, draws nothing.
            if (el && Math.max(el.w, el.h) >= ctx.px(3)) {
                const { z: _z, v: _v, by: _by, ...init } = el;
                // The saved shape replaces the preview on everyone's screen.
                ctx.history.commit([init]);
                reset();
            } else {
                discard();
            }
        },
        cancel: discard,
        drawLive(c) {
            const el = build();
            if (el) drawElement(c, el, { theme: ctx.theme });
            return false;
        },
    };
}
