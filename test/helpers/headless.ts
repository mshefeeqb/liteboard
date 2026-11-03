import { Emitter } from '../../src/emitter';
import { RemoteLayer } from '../../src/live';
import { relativePoints } from '../../src/model/geometry';
import { Store } from '../../src/model/store';
import type { SyncTarget } from '../../src/sync';
import type { Camera, ChangeEvent, Element, LiveEvent } from '../../src/types';

interface Events {
    change: ChangeEvent;
    live: LiveEvent;
    load: { boardId: string | undefined };
    camera: Camera;
}

/** A board without a screen: the store, events and remote layer a SyncClient uses. */
export class HeadlessBoard implements SyncTarget {
    store = new Store();
    remote = new RemoteLayer(() => {});
    camera: Camera = { x: 0, y: 0, zoom: 1 };
    private events = new Emitter<Events>();

    constructor(public boardId: string | undefined) {
        this.store.on((e) => this.events.emit('change', e));
    }

    merge(elements: Iterable<Element>): Element[] {
        return this.store.merge(elements, 'remote');
    }

    setCamera(c: Camera): void {
        this.camera = c;
        this.events.emit('camera', c);
    }

    on(event: keyof Events, fn: (payload: never) => void): () => void {
        return this.events.on(event, fn as (p: unknown) => void);
    }

    emitLive(e: LiveEvent): void {
        this.events.emit('live', e);
    }

    load(boardId: string): void {
        this.store.reset();
        this.boardId = boardId;
        this.events.emit('load', { boardId });
    }

    /** Draws a small stroke as this user. */
    draw(id: string, x = Math.random() * 1000, y = Math.random() * 1000): Element {
        return this.store.write({
            id,
            t: 'pen',
            ...relativePoints([x, y, x + 10, y + 4, x + 20, y]),
            c: '#1e1e1e',
            sw: 1,
        });
    }

    /** Visible elements as comparable records. */
    snapshot(): string[] {
        return this.store
            .elements()
            .map((e) => `${e.id}@${e.v}:${e.by}:${e.x},${e.y}`)
            .sort();
    }
}
