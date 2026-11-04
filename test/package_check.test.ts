import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { runPackageVersionCheck, type PackageVersionCheckDeps } from '../src/package_check.ts';
import type { PreaurPackage } from '../src/config.ts';
import { envPairsToRecord, type EnvPairs } from '../src/env.ts';
import { VersionStore } from '../src/version_store.ts';
import type { WebhookNotifier } from '../src/webhook.ts';

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

function makeDeps(finalData: { epoch?: number; pkgver: string; pkgrel: number; pkgbase?: string }, changed = false): PackageVersionCheckDeps {
    return {
        preparePackageDiff: async (pkgname) => ({
            path: `/tmp/preaur-test/${pkgname}`,
            git: {} as any,
        }),
        updateDynamicPkgver: async () => false,
        updatePkgBuild: async () => changed,
        parsePkgBuild: async () => ({
            epoch: finalData.epoch ?? 0,
            pkgver: finalData.pkgver,
            pkgrel: finalData.pkgrel,
            ...(finalData.pkgbase ? { pkgbase: finalData.pkgbase } : {}),
        }),
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

    test('syncs missing stored version and skips build when the repo artifact already exists', async () => {
        const baseDir = await makeBaseDir();
        const store = new VersionStore(baseDir);
        await store.load();

        const packages: PreaurPackage[] = [{ pkgname: 'demo', maintainer: 'preaur-owner' }];
        const deps = makeDeps({ epoch: 2, pkgver: '1.0.0', pkgrel: 1 });
        deps.hasBuiltPackage = async () => true;

        const result = await runPackageVersionCheck(packages, store, {
            baseDir,
            repo: { name: 'localrepo' },
            deps,
        });

        expect(result.buildPlans).toEqual([]);
        expect(result.skippedPackages.map(item => item.reason)).toEqual([
            'no stored successful build version but artifact already exists; synced version store (2:1.0.0-1)',
        ]);
        expect(store.get('demo')).toMatchObject({ epoch: 2, pkgver: '1.0.0', pkgrel: 1 });

        const reloadedStore = new VersionStore(baseDir);
        await reloadedStore.load();
        expect(reloadedStore.get('demo')).toMatchObject({ epoch: 2, pkgver: '1.0.0', pkgrel: 1 });
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

    test('does not schedule builds only because PKGBUILD content was rewritten', async () => {
        const baseDir = await makeBaseDir();
        const store = new VersionStore(baseDir);
        await store.load();
        store.set('demo', { pkgver: '1.0.0', pkgrel: 1 });

        const packages: PreaurPackage[] = [{ pkgname: 'demo', maintainer: 'preaur-owner' }];
        const result = await runPackageVersionCheck(packages, store, {
            baseDir,
            deps: makeDeps({ pkgver: '1.0.0', pkgrel: 1 }, true),
        });

        expect(result.buildPlans).toEqual([]);
        expect(result.skippedPackages.map(item => item.reason)).toEqual(['version unchanged (1.0.0-1)']);
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
        deps.updatePkgBuild = async (pkgname, pkgbuildPath, updates) => {
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

    test('passes package-scoped work directories to PKGBUILD commands', async () => {
        const baseDir = await makeBaseDir();
        const store = new VersionStore(baseDir);
        await store.load();

        let dynamicEnv: EnvPairs | undefined;
        let updateEnv: EnvPairs | undefined;
        const deps = makeDeps({ pkgver: '1.0.0', pkgrel: 1 });
        deps.updateDynamicPkgver = async (pkgbuildPath, env) => {
            dynamicEnv = env;
            return false;
        };
        deps.updatePkgBuild = async (pkgname, pkgbuildPath, updates, forceBumpRel, parser, env) => {
            updateEnv = env;
            return false;
        };

        const packages: PreaurPackage[] = [{ pkgname: 'demo', maintainer: 'preaur-owner' }];
        const result = await runPackageVersionCheck(packages, store, {
            baseDir,
            deps,
        });

        const dynamicEnvRecord = envPairsToRecord(dynamicEnv ?? []);
        const updateEnvRecord = envPairsToRecord(updateEnv ?? []);

        expect(dynamicEnvRecord).toEqual({
            SRCDEST: path.join(baseDir, 'work', 'demo', 'srcdest'),
            SRCPKGDEST: path.join(baseDir, 'work', 'demo', 'srcpkgdest'),
            LOGDEST: path.join(baseDir, 'work', 'demo', 'logdest'),
            BUILDDIR: path.join(baseDir, 'work', 'demo', 'builddir'),
            PKGDEST: path.join(baseDir, 'work', 'demo', 'pkgdest'),
        });
        expect(updateEnvRecord).toEqual(dynamicEnvRecord);
        expect(result.buildPlans[0]?.workDirs.pkgdest).toBe(path.join(baseDir, 'work', 'demo', 'pkgdest'));
        expect(result.buildPlans[0]?.env).toEqual(dynamicEnv);

        await expect(fs.stat(path.join(baseDir, 'work', 'demo', 'makepkg.conf'))).rejects.toThrow();
        await expect(fs.stat(path.join(baseDir, 'work', 'demo', 'logdest'))).rejects.toThrow();
    });

    test('uses session package log directory for LOGDEST when provided', async () => {
        const baseDir = await makeBaseDir();
        const sessionLogDir = path.join(baseDir, 'logs', 'session');
        const store = new VersionStore(baseDir);
        await store.load();

        let updateEnv: EnvPairs | undefined;
        const deps = makeDeps({ pkgver: '1.0.0', pkgrel: 1 });
        deps.updatePkgBuild = async (pkgname, pkgbuildPath, updates, forceBumpRel, parser, env) => {
            updateEnv = env;
            return false;
        };

        await runPackageVersionCheck([{ pkgname: 'demo', maintainer: 'preaur-owner' }], store, {
            baseDir,
            sessionLogDir,
            deps,
        });

        expect(envPairsToRecord(updateEnv ?? []).LOGDEST).toBe(path.join(sessionLogDir, 'demo'));
    });

    test('notifies PACKAGE_CHECK_FAILED when a package version check throws', async () => {
        const baseDir = await makeBaseDir();
        const store = new VersionStore(baseDir);
        await store.load();

        const events: Array<{ tag: string; context: Record<string, unknown> }> = [];
        const webhook = {
            notify: async (tag: string, context: Record<string, unknown> = {}) => {
                events.push({ tag, context });
            },
        } as unknown as WebhookNotifier;

        const deps = makeDeps({ pkgver: '1.0.0', pkgrel: 1 });
        deps.parsePkgBuild = async () => {
            throw new Error('sandbox exploded');
        };

        const result = await runPackageVersionCheck([{ pkgname: 'demo', maintainer: 'preaur-owner' }], store, {
            baseDir,
            deps,
            webhook,
        });

        expect(result.buildPlans).toEqual([]);
        expect(result.skippedPackages.map(item => item.reason)).toEqual(['error during processing: sandbox exploded']);
        expect(events).toEqual([
            { tag: 'PACKAGE_CHECK_FAILED', context: { pkgname: 'demo', error: 'sandbox exploded' } },
        ]);
    });

    test('records pkgbase when syncing a missing stored version', async () => {
        const baseDir = await makeBaseDir();
        const store = new VersionStore(baseDir);
        await store.load();

        const deps = makeDeps({ pkgver: '1.0.0', pkgrel: 1, pkgbase: 'demo-base' });
        deps.hasBuiltPackage = async () => true;
        await runPackageVersionCheck([{ pkgname: 'demo', maintainer: 'preaur-owner' }], store, {
            baseDir,
            repo: { name: 'localrepo' },
            deps,
        });

        expect(store.get('demo')).toEqual({ epoch: 0, pkgver: '1.0.0', pkgrel: 1, pkgbase: 'demo-base' });
    });

    test('backfills pkgbase for an unchanged version without touching other fields', async () => {
        const baseDir = await makeBaseDir();
        const store = new VersionStore(baseDir);
        await store.load();
        store.set('demo', { pkgver: '1.0.0', pkgrel: 1, maintainer: 'alice' });

        const deps = makeDeps({ pkgver: '1.0.0', pkgrel: 1, pkgbase: 'demo-base' });
        deps.hasBuiltPackage = async () => true;
        const result = await runPackageVersionCheck([{ pkgname: 'demo', maintainer: 'preaur-owner' }], store, {
            baseDir,
            repo: { name: 'localrepo' },
            deps,
        });

        expect(result.buildPlans).toEqual([]);
        expect(store.get('demo')).toEqual({ pkgver: '1.0.0', pkgrel: 1, maintainer: 'alice', pkgbase: 'demo-base' });
        expect(JSON.parse(await fs.readFile(path.join(baseDir, 'data', 'versions.json'), 'utf8')).demo.pkgbase).toBe('demo-base');
    });

    test('does not write versions.json when pkgbase is already recorded', async () => {
        const baseDir = await makeBaseDir();
        const store = new VersionStore(baseDir);
        await store.load();
        store.set('demo', { pkgver: '1.0.0', pkgrel: 1, pkgbase: 'demo-base' });

        const deps = makeDeps({ pkgver: '1.0.0', pkgrel: 1, pkgbase: 'demo-base' });
        deps.hasBuiltPackage = async () => true;
        await runPackageVersionCheck([{ pkgname: 'demo', maintainer: 'preaur-owner' }], store, {
            baseDir,
            repo: { name: 'localrepo' },
            deps,
        });

        await expect(fs.access(path.join(baseDir, 'data', 'versions.json'))).rejects.toThrow();
    });

    describe('version marker', () => {
        const COMMIT = 'a'.repeat(40);
        const STATIC_PKGBUILD = 'pkgname=demo\npkgver=1.0.0\npkgrel=1\npackage() {\n  true\n}\n';
        const marker = (commit = COMMIT) => ({
            commit,
            git: 'https://aur.archlinux.org/demo.git',
            parser: 'native',
            builder: 'extra-x86_64-build',
        });

        async function setup(pkgbuild: string, commit: string | undefined = COMMIT) {
            const baseDir = await makeBaseDir();
            const pkgDir = path.join(baseDir, 'pkgbuilds', 'demo');
            await fs.mkdir(pkgDir, { recursive: true });
            await fs.writeFile(path.join(pkgDir, 'PKGBUILD'), pkgbuild, 'utf8');
            const store = new VersionStore(baseDir);
            await store.load();
            const calls = { parse: 0, dynamic: 0 };
            const deps: PackageVersionCheckDeps = {
                ...makeDeps({ pkgver: '1.0.0', pkgrel: 1 }),
                preparePackageDiff: async () => ({ path: pkgDir, git: {} as any }),
                resolveHeadCommit: async () => commit,
            };
            const parse = deps.parsePkgBuild!;
            deps.parsePkgBuild = async (...args) => { calls.parse++; return parse(...args); };
            deps.updateDynamicPkgver = async () => { calls.dynamic++; return false; };
            return { baseDir, store, deps, calls };
        }

        const packages: PreaurPackage[] = [{ pkgname: 'demo', maintainer: 'preaur-owner' }];

        test('records the marker when a static version is confirmed unchanged', async () => {
            const { baseDir, store, deps } = await setup(STATIC_PKGBUILD);
            store.set('demo', { pkgver: '1.0.0', pkgrel: 1 });
            deps.hasBuiltPackage = async () => true;

            await runPackageVersionCheck(packages, store, { baseDir, repo: { name: 'localrepo' }, deps });

            expect(store.get('demo')?.version_marker).toEqual(marker());
        });

        test('skips the PKGBUILD commands when the marker matches and the artifact exists', async () => {
            const { baseDir, store, deps, calls } = await setup(STATIC_PKGBUILD);
            store.set('demo', { pkgver: '1.0.0', pkgrel: 1, version_marker: marker() });
            deps.hasBuiltPackage = async () => true;

            const result = await runPackageVersionCheck(packages, store, { baseDir, repo: { name: 'localrepo' }, deps });

            expect(calls).toEqual({ parse: 0, dynamic: 0 });
            expect(result.skippedPackages.map(item => item.reason)).toEqual([
                'version marker unchanged and artifact already exists (1.0.0-1, commit aaaaaaaaaaaa)',
            ]);
        });

        test('runs the full check when the commit changed', async () => {
            const { baseDir, store, deps, calls } = await setup(STATIC_PKGBUILD, 'b'.repeat(40));
            store.set('demo', { pkgver: '1.0.0', pkgrel: 1, version_marker: marker() });
            deps.hasBuiltPackage = async () => true;

            await runPackageVersionCheck(packages, store, { baseDir, repo: { name: 'localrepo' }, deps });

            expect(calls.parse).toBe(1);
            expect(store.get('demo')?.version_marker).toEqual(marker('b'.repeat(40)));
        });

        test('runs the full check and keeps the marker for the build when the artifact is missing', async () => {
            const { baseDir, store, deps, calls } = await setup(STATIC_PKGBUILD);
            store.set('demo', { pkgver: '1.0.0', pkgrel: 1, version_marker: marker() });
            deps.hasBuiltPackage = async () => false;

            const result = await runPackageVersionCheck(packages, store, { baseDir, repo: { name: 'localrepo' }, deps });

            expect(calls.parse).toBe(1);
            expect(result.buildPlans.map(plan => plan.versionMarker)).toEqual([marker()]);
        });

        test('clears the marker when the PKGBUILD has pkgver()', async () => {
            const { baseDir, store, deps } = await setup(`${STATIC_PKGBUILD}pkgver() {\n  echo 1.0.0\n}\n`, 'b'.repeat(40));
            store.set('demo', { pkgver: '1.0.0', pkgrel: 1, version_marker: marker() });

            await runPackageVersionCheck(packages, store, { baseDir, deps });

            expect(store.get('demo')?.version_marker).toBeUndefined();
        });

        test('does not record a marker when sourcing reports pkgver()', async () => {
            const { baseDir, store, deps } = await setup(STATIC_PKGBUILD);
            store.set('demo', { pkgver: '1.0.0', pkgrel: 1 });
            deps.parsePkgBuild = async () => ({ epoch: 0, pkgver: '1.0.0', pkgrel: 1, pkgverFunction: true });

            const result = await runPackageVersionCheck(packages, store, { baseDir, deps });

            expect(result.skippedPackages.map(item => item.reason)).toEqual(['version unchanged (1.0.0-1)']);
            expect(store.get('demo')?.version_marker).toBeUndefined();
            expect('pkgverFunction' in store.get('demo')!).toBe(false);
        });

        test('ignores the marker for packages with a checker', async () => {
            const { baseDir, store, deps, calls } = await setup(STATIC_PKGBUILD);
            store.set('demo', { pkgver: '1.0.0', pkgrel: 1, version_marker: marker() });
            deps.fetchLatestVersion = async () => ({ version: '1.0.0' });

            await runPackageVersionCheck(
                [{ ...packages[0]!, checker: { type: 'github', repo: 'owner/demo' } }],
                store,
                { baseDir, deps }
            );

            expect(calls.parse).toBe(1);
            expect(store.get('demo')?.version_marker).toBeUndefined();
        });
    });
});
