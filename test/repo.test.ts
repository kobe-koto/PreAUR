import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { hasBuiltPackage, resolveBuiltPackage } from '../src/repo';

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
