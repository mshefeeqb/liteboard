import type { Camera, Point, Rect } from './types';

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** screen = (scene - camera) * zoom */
export function sceneToScreen(cam: Camera, p: Point): Point {
    return { x: (p.x - cam.x) * cam.zoom, y: (p.y - cam.y) * cam.zoom };
}

export function screenToScene(cam: Camera, p: Point): Point {
    return { x: p.x / cam.zoom + cam.x, y: p.y / cam.zoom + cam.y };
}

/** Moves the view by a distance in screen pixels. */
export function panBy(cam: Camera, dx: number, dy: number): Camera {
    return { ...cam, x: cam.x - dx / cam.zoom, y: cam.y - dy / cam.zoom };
}

/** Zooms while keeping the scene point under `screen` in place. */
export function zoomAt(cam: Camera, screen: Point, zoom: number): Camera {
    const z = clampZoom(zoom);
    const anchor = screenToScene(cam, screen);
    return { x: anchor.x - screen.x / z, y: anchor.y - screen.y / z, zoom: z };
}

/** The part of the scene that is on screen. */
export function viewportRect(cam: Camera, width: number, height: number): Rect {
    return { x: cam.x, y: cam.y, w: width / cam.zoom, h: height / cam.zoom };
}

/** A camera that shows `content` centred, never zooming in past 1. */
export function fitRect(
    content: Rect,
    width: number,
    height: number,
    padding = 40,
): Camera {
    const zoom = clampZoom(
        Math.min(
            1,
            (width - padding * 2) / Math.max(content.w, 1),
            (height - padding * 2) / Math.max(content.h, 1),
        ),
    );
    return {
        x: content.x + content.w / 2 - width / 2 / zoom,
        y: content.y + content.h / 2 - height / 2 / zoom,
        zoom,
    };
}
