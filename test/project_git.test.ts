import { afterEach, describe, expect, test } from 'bun:test';
import simpleGit from 'simple-git';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ProjectGitManager, readProjectDataSnapshot, saveVersionStoreUpdate } from '../src/project_git';
import { VersionStore } from '../src/version_store';

const tmpDirs: string[] = [];

async function makeGitRepo(): Promise<{ baseDir: string; git: ReturnType<typeof simpleGit> }> {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'preaur-project-git-'));
    tmpDirs.push(baseDir);

    const git = simpleGit(baseDir);
    await git.raw(['init']);
    await git.addConfig('user.name', 'PreAUR Test');
    await git.addConfig('user.email', 'preaur@example.invalid');
    await git.addConfig('commit.gpgsign', 'false');
    await git.addConfig('tag.gpgsign', 'false');

    return { baseDir, git };
}

async function writeDataFile(baseDir: string, name: string, content: string): Promise<void> {
    const dataDir = path.join(baseDir, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, name), content, 'utf8');
}

async function logSubjects(baseDir: string): Promise<string[]> {
    const output = await simpleGit(baseDir).raw(['log', '--format=%s', '--reverse']);
    return output.trim().split('\n').filter(Boolean);
}

afterEach(async () => {
    while (tmpDirs.length) {
        const dir = tmpDirs.pop()!;
        await fs.rm(dir, { recursive: true, force: true });
    }
});

describe('ProjectGitManager', () => {
    test('splits project data changes into focused commits', async () => {
        const { baseDir, git } = await makeGitRepo();

        await writeDataFile(baseDir, 'versions.json', JSON.stringify({
            foo: {
                source: 'aur',
                aur_pkgname: 'foo',
                maintainer: 'old',
                co_maintainers: [],
            },
        }, null, 2));
        await writeDataFile(baseDir, 'known_packages', 'foo # Maintainer: old\n');
        await writeDataFile(baseDir, 'known_maintainers', 'old # Maintaining: foo\n');
        await git.add(['data/versions.json', 'data/known_packages', 'data/known_maintainers']);
        await git.commit('initial data');

        const before = await readProjectDataSnapshot(baseDir);

        await writeDataFile(baseDir, 'versions.json', JSON.stringify({
            foo: {
                source: 'aur',
                aur_pkgname: 'foo',
                maintainer: 'new',
                co_maintainers: [],
            },
        }, null, 2));
        await writeDataFile(baseDir, 'known_packages', 'bar # Source: custom git\n!!! foo # Maintainer: new\n');
        await writeDataFile(baseDir, 'known_maintainers', 'new # Maintaining: foo\n');

        const manager = new ProjectGitManager(baseDir, git, {
            enabled: true,
            remote: 'origin',
            sync: {},
            push: {},
        }, 'main');
        await manager.commitDataChanges(before);

        expect(await logSubjects(baseDir)).toEqual([
            'initial data',
            'approval: update foo maintainers',
            'approval: add known package bar',
            'approval: unapprove package foo',
            'approval: add known maintainer new',
            'approval: remove known maintainer old',
        ]);
        expect(await fs.readFile(path.join(baseDir, 'data', 'known_packages'), 'utf8'))
            .toBe('bar # Source: custom git\n!!! foo # Maintainer: new\n');
    });

    test('commits version store updates per package', async () => {
        const { baseDir, git } = await makeGitRepo();
        await writeDataFile(baseDir, 'versions.json', '{}');
        await git.add(['data/versions.json']);
        await git.commit('initial data');

        const store = new VersionStore(baseDir);
        await store.load();

        const manager = new ProjectGitManager(baseDir, git, {
            enabled: true,
            remote: 'origin',
            sync: {},
            push: {},
        }, 'main');

        await saveVersionStoreUpdate(store, 'foo', { pkgver: '1.2.3', pkgrel: 1 }, manager);
        await saveVersionStoreUpdate(store, 'bar', { epoch: 2, pkgver: '4.5.6', pkgrel: 7 }, manager);

        expect(await logSubjects(baseDir)).toEqual([
            'initial data',
            'versions: update foo to 1.2.3-1',
            'versions: update bar to 2:4.5.6-7',
        ]);
    });
});
