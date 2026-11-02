import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    hasBuiltPackage,
    orphanRepoPackageNames,
    readRepoDbPackageNames,
    removeRepoPackages,
    repoAddArgs,
    repoRemoveArgs,
    resolveBuiltPackage,
    withRepoLock,
} from '../src/repo';
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

async function writeRepoDb(dbFile: string, packages: Array<{ name: string; version: string }>): Promise<void> {
    const entries = packages.flatMap(({ name, version }) => [
        tarEntry(`${name}-${version}/`, undefined),
        tarEntry(`${name}-${version}/desc`, `%FILENAME%\n${name}-${version}-x86_64.pkg.tar.zst\n\n%NAME%\n${name}\n\n%VERSION%\n${version}\n`),
    ]);
    await fs.writeFile(dbFile, gzipSync(Buffer.concat([...entries, Buffer.alloc(1024, 0)])));
}

async function installFakeRepoRemove(baseDir: string, exitCode: number): Promise<{ log: string; restore: () => void }> {
    const binDir = path.join(baseDir, 'bin');
    const log = path.join(baseDir, 'repo-remove.log');
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(
        path.join(binDir, 'repo-remove'),
        `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nexit ${exitCode}\n`,
        { mode: 0o755 }
    );
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;
    return { log, restore: () => { process.env.PATH = originalPath; } };
}

async function makeRepoDir(baseDir: string, files: string[]): Promise<string> {
    const repoDir = path.join(baseDir, 'repo', 'localrepo');
    await fs.mkdir(repoDir, { recursive: true });
    for (const file of files) await fs.writeFile(path.join(repoDir, file), '');
    return repoDir;
}

describe('orphanRepoPackageNames', () => {
    test('targets each pkgname and its -debug package', () => {
        expect(orphanRepoPackageNames(['foo', 'bar'])).toEqual(['foo', 'foo-debug', 'bar', 'bar-debug']);
    });

    test('never targets a package that is still configured', () => {
        expect(orphanRepoPackageNames(['foo'], ['foo-debug', 'baz'])).toEqual(['foo']);
    });
});

describe('repoRemoveArgs', () => {
    test('passes the database followed by package names', () => {
        expect(repoRemoveArgs('/srv/my repo/localrepo.db.tar.gz', ['foo', 'foo-debug']))
            .toEqual(['/srv/my repo/localrepo.db.tar.gz', 'foo', 'foo-debug']);
    });
});

describe('readRepoDbPackageNames', () => {
    test('reads %NAME% from every desc entry', async () => {
        const baseDir = await makeBaseDir();
        const dbFile = path.join(baseDir, 'localrepo.db.tar.gz');
        await writeRepoDb(dbFile, [
            { name: 'foo', version: '1:2.0-1' },
            { name: 'foo-debug', version: '1:2.0-1' },
            { name: 'foo-tools', version: '3.1-2' },
        ]);

        expect([...await readRepoDbPackageNames(dbFile)].sort()).toEqual(['foo', 'foo-debug', 'foo-tools']);
    });
});

describe('removeRepoPackages', () => {
    const files = [
        'foo-1.0-1-x86_64.pkg.tar.zst',
        'foo-1.0-1-x86_64.pkg.tar.zst.sig',
        'foo-debug-1.0-1-x86_64.pkg.tar.zst',
        'foo-0.9-1-x86_64.pkg.tar.zst.sig',
        'foo-tools-1.0-1-x86_64.pkg.tar.zst',
        'manual-1.0-1-any.pkg.tar.zst',
    ];
    const kept = ['foo-tools-1.0-1-x86_64.pkg.tar.zst', 'manual-1.0-1-any.pkg.tar.zst'];

    test('skips repo-remove without a database and deletes exact artifact matches and signatures', async () => {
        const baseDir = await makeBaseDir();
        const repoDir = await makeRepoDir(baseDir, files);

        const result = await removeRepoPackages({ name: 'localrepo' }, ['foo', 'foo-debug'], baseDir);

        expect(result.removedFromDb).toEqual([]);
        expect(result.deletedFiles.sort()).toEqual([
            'foo-0.9-1-x86_64.pkg.tar.zst.sig',
            'foo-1.0-1-x86_64.pkg.tar.zst',
            'foo-1.0-1-x86_64.pkg.tar.zst.sig',
            'foo-debug-1.0-1-x86_64.pkg.tar.zst',
        ]);
        expect((await fs.readdir(repoDir)).sort()).toEqual(kept);
    });

    test('passes repo-remove only the names present in the database', async () => {
        const baseDir = await makeBaseDir();
        const repoDir = await makeRepoDir(baseDir, files);
        const dbFile = path.join(repoDir, 'localrepo.db.tar.gz');
        await writeRepoDb(dbFile, [{ name: 'foo', version: '1.0-1' }, { name: 'foo-tools', version: '1.0-1' }]);
        const fake = await installFakeRepoRemove(baseDir, 0);

        try {
            const result = await removeRepoPackages({ name: 'localrepo' }, ['foo', 'foo-debug'], baseDir);
            expect(result.removedFromDb).toEqual(['foo']);
        } finally {
            fake.restore();
        }

        expect((await fs.readFile(fake.log, 'utf8')).trim().split('\n')).toEqual([dbFile, 'foo']);
        expect((await fs.readdir(repoDir)).sort()).toEqual(['localrepo.db.tar.gz', ...kept].sort());
    });

    test('does not run repo-remove when no name is in the database', async () => {
        const baseDir = await makeBaseDir();
        const repoDir = await makeRepoDir(baseDir, []);
        await writeRepoDb(path.join(repoDir, 'localrepo.db.tar.gz'), [{ name: 'bar', version: '1.0-1' }]);
        const fake = await installFakeRepoRemove(baseDir, 1);

        try {
            await expect(removeRepoPackages({ name: 'localrepo' }, ['foo', 'foo-debug'], baseDir))
                .resolves.toEqual({ removedFromDb: [], deletedFiles: [] });
        } finally {
            fake.restore();
        }
        await expect(fs.access(fake.log)).rejects.toThrow();
    });

    test('keeps every file when repo-remove fails', async () => {
        const baseDir = await makeBaseDir();
        const repoDir = await makeRepoDir(baseDir, files);
        await writeRepoDb(path.join(repoDir, 'localrepo.db.tar.gz'), [{ name: 'foo', version: '1.0-1' }]);
        const fake = await installFakeRepoRemove(baseDir, 1);

        try {
            await expect(removeRepoPackages({ name: 'localrepo' }, ['foo', 'foo-debug'], baseDir)).rejects.toThrow();
        } finally {
            fake.restore();
        }
        expect((await fs.readdir(repoDir)).sort()).toEqual(['localrepo.db.tar.gz', ...files].sort());
    });

    test('does nothing when the repository directory does not exist', async () => {
        const baseDir = await makeBaseDir();
        await expect(removeRepoPackages({ name: 'localrepo' }, ['foo'], baseDir))
            .resolves.toEqual({ removedFromDb: [], deletedFiles: [] });
    });
});
