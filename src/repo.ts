import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { PreaurRepo } from './config';
import type { PacmanVersion } from './pacman_version';
import { packageArtifactPrefix } from './pacman_version';
import { Semaphore } from './semaphore';

const PACKAGE_ARTIFACT_EXT = '.pkg.tar.zst';

// Builds run in parallel, but the repository database must be updated by one
// writer at a time. Upstream repo-add aborts when <db>.lck is held, and some
// repo-add implementations ignore the lock entirely, so concurrent runs can
// corrupt or delete the database. Only in-process serialization is provided.
const repoLock = new Semaphore(1);

export async function withRepoLock<T>(work: () => Promise<T>): Promise<T> {
    await repoLock.acquire();
    try {
        return await work();
    } finally {
        repoLock.release();
    }
}

function parsePackageArtifactFile(file: string): { pkgname: string; pkgver: string; pkgrel: string; arch: string } | undefined {
    if (!file.endsWith(PACKAGE_ARTIFACT_EXT)) return undefined;

    const basename = file.slice(0, -PACKAGE_ARTIFACT_EXT.length);
    const parts = basename.split('-');
    if (parts.length < 4) return undefined;

    const arch = parts.pop();
    const pkgrel = parts.pop();
    const pkgver = parts.pop();
    const pkgname = parts.join('-');

    if (!pkgname || !pkgver || !pkgrel || !arch) return undefined;
    return { pkgname, pkgver, pkgrel, arch };
}

export async function hasBuiltPackage(
    repoConfig: Pick<PreaurRepo, 'name'>,
    pkgname: string,
    version: PacmanVersion,
    baseDir: string = process.cwd()
): Promise<boolean> {
    const repoDir = path.resolve(baseDir, 'repo', repoConfig.name);
    try {
        const files = await fs.readdir(repoDir);
        const prefix = packageArtifactPrefix(pkgname, version);
        return files.some(f => f.startsWith(prefix) && f.endsWith('.pkg.tar.zst'));
    } catch (e: any) {
        if (e.code === 'ENOENT') {
            return false;
        }
        throw e;
    }
}

export async function resolveBuiltPackage(
    repoConfig: Pick<PreaurRepo, 'name'>,
    pkgname: string,
    baseDir: string = process.cwd()
): Promise<string> {
    const repoDir = path.resolve(baseDir, 'repo', repoConfig.name);
    try {
        const files = await fs.readdir(repoDir);
        const pkgFiles = files.filter(f => parsePackageArtifactFile(f)?.pkgname === pkgname);

        if (pkgFiles.length === 0) {
            throw new Error(`Could not find built package for ${pkgname} in repository ${repoConfig.name}`);
        }

        // Sort by modified time:
        const stats = await Promise.all(pkgFiles.map(async f => ({
            file: f,
            stat: await fs.stat(path.join(repoDir, f))
        })));
        stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

        return path.join(repoDir, stats[0]!.file);
    } catch (e: any) {
        throw new Error(`Failed to resolve package ${pkgname} in repo: ${e.message}`);
    }
}

const execFileAsync = promisify(execFile);

export interface RepoAddOptions {
    removeOld?: boolean;
}

// repo-add usage: repo-add [options] <path-to-db> <package1> [<package2> ...]
export function repoAddArgs(dbFile: string, files: string[], opts: RepoAddOptions = {}): string[] {
    const args: string[] = [];
    if (opts.removeOld) args.push('-R');
    args.push(dbFile, ...files);
    return args;
}

export async function manageRepository(
    repoConfig: PreaurRepo,
    pkgbuildDirectory: string,
    baseDir: string = process.cwd()
): Promise<void> {
    await withRepoLock(() => addArtifactsToRepository(repoConfig, pkgbuildDirectory, baseDir));
}

async function addArtifactsToRepository(
    repoConfig: PreaurRepo,
    pkgbuildDirectory: string,
    baseDir: string
): Promise<void> {
    const repoDir = path.resolve(baseDir, 'repo', repoConfig.name);

    // Ensure repo directory exists
    await fs.mkdir(repoDir, { recursive: true });

    console.log(`[Repo] Moving artifacts to ${repoDir}...`);

    // Find built `.pkg.tar.zst` files in the pkgbuildDirectory
    const files = await fs.readdir(pkgbuildDirectory);
    const pkgFiles = files.filter(f => f.endsWith('.pkg.tar.zst'));

    if (pkgFiles.length === 0) {
        console.log(`[Repo] No .pkg.tar.zst files found in ${pkgbuildDirectory} to copy.`);
        return;
    }

    const movedFiles: string[] = [];

    for (const file of pkgFiles) {
        const srcPath = path.resolve(pkgbuildDirectory, file);
        const destPath = path.resolve(repoDir, file);

        await fs.rename(srcPath, destPath);
        console.log(`[Repo] Moved ${file} to repository.`);
        movedFiles.push(destPath);
    }

    // Run repo-add
    const dbFile = path.resolve(repoDir, `${repoConfig.name}.db.tar.gz`);

    console.log(`[Repo] Running repo-add ${repoConfig.name}.db.tar.gz...`);

    try {
        const args = repoAddArgs(dbFile, movedFiles, { removeOld: repoConfig.removeOld });
        await execFileAsync('repo-add', args, { cwd: repoDir });
        console.log(`[Repo] Successfully updated pacman database: ${repoConfig.name}.db.tar.gz`);
    } catch (e: any) {
        console.error(`[Repo] Failed to update pacman database: ${e.message}`);
        throw e;
    }
}

