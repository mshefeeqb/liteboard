import { LiveStroke } from '../live';
import { nanoid, relativePoints, simplify } from '../model/geometry';
import type { Tool, ToolContext, ToolPointer } from './types';

/** Points closer than this (screen px) to the previous one are dropped. */
const MIN_SPACING = 0.75;
/** Simplification tolerance (screen px): invisible, but removes most points. */
const SIMPLIFY = 0.3;

export function penTool(ctx: ToolContext): Tool {
    let stroke: LiveStroke | null = null;

    const toByte = (p: number) => Math.round(Math.min(1, Math.max(0, p)) * 255);

    const add = (s: LiveStroke, p: ToolPointer) => {
        s.push(p.x, p.y, toByte(p.pressure || 0.5));
        ctx.emitLive({
            kind: 'stroke',
            id: s.id,
            color: s.color,
            width: s.width,
            index: s.length - 1,
            x: p.x,
            y: p.y,
        });
        ctx.invalidate();
    };

    const finish = (s: LiveStroke) => {
        const keep = simplify(s.pts, ctx.px(SIMPLIFY));
        const pts = keep.flatMap((i) => [s.pts[i * 2], s.pts[i * 2 + 1]]);
        let pr: number[] | undefined;
        if (s.withPressure) {
            pr = keep.map((i) => s.pr[i]);
            // A pen that reports one constant value has no real pressure.
            if (pr.every((v) => v === pr![0])) pr = undefined;
        }
        ctx.history.commit([
            {
                id: s.id,
                t: 'pen',
                ...relativePoints(pts),
                ...(pr && { pr }),
                c: s.color,
                sw: s.width,
            },
        ]);
    };

    const cancel = () => {
        if (!stroke) return;
        ctx.emitLive({ kind: 'strokeEnd', id: stroke.id });
        stroke = null;
        ctx.invalidate();
    };

    return {
        cursor: 'crosshair',
        down(p) {
            stroke = new LiveStroke(
                nanoid(),
                ctx.style.color,
                ctx.style.strokeWidth,
                p.pointerType === 'pen',
            );
            add(stroke, p);
        },
        move(p) {
            if (!stroke) return;
            const n = stroke.pts.length;
            const min = ctx.px(MIN_SPACING);
            if (Math.abs(p.x - stroke.pts[n - 2]) < min && Math.abs(p.y - stroke.pts[n - 1]) < min) {
                return;
            }
            add(stroke, p);
        },
        up() {
            if (!stroke) return;
            const s = stroke;
            stroke = null;
            // The saved stroke replaces the live one on everyone's screen.
            finish(s);
            ctx.invalidate();
        },
        cancel,
        drawLive(c) {
            stroke?.draw(c, ctx.theme);
            return false;
        },
    };
}
