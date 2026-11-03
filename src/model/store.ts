import type { ChangeEvent, ChangeOrigin, Element, ElementInit } from '../types';
import { nanoid } from './geometry';

type Listener = (event: ChangeEvent) => void;

/** Whether `a` replaces `b`: the higher clock wins, the client id breaks ties. */
export function wins(a: Element, b: Element): boolean {
    return a.v > b.v || (a.v === b.v && a.by > b.by);
}

function byZ(a: Element, b: Element): number {
    return a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The board's elements as a last-writer-wins map: every element is an
 * independent register versioned by a Lamport clock. Merging is commutative
 * and idempotent, so updates may arrive late, twice or out of order and every
 * client still ends up with the same board.
 */
export class Store {
    readonly clientId: string;
    private clock = 0;
    private map = new Map<string, Element>();
    private sorted: Element[] | null = null;
    private listeners = new Set<Listener>();
    private pending: Map<string, Element> | null = null;

    constructor(clientId: string = nanoid(12)) {
        this.clientId = clientId;
    }

    get(id: string): Element | undefined {
        return this.map.get(id);
    }

    /** Visible elements, bottom to top. Cached until the next change. */
    elements(): readonly Element[] {
        if (!this.sorted) {
            this.sorted = [];
            for (const el of this.map.values()) if (!el.del) this.sorted.push(el);
            this.sorted.sort(byZ);
        }
        return this.sorted;
    }

    /** Every element including tombstones, for saving and syncing. */
    allRecords(): IterableIterator<Element> {
        return this.map.values();
    }

    /** Applies a local change and stamps it with the next clock value. */
    write(content: ElementInit | Element): Element {
        const id = content.id ?? nanoid();
        const prev = this.map.get(id);
        const v = ++this.clock;
        const el: Element = {
            ...content,
            id,
            z: content.z ?? prev?.z ?? v,
            v,
            by: this.clientId,
        };
        if (el.del) {
            // A tombstone only has to win merges; carrying the points would
            // keep a cleared board as big as it was. Undo restores from history.
            delete el.pts;
            delete el.pr;
            delete el.txt;
            delete el.fill;
        }
        this.set(el, 'local');
        return el;
    }

    /** Marks an element deleted. */
    remove(id: string): Element | undefined {
        const prev = this.map.get(id);
        if (!prev || prev.del) return undefined;
        return this.write({ ...prev, del: 1 });
    }

    /** Merges elements from another client or storage; returns those that changed. */
    merge(incoming: Iterable<Element>, origin: ChangeOrigin = 'remote'): Element[] {
        const changed: Element[] = [];
        this.transact(() => {
            for (const el of incoming) {
                if (el.v > this.clock) this.clock = el.v;
                const cur = this.map.get(el.id);
                if (cur && !wins(el, cur)) continue;
                this.set(el, origin);
                changed.push(el);
            }
        }, origin);
        return changed;
    }

    /** Drops everything, e.g. when switching boards. Emits nothing. */
    reset(): void {
        this.map.clear();
        this.sorted = null;
    }

    /** Groups changes so listeners hear about them once. */
    transact(fn: () => void, origin: ChangeOrigin = 'local'): void {
        if (this.pending) {
            fn();
            return;
        }
        this.pending = new Map();
        try {
            fn();
        } finally {
            const batch = this.pending;
            this.pending = null;
            if (batch.size > 0) this.emit({ elements: [...batch.values()], origin });
        }
    }

    on(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private set(el: Element, origin: ChangeOrigin): void {
        this.map.set(el.id, el);
        this.sorted = null;
        if (this.pending) this.pending.set(el.id, el);
        else this.emit({ elements: [el], origin });
    }

    private emit(event: ChangeEvent): void {
        for (const l of this.listeners) l(event);
    }
}
