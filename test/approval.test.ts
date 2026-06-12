import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { runApprovalCheck, type AurMetadataFetcher } from '../src/approval';
import type { PreaurPackage } from '../src/config';
import { VersionStore } from '../src/version_store';

const tmpDirs: string[] = [];

async function makeBaseDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preaur-approval-'));
    tmpDirs.push(dir);
    return dir;
}

async function writeDataFile(baseDir: string, name: string, content: string): Promise<void> {
    const dataDir = path.join(baseDir, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, name), content, 'utf8');
}

async function readDataFile(baseDir: string, name: string): Promise<string> {
    return fs.readFile(path.join(baseDir, 'data', name), 'utf8');
}

afterEach(async () => {
    while (tmpDirs.length) {
        const dir = tmpDirs.pop()!;
        await fs.rm(dir, { recursive: true, force: true });
    }
});

describe('runApprovalCheck', () => {
    test('writes newly discovered packages and AUR maintainers as unapproved', async () => {
        const baseDir = await makeBaseDir();
        const store = new VersionStore(baseDir);
        await store.load();

        const packages: PreaurPackage[] = [{ pkgname: 'spotify', maintainer: 'preaur-owner' }];
        const fetcher: AurMetadataFetcher = async () => new Map([
            ['spotify', {
                name: 'spotify',
                maintainer: 'gromit',
                coMaintainers: ['Antiz'],
            }],
        ]);

        await expect(runApprovalCheck(packages, store, baseDir, fetcher)).rejects.toThrow(/Unapproved AUR ownership entries/);

        expect(await readDataFile(baseDir, 'known_packages')).toBe('!!! spotify # Maintainer: gromit, Antiz\n');
        expect(await readDataFile(baseDir, 'known_maintainers')).toBe(
            '!!! Antiz # Maintaining: spotify\n'
            + '!!! gromit # Maintaining: spotify\n'
        );
        expect(JSON.parse(await readDataFile(baseDir, 'versions.json')).spotify).toEqual({
            maintainer: 'gromit',
            co_maintainers: ['Antiz'],
        });
    });

    test('skips approved orphan packages unless allow_orphan_package_build is true', async () => {
        const baseDir = await makeBaseDir();
        await writeDataFile(baseDir, 'known_packages', 'dma\n');

        const store = new VersionStore(baseDir);
        await store.load();

        const packages: PreaurPackage[] = [{ pkgname: 'dma', maintainer: 'preaur-owner' }];
        const fetcher: AurMetadataFetcher = async () => new Map([
            ['dma', {
                name: 'dma',
                maintainer: null,
                coMaintainers: [],
            }],
        ]);

        const result = await runApprovalCheck(packages, store, baseDir, fetcher);

        expect(result.buildablePackages).toEqual([]);
        expect(result.skippedPackages.map(item => item.pkg.pkgname)).toEqual(['dma']);
        expect(await readDataFile(baseDir, 'known_maintainers')).toBe('');
        expect(await readDataFile(baseDir, 'known_packages')).toBe('dma # Maintainer: orphan\n');
    });

    test('allows approved orphan packages when allow_orphan_package_build is true', async () => {
        const baseDir = await makeBaseDir();
        await writeDataFile(baseDir, 'known_packages', 'dma\n');

        const store = new VersionStore(baseDir);
        await store.load();

        const packages: PreaurPackage[] = [{
            pkgname: 'dma',
            maintainer: 'preaur-owner',
            allow_orphan_package_build: true,
        }];
        const fetcher: AurMetadataFetcher = async () => new Map([
            ['dma', {
                name: 'dma',
                maintainer: null,
                coMaintainers: [],
            }],
        ]);

        const result = await runApprovalCheck(packages, store, baseDir, fetcher);

        expect(result.buildablePackages.map(pkg => pkg.pkgname)).toEqual(['dma']);
        expect(result.skippedPackages).toEqual([]);
    });

    test('ignores whole-line and inline comments in known list files', async () => {
        const baseDir = await makeBaseDir();
        await writeDataFile(baseDir, 'known_packages', '# approved packages\nspotify # Maintainer: old\n');
        await writeDataFile(baseDir, 'known_maintainers', '# approved maintainers\ngromit # Maintaining: old\n');

        const store = new VersionStore(baseDir);
        await store.load();

        const packages: PreaurPackage[] = [{ pkgname: 'spotify', maintainer: 'preaur-owner' }];
        const fetcher: AurMetadataFetcher = async () => new Map([
            ['spotify', {
                name: 'spotify',
                maintainer: 'gromit',
                coMaintainers: [],
            }],
        ]);

        const result = await runApprovalCheck(packages, store, baseDir, fetcher);

        expect(result.buildablePackages.map(pkg => pkg.pkgname)).toEqual(['spotify']);
        expect(await readDataFile(baseDir, 'known_packages')).toBe('spotify # Maintainer: gromit\n');
        expect(await readDataFile(baseDir, 'known_maintainers')).toBe('gromit # Maintaining: spotify\n');
    });

    test('marks a package unapproved when its AUR ownership changes', async () => {
        const baseDir = await makeBaseDir();
        await writeDataFile(baseDir, 'known_packages', 'spotify\n');
        await writeDataFile(baseDir, 'known_maintainers', 'new-maintainer\n');

        const store = new VersionStore(baseDir);
        await store.load();
        store.set('spotify', {
            maintainer: 'old-maintainer',
            co_maintainers: [],
        });
        await store.save();

        const packages: PreaurPackage[] = [{ pkgname: 'spotify', maintainer: 'preaur-owner' }];
        const fetcher: AurMetadataFetcher = async () => new Map([
            ['spotify', {
                name: 'spotify',
                maintainer: 'new-maintainer',
                coMaintainers: [],
            }],
        ]);

        await expect(runApprovalCheck(packages, store, baseDir, fetcher)).rejects.toThrow(/packages: spotify/);
        expect(await readDataFile(baseDir, 'known_packages')).toBe('!!! spotify # Maintainer: new-maintainer\n');
    });
});
