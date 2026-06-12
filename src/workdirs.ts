import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface PackageWorkDirs {
    root: string;
    srcdest: string;
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
        logdest: logdest ? path.resolve(logdest) : path.resolve(root, 'logdest'),
        builddir: path.resolve(root, 'builddir'),
        pkgdest: path.resolve(root, 'pkgdest'),
    };
}

export async function ensurePackageWorkDirs(workDirs: PackageWorkDirs): Promise<void> {
    await fs.mkdir(workDirs.srcdest, { recursive: true });
    await fs.mkdir(workDirs.logdest, { recursive: true });
    await fs.mkdir(workDirs.builddir, { recursive: true });
    await fs.mkdir(workDirs.pkgdest, { recursive: true });
}

export function packageWorkEnv(workDirs: PackageWorkDirs): Record<string, string> {
    return {
        SRCDEST: workDirs.srcdest,
        LOGDEST: workDirs.logdest,
        BUILDDIR: workDirs.builddir,
        PKGDEST: workDirs.pkgdest,
    };
}
