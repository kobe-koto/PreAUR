import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { hasBuiltPackage, repoAddArgs, resolveBuiltPackage, withRepoLock } from '../src/repo';

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
