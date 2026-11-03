import { drawElement, inkColor, penPath } from './render/draw';
import type { Element, Theme } from './types';

/**
 * What is happening right now but is not saved: strokes being drawn, shapes
 * being dragged, the laser and pointers. Local tools and remote peers share
 * these renderers.
 */

/** Points per frozen chunk of a stroke being drawn. */
const CHUNK = 64;
/** Points shared between a frozen chunk and the next, so joins don't show. */
const OVERLAP = 6;

/**
 * A pen stroke being drawn. Its outline is rebuilt only for the last few
 * dozen points each frame; older parts are frozen into cached paths, so a
 * long scribble costs the same per frame as a short one.
 */
export class LiveStroke {
    pts: number[] = [];
    pr: number[] = [];
    private frozen: Path2D[] = [];
    /** First point of the part still being rebuilt. */
    private tailStart = 0;
    updated = performance.now();

    constructor(
        readonly id: string,
        public color: string,
        public width: number,
        readonly withPressure: boolean,
    ) {}

    get length(): number {
        return this.pts.length / 2;
    }

    push(x: number, y: number, pressure = 128): void {
        this.pts.push(x, y);
        this.pr.push(pressure);
        this.updated = performance.now();
    }

    /** Applies points from the network, which say where they start. */
    setFrom(start: number, points: number[]): void {
        // A gap (lost batch) is bridged by a straight line, which the saved
        // stroke replaces moments later anyway.
        const from = Math.min(start, this.length);
        this.pts.length = from * 2;
        this.pr.length = from;
        for (let i = 0; i < points.length; i += 2) this.push(points[i], points[i + 1]);
        if (from < this.tailStart) {
            this.frozen = [];
            this.tailStart = 0;
        }
    }

    draw(ctx: CanvasRenderingContext2D, theme: Theme): void {
        const n = this.length;
        if (n === 0) return;
        ctx.fillStyle = inkColor(this.color, theme);
        for (const p of this.frozen) ctx.fill(p);
        const pr = this.withPressure ? this.pr : undefined;
        if (n - this.tailStart > CHUNK + OVERLAP) {
            const end = n - OVERLAP;
            this.frozen.push(
                new Path2D(
                    penPath(
                        this.pts.slice(this.tailStart * 2, end * 2),
                        pr?.slice(this.tailStart, end),
                        this.width,
                    ),
                ),
            );
            ctx.fill(this.frozen[this.frozen.length - 1]);
            this.tailStart = end - 1;
        }
        ctx.fill(
            new Path2D(
                penPath(this.pts.slice(this.tailStart * 2), pr?.slice(this.tailStart), this.width, false),
            ),
        );
    }
}

/** How long a laser trail stays visible, in ms. */
const LASER_FADE_MS = 1000;
export const LASER_COLOR = '#ff3b30';

/** A fading pointer trail. Flat [x, y, time, …]; NaN time separates strokes. */
export class LaserTrail {
    private trail: number[] = [];

    start(): void {
        if (this.trail.length > 0) this.trail.push(NaN, NaN, NaN);
    }

    push(x: number, y: number): void {
        this.trail.push(x, y, performance.now());
    }

    get active(): boolean {
        return this.trail.length > 0;
    }

    /** Returns true while anything is still fading. */
    draw(ctx: CanvasRenderingContext2D, width: number, color = LASER_COLOR): boolean {
        const now = performance.now();
        let start = 0;
        while (start < this.trail.length && !(now - this.trail[start + 2] < LASER_FADE_MS)) {
            start += 3;
        }
        if (start > 0) this.trail = this.trail.slice(start);
        const t = this.trail;
        if (t.length === 0) return false;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = color;
        for (let i = 3; i < t.length; i += 3) {
            if (Number.isNaN(t[i + 2]) || Number.isNaN(t[i - 1])) continue;
            const life = 1 - (now - t[i + 2]) / LASER_FADE_MS;
            ctx.globalAlpha = Math.max(0, life);
            ctx.lineWidth = width * (0.4 + 0.6 * life);
            ctx.beginPath();
            ctx.moveTo(t[i - 3], t[i - 2]);
            ctx.lineTo(t[i], t[i + 1]);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
        return true;
    }
}

export interface PeerInfo {
    name: string;
    color: string;
}

interface RemotePeer extends PeerInfo {
    strokes: Map<string, LiveStroke>;
    shape: Element | null;
    laser: LaserTrail;
    cursor: { x: number; y: number; at: number } | null;
}

/** A stroke nobody has updated for this long was abandoned (peer left). */
const STALE_STROKE_MS = 15_000;
/** A pointer that hasn't moved for this long is hidden. */
const CURSOR_IDLE_MS = 8_000;

/** Other people's live activity, drawn on the live layer. */
export class RemoteLayer {
    private peers = new Map<string, RemotePeer>();

