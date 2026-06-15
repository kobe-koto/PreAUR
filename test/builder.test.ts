import { describe, expect, test } from 'bun:test';

import { buildCommandPlan, buildProcessEnvPairs } from '../src/builder';
import { envAssignments, envPairsToRecord } from '../src/env';

describe('buildCommandPlan', () => {
    test('passes devtools options to makechrootpkg without unsupported makepkg config flags', () => {
        const plan = buildCommandPlan('extra-x86_64-build', {
            chrootWorker: 'preaur-0',
            dummyPkgs: ['/tmp/demo-dep.pkg.tar.zst'],
            chrootPacmanConfig: '/tmp/preaur-pacman.conf',
        });

        expect(plan).toEqual({
            cmd: 'extra-x86_64-build',
            args: ['--', '-l', 'preaur-0', '-D', '/tmp/preaur-pacman.conf:/etc/pacman.conf', '-I', '/tmp/demo-dep.pkg.tar.zst'],
            isDevtoolsBuild: true,
        });
        expect(plan.args).not.toContain('-M');
    });

    test('passes dependency packages directly to non-devtools builders', () => {
        const plan = buildCommandPlan('makepkg --syncdeps', {
            dummyPkgs: ['/tmp/demo-dep.pkg.tar.zst'],
        });

        expect(plan).toEqual({
            cmd: 'makepkg',
            args: ['--syncdeps', '-I', '/tmp/demo-dep.pkg.tar.zst'],
            isDevtoolsBuild: false,
        });
    });

    test('ignores chroot pacman config for non-devtools builders', () => {
        const plan = buildCommandPlan('makepkg --syncdeps', {
            chrootPacmanConfig: '/tmp/preaur-pacman.conf',
        });

        expect(plan).toEqual({
            cmd: 'makepkg',
            args: ['--syncdeps'],
            isDevtoolsBuild: false,
        });
    });
});

describe('buildProcessEnvPairs', () => {
    test('keeps makepkg settings in env for non-devtools builders', () => {
        const pairs = buildProcessEnvPairs(
            [
                ['SRCDEST', '/work/demo/srcdest'],
                ['SRCPKGDEST', '/work/demo/srcpkgdest'],
                ['LOGDEST', '/work/demo/logdest'],
                ['BUILDDIR', '/work/demo/builddir'],
                ['PKGDEST', '/work/demo/pkgdest'],
            ],
            { nproc: 4, packager: 'PreAUR <preaur@example.test>', devtoolsBuild: false }
        );
        const env = envPairsToRecord(pairs);

        expect(env.SRCDEST).toBe('/work/demo/srcdest');
        expect(env.SRCPKGDEST).toBe('/work/demo/srcpkgdest');
        expect(env.MAKEFLAGS).toBe('-j4');
        expect(env.COMPRESSZST).toBe('zstd -c -T4 -');
        expect(env.PACKAGER).toBe('PreAUR <preaur@example.test>');
    });

    test('passes host-side package paths through devtools env', () => {
        const pairs = buildProcessEnvPairs(
            [
                ['SRCDEST', '/work/demo/srcdest'],
                ['SRCPKGDEST', '/work/demo/srcpkgdest'],
                ['LOGDEST', '/work/demo/logdest'],
                ['BUILDDIR', '/work/demo/builddir'],
                ['PKGDEST', '/work/demo/pkgdest'],
                ['CUSTOM_FLAG', 'kept'],
            ],
            { nproc: 4, packager: 'PreAUR <preaur@example.test>', devtoolsBuild: true }
        );
        const env = envPairsToRecord(pairs);

        expect(env.CUSTOM_FLAG).toBe('kept');
        expect(env.SRCDEST).toBe('/work/demo/srcdest');
        expect(env.SRCPKGDEST).toBe('/work/demo/srcpkgdest');
        expect(env.LOGDEST).toBe('/work/demo/logdest');
        expect(env.PKGDEST).toBe('/work/demo/pkgdest');
        expect(env.MAKEFLAGS).toBe('-j4');
        expect(env.NPROC).toBe('4');
        expect(env.PACKAGER).toBe('PreAUR <preaur@example.test>');
        expect(env.BUILDDIR).toBeUndefined();
        expect(env.COMPRESSZST).toBeUndefined();
    });

    test('renders explicit env assignments for spawn', () => {
        const pairs = buildProcessEnvPairs(
            [
                ['PKGDEST', '/work/demo/pkgdest'],
                ['PACKAGER', 'old value'],
            ],
            { nproc: 4, packager: 'PreAUR <preaur@example.test>', devtoolsBuild: false }
        );

        expect(envAssignments(pairs)).toContain('PKGDEST=/work/demo/pkgdest');
        expect(envAssignments(pairs)).toContain('PACKAGER=PreAUR <preaur@example.test>');
        expect(envAssignments(pairs)).not.toContain('PACKAGER=old value');
    });
});
