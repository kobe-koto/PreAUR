import * as os from 'node:os';

/**
 * Chroot copy names for a pool. The instance is reduced to characters that are
 * safe in a directory name, since makechrootpkg uses the name as a path.
 */
export function chrootWorkerNames(size: number, user: string, instance?: string): string[] {
    const safeInstance = instance?.trim().replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
    const prefix = safeInstance ? `${user}-preaur-${safeInstance}` : `${user}-preaur`;
    return Array.from({ length: size }, (_, i) => `${prefix}-worker-${i + 1}`);
}

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

    /**
     * @param instance Separates the copies of PreAUR processes that run as the
     * same user, such as instances of preaur@.service (which sets
     * PREAUR_INSTANCE=%i). Without it, the names stay `<user>-preaur-worker-N`.
     */
    constructor(size: number, instance: string | undefined = process.env.PREAUR_INSTANCE) {
        this.available.push(...chrootWorkerNames(size, os.userInfo().username, instance));
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
