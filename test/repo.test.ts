import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    hasBuiltPackage,
    orphanBaseCandidates,
    orphanFallbackNames,
    readRepoDbEntries,
    manageRepository,
    removeOrphanRepoPackages,
    repoAddArgs,
    repoRemoveArgs,
    resolveBuiltPackage,
    selectOrphanRepoPackages,
    selectStaleSplitPackages,
    withRepoLock,
    type RepoCleanupProtection,
    type RepoDbEntry,
} from '../src/repo.ts';
import { gzipSync } from 'node:zlib';

const tmpDirs: string[] = [];

async function makeBaseDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preaur-repo-'));
    tmpDirs.push(dir);
    return dir;
}

afterEach(async () => {
    while (tmpDirs.length) {
        const dir = tmpDirs.pop()!;
        await fs.rm(dir, { recursive: true, force: true });
    }
});

describe('hasBuiltPackage', () => {
    test('matches package artifacts with epoch in the filename', async () => {
        const baseDir = await makeBaseDir();
        const repoDir = path.join(baseDir, 'repo', 'localrepo');
        await fs.mkdir(repoDir, { recursive: true });
        await fs.writeFile(path.join(repoDir, 'spotify-1:1.2.3-1-x86_64.pkg.tar.zst'), '');

        await expect(hasBuiltPackage(
            { name: 'localrepo' },
            'spotify',
            { epoch: 1, pkgver: '1.2.3', pkgrel: 1 },
            baseDir
        )).resolves.toBe(true);

        await expect(hasBuiltPackage(
            { name: 'localrepo' },
            'spotify',
            { epoch: 0, pkgver: '1.2.3', pkgrel: 1 },
            baseDir
        )).resolves.toBe(false);
    });
});

describe('resolveBuiltPackage', () => {
    test('does not resolve a debug package when the base package is requested', async () => {
        const baseDir = await makeBaseDir();
        const repoDir = path.join(baseDir, 'repo', 'localrepo');
        await fs.mkdir(repoDir, { recursive: true });

        const pkgPath = path.join(repoDir, 'foo-1.0.0-1-x86_64.pkg.tar.zst');
        const debugPath = path.join(repoDir, 'foo-debug-1.0.0-1-x86_64.pkg.tar.zst');
        await fs.writeFile(pkgPath, '');
        await fs.writeFile(debugPath, '');

        const older = new Date('2024-01-01T00:00:00Z');
        const newer = new Date('2024-01-02T00:00:00Z');
        await fs.utimes(pkgPath, older, older);
        await fs.utimes(debugPath, newer, newer);

        await expect(resolveBuiltPackage(
            { name: 'localrepo' },
            'foo',
            baseDir
        )).resolves.toBe(pkgPath);
    });

    test('resolves hyphenated package names exactly', async () => {
        const baseDir = await makeBaseDir();
        const repoDir = path.join(baseDir, 'repo', 'localrepo');
        await fs.mkdir(repoDir, { recursive: true });

        const pkgPath = path.join(repoDir, 'foo-tools-1.0.0-1-x86_64.pkg.tar.zst');
        await fs.writeFile(path.join(repoDir, 'foo-2.0.0-1-x86_64.pkg.tar.zst'), '');
        await fs.writeFile(pkgPath, '');

        await expect(resolveBuiltPackage(
            { name: 'localrepo' },
            'foo-tools',
            baseDir
        )).resolves.toBe(pkgPath);
    });
});

describe('withRepoLock', () => {
    test('runs repository updates one at a time', async () => {
        let active = 0;
        let maxActive = 0;
        const order: number[] = [];

        await Promise.all([0, 1, 2, 3].map(i => withRepoLock(async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise(resolve => setTimeout(resolve, 5));
            order.push(i);
            active--;
        })));

        expect(maxActive).toBe(1);
        expect(order).toEqual([0, 1, 2, 3]);
    });

    test('releases the lock when the work throws', async () => {
        await expect(withRepoLock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        await expect(withRepoLock(async () => 'next')).resolves.toBe('next');
    });
});

describe('repoAddArgs', () => {
    const db = '/srv/my repo/localrepo.db.tar.gz';
    const files = ['/srv/my repo/foo-1.0-1-x86_64.pkg.tar.zst', '/srv/my repo/foo-debug-1.0-1-x86_64.pkg.tar.zst'];

    test('does not remove old files by default', () => {
        expect(repoAddArgs(db, files)).toEqual([db, ...files]);
        expect(repoAddArgs(db, files, { removeOld: false })).toEqual([db, ...files]);
    });

    test('passes -R before the database when removeOld is enabled', () => {
        expect(repoAddArgs(db, files, { removeOld: true })).toEqual(['-R', db, ...files]);
    });

    test('keeps paths with spaces as single arguments', () => {
        const args = repoAddArgs(db, files);
        expect(args).toHaveLength(3);
        expect(args[0]).toBe(db);
    });
});

