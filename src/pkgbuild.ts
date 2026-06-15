import * as fs from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import pc from 'picocolors';
import type { PacmanVersion } from './pacman_version';
import { constructMessager } from './logger';
import { shellEnvCommand, shellQuote, type EnvPairs } from './env';

const execAsync = promisify(exec);

export type PkgBuildData = PacmanVersion;

export type PkgBuildParser = 'native' | 'makepkg';

/**
 * Source the PKGBUILD in a subshell so that variable references and bash
 * parameter expansions (e.g. pkgver="${_update_pkgver//-/_}") are resolved to
 * their concrete values, which a plain regex cannot do.
 */
async function evalPkgBuildVars(pkgbuildPath: string): Promise<{ epoch?: string; pkgver?: string; pkgrel?: string }> {
    // The path is passed as $0 so it never has to be embedded in the script body.
    const script = `export CARCH="$(uname -m)"; source "$0" >/dev/null 2>&1; printf '%s\\n%s\\n%s\\n' "\${epoch-}" "\${pkgver-}" "\${pkgrel-}"`;
    const { stdout } = await execAsync(`bash -c ${shellQuote(script)} ${shellQuote(pkgbuildPath)}`);
    const [epoch = '', pkgver = '', pkgrel = ''] = stdout.split('\n');
    return {
        epoch: epoch.trim() || undefined,
        pkgver: pkgver.trim() || undefined,
        pkgrel: pkgrel.trim() || undefined,
    };
}

