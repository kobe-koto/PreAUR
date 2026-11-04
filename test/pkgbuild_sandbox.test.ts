import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildMetadataRootInitCommand,
    buildMetadataRootMaintenanceCommand,
    buildPkgbuildSandboxCommand,
    detectVcsSourcePackages,
    metadataRootPackages,
    parseSandboxVersionOutput,
    resolveMetadataRootLockFile,
    resolvePkgbuildSandboxOptions,
    type ResolvedPkgbuildSandboxOptions,
} from '../src/pkgbuild_sandbox.ts';
import type { PackageWorkDirs } from '../src/workdirs.ts';

const tmpDirs: string[] = [];

async function makeDir(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
}

function sandboxOptions(overrides: Partial<ResolvedPkgbuildSandboxOptions> = {}): ResolvedPkgbuildSandboxOptions {
    return {
        enabled: true,
        root: '/var/lib/preaur/metadata/extra-x86_64',
        command: 'systemd-nspawn',
        sudo: false,
        user: 'preaur',
        network: true,
        ephemeral: true,
        initRoot: true,
        packages: [],
        builder: 'extra-x86_64-build',
        ...overrides,
    };
}

afterEach(async () => {
    while (tmpDirs.length) {
        const dir = tmpDirs.pop()!;
        await fs.rm(dir, { recursive: true, force: true });
    }
});

describe('resolvePkgbuildSandboxOptions', () => {
    test('derives a dedicated metadata root from a build wrapper', () => {
        const options = resolvePkgbuildSandboxOptions({
            builder: 'extra-x86_64-build',
            workDirs: {} as PackageWorkDirs,
        });

        expect(options?.root).toBe('/var/lib/preaur/metadata/extra-x86_64');
        expect(options?.command).toBe('systemd-nspawn');
        expect(options?.user).toBe('preaur');
        expect(options?.ephemeral).toBe(true);
        expect(options?.initRoot).toBe(true);
        expect(options?.packages).toEqual([]);
        expect(options?.builder).toBe('extra-x86_64-build');
    });

    test('requires an explicit root for non-devtools builders', () => {
        expect(() => resolvePkgbuildSandboxOptions({
            builder: 'makepkg --syncdeps',
            workDirs: {} as PackageWorkDirs,
        })).toThrow(/pkgbuildSandbox.root/);
    });

    test('rejects devtools build chroots as the metadata root', () => {
        expect(() => resolvePkgbuildSandboxOptions({
            config: { root: '/var/lib/archbuild/extra-x86_64/root' } as any,
            builder: 'extra-x86_64-build',
            workDirs: {} as PackageWorkDirs,
        })).toThrow(/dedicated chroot/);
    });

    test('accepts an explicit dedicated root', () => {
        const options = resolvePkgbuildSandboxOptions({
            config: { root: '/srv/preaur-meta/' } as any,
            builder: 'makepkg --syncdeps',
            workDirs: {} as PackageWorkDirs,
        });

        expect(options?.root).toBe('/srv/preaur-meta');
    });
});