function tarEntry(name: string, content: string | undefined): Buffer {
    const data = Buffer.from(content ?? '', 'utf8');
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 'ascii');
    header.write('0000000\0', 108, 'ascii');
    header.write('0000000\0', 116, 'ascii');
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    header.write('00000000000\0', 136, 'ascii');
    header.write(content === undefined ? '5' : '0', 156, 'ascii');
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    header.fill(' ', 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    const padding = Buffer.alloc((512 - (data.length % 512)) % 512, 0);
    return Buffer.concat([header, data, padding]);
}

type DbPackage = { name: string; version: string; base?: string };

async function writeRepoDb(dbFile: string, packages: DbPackage[]): Promise<void> {
    const entries = packages.flatMap(({ name, version, base }) => [
        tarEntry(`${name}-${version}/`, undefined),
        tarEntry(
            `${name}-${version}/desc`,
            `%FILENAME%\n${name}-${version}-x86_64.pkg.tar.zst\n\n%NAME%\n${name}\n\n`
                + (base ? `%BASE%\n${base}\n\n` : '')
                + `%VERSION%\n${version}\n`
        ),
    ]);
    await fs.writeFile(dbFile, gzipSync(Buffer.concat([...entries, Buffer.alloc(1024, 0)])));
}

async function installFakeTool(baseDir: string, tool: string, exitCode: number): Promise<{ log: string; restore: () => void }> {
    const binDir = path.join(baseDir, 'bin');
    const log = path.join(baseDir, `${tool}.log`);
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(
        path.join(binDir, tool),
        `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nexit ${exitCode}\n`,
        { mode: 0o755 }
    );
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;
    return { log, restore: () => { process.env.PATH = originalPath; } };
}

function installFakeRepoRemove(baseDir: string, exitCode: number) {
    return installFakeTool(baseDir, 'repo-remove', exitCode);
}

async function makeRepoDir(baseDir: string, files: string[]): Promise<string> {
    const repoDir = path.join(baseDir, 'repo', 'localrepo');
    await fs.mkdir(repoDir, { recursive: true });
    for (const file of files) await fs.writeFile(path.join(repoDir, file), '');
    return repoDir;
}

const noProtection = (): RepoCleanupProtection => ({ names: new Set(), bases: new Set() });

describe('orphan target names', () => {
    test('orders base candidates by recorded pkgbase, AUR name, then key', () => {
        expect(orphanBaseCandidates({ key: 'foo', pkgbase: 'foo-base', aurPkgname: 'foo-aur' }))
            .toEqual(['foo-base', 'foo-aur', 'foo']);
        expect(orphanBaseCandidates({ key: 'foo', pkgbase: 'foo' })).toEqual(['foo']);
    });

    test('falls back to key and pkgbase with their -debug packages', () => {
        expect(orphanFallbackNames({ key: 'foo' })).toEqual(['foo', 'foo-debug']);
        expect(orphanFallbackNames({ key: 'foo', pkgbase: 'foo-base' }))
            .toEqual(['foo', 'foo-debug', 'foo-base', 'foo-base-debug']);
    });
});

