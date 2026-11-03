import { panBy } from '../camera';
import type { Tool, ToolContext } from './types';

export function handTool(ctx: ToolContext): Tool {
    let last: { x: number; y: number } | null = null;
    return {
        cursor: 'grab',
        down(p) {
            last = { x: p.sx, y: p.sy };
        },
        move(p) {
            if (!last) return;
            ctx.setCamera(panBy(ctx.camera, p.sx - last.x, p.sy - last.y));
            last = { x: p.sx, y: p.sy };
        },
        up() {
            last = null;
        },
        cancel() {
            last = null;
        },
    };
}
