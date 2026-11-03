import { describe, expect, it } from 'vitest';
import { decodeElement, decodePoints, decodeScene, encodePoints, encodeScene } from '../src/model/codec';
import {
    hitTest,
    relativePoints,
    scaleElement,
    simplify,
} from '../src/model/geometry';
import { History } from '../src/model/history';
import { Store } from '../src/model/store';
import { fromExcalidraw } from '../src/excalidraw';
import { fitRect, screenToScene, sceneToScreen, zoomAt } from '../src/camera';
import type { Element, ElementInit } from '../src/types';

const pen = (id: string, pts: number[]): ElementInit & { id: string } => ({
    id,
    t: 'pen',
    ...relativePoints(pts),
    c: '#1e1e1e',
    sw: 2,
});

describe('codec', () => {
    it('round-trips points at 0.1 precision', () => {
        const pts = [412.3, 98.7, 413.1, 99.2, 420, 101.55];
        const back = decodePoints(encodePoints(pts));
        back.forEach((v, i) => expect(v).toBeCloseTo(pts[i], 1));
        expect(encodePoints([412.3, 98.7, 413.1, 99.2])).toEqual([4123, 987, 8, 5]);
    });

    it('round-trips a scene', () => {
        const store = new Store('a');
        store.write(pen('p1', [0, 0, 10, 5, 20, 0]));
        store.write({ id: 'r1', t: 'rect', x: 1, y: 2, w: 3, h: 4, c: '#000', sw: 1 });
        const json = JSON.parse(JSON.stringify(encodeScene(store.allRecords())));
        const els = decodeScene(json);
        expect(els).toHaveLength(2);
        expect(els[0].pts).toEqual(store.get('p1')!.pts);
    });

    it('rejects malformed elements', () => {
        expect(decodeElement(null)).toBeNull();
        expect(decodeElement({ id: 'x', t: 'virus' })).toBeNull();
        expect(
            decodeElement({ id: 'x', t: 'pen', x: 0, y: 0, w: 0, h: 0, c: '#000', sw: 1, z: 1, v: 1, by: 'a', pts: [1] }),
        ).toBeNull();
        expect(
            decodeElement({ id: 'x', t: 'rect', x: NaN, y: 0, w: 0, h: 0, c: '#000', sw: 1, z: 1, v: 1, by: 'a' }),
        ).toBeNull();
    });
});

describe('store merge', () => {
    it('converges whatever the delivery order, including duplicates', () => {
        const a = new Store('a');
        const b = new Store('b');
        const ops: Element[] = [];
        a.on((e) => ops.push(...e.elements));
        b.on((e) => e.origin === 'local' && ops.push(...e.elements));
        a.write(pen('s1', [0, 0, 5, 5]));
        b.write(pen('s2', [1, 1, 6, 6]));
        a.write({ ...a.get('s1')!, x: 50 });
        b.merge([a.get('s1')!]);
        b.write({ ...b.get('s1')!, x: 70 });
        a.remove('s1');

        const shuffled = (seed: number) => {
            const copy = [...ops, ...ops];
            let s = seed;
            for (let i = copy.length - 1; i > 0; i--) {
                s = (s * 9301 + 49297) % 233280;
                const j = Math.floor((s / 233280) * (i + 1));
                [copy[i], copy[j]] = [copy[j], copy[i]];
            }
            return copy;
        };
        const results = [1, 2, 3, 4, 5].map((seed) => {
            const s = new Store('z');
            for (const op of shuffled(seed)) s.merge([op]);
            return JSON.stringify([...s.allRecords()].sort((x, y) => x.id.localeCompare(y.id)));
        });
        expect(new Set(results).size).toBe(1);
    });

    it('ignores older versions', () => {
        const s = new Store('a');
        const v1 = s.write(pen('p', [0, 0, 1, 1]));
        const v2 = s.write({ ...v1, x: 9 });
        expect(s.merge([v1])).toHaveLength(0);
        expect(s.get('p')!.x).toBe(v2.x);
    });
});

describe('history', () => {
    it('undoes and redoes a step', () => {
        const s = new Store('a');
        const h = new History(s);
        h.commit([pen('p', [0, 0, 1, 1])]);
        expect(s.elements()).toHaveLength(1);
        h.undo();
        expect(s.elements()).toHaveLength(0);
        h.redo();
        expect(s.elements()).toHaveLength(1);
    });

    it("does not undo over someone else's later change", () => {
        const mine = new Store('a');
        const h = new History(mine);
        const [el] = h.commit([pen('p', [0, 0, 1, 1])]);
        const theirs = new Store('b');
        theirs.merge([el]);
        const moved = theirs.write({ ...el, x: 100 });
        mine.merge([moved]);
        expect(h.undo()).toBe(false);
        expect(mine.get('p')!.x).toBe(100);
        expect(mine.get('p')!.del).toBeUndefined();
    });
});

