import { Emitter } from '../emitter';
import type { RemoteLayer } from '../live';
import { nanoid } from '../model/geometry';
import type { Store } from '../model/store';
import {
    decode,
    decodeElementBinary,
    encode,
    encodeElementBinary,
    Msg,
    PROTOCOL_VERSION,
    type Message,
    type PeerUser,
} from '../protocol';
import type { Camera, ChangeEvent, Element, LiveEvent } from '../types';
import { defaultOutbox, type OutboxEntry, type OutboxStore } from './outbox';

/** What the sync client needs from a board. `Whiteboard` provides all of it. */
export interface SyncTarget {
    readonly boardId: string | undefined;
    readonly store: Store;
    readonly remote?: RemoteLayer;
    readonly camera?: Camera;
    merge(elements: Iterable<Element>): unknown;
    setCamera?(camera: Camera): void;
    on(event: 'change', fn: (e: ChangeEvent) => void): () => void;
    on(event: 'live', fn: (e: LiveEvent) => void): () => void;
    on(event: 'load', fn: (e: { boardId: string | undefined }) => void): () => void;
    on(event: 'camera', fn: (c: Camera) => void): () => void;
}

export interface SyncOptions {
    /** Relay address, e.g. `wss://board.example.com`. */
    url: string;
    /** Login token the server checks; a function is called on every connect. */
    token?: string | (() => string | Promise<string>);
    user: { id: string; name: string; color?: string };
    /** Where unconfirmed changes wait. Default: IndexedDB, else memory. */
    outbox?: OutboxStore;
    /** WebSocket implementation, for environments without a global one. */
    WebSocket?: typeof WebSocket;
}

export type SyncStatus = 'connecting' | 'online' | 'offline' | 'denied' | 'closed';

export interface SyncPeer {
    peer: number;
    user: PeerUser;
}

export interface SyncEvents {
    status: SyncStatus;
    peers: SyncPeer[];
    /** Changes not yet confirmed saved; 0 means everything is safe. */
    pending: number;
    /**
     * The board finished loading after a join or board switch. `elements` is
     * how many it has, e.g. to import old content into an empty board.
     */
    joined: { boardId: string; full: boolean; elements: number };
    error: { code: string; message: string };
}

/** Live batches go out this often; less often when the connection backs up. */
const LIVE_MS = 50;
const LIVE_SLOW_MS = 200;
/** Unsent bytes above this mean the network is not keeping up. */
const CONGESTED_BYTES = 32 * 1024;
const POINTER_MS = 100;
const CAMERA_MS = 100;
/** No message (the server beats every 15 s) for this long: reconnect. */
const SILENCE_MS = 35_000;
/** A connection attempt that hasn't opened by now is abandoned and retried. */
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_OPS_PER_MESSAGE = 500;

interface StrokeBuffer {
    color: string;
    width: number;
    /** Index of the first point in `points`. */
    start: number;
    points: number[];
}

/**
 * Keeps a board in sync through a liteboard relay.
 *
 * Saved changes travel with acknowledgements: each one waits in the outbox
 * until the server confirms it is in the database, and is sent again after
 * any reconnect. Live activity (strokes being drawn, shapes, laser, pointer)
 * is sent in small batches and dropped first when the network is slow.
 */
export class SyncClient {
    /** Identifies this client's uploads; unique per instance. */
    readonly writerId = nanoid(12);
    private events = new Emitter<SyncEvents>();
    private ws: WebSocket | null = null;
    private statusValue: SyncStatus = 'connecting';
    private closed = false;
    private cseq = 0;
    private entries: OutboxEntry[] = [];
    private outbox: OutboxStore;
    /** Highest sequence sent on the current socket, by board and writer. */
    private sent = new Map<string, number>();
    /** Board whose Welcome arrived on this socket; messages for others are stale. */
    private joined: string | null = null;
    private epoch = '';
    private cursor = 0;
    private peerNo = 0;
    private peerMap = new Map<number, PeerUser>();
    private attempts = 0;
    private lastMessageAt = 0;
    private openedAt = 0;
    private timers = { ops: 0, live: 0, reconnect: 0, watchdog: 0 };
    private offs: (() => void)[] = [];

