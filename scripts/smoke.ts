/**
 * Two simulated users draw on the same board through a running relay and
 * check that both see everything and the relay confirms it saved.
 *
 *   npm run smoke                              # ws://localhost:8787
 *   npm run smoke -- ws://localhost:8788 50    # another relay, 50 strokes each
 */
import { connect, MemoryOutbox } from '../src/sync';
import { HeadlessBoard } from '../test/helpers/headless';

const url = process.argv[2] ?? 'ws://localhost:8787';
const strokes = Number(process.argv[3] ?? 25);
const board = `smoke-${Date.now()}:topic-1`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, check: () => boolean, timeout = 15_000): Promise<void> {
    const start = Date.now();
    while (!check()) {
        if (Date.now() - start > timeout) {
            console.error(`✗ timed out waiting for: ${what}`);
            process.exit(1);
        }
        await wait(50);
    }
    console.log(`✓ ${what} (${Date.now() - start} ms)`);
}

const a = new HeadlessBoard(board);
const b = new HeadlessBoard(board);
const ca = connect(a, { url, user: { id: 'a', name: 'User A' }, outbox: new MemoryOutbox() });
const cb = connect(b, { url, user: { id: 'b', name: 'User B' }, outbox: new MemoryOutbox() });

console.log(`relay ${url}, board ${board}`);
await until('both online', () => ca.status === 'online' && cb.status === 'online');
await until('each sees the other', () => ca.peers.length === 1 && cb.peers.length === 1);
for (let i = 0; i < strokes; i++) {
    a.draw(`a${i}`);
    b.draw(`b${i}`);
}
await until(`both boards have ${strokes * 2} strokes`, () =>
    a.snapshot().length === strokes * 2 && b.snapshot().join() === a.snapshot().join(),
);
await until('relay confirmed everything saved', () => ca.pending === 0 && cb.pending === 0);
ca.close();
cb.close();

// A third user joining later loads the board from the relay.
const c = new HeadlessBoard(board);
const cc = connect(c, { url, user: { id: 'c', name: 'User C' }, outbox: new MemoryOutbox() });
await until('a late joiner loads the whole board', () => c.snapshot().join() === a.snapshot().join());
cc.close();
console.log('all good');
process.exit(0);
