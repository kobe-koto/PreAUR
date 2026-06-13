import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { hasBuiltPackage } from '../src/repo';

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
