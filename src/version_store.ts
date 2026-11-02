import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PartialPacmanVersion } from './pacman_version';

export interface VersionInfo extends PartialPacmanVersion {
    source?: 'aur' | 'custom_git';
    aur_pkgname?: string;
    maintainer?: string | null;
    co_maintainers?: string[];
}

export class VersionStore {
    private dataFile: string;
    private data: Record<string, VersionInfo> = {};

    constructor(baseDir: string = process.cwd()) {
        this.dataFile = path.resolve(baseDir, 'data', 'versions.json');
    }

    async load() {
        try {
            const parent = path.dirname(this.dataFile);
            await fs.mkdir(parent, { recursive: true });
            const content = await fs.readFile(this.dataFile, 'utf8');
            this.data = JSON.parse(content);
        } catch (e: any) {
            this.data = {};
        }
    }

    async save() {
        const parent = path.dirname(this.dataFile);
        await fs.mkdir(parent, { recursive: true });
        await fs.writeFile(this.dataFile, JSON.stringify(this.data, null, 2), 'utf8');
    }

    get(pkgname: string): VersionInfo | undefined {
        return this.data[pkgname];
    }

    entries(): Array<[string, VersionInfo]> {
        return Object.entries(this.data);
    }

    delete(pkgname: string): boolean {
        if (!Object.hasOwn(this.data, pkgname)) return false;
        delete this.data[pkgname];
        return true;
    }

    set(pkgname: string, info: VersionInfo) {
        this.data[pkgname] = {
            ...this.data[pkgname],
            ...info,
        };
    }
}

/**
 * Remove entries whose key is not a configured pkgname and return them.
 * configuredNames must come from the full config.packages list, not a
 * filtered subset (such as -p), or every other package would be pruned.
 * The store is modified in memory only; the caller saves it.
 */
export function pruneOrphanVersions(
    store: VersionStore,
    configuredNames: Iterable<string>
): Array<[string, VersionInfo]> {
    const configured = new Set(configuredNames);
    const orphans = store.entries().filter(([pkgname]) => !configured.has(pkgname));
    for (const [pkgname] of orphans) {
        store.delete(pkgname);
    }
    return orphans;
}