async function parsePkgBuildNative(pkgbuildPath: string): Promise<PkgBuildData> {
    const content = await fs.readFile(pkgbuildPath, 'utf8');

    const stripQuotes = (s: string) => s.replace(/^['"]|['"]$/g, '').trim();

    // Loose capture (not \d+): pkgrel/epoch may be defined via bash variables,
    // which we resolve below — a strict numeric regex would throw prematurely.
    const pkgverMatch = content.match(/^pkgver=(.+)$/m);
    const pkgrelMatch = content.match(/^pkgrel=(.+)$/m);
    const epochMatch = content.match(/^epoch=(.+)$/m);

    if (!pkgverMatch || !pkgverMatch[1] || !pkgrelMatch || !pkgrelMatch[1]) {
        throw new Error('Could not parse pkgver or pkgrel from PKGBUILD');
    }

    let pkgver = stripQuotes(pkgverMatch[1]);
    let pkgrelRaw = stripQuotes(pkgrelMatch[1]);
    let epochRaw = epochMatch && epochMatch[1] ? stripQuotes(epochMatch[1]) : '0';

    // The regex captures the raw assignment text. If any version field relies on
    // bash variables / parameter expansion (no pkgver() to let makepkg rewrite it),
    // the literal expression leaks through — resolve it by sourcing the PKGBUILD.
    if (pkgver.includes('$') || pkgrelRaw.includes('$') || epochRaw.includes('$')) {
        try {
            const resolved = await evalPkgBuildVars(pkgbuildPath);
            if (resolved.pkgver) pkgver = resolved.pkgver;
            if (resolved.pkgrel) pkgrelRaw = resolved.pkgrel;
            epochRaw = resolved.epoch ?? '0';
        } catch (e: any) {
            console.warn(pc.yellow(`Failed to resolve bash-expanded version fields via sourcing: ${e.message}`));
        }
    }

    const pkgrel = parseInt(pkgrelRaw, 10);
    if (isNaN(pkgrel)) {
        throw new Error(`Could not parse pkgrel from PKGBUILD (got "${pkgrelRaw}")`);
    }
    const epoch = parseInt(epochRaw || '0', 10);
    if (isNaN(epoch) || epoch < 0) {
        throw new Error(`Could not parse epoch from PKGBUILD (got "${epochRaw}")`);
    }

    return { epoch, pkgver, pkgrel };
}

async function parsePkgBuildMakepkg(pkgbuildPath: string, env?: EnvPairs): Promise<PkgBuildData> {
    const pkgbuildDir = path.dirname(pkgbuildPath);
    const { stdout } = await execAsync(shellEnvCommand('makepkg --printsrcinfo', env), {
        cwd: pkgbuildDir,
    });

    const fields: Record<string, string> = {};
    for (const line of stdout.split('\n')) {
        const match = line.match(/^\s*(epoch|pkgver|pkgrel)\s*=\s*(.+)$/);
        if (match && match[1] && match[2] && fields[match[1]] === undefined) {
            fields[match[1]] = match[2].trim();
        }
    }

    if (!fields.pkgver || !fields.pkgrel) {
        throw new Error('Could not parse pkgver or pkgrel from makepkg --printsrcinfo');
    }

    const pkgrel = parseInt(fields.pkgrel, 10);
    if (isNaN(pkgrel)) {
        throw new Error(`Could not parse pkgrel from makepkg --printsrcinfo (got "${fields.pkgrel}")`);
    }

    const epoch = fields.epoch ? parseInt(fields.epoch, 10) : 0;
    if (isNaN(epoch) || epoch < 0) {
        throw new Error(`Could not parse epoch from makepkg --printsrcinfo (got "${fields.epoch}")`);
    }

    return { epoch, pkgver: fields.pkgver, pkgrel };
}

export async function parsePkgBuild(pkgbuildPath: string, parser: PkgBuildParser = 'native', env?: EnvPairs): Promise<PkgBuildData> {
    return parser === 'makepkg'
        ? parsePkgBuildMakepkg(pkgbuildPath, env)
        : parsePkgBuildNative(pkgbuildPath);
}

export async function updateDynamicPkgver(pkgbuildPath: string, env?: EnvPairs): Promise<boolean> {
    const pkgMessager = constructMessager('PKGBUILD Updater', path.basename(path.dirname(pkgbuildPath)));
    const content = await fs.readFile(pkgbuildPath, 'utf8');
    if (!content.match(/^pkgver\(\)\s*\{/m)) {
        return false; // No pkgver() function
    }

    const pkgbuildDir = path.dirname(pkgbuildPath);
    console.log(pkgMessager(`Found dynamic pkgver() in ${path.basename(pkgbuildDir)}, running makepkg -odc to update version...`));

    try {
        // -o: extract and download sources
        // -d: skip dependency checks
        // -c: clean up working directory after
        await execAsync(shellEnvCommand('makepkg -odc --noconfirm --skipinteg', env), {
            cwd: pkgbuildDir,
        });
        return true;
    } catch (e: any) {
        console.error(pkgMessager(pc.red(`Failed to run makepkg for dynamic pkgver: ${e.message}`)));
        return false;
    }
}

export async function updatePkgBuild(
    pkgname: string,
    pkgbuildPath: string,
    updates: Record<string, string>,
    forceBumpRel: boolean = false,
    parser: PkgBuildParser = 'native',
    env?: EnvPairs
): Promise<boolean> {
    const pkgMessager = constructMessager('PKGBUILD Updater', pkgname);
    let content = await fs.readFile(pkgbuildPath, 'utf8');
    const originalContent = content;

    const currentData = await parsePkgBuild(pkgbuildPath, parser, env);

    if (updates.pkgver && currentData.pkgver !== updates.pkgver) {
        console.log(pkgMessager(`Updating pkgver from ${currentData.pkgver} to ${updates.pkgver} (pkgrel=1)`));
        content = content.replace(/^pkgver=.+$/m, `pkgver=${updates.pkgver}`);
        content = content.replace(/^pkgrel=\d+$/m, `pkgrel=1`);
    } else if (forceBumpRel) {
        console.log(pkgMessager(`Bumping pkgrel from ${currentData.pkgrel} to ${currentData.pkgrel + 1}`));
        content = content.replace(/^pkgrel=\d+$/m, `pkgrel=${currentData.pkgrel + 1}`);
    }

    for (const [key, value] of Object.entries(updates)) {
        if (key === 'pkgver' || key === 'pkgrel') continue;
        if (key === 'epoch') {
            if (!value || value === "0") continue;
            if (content.match(/^epoch=.+$/m)) {
                console.log(pkgMessager(`Updating epoch to ${value}`));
                content = content.replace(/^epoch=.+$/m, `epoch=${value}`);
            } else {
                console.log(pkgMessager(`Injecting new epoch ${value}`));
                content = content.replace(/^pkgver=/m, `epoch=${value}\npkgver=`);
            }
            continue;
        }

        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (content.match(regex)) {
            console.log(pkgMessager(`Updating custom variable ${key}=${value}`));
            content = content.replace(regex, `${key}=${value}`);
        } else {
            console.log(pkgMessager(`Injecting custom variable ${key}=${value}`));
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
        // console.log(pkgMessager(`Running updpkgsums in ${pkgbuildDir}...`));
        await execAsync(shellEnvCommand('updpkgsums', env), {
            cwd: pkgbuildDir,
        });
    } catch (e: any) {
        console.error(pkgMessager(pc.red(`Failed to run updpkgsums: ${e.message}`)));
        throw e;
    }

    return changed;
}
