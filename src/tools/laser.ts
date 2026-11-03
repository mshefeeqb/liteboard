import { LaserTrail } from '../live';
import type { Tool, ToolContext } from './types';

/** A fading pointer trail for showing things. Nothing is saved. */
export function laserTool(ctx: ToolContext): Tool {
    const trail = new LaserTrail();
    let active = false;

    return {
        cursor: 'crosshair',
        down(p) {
            active = true;
            trail.start();
            trail.push(p.x, p.y);
            ctx.emitLive({ kind: 'laser', x: p.x, y: p.y, start: true });
            ctx.invalidate();
        },
        move(p) {
            if (!active) return;
            trail.push(p.x, p.y);
            ctx.emitLive({ kind: 'laser', x: p.x, y: p.y, start: false });
            ctx.invalidate();
        },
        up() {
            active = false;
        },
        cancel() {
            active = false;
        },
        drawLive(c) {
            return trail.draw(c, ctx.px(4));
        },
    };
}
