import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { packageCacheDirs, pruneUnreferencedSourceFiles, removeDirs } from '../src/workdirs.ts';

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preaur-workdirs-'));
    tmpDirs.push(dir);
    return dir;
}

afterEach(async () => {
    while (tmpDirs.length) {
        await fs.rm(tmpDirs.pop()!, { recursive: true, force: true });
    }
});

describe('pruneUnreferencedSourceFiles', () => {
    test('deletes only regular files no source entry refers to', async () => {
        const srcdest = await makeTmpDir();
        const outside = await makeTmpDir();
        for (const file of [
            'demo-1.0.0.tar.gz',
            'demo-2.0.0.tar.gz',
            'demo-2.0.0-x86_64.deb',
            'demo-2.0.0-aarch64.deb.part',
            'demo-1.0.0-x86_64.deb.part',
            'old.fossil',
        ]) {
            await fs.writeFile(path.join(srcdest, file), file);
        }
        await fs.mkdir(path.join(srcdest, 'old-vcs-checkout'));
        await fs.writeFile(path.join(outside, 'target'), 'target');
        await fs.symlink(path.join(outside, 'target'), path.join(srcdest, 'link'));

        const result = await pruneUnreferencedSourceFiles(srcdest, [
            'demo-2.0.0.tar.gz::https://example.com/v2.0.0.tar.gz',
            'https://example.com/demo-2.0.0-x86_64.deb',
            'https://example.com/demo-2.0.0-aarch64.deb',
            'git+https://example.com/demo.git',
        ]);

        expect(result).toEqual({ removed: ['demo-1.0.0-x86_64.deb.part', 'demo-1.0.0.tar.gz'], failed: [] });
        expect((await fs.readdir(srcdest)).sort()).toEqual([
            'demo-2.0.0-aarch64.deb.part',
            'demo-2.0.0-x86_64.deb',
            'demo-2.0.0.tar.gz',
            'link',
            'old-vcs-checkout',
            'old.fossil',
        ]);
        expect(await fs.readFile(path.join(outside, 'target'), 'utf8')).toBe('target');
    });

    test('empties SRCDEST of files when the PKGBUILD has no sources', async () => {
        const srcdest = await makeTmpDir();
        await fs.writeFile(path.join(srcdest, 'stale.tar.gz'), '');

        expect((await pruneUnreferencedSourceFiles(srcdest, [])).removed).toEqual(['stale.tar.gz']);
    });

    test('treats a missing SRCDEST as empty', async () => {
        const base = await makeTmpDir();
        expect(await pruneUnreferencedSourceFiles(path.join(base, 'missing'), ['a.tar.gz'])).toEqual({ removed: [], failed: [] });
    });
});

describe('packageCacheDirs', () => {
    test('resolves the work and pkgbuilds directories of a package', () => {
        expect(packageCacheDirs('/srv/preaur', 'demo-bin')).toEqual([
            '/srv/preaur/work/demo-bin',
            '/srv/preaur/pkgbuilds/demo-bin',
        ]);
    });

    test('refuses names that are not a single path segment', () => {
        for (const name of ['', '.', '..', 'a/b', '../x', 'a\\b', 'a\0b']) {
            expect(packageCacheDirs('/srv/preaur', name)).toBeUndefined();
        }
    });
});

describe('removeDirs', () => {
    test('removes existing directories recursively and skips missing ones', async () => {
        const base = await makeTmpDir();
        const work = path.join(base, 'work', 'demo');
        await fs.mkdir(path.join(work, 'srcdest'), { recursive: true });
        await fs.writeFile(path.join(work, 'srcdest', 'a.tar.gz'), '');

        expect(await removeDirs([work, path.join(base, 'pkgbuilds', 'demo')])).toEqual([work]);
        expect(await fs.readdir(path.join(base, 'work'))).toEqual([]);
    });

    test('removes a symlink without following it', async () => {
        const base = await makeTmpDir();
        const target = await makeTmpDir();
        await fs.writeFile(path.join(target, 'keep'), '');
        await fs.mkdir(path.join(base, 'pkgbuilds'));
        const link = path.join(base, 'pkgbuilds', 'demo');
        await fs.symlink(target, link);

        expect(await removeDirs([link])).toEqual([link]);
        expect(await fs.readdir(target)).toEqual(['keep']);
    });
});
