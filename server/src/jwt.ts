import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PeerUser } from '../../src/protocol';
import type { Access } from './relay';

/**
 * Claims liteboard reads from an HS256 token your backend signs:
 *   sub    user id (required)
 *   name   display name
 *   boards board id prefix the token may open, e.g. "session-123:" (required)
 *   write  false for read-only (default true)
 *   exp    expiry, seconds since epoch (required)
 */
export interface BoardClaims {
    sub: string;
    name?: string;
    boards: string;
    write?: boolean;
    exp: number;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

export function signToken(claims: BoardClaims, secret: string): string {
    const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
    const body = b64url(Buffer.from(JSON.stringify(claims)));
    const sig = b64url(createHmac('sha256', secret).update(`${header}.${body}`).digest());
    return `${header}.${body}.${sig}`;
}

export function verifyToken(token: string, secret: string): BoardClaims | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    try {
        if (JSON.parse(Buffer.from(header, 'base64url').toString()).alg !== 'HS256') return null;
        const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest();
        const given = Buffer.from(sig, 'base64url');
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
        const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as BoardClaims;
        if (typeof claims.sub !== 'string' || typeof claims.boards !== 'string') return null;
        if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null;
        return claims;
    } catch {
        return null;
    }
}

/** An `authorize` hook for the relay that checks HS256 tokens. */
export function jwtAuthorizer(secret: string) {
    return (token: string, boardId: string, user: PeerUser): Access | null => {
        const claims = verifyToken(token, secret);
        if (!claims || !boardId.startsWith(claims.boards)) return null;
        return {
            canWrite: claims.write !== false,
            // The token, not the client, decides who this is.
            user: { id: claims.sub, name: claims.name ?? user.name, color: user.color },
        };
    };
}
