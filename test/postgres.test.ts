import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { PostgresStorage } from '../server/src/postgres';
import { createRelay } from '../server/src/relay';
import { SeqConflictError, type StoredOp } from '../server/src/storage';
import { decodeElementBinary, encodeElementBinary } from '../src/protocol';
import { relativePoints } from '../src/model/geometry';
import { connect, MemoryOutbox } from '../src/sync';
import type { Element } from '../src/types';
import { HeadlessBoard } from './helpers/headless';

async function fresh(): Promise<PostgresStorage> {
    const storage = new PostgresStorage(new PGlite());
    await storage.migrate();
    return storage;
}

const el = (id: string, v: number, x = 0): Element => ({
    id,
    t: 'pen',
    ...relativePoints([x, 0, x + 5, 5]),
    c: '#1e1e1e',
    sw: 1,
    z: 1,
    v,
    by: 'w',
});

const op = (seq: number, cseq: number, e: Element, boardId = 'b1'): StoredOp => ({
    boardId,
    seq,
    clientId: 'c1',
    cseq,
    item: encodeElementBinary(e),
});

describe('PostgresStorage', () => {
    it('appends, ignores resent changes, and loads after a sequence number', async () => {
        const s = await fresh();
        await s.append([op(1, 1, el('a', 1)), op(2, 2, el('b', 1))]);
        await s.append([op(3, 2, el('b', 1))]); // same writer + cseq: a resend
        expect(await s.maxSeq('b1')).toBe(2);
        const all = await s.load('b1', 0);
        expect(all.full).toBe(true);
        expect(all.items.map((i) => decodeElementBinary(i.item).id)).toEqual(['a', 'b']);
        const since = await s.load('b1', 1);
        expect(since.full).toBe(false);
        expect(since.items.map((i) => i.seq)).toEqual([2]);
    });

    it('reports a sequence number taken by another relay', async () => {
        const s = await fresh();
        await s.append([op(1, 1, el('a', 1))]);
        await expect(
            s.append([{ ...op(1, 9, el('z', 1)), clientId: 'other' }]),
        ).rejects.toBeInstanceOf(SeqConflictError);
    });

    it('compacts into a snapshot that keeps the newest versions', async () => {
        const s = await fresh();
        const ops: StoredOp[] = [];
        for (let i = 1; i <= 250; i++) ops.push(op(i, i, el(`e${i % 100}`, i, i)));
        await s.append(ops);
        await s.compact('b1');
        const loaded = await s.load('b1', 0);
        expect(loaded.items).toHaveLength(100);
        const e5 = loaded.items.map((i) => decodeElementBinary(i.item)).find((e) => e.id === 'e5')!;
        expect(e5.v).toBe(205);
        expect(await s.maxSeq('b1')).toBe(250);
        // New changes go after the snapshot; an old cursor gets the full board.
        await s.append([op(251, 251, el('new', 251))]);
        expect((await s.load('b1', 250)).items).toHaveLength(1);
        expect((await s.load('b1', 10)).full).toBe(true);
    });

    it('deletes every board of a session', async () => {
        const s = await fresh();
        await s.append([op(1, 1, el('a', 1), 'sess1:t1'), op(1, 2, el('b', 1), 'sess1:t2'), op(1, 3, el('c', 1), 'sess2:t1')]);
        await s.deleteBoards('sess1:%');
        expect((await s.load('sess1:t1', 0)).items).toHaveLength(0);
        expect((await s.load('sess2:t1', 0)).items).toHaveLength(1);
    });

    it('serves a relay end to end and keeps boards across restarts', async () => {
        const storage = await fresh();
        let relay = await createRelay({ storage, flushMs: 50, roomIdleMs: 100 });
        const a = new HeadlessBoard('lesson');
        const c = connect(a, { url: `ws://127.0.0.1:${relay.port}`, user: { id: 't', name: 'T' }, outbox: new MemoryOutbox() });
        const until = async (f: () => boolean) => {
            for (let i = 0; i < 400 && !f(); i++) await new Promise((r) => setTimeout(r, 20));
            expect(f()).toBe(true);
        };
        await until(() => c.status === 'online');
        for (let i = 0; i < 30; i++) a.draw(`s${i}`);
        await until(() => c.pending === 0);
        c.close();
        await relay.close();

        relay = await createRelay({ storage, flushMs: 50 });
        const b = new HeadlessBoard('lesson');
        const cb = connect(b, { url: `ws://127.0.0.1:${relay.port}`, user: { id: 's', name: 'S' }, outbox: new MemoryOutbox() });
        await until(() => b.snapshot().length === 30);
        expect(b.snapshot()).toEqual(a.snapshot());
        cb.close();
        await relay.close();
    });
});
