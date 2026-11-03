import { afterEach, describe, expect, it } from 'vitest';
import { createRelay, type Relay } from '../server/src/relay';
import { MemoryStorage } from '../server/src/storage';
import { jwtAuthorizer, signToken } from '../server/src/jwt';
import { decodeElementBinary } from '../src/protocol';
import { connect, MemoryOutbox, type SyncClient } from '../src/sync';
import { HeadlessBoard } from './helpers/headless';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, timeout = 8000, what = 'condition'): Promise<void> {
    const start = Date.now();
    while (!check()) {
        if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
        await wait(20);
    }
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function startRelay(storage = new MemoryStorage(), port = 0, extra = {}): Promise<Relay> {
    const relay = await createRelay({ storage, port, flushMs: 50, roomIdleMs: 200, ...extra });
    cleanups.push(() => relay.close());
    return relay;
}

function client(relay: Relay | number, board: HeadlessBoard, name: string, extra = {}): SyncClient {
    const port = typeof relay === 'number' ? relay : relay.port;
    const c = connect(board, {
        url: `ws://127.0.0.1:${port}`,
        user: { id: name, name },
        outbox: new MemoryOutbox(),
        ...extra,
    });
    cleanups.push(() => c.close());
    return c;
}

describe('sync through the relay', () => {
    it('delivers strokes both ways and confirms them saved', async () => {
        const storage = new MemoryStorage();
        const relay = await startRelay(storage);
        const a = new HeadlessBoard('lesson-1');
        const b = new HeadlessBoard('lesson-1');
        const ca = client(relay, a, 'teacher');
        const cb = client(relay, b, 'student');
        await until(() => ca.status === 'online' && cb.status === 'online', 8000, 'online');
        await until(() => ca.peers.length === 1 && cb.peers.length === 1, 8000, 'presence');
        expect(ca.peers[0].user.name).toBe('student');

        a.draw('a1');
        b.draw('b1');
        await until(() => a.snapshot().length === 2 && b.snapshot().length === 2, 8000, 'delivery');
        expect(a.snapshot()).toEqual(b.snapshot());
        await until(() => ca.pending === 0 && cb.pending === 0, 8000, 'acks');
        expect((await storage.elements('lesson-1')).length).toBe(2);
    });

    it('loads the whole board for someone who joins later', async () => {
        const relay = await startRelay();
        const a = new HeadlessBoard('lesson-2');
        const ca = client(relay, a, 'teacher');
        await until(() => ca.status === 'online');
        for (let i = 0; i < 50; i++) a.draw(`s${i}`);
        await until(() => ca.pending === 0, 8000, 'acks');
        const late = new HeadlessBoard('lesson-2');
        client(relay, late, 'student');
        await until(() => late.snapshot().length === 50, 8000, 'late join');
        expect(late.snapshot()).toEqual(a.snapshot());
    });

    it('keeps changes made offline and delivers them after reconnecting', async () => {
        const storage = new MemoryStorage();
        const relay = await startRelay(storage);
        const a = new HeadlessBoard('lesson-3');
        const b = new HeadlessBoard('lesson-3');
        const ca = client(relay, a, 'teacher');
        client(relay, b, 'student');
        await until(() => ca.status === 'online');
        // Drop the teacher's connection and draw while it is down.
        (ca as unknown as { ws: WebSocket }).ws.close();
        await until(() => ca.status === 'offline', 8000, 'offline');
        for (let i = 0; i < 10; i++) a.draw(`off${i}`);
        expect(ca.pending).toBe(10);
        await until(() => ca.status === 'online' && ca.pending === 0, 10_000, 'reconnect and ack');
        await until(() => b.snapshot().length === 10, 8000, 'peer catch-up');
        expect((await storage.elements('lesson-3')).length).toBe(10);
    });

    it('forwards live strokes, cursors and laser without saving them', async () => {
        const storage = new MemoryStorage();
        const relay = await startRelay(storage);
        const a = new HeadlessBoard('lesson-4');
        const b = new HeadlessBoard('lesson-4');
        const ca = client(relay, a, 'teacher');
        const cb = client(relay, b, 'student');
        await until(() => ca.peers.length === 1 && cb.peers.length === 1, 8000, 'presence');
        const seen: string[] = [];
        const remote = b.remote as unknown as Record<string, (...args: unknown[]) => void>;
        for (const name of ['stroke', 'cursor', 'laser']) {
            const orig = remote[name].bind(b.remote);
            remote[name] = (...args: unknown[]) => {
                seen.push(name);
                orig(...args);
            };
        }
        for (let i = 0; i < 5; i++) {
            a.emitLive({ kind: 'stroke', id: 'live1', color: '#000000', width: 1, index: i, x: i, y: i });
        }
        a.emitLive({ kind: 'pointer', x: 5, y: 5, visible: true });
        a.emitLive({ kind: 'laser', x: 1, y: 1, start: true });
        await until(() => ['stroke', 'cursor', 'laser'].every((n) => seen.includes(n)), 8000, 'live');
        await wait(150);
        expect((await storage.elements('lesson-4')).length).toBe(0);
    });

    it('refuses a board the token does not cover', async () => {
        const secret = 'test-secret';
        const relay = await startRelay(new MemoryStorage(), 0, { authorize: jwtAuthorizer(secret) });
        const exp = Math.floor(Date.now() / 1000) + 60;
        const ok = new HeadlessBoard('session-1:topic-1');
        const bad = new HeadlessBoard('session-2:topic-1');
        const cok = client(relay, ok, 'student', { token: signToken({ sub: 'u1', boards: 'session-1:', exp }, secret) });
        const cbad = client(relay, bad, 'student', { token: signToken({ sub: 'u1', boards: 'session-1:', exp }, secret) });
        await until(() => cok.status === 'online' && cbad.status === 'denied', 8000, 'auth');
    });
});

describe('no data loss under failure', () => {
    it('survives dropped connections and a relay crash while two people draw', async () => {
        const storage = new MemoryStorage();
        // Slow flushes, so the crash below loses a buffer full of changes.
        let relay = await createRelay({ storage, flushMs: 300, roomIdleMs: 200 });
        const port = relay.port;
        const a = new HeadlessBoard('chaos');
        const b = new HeadlessBoard('chaos');
        const ca = client(port, a, 'teacher');
        const cb = client(port, b, 'student');
        await until(() => ca.status === 'online' && cb.status === 'online', 8000, 'online');

        const drop = (c: SyncClient) => (c as unknown as { ws: WebSocket | null }).ws?.close();
        let n = 0;
        for (let round = 0; round < 20; round++) {
            for (let i = 0; i < 10; i++) {
                a.draw(`a${n}`);
                b.draw(`b${n}`);
                n++;
            }
            // Edit and delete some earlier strokes too.
            if (round > 2) {
                const target = a.store.get(`b${n - 25}`);
                if (target) a.store.write({ ...target, x: target.x + 5 });
                b.store.remove(`a${n - 30}`);
            }
            if (round % 4 === 1) drop(ca);
            if (round % 5 === 2) drop(cb);
            if (round === 10) {
                // Crash: everything buffered in the relay is lost.
                relay.abort();
                await wait(100);
                relay = await createRelay({ storage, port, flushMs: 50, roomIdleMs: 200 });
            }
            await wait(30);
        }
        cleanups.push(() => relay.close());

        await until(
            () =>
                ca.status === 'online' &&
                cb.status === 'online' &&
                ca.pending === 0 &&
                cb.pending === 0 &&
                a.snapshot().join() === b.snapshot().join(),
            20_000,
            'convergence',
        );
        // Every stroke that wasn't deleted is on both boards and in storage.
        const saved = (await storage.elements('chaos')).map(decodeElementBinary).filter((e) => !e.del);
        expect(a.snapshot().length).toBe(saved.length);
        expect(a.snapshot().length).toBeGreaterThan(300);
        const savedIds = new Set(saved.map((e) => e.id));
        for (const id of a.snapshot().map((s) => s.split('@')[0])) expect(savedIds.has(id)).toBe(true);
    }, 30_000);
});

describe('presenting', () => {
    it('reports joins and lets a follower follow whoever presents', async () => {
        const relay = await startRelay();
        const a = new HeadlessBoard('follow');
        const b = new HeadlessBoard('follow');
        const ca = client(relay, a, 'teacher');
        const cb = client(relay, b, 'student');
        const joins: number[] = [];
        cb.on('joined', (j) => joins.push(j.elements));
        await until(() => ca.peers.length === 1 && cb.peers.length === 1, 8000, 'presence');
        expect(joins).toEqual([0]);
        cb.follow('any');
        ca.present(true);
        a.setCamera({ x: 120, y: 340, zoom: 1.5 });
        await until(() => b.camera.x === 120 && b.camera.y === 340 && b.camera.zoom === 1.5, 8000, 'follow');
    });
});
