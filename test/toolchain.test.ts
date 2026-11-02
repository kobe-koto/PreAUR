import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    describeToolchain,
    isDefaultToolchain,
    renderToolchainDropIn,
    resolveToolchain,
    resolveValidToolchain,
    toolchainPackages,
    toolchainScripts,
    validateToolchain,
    writeToolchainDropIn,
    type ResolvedToolchain,
} from '../src/toolchain';

const tmpDirs: string[] = [];

async function makeDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preaur-toolchain-'));
    tmpDirs.push(dir);
    return dir;
}

afterEach(async () => {
    while (tmpDirs.length) {
        await fs.rm(tmpDirs.pop()!, { recursive: true, force: true });
    }
});

// Mirrors the relevant parts of devtools' makepkg.conf.d/x86_64.conf.
const BASE_MAKEPKG_CONF = `
CFLAGS="-O2 -pipe -fno-plt"
CXXFLAGS="$CFLAGS -Wp,-D_GLIBCXX_ASSERTIONS"
LDFLAGS="-Wl,-O1 -Wl,--as-needed"
LTOFLAGS="-flto=auto"
RUSTFLAGS="-C force-frame-pointers=yes"
OPTIONS=(strip docs !libtool !staticlibs emptydirs zipman purge debug lto)
`;

interface SourcedConfig {
    OPTIONS: string;
    CFLAGS: string;
    LDFLAGS: string;
    LTOFLAGS: string;
    RUSTFLAGS: string;
    CC: string;
    CXX: string;
    AR: string;
    NM: string;
    LD: string;
    strip: string;
    helper: string;
}

/** Source the base config plus the generated drop-in the way makepkg does. */
async function sourceDropIn(toolchain: ResolvedToolchain): Promise<SourcedConfig> {
    const dir = await makeDir();
    await fs.writeFile(path.join(dir, 'makepkg.conf'), BASE_MAKEPKG_CONF, 'utf8');
    const dropIn = await writeToolchainDropIn(toolchain, 'demo', dir);
    const script = [
        'set -e',
        `source ${JSON.stringify(path.join(dir, 'makepkg.conf'))}`,
        `source ${JSON.stringify(dropIn)}`,
        'printf "%s\\n" "${OPTIONS[*]}" "$CFLAGS" "$LDFLAGS" "$LTOFLAGS" "$RUSTFLAGS" "${CC-}" "${CXX-}" "${AR-}" "${NM-}" "${LD-}"',
        'type -t strip',
        'declare -F _preaur_set_option || echo unset',
    ].join('\n');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    expect(result.status).toBe(0);
    const [OPTIONS, CFLAGS, LDFLAGS, LTOFLAGS, RUSTFLAGS, CC, CXX, AR, NM, LD, strip, helper] = result.stdout.split('\n');
    return {
        OPTIONS: OPTIONS!, CFLAGS: CFLAGS!, LDFLAGS: LDFLAGS!, LTOFLAGS: LTOFLAGS!, RUSTFLAGS: RUSTFLAGS!,
        CC: CC!, CXX: CXX!, AR: AR!, NM: NM!, LD: LD!, strip: strip!, helper: helper!,
    };
}

describe('resolveToolchain', () => {
    test('defaults to the plain makepkg toolchain', () => {
        const toolchain = resolveToolchain(undefined, undefined);
        expect(toolchain).toEqual({ llvm: false, linker: undefined, lto: 'default', debug: undefined, stripOnLink: false });
        expect(isDefaultToolchain(toolchain)).toBe(true);
        expect(toolchainPackages(toolchain)).toEqual([]);
        expect(toolchainScripts(toolchain)).toEqual([]);
    });

    test('lets package fields override global fields one by one', () => {
        const toolchain = resolveToolchain(
            { llvm: true, mold: true, lto: 'thin', debug: false },
            { mold: false, lto: 'default' },
        );

        // mold: false falls back to llvm's implicit LLD.
        expect(toolchain).toEqual({
            llvm: true,
            linker: { name: 'lld', mode: 'driver' },
            lto: 'default',
            debug: false,
            stripOnLink: false,
        });
        expect(describeToolchain(toolchain)).toBe('llvm, lld, !debug');
    });

    test('maps true to driver mode and keeps replace mode', () => {
        expect(resolveToolchain({ mold: true }, undefined).linker).toEqual({ name: 'mold', mode: 'driver' });
        expect(resolveToolchain({ mold: 'replace' }, undefined).linker).toEqual({ name: 'mold', mode: 'replace' });
        expect(resolveToolchain({ lld: 'replace', llvm: true }, undefined).linker).toEqual({ name: 'lld', mode: 'replace' });
        expect(describeToolchain(resolveToolchain({ mold: 'replace' }, undefined))).toBe('mold=replace');
    });

    test('mold replaces the implicit LLD of llvm; lld: false disables it', () => {
        expect(resolveToolchain({ llvm: true, mold: 'driver' }, undefined).linker).toEqual({ name: 'mold', mode: 'driver' });
        expect(resolveToolchain({ llvm: true, lld: false }, undefined).linker).toBeUndefined();
    });

    test('rejects enabling mold and lld together', () => {
        expect(() => resolveValidToolchain({ lld: 'replace' }, { mold: 'driver' }, 'Package demo'))
            .toThrow(/Package demo: toolchain.mold and toolchain.lld cannot both be enabled/);
        expect(() => resolveValidToolchain({ lld: 'replace', llvm: true }, { mold: 'driver', lld: false }, 'Package demo'))
            .not.toThrow();
    });

    test('lists the chroot packages each option needs', () => {
        expect(toolchainPackages(resolveToolchain({ llvm: true }, undefined))).toEqual(['clang', 'llvm', 'lld']);
        expect(toolchainPackages(resolveToolchain({ llvm: true, mold: true }, undefined))).toEqual(['clang', 'llvm', 'mold']);
        expect(toolchainPackages(resolveToolchain({ llvm: true, lld: false }, undefined))).toEqual(['clang', 'llvm']);
    });

    test('replace mode points /usr/bin/ld at the selected linker', () => {
        expect(toolchainScripts(resolveToolchain({ mold: 'replace' }, undefined))).toEqual(['ln -sfn ld.mold /usr/bin/ld']);
        expect(toolchainScripts(resolveToolchain({ llvm: true, lld: 'replace' }, undefined))).toEqual(['ln -sfn ld.lld /usr/bin/ld']);
        expect(toolchainScripts(resolveToolchain({ mold: 'driver' }, undefined))).toEqual([]);
    });
});

