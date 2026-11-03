/**
 * Changes waiting for the server to confirm they are saved. An entry is
 * removed only when an acknowledgement for it arrives, so closing the tab,
 * a crash or a dropped connection never loses a stroke: it is sent again
 * next time.
 */

export interface OutboxEntry {
    boardId: string;
    /** Writer id and sequence number: together they make the change unique. */
    clientId: string;
    cseq: number;
    /** The element, binary-encoded. */
    item: Uint8Array;
}

export interface OutboxStore {
    all(): Promise<OutboxEntry[]>;
    add(entries: OutboxEntry[]): Promise<void>;
    /** Removes a writer's entries for a board up to and including `upTo`. */
    ack(boardId: string, clientId: string, upTo: number): Promise<void>;
}

export class MemoryOutbox implements OutboxStore {
    private entries: OutboxEntry[] = [];

    async all(): Promise<OutboxEntry[]> {
        return [...this.entries];
    }

    async add(entries: OutboxEntry[]): Promise<void> {
        this.entries.push(...entries);
    }

    async ack(boardId: string, clientId: string, upTo: number): Promise<void> {
        this.entries = this.entries.filter(
            (e) => !(e.boardId === boardId && e.clientId === clientId && e.cseq <= upTo),
        );
    }
}

const DB_NAME = 'liteboard';
const STORE = 'outbox';

function request<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/** Survives reloads and crashes. Falls back to memory where IndexedDB is unavailable. */
export class IndexedDbOutbox implements OutboxStore {
    private db: Promise<IDBDatabase>;

    constructor(name = DB_NAME) {
        this.db = new Promise((resolve, reject) => {
            const open = indexedDB.open(name, 1);
            open.onupgradeneeded = () =>
                open.result.createObjectStore(STORE, { keyPath: ['boardId', 'clientId', 'cseq'] });
            open.onsuccess = () => resolve(open.result);
            open.onerror = () => reject(open.error);
        });
    }

    private async tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
        return (await this.db).transaction(STORE, mode).objectStore(STORE);
    }

    async all(): Promise<OutboxEntry[]> {
        return request((await this.tx('readonly')).getAll() as IDBRequest<OutboxEntry[]>);
    }

    async add(entries: OutboxEntry[]): Promise<void> {
        const store = await this.tx('readwrite');
        await Promise.all(entries.map((e) => request(store.put(e))));
    }

    async ack(boardId: string, clientId: string, upTo: number): Promise<void> {
        const store = await this.tx('readwrite');
        await request(
            store.delete(IDBKeyRange.bound([boardId, clientId, 0], [boardId, clientId, upTo])),
        );
    }
}

/** The best store this environment offers. */
export function defaultOutbox(): OutboxStore {
    try {
        if (typeof indexedDB !== 'undefined') return new IndexedDbOutbox();
    } catch {
        // Some private modes throw on access.
    }
    return new MemoryOutbox();
}
