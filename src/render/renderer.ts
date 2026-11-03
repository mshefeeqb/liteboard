import { viewportRect } from '../camera';
import { elementBounds, intersects } from '../model/geometry';
import type { Camera, Element, Theme } from '../types';
import { drawElement } from './draw';

export interface RendererOptions {
    getElements: () => readonly Element[];
    /** Draws previews on the live layer; returns true to keep animating. */
    drawLive: (ctx: CanvasRenderingContext2D) => boolean;
    fontFamily?: string;
    /** Upper limit for canvas pixels per CSS pixel. */
    maxPixelRatio?: number;
}

/** A static redraw slower than this (ms) makes panning use the old bitmap. */
const SLOW_DRAW_MS = 8;
/** How long the camera must rest before a slow board is redrawn. */
const SETTLE_MS = 120;
/** While moving, a slow board still refreshes this often to fill in edges. */
const REFRESH_MS = 250;

/**
 * Canvas memory is width × height × ratio² × 4 bytes per layer, so the ratio
 * dominates: a 1440×800 board is 4.6 MB per layer at 1×, 18 MB at 2×.
 */
function pixelRatio(max: number | undefined): number {
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    // Low-end tablets have neither the memory nor the fill rate to spare,
    // and above 2× the difference is invisible.
    const cap = max ?? (memory !== undefined && memory <= 2 ? 1.5 : 2);
    return Math.max(1, Math.min(window.devicePixelRatio || 1, cap));
}

function makeCanvas(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.style.cssText =
        'position:absolute;inset:0;width:100%;height:100%;transform-origin:0 0;';
    return c;
}

/**
 * Two stacked canvases. The static layer holds committed elements and is
 * only redrawn when they or the camera change. The live layer holds what is
 * being drawn right now (local and remote strokes, selection, laser) and is
 * cheap to redraw every frame.
 */
export class Renderer {
    readonly staticCanvas = makeCanvas();
    readonly liveCanvas = makeCanvas();
    width = 0;
    height = 0;
    camera: Camera = { x: 0, y: 0, zoom: 1 };
    theme: Theme = 'light';
    background: string | undefined;
    /** Elements drawn on the live layer instead (being moved, erased, edited). */
    readonly hidden = new Set<string>();

    private dpr = 1;
    /** Camera the static layer was last drawn with. */
    private drawnCamera: Camera = { x: 0, y: 0, zoom: 1 };
    /** Smoothed cost of a static redraw, in ms. */
    private staticCost = 0;
    private lastStaticDraw = 0;
    private settleTimer = 0;
    private staticDirty = true;
    private liveDirty = true;
    private frame = 0;
    private sctx: CanvasRenderingContext2D;
    private lctx: CanvasRenderingContext2D;

    constructor(private opts: RendererOptions) {
        this.sctx = this.staticCanvas.getContext('2d')!;
        // Not `desynchronized`: mobile Chrome shows such a canvas as a
        // hardware overlay without transparency, which turns this layer
        // solid black and hides everything under it.
        this.lctx = this.liveCanvas.getContext('2d')!;
    }

    resize(width: number, height: number): void {
        this.dpr = pixelRatio(this.opts.maxPixelRatio);
        this.width = width;
        this.height = height;
        for (const c of [this.staticCanvas, this.liveCanvas]) {
            c.width = Math.max(1, Math.round(width * this.dpr));
            c.height = Math.max(1, Math.round(height * this.dpr));
        }
        this.invalidate(true);
    }

    /**
     * Moves the view. When redrawing every stroke is cheap it happens each
     * frame. On a slow device the last drawing slides and scales with a CSS
     * transform (done by the GPU, nearly free) and is redrawn once the camera
     * rests, so panning a busy board stays smooth.
     */
    setCamera(camera: Camera): void {
        this.camera = camera;
        const sinceDraw = performance.now() - this.lastStaticDraw;
        if (this.staticCost < SLOW_DRAW_MS || sinceDraw > REFRESH_MS) {
            this.invalidate(true);
            return;
        }
        const d = this.drawnCamera;
        const z = camera.zoom;
        this.staticCanvas.style.transform =
            `translate(${(d.x - camera.x) * z}px, ${(d.y - camera.y) * z}px) scale(${z / d.zoom})`;
        this.invalidate();
        clearTimeout(this.settleTimer);
        this.settleTimer = window.setTimeout(() => this.invalidate(true), SETTLE_MS);
    }

    /** Schedules a redraw of the live layer, and of the static one if asked. */
    invalidate(staticToo = false): void {
        if (staticToo) this.staticDirty = true;
        this.liveDirty = true;
        if (!this.frame) this.frame = requestAnimationFrame(this.draw);
    }

    destroy(): void {
        clearTimeout(this.settleTimer);
        cancelAnimationFrame(this.frame);
        this.frame = 0;
    }

    private applyCamera(ctx: CanvasRenderingContext2D): void {
        const { x, y, zoom } = this.camera;
        const s = this.dpr * zoom;
        ctx.setTransform(s, 0, 0, s, -x * s, -y * s);
    }

    private draw = () => {
        this.frame = 0;
        if (this.staticDirty) {
            this.staticDirty = false;
            this.drawStatic();
        }
        if (this.liveDirty) {
            this.liveDirty = false;
            const ctx = this.lctx;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, this.liveCanvas.width, this.liveCanvas.height);
            this.applyCamera(ctx);
            if (this.opts.drawLive(ctx)) this.invalidate();
        }
    };

    private drawStatic(): void {
        const start = performance.now();
        clearTimeout(this.settleTimer);
        this.staticCanvas.style.transform = '';
        this.drawnCamera = this.camera;
        const ctx = this.sctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.staticCanvas.width, this.staticCanvas.height);
        if (this.background) {
            ctx.fillStyle = this.background;
            ctx.fillRect(0, 0, this.staticCanvas.width, this.staticCanvas.height);
        }
        this.applyCamera(ctx);
        const view = viewportRect(this.camera, this.width, this.height);
        const opts = { theme: this.theme, fontFamily: this.opts.fontFamily };
        for (const el of this.opts.getElements()) {
            if (this.hidden.has(el.id) || !intersects(elementBounds(el), view)) continue;
            drawElement(ctx, el, opts);
        }
        this.lastStaticDraw = performance.now();
        this.staticCost = this.staticCost * 0.7 + (this.lastStaticDraw - start) * 0.3;
    }
}
