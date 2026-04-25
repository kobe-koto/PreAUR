import * as os from 'node:os';

/**
 * Manages a pool of named chroot worker copies for parallel devtools builds.
 *
 * By default, `extra-x86_64-build` (and similar devtools scripts) use
 * `makechrootpkg -l $USER` — meaning all concurrent builds compete for the
 * same chroot copy lock. This pool assigns each build a unique copy name
 * so they can run truly in parallel.
 */
export class ChrootPool {
    private available: string[] = [];
    private waiting: ((worker: string) => void)[] = [];

    constructor(size: number) {
        const user = os.userInfo().username;
        for (let i = 1; i <= size; i++) {
            this.available.push(`${user}-preaur-worker-${i}`);
        }
    }

    /** Acquire a named chroot worker. Waits if none are free. */
    async acquire(): Promise<string> {
        const worker = this.available.pop();
        if (worker) {
            return worker;
        }
        return new Promise<string>((resolve) => {
            this.waiting.push(resolve);
        });
    }

    /** Release a chroot worker back to the pool. */
    release(worker: string): void {
        const next = this.waiting.shift();
        if (next) {
            next(worker);
        } else {
            this.available.push(worker);
        }
    }
}
