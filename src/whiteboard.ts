import { clampZoom, fitRect, panBy, screenToScene, viewportRect, zoomAt } from './camera';
import { Emitter } from './emitter';
import { exportPNG, exportSVG, type ExportOptions } from './export';
import { decodeScene, encodeScene } from './model/codec';
import { elementBounds, nanoid, round1, unionRect } from './model/geometry';
import { History } from './model/history';
import { Store } from './model/store';
import { NOTE_SIZE, NOTE_TEXT } from './render/draw';
import { Renderer } from './render/renderer';
import { RemoteLayer } from './live';
import { TextEditor } from './text-editor';
import { eraserTool } from './tools/eraser';
import { handTool } from './tools/hand';
import { laserTool } from './tools/laser';
import { penTool } from './tools/pen';
import { selectTool } from './tools/select';
import { shapeTool } from './tools/shape';
import type { Tool, ToolContext, ToolPointer } from './tools/types';
import type {
    Camera,
    ChangeEvent,
    LiveEvent,
    Element,
    Point,
    Rect,
    Scene,
    Style,
    Theme,
    ToolName,
} from './types';

export const ALL_TOOLS: readonly ToolName[] = [
    'select',
    'hand',
    'pen',
    'line',
    'arrow',
    'rect',
    'ellipse',
    'text',
    'note',
    'eraser',
    'laser',
];

/** Tools that change nothing, so they stay available when read-only. */
const VIEW_TOOLS: ReadonlySet<ToolName> = new Set(['hand', 'laser']);

const SHORTCUTS: Record<string, ToolName> = {
    v: 'select',
    h: 'hand',
    p: 'pen',
    l: 'line',
    a: 'arrow',
    r: 'rect',
    o: 'ellipse',
    t: 'text',
    n: 'note',
    e: 'eraser',
    k: 'laser',
};

export interface Gestures {
    /** Two-finger pinch and ctrl/trackpad-pinch zoom. Default true. */
    pinchZoom?: boolean;
    /** Two-finger drag pans. Default true. */
    twoFingerPan?: boolean;
    /** What the mouse wheel does. Default 'pan'. */
    wheel?: 'pan' | 'zoom' | 'none';
}

export interface WhiteboardOptions {
    /** Identifies the board; passed back in events. */
    boardId?: string;
    /** Board to show, from `getScene()` or storage. */
    scene?: Scene | null;
    theme?: Theme;
    readOnly?: boolean;
    /** Tools offered, in toolbar order. Default: all. */
    tools?: readonly ToolName[];
    /** Starting tool. Default 'pen'. */
    tool?: ToolName;
    style?: Partial<Style>;
    /** Choosing the pen resets the stroke width to `style.strokeWidth`. */
    penResetsWidth?: boolean;
    gestures?: Gestures;
    /** Board colour. Default transparent, so host content can show beneath. */
    background?: string;
    /** Host element drawn under the strokes that pans and zooms with them. */
    underlay?: HTMLElement;
    fontFamily?: string;
    /**
     * Limit for canvas sharpness on high-density screens. Default 2 (1.5 on
     * devices with ≤ 2 GB memory). 1.5 cuts canvas memory by about 44% on a
     * Retina screen, with slightly softer lines.
     */
    maxPixelRatio?: number;
    /** Keyboard shortcuts while the board has focus. Default true. */
    keyboard?: boolean;
    /** Stable id for this client; generated when omitted. */
    clientId?: string;
}

export interface WhiteboardEvents {
    change: ChangeEvent;
    camera: Camera;
    tool: ToolName;
    style: Style;
    selection: string[];
    history: { canUndo: boolean; canRedo: boolean };
    load: { boardId: string | undefined };
    readOnly: boolean;
    theme: Theme;
    /** Unsaved activity (strokes being drawn, laser, pointer) to forward. */
    live: LiveEvent;
}

const DEFAULT_STYLE: Style = {
    color: '#1e1e1e',
    strokeWidth: 2,
    fontSize: 20,
    noteColor: '#ffec99',
};
const DOUBLE_TAP_MS = 350;

interface Gesture {
    startDist: number;
    startMid: Point;
    startCam: Camera;
}