describe('validateToolchain', () => {
    test('requires llvm for ThinLTO', () => {
        expect(() => validateToolchain(resolveToolchain({ lto: 'thin' }, undefined), 'Package demo'))
            .toThrow(/Package demo: .*requires toolchain.llvm/);
        expect(() => validateToolchain(resolveToolchain({ lto: 'thin' }, { llvm: true }), 'Package demo'))
            .not.toThrow();
    });

    test('requires lto: off when GCC links with LLD', () => {
        expect(() => validateToolchain(resolveToolchain({ lld: true }, undefined), 'Package demo'))
            .toThrow(/LLD cannot link GCC LTO objects/);
        expect(() => validateToolchain(resolveToolchain({ lld: 'replace', lto: 'off' }, undefined), 'Package demo'))
            .not.toThrow();
        expect(() => validateToolchain(resolveToolchain({ lld: 'replace', llvm: true }, undefined), 'Package demo'))
            .not.toThrow();
    });
});

describe('renderToolchainDropIn', () => {
    test('selects Clang/LLVM tools, llvm-strip, and lld', async () => {
        const conf = await sourceDropIn(resolveToolchain({ llvm: true }, undefined));

        expect(conf.CC).toBe('clang');
        expect(conf.CXX).toBe('clang++');
        expect(conf.AR).toBe('llvm-ar');
        expect(conf.NM).toBe('llvm-nm');
        expect(conf.LD).toBe('ld.lld');
        expect(conf.LDFLAGS).toEndWith(' -fuse-ld=lld');
        expect(conf.LTOFLAGS).toBe('-flto=full');
        expect(conf.strip).toBe('function');
        expect(conf.helper).toBe('unset');
        expect(conf.OPTIONS).toBe('strip docs !libtool !staticlibs emptydirs zipman purge debug lto');
    });

    test('uses mold instead of lld and links Rust with mold too', async () => {
        const conf = await sourceDropIn(resolveToolchain({ llvm: true, mold: true }, undefined));

        expect(conf.LD).toBe('ld.mold');
        expect(conf.LDFLAGS).toEndWith(' -fuse-ld=mold');
        expect(conf.LDFLAGS).not.toContain('lld');
        expect(conf.RUSTFLAGS).toBe('-C force-frame-pointers=yes -C link-arg=-fuse-ld=mold');
    });

    test('replace mode leaves compiler flags alone', async () => {
        const conf = await sourceDropIn(resolveToolchain({ llvm: true, mold: 'replace' }, undefined));

        expect(conf.LD).toBe('ld.mold');
        expect(conf.LDFLAGS).not.toContain('-fuse-ld');
        expect(conf.RUSTFLAGS).toBe('-C force-frame-pointers=yes');
        expect(conf.CC).toBe('clang');
    });

    test('links Clang with GNU ld when lld is disabled', async () => {
        const conf = await sourceDropIn(resolveToolchain({ llvm: true, lld: false }, undefined));

        expect(conf.LD).toBe('');
        expect(conf.LDFLAGS).not.toContain('-fuse-ld');
    });

    test('combines ThinLTO, no debug packages, and link-time stripping', async () => {
        const conf = await sourceDropIn(resolveToolchain(
            { llvm: true, lto: 'thin', debug: false, stripOnLink: true },
            undefined,
        ));

        expect(conf.OPTIONS).toBe('docs !libtool !staticlibs emptydirs zipman purge !debug !strip lto');
        expect(conf.LTOFLAGS).toBe('-flto=thin');
        expect(conf.LDFLAGS).toContain(' -s');
    });

    test('uses GCC LTO wrappers for full LTO without llvm', async () => {
        const conf = await sourceDropIn(resolveToolchain({ lto: 'full' }, undefined));

        expect(conf.CC).toBe('');
        expect(conf.AR).toBe('gcc-ar');
        expect(conf.NM).toBe('gcc-nm');
        expect(conf.LTOFLAGS).toBe('-flto=auto');
        expect(conf.strip).not.toBe('function');
    });

    test('disables LTO and drops inherited LTO flags', async () => {
        const conf = await sourceDropIn(resolveToolchain({ lto: 'off', debug: true }, undefined));

        expect(conf.OPTIONS).toEndWith('!lto');
        expect(conf.OPTIONS).toContain('debug');
        expect(conf.LTOFLAGS).toBe('-fno-lto');
        expect(conf.CFLAGS).toBe('-O2 -pipe -fno-plt -fno-lto');
        expect(conf.LDFLAGS).toEndWith(' -fno-lto');
    });

    test('records the package and selected options in the header', () => {
        const rendered = renderToolchainDropIn(resolveToolchain({ mold: true }, undefined), 'demo');
        expect(rendered.split('\n')[0]).toBe('# Generated by PreAUR for demo: mold');
    });
});
