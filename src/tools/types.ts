import type { History } from '../model/history';
import type { Store } from '../model/store';
import type { Camera, Element, LiveEvent, Point, Style, Theme } from '../types';

/** A pointer event in scene coordinates, as tools see it. */
export interface ToolPointer extends Point {
    /** Screen position inside the board, for tools that work in pixels. */
    sx: number;
    sy: number;
    pressure: number;
    pointerType: string;
    shiftKey: boolean;
}

/** What the whiteboard gives a tool to work with. */
export interface ToolContext {
    readonly store: Store;
    readonly history: History;
    readonly style: Style;
    readonly camera: Camera;
    readonly theme: Theme;
    readonly fontFamily: string | undefined;
    /** Last pointer type, for touch-sized hit areas. */
    readonly pointerType: string;
    selection: ReadonlySet<string>;
    setSelection(ids: Iterable<string>): void;
    /** Hides elements from the static layer while a tool previews them. */
    hide(ids: Iterable<string>): void;
    unhide(): void;
    setCamera(camera: Camera): void;
    /** Opens the text editor on an element, or a new one at `at`. */
    editText(el: Element | null, at?: Point): void;
    invalidate(staticToo?: boolean): void;
    /** Reports unsaved activity for collaborators to see. */
    emitLive(event: LiveEvent): void;
    /** Screen pixels in scene units at the current zoom. */
    px(n: number): number;
}

export interface Tool {
    cursor: string;
    down(p: ToolPointer): void;
    move(p: ToolPointer): void;
    up(p: ToolPointer): void;
    /** Abandons the current action (second finger landed, pointer cancelled). */
    cancel(): void;
    /** Draws previews on the live layer; returns true while animating. */
    drawLive?(ctx: CanvasRenderingContext2D): boolean;
    /** Cursor for a hovering mouse. */
    hover?(p: Point): string | undefined;
    doubleClick?(p: ToolPointer): void;
    /** Returns true when the key was handled. */
    keyDown?(e: KeyboardEvent): boolean;
    deactivate?(): void;
}

/** A complete element for previews, which never reach the store. */
export function previewElement(el: Omit<Element, 'z' | 'v' | 'by'>): Element {
    return { ...el, z: 0, v: 0, by: '' };
}
