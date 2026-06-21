import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildChrootInitCommand,
    buildPkgbuildSandboxCommand,
    renderChrootInitPkgbuild,
    resolvePkgbuildSandboxOptions,
} from '../src/pkgbuild_sandbox';
import type { PackageWorkDirs } from '../src/workdirs';

const tmpDirs: string[] = [];

async function makeDir(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
}

afterEach(async () => {
    while (tmpDirs.length) {
        const dir = tmpDirs.pop()!;
        await fs.rm(dir, { recursive: true, force: true });
    }
});

describe('resolvePkgbuildSandboxOptions', () => {
    test('derives the default devtools chroot root from a build wrapper', () => {
        const options = resolvePkgbuildSandboxOptions({
            builder: 'extra-x86_64-build',
            workDirs: {} as PackageWorkDirs,
        });

        expect(options?.root).toBe('/var/lib/archbuild/extra-x86_64/root');
        expect(options?.command).toBe('systemd-nspawn');
        expect(options?.user).toBe('preaur');
        expect(options?.ephemeral).toBe(true);
        expect(options?.initRoot).toBe(true);
        expect(options?.builder).toBe('extra-x86_64-build');
    });

    test('requires an explicit root for non-devtools builders', () => {
        expect(() => resolvePkgbuildSandboxOptions({
            builder: 'makepkg --syncdeps',
            workDirs: {} as PackageWorkDirs,
        })).toThrow(/pkgbuildSandbox.root/);
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
                builder: 'extra-x86_64-build',
            },
            workDirs: {} as PackageWorkDirs,
            env: [
                ['SRCDEST', srcdest],
                ['PKGDEST', pkgdest],
            ],
            command: 'makepkg --printsrcinfo',
        });

        expect(plan.cmd).toBe('systemd-nspawn');
        expect(plan.args).toContain(`--directory=${root}`);
        expect(plan.args).toContain('--ephemeral');
        expect(plan.args).toContain(`--bind=${pkgDir}:/mnt/preaur-pkg`);
        expect(plan.args).toContain(`--bind=${srcdest}:/mnt/preaur-srcdest`);
        expect(plan.args).toContain(`--bind=${pkgdest}:/mnt/preaur-pkgdest`);
        expect(plan.args).toContain('--private-network');
        expect(plan.args).toContain('--setenv=SRCDEST=/mnt/preaur-srcdest');
        expect(plan.args).toContain('--setenv=PKGDEST=/mnt/preaur-pkgdest');
        expect(plan.args).not.toContain('--user=preaur');
        expect(plan.args.at(-1)).toContain('runuser -u');
        expect(plan.args.at(-1)).toContain("'SRCDEST=/mnt/preaur-srcdest'");
        expect(plan.env.some(([key]) => key === 'GITHUB_TOKEN')).toBe(false);
        expect(await fs.stat(srcdest).then(stat => stat.isDirectory())).toBe(true);
    });
});

describe('chroot root initialization', () => {
    test('uses the package builder for generated safe package initialization', () => {
        expect(buildChrootInitCommand('extra-x86_64-build')).toEqual({
            cmd: 'extra-x86_64-build',
            args: [],
        });
        expect(buildChrootInitCommand('multilib-build -- --noconfirm')).toEqual({
            cmd: 'multilib-build',
            args: ['--', '--noconfirm'],
        });
        expect(() => buildChrootInitCommand('makepkg --syncdeps')).toThrow(/non-devtools builder/);

        const pkgbuild = renderChrootInitPkgbuild();
        expect(pkgbuild).toContain('pkgname=preaur-chroot-init');
        expect(pkgbuild).toContain('package() {');
        expect(pkgbuild).not.toContain('source=');
    });
});