export class Whiteboard {
    readonly store: Store;
    readonly history: History;
    /** The board's root element, inside the container. */
    readonly element: HTMLDivElement;
    /** Collaborators' live strokes, shapes, laser and pointers. */
    readonly remote: RemoteLayer;

    private renderer: Renderer;
    private editor: TextEditor;
    private events = new Emitter<WhiteboardEvents>();
    private tools = new Map<ToolName, Tool>();
    private toolName: ToolName;
    private toolList: ToolName[];
    private currentStyle: Style;
    private cam: Camera = { x: 0, y: 0, zoom: 1 };
    private selected = new Set<string>();
    private themeName: Theme;
    private readOnlyFlag: boolean;
    private boardIdValue: string | undefined;
    private gestures: Required<Gestures>;
    private underlay: HTMLElement | undefined;
    private resizeObserver: ResizeObserver;
    private cleanups: (() => void)[] = [];

    // Pointer state.
    private pointers = new Map<number, Point>();
    private toolPointer: number | null = null;
    private panPointer: { id: number; last: Point } | null = null;
    private gesture: Gesture | null = null;
    private penSeen = false;
    private lastPointerType = 'mouse';
    private spaceDown = false;
    private lastTap = { time: 0, x: 0, y: 0 };

    constructor(
        container: HTMLElement,
        private opts: WhiteboardOptions = {},
    ) {
        this.store = new Store(opts.clientId);
        this.history = new History(this.store);
        this.themeName = opts.theme ?? 'light';
        this.readOnlyFlag = opts.readOnly ?? false;
        this.boardIdValue = opts.boardId;
        this.currentStyle = { ...DEFAULT_STYLE, ...opts.style };
        this.gestures = { pinchZoom: true, twoFingerPan: true, wheel: 'pan', ...opts.gestures };
        this.toolList = (opts.tools ?? ALL_TOOLS).filter((t) => ALL_TOOLS.includes(t));
        if (this.toolList.length === 0) this.toolList = ['pen'];
        const initial = opts.tool ?? 'pen';
        this.toolName = this.toolList.includes(initial) ? initial : this.toolList[0];

        const root = document.createElement('div');
        root.className = 'lb-root';
        root.tabIndex = 0;
        root.style.cssText =
            'position:relative;width:100%;height:100%;overflow:hidden;outline:none;' +
            'touch-action:none;user-select:none;-webkit-user-select:none;' +
            '-webkit-tap-highlight-color:transparent;';
        this.element = root;

        if (opts.underlay) {
            this.underlay = opts.underlay;
            const u = opts.underlay.style;
            u.position = 'absolute';
            u.left = '0';
            u.top = '0';
            u.transformOrigin = '0 0';
            u.willChange = 'transform';
            root.appendChild(opts.underlay);
        }

        this.remote = new RemoteLayer(() => this.renderer.invalidate());
        this.renderer = new Renderer({
            getElements: () => this.store.elements(),
            drawLive: (ctx) => {
                const remote = this.remote.draw(ctx, this.themeName, this.cam.zoom);
                const local = this.tool.drawLive?.(ctx) ?? false;
                return remote || local;
            },
            fontFamily: opts.fontFamily,
            maxPixelRatio: opts.maxPixelRatio,
        });
        this.renderer.theme = this.themeName;
        this.renderer.background = opts.background;
        root.appendChild(this.renderer.staticCanvas);
        root.appendChild(this.renderer.liveCanvas);
        container.appendChild(root);

        this.editor = new TextEditor({
            root,
            history: this.history,
            camera: () => this.cam,
            style: () => this.currentStyle,
            theme: () => this.themeName,
            fontFamily: opts.fontFamily,
            hide: (id) => {
                if (id) this.renderer.hidden.add(id);
                else this.renderer.hidden.clear();
                this.renderer.invalidate(true);
            },
        });

        const ctx = this.toolContext();
        this.tools.set('select', selectTool(ctx));
        this.tools.set('hand', handTool(ctx));
        this.tools.set('pen', penTool(ctx));
        this.tools.set('eraser', eraserTool(ctx));
        this.tools.set('laser', laserTool(ctx));
        for (const t of ['line', 'arrow', 'rect', 'ellipse'] as const) {
            this.tools.set(t, shapeTool(ctx, t));
        }
        // Text is placed by tapping; the editor does the work.
        this.tools.set('text', {
            cursor: 'text',
            down() {},
            move() {},
            up: (p) => this.editTextAt(p),
            cancel() {},
        });
        // Tapping empty space adds a note and opens it for typing; tapping a
        // note edits it.
        this.tools.set('note', {
            cursor: 'copy',
            down() {},
            move() {},
            up: (p) => this.placeNote(p),
            cancel() {},
        });

        this.store.on((e) => {
            if (e.origin !== 'local') this.pruneSelection();
            if (e.origin === 'remote') this.remote.committed(e.elements.map((el) => el.id));
            this.renderer.invalidate(true);
            this.events.emit('change', e);
        });
        this.history.onChange(() =>
            this.events.emit('history', {
                canUndo: this.history.canUndo,
                canRedo: this.history.canRedo,
            }),
        );

        this.bindInput();
        this.resizeObserver = new ResizeObserver(() => this.measure());
        this.resizeObserver.observe(root);
        this.measure();
        this.updateCursor();
        this.applyCamera();
        if (opts.scene) this.store.merge(decodeScene(opts.scene), 'load');
    }

