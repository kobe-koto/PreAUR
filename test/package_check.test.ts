import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { runPackageVersionCheck, type PackageVersionCheckDeps } from '../src/package_check';
import type { PreaurPackage } from '../src/config';
import { VersionStore } from '../src/version_store';

const tmpDirs: string[] = [];

async function makeBaseDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preaur-package-check-'));
    tmpDirs.push(dir);
    return dir;
}

afterEach(async () => {
    while (tmpDirs.length) {
        const dir = tmpDirs.pop()!;
        await fs.rm(dir, { recursive: true, force: true });
    }
});

function makeDeps(finalData: { epoch?: string; pkgver: string; pkgrel: number }, changed = false): PackageVersionCheckDeps {
    return {
        preparePackageDiff: async (pkgname) => ({
            path: `/tmp/preaur-test/${pkgname}`,
            git: {} as any,
        }),
        updateDynamicPkgver: async () => false,
        updatePkgBuild: async () => changed,
        parsePkgBuild: async () => finalData,
    };
}

describe('runPackageVersionCheck', () => {
    test('schedules packages without a stored successful build version', async () => {
        const baseDir = await makeBaseDir();
        const store = new VersionStore(baseDir);
        await store.load();

        const packages: PreaurPackage[] = [{ pkgname: 'demo', maintainer: 'preaur-owner' }];
        const result = await runPackageVersionCheck(packages, store, {
            baseDir,
            deps: makeDeps({ pkgver: '1.0.0', pkgrel: 1 }),
        });

        expect(result.buildPlans.map(plan => plan.pkg.pkgname)).toEqual(['demo']);
        expect(store.get('demo')?.pkgver).toBeUndefined();
        expect(store.get('demo')?.pkgrel).toBeUndefined();
    });

    test('skips packages when the final PKGBUILD version matches the stored version', async () => {
        const baseDir = await makeBaseDir();
        const store = new VersionStore(baseDir);
        await store.load();
        store.set('demo', { pkgver: '1.0.0', pkgrel: 1 });

        const packages: PreaurPackage[] = [{ pkgname: 'demo', maintainer: 'preaur-owner' }];
        const result = await runPackageVersionCheck(packages, store, {
            baseDir,
            deps: makeDeps({ pkgver: '1.0.0', pkgrel: 1 }),
        });

        expect(result.buildPlans).toEqual([]);
        expect(result.skippedPackages.map(item => item.pkg.pkgname)).toEqual(['demo']);
    });

    test('skips unchanged packages only when the repo artifact already exists', async () => {
        const baseDir = await makeBaseDir();
        const store = new VersionStore(baseDir);
        await store.load();
        store.set('demo', { pkgver: '1.0.0', pkgrel: 1 });

        const packages: PreaurPackage[] = [{ pkgname: 'demo', maintainer: 'preaur-owner' }];
        const deps = makeDeps({ pkgver: '1.0.0', pkgrel: 1 });
        deps.hasBuiltPackage = async () => true;

        const result = await runPackageVersionCheck(packages, store, {
            baseDir,
            repo: { name: 'localrepo' },
            deps,
        });

        expect(result.buildPlans).toEqual([]);
        expect(result.skippedPackages.map(item => item.reason)).toEqual([
            'version unchanged and artifact already exists (1.0.0-1)',
        ]);
    });

    test('schedules unchanged packages when the repo artifact is missing', async () => {
        const baseDir = await makeBaseDir();
        const store = new VersionStore(baseDir);
        await store.load();
        store.set('demo', { pkgver: '1.0.0', pkgrel: 1 });

        const packages: PreaurPackage[] = [{ pkgname: 'demo', maintainer: 'preaur-owner' }];
        const deps = makeDeps({ pkgver: '1.0.0', pkgrel: 1 });
        deps.hasBuiltPackage = async () => false;

        const result = await runPackageVersionCheck(packages, store, {
            baseDir,
            repo: { name: 'localrepo' },
            deps,
        });

        expect(result.buildPlans.map(plan => plan.pkg.pkgname)).toEqual(['demo']);
        expect(result.skippedPackages).toEqual([]);
        expect(store.get('demo')?.pkgver).toBe('1.0.0');
    });

    test('applies checker template updates during check phase', async () => {
        const baseDir = await makeBaseDir();
        const store = new VersionStore(baseDir);
        await store.load();
        store.set('demo', { pkgver: '1.0.0', pkgrel: 1 });

        let capturedUpdates: Record<string, string> | undefined;
        const deps = makeDeps({ pkgver: '2.0.0', pkgrel: 1 }, true);
        deps.fetchLatestVersion = async () => ({ version: '2.0.0' });
        deps.updatePkgBuild = async (pkgbuildPath, updates) => {
            capturedUpdates = updates;
            return true;
        };

        const packages: PreaurPackage[] = [{
            pkgname: 'demo',
            maintainer: 'preaur-owner',
            checker: {
                type: 'github',
                repo: 'owner/demo',
            },
        }];

        const result = await runPackageVersionCheck(packages, store, {
            baseDir,
            deps,
        });

        expect(capturedUpdates).toEqual({ pkgver: '2.0.0' });
        expect(result.buildPlans.map(plan => plan.finalData.pkgver)).toEqual(['2.0.0']);
        expect(store.get('demo')?.pkgver).toBe('1.0.0');
    });
});
