import type { Element, ElementInit } from '../types';
import type { Store } from './store';

interface Change {
    /** State before the change; undefined when the change created the element. */
    before: Element | undefined;
    /** State the change wrote. */
    after: Element;
}

type Entry = Change[];

const LIMIT = 200;

/**
 * Per-user undo/redo. Undo only reverts this user's own changes, and skips an
 * element someone else has changed since, so it never throws away a
 * collaborator's work.
 */
export class History {
    private undoStack: Entry[] = [];
    private redoStack: Entry[] = [];
    private listener: (() => void) | null = null;

    constructor(private store: Store) {}

    /** Writes elements and deletions as one undoable step. */
    commit(
        writes: (ElementInit & { id: string })[],
        deletes: string[] = [],
    ): Element[] {
        const entry: Entry = [];
        const written: Element[] = [];
        this.store.transact(() => {
            for (const content of writes) {
                const before = this.store.get(content.id);
                const after = this.store.write(content);
                entry.push({ before, after });
                written.push(after);
            }
            for (const id of deletes) {
                const before = this.store.get(id);
                const after = this.store.remove(id);
                if (after) entry.push({ before, after });
            }
        });
        if (entry.length > 0) {
            this.undoStack.push(entry);
            if (this.undoStack.length > LIMIT) this.undoStack.shift();
            this.redoStack = [];
            this.listener?.();
        }
        return written;
    }

    undo(): boolean {
        return this.step(this.undoStack, this.redoStack);
    }

    redo(): boolean {
        return this.step(this.redoStack, this.undoStack);
    }

    get canUndo(): boolean {
        return this.undoStack.length > 0;
    }

    get canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    clear(): void {
        this.undoStack = [];
        this.redoStack = [];
        this.listener?.();
    }

    onChange(listener: () => void): void {
        this.listener = listener;
    }

    private step(from: Entry[], to: Entry[]): boolean {
        // Skip entries that no longer apply (all their elements were changed
        // by someone else), so one press always does something visible.
        while (from.length > 0) {
            const entry = from.pop()!;
            const inverse: Entry = [];
            this.store.transact(() => {
                for (let i = entry.length - 1; i >= 0; i--) {
                    const { before, after } = entry[i];
                    const cur = this.store.get(after.id);
                    if (!cur || cur.v !== after.v || cur.by !== after.by) continue;
                    const content = before ?? { ...after, del: 1 as const };
                    const written = this.store.write(content);
                    inverse.push({ before: cur, after: written });
                }
            });
            if (inverse.length > 0) {
                to.push(inverse);
                this.listener?.();
                return true;
            }
        }
        this.listener?.();
        return false;
    }
}