    // ---- Public API ------------------------------------------------------------

    get boardId(): string | undefined {
        return this.boardIdValue;
    }

    get tool(): Tool {
        return this.tools.get(this.toolName)!;
    }

    get toolId(): ToolName {
        return this.toolName;
    }

    get availableTools(): readonly ToolName[] {
        return this.toolList;
    }

    setTool(name: ToolName): void {
        if (!this.toolList.includes(name) || name === this.toolName) return;
        if (this.readOnlyFlag && !VIEW_TOOLS.has(name)) return;
        this.editor.commit();
        this.cancelToolAction();
        this.tool.deactivate?.();
        this.toolName = name;
        if (name !== 'select') this.setSelection([]);
        if (name === 'pen' && this.opts.penResetsWidth) {
            const width = this.opts.style?.strokeWidth ?? DEFAULT_STYLE.strokeWidth;
            if (this.currentStyle.strokeWidth !== width) this.setStyle({ strokeWidth: width });
        }
        this.updateCursor();
        this.renderer.invalidate();
        this.events.emit('tool', name);
    }

    get style(): Style {
        return this.currentStyle;
    }

    /** Changes the drawing style, and restyles the selection. */
    setStyle(patch: Partial<Style>): void {
        this.currentStyle = { ...this.currentStyle, ...patch };
        if (this.selected.size > 0 && !this.readOnlyFlag) {
            const updates: Element[] = [];
            for (const id of this.selected) {
                const el = this.store.get(id);
                if (!el || el.del) continue;
                const next = { ...el };
                if (el.t === 'note') {
                    if (patch.noteColor === undefined) continue;
                    next.fill = patch.noteColor;
                    updates.push(next);
                    continue;
                }
                if (patch.color !== undefined) next.c = patch.color;
                if (patch.strokeWidth !== undefined && el.t !== 'text') next.sw = patch.strokeWidth;
                if ('fill' in patch && (el.t === 'rect' || el.t === 'ellipse')) {
                    if (patch.fill) next.fill = patch.fill;
                    else delete next.fill;
                }
                updates.push(next);
            }
            if (updates.length > 0) this.history.commit(updates);
        }
        this.events.emit('style', this.currentStyle);
    }

    get theme(): Theme {
        return this.themeName;
    }

    setTheme(theme: Theme): void {
        if (theme === this.themeName) return;
        this.themeName = theme;
        this.renderer.theme = theme;
        this.renderer.invalidate(true);
        this.editor.layout();
        this.events.emit('theme', theme);
    }

    get readOnly(): boolean {
        return this.readOnlyFlag;
    }

    setReadOnly(readOnly: boolean): void {
        if (readOnly === this.readOnlyFlag) return;
        this.readOnlyFlag = readOnly;
        if (readOnly) {
            this.editor.commit();
            this.setSelection([]);
            if (!VIEW_TOOLS.has(this.toolName)) {
                this.cancelToolAction();
                const fallback = this.toolList.find((t) => VIEW_TOOLS.has(t));
                if (fallback) this.setTool(fallback);
            }
        }
        this.events.emit('readOnly', readOnly);
    }