    // Live state waiting for the next batch.
    private strokes = new Map<string, StrokeBuffer>();
    private strokeEnds: string[] = [];
    private shape: { el: Element | null } | null = null;
    private laser: { start: boolean; points: number[] }[] = [];
    private pointer: { x: number; y: number; visible: boolean } | null = null;
    private lastPointerSent = 0;
    private presenting = false;
    private cameraDirty = false;
    private lastCameraSent = 0;
    private following: number | 'any' | null = null;

    constructor(
        private target: SyncTarget,
        private opts: SyncOptions,
    ) {
        this.outbox = opts.outbox ?? defaultOutbox();
        this.offs.push(
            target.on('change', this.onChange),
            target.on('live', this.onLive),
            target.on('load', this.onLoad),
            target.on('camera', () => {
                if (!this.presenting) return;
                this.cameraDirty = true;
                this.scheduleLive();
            }),
        );
        if (typeof window !== 'undefined') {
            const wake = () => {
                if (this.statusValue === 'offline') this.reconnectNow();
            };
            // A page kept in the back/forward cache stays connected unless
            // told otherwise, and would show up as a ghost in the room.
            const hide = (e: PageTransitionEvent) => {
                if (e.persisted) this.suspend();
            };
            const show = (e: PageTransitionEvent) => {
                if (e.persisted) this.reconnectNow();
            };
            window.addEventListener('online', wake);
            document.addEventListener('visibilitychange', wake);
            window.addEventListener('pagehide', hide);
            window.addEventListener('pageshow', show);
            this.offs.push(() => {
                window.removeEventListener('online', wake);
                document.removeEventListener('visibilitychange', wake);
                window.removeEventListener('pagehide', hide);
                window.removeEventListener('pageshow', show);
            });
        }
        this.timers.watchdog = setInterval(() => {
            const ws = this.ws;
            if (!ws) return;
            const silent = ws.readyState === 1 && Date.now() - this.lastMessageAt > SILENCE_MS;
            // A half-open network can leave an attempt hanging with no error,
            // or a close waiting forever for a server that is gone.
            const stuck = ws.readyState === 0 && Date.now() - this.openedAt > CONNECT_TIMEOUT_MS;
            const closing = ws.readyState >= 2;
            if (silent || stuck || closing) this.drop(ws);
        }, 1000) as unknown as number;

        this.outbox
            .all()
            .catch(() => [] as OutboxEntry[])
            .then((saved) => {
                // Unconfirmed changes from earlier visits go first, in order.
                this.entries = [...saved, ...this.entries];
                this.emitPending();
                this.open();
            });
    }

    // ---- Public API ------------------------------------------------------------

    get status(): SyncStatus {
        return this.statusValue;
    }

    get peers(): SyncPeer[] {
        return [...this.peerMap].map(([peer, user]) => ({ peer, user }));
    }

    /** Number of changes not yet confirmed saved. */
    get pending(): number {
        return this.entries.length;
    }

    /** This connection's peer number in the room. */
    get self(): number {
        return this.peerNo;
    }

    /** Shares this board's camera so followers see what you see. */
    present(on: boolean): void {
        this.presenting = on;
        if (on) {
            this.cameraDirty = true;
            this.scheduleLive();
        }
    }

    /**
     * Follows a peer's camera; `'any'` follows whoever is presenting; null
     * stops following.
     */
    follow(peer: number | 'any' | null): void {
        this.following = peer;
    }

    on<K extends keyof SyncEvents>(event: K, fn: (payload: SyncEvents[K]) => void): () => void {
        return this.events.on(event, fn);
    }

    close(): void {
        this.closed = true;
        for (const t of [this.timers.ops, this.timers.live, this.timers.reconnect]) clearTimeout(t);
        clearInterval(this.timers.watchdog);
        this.offs.forEach((off) => off());
        this.offs = [];
        this.ws?.close();
        this.ws = null;
        this.target.remote?.clear();
        this.setStatus('closed');
    }

    // ---- Connection --------------------------------------------------------------

    private setStatus(s: SyncStatus): void {
        if (s === this.statusValue) return;
        this.statusValue = s;
        this.events.emit('status', s);
    }

