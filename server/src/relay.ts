import { createRequire } from 'node:module';
import type * as UWS from 'uWebSockets.js';

// Browsers send every cookie for the host with the WebSocket handshake,
// whatever the port, so a relay next to a signed-in app receives the app's
// auth cookies (Supabase's alone are several KB). uWS refuses headers above
// 4 KB with "431" unless this is raised, and reads it once when it loads,
// which is why it is loaded here rather than imported.
process.env.UWS_HTTP_MAX_HEADERS_SIZE ??= String(64 * 1024);
const uWS = createRequire(import.meta.url)('uWebSockets.js') as typeof UWS;
import { nanoid } from '../../src/model/geometry';
import {
    decode,
    encode,
    Msg,
    PROTOCOL_VERSION,
    RELAY_MIN,
    type Hello,
    type Message,
    type PeerUser,
} from '../../src/protocol';
import { mergeItems, SeqConflictError, type BoardStorage, type StoredOp } from './storage';

export interface Access {
    /** Overrides what the client says about the user (name, colour). */
    user?: PeerUser;
    canWrite: boolean;
}

export interface RelayOptions {
    storage: BoardStorage;
    port?: number;
    /** Interface to listen on. Default: all, IPv4 and IPv6. */
    host?: string;
    /**
     * Decides whether a token may open a board. Return null to refuse.
     * Default: everyone may read and write (development only).
     */
    authorize?: (token: string, boardId: string, user: PeerUser) => Promise<Access | null> | Access | null;
    /** How often buffered changes are written to storage. Default 1000 ms. */
    flushMs?: number;
    /** How long an empty room stays open before it is compacted. Default 30 s. */
    roomIdleMs?: number;
    /** Heartbeat to every connection, so clients notice dead links. Default 15 s. */
    beatMs?: number;
    log?: (msg: string, extra?: unknown) => void;
}

interface Pending {
    op: StoredOp;
    conn: Conn;
}

interface Room {
    boardId: string;
    topic: string;
    /** Changes when the room is recreated; cursors from another epoch need a full load. */
    epoch: string;
    seq: number;
    members: Set<Conn>;
    /** Write-only connections finishing uploads; they keep the room open. */
    writers: Set<Conn>;
    nextPeer: number;
    /** Received, not yet handed to storage. */
    pending: Pending[];
    /** Handed to storage, not yet confirmed. */
    inflight: Pending[];
    /** Recently confirmed, kept briefly so a join racing a write misses nothing. */
    recent: { seq: number; item: Uint8Array; at: number }[];
    closeTimer: ReturnType<typeof setTimeout> | null;
}

interface Conn {
    id: number;
    ws: UWS.WebSocket<ConnRef> | null;
    room: Room | null;
    writeOnly: boolean;
    canWrite: boolean;
    peer: number;
    user: PeerUser;
    queue: Uint8Array[];
    busy: boolean;
    warnedReadOnly: boolean;
}

interface ConnRef {
    conn: Conn;
}

/** Changes per room that may wait for storage before writers are pushed back. */
const MAX_PENDING_PER_ROOM = 20_000;
const RECENT_MS = 60_000;

export interface Relay {
    port: number;
    /** Stops accepting, writes everything buffered, and closes. */
    close(): Promise<void>;
    /** Dies without writing anything buffered, like a crash. For tests. */
    abort(): void;
    stats(): { connections: number; rooms: number; pending: number };
}

