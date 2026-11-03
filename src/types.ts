export type ElementType = 'pen' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'note';

/**
 * One drawn object. Short keys keep the wire and storage format small; the
 * same shape is used in memory, so there is no conversion layer.
 *
 * Geometry is relative to (x, y): moving an element changes only x and y,
 * so the cached path of a pen stroke survives a move.
 */
export interface Element {
    id: string;
    t: ElementType;
    /** Top-left of the bounding box, in scene units. */
    x: number;
    y: number;
    /** Bounding box size, in scene units. */
    w: number;
    h: number;
    /** pen, line, arrow: flat [x0, y0, x1, y1, …] relative to (x, y). */
    pts?: number[];
    /** pen only: pressure per point, 0–255. Absent when the device has none. */
    pr?: number[];
    /** Stroke colour. */
    c: string;
    /** Stroke width, in scene units. */
    sw: number;
    /** rect, ellipse: fill colour. note: paper colour (always set). */
    fill?: string;
    /** text, note: content and font size. */
    txt?: string;
    fs?: number;
    /** Creation order: (z, id) sorts elements bottom to top. */
    z: number;
    /** Lamport clock of the last change. */
    v: number;
    /** Client that made the last change; breaks ties between equal clocks. */
    by: string;
    /** Tombstone: deleted elements stay so a late edit cannot revive them. */
    del?: 1;
}

/** An element as the caller describes it; the store fills in the bookkeeping. */
export type ElementInit = Omit<Element, 'v' | 'by' | 'z' | 'id'> & {
    id?: string;
    z?: number;
};

export type ToolName =
    | 'select'
    | 'hand'
    | 'pen'
    | 'line'
    | 'arrow'
    | 'rect'
    | 'ellipse'
    | 'text'
    | 'note'
    | 'eraser'
    | 'laser';

export type Theme = 'light' | 'dark';

export interface Style {
    color: string;
    strokeWidth: number;
    fontSize: number;
    /** Fill for rect and ellipse; undefined draws an outline. */
    fill?: string;
    /** Paper colour for sticky notes. */
    noteColor: string;
}

export interface Camera {
    /** Scene coordinate shown at the top-left corner of the board. */
    x: number;
    y: number;
    zoom: number;
}

export interface Point {
    x: number;
    y: number;
}

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Serialized board: elements with delta-encoded points. */
export interface Scene {
    v: 1;
    els: Element[];
}

export type ChangeOrigin = 'local' | 'remote' | 'load';

export interface ChangeEvent {
    /** Elements as they are now, including tombstones of deleted ones. */
    elements: Element[];
    origin: ChangeOrigin;
}

/**
 * Unsaved activity a sync client can forward: points of a stroke being drawn,
 * a shape being dragged, the laser, and the pointer. Coordinates are scene
 * units.
 */
export type LiveEvent =
    | { kind: 'stroke'; id: string; color: string; width: number; index: number; x: number; y: number }
    | { kind: 'strokeEnd'; id: string }
    | { kind: 'shape'; el: Element | null }
    | { kind: 'laser'; x: number; y: number; start: boolean }
    | { kind: 'pointer'; x: number; y: number; visible: boolean };