    undo(): void {
        if (this.readOnlyFlag) return;
        this.editor.commit();
        this.history.undo();
    }

    redo(): void {
        if (this.readOnlyFlag) return;
        this.editor.commit();
        this.history.redo();
    }

    get canUndo(): boolean {
        return this.history.canUndo;
    }

    get canRedo(): boolean {
        return this.history.canRedo;
    }

    get selection(): string[] {
        return [...this.selected];
    }

    setSelection(ids: Iterable<string>): void {
        const next = new Set(ids);
        if (next.size === this.selected.size && [...next].every((id) => this.selected.has(id))) {
            return;
        }
        this.selected = next;
        this.renderer.invalidate();
        this.events.emit('selection', [...next]);
    }

    selectAll(): void {
        this.setTool('select');
        this.setSelection(this.store.elements().map((e) => e.id));
    }

    deleteSelected(): void {
        if (this.readOnlyFlag || this.selected.size === 0) return;
        this.history.commit([], [...this.selected]);
        this.setSelection([]);
    }

    /** Deletes everything, as one undoable step. */
    clear(): void {
        if (this.readOnlyFlag) return;
        this.editor.commit();
        this.history.commit(
            [],
            this.store.elements().map((e) => e.id),
        );
        this.setSelection([]);
    }

    /** Visible elements, bottom to top. */
    getElements(): readonly Element[] {
        return this.store.elements();
    }

    /** The whole board (including deletions) in the compact storage format. */
    getScene(): Scene {
        return encodeScene(this.store.allRecords());
    }

    /**
     * Switches to another board: saves any open text, then replaces
     * everything. Undo history and selection belong to the old board.
     */
    load(boardId: string | undefined, scene?: Scene | null): void {
        this.editor.commit();
        this.cancelToolAction();
        this.store.reset();
        this.remote.clear();
        this.history.clear();
        this.selected.clear();
        this.boardIdValue = boardId;
        this.setCamera({ x: 0, y: 0, zoom: this.cam.zoom });
        if (scene) this.store.merge(decodeScene(scene), 'load');
        this.renderer.invalidate(true);
        this.events.emit('load', { boardId });
    }

    /** Merges elements from another client; returns those that changed. */
    merge(elements: Iterable<Element>): Element[] {
        return this.store.merge(elements, 'remote');
    }

    get camera(): Camera {
        return this.cam;
    }

    setCamera(camera: Camera): void {
        this.cam = { ...camera };
        this.applyCamera();
        this.events.emit('camera', this.cam);
    }

    /** Zooms around the board's centre (or a screen point). */
    zoomTo(zoom: number, around?: Point): void {
        const center = around ?? { x: this.renderer.width / 2, y: this.renderer.height / 2 };
        this.setCamera(zoomAt(this.cam, center, zoom));
    }

    /** Fits the whole drawing on screen. */
    zoomToContent(): void {
        const box = unionRect(this.store.elements().map(elementBounds));
        if (!box) {
            this.setCamera({ x: 0, y: 0, zoom: 1 });
            return;
        }
        this.setCamera(fitRect(box, this.renderer.width, this.renderer.height));
    }

    /** The part of the scene on screen. */
    get viewport(): Rect {
        return viewportRect(this.cam, this.renderer.width, this.renderer.height);
    }

    screenToScene(p: Point): Point {
        return screenToScene(this.cam, p);
    }

    async exportPNG(opts: ExportOptions & { region?: Rect | 'viewport' } = {}): Promise<Blob> {
        return exportPNG(this.store.elements(), this.exportOptions(opts));
    }

    exportSVG(opts: ExportOptions & { region?: Rect | 'viewport' } = {}): string {
        return exportSVG(this.store.elements(), this.exportOptions(opts));
    }

    on<K extends keyof WhiteboardEvents>(
        event: K,
        handler: (payload: WhiteboardEvents[K]) => void,
    ): () => void {
        return this.events.on(event, handler);
    }

    /** Saves open text, then removes the board and every listener. */
    destroy(): void {
        this.editor.commit();
        this.resizeObserver.disconnect();
        this.cleanups.forEach((fn) => fn());
        this.cleanups = [];
        this.renderer.destroy();
        this.events.clear();
        this.element.remove();
    }