describe('geometry', () => {
    it('simplifies a straight line to its ends', () => {
        const pts: number[] = [];
        for (let i = 0; i <= 100; i++) pts.push(i, i * 0.5);
        expect(simplify(pts, 0.1)).toEqual([0, 100]);
    });

    it('hit-tests strokes and outlines', () => {
        const store = new Store('a');
        const line = store.write(pen('p', [0, 0, 100, 0]));
        expect(hitTest(line, { x: 50, y: 2 }, 2, 'stroke')).toBe(true);
        expect(hitTest(line, { x: 50, y: 10 }, 2, 'stroke')).toBe(false);
        const rect = store.write({ id: 'r', t: 'rect', x: 0, y: 0, w: 100, h: 100, c: '#000', sw: 2 });
        expect(hitTest(rect, { x: 50, y: 50 }, 4, 'stroke')).toBe(false);
        expect(hitTest(rect, { x: 50, y: 50 }, 4, 'area')).toBe(true);
        expect(hitTest(rect, { x: 1, y: 50 }, 4, 'stroke')).toBe(true);
    });

    it('scales an element between boxes', () => {
        const store = new Store('a');
        const r = store.write({ id: 'r', t: 'rect', x: 10, y: 10, w: 10, h: 10, c: '#000', sw: 1 });
        const s = scaleElement(r, { x: 10, y: 10, w: 10, h: 10 }, { x: 0, y: 0, w: 40, h: 20 });
        expect([s.x, s.y, s.w, s.h]).toEqual([0, 0, 40, 20]);
    });
});

describe('camera', () => {
    it('converts both ways and zooms around a point', () => {
        const cam = { x: 10, y: 20, zoom: 2 };
        const p = { x: 33, y: 44 };
        expect(screenToScene(cam, sceneToScreen(cam, p))).toEqual(p);
        const z = zoomAt(cam, { x: 100, y: 100 }, 4);
        expect(screenToScene(z, { x: 100, y: 100 })).toEqual(screenToScene(cam, { x: 100, y: 100 }));
    });

    it('fits content without zooming in', () => {
        const cam = fitRect({ x: 0, y: 0, w: 100, h: 100 }, 1000, 1000);
        expect(cam.zoom).toBe(1);
    });
});

describe('fromExcalidraw', () => {
    it('converts freedraw, shapes and text, and skips the rest', () => {
        const scene = fromExcalidraw({
            elements: [
                { id: 'f', type: 'freedraw', x: 10, y: 10, width: 5, height: 5, strokeColor: '#e03131', strokeWidth: 1, points: [[0, 0], [5, 5]], pressures: [], simulatePressure: true },
                { id: 'r', type: 'rectangle', x: 0, y: 0, width: 20, height: 10, backgroundColor: 'transparent' },
                { id: 't', type: 'text', x: 0, y: 0, width: 40, height: 25, text: 'hi', fontSize: 20 },
                { id: 'd', type: 'rectangle', x: 0, y: 0, width: 1, height: 1, isDeleted: true },
                { id: 'i', type: 'image', x: 0, y: 0, width: 1, height: 1 },
            ],
        });
        const els = decodeScene(scene);
        expect(els.map((e) => e.t)).toEqual(['pen', 'rect', 'text']);
        expect(els[0]).toMatchObject({ x: 10, y: 10, c: '#e03131', sw: 1, pts: [0, 0, 5, 5] });
        expect(els[0].pr).toBeUndefined();
        expect(els[1].fill).toBeUndefined();
    });
});

describe('sticky notes', () => {
    it('round-trips through the codec and is hit anywhere inside', () => {
        const s = new Store('a');
        const note = s.write({
            id: 'n1',
            t: 'note',
            x: 0,
            y: 0,
            w: 200,
            h: 200,
            fill: '#ffec99',
            txt: 'Check both roots',
            fs: 20,
            c: '#1e1e1e',
            sw: 1,
        });
        const [back] = decodeScene(JSON.parse(JSON.stringify(encodeScene([note]))));
        expect(back).toMatchObject({ t: 'note', fill: '#ffec99', txt: 'Check both roots' });
        expect(hitTest(note, { x: 100, y: 100 }, 0, 'stroke')).toBe(true);
        expect(hitTest(note, { x: 250, y: 100 }, 0, 'area')).toBe(false);
    });

    it('resizes the paper without changing the font size', () => {
        const s = new Store('a');
        const note = s.write({ id: 'n', t: 'note', x: 0, y: 0, w: 200, h: 200, fill: '#ffec99', txt: 'hi', fs: 20, c: '#1e1e1e', sw: 1 });
        const big = scaleElement(note, { x: 0, y: 0, w: 200, h: 200 }, { x: 0, y: 0, w: 300, h: 260 });
        expect([big.w, big.h, big.fs]).toEqual([300, 260, 20]);
    });
});

describe('tombstones', () => {
    it('drop heavy data on delete, and undo still restores it', () => {
        const s = new Store('a');
        const h = new History(s);
        h.commit([pen('p', [0, 0, 5, 5, 10, 0])]);
        h.commit([], ['p']);
        expect(s.get('p')!.pts).toBeUndefined();
        expect(JSON.stringify(encodeScene(s.allRecords())).length).toBeLessThan(150);
        h.undo();
        expect(s.get('p')!.del).toBeUndefined();
        expect(s.get('p')!.pts).toEqual([0, 0, 5, 5, 10, 0]);
    });
});
