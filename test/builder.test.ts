import { describe, expect, test } from 'bun:test';

import { buildCommandPlan, buildProcessEnv } from '../src/builder';

describe('buildCommandPlan', () => {
    test('passes devtools options to makechrootpkg without unsupported makepkg config flags', () => {
        const plan = buildCommandPlan('extra-x86_64-build', {
            chrootWorker: 'preaur-0',
            dummyPkgs: ['/tmp/demo-dep.pkg.tar.zst'],
        });

        expect(plan).toEqual({
            cmd: 'extra-x86_64-build',
            args: ['--', '-l', 'preaur-0', '-I', '/tmp/demo-dep.pkg.tar.zst'],
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
});

describe('buildProcessEnv', () => {
    test('keeps makepkg settings in env for non-devtools builders', () => {
        const env = buildProcessEnv(
            { PATH: '/usr/bin' },
            {
                SRCDEST: '/work/demo/srcdest',
                LOGDEST: '/work/demo/logdest',
                BUILDDIR: '/work/demo/builddir',
                PKGDEST: '/work/demo/pkgdest',
                MAKEPKG_CONF: '/work/demo/makepkg.conf',
            },
            { nproc: 4, packager: 'PreAUR <preaur@example.test>', devtoolsBuild: false }
        );

        expect(env.SRCDEST).toBe('/work/demo/srcdest');
        expect(env.MAKEPKG_CONF).toBe('/work/demo/makepkg.conf');
        expect(env.MAKEFLAGS).toBe('-j4');
        expect(env.COMPRESSZST).toBe('zstd -c -T4 -');
        expect(env.PACKAGER).toBe('PreAUR <preaur@example.test>');
    });

    test('passes host-side package paths through devtools env', () => {
        const env = buildProcessEnv(
            { PATH: '/usr/bin' },
            {
                SRCDEST: '/work/demo/srcdest',
                LOGDEST: '/work/demo/logdest',
                BUILDDIR: '/work/demo/builddir',
                PKGDEST: '/work/demo/pkgdest',
                MAKEPKG_CONF: '/work/demo/makepkg.conf',
                CUSTOM_FLAG: 'kept',
            },
            { nproc: 4, packager: 'PreAUR <preaur@example.test>', devtoolsBuild: true }
        );

        expect(env.PATH).toBe('/usr/bin');
        expect(env.CUSTOM_FLAG).toBe('kept');
        expect(env.SRCDEST).toBe('/work/demo/srcdest');
        expect(env.LOGDEST).toBe('/work/demo/logdest');
        expect(env.PKGDEST).toBe('/work/demo/pkgdest');
        expect(env.MAKEPKG_CONF).toBe('/work/demo/makepkg.conf');
        expect(env.MAKEFLAGS).toBe('-j4');
        expect(env.NPROC).toBe('4');
        expect(env.PACKAGER).toBe('PreAUR <preaur@example.test>');
        expect(env.BUILDDIR).toBeUndefined();
        expect(env.COMPRESSZST).toBeUndefined();
    });
});