    // ---- Internals ---------------------------------------------------------------

    private exportOptions(opts: ExportOptions & { region?: Rect | 'viewport' }): ExportOptions {
        return {
            fontFamily: this.opts.fontFamily,
            ...opts,
            region: opts.region === 'viewport' ? this.viewport : opts.region,
        };
    }

    private toolContext(): ToolContext {
        // Getters, so tools always see the current values.
        const wb = this;
        return {
            store: this.store,
            history: this.history,
            get style() {
                return wb.currentStyle;
            },
            get camera() {
                return wb.cam;
            },
            get theme() {
                return wb.themeName;
            },
            fontFamily: this.opts.fontFamily,
            get pointerType() {
                return wb.lastPointerType;
            },
            get selection() {
                return wb.selected;
            },
            setSelection: (ids) => this.setSelection(ids),
            hide: (ids) => {
                for (const id of ids) this.renderer.hidden.add(id);
                this.renderer.invalidate(true);
            },
            unhide: () => {
                this.renderer.hidden.clear();
                this.renderer.invalidate(true);
            },
            setCamera: (c) => this.setCamera(c),
            editText: (el, at) => {
                if (!this.readOnlyFlag) this.editor.open(el, at);
            },
            invalidate: (staticToo) => this.renderer.invalidate(staticToo),
            emitLive: (e) => this.events.emit('live', e),
            px: (n) => n / this.cam.zoom,
        };
    }

    private placeNote(p: Point): void {
        const els = this.store.elements();
        for (let i = els.length - 1; i >= 0; i--) {
            const el = els[i];
            if (el.t === 'note' && p.x >= el.x && p.x <= el.x + el.w && p.y >= el.y && p.y <= el.y + el.h) {
                this.editor.open(el);
                return;
            }
        }
        const [note] = this.history.commit([
            {
                id: nanoid(),
                t: 'note',
                x: round1(p.x - NOTE_SIZE / 2),
                y: round1(p.y - NOTE_SIZE / 2),
                w: NOTE_SIZE,
                h: NOTE_SIZE,
                fill: this.currentStyle.noteColor,
                txt: '',
                fs: this.currentStyle.fontSize,
                c: NOTE_TEXT,
                sw: 1,
            },
        ]);
        this.editor.open(note);
    }

    private editTextAt(p: Point): void {
        const hit = this.store
            .elements()
            .filter((el) => el.t === 'text')
            .reverse()
            .find((el) => p.x >= el.x && p.x <= el.x + el.w && p.y >= el.y && p.y <= el.y + el.h);
        this.editor.open(hit ?? null, p);
    }

    private pruneSelection(): void {
        const alive = [...this.selected].filter((id) => {
            const el = this.store.get(id);
            return el && !el.del;
        });
        if (alive.length !== this.selected.size) this.setSelection(alive);
    }

    private measure(): void {
        const r = this.element.getBoundingClientRect();
        this.renderer.resize(r.width, r.height);
    }

    private applyCamera(): void {
        this.renderer.setCamera(this.cam);
        if (this.underlay) {
            const { x, y, zoom } = this.cam;
            this.underlay.style.transform = `translate(${-x * zoom}px, ${-y * zoom}px) scale(${zoom})`;
        }
        this.editor.layout();
    }

    private updateCursor(): void {
        this.renderer.liveCanvas.style.cursor = this.spaceDown ? 'grab' : this.tool.cursor;
    }

    private cancelToolAction(): void {
        if (this.toolPointer !== null) {
            this.tool.cancel();
            this.toolPointer = null;
        }
    }

    private toolPointerFrom(e: PointerEvent): ToolPointer {
        const r = this.element.getBoundingClientRect();
        const sx = e.clientX - r.left;
        const sy = e.clientY - r.top;
        const p = screenToScene(this.cam, { x: sx, y: sy });
        return {
            x: p.x,
            y: p.y,
            sx,
            sy,
            pressure: e.pressure,
            pointerType: e.pointerType,
            shiftKey: e.shiftKey,
        };
    }

