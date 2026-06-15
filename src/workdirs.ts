import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { EnvPair } from './env';

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