    constructor(private invalidate: () => void) {}

    private peer(key: string): RemotePeer {
        let p = this.peers.get(key);
        if (!p) {
            p = {
                name: '',
                color: '#4c6ef5',
                strokes: new Map(),
                shape: null,
                laser: new LaserTrail(),
                cursor: null,
            };
            this.peers.set(key, p);
        }
        return p;
    }

    setPeer(key: string, info: PeerInfo): void {
        Object.assign(this.peer(key), info);
        this.invalidate();
    }

    removePeer(key: string): void {
        if (this.peers.delete(key)) this.invalidate();
    }

    clear(): void {
        this.peers.clear();
        this.invalidate();
    }

    stroke(key: string, id: string, color: string, width: number, start: number, points: number[]): void {
        const p = this.peer(key);
        let s = p.strokes.get(id);
        if (!s) {
            s = new LiveStroke(id, color, width, false);
            p.strokes.set(id, s);
        }
        s.setFrom(start, points);
        this.invalidate();
    }

    endStroke(key: string, id: string): void {
        if (this.peers.get(key)?.strokes.delete(id)) this.invalidate();
    }

    shape(key: string, el: Element | null): void {
        this.peer(key).shape = el;
        this.invalidate();
    }

    cursor(key: string, x: number, y: number, visible: boolean): void {
        this.peer(key).cursor = visible ? { x, y, at: performance.now() } : null;
        this.invalidate();
    }

    laser(key: string, points: number[], startNew: boolean): void {
        const trail = this.peer(key).laser;
        if (startNew) trail.start();
        for (let i = 0; i < points.length; i += 2) trail.push(points[i], points[i + 1]);
        this.invalidate();
    }

    /** Saved elements replace their live previews. */
    committed(ids: Iterable<string>): void {
        let changed = false;
        for (const id of ids) {
            for (const p of this.peers.values()) {
                if (p.strokes.delete(id)) changed = true;
                if (p.shape?.id === id) {
                    p.shape = null;
                    changed = true;
                }
            }
        }
        if (changed) this.invalidate();
    }

    /** Returns true while something animates (laser fading). */
    draw(ctx: CanvasRenderingContext2D, theme: Theme, zoom: number): boolean {
        const now = performance.now();
        let animating = false;
        for (const p of this.peers.values()) {
            for (const [id, s] of p.strokes) {
                if (now - s.updated > STALE_STROKE_MS) p.strokes.delete(id);
                else s.draw(ctx, theme);
            }
            if (p.shape) drawElement(ctx, p.shape, { theme });
            if (p.laser.active && p.laser.draw(ctx, 4 / zoom)) animating = true;
        }
        for (const p of this.peers.values()) {
            if (!p.cursor) continue;
            if (now - p.cursor.at > CURSOR_IDLE_MS) {
                p.cursor = null;
                continue;
            }
            drawCursor(ctx, p.cursor.x, p.cursor.y, zoom, p.name, p.color);
        }
        return animating;
    }
}

/** An arrow and a name tag, a constant size on screen whatever the zoom. */
function drawCursor(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    zoom: number,
    name: string,
    color: string,
): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1 / zoom, 1 / zoom);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 15);
    ctx.lineTo(4, 11.5);
    ctx.lineTo(7, 18);
    ctx.lineTo(9.5, 17);
    ctx.lineTo(6.5, 10.5);
    ctx.lineTo(11.5, 10.5);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    if (name) {
        ctx.font = '600 11px system-ui, sans-serif';
        const w = ctx.measureText(name).width + 10;
        ctx.fillStyle = color;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(10, 18, w, 17, 8);
        else ctx.rect(10, 18, w, 17);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.textBaseline = 'middle';
        ctx.fillText(name, 15, 27);
    }
    ctx.restore();
}