describe('selectOrphanRepoPackages', () => {
    const entry = (name: string, base?: string): RepoDbEntry => ({
        name,
        base,
        filename: `${name}-1.0-1-x86_64.pkg.tar.zst`,
    });

    test('selects split and -debug packages sharing the recorded pkgbase', () => {
        const entries = [
            entry('foo-cli', 'foo-base'),
            entry('foo-docs', 'foo-base'),
            entry('foo-base-debug', 'foo-base'),
            entry('foo', 'other'),
            entry('bar', 'bar'),
        ];

        const selection = selectOrphanRepoPackages(entries, [{ key: 'foo', pkgbase: 'foo-base' }], noProtection());

        expect(selection.dbNames).toEqual(['foo-cli', 'foo-docs', 'foo-base-debug']);
        expect(selection.artifactNames).toEqual(['foo-cli', 'foo-docs', 'foo-base-debug']);
        expect(selection.filenames).toEqual([
            'foo-cli-1.0-1-x86_64.pkg.tar.zst',
            'foo-docs-1.0-1-x86_64.pkg.tar.zst',
            'foo-base-debug-1.0-1-x86_64.pkg.tar.zst',
        ]);
    });

    test('uses the key as base for entries recorded before pkgbase existed', () => {
        const entries = [entry('foo', 'foo'), entry('foo-extras', 'foo'), entry('foo-debug', 'foo')];
        expect(selectOrphanRepoPackages(entries, [{ key: 'foo' }], noProtection()).dbNames)
            .toEqual(['foo', 'foo-extras', 'foo-debug']);
    });

    test('falls back to names when no database entry has a matching base', () => {
        const entries = [entry('foo'), entry('foo-debug'), entry('foo-tools')];
        const selection = selectOrphanRepoPackages(entries, [{ key: 'foo' }], noProtection());

        expect(selection.dbNames).toEqual(['foo', 'foo-debug']);
        expect(selection.artifactNames).toEqual(['foo', 'foo-debug']);
    });

    test('only targets names that exist in the database for repo-remove', () => {
        const selection = selectOrphanRepoPackages([entry('foo', 'other')], [{ key: 'foo' }], noProtection());
        expect(selection.dbNames).toEqual(['foo']);
        expect(selection.artifactNames).toEqual(['foo', 'foo-debug']);
    });

    test('still deletes fallback artifacts when the database is empty', () => {
        const selection = selectOrphanRepoPackages([], [{ key: 'foo', pkgbase: 'foo-base' }], noProtection());
        expect(selection.dbNames).toEqual([]);
        expect(selection.artifactNames).toEqual(['foo', 'foo-debug', 'foo-base', 'foo-base-debug']);
    });

    test('never selects packages belonging to configured names or bases', () => {
        const entries = [
            entry('foo-cli', 'shared'),
            entry('foo-docs', 'shared'),
            entry('foo', 'foo'),
            entry('foo-debug', 'foo'),
        ];
        const protection: RepoCleanupProtection = { names: new Set(['foo-debug']), bases: new Set(['shared']) };

        const selection = selectOrphanRepoPackages(entries, [{ key: 'foo', pkgbase: 'shared' }], protection);

        expect(selection.dbNames).toEqual(['foo']);
        expect(selection.artifactNames).toEqual(['foo']);
    });

    test('ignores entries that only appear in the repository by hand', () => {
        const selection = selectOrphanRepoPackages([entry('manual', 'manual')], [{ key: 'foo' }], noProtection());
        expect(selection.dbNames).toEqual([]);
        expect(selection.filenames).toEqual([]);
    });
});

describe('repoRemoveArgs', () => {
    test('passes the database followed by package names', () => {
        expect(repoRemoveArgs('/srv/my repo/localrepo.db.tar.gz', ['foo', 'foo-debug']))
            .toEqual(['/srv/my repo/localrepo.db.tar.gz', 'foo', 'foo-debug']);
    });
});

describe('readRepoDbEntries', () => {
    test('reads %NAME%, %BASE% and %FILENAME% from every desc entry', async () => {
        const baseDir = await makeBaseDir();
        const dbFile = path.join(baseDir, 'localrepo.db.tar.gz');
        await writeRepoDb(dbFile, [
            { name: 'foo', version: '1:2.0-1', base: 'foo' },
            { name: 'foo-debug', version: '1:2.0-1', base: 'foo' },
            { name: 'legacy', version: '3.1-2' },
        ]);

        expect(await readRepoDbEntries(dbFile)).toEqual([
            { name: 'foo', base: 'foo', filename: 'foo-1:2.0-1-x86_64.pkg.tar.zst' },
            { name: 'foo-debug', base: 'foo', filename: 'foo-debug-1:2.0-1-x86_64.pkg.tar.zst' },
            { name: 'legacy', base: undefined, filename: 'legacy-3.1-2-x86_64.pkg.tar.zst' },
        ]);
    });
});

