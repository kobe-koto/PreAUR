import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { PreaurRepo } from './config.ts';
import type { PacmanVersion } from './pacman_version.ts';
import { packageArtifactPrefix } from './pacman_version.ts';
import { Semaphore } from './semaphore.ts';

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

    if (repoConfig.removeOld) {
        await removeStaleSplitPackages(repoConfig.name, repoDir, dbFile, movedFiles);
    }
}

/**
 * After repo-add -R, drop packages of the same pkgbase that this build no
 * longer produced. The new packages are already in the database, so failures
 * are logged and not thrown: the build must still count as successful.
 */
async function removeStaleSplitPackages(repoName: string, repoDir: string, dbFile: string, movedFiles: string[]): Promise<void> {
    try {
        const entries = await readRepoDbEntries(dbFile);
        const selection = selectStaleSplitPackages(entries, movedFiles.map(file => path.basename(file)));
        if (selection.dbNames.length === 0) return;

        console.log(`[Repo] Removing packages no longer produced by this build: ${selection.dbNames.join(', ')}`);
        await applyRepoRemoval(repoName, repoDir, dbFile, selection);
    } catch (e: any) {
        console.warn(`[Repo] Failed to remove stale split packages; they stay in the repository: ${e.message}`);
    }
}

const SIGNATURE_EXT = '.sig';

/** A versions.json entry whose package is no longer configured. */
export interface OrphanRepoTarget {
    /** versions.json key (the configured pkgname). */
    key: string;
    /** Recorded makepkg pkgbase, when known. */
    pkgbase?: string;
    aurPkgname?: string;
}

/** Package names and pkgbases of packages still configured; never removed. */
export interface RepoCleanupProtection {
    names: Set<string>;
    bases: Set<string>;
}

export interface RepoDbEntry {
    name: string;
    base?: string;
    filename?: string;
}

export interface RepoRemovalSelection {
    /** Names to pass to repo-remove; all are present in the database. */
    dbNames: string[];
    /** %FILENAME% values of the selected database entries. */
    filenames: string[];
    /** Package names whose artifacts in the repository directory are deleted. */
    artifactNames: string[];
}

function unique(values: Array<string | undefined>): string[] {
    return [...new Set(values.filter((value): value is string => !!value))];
}

/** pkgbase candidates in priority order: recorded pkgbase, AUR package name, key. */
export function orphanBaseCandidates(target: OrphanRepoTarget): string[] {
    return unique([target.pkgbase, target.aurPkgname, target.key]);
}

/** Names used when no database entry matches by pkgbase. */
export function orphanFallbackNames(target: OrphanRepoTarget): string[] {
    return unique([
        target.key,
        `${target.key}-debug`,
        target.pkgbase,
        target.pkgbase && `${target.pkgbase}-debug`,
    ]);
}

/**
 * Decide what to remove for orphaned entries. Database entries are matched
 * by %BASE% against the first base candidate that has any match, which
 * covers split and -debug packages; without such a match, entries are matched
 * by %NAME% against the fallback names. Anything whose name or base belongs to
 * a configured package is skipped.
 */
export function selectOrphanRepoPackages(
    entries: RepoDbEntry[],
    targets: OrphanRepoTarget[],
    protection: RepoCleanupProtection
): RepoRemovalSelection {
    const isProtected = (entry: RepoDbEntry) =>
        protection.names.has(entry.name) || (!!entry.base && protection.bases.has(entry.base));

    const selected = new Map<string, RepoDbEntry>();
    const artifactNames = new Set<string>();

    for (const target of targets) {
        let matches: RepoDbEntry[] = [];
        for (const base of orphanBaseCandidates(target)) {
            if (protection.bases.has(base)) continue;
            matches = entries.filter(entry => entry.base === base);
            if (matches.length > 0) break;
        }

        if (matches.length === 0) {
            const fallback = orphanFallbackNames(target).filter(name => !protection.names.has(name));
            fallback.forEach(name => artifactNames.add(name));
            matches = entries.filter(entry => fallback.includes(entry.name));
        }

        for (const entry of matches) {
            if (isProtected(entry)) continue;
            selected.set(entry.name, entry);
            artifactNames.add(entry.name);
        }
    }

    for (const name of protection.names) artifactNames.delete(name);

    return {
        dbNames: [...selected.keys()],
        filenames: unique([...selected.values()].map(entry => entry.filename)),
        artifactNames: [...artifactNames],
    };
}

/**
 * Entries left behind by a rebuild: same %BASE% as a package just added, but a
 * name this build did not produce (a dropped split package, or <pkgbase>-debug
 * after debug packages were turned off). Entries without %BASE% are ignored.
 */