const SIGNATURE_EXT = '.sig';

/**
 * Package names to remove for orphaned versions.json entries: each pkgname and
 * its -debug package. Split packages are not covered. Names in protectedNames
 * (packages still in the config) are never returned.
 */
export function orphanRepoPackageNames(pkgnames: Iterable<string>, protectedNames: Iterable<string> = []): string[] {
    const keep = new Set(protectedNames);
    const names = new Set<string>();
    for (const pkgname of pkgnames) {
        for (const name of [pkgname, `${pkgname}-debug`]) {
            if (!keep.has(name)) names.add(name);
        }
    }
    return [...names];
}

// repo-remove usage: repo-remove [options] <path-to-db> <packagename> ...
export function repoRemoveArgs(dbFile: string, names: string[]): string[] {
    return [dbFile, ...names];
}

function readTarString(block: Buffer, start: number, length: number): string {
    const field = block.subarray(start, start + length);
    const end = field.indexOf(0);
    return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

/**
 * Package names (%NAME%) recorded in a pacman sync database (.db.tar.gz or an
 * uncompressed tar). Used to pass repo-remove only names it knows: repo-remove
 * fails and leaves the database unchanged if any given name is missing.
 */
export async function readRepoDbPackageNames(dbFile: string): Promise<Set<string>> {
    const raw = await fs.readFile(dbFile);
    const tar = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
    const names = new Set<string>();

    let offset = 0;
    let longName: string | undefined;
    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every(byte => byte === 0)) break;

        const size = parseInt(readTarString(header, 124, 12).trim() || '0', 8);
        const type = String.fromCharCode(header[156] ?? 0);
        const prefix = readTarString(header, 345, 155);
        const shortName = readTarString(header, 0, 100);
        const name = longName ?? (prefix ? `${prefix}/${shortName}` : shortName);
        const dataStart = offset + 512;
        const data = tar.subarray(dataStart, dataStart + size);
        offset = dataStart + Math.ceil(size / 512) * 512;

        if (type === 'L') {
            longName = readTarString(data, 0, data.length);
            continue;
        }
        longName = undefined;

        if ((type === '0' || type === '\0') && name.endsWith('/desc')) {
            const match = /^%NAME%\n([^\n]+)/m.exec(data.toString('utf8'));
            if (match) names.add(match[1]!.trim());
        }
    }

    return names;
}

export interface OrphanRepoCleanupResult {
    removedFromDb: string[];
    deletedFiles: string[];
}

/**
 * Remove the given package names from the repository database with
 * repo-remove, then delete their package files and signatures. Throws if
 * repo-remove fails, before any file is deleted, so the caller can keep its
 * records and retry. A missing database or repository directory is skipped.
 */
export async function removeRepoPackages(
    repoConfig: Pick<PreaurRepo, 'name'>,
    names: string[],
    baseDir: string = process.cwd()
): Promise<OrphanRepoCleanupResult> {
    return withRepoLock(async () => {
        const repoDir = path.resolve(baseDir, 'repo', repoConfig.name);
        const dbFile = path.resolve(repoDir, `${repoConfig.name}.db.tar.gz`);
        const wanted = new Set(names);

        let removedFromDb: string[] = [];
        let dbNames: Set<string> | undefined;
        try {
            dbNames = await readRepoDbPackageNames(dbFile);
        } catch (e: any) {
            if (e.code !== 'ENOENT') {
                throw new Error(`Failed to read repository database ${dbFile}: ${e.message}`);
            }
            console.log(`[Repo] ${repoConfig.name}.db.tar.gz does not exist; skipping repo-remove.`);
        }

        if (dbNames) {
            removedFromDb = names.filter(name => dbNames!.has(name));
            if (removedFromDb.length > 0) {
                console.log(`[Repo] Running repo-remove ${repoConfig.name}.db.tar.gz ${removedFromDb.join(' ')}...`);
                try {
                    await execFileAsync('repo-remove', repoRemoveArgs(dbFile, removedFromDb), { cwd: repoDir });
                } catch (e: any) {
                    console.error(`[Repo] Failed to remove packages from pacman database: ${e.message}`);
                    throw e;
                }
            }
        }

        let files: string[];
        try {
            files = await fs.readdir(repoDir);
        } catch (e: any) {
            if (e.code === 'ENOENT') return { removedFromDb, deletedFiles: [] };
            throw e;
        }

        const deletedFiles: string[] = [];
        for (const file of files) {
            const artifact = file.endsWith(SIGNATURE_EXT) ? file.slice(0, -SIGNATURE_EXT.length) : file;
            const pkgname = parsePackageArtifactFile(artifact)?.pkgname;
            if (!pkgname || !wanted.has(pkgname)) continue;

            await fs.rm(path.join(repoDir, file), { force: true });
            console.log(`[Repo] Deleted ${file}.`);
            deletedFiles.push(file);
        }

        return { removedFromDb, deletedFiles };
    });
}
