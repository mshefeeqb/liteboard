/**
 * Minimal binary writer/reader: unsigned and zigzag varints (LEB128),
 * length-prefixed UTF-8 strings and raw bytes. Small numbers take one byte,
 * which is what makes delta-encoded points compact.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class Writer {
    private buf: Uint8Array;
    private pos = 0;

    constructor(size = 256) {
        this.buf = new Uint8Array(size);
    }

    private ensure(n: number): void {
        if (this.pos + n <= this.buf.length) return;
        let size = this.buf.length * 2;
        while (size < this.pos + n) size *= 2;
        const next = new Uint8Array(size);
        next.set(this.buf.subarray(0, this.pos));
        this.buf = next;
    }

    byte(v: number): this {
        this.ensure(1);
        this.buf[this.pos++] = v & 255;
        return this;
    }

    /** Unsigned integer up to 2^53. */
    uint(v: number): this {
        this.ensure(8);
        while (v >= 128) {
            this.buf[this.pos++] = (v % 128) | 128;
            v = Math.floor(v / 128);
        }
        this.buf[this.pos++] = v;
        return this;
    }

    /** Signed integer: zigzag keeps small negatives small. */
    int(v: number): this {
        return this.uint(v >= 0 ? v * 2 : -v * 2 - 1);
    }

    /** A number at 0.1 precision, the precision scenes are stored at. */
    tenth(v: number): this {
        return this.int(Math.round(v * 10));
    }

    str(s: string): this {
        const bytes = encoder.encode(s);
        this.uint(bytes.length);
        return this.bytes(bytes);
    }

    bytes(b: Uint8Array): this {
        this.ensure(b.length);
        this.buf.set(b, this.pos);
        this.pos += b.length;
        return this;
    }

    /** Raw bytes prefixed with their length. */
    block(b: Uint8Array): this {
        this.uint(b.length);
        return this.bytes(b);
    }

    get length(): number {
        return this.pos;
    }

    finish(): Uint8Array {
        return this.buf.slice(0, this.pos);
    }
}

export class ProtocolError extends Error {}

export class Reader {
    pos = 0;

    constructor(readonly buf: Uint8Array) {}

    get done(): boolean {
        return this.pos >= this.buf.length;
    }

    byte(): number {
        if (this.pos >= this.buf.length) throw new ProtocolError('Unexpected end of message');
        return this.buf[this.pos++];
    }

    uint(): number {
        let v = 0;
        let mul = 1;
        for (let i = 0; i < 8; i++) {
            const b = this.byte();
            v += (b & 127) * mul;
            if (b < 128) return v;
            mul *= 128;
        }
        throw new ProtocolError('Varint too long');
    }

    int(): number {
        const v = this.uint();
        return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
    }

    tenth(): number {
        return this.int() / 10;
    }

    str(max = 1 << 16): string {
        const n = this.uint();
        if (n > max) throw new ProtocolError('String too long');
        return decoder.decode(this.bytes(n));
    }

    bytes(n: number): Uint8Array {
        if (this.pos + n > this.buf.length) throw new ProtocolError('Unexpected end of message');
        const out = this.buf.subarray(this.pos, this.pos + n);
        this.pos += n;
        return out;
    }

    block(max = 1 << 20): Uint8Array {
        const n = this.uint();
        if (n > max) throw new ProtocolError('Block too large');
        return this.bytes(n);
    }
}