    private screenPoint(e: { clientX: number; clientY: number }): Point {
        const r = this.element.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    private listen<K extends keyof HTMLElementEventMap>(
        target: HTMLElement | Window,
        type: K,
        handler: (e: HTMLElementEventMap[K]) => void,
        options?: AddEventListenerOptions,
    ): void {
        target.addEventListener(type, handler as EventListener, options);
        this.cleanups.push(() =>
            target.removeEventListener(type, handler as EventListener, options),
        );
    }

    private bindInput(): void {
        const canvas = this.renderer.liveCanvas;
        this.listen(canvas, 'pointerdown', this.onPointerDown);
        this.listen(canvas, 'pointermove', this.onPointerMove);
        this.listen(canvas, 'pointerup', this.onPointerUp);
        this.listen(canvas, 'pointercancel', this.onPointerUp);
        this.listen(canvas, 'pointerleave', () => {
            if (this.toolPointer === null) this.tool.deactivate?.();
            this.events.emit('live', { kind: 'pointer', x: 0, y: 0, visible: false });
        });
        this.listen(this.element, 'wheel', this.onWheel, { passive: false });
        this.listen(this.element, 'keydown', this.onKeyDown);
        this.listen(this.element, 'keyup', (e) => {
            if (e.key === ' ') {
                this.spaceDown = false;
                this.updateCursor();
            }
        });
        // Safari's own pinch gesture events would zoom the page.
        this.listen(this.element, 'gesturestart' as keyof HTMLElementEventMap, (e) =>
            e.preventDefault(),
        );
        this.listen(this.element, 'contextmenu', (e) => e.preventDefault());
    }

    private onPointerDown = (e: PointerEvent) => {
        if (this.editor.isOpen) {
            // A tap outside the text box just closes it.
            this.editor.commit();
            if (this.toolName === 'text' || this.toolName === 'select') return;
        }
        e.preventDefault();
        this.element.focus({ preventScroll: true });
        try {
            this.renderer.liveCanvas.setPointerCapture(e.pointerId);
        } catch {
            // Some browsers refuse capture for a pointer that is already gone.
        }
        this.lastPointerType = e.pointerType;
        const screen = this.screenPoint(e);
        this.pointers.set(e.pointerId, screen);
        if (e.pointerType === 'pen') this.penSeen = true;

        const isTouch = e.pointerType === 'touch';
        if (isTouch && this.pointers.size === 2) {
            const { pinchZoom, twoFingerPan } = this.gestures;
            if (!pinchZoom && !twoFingerPan) return;
            this.cancelToolAction();
            this.panPointer = null;
            this.startGesture();
            return;
        }
        if (this.gesture || this.pointers.size > 2) return;

        const wantsPan =
            e.button === 1 ||
            this.spaceDown ||
            // Palm rejection: once a pen is in use, fingers only pan.
            (isTouch && this.penSeen) ||
            (this.readOnlyFlag && !VIEW_TOOLS.has(this.toolName));
        if (wantsPan) {
            this.panPointer = { id: e.pointerId, last: screen };
            return;
        }
        if (e.button !== 0 && e.button !== -1) return;
        if (this.toolPointer !== null) return;

        const p = this.toolPointerFrom(e);
        const now = performance.now();
        const isDouble =
            now - this.lastTap.time < DOUBLE_TAP_MS &&
            Math.abs(screen.x - this.lastTap.x) < 12 &&
            Math.abs(screen.y - this.lastTap.y) < 12;
        this.lastTap = isDouble ? { time: 0, x: 0, y: 0 } : { time: now, ...screen };
        if (isDouble && this.tool.doubleClick && !this.readOnlyFlag) {
            this.tool.doubleClick(p);
            return;
        }
        this.toolPointer = e.pointerId;
        this.tool.down(p);
    };

    private onPointerMove = (e: PointerEvent) => {
        if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, this.screenPoint(e));

        if (this.gesture) {
            this.updateGesture();
            return;
        }
        if (e.isPrimary) {
            const at = screenToScene(this.cam, this.screenPoint(e));
            this.events.emit('live', { kind: 'pointer', x: at.x, y: at.y, visible: true });
        }
        if (this.panPointer?.id === e.pointerId) {
            const p = this.screenPoint(e);
            this.setCamera(panBy(this.cam, p.x - this.panPointer.last.x, p.y - this.panPointer.last.y));
            this.panPointer.last = p;
            return;
        }
        if (e.pointerId === this.toolPointer) {
            // Coalesced events carry every sample since the last frame, which
            // keeps fast handwriting smooth on 60 Hz event delivery.
            const samples = e.getCoalescedEvents?.() ?? [];
            for (const s of samples.length > 0 ? samples : [e]) {
                this.tool.move(this.toolPointerFrom(s));
            }
            return;
        }
        if (e.pointerType === 'mouse' && e.buttons === 0 && this.tool.hover) {
            this.lastPointerType = 'mouse';
            const cursor = this.tool.hover(this.toolPointerFrom(e));
            this.renderer.liveCanvas.style.cursor = cursor ?? this.tool.cursor;
        }
    };