    private open(): void {
        if (this.closed) return;
        const WS = this.opts.WebSocket ?? globalThis.WebSocket;
        const ws = new WS(this.opts.url);
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        this.openedAt = Date.now();
        this.setStatus('connecting');
        ws.onopen = () => {
            if (ws === this.ws) void this.onOpen(ws);
        };
        ws.onmessage = (ev: MessageEvent) => {
            if (ws !== this.ws) return;
            this.lastMessageAt = Date.now();
            let msg: Message;
            try {
                msg = decode(new Uint8Array(ev.data as ArrayBuffer));
            } catch {
                ws.close();
                return;
            }
            this.onMessage(msg);
        };
        ws.onclose = () => this.drop(ws);
        ws.onerror = () => {
            // A close event follows; handled there.
        };
    }

    /** Forgets a socket (closed, silent or stuck) and plans the next attempt. */
    private drop(ws: WebSocket): void {
        if (ws !== this.ws) return;
        this.ws = null;
        ws.onopen = ws.onmessage = ws.onclose = null;
        try {
            ws.close();
        } catch {
            // Already closed.
        }
        this.resetSocketState();
        if (this.closed || this.statusValue === 'denied') return;
        this.setStatus('offline');
        this.scheduleReconnect();
    }

    private resetSocketState(): void {
        this.joined = null;
        this.sent.clear();
        this.peerMap.clear();
        this.target.remote?.clear();
        this.events.emit('peers', []);
    }

    private scheduleReconnect(): void {
        clearTimeout(this.timers.reconnect);
        // Exponential backoff with jitter, so a server restart is not met by
        // every client at the same instant.
        const delay = Math.min(10_000, 400 * 2 ** this.attempts) * (0.6 + Math.random() * 0.4);
        this.attempts++;
        this.timers.reconnect = setTimeout(() => this.open(), delay) as unknown as number;
    }

    /** Disconnects without reconnecting until the page is shown again. */
    private suspend(): void {
        const ws = this.ws;
        if (!ws) return;
        this.ws = null;
        ws.onopen = ws.onmessage = ws.onclose = null;
        ws.close();
        clearTimeout(this.timers.reconnect);
        this.resetSocketState();
        this.setStatus('offline');
    }

    private reconnectNow(): void {
        clearTimeout(this.timers.reconnect);
        this.attempts = 0;
        if (!this.ws) this.open();
    }

    private async token(): Promise<string> {
        const t = this.opts.token;
        return typeof t === 'function' ? await t() : (t ?? '');
    }

    private send(m: Message): void {
        if (this.ws?.readyState === 1) this.ws.send(encode(m));
    }

    private async onOpen(ws: WebSocket): Promise<void> {
        this.attempts = 0;
        this.lastMessageAt = Date.now();
        const token = await this.token();
        if (ws !== this.ws) return;
        this.uploadOtherBoards(token);
        this.join(token);
    }

    private hello(boardId: string, token: string, writeOnly: boolean): void {
        this.send({
            type: Msg.Hello,
            proto: PROTOCOL_VERSION,
            boardId,
            token,
            epoch: writeOnly ? '' : this.epoch,
            cursor: writeOnly ? 0 : this.cursor,
            user: {
                id: this.opts.user.id,
                name: this.opts.user.name,
                color: this.opts.user.color ?? '#4c6ef5',
            },
            writeOnly,
        });
    }

    private join(token: string): void {
        const board = this.target.boardId;
        if (!board) return;
        this.joined = null;
        this.hello(board, token, false);
    }

    /** Finishes uploads for boards the user has left. */
    private uploadOtherBoards(token: string): void {
        const current = this.target.boardId;
        const boards = new Set(this.entries.map((e) => e.boardId));
        for (const board of boards) {
            if (board === current || !this.hasUnsent(board)) continue;
            this.hello(board, token, true);
            this.sendEntries(board);
        }
    }

    // ---- Saved changes -------------------------------------------------------------

    private onChange = (e: ChangeEvent) => {
        const board = this.target.boardId;
        if (e.origin !== 'local' || !board) return;
        const added: OutboxEntry[] = [];
        for (const el of e.elements) {
            this.strokes.delete(el.id);
            added.push({
                boardId: board,
                clientId: this.writerId,
                cseq: ++this.cseq,
                item: encodeElementBinary(el),
            });
        }
        this.entries.push(...added);
        this.outbox.add(added).catch(() => {
            // Persistence failed (quota, private mode): the entries are still
            // held in memory and sent; only a crash right now could lose them.
        });
        this.emitPending();
        if (!this.timers.ops) {
            this.timers.ops = setTimeout(() => {
                this.timers.ops = 0;
                if (this.joined && this.joined === this.target.boardId) this.sendEntries(this.joined);
            }, 30) as unknown as number;
        }
    };

