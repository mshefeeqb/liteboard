import { describe, expect, it } from 'vitest';
import { Reader, Writer } from '../src/protocol/buffer';
import { decodeElementBinary, encodeElementBinary, readElementHeader } from '../src/protocol/element';
import { decode, encode, Msg } from '../src/protocol/messages';
import { relativePoints } from '../src/model/geometry';
import type { Element } from '../src/types';

describe('varints', () => {
    it('round-trips unsigned, signed and large values', () => {
        const values = [0, 1, 127, 128, 300, 2 ** 31, 2 ** 52];
        const signed = [0, -1, 1, -64, 64, -100000, 123456789];
        const w = new Writer(4);
        values.forEach((v) => w.uint(v));
        signed.forEach((v) => w.int(v));
        w.str('héllo ✏️');
        const r = new Reader(w.finish());
        expect(values.map(() => r.uint())).toEqual(values);
        expect(signed.map(() => r.int())).toEqual(signed);
        expect(r.str()).toBe('héllo ✏️');
        expect(r.done).toBe(true);
    });

    it('rejects truncated input', () => {
        const bytes = new Writer().str('abcdef').finish();
        expect(() => new Reader(bytes.subarray(0, 3)).str()).toThrow();
    });
});

function handwriting(id: string, n = 20): Element {
    const abs: number[] = [];
    for (let i = 0; i < n; i++) abs.push(400 + i * 1.7, 300 + Math.sin(i / 3) * 6);
    return { id, t: 'pen', ...relativePoints(abs), c: '#1e1e1e', sw: 1, z: 42, v: 1234, by: 'k3j4h5g6f7d8' };
}

describe('binary elements', () => {
    it('round-trips every field', () => {
        const el: Element = {
            ...handwriting('a1b2c3d4e5'),
            pr: [10, 200, 255],
            fill: '#FFEC99',
            txt: 'x² = 4',
            fs: 20,
        };
        const back = decodeElementBinary(encodeElementBinary(el));
        expect(back).toEqual({ ...el, fill: '#ffec99' });
        expect(readElementHeader(encodeElementBinary(el))).toEqual({ id: el.id, v: el.v, by: el.by });
    });

    it('encodes a handwritten stroke in about 100 bytes', () => {
        const el = handwriting('a1b2c3d4e5');
        const binary = encodeElementBinary(el).length;
        const json = JSON.stringify(el).length;
        expect(binary).toBeLessThan(110);
        expect(binary * 2).toBeLessThan(json);
    });

    it('keeps tombstones tiny', () => {
        const { pts: _p, ...rest } = handwriting('a1b2c3d4e5');
        expect(encodeElementBinary({ ...rest, del: 1 }).length).toBeLessThan(45);
    });
});

describe('messages', () => {
    it('round-trips each message type', () => {
        const item = encodeElementBinary(handwriting('x'));
        const user = { id: 'u1', name: 'Teacher', color: '#e03131' };
        const messages = [
            { type: Msg.Hello, proto: 1, boardId: 's:1:2:0', token: 't', epoch: '', cursor: 0, user, writeOnly: false },
            { type: Msg.Ops, clientId: 'c1', firstClientSeq: 7, items: [item, item] },
            { type: Msg.Welcome, boardId: 's:1:2:0', epoch: 'e1', peer: 3, full: true, seq: 99, items: [item], peers: [{ peer: 1, user }] },
            { type: Msg.OpsRelay, firstSeq: 100, items: [item] },
            { type: Msg.Ack, boardId: 's:1:2:0', clientId: 'c1', upTo: 8 },
            { type: Msg.Join, peer: 2, user },
            { type: Msg.Leave, peer: 2 },
            { type: Msg.Error, code: 'auth', message: 'Not allowed' },
            { type: Msg.Beat },
            { type: Msg.Live, peer: 1, id: 's1', color: '#1e1e1e', width: 1, start: 12, points: [10.5, 20, 11, 21.5] },
            { type: Msg.LiveEnd, peer: 1, id: 's1' },
            { type: Msg.Shape, peer: 1, item },
            { type: Msg.Cursor, peer: 1, visible: true, x: -12.3, y: 45.6 },
            { type: Msg.Laser, peer: 1, start: true, points: [1, 2, 3, 4] },
            { type: Msg.Camera, peer: 1, x: -100, y: 250.5, zoom: 1.25 },
        ] as const;
        for (const m of messages) {
            expect(decode(encode(m as never))).toEqual(m);
        }
    });
});