    private onPointerUp = (e: PointerEvent) => {
        this.pointers.delete(e.pointerId);
        if (this.gesture) {
            if (this.pointers.size < 2) this.gesture = null;
            return;
        }
        if (this.panPointer?.id === e.pointerId) {
            this.panPointer = null;
            return;
        }
        if (e.pointerId === this.toolPointer) {
            this.toolPointer = null;
            if (e.type === 'pointercancel') this.tool.cancel();
            else this.tool.up(this.toolPointerFrom(e));
        }
    };

    private twoTouches(): { mid: Point; dist: number } {
        const [a, b] = [...this.pointers.values()];
        return {
            mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
            dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        };
    }

    private startGesture(): void {
        const { mid, dist } = this.twoTouches();
        this.gesture = { startDist: dist, startMid: mid, startCam: this.cam };
    }

    private updateGesture(): void {
        const g = this.gesture!;
        if (this.pointers.size < 2) return;
        const { mid, dist } = this.twoTouches();
        const zoom = this.gestures.pinchZoom
            ? clampZoom(g.startCam.zoom * (dist / g.startDist))
            : g.startCam.zoom;
        const target = this.gestures.twoFingerPan ? mid : g.startMid;
        // The scene point that was under the fingers stays under them.
        const anchor = screenToScene(g.startCam, g.startMid);
        this.setCamera({ x: anchor.x - target.x / zoom, y: anchor.y - target.y / zoom, zoom });
    }

    private onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const p = this.screenPoint(e);
        // Trackpad pinch arrives as a wheel event with ctrlKey set.
        const zoomGesture = e.ctrlKey || e.metaKey;
        if (zoomGesture ? this.gestures.pinchZoom : this.gestures.wheel === 'zoom') {
            const factor = Math.exp(-e.deltaY * (zoomGesture ? 0.01 : 0.002));
            this.setCamera(zoomAt(this.cam, p, this.cam.zoom * factor));
        } else if (!zoomGesture && this.gestures.wheel === 'pan') {
            const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
            const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
            this.setCamera(panBy(this.cam, -dx, -dy));
        }
    };

    private onKeyDown = (e: KeyboardEvent) => {
        if (this.opts.keyboard === false) return;
        const mod = e.metaKey || e.ctrlKey;
        const key = e.key.toLowerCase();

        if (e.key === ' ' && !this.spaceDown) {
            this.spaceDown = true;
            this.updateCursor();
            e.preventDefault();
            return;
        }
        if (mod && key === 'z') {
            e.preventDefault();
            if (e.shiftKey) this.redo();
            else this.undo();
            return;
        }
        if (mod && key === 'y') {
            e.preventDefault();
            this.redo();
            return;
        }
        if (mod && key === 'a') {
            e.preventDefault();
            this.selectAll();
            return;
        }
        if (e.key === 'Escape') {
            this.cancelToolAction();
            this.setSelection([]);
            return;
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected.size > 0) {
            e.preventDefault();
            this.deleteSelected();
            return;
        }
        if (!this.readOnlyFlag && this.tool.keyDown?.(e)) {
            e.preventDefault();
            return;
        }
        if (!mod && !e.altKey && SHORTCUTS[key]) {
            this.setTool(SHORTCUTS[key]);
        }
    };
}

export function createWhiteboard(container: HTMLElement, options?: WhiteboardOptions): Whiteboard {
    return new Whiteboard(container, options);
}