    private sentKey(board: string, clientId: string): string {
        return board + '\u0000' + clientId;
    }

    private hasUnsent(board: string): boolean {
        return this.entries.some(
            (e) => e.boardId === board && e.cseq > (this.sent.get(this.sentKey(board, e.clientId)) ?? 0),
        );
    }

    /** Sends a board's unsent entries, as runs of consecutive sequence numbers. */
    private sendEntries(board: string): void {
        if (this.ws?.readyState !== 1) return;
        let run: OutboxEntry[] = [];
        const flush = () => {
            if (run.length === 0) return;
            this.send({
                type: Msg.Ops,
                clientId: run[0].clientId,
                firstClientSeq: run[0].cseq,
                items: run.map((e) => e.item),
            });
            this.sent.set(this.sentKey(board, run[0].clientId), run[run.length - 1].cseq);
            run = [];
        };
        for (const e of this.entries) {
            if (e.boardId !== board) continue;
            if (e.cseq <= (this.sent.get(this.sentKey(board, e.clientId)) ?? 0)) continue;
            const last = run[run.length - 1];
            if (
                last &&
                (last.clientId !== e.clientId ||
                    last.cseq + 1 !== e.cseq ||
                    run.length >= MAX_OPS_PER_MESSAGE)
            ) {
                flush();
            }
            run.push(e);
        }
        flush();
    }

    private emitPending(): void {
        this.events.emit('pending', this.entries.length);
    }

    private onLoad = () => {
        // Anything waiting for the old board goes out before switching rooms.
        clearTimeout(this.timers.ops);
        this.timers.ops = 0;
        if (this.joined) this.sendEntries(this.joined);
        this.epoch = '';
        this.cursor = 0;
        this.strokes.clear();
        this.shape = null;
        this.laser = [];
        this.resetPresence();
        if (this.ws?.readyState === 1) {
            void this.token().then((token) => {
                this.uploadOtherBoards(token);
                this.join(token);
            });
        }
    };

    private resetPresence(): void {
        this.joined = null;
        this.peerMap.clear();
        this.target.remote?.clear();
        this.events.emit('peers', []);
    }

    // ---- Incoming --------------------------------------------------------------------

    private onMessage(m: Message): void {
        const current = this.target.boardId;
        switch (m.type) {
            case Msg.Welcome: {
                if (m.boardId !== current) return;
                this.target.merge(m.items.map(decodeElementBinary));
                this.epoch = m.epoch;
                this.cursor = m.seq;
                this.peerNo = m.peer;
                this.peerMap.clear();
                for (const p of m.peers) this.addPeer(p.peer, p.user);
                this.joined = m.boardId;
                this.events.emit('peers', this.peers);
                this.setStatus('online');
                this.sendEntries(m.boardId);
                this.events.emit('joined', {
                    boardId: m.boardId,
                    full: m.full,
                    elements: this.target.store.elements().length,
                });
                return;
            }
            case Msg.Ack: {
                const before = this.entries.length;
                this.entries = this.entries.filter(
                    (e) => !(e.boardId === m.boardId && e.clientId === m.clientId && e.cseq <= m.upTo),
                );
                if (this.entries.length !== before) {
                    this.outbox.ack(m.boardId, m.clientId, m.upTo).catch(() => {});
                    this.emitPending();
                }
                return;
            }
            case Msg.Error:
                this.events.emit('error', { code: m.code, message: m.message });
                if (m.code === 'denied') {
                    this.setStatus('denied');
                    this.ws?.close();
                }
                return;
            case Msg.Beat:
                return;
        }
        // Everything else belongs to the joined room; anything arriving before
        // the Welcome is from the room we just left.
        if (!this.joined || this.joined !== current) return;
        const remote = this.target.remote;
        switch (m.type) {
            case Msg.OpsRelay:
                this.target.merge(m.items.map(decodeElementBinary));
                this.cursor = m.firstSeq + m.items.length - 1;
                return;
            case Msg.Join:
                this.addPeer(m.peer, m.user);
                this.events.emit('peers', this.peers);
                return;
            case Msg.Leave:
                this.peerMap.delete(m.peer);
                remote?.removePeer(String(m.peer));
                this.events.emit('peers', this.peers);
                return;
            case Msg.Live:
                remote?.stroke(String(m.peer), m.id, m.color, m.width, m.start, m.points);
                return;
            case Msg.LiveEnd:
                remote?.endStroke(String(m.peer), m.id);
                return;
            case Msg.Shape:
                remote?.shape(String(m.peer), m.item.length ? decodeElementBinary(m.item) : null);
                return;
            case Msg.Cursor:
                remote?.cursor(String(m.peer), m.x, m.y, m.visible);
                return;
            case Msg.Laser:
                remote?.laser(String(m.peer), m.points, m.start);
                return;
            case Msg.Camera:
                if (this.following === m.peer || this.following === 'any') {
                    this.target.setCamera?.({ x: m.x, y: m.y, zoom: m.zoom });
                }
                return;
        }
    }

