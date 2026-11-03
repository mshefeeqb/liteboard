import { Reader, Writer } from '../../src/protocol';
import {
    mergeItems,
    SeqConflictError,
    type BoardStorage,
    type LoadResult,
    type StoredOp,
} from './storage';

/** Anything with node-postgres's `query`: a `pg.Pool`, a `pg.Client`, PGlite. */
export interface Queryable {
    query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export const SCHEMA = `
create table if not exists liteboard_ops (
    board_id   text        not null,
    seq        bigint      not null,
    client_id  text        not null,
    cseq       bigint      not null,
    item       bytea       not null,
    created_at timestamptz not null default now(),
    primary key (board_id, seq)
);
create unique index if not exists liteboard_ops_writer
    on liteboard_ops (board_id, client_id, cseq);

create table if not exists liteboard_snapshots (
    board_id   text        primary key,
    seq        bigint      not null,
    items      bytea       not null,
    updated_at timestamptz not null default now()
);
`;

/** Rows per INSERT: 5 parameters each keeps well under Postgres's 65,535 limit. */
const ROWS_PER_INSERT = 1000;

/** Ops above this count are folded into the snapshot when a room closes. */
const COMPACT_AFTER = 200;

const toBytes = (v: unknown): Uint8Array => (v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer));

function packItems(items: Uint8Array[]): Uint8Array {
    const w = new Writer(1024);
    w.uint(items.length);
    for (const it of items) w.block(it);
    return w.finish();
}

function unpackItems(bytes: Uint8Array): Uint8Array[] {
    const r = new Reader(bytes);
    const n = r.uint();
    const out: Uint8Array[] = [];
    for (let i = 0; i < n; i++) out.push(r.block(1 << 20).slice());
    return out;
}

/**
 * Postgres storage: one row per change while a board is in use, folded into
 * one snapshot row when its room closes. Writes are batched and idempotent.
 */
export class PostgresStorage implements BoardStorage {
    constructor(private db: Queryable) {}

    /** Creates the tables if they don't exist. */
    async migrate(): Promise<void> {
        for (const statement of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
            await this.db.query(statement);
        }
    }

    async maxSeq(boardId: string): Promise<number> {
        const { rows } = await this.db.query(
            `select greatest(
                (select coalesce(max(seq), 0) from liteboard_ops where board_id = $1),
                (select coalesce(max(seq), 0) from liteboard_snapshots where board_id = $1)
            ) as seq`,
            [boardId],
        );
        return Number(rows[0].seq);
    }

    async load(boardId: string, since: number): Promise<LoadResult> {
        const snap = await this.db.query(
            'select seq, items from liteboard_snapshots where board_id = $1',
            [boardId],
        );
        const snapSeq = snap.rows.length ? Number(snap.rows[0].seq) : 0;
        const full = since === 0 || since < snapSeq;
        const after = full ? snapSeq : since;
        const ops = await this.db.query(
            'select seq, item from liteboard_ops where board_id = $1 and seq > $2 order by seq',
            [boardId, after],
        );
        const items = ops.rows.map((r) => ({ seq: Number(r.seq), item: toBytes(r.item) }));
        if (full && snap.rows.length) {
            const base = unpackItems(toBytes(snap.rows[0].items)).map((item) => ({ seq: snapSeq, item }));
            return { full, items: [...base, ...items] };
        }
        return { full, items };
    }

    async append(ops: StoredOp[]): Promise<void> {
        for (let i = 0; i < ops.length; i += ROWS_PER_INSERT) {
            const chunk = ops.slice(i, i + ROWS_PER_INSERT);
            const params: unknown[] = [];
            const rows = chunk.map((op, k) => {
                params.push(op.boardId, op.seq, op.clientId, op.cseq, op.item);
                const b = k * 5;
                return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`;
            });
            try {
                // A resent change (same writer and number) is skipped, not doubled.
                await this.db.query(
                    `insert into liteboard_ops (board_id, seq, client_id, cseq, item)
                     values ${rows.join(', ')}
                     on conflict (board_id, client_id, cseq) do nothing`,
                    params,
                );
            } catch (err) {
                const e = err as { code?: string; constraint?: string; message?: string };
                if (e.code === '23505' && !String(e.constraint ?? e.message).includes('writer')) {
                    throw new SeqConflictError(chunk[0].boardId);
                }
                throw err;
            }
        }
    }

    async compact(boardId: string): Promise<void> {
        const { rows } = await this.db.query(
            'select count(*)::int as n from liteboard_ops where board_id = $1',
            [boardId],
        );
        if (Number(rows[0].n) < COMPACT_AFTER) return;
        const seq = await this.maxSeq(boardId);
        const all = await this.load(boardId, 0);
        const items = mergeItems(all.items.filter((i) => i.seq <= seq).map((i) => i.item));
        // Snapshot first, then delete: a crash in between only leaves rows
        // that loading merges again, never a gap.
        await this.db.query(
            `insert into liteboard_snapshots (board_id, seq, items, updated_at)
             values ($1, $2, $3, now())
             on conflict (board_id) do update set seq = excluded.seq, items = excluded.items, updated_at = now()`,
            [boardId, seq, packItems(items)],
        );
        await this.db.query('delete from liteboard_ops where board_id = $1 and seq <= $2', [boardId, seq]);
    }

    /** Deletes boards, e.g. every board of a deleted session: `deleteBoards('session-123:%')`. */
    async deleteBoards(likePattern: string): Promise<void> {
        await this.db.query('delete from liteboard_ops where board_id like $1', [likePattern]);
        await this.db.query('delete from liteboard_snapshots where board_id like $1', [likePattern]);
    }
}
