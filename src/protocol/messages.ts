import { ProtocolError, Reader, Writer } from './buffer';

/**
 * Wire messages. The first byte is the type. Types at or above RELAY_MIN are
 * ephemeral (live strokes, cursors, laser, camera): the server forwards them
 * to the rest of the room unread and never stores them.
 */

export const PROTOCOL_VERSION = 1;

export enum Msg {
    // client → server
    Hello = 1,
    Ops = 2,
    // server → client
    Welcome = 10,
    OpsRelay = 11,
    Ack = 12,
    Join = 13,
    Leave = 14,
    Error = 15,
    Beat = 16,
    // client → room, forwarded as-is
    Live = 32,
    LiveEnd = 33,
    Shape = 34,
    Cursor = 35,
    Laser = 36,
    Camera = 37,
}

export const RELAY_MIN = 32;

export interface PeerUser {
    id: string;
    name: string;
    color: string;
}

export interface Hello {
    type: Msg.Hello;
    proto: number;
    boardId: string;
    token: string;
    /** Room epoch the cursor belongs to; empty for a first join. */
    epoch: string;
    /** Last op sequence number received from the room. */
    cursor: number;
    user: PeerUser;
    /**
     * Only deliver saved-but-unacknowledged changes to this board: no board
     * download, no presence. Used to finish uploads for a board the user has
     * left. Sending another Hello switches rooms on the same connection.
     */
    writeOnly: boolean;
}

export interface Ops {
    type: Msg.Ops;
    /** Writer of these changes; with clientSeq it makes each change unique. */
    clientId: string;
    firstClientSeq: number;
    /** Encoded elements. */
    items: Uint8Array[];
}

export interface Welcome {
    type: Msg.Welcome;
    boardId: string;
    epoch: string;
    peer: number;
    /** true: `items` is the whole board. false: only what was missed. */
    full: boolean;
    seq: number;
    items: Uint8Array[];
    peers: { peer: number; user: PeerUser }[];
}

export interface OpsRelay {
    type: Msg.OpsRelay;
    firstSeq: number;
    items: Uint8Array[];
}

export interface Ack {
    type: Msg.Ack;
    boardId: string;
    clientId: string;
    upTo: number;
}

export interface Join {
    type: Msg.Join;
    peer: number;
    user: PeerUser;
}

export interface Leave {
    type: Msg.Leave;
    peer: number;
}

export interface ErrorMsg {
    type: Msg.Error;
    code: string;
    message: string;
}

export interface Beat {
    type: Msg.Beat;
}

/** Points of a stroke being drawn, from index `start` on. Scene coordinates. */
export interface Live {
    type: Msg.Live;
    peer: number;
    id: string;
    color: string;
    width: number;
    start: number;
    points: number[];
}

export interface LiveEnd {
    type: Msg.LiveEnd;
    peer: number;
    id: string;
}

/** A shape being dragged out, sent whole. */
export interface Shape {
    type: Msg.Shape;
    peer: number;
    item: Uint8Array;
}

export interface Cursor {
    type: Msg.Cursor;
    peer: number;
    visible: boolean;
    x: number;
    y: number;
}

export interface Laser {
    type: Msg.Laser;
    peer: number;
    /** These points begin a new trail rather than continue the last one. */
    start: boolean;
    points: number[];
}

export interface CameraMsg {
    type: Msg.Camera;
    peer: number;
    x: number;
    y: number;
    zoom: number;
}

export type Message =
    | Hello
    | Ops
    | Welcome
    | OpsRelay
    | Ack
    | Join
    | Leave
    | ErrorMsg
    | Beat
    | Live
    | LiveEnd
    | Shape
    | Cursor
    | Laser
    | CameraMsg;

const MAX_ITEMS = 50_000;

function writeUser(w: Writer, u: PeerUser): void {
    w.str(u.id).str(u.name).str(u.color);
}

function readUser(r: Reader): PeerUser {
    return { id: r.str(128), name: r.str(256), color: r.str(64) };
}

function writeItems(w: Writer, items: Uint8Array[]): void {
    w.uint(items.length);
    for (const it of items) w.block(it);
}

function readItems(r: Reader): Uint8Array[] {
    const n = r.uint();
    if (n > MAX_ITEMS) throw new ProtocolError('Too many items');
    const items = new Array<Uint8Array>(n);
    for (let i = 0; i < n; i++) items[i] = r.block(1 << 20);
    return items;
}

/** Absolute first point, then deltas, in tenths. */
function writePoints(w: Writer, pts: number[]): void {
    w.uint(pts.length / 2);
    let px = 0;
    let py = 0;
    for (let i = 0; i < pts.length; i += 2) {
        const x = Math.round(pts[i] * 10);
        const y = Math.round(pts[i + 1] * 10);
        w.int(x - px).int(y - py);
        px = x;
        py = y;
    }
}