describe('buildPkgbuildSandboxCommand', () => {
    test('binds only the package directory and explicit makepkg work directories', async () => {
        const baseDir = await makeDir('preaur-sandbox-');
        const root = path.join(baseDir, 'chroot');
        const pkgDir = path.join(baseDir, 'pkg');
        const workRoot = path.join(baseDir, 'work');
        const srcdest = path.join(workRoot, 'srcdest');
        const pkgdest = path.join(workRoot, 'pkgdest');

        await fs.mkdir(root, { recursive: true });
        await fs.mkdir(pkgDir, { recursive: true });
        await fs.writeFile(path.join(pkgDir, 'PKGBUILD'), 'pkgname=demo\npkgver=1\npkgrel=1\n', 'utf8');

        const plan = await buildPkgbuildSandboxCommand({
            pkgbuildPath: path.join(pkgDir, 'PKGBUILD'),
            sandbox: {
                enabled: true,
                root,
                command: 'systemd-nspawn',
                sudo: false,
                user: 'preaur',
                network: false,
                ephemeral: true,
                initRoot: false,
                packages: ['git'],
                builder: 'extra-x86_64-build',
            },
            workDirs: {} as PackageWorkDirs,
            env: [
                ['SRCDEST', srcdest],
                ['PKGDEST', pkgdest],
            ],
            command: 'makepkg --printsrcinfo',
        });

        expect(plan.cmd).toBe('flock');
        expect(plan.args.slice(0, 3)).toEqual(['--shared', await resolveMetadataRootLockFile(root), 'systemd-nspawn']);
        expect(plan.args).toContain(`--directory=${root}`);
        expect(plan.args).toContain('--volatile=overlay');
        expect(plan.args).toContain('--register=no');
        const machineArgs = (args: string[]) => args.filter(arg => arg.startsWith('--machine='));
        expect(machineArgs(plan.args)).toHaveLength(1);
        expect(machineArgs(plan.args)[0]).toMatch(/^--machine=preaur-meta-\d+-\d+$/);
        expect(plan.args).not.toContain('--ephemeral');
        expect(plan.args).toContain(`--bind=${pkgDir}:/mnt/preaur-pkg`);
        expect(plan.args).toContain(`--bind=${srcdest}:/mnt/preaur-srcdest`);
        expect(plan.args).toContain(`--bind=${pkgdest}:/mnt/preaur-pkgdest`);
        expect(plan.args).toContain('--private-network');
        expect(plan.args).toContain('--setenv=SRCDEST=/mnt/preaur-srcdest');
        expect(plan.args).toContain('--setenv=PKGDEST=/mnt/preaur-pkgdest');
        expect(plan.args).not.toContain('--user=preaur');
        expect(plan.args.at(-1)).toContain('runuser -u');
        expect(plan.args.at(-1)).toContain("'SRCDEST=/mnt/preaur-srcdest'");
        expect(plan.args.at(-1)).not.toContain('pacman');
        expect(plan.env.some(([key]) => key === 'GITHUB_TOKEN')).toBe(false);
        expect(await fs.stat(srcdest).then(stat => stat.isDirectory())).toBe(true);
    });

    test('does not create or bind LOGDEST for metadata commands', async () => {
        const baseDir = await makeDir('preaur-sandbox-');
        const root = path.join(baseDir, 'chroot');
        const pkgDir = path.join(baseDir, 'pkg');
        const logdest = path.join(baseDir, 'logs', 'session', 'demo');
        const srcdest = path.join(baseDir, 'work', 'srcdest');

        await fs.mkdir(root, { recursive: true });
        await fs.mkdir(pkgDir, { recursive: true });
        await fs.writeFile(path.join(pkgDir, 'PKGBUILD'), 'pkgname=demo\npkgver=1\npkgrel=1\n', 'utf8');

        const plan = await buildPkgbuildSandboxCommand({
            pkgbuildPath: path.join(pkgDir, 'PKGBUILD'),
            sandbox: {
                enabled: true,
                root,
                command: 'systemd-nspawn',
                sudo: false,
                user: 'preaur',
                network: true,
                ephemeral: true,
                initRoot: false,
                packages: [],
                builder: 'extra-x86_64-build',
            },
            workDirs: {} as PackageWorkDirs,
            env: [
                ['SRCDEST', srcdest],
                ['LOGDEST', logdest],
            ],
            command: 'makepkg --printsrcinfo',
        });

        await expect(fs.stat(logdest)).rejects.toThrow();
        expect(plan.args.some(arg => arg.includes('LOGDEST') || arg.includes('preaur-logdest'))).toBe(false);
        expect(plan.args.at(-1)).not.toContain('LOGDEST');
        expect(plan.args).toContain('--setenv=SRCDEST=/mnt/preaur-srcdest');
    });
});