export async function createRelay(opts: RelayOptions): Promise<Relay> {
    const storage = opts.storage;
    const log = opts.log ?? (() => {});
    const authorize = opts.authorize ?? ((): Access => ({ canWrite: true }));
    const flushMs = opts.flushMs ?? 1000;
    const roomIdleMs = opts.roomIdleMs ?? 30_000;
    const rooms = new Map<string, Room>();
    const roomLoads = new Map<string, Promise<Room>>();
    const conns = new Set<Conn>();
    let nextConnId = 1;
    let flushing = false;
    let flushFailures = 0;
    let nextFlushAt = 0;

    const app = uWS.App();

    const send = (conn: Conn, m: Message) => {
        if (conn.ws) conn.ws.send(encode(m), true);
    };
    const publish = (room: Room, m: Message | Uint8Array, from?: Conn) => {
        const bytes = m instanceof Uint8Array ? m : encode(m);
        if (from?.ws) from.ws.publish(room.topic, bytes, true);
        else app.publish(room.topic, bytes, true);
    };

    async function getRoom(boardId: string): Promise<Room> {
        const open = rooms.get(boardId);
        if (open) return open;
        let loading = roomLoads.get(boardId);
        if (!loading) {
            loading = storage.maxSeq(boardId).then((seq) => {
                const room: Room = {
                    boardId,
                    topic: 'b:' + boardId,
                    epoch: nanoid(8),
                    seq,
                    members: new Set(),
                    writers: new Set(),
                    nextPeer: 1,
                    pending: [],
                    inflight: [],
                    recent: [],
                    closeTimer: null,
                };
                rooms.set(boardId, room);
                roomLoads.delete(boardId);
                return room;
            });
            loading.catch(() => roomLoads.delete(boardId));
            roomLoads.set(boardId, loading);
        }
        return loading;
    }

    function scheduleClose(room: Room): void {
        if (room.closeTimer || room.members.size > 0 || room.writers.size > 0) return;
        room.closeTimer = setTimeout(async () => {
            room.closeTimer = null;
            if (room.members.size > 0 || room.writers.size > 0) return;
            if (room.pending.length > 0 || room.inflight.length > 0) {
                scheduleClose(room);
                return;
            }
            rooms.delete(room.boardId);
            try {
                await storage.compact?.(room.boardId);
            } catch (err) {
                log('compact failed', { board: room.boardId, err });
            }
        }, roomIdleMs);
    }

    function leave(conn: Conn): void {
        const room = conn.room;
        if (!room) return;
        conn.room = null;
        room.writers.delete(conn);
        if (!conn.writeOnly) {
            room.members.delete(conn);
            conn.ws?.unsubscribe(room.topic);
            publish(room, { type: Msg.Leave, peer: conn.peer });
        }
        scheduleClose(room);
    }

    /** Everything after `since` the room knows of, saved or not. */
    async function catchUp(room: Room, since: number, full: boolean) {
        const loaded = await storage.load(room.boardId, full ? 0 : since);
        const isFull = full || loaded.full;
        const seen = new Set<number>();
        const items: Uint8Array[] = [];
        for (const i of loaded.items) {
            items.push(i.item);
            seen.add(i.seq);
        }
        // The room may hold changes storage didn't return yet (buffered,
        // being written, or written during the await). This runs without
        // another await before the Welcome is sent, so nothing slips between.
        const extra = (seq: number, item: Uint8Array) => {
            if ((!isFull && seq <= since) || seen.has(seq)) return;
            seen.add(seq);
            items.push(item);
        };
        for (const r of room.recent) extra(r.seq, r.item);
        for (const p of room.inflight) extra(p.op.seq, p.op.item);
        for (const p of room.pending) extra(p.op.seq, p.op.item);
        return { full: isFull, items: isFull ? mergeItems(items) : items };
    }

    async function onHello(conn: Conn, m: Hello): Promise<void> {
        if (m.proto !== PROTOCOL_VERSION) {
            send(conn, { type: Msg.Error, code: 'protocol', message: `Protocol ${PROTOCOL_VERSION} required` });
            conn.ws?.end(4000);
            return;
        }
        const access = await authorize(m.token, m.boardId, m.user);
        if (!conn.ws) return;
        if (!access) {
            send(conn, { type: Msg.Error, code: 'denied', message: 'Not allowed on this board' });
            conn.ws.end(4001);
            return;
        }
        leave(conn);
        const room = await getRoom(m.boardId);
        if (!conn.ws) return;
        if (room.closeTimer) {
            clearTimeout(room.closeTimer);
            room.closeTimer = null;
        }
        conn.canWrite = access.canWrite;
        conn.user = access.user ?? m.user;
        conn.room = room;
        conn.writeOnly = m.writeOnly;
        if (m.writeOnly) {
            room.writers.add(conn);
            return;
        }

        const sameEpoch = m.epoch === room.epoch && m.cursor <= room.seq;
        const result = await catchUp(room, m.cursor, !sameEpoch);
        if (!conn.ws || conn.room !== room) return;
        conn.peer = room.nextPeer++;
        // Welcome, subscribe and announce in one synchronous step, so the
        // newcomer neither misses nor double-receives a change.
        send(conn, {
            type: Msg.Welcome,
            boardId: room.boardId,
            epoch: room.epoch,
            peer: conn.peer,
            full: result.full,
            seq: room.seq,
            items: result.items,
            peers: [...room.members].map((c) => ({ peer: c.peer, user: c.user })),
        });
        room.members.add(conn);
        conn.ws.subscribe(room.topic);
        conn.ws.subscribe('beat');
        publish(room, { type: Msg.Join, peer: conn.peer, user: conn.user }, conn);
    }

    function onOps(conn: Conn, clientId: string, firstClientSeq: number, items: Uint8Array[]): void {
        const room = conn.room;
        if (!room || items.length === 0) return;
        if (!conn.canWrite) {
            if (!conn.warnedReadOnly) {
                send(conn, { type: Msg.Error, code: 'readonly', message: 'This board is read-only for you' });
                conn.warnedReadOnly = true;
            }
            return;
        }
        if (room.pending.length + items.length > MAX_PENDING_PER_ROOM) {
            // Storage is not keeping up. Unacknowledged changes stay safe in
            // the client's outbox and come back after reconnecting.
            send(conn, { type: Msg.Error, code: 'overloaded', message: 'Try again shortly' });
            conn.ws?.end(4002);
            return;
        }
        const firstSeq = room.seq + 1;
        items.forEach((item, i) => {
            room.pending.push({
                conn,
                op: { boardId: room.boardId, seq: ++room.seq, clientId, cseq: firstClientSeq + i, item },
            });
        });
        // Others see the change now; the writer's ack waits for storage.
        publish(room, { type: Msg.OpsRelay, firstSeq, items }, conn);
    }

    function handle(conn: Conn, bytes: Uint8Array): Promise<void> | void {
        // Live activity is forwarded unread, the cheapest possible path.
        if (bytes[0] >= RELAY_MIN) {
            if (conn.room && !conn.writeOnly) publish(conn.room, bytes, conn);
            return;
        }
        const m = decode(bytes);
        if (m.type === Msg.Hello) return onHello(conn, m);
        if (m.type === Msg.Ops) return onOps(conn, m.clientId, m.firstClientSeq, m.items);
    }

    /** Messages from one connection are handled in order, even across awaits. */
    async function drain(conn: Conn): Promise<void> {
        if (conn.busy) return;
        conn.busy = true;
        try {
            while (conn.queue.length > 0 && conn.ws) {
                const bytes = conn.queue.shift()!;
                try {
                    await handle(conn, bytes);
                } catch (err) {
                    log('bad message', err);
                    conn.ws?.end(4003);
                }
            }
        } finally {
            conn.busy = false;
        }
    }

    async function flush(): Promise<void> {
        if (flushing) return;
        flushing = true;
        const batch: Pending[] = [];
        for (const room of rooms.values()) {
            if (room.pending.length === 0) continue;
            room.inflight.push(...room.pending);
            batch.push(...room.pending);
            room.pending = [];
        }
        try {
            if (batch.length === 0) return;
            await storage.append(batch.map((p) => p.op));
            flushFailures = 0;
            const now = Date.now();
            const acks = new Map<Conn, Map<string, { boardId: string; clientId: string; upTo: number }>>();
            for (const p of batch) {
                const room = rooms.get(p.op.boardId);
                if (room) {
                    room.recent.push({ seq: p.op.seq, item: p.op.item, at: now });
                    room.inflight = room.inflight.filter((x) => x !== p);
                }
                let perConn = acks.get(p.conn);
                if (!perConn) acks.set(p.conn, (perConn = new Map()));
                const key = p.op.boardId + '\u0000' + p.op.clientId;
                const cur = perConn.get(key);
                if (!cur || p.op.cseq > cur.upTo) {
                    perConn.set(key, { boardId: p.op.boardId, clientId: p.op.clientId, upTo: p.op.cseq });
                }
            }
            for (const room of rooms.values()) {
                room.recent = room.recent.filter((r) => now - r.at < RECENT_MS);
            }
            // Acknowledge only now that the changes are durable.
            for (const [conn, perConn] of acks) {
                for (const a of perConn.values()) send(conn, { type: Msg.Ack, ...a });
            }
        } catch (err) {
            flushFailures++;
            // Back off while storage is failing: 1 s, 2 s, 4 s … up to 10 s.
            nextFlushAt = Date.now() + Math.min(10_000, 1000 * 2 ** (flushFailures - 1));
            log('flush failed', { count: batch.length, err });
            // Put the batch back in front; nothing is acknowledged, so clients
            // keep their copies either way.
            const byRoom = new Map<string, Pending[]>();
            for (const p of batch) {
                const list = byRoom.get(p.op.boardId) ?? [];
                list.push(p);
                byRoom.set(p.op.boardId, list);
            }
            for (const [boardId, list] of byRoom) {
                const room = rooms.get(boardId);
                if (!room) continue;
                room.inflight = room.inflight.filter((x) => !list.includes(x));
                if (err instanceof SeqConflictError && err.boardId === boardId) {
                    // Another relay wrote to this board: renumber after its
                    // changes and start a new epoch so clients reload fully.
                    room.seq = await storage.maxSeq(boardId).catch(() => room.seq);
                    for (const p of [...list, ...room.pending]) p.op.seq = ++room.seq;
                    room.epoch = nanoid(8);
                }
                room.pending = [...list, ...room.pending];
            }
        } finally {
            flushing = false;
        }
    }

    app.ws<ConnRef>('/*', {
        compression: uWS.DISABLED,
        maxPayloadLength: 1 << 20,
        idleTimeout: 60,
        maxBackpressure: 4 << 20,
        upgrade: (res, req, context) => {
            const conn: Conn = {
                id: nextConnId++,
                ws: null,
                room: null,
                writeOnly: false,
                canWrite: false,
                peer: 0,
                user: { id: '', name: '', color: '' },
                queue: [],
                busy: false,
                warnedReadOnly: false,
            };
            res.upgrade<ConnRef>(
                { conn },
                req.getHeader('sec-websocket-key'),
                req.getHeader('sec-websocket-protocol'),
                req.getHeader('sec-websocket-extensions'),
                context,
            );
        },
        open: (ws) => {
            const conn = ws.getUserData().conn;
            conn.ws = ws;
            conns.add(conn);
        },
        message: (ws, message, isBinary) => {
            if (!isBinary || message.byteLength === 0) return;
            const conn = ws.getUserData().conn;
            // uWS reuses the buffer after this callback returns.
            conn.queue.push(new Uint8Array(message.slice(0)));
            void drain(conn);
        },
        close: (ws) => {
            const conn = ws.getUserData().conn;
            conn.ws = null;
            conn.queue = [];
            conns.delete(conn);
            leave(conn);
        },
    });

    // For load balancers and uptime checks.
    app.get('/health', (res) => {
        let pending = 0;
        for (const r of rooms.values()) pending += r.pending.length + r.inflight.length;
        res.writeHeader('content-type', 'application/json').end(
            JSON.stringify({ ok: true, connections: conns.size, rooms: rooms.size, pending }),
        );
    });

    const port = await new Promise<number>((resolve, reject) => {
        const done = (token: UWS.us_listen_socket | false) => {
            if (!token) {
                reject(new Error(`Port ${opts.port} is in use (is another relay running?)`));
            } else {
                resolve(uWS.us_socket_local_port(token));
            }
        };
        // Exclusive: uWS shares ports by default, and two relays on one port
        // would split a board's users between them without any error.
        // Without a host it listens on IPv4 and IPv6, so `localhost` works
        // whichever address the browser tries first.
        const exclusive = 1 as UWS.ListenOptions; // LIBUS_LISTEN_EXCLUSIVE_PORT
        if (opts.host) {
            // The runtime accepts (host, port, options, cb); the typings don't list it.
            const listenOn = app.listen as unknown as (
                host: string,
                port: number,
                options: UWS.ListenOptions,
                cb: typeof done,
            ) => void;
            listenOn.call(app, opts.host, opts.port ?? 0, exclusive, done);
        } else {
            app.listen(opts.port ?? 0, exclusive, done);
        }
    });

    const flushTimer = setInterval(() => {
        if (Date.now() >= nextFlushAt) void flush();
    }, flushMs);
    const beat = encode({ type: Msg.Beat });
    const beatTimer = setInterval(() => app.publish('beat', beat, true), opts.beatMs ?? 15_000);
    log('relay listening', { port });

    return {
        port,
        async close() {
            clearInterval(flushTimer);
            clearInterval(beatTimer);
            while (flushing) await new Promise((r) => setTimeout(r, 10));
            await flush();
            for (const room of rooms.values()) if (room.closeTimer) clearTimeout(room.closeTimer);
            // Clients reconnect (to another relay, or this one restarted).
            for (const c of [...conns]) c.ws?.end(1001, 'Server restarting');
            app.close();
        },
        abort() {
            clearInterval(flushTimer);
            clearInterval(beatTimer);
            for (const room of rooms.values()) if (room.closeTimer) clearTimeout(room.closeTimer);
            rooms.clear();
            for (const c of [...conns]) c.ws?.close();
            app.close();
        },
        stats() {
            let pending = 0;
            for (const r of rooms.values()) pending += r.pending.length + r.inflight.length;
            return { connections: conns.size, rooms: rooms.size, pending };
        },
    };
}
