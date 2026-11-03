import { readElementHeader } from '../../src/protocol';

/** One saved change: an element version, numbered within its board. */
export interface StoredOp {
    boardId: string;
    /** Board-wide order, assigned by the relay. */
    seq: number;
    /** Writer and its sequence number: duplicates of this pair are ignored. */
    clientId: string;
    cseq: number;
    /** The element, binary-encoded. */
    item: Uint8Array;
}

export interface LoadResult {
    /** true when `items` is the whole board rather than changes after `since`. */
    full: boolean;
    items: { seq: number; item: Uint8Array }[];
}

export interface BoardStorage {
    /** Highest sequence number saved for a board (0 for a new board). */
    maxSeq(boardId: string): Promise<number>;
    /** Changes after `since`; the whole board when `since` is 0 or compacted away. */
    load(boardId: string, since: number): Promise<LoadResult>;
    /** Saves changes. Must be idempotent per (boardId, clientId, cseq). */
    append(ops: StoredOp[]): Promise<void>;
    /** Folds a board's changes into one snapshot. Called when a room closes. */
    compact?(boardId: string): Promise<void>;
}

/** Thrown by storage when a sequence number is already taken (two relays on one board). */
export class SeqConflictError extends Error {
    constructor(readonly boardId: string) {
        super(`Sequence conflict on ${boardId}`);
    }
}

/**
 * Keeps the newest version of each element: higher version wins, then the
 * higher writer id, the same rule every client applies.
 */
export function mergeItems(items: Iterable<Uint8Array>): Uint8Array[] {
    const latest = new Map<string, { v: number; by: string; item: Uint8Array }>();
    for (const item of items) {
        const h = readElementHeader(item);
        const cur = latest.get(h.id);
        if (!cur || h.v > cur.v || (h.v === cur.v && h.by > cur.by)) {
            latest.set(h.id, { v: h.v, by: h.by, item });
        }
    }
    return [...latest.values()].map((e) => e.item);
}

/** In-memory storage for development and tests. Lost on restart. */
export class MemoryStorage implements BoardStorage {
    private boards = new Map<
        string,
        { ops: StoredOp[]; keys: Set<string>; seqs: Set<number>; snapshot: { seq: number; items: Uint8Array[] } | null }
    >();

    private board(id: string) {
        let b = this.boards.get(id);
        if (!b) {
            b = { ops: [], keys: new Set(), seqs: new Set(), snapshot: null };
            this.boards.set(id, b);
        }
        return b;
    }

    async maxSeq(boardId: string): Promise<number> {
        const b = this.board(boardId);
        const last = b.ops.length ? b.ops[b.ops.length - 1].seq : 0;
        return Math.max(last, b.snapshot?.seq ?? 0);
    }

    async load(boardId: string, since: number): Promise<LoadResult> {
        const b = this.board(boardId);
        const snap = b.snapshot;
        if (since === 0 || (snap && since < snap.seq)) {
            const base = snap ? snap.items.map((item) => ({ seq: snap.seq, item })) : [];
            const after = snap ? snap.seq : 0;
            return {
                full: true,
                items: [...base, ...b.ops.filter((o) => o.seq > after).map((o) => ({ seq: o.seq, item: o.item }))],
            };
        }
        return { full: false, items: b.ops.filter((o) => o.seq > since).map((o) => ({ seq: o.seq, item: o.item })) };
    }

    async append(ops: StoredOp[]): Promise<void> {
        for (const op of ops) {
            const b = this.board(op.boardId);
            const key = op.clientId + '\u0000' + op.cseq;
            if (b.keys.has(key)) continue;
            if (b.seqs.has(op.seq)) throw new SeqConflictError(op.boardId);
            b.keys.add(key);
            b.seqs.add(op.seq);
            b.ops.push({ ...op, item: op.item.slice() });
        }
        for (const op of ops) this.board(op.boardId).ops.sort((x, y) => x.seq - y.seq);
    }

    async compact(boardId: string): Promise<void> {
        const b = this.board(boardId);
        if (b.ops.length === 0) return;
        const all = await this.load(boardId, 0);
        const seq = await this.maxSeq(boardId);
        b.snapshot = { seq, items: mergeItems(all.items.map((i) => i.item)) };
        b.ops = b.ops.filter((o) => o.seq > seq);
    }

    /** Test helper: everything saved for a board, merged. */
    async elements(boardId: string): Promise<Uint8Array[]> {
        return mergeItems((await this.load(boardId, 0)).items.map((i) => i.item));
    }
}
