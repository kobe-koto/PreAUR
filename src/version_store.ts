import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PartialPacmanVersion } from './pacman_version.ts';

/**
 * Inputs that fully determine the version of a package without a checker
 * whose PKGBUILD has no pkgver() and no top-level command substitution.
 * While all fields match, the stored version is still current.
 */
export interface VersionMarker {
    /** HEAD of the package git checkout. */
    commit: string;
    git: string;
    parser: string;
    builder: string;
}

export function sameVersionMarker(a: VersionMarker | undefined, b: VersionMarker | undefined): boolean {
    if (!a || !b) return a === b;
    return a.commit === b.commit && a.git === b.git && a.parser === b.parser && a.builder === b.builder;
}

export interface VersionInfo extends PartialPacmanVersion {
    source?: 'aur' | 'custom_git';
    aur_pkgname?: string;
    maintainer?: string | null;
    co_maintainers?: string[];
    /** makepkg pkgbase of the last parsed PKGBUILD; may differ from the versions.json key. */
    pkgbase?: string;
    /** Set after a successful build or a confirmed unchanged version when the version is static. */
    version_marker?: VersionMarker;
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
 * Entries whose key is not a configured pkgname. configuredNames must come
 * from the full config.packages list, not a filtered subset (such as -p), or
 * every other package would be reported as an orphan.
 */
export function findOrphanVersions(
    store: VersionStore,
    configuredNames: Iterable<string>
): Array<[string, VersionInfo]> {
    const configured = new Set(configuredNames);
    return store.entries().filter(([pkgname]) => !configured.has(pkgname));
}

/**
 * Remove the entries findOrphanVersions reports and return them. The store is
 * modified in memory only; the caller saves it.
 */
export function pruneOrphanVersions(
    store: VersionStore,
    configuredNames: Iterable<string>
): Array<[string, VersionInfo]> {
    const orphans = findOrphanVersions(store, configuredNames);
    for (const [pkgname] of orphans) {
        store.delete(pkgname);
    }
    return orphans;
}
