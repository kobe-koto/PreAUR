import { afterEach, describe, expect, test } from 'bun:test';
import simpleGit from 'simple-git';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ProjectGitManager, readProjectDataSnapshot } from '../src/project_git';
import { VersionStore, pruneOrphanVersions, type VersionInfo } from '../src/version_store';

const tmpDirs: string[] = [];

async function makeBaseDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preaur-version-store-'));
    tmpDirs.push(dir);
    return dir;
}

async function writeVersions(baseDir: string, versions: Record<string, VersionInfo>): Promise<void> {
    await fs.mkdir(path.join(baseDir, 'data'), { recursive: true });
    await fs.writeFile(path.join(baseDir, 'data', 'versions.json'), JSON.stringify(versions, null, 2), 'utf8');
}

async function readVersions(baseDir: string): Promise<Record<string, VersionInfo>> {
    return JSON.parse(await fs.readFile(path.join(baseDir, 'data', 'versions.json'), 'utf8'));
}

afterEach(async () => {
    while (tmpDirs.length) {
        const dir = tmpDirs.pop()!;
        await fs.rm(dir, { recursive: true, force: true });
    }
});

const versions: Record<string, VersionInfo> = {
    foo: { pkgver: '1.0', pkgrel: 1, source: 'aur', maintainer: 'alice', co_maintainers: [] },
    bar: { pkgver: '2.0', pkgrel: 1 },
    gone: { pkgver: '3.0', pkgrel: 2, source: 'aur' },
    'gone-too': { source: 'custom_git' },
};

describe('VersionStore.delete', () => {
    test('removes an entry and reports whether it existed', async () => {
        const baseDir = await makeBaseDir();
        await writeVersions(baseDir, versions);
        const store = new VersionStore(baseDir);
        await store.load();

        expect(store.delete('foo')).toBe(true);
        expect(store.get('foo')).toBeUndefined();
        expect(store.delete('foo')).toBe(false);
        expect(store.delete('missing')).toBe(false);
    });
});

describe('pruneOrphanVersions', () => {
    test('removes and returns entries whose pkgname is not configured', async () => {
        const baseDir = await makeBaseDir();
        await writeVersions(baseDir, versions);
        const store = new VersionStore(baseDir);
        await store.load();

        const removed = pruneOrphanVersions(store, ['foo', 'bar', 'not-built-yet']);

        expect(removed).toEqual([
            ['gone', versions.gone!],
            ['gone-too', versions['gone-too']!],
        ]);
        expect(store.entries().map(([name]) => name)).toEqual(['foo', 'bar']);
    });

    test('keeps every configured package when only one is processed with -p', async () => {
        const baseDir = await makeBaseDir();
        await writeVersions(baseDir, versions);
        const store = new VersionStore(baseDir);
        await store.load();

        // index.ts passes the full config.packages list, so a -p run on foo
        // must not prune bar.
        const configuredNames = ['foo', 'bar', 'gone', 'gone-too'];
        const packagesToProcess = configuredNames.filter(name => name === 'foo');
        expect(packagesToProcess).toEqual(['foo']);

        expect(pruneOrphanVersions(store, configuredNames)).toEqual([]);
        expect(store.entries()).toHaveLength(4);
    });

    test('returns nothing when there are no orphans', async () => {
        const baseDir = await makeBaseDir();
        const store = new VersionStore(baseDir);
        await store.load();

        expect(pruneOrphanVersions(store, ['foo'])).toEqual([]);
    });

    test('writes the remaining entries unchanged after save', async () => {
        const baseDir = await makeBaseDir();
        await writeVersions(baseDir, versions);
        const store = new VersionStore(baseDir);
        await store.load();

        pruneOrphanVersions(store, ['foo', 'bar']);
        await store.save();

        expect(await readVersions(baseDir)).toEqual({ foo: versions.foo!, bar: versions.bar! });

        const reloaded = new VersionStore(baseDir);
        await reloaded.load();
        expect(reloaded.get('gone')).toBeUndefined();
        expect(reloaded.get('foo')).toEqual(versions.foo!);
    });

    test('produces one versions: remove commit per orphan', async () => {
        const baseDir = await makeBaseDir();
        const git = simpleGit(baseDir);
        await git.raw(['init']);
        await git.addConfig('user.name', 'PreAUR Test');
        await git.addConfig('user.email', 'preaur@example.invalid');
        await git.addConfig('commit.gpgsign', 'false');
        await writeVersions(baseDir, versions);
        await git.add('.');
        await git.commit('init');

        const manager = new ProjectGitManager(
            baseDir,
            git,
            { enabled: true, remote: 'origin', sync: { allow_remote_overwrite_local: false }, push: { force: false } },
            'main'
        );

        const store = new VersionStore(baseDir);
        await store.load();
        const before = await manager.snapshotData();
        pruneOrphanVersions(store, ['foo', 'bar']);
        await store.save();
        await manager.commitDataChanges(before);

        const subjects = (await git.raw(['log', '--format=%s', '--reverse'])).trim().split('\n');
        expect(subjects).toEqual(['init', 'versions: remove gone', 'versions: remove gone-too']);
        expect((await readProjectDataSnapshot(baseDir)).versions).toEqual({ foo: versions.foo!, bar: versions.bar! });
    });
});