describe('metadata root management', () => {
    test('bakes PKGBUILD tooling and configured packages into the root', () => {
        expect(metadataRootPackages(sandboxOptions({ packages: ['git', 'nodejs'] }))).toEqual([
            'base-devel',
            'git',
            'pacman-contrib',
            'nodejs',
        ]);
    });

    test('creates the root with mkarchroot using the devtools configs', async () => {
        const devtoolsDir = await makeDir('preaur-devtools-');
        await fs.mkdir(path.join(devtoolsDir, 'pacman.conf.d'), { recursive: true });
        await fs.writeFile(path.join(devtoolsDir, 'pacman.conf.d', 'extra.conf'), '', 'utf8');

        expect(await buildMetadataRootInitCommand(sandboxOptions(), devtoolsDir, 'x86_64')).toEqual({
            cmd: 'mkarchroot',
            args: [
                '-C', path.join(devtoolsDir, 'pacman.conf.d', 'extra.conf'),
                '-M', path.join(devtoolsDir, 'makepkg.conf.d', 'x86_64.conf'),
                '/var/lib/preaur/metadata/extra-x86_64',
                'base-devel', 'git', 'pacman-contrib',
            ],
        });
    });

    test('uses setarch aliases and multilib base packages like archbuild', async () => {
        const devtoolsDir = await makeDir('preaur-devtools-');
        await fs.mkdir(path.join(devtoolsDir, 'pacman.conf.d'), { recursive: true });
        await fs.mkdir(path.join(devtoolsDir, 'setarch-aliases.d'), { recursive: true });
        await fs.writeFile(path.join(devtoolsDir, 'pacman.conf.d', 'multilib.conf'), '', 'utf8');
        await fs.writeFile(path.join(devtoolsDir, 'setarch-aliases.d', 'x86_64'), 'x86_64\n', 'utf8');

        const plan = await buildMetadataRootInitCommand(
            sandboxOptions({ builder: 'multilib-build', root: '/var/lib/preaur/metadata/multilib-x86_64' }),
            devtoolsDir,
            'aarch64',
        );

        expect(plan.cmd).toBe('setarch');
        expect(plan.args.slice(0, 2)).toEqual(['x86_64', 'mkarchroot']);
        expect(plan.args.slice(-4)).toEqual(['base-devel', 'multilib-devel', 'git', 'pacman-contrib']);
    });

    test('refuses to create a root for non-devtools builders', async () => {
        await expect(buildMetadataRootInitCommand(sandboxOptions({ builder: 'makepkg --syncdeps' })))
            .rejects.toThrow(/non-devtools builder/);
    });

    test('updates the persistent root with the host cache and mirrorlist', () => {
        const plan = buildMetadataRootMaintenanceCommand(sandboxOptions({ sudo: true }), ['base-devel', 'git'], {
            refresh: true,
            cacheDir: '/var/cache/pacman/pkg/',
            mirrorlist: '/etc/pacman.d/mirrorlist',
        });
        const script = plan.args.at(-1)!;

        expect(plan.args).toContain('--directory=/var/lib/preaur/metadata/extra-x86_64');
        expect(plan.args).not.toContain('--ephemeral');
        expect(plan.args).toContain('--bind=/var/cache/pacman/pkg/:/var/cache/pacman/pkg');
        expect(plan.args).toContain('--bind-ro=/etc/pacman.d/mirrorlist:/etc/pacman.d/mirrorlist');
        expect(script).toContain('pacman -Sy --needed --noconfirm archlinux-keyring');
        expect(script).toContain("pacman -Su --needed --noconfirm 'base-devel' 'git'");
        expect(script).toContain('useradd');
    });

    test('takes the root lock exclusively for maintenance', () => {
        const plan = buildMetadataRootMaintenanceCommand(sandboxOptions({ sudo: true }), ['git'], {
            refresh: false,
            lockFile: '/var/lib/preaur/metadata/extra-x86_64.lock',
        });

        expect(plan.cmd).toBe('flock');
        expect(plan.args.slice(0, 2)).toEqual(['--exclusive', '/var/lib/preaur/metadata/extra-x86_64.lock']);
        expect(plan.args.slice(2, 4)).toEqual(['sudo', 'systemd-nspawn']);
    });

    test('installs on-demand packages into the persistent root without a sync', () => {
        const plan = buildMetadataRootMaintenanceCommand(sandboxOptions(), ['subversion', 'subversion'], {
            refresh: false,
        });
        const script = plan.args.at(-1)!;

        expect(plan.cmd).toBe('systemd-nspawn');
        expect(script).toContain("pacman -S --needed --noconfirm 'subversion'");
        expect(script).not.toContain('-Sy');
        expect(script).not.toContain('useradd');
        expect(plan.args.some(arg => arg.startsWith('--bind'))).toBe(false);
    });
});

describe('volatile sandbox locking', () => {
    test('runs non-ephemeral commands directly on the root under an exclusive lock', async () => {
        const baseDir = await makeDir('preaur-sandbox-');
        const root = path.join(baseDir, 'chroot');
        const pkgDir = path.join(baseDir, 'pkg');
        await fs.mkdir(root, { recursive: true });
        await fs.mkdir(pkgDir, { recursive: true });

        const plan = await buildPkgbuildSandboxCommand({
            pkgbuildPath: path.join(pkgDir, 'PKGBUILD'),
            sandbox: sandboxOptions({ root, ephemeral: false }),
            workDirs: {} as PackageWorkDirs,
            command: 'makepkg --printsrcinfo',
        });

        expect(plan.args[0]).toBe('--exclusive');
        expect(plan.args).not.toContain('--volatile=overlay');
    });

    test('prefers the lock file mkarchroot leaves next to the root', async () => {
        const baseDir = await makeDir('preaur-sandbox-');
        const root = path.join(baseDir, 'extra-x86_64');
        const fallback = await resolveMetadataRootLockFile(root);
        expect(path.dirname(fallback)).toBe(os.tmpdir());
        expect(fallback).toBe(await resolveMetadataRootLockFile(root));

        await fs.writeFile(`${root}.lock`, '', 'utf8');
        expect(await resolveMetadataRootLockFile(root)).toBe(`${root}.lock`);
    });
});