describe('removeOrphanRepoPackages', () => {
    const files = [
        'foo-cli-1.0-1-x86_64.pkg.tar.zst',
        'foo-cli-1.0-1-x86_64.pkg.tar.zst.sig',
        'foo-cli-0.9-1-x86_64.pkg.tar.zst.sig',
        'foo-docs-1.0-1-x86_64.pkg.tar.zst',
        'foo-base-debug-1.0-1-x86_64.pkg.tar.zst',
        'foo-tools-1.0-1-x86_64.pkg.tar.zst',
        'manual-1.0-1-any.pkg.tar.zst',
    ];
    const kept = ['foo-tools-1.0-1-x86_64.pkg.tar.zst', 'manual-1.0-1-any.pkg.tar.zst'];
    const splitDb: DbPackage[] = [
        { name: 'foo-cli', version: '1.0-1', base: 'foo-base' },
        { name: 'foo-docs', version: '1.0-1', base: 'foo-base' },
        { name: 'foo-base-debug', version: '1.0-1', base: 'foo-base' },
        { name: 'foo-tools', version: '1.0-1', base: 'foo-tools' },
    ];

    test('removes every package of the recorded pkgbase and their files', async () => {
        const baseDir = await makeBaseDir();
        const repoDir = await makeRepoDir(baseDir, files);
        const dbFile = path.join(repoDir, 'localrepo.db.tar.gz');
        await writeRepoDb(dbFile, splitDb);
        const fake = await installFakeRepoRemove(baseDir, 0);

        try {
            const result = await removeOrphanRepoPackages(
                { name: 'localrepo' }, [{ key: 'foo', pkgbase: 'foo-base' }], noProtection(), baseDir
            );
            expect(result.removedFromDb).toEqual(['foo-cli', 'foo-docs', 'foo-base-debug']);
        } finally {
            fake.restore();
        }

        expect((await fs.readFile(fake.log, 'utf8')).trim().split('\n'))
            .toEqual([dbFile, 'foo-cli', 'foo-docs', 'foo-base-debug']);
        expect((await fs.readdir(repoDir)).sort()).toEqual(['localrepo.db.tar.gz', ...kept].sort());
    });

    test('skips repo-remove without a database and deletes fallback artifacts', async () => {
        const baseDir = await makeBaseDir();
        const repoDir = await makeRepoDir(baseDir, ['foo-1.0-1-x86_64.pkg.tar.zst', 'foo-1.0-1-x86_64.pkg.tar.zst.sig', 'foo-debug-1.0-1-x86_64.pkg.tar.zst', ...kept]);

        const result = await removeOrphanRepoPackages({ name: 'localrepo' }, [{ key: 'foo' }], noProtection(), baseDir);

        expect(result.removedFromDb).toEqual([]);
        expect(result.deletedFiles.sort()).toEqual([
            'foo-1.0-1-x86_64.pkg.tar.zst',
            'foo-1.0-1-x86_64.pkg.tar.zst.sig',
            'foo-debug-1.0-1-x86_64.pkg.tar.zst',
        ]);
        expect((await fs.readdir(repoDir)).sort()).toEqual(kept);
    });

    test('does not run repo-remove when nothing matches in the database', async () => {
        const baseDir = await makeBaseDir();
        const repoDir = await makeRepoDir(baseDir, []);
        await writeRepoDb(path.join(repoDir, 'localrepo.db.tar.gz'), [{ name: 'bar', version: '1.0-1', base: 'bar' }]);
        const fake = await installFakeRepoRemove(baseDir, 1);

        try {
            await expect(removeOrphanRepoPackages({ name: 'localrepo' }, [{ key: 'foo' }], noProtection(), baseDir))
                .resolves.toEqual({ removedFromDb: [], deletedFiles: [] });
        } finally {
            fake.restore();
        }
        await expect(fs.access(fake.log)).rejects.toThrow();
    });

    test('keeps every file when repo-remove fails', async () => {
        const baseDir = await makeBaseDir();
        const repoDir = await makeRepoDir(baseDir, files);
        await writeRepoDb(path.join(repoDir, 'localrepo.db.tar.gz'), splitDb);
        const fake = await installFakeRepoRemove(baseDir, 1);

        try {
            await expect(removeOrphanRepoPackages(
                { name: 'localrepo' }, [{ key: 'foo', pkgbase: 'foo-base' }], noProtection(), baseDir
            )).rejects.toThrow();
        } finally {
            fake.restore();
        }
        expect((await fs.readdir(repoDir)).sort()).toEqual(['localrepo.db.tar.gz', ...files].sort());
    });

    test('does nothing when the repository directory does not exist', async () => {
        const baseDir = await makeBaseDir();
        await expect(removeOrphanRepoPackages({ name: 'localrepo' }, [{ key: 'foo' }], noProtection(), baseDir))
            .resolves.toEqual({ removedFromDb: [], deletedFiles: [] });
    });
});

