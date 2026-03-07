import * as fs from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';

const execAsync = promisify(exec);

export interface PkgBuildData {
    epoch?: string;
    pkgver: string;
    pkgrel: number;
}

export async function parsePkgBuild(pkgbuildPath: string): Promise<PkgBuildData> {
    const content = await fs.readFile(pkgbuildPath, 'utf8');

    const pkgverMatch = content.match(/^pkgver=(.+)$/m);
    const pkgrelMatch = content.match(/^pkgrel=(\d+)$/m);

    const epochMatch = content.match(/^epoch=(\d+)$/m);

    if (!pkgverMatch || !pkgverMatch[1] || !pkgrelMatch || !pkgrelMatch[1]) {
        throw new Error('Could not parse pkgver or pkgrel from PKGBUILD');
    }

    return {
        epoch: epochMatch && epochMatch[1] ? epochMatch[1] : undefined,
        pkgver: (pkgverMatch[1] as string).replace(/^['"]|['"]$/g, ''),
        pkgrel: parseInt(pkgrelMatch[1] as string, 10),
    };
}

export async function updateDynamicPkgver(pkgbuildPath: string): Promise<boolean> {
    const content = await fs.readFile(pkgbuildPath, 'utf8');
    if (!content.match(/^pkgver\(\)\s*\{/m)) {
        return false; // No pkgver() function
    }

    const pkgbuildDir = path.dirname(pkgbuildPath);
    console.log(`[PKGBUILD] Found dynamic pkgver() in ${path.basename(pkgbuildDir)}, running makepkg -odc to update version...`);

    try {
        // -o: extract and download sources
        // -d: skip dependency checks
        // -c: clean up working directory after
        await execAsync('makepkg -odc --noconfirm', { cwd: pkgbuildDir });
        return true;
    } catch (e: any) {
        console.error(`[PKGBUILD] Failed to run makepkg for dynamic pkgver: ${e.message}`);
        return false;
    }
}

export async function updatePkgBuild(
    pkgbuildPath: string,
    updates: Record<string, string>,
    forceBumpRel: boolean = false
): Promise<boolean> {
    let content = await fs.readFile(pkgbuildPath, 'utf8');
    const originalContent = content;

    const currentData = await parsePkgBuild(pkgbuildPath);

    if (updates.pkgver && currentData.pkgver !== updates.pkgver) {
        console.log(`[PKGBUILD] Updating pkgver from ${currentData.pkgver} to ${updates.pkgver} (pkgrel=1)`);
        content = content.replace(/^pkgver=.+$/m, `pkgver=${updates.pkgver}`);
        content = content.replace(/^pkgrel=\d+$/m, `pkgrel=1`);
    } else if (forceBumpRel) {
        console.log(`[PKGBUILD] Bumping pkgrel from ${currentData.pkgrel} to ${currentData.pkgrel + 1}`);
        content = content.replace(/^pkgrel=\d+$/m, `pkgrel=${currentData.pkgrel + 1}`);
    }

    for (const [key, value] of Object.entries(updates)) {
        if (key === 'pkgver' || key === 'pkgrel') continue;
        if (key === 'epoch') {
            if (!value || value === "0") continue;
            if (content.match(/^epoch=.+$/m)) {
                console.log(`[PKGBUILD] Updating epoch to ${value}`);
                content = content.replace(/^epoch=.+$/m, `epoch=${value}`);
            } else {
                console.log(`[PKGBUILD] Injecting new epoch ${value}`);
                content = content.replace(/^pkgver=/m, `epoch=${value}\npkgver=`);
            }
            continue;
        }

        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (content.match(regex)) {
            console.log(`[PKGBUILD] Updating custom variable ${key}=${value}`);
            content = content.replace(regex, `${key}=${value}`);
        } else {
            console.log(`[PKGBUILD] Injecting custom variable ${key}=${value}`);
            content = content.replace(/^pkgver=/m, `${key}=${value}\npkgver=`);
        }
    }

    const changed = content !== originalContent;

    if (changed) {
        await fs.writeFile(pkgbuildPath, content, 'utf8');
    }

    // ALWAYS update checksums
    try {
        const pkgbuildDir = path.dirname(pkgbuildPath);
        console.log(`[PKGBUILD] Running updpkgsums in ${pkgbuildDir}...`);
        await execAsync('updpkgsums', { cwd: pkgbuildDir });
    } catch (e: any) {
        console.error(`[PKGBUILD] Failed to run updpkgsums: ${e.message}`);
        throw e;
    }

    return changed;
}