    private addPeer(peer: number, user: PeerUser): void {
        this.peerMap.set(peer, user);
        this.target.remote?.setPeer(String(peer), { name: user.name, color: user.color });
    }

    // ---- Live activity -----------------------------------------------------------------

    private onLive = (e: LiveEvent) => {
        if (!this.joined || this.joined !== this.target.boardId) return;
        switch (e.kind) {
            case 'stroke': {
                let s = this.strokes.get(e.id);
                if (!s) {
                    s = { color: e.color, width: e.width, start: e.index, points: [] };
                    this.strokes.set(e.id, s);
                }
                s.points.push(e.x, e.y);
                break;
            }
            case 'strokeEnd':
                this.strokes.delete(e.id);
                this.strokeEnds.push(e.id);
                break;
            case 'shape':
                this.shape = { el: e.el };
                break;
            case 'laser': {
                const last = this.laser[this.laser.length - 1];
                if (e.start || !last) this.laser.push({ start: e.start, points: [e.x, e.y] });
                else last.points.push(e.x, e.y);
                break;
            }
            case 'pointer':
                this.pointer = { x: e.x, y: e.y, visible: e.visible };
                break;
        }
        this.scheduleLive();
    };

    private congested(): boolean {
        return (this.ws?.bufferedAmount ?? 0) > CONGESTED_BYTES;
    }

    private scheduleLive(): void {
        if (this.timers.live) return;
        const wait = this.congested() ? LIVE_SLOW_MS : LIVE_MS;
        this.timers.live = setTimeout(this.flushLive, wait) as unknown as number;
    }

    private flushLive = () => {
        this.timers.live = 0;
        if (!this.joined || this.ws?.readyState !== 1) return;
        const peer = this.peerNo;
        const slow = this.congested();
        let again = false;

        // Stroke points are always sent (they carry their start index, so a
        // slow link just gets bigger batches). Everything else can be skipped.
        for (const [id, s] of this.strokes) {
            if (s.points.length === 0) continue;
            this.send({ type: Msg.Live, peer, id, color: s.color, width: s.width, start: s.start, points: s.points });
            s.start += s.points.length / 2;
            s.points = [];
        }
        for (const id of this.strokeEnds) this.send({ type: Msg.LiveEnd, peer, id });
        this.strokeEnds = [];

        if (!slow) {
            if (this.shape) {
                const el = this.shape.el;
                this.send({ type: Msg.Shape, peer, item: el ? encodeElementBinary(el) : new Uint8Array(0) });
            }
            for (const seg of this.laser) {
                this.send({ type: Msg.Laser, peer, start: seg.start, points: seg.points });
            }
        }
        this.shape = null;
        this.laser = [];

        const now = Date.now();
        if (this.pointer) {
            if (!slow && now - this.lastPointerSent >= POINTER_MS) {
                const p = this.pointer;
                this.send({ type: Msg.Cursor, peer, visible: p.visible, x: p.x, y: p.y });
                this.pointer = null;
                this.lastPointerSent = now;
            } else {
                again = true;
            }
        }
        if (this.cameraDirty && this.target.camera) {
            if (!slow && now - this.lastCameraSent >= CAMERA_MS) {
                const c = this.target.camera;
                this.send({ type: Msg.Camera, peer, x: c.x, y: c.y, zoom: c.zoom });
                this.cameraDirty = false;
                this.lastCameraSent = now;
            } else {
                again = true;
            }
        }
        if (again) this.scheduleLive();
    };
}

/** Connects a board to a liteboard relay. Call `close()` to disconnect. */
export function connect(target: SyncTarget, options: SyncOptions): SyncClient {
    return new SyncClient(target, options);
}
