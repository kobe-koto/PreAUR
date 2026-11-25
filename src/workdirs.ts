import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { EnvPair } from './env.ts';
import { sourceEntryFilename } from './pkgbuild.ts';

export interface PackageWorkDirs {
    root: string;
    srcdest: string;
    srcpkgdest: string;
    logdest: string;
    builddir: string;
    pkgdest: string;
}

function safePathSegment(value: string): string {
    return value.replace(/[\/\\]/g, '_');
}

export function getPackageWorkDirs(baseDir: string, pkgname: string, logdest?: string): PackageWorkDirs {
    const root = path.resolve(baseDir, 'work', safePathSegment(pkgname));

    return {
        root,
        srcdest: path.resolve(root, 'srcdest'),
        srcpkgdest: path.resolve(root, 'srcpkgdest'),
        logdest: logdest ? path.resolve(logdest) : path.resolve(root, 'logdest'),
        builddir: path.resolve(root, 'builddir'),
        pkgdest: path.resolve(root, 'pkgdest'),
    };
}

export async function ensurePackageCheckWorkDirs(workDirs: PackageWorkDirs): Promise<void> {
    await fs.mkdir(workDirs.srcdest, { recursive: true });
    await fs.mkdir(workDirs.srcpkgdest, { recursive: true });
    await fs.mkdir(workDirs.builddir, { recursive: true });
    await fs.mkdir(workDirs.pkgdest, { recursive: true });
}

export async function ensurePackageLogDir(workDirs: PackageWorkDirs): Promise<void> {
    await fs.mkdir(workDirs.logdest, { recursive: true });
}

export function packageWorkEnvPairs(workDirs: PackageWorkDirs): EnvPair[] {
    return [
        ['SRCDEST', workDirs.srcdest],
        ['SRCPKGDEST', workDirs.srcpkgdest],
        ['LOGDEST', workDirs.logdest],
        ['BUILDDIR', workDirs.builddir],
        ['PKGDEST', workDirs.pkgdest],
    ];
}

export interface SourceCachePruneResult {
    removed: string[];
    failed: Array<{ name: string; error: string }>;
}

/**
 * Delete regular files in SRCDEST that no source entry refers to, such as the
 * tarballs of previous versions. <name>.part, which makepkg resumes on the
 * next download, is kept for every referenced name. Directories (git, hg, svn
 * and bzr checkouts), *.fossil repositories and symlinks are never touched.
 */
export async function pruneUnreferencedSourceFiles(
    srcdest: string,
    sourceEntries: Iterable<string>
): Promise<SourceCachePruneResult> {
    const referenced = new Set<string>();
    for (const entry of sourceEntries) {
        const name = sourceEntryFilename(entry);
        referenced.add(name);
        referenced.add(`${name}.part`);
    }

    let dirents: Dirent[];
    try {
        dirents = await fs.readdir(srcdest, { withFileTypes: true });
    } catch (e: any) {
        if (e.code === 'ENOENT') return { removed: [], failed: [] };
        throw e;
    }

    const result: SourceCachePruneResult = { removed: [], failed: [] };
    for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!dirent.isFile() || dirent.name.endsWith('.fossil') || referenced.has(dirent.name)) continue;
        try {
            await fs.rm(path.join(srcdest, dirent.name), { force: true });
            result.removed.push(dirent.name);
        } catch (e: any) {
            result.failed.push({ name: dirent.name, error: e.message });
        }
    }
    return result;
}