export function selectStaleSplitPackages(entries: RepoDbEntry[], addedFilenames: Iterable<string>): RepoRemovalSelection {
    const added = new Set(addedFilenames);
    const addedEntries = entries.filter(entry => entry.filename && added.has(entry.filename));
    const bases = new Set(addedEntries.map(entry => entry.base).filter((base): base is string => !!base));
    const addedNames = new Set(addedEntries.map(entry => entry.name));
    const stale = entries.filter(entry => entry.base && bases.has(entry.base) && !addedNames.has(entry.name));

    return {
        dbNames: stale.map(entry => entry.name),
        filenames: unique(stale.map(entry => entry.filename)),
        artifactNames: stale.map(entry => entry.name),
    };
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

function readDescField(desc: string, field: string): string | undefined {
    const lines = desc.split('\n');
    const index = lines.indexOf(`%${field}%`);
    const value = index === -1 ? undefined : lines[index + 1]?.trim();
    return value || undefined;
}

/**
 * Entries (%NAME%, %BASE%, %FILENAME%) of a pacman sync database (.db.tar.gz
 * or an uncompressed tar). repo-remove fails and leaves the database unchanged
 * if any given name is missing, so callers pass it only names found here.
 */
export async function readRepoDbEntries(dbFile: string): Promise<RepoDbEntry[]> {
    const raw = await fs.readFile(dbFile);
    const tar = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
    const entries: RepoDbEntry[] = [];

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
            const desc = data.toString('utf8');
            const pkgname = readDescField(desc, 'NAME');
            if (pkgname) {
                entries.push({
                    name: pkgname,
                    base: readDescField(desc, 'BASE'),
                    filename: readDescField(desc, 'FILENAME'),
                });
            }
        }
    }

    return entries;
}

export interface OrphanRepoCleanupResult {
    removedFromDb: string[];
    deletedFiles: string[];
}

/**
 * Remove orphaned packages from the repository database with repo-remove,
 * then delete their package files and signatures. Throws if repo-remove
 * fails, before any file is deleted, so the caller can keep its records and
 * retry. A missing database or repository directory is skipped.
 */
export async function removeOrphanRepoPackages(
    repoConfig: Pick<PreaurRepo, 'name'>,
    targets: OrphanRepoTarget[],
    protection: RepoCleanupProtection,
    baseDir: string = process.cwd()
): Promise<OrphanRepoCleanupResult> {
    return withRepoLock(async () => {
        const repoDir = path.resolve(baseDir, 'repo', repoConfig.name);
        const dbFile = path.resolve(repoDir, `${repoConfig.name}.db.tar.gz`);

        let entries: RepoDbEntry[] = [];
        try {
            entries = await readRepoDbEntries(dbFile);
        } catch (e: any) {
            if (e.code !== 'ENOENT') {
                throw new Error(`Failed to read repository database ${dbFile}: ${e.message}`);
            }
            console.log(`[Repo] ${repoConfig.name}.db.tar.gz does not exist; skipping repo-remove.`);
        }

        const selection = selectOrphanRepoPackages(entries, targets, protection);
        return applyRepoRemoval(repoConfig.name, repoDir, dbFile, selection);
    });
}

/**
 * repo-remove the selected names, then delete the selected package files and
 * signatures. Throws if repo-remove fails, before any file is deleted. The
 * caller must hold the repository lock.
 */
async function applyRepoRemoval(
    repoName: string,
    repoDir: string,
    dbFile: string,
    selection: RepoRemovalSelection
): Promise<OrphanRepoCleanupResult> {
    if (selection.dbNames.length > 0) {
        console.log(`[Repo] Running repo-remove ${repoName}.db.tar.gz ${selection.dbNames.join(' ')}...`);
        try {
            await execFileAsync('repo-remove', repoRemoveArgs(dbFile, selection.dbNames), { cwd: repoDir });
        } catch (e: any) {
            console.error(`[Repo] Failed to remove packages from pacman database: ${e.message}`);
            throw e;
        }
    }

    let files: string[];
    try {
        files = await fs.readdir(repoDir);
    } catch (e: any) {
        if (e.code === 'ENOENT') return { removedFromDb: selection.dbNames, deletedFiles: [] };
        throw e;
    }

    const dbFilenames = new Set(selection.filenames);
    const artifactNames = new Set(selection.artifactNames);
    const deletedFiles: string[] = [];
    for (const file of files) {
        const artifact = file.endsWith(SIGNATURE_EXT) ? file.slice(0, -SIGNATURE_EXT.length) : file;
        const pkgname = parsePackageArtifactFile(artifact)?.pkgname;
        const selected = dbFilenames.has(artifact) || (!!pkgname && artifactNames.has(pkgname));
        if (!selected) continue;

        await fs.rm(path.join(repoDir, file), { force: true });
        console.log(`[Repo] Deleted ${file}.`);
        deletedFiles.push(file);
    }

    return { removedFromDb: selection.dbNames, deletedFiles };
}