describe('selectStaleSplitPackages', () => {
    const entry = (name: string, version: string, base?: string): RepoDbEntry => ({
        name,
        base,
        filename: `${name}-${version}-x86_64.pkg.tar.zst`,
    });

    test('selects same-base packages the build did not produce', () => {
        const entries = [
            entry('foo', '2.0-1', 'foo'),
            entry('foo-debug', '1.0-1', 'foo'),
            entry('foo-docs', '1.0-1', 'foo'),
            entry('bar', '1.0-1', 'bar'),
        ];

        const selection = selectStaleSplitPackages(entries, ['foo-2.0-1-x86_64.pkg.tar.zst']);

        expect(selection.dbNames).toEqual(['foo-debug', 'foo-docs']);
        expect(selection.artifactNames).toEqual(['foo-debug', 'foo-docs']);
        expect(selection.filenames).toEqual(['foo-debug-1.0-1-x86_64.pkg.tar.zst', 'foo-docs-1.0-1-x86_64.pkg.tar.zst']);
    });

    test('keeps everything the build produced', () => {
        const entries = [entry('foo', '2.0-1', 'foo'), entry('foo-debug', '2.0-1', 'foo')];
        expect(selectStaleSplitPackages(entries, [
            'foo-2.0-1-x86_64.pkg.tar.zst',
            'foo-debug-2.0-1-x86_64.pkg.tar.zst',
        ]).dbNames).toEqual([]);
    });

    test('ignores entries without %BASE% and files that are not in the database', () => {
        const entries = [entry('foo', '2.0-1'), entry('foo-debug', '1.0-1')];
        expect(selectStaleSplitPackages(entries, ['foo-2.0-1-x86_64.pkg.tar.zst']).dbNames).toEqual([]);
        expect(selectStaleSplitPackages([entry('foo-debug', '1.0-1', 'foo')], ['foo-2.0-1-x86_64.pkg.tar.zst']).dbNames)
            .toEqual([]);
    });
});

describe('manageRepository stale split packages', () => {
    // The fake repo-add does not touch the database, so it is written in its post-add state.
    async function setup(removeRepoRemoveExit: number) {
        const baseDir = await makeBaseDir();
        const pkgdest = path.join(baseDir, 'pkgdest');
        await fs.mkdir(pkgdest, { recursive: true });
        await fs.writeFile(path.join(pkgdest, 'foo-2.0-1-x86_64.pkg.tar.zst'), '');
        const repoDir = await makeRepoDir(baseDir, [
            'foo-debug-1.0-1-x86_64.pkg.tar.zst',
            'foo-debug-1.0-1-x86_64.pkg.tar.zst.sig',
            'bar-1.0-1-x86_64.pkg.tar.zst',
        ]);
        const dbFile = path.join(repoDir, 'localrepo.db.tar.gz');
        await writeRepoDb(dbFile, [
            { name: 'foo', version: '2.0-1', base: 'foo' },
            { name: 'foo-debug', version: '1.0-1', base: 'foo' },
            { name: 'bar', version: '1.0-1', base: 'bar' },
        ]);
        const repoAdd = await installFakeTool(baseDir, 'repo-add', 0);
        const repoRemove = await installFakeRepoRemove(baseDir, removeRepoRemoveExit);
        const restore = () => { repoRemove.restore(); repoAdd.restore(); };
        return { baseDir, pkgdest, repoDir, dbFile, repoRemove, restore };
    }

    test('removes same-base packages no longer produced when removeOld is enabled', async () => {
        const { baseDir, pkgdest, repoDir, dbFile, repoRemove, restore } = await setup(0);
        try {
            await manageRepository({ name: 'localrepo', removeOld: true, removeOrphans: false }, pkgdest, baseDir);
        } finally {
            restore();
        }

        expect((await fs.readFile(repoRemove.log, 'utf8')).trim().split('\n')).toEqual([dbFile, 'foo-debug']);
        expect((await fs.readdir(repoDir)).sort()).toEqual([
            'bar-1.0-1-x86_64.pkg.tar.zst',
            'foo-2.0-1-x86_64.pkg.tar.zst',
            'localrepo.db.tar.gz',
        ]);
    });

    test('leaves them alone when removeOld is disabled', async () => {
        const { baseDir, pkgdest, repoDir, repoRemove, restore } = await setup(0);
        try {
            await manageRepository({ name: 'localrepo', removeOld: false, removeOrphans: false }, pkgdest, baseDir);
        } finally {
            restore();
        }

        await expect(fs.access(repoRemove.log)).rejects.toThrow();
        expect(await fs.readdir(repoDir)).toContain('foo-debug-1.0-1-x86_64.pkg.tar.zst');
    });

    test('does not fail the repository update when removing stale packages fails', async () => {
        const { baseDir, pkgdest, repoDir, restore } = await setup(1);
        try {
            await expect(manageRepository({ name: 'localrepo', removeOld: true, removeOrphans: false }, pkgdest, baseDir))
                .resolves.toBeUndefined();
        } finally {
            restore();
        }

        expect(await fs.readdir(repoDir)).toContain('foo-debug-1.0-1-x86_64.pkg.tar.zst.sig');
    });
});