describe('detectVcsSourcePackages', () => {
    test('detects git from a VCS source fragment', () => {
        const pkgbuild = [
            'pkgname=demo-git',
            'pkgver=r1',
            'pkgrel=1',
            "makedepends=('git')",
            "source=('demo::git+https://example.org/demo.git')",
            'pkgver() { :; }',
        ].join('\n');
        expect(detectVcsSourcePackages(pkgbuild)).toEqual(['git']);
    });

    test('maps each VCS prefix to its client package', () => {
        const pkgbuild = [
            "source=('a::svn+https://x/a' 'b::hg+https://x/b' 'c::bzr+lp:c' 'd::fossil+https://x/d')",
        ].join('\n');
        expect(detectVcsSourcePackages(pkgbuild).sort()).toEqual(
            ['bzr', 'fossil', 'mercurial', 'subversion'].sort()
        );
    });

    test('deduplicates repeated VCS prefixes and ignores non-VCS sources', () => {
        const pkgbuild = [
            "source=('one::git+https://x/one.git' 'two::git+https://x/two.git' 'https://x/tar.gz')",
        ].join('\n');
        expect(detectVcsSourcePackages(pkgbuild)).toEqual(['git']);
    });

    test('returns nothing for a plain tarball PKGBUILD', () => {
        expect(detectVcsSourcePackages("source=('https://example.org/demo-1.0.tar.gz')")).toEqual([]);
    });
});

describe('parseSandboxVersionOutput', () => {
    test('ignores session marker output before version markers', () => {
        expect(parseSandboxVersionOutput([
            'G10zMDA4O3N0YXJ0PXNlc3Npb24tbWFya2Vy',
            '__PREAUR_VERSION_BEGIN__',
            '',
            '1.2.3',
            '4',
            '__PREAUR_VERSION_END__',
            '',
        ].join('\n'))).toEqual({
            epoch: 0,
            pkgver: '1.2.3',
            pkgrel: 4,
        });
    });

    test('finds version markers even when noise shares the marker line', () => {
        expect(parseSandboxVersionOutput([
            'G10zMDA4O3N0YXJ0PXNlc3Npb24tbWFya2Vy__PREAUR_VERSION_BEGIN__',
            '',
            '1.2.3',
            '4',
            '__PREAUR_VERSION_END__',
            '',
        ].join('\n'))).toEqual({
            epoch: 0,
            pkgver: '1.2.3',
            pkgrel: 4,
        });
    });

    test('defaults missing epoch output to zero', () => {
        expect(parseSandboxVersionOutput('\n1.2.3\n4\n')).toEqual({
            epoch: 0,
            pkgver: '1.2.3',
            pkgrel: 4,
        });
    });

    test('defaults whitespace epoch output to zero', () => {
        expect(parseSandboxVersionOutput('   \n1.2.3\n4\n')).toEqual({
            epoch: 0,
            pkgver: '1.2.3',
            pkgrel: 4,
        });
    });

    test('reads pkgbase from the fourth output line', () => {
        expect(parseSandboxVersionOutput([
            '__PREAUR_VERSION_BEGIN__',
            '1',
            '1.2.3',
            '4',
            'foo-base',
            '__PREAUR_VERSION_END__',
        ].join('\n'))).toEqual({ epoch: 1, pkgver: '1.2.3', pkgrel: 4, pkgbase: 'foo-base' });
    });

    test('omits empty or invalid pkgbase output', () => {
        expect('pkgbase' in parseSandboxVersionOutput('\n1.2.3\n4\n\n')).toBe(false);
        expect('pkgbase' in parseSandboxVersionOutput('\n1.2.3\n4\nNot Valid\n')).toBe(false);
    });

    test('reads whether pkgver() is defined from the fifth output line', () => {
        const output = (flag: string) => ['__PREAUR_VERSION_BEGIN__', '', '1.2.3', '4', 'demo', flag, '__PREAUR_VERSION_END__'].join('\n');
        expect(parseSandboxVersionOutput(output('1'))).toEqual({ epoch: 0, pkgver: '1.2.3', pkgrel: 4, pkgbase: 'demo', pkgverFunction: true });
        expect(parseSandboxVersionOutput(output('0')).pkgverFunction).toBe(false);
        expect('pkgverFunction' in parseSandboxVersionOutput('\n1.2.3\n4\ndemo\n')).toBe(false);
    });

    test('rejects invalid non-empty epoch output', () => {
        expect(() => parseSandboxVersionOutput('abc\n1.2.3\n4\n')).toThrow(/Could not parse epoch/);
    });
});