function readPoints(r: Reader): number[] {
    const n = r.uint();
    if (n > 10_000) throw new ProtocolError('Too many points');
    const pts = new Array<number>(n * 2);
    let x = 0;
    let y = 0;
    for (let i = 0; i < n; i++) {
        x += r.int();
        y += r.int();
        pts[i * 2] = x / 10;
        pts[i * 2 + 1] = y / 10;
    }
    return pts;
}

export function encode(m: Message): Uint8Array {
    const w = new Writer();
    w.byte(m.type);
    switch (m.type) {
        case Msg.Hello:
            w.uint(m.proto).str(m.boardId).str(m.token).str(m.epoch).uint(m.cursor);
            writeUser(w, m.user);
            w.byte(m.writeOnly ? 1 : 0);
            break;
        case Msg.Ops:
            w.str(m.clientId).uint(m.firstClientSeq);
            writeItems(w, m.items);
            break;
        case Msg.Welcome:
            w.str(m.boardId).str(m.epoch).uint(m.peer).byte(m.full ? 1 : 0).uint(m.seq);
            writeItems(w, m.items);
            w.uint(m.peers.length);
            for (const p of m.peers) {
                w.uint(p.peer);
                writeUser(w, p.user);
            }
            break;
        case Msg.OpsRelay:
            w.uint(m.firstSeq);
            writeItems(w, m.items);
            break;
        case Msg.Ack:
            w.str(m.boardId).str(m.clientId).uint(m.upTo);
            break;
        case Msg.Join:
            w.uint(m.peer);
            writeUser(w, m.user);
            break;
        case Msg.Leave:
            w.uint(m.peer);
            break;
        case Msg.Error:
            w.str(m.code).str(m.message);
            break;
        case Msg.Beat:
            break;
        case Msg.Live:
            w.uint(m.peer).str(m.id).str(m.color).tenth(m.width).uint(m.start);
            writePoints(w, m.points);
            break;
        case Msg.LiveEnd:
            w.uint(m.peer).str(m.id);
            break;
        case Msg.Shape:
            w.uint(m.peer).block(m.item);
            break;
        case Msg.Cursor:
            w.uint(m.peer).byte(m.visible ? 1 : 0).tenth(m.x).tenth(m.y);
            break;
        case Msg.Laser:
            w.uint(m.peer).byte(m.start ? 1 : 0);
            writePoints(w, m.points);
            break;
        case Msg.Camera:
            w.uint(m.peer).tenth(m.x).tenth(m.y).uint(Math.round(m.zoom * 1000));
            break;
    }
    return w.finish();
}

export function decode(bytes: Uint8Array): Message {
    const r = new Reader(bytes);
    const type = r.byte();
    switch (type) {
        case Msg.Hello:
            return {
                type,
                proto: r.uint(),
                boardId: r.str(256),
                token: r.str(8192),
                epoch: r.str(64),
                cursor: r.uint(),
                user: readUser(r),
                writeOnly: r.byte() === 1,
            };
        case Msg.Ops:
            return { type, clientId: r.str(64), firstClientSeq: r.uint(), items: readItems(r) };
        case Msg.Welcome: {
            const boardId = r.str(256);
            const epoch = r.str(64);
            const peer = r.uint();
            const full = r.byte() === 1;
            const seq = r.uint();
            const items = readItems(r);
            const n = r.uint();
            const peers: Welcome['peers'] = [];
            for (let i = 0; i < n && i < 1000; i++) peers.push({ peer: r.uint(), user: readUser(r) });
            return { type, boardId, epoch, peer, full, seq, items, peers };
        }
        case Msg.OpsRelay:
            return { type, firstSeq: r.uint(), items: readItems(r) };
        case Msg.Ack:
            return { type, boardId: r.str(256), clientId: r.str(64), upTo: r.uint() };
        case Msg.Join:
            return { type, peer: r.uint(), user: readUser(r) };
        case Msg.Leave:
            return { type, peer: r.uint() };
        case Msg.Error:
            return { type, code: r.str(64), message: r.str(1024) };
        case Msg.Beat:
            return { type };
        case Msg.Live:
            return {
                type,
                peer: r.uint(),
                id: r.str(64),
                color: r.str(64),
                width: r.tenth(),
                start: r.uint(),
                points: readPoints(r),
            };
        case Msg.LiveEnd:
            return { type, peer: r.uint(), id: r.str(64) };
        case Msg.Shape:
            return { type, peer: r.uint(), item: r.block(1 << 16) };
        case Msg.Cursor:
            return { type, peer: r.uint(), visible: r.byte() === 1, x: r.tenth(), y: r.tenth() };
        case Msg.Laser:
            return { type, peer: r.uint(), start: r.byte() === 1, points: readPoints(r) };
        case Msg.Camera:
            return { type, peer: r.uint(), x: r.tenth(), y: r.tenth(), zoom: r.uint() / 1000 };
        default:
            throw new ProtocolError(`Unknown message type ${type}`);
    }
}
