import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { PreaurToolchainConfig } from './config_schema';

/** Path inside the devtools chroot where the generated drop-in is mounted. */
export const TOOLCHAIN_DROPIN_CHROOT_PATH = '/etc/makepkg.conf.d/zz-preaur-toolchain.conf';

export type LtoMode = 'default' | 'off' | 'thin' | 'full';

/**
 * driver: select the linker through the compiler driver (-fuse-ld=...).
 * replace: point /usr/bin/ld at the linker inside the build chroot, so every
 * link uses it, including build systems that run `ld` directly.
 */
export type LinkerMode = 'driver' | 'replace';
export type LinkerName = 'lld' | 'mold';

export interface ResolvedLinker {
    name: LinkerName;
    mode: LinkerMode;
}

export interface ResolvedToolchain {
    llvm: boolean;
    /** undefined keeps the compiler's default linker (GNU ld). */
    linker?: ResolvedLinker;
    lto: LtoMode;
    /** undefined keeps the chroot makepkg.conf debug policy. */
    debug?: boolean;
    stripOnLink: boolean;
}

/**
 * Merge the global toolchain config with a package override. Package fields
 * win field by field; unset fields fall back to the global value, then to the
 * makepkg defaults.
 */
export function resolveToolchain(
    global: PreaurToolchainConfig | undefined,
    pkg: PreaurToolchainConfig | undefined,
): ResolvedToolchain {
    const pick = <K extends keyof PreaurToolchainConfig>(key: K): PreaurToolchainConfig[K] =>
        pkg?.[key] !== undefined ? pkg[key] : global?.[key];

    const llvm = pick('llvm') ?? false;
    const mold = linkerMode(pick('mold'));
    const lld = linkerMode(pick('lld'));
    if (mold && lld) {
        throw new ToolchainConflictError('toolchain.mold and toolchain.lld cannot both be enabled; set one of them to false.');
    }

    let linker: ResolvedLinker | undefined;
    if (mold) {
        linker = { name: 'mold', mode: mold };
    } else if (lld) {
        linker = { name: 'lld', mode: lld };
    } else if (llvm && pick('lld') !== false) {
        // Clang builds link with LLD unless lld is disabled or mold is chosen.
        linker = { name: 'lld', mode: 'driver' };
    }

    return {
        llvm,
        linker,
        lto: pick('lto') ?? 'default',
        debug: pick('debug'),
        stripOnLink: pick('stripOnLink') ?? false,
    };
}

class ToolchainConflictError extends Error {}

/** `true` is the driver mode; `false`/unset disables the linker. */
function linkerMode(value: boolean | LinkerMode | undefined): LinkerMode | undefined {
    if (value === true) return 'driver';
    if (value === false || value === undefined) return undefined;
    return value;
}

/** Resolve and validate the merged toolchain, prefixing errors with `context`. */
export function resolveValidToolchain(
    global: PreaurToolchainConfig | undefined,
    pkg: PreaurToolchainConfig | undefined,
    context: string,
): ResolvedToolchain {
    let toolchain: ResolvedToolchain;
    try {
        toolchain = resolveToolchain(global, pkg);
    } catch (e) {
        if (e instanceof ToolchainConflictError) throw new Error(`${context}: ${e.message}`);
        throw e;
    }
    validateToolchain(toolchain, context);
    return toolchain;
}

export function validateToolchain(toolchain: ResolvedToolchain, context: string): void {
    if (toolchain.lto === 'thin' && !toolchain.llvm) {
        throw new Error(`${context}: toolchain.lto "thin" requires toolchain.llvm: true (ThinLTO is LLVM-only).`);
    }
    if (toolchain.linker?.name === 'lld' && !toolchain.llvm && toolchain.lto !== 'off') {
        // LLD cannot read GCC's GIMPLE LTO objects, and makepkg enables LTO by default.
        throw new Error(`${context}: toolchain.lld with GCC requires toolchain.lto: "off" (LLD cannot link GCC LTO objects), or enable toolchain.llvm.`);
    }
}

/** True when the toolchain changes nothing compared with plain makepkg. */
export function isDefaultToolchain(toolchain: ResolvedToolchain): boolean {
    return !toolchain.llvm
        && !toolchain.linker
        && toolchain.lto === 'default'
        && toolchain.debug === undefined
        && !toolchain.stripOnLink;
}

/** Packages the chroot needs for the selected toolchain. */
export function toolchainPackages(toolchain: ResolvedToolchain): string[] {
    const packages: string[] = [];
    // llvm provides llvm-ar/ranlib/nm/strip; LLVMgold.so (LTO with mold or GNU ld) comes with llvm-libs.
    if (toolchain.llvm) packages.push('clang', 'llvm');
    if (toolchain.linker) packages.push(toolchain.linker.name);
    return packages;
}

/**
 * Root scripts run in the build chroot before the build (through the
 * pre-build helper package). The chroot copy is reset for every build, so
 * replacing /usr/bin/ld does not leak into other packages. ld.bfd stays
 * available as an explicit fallback (-fuse-ld=bfd).
 */
export function toolchainScripts(toolchain: ResolvedToolchain): string[] {
    if (toolchain.linker?.mode !== 'replace') return [];
    return [`ln -sfn ld.${toolchain.linker.name} /usr/bin/ld`];
}

export function describeToolchain(toolchain: ResolvedToolchain): string {
    const parts: string[] = [];
    if (toolchain.llvm) parts.push('llvm');
    if (toolchain.linker) {
        parts.push(toolchain.linker.mode === 'replace' ? `${toolchain.linker.name}=replace` : toolchain.linker.name);
    }
    if (toolchain.lto !== 'default') parts.push(`lto=${toolchain.lto}`);
    if (toolchain.debug !== undefined) parts.push(toolchain.debug ? 'debug' : '!debug');
    if (toolchain.stripOnLink) parts.push('strip-on-link');
    return parts.join(', ') || 'default';
}

/**
 * Render a makepkg.conf drop-in applying the toolchain. It is sourced after
 * /etc/makepkg.conf and the devtools drop-ins, so it only adjusts what the
 * chroot configuration already defines.
 */
export function renderToolchainDropIn(toolchain: ResolvedToolchain, pkgname: string): string {
    const lines: string[] = [
        `# Generated by PreAUR for ${pkgname}: ${describeToolchain(toolchain)}`,
        '# Do not edit; this file is regenerated for every build.',
        '',
        '_preaur_set_option() {',
        '    local opt kept=()',
        '    for opt in "${OPTIONS[@]}"; do',
        '        [[ $opt == "$1" || $opt == "!$1" ]] || kept+=("$opt")',
        '    done',
        '    OPTIONS=("${kept[@]}" "$2")',
        '}',
    ];

    if (toolchain.debug !== undefined) {
        lines.push('', toolchain.debug ? '_preaur_set_option debug debug' : "_preaur_set_option debug '!debug'");
    }

    if (toolchain.stripOnLink) {
        lines.push(
            '',
            '# Strip while linking instead of in makepkg\'s post-build step.',
            "_preaur_set_option strip '!strip'",
            'LDFLAGS+=" -s"',
        );
    }

    if (toolchain.llvm) {
        lines.push(
            '',
            'export CC=clang CXX=clang++',
            'export AR=llvm-ar RANLIB=llvm-ranlib NM=llvm-nm',
            '# makepkg strips through the `strip` command; use llvm-strip for LLVM objects.',
            'strip() { command llvm-strip "$@"; }',
            '# Clang does not support GCC\'s -flto=auto spelling.',
            'LTOFLAGS="${LTOFLAGS//-flto=auto/-flto=full}"',
        );
    }

    if (toolchain.linker) {
        const { name, mode } = toolchain.linker;
        if (mode === 'driver') {
            lines.push(
                '',
                `export LD=ld.${name}`,
                `LDFLAGS+=" -fuse-ld=${name}"`,
                `RUSTFLAGS+=" -C link-arg=-fuse-ld=${name}"`,
            );
        } else {
            lines.push(
                '',
                `# /usr/bin/ld points at ld.${name} in this chroot (linker mode "replace").`,
                `export LD=ld.${name}`,
            );
        }
    }

    if (toolchain.lto !== 'default') {
        lines.push(
            '',
            '# Replace inherited LTO flags so the selected mode is unambiguous.',
            'for _preaur_var in CFLAGS CXXFLAGS LDFLAGS; do',
            '    read -r -a _preaur_flags <<< "${!_preaur_var}"',
            '    _preaur_kept=()',
            '    for _preaur_flag in "${_preaur_flags[@]}"; do',
            '        case "$_preaur_flag" in',
            '            -flto|-flto=*|-fno-lto) ;;',
            '            *) _preaur_kept+=("$_preaur_flag") ;;',
            '        esac',
            '    done',
            '    printf -v "$_preaur_var" \'%s\' "${_preaur_kept[*]}"',
            'done',
            'unset _preaur_var _preaur_flags _preaur_kept _preaur_flag',
        );

        switch (toolchain.lto) {
            case 'off':
                lines.push(
                    "_preaur_set_option lto '!lto'",
                    'LTOFLAGS=-fno-lto',
                    'CFLAGS+=" -fno-lto"',
                    'CXXFLAGS+=" -fno-lto"',
                    'LDFLAGS+=" -fno-lto"',
                );
                break;
            case 'thin':
                lines.push('_preaur_set_option lto lto', 'LTOFLAGS=-flto=thin');
                break;
            case 'full':
                lines.push('_preaur_set_option lto lto');
                if (toolchain.llvm) {
                    lines.push('LTOFLAGS=-flto=full');
                } else {
                    lines.push('LTOFLAGS=-flto=auto', 'export AR=gcc-ar RANLIB=gcc-ranlib NM=gcc-nm');
                }
                break;
        }
    }

    lines.push('', 'unset -f _preaur_set_option', '');
    return lines.join('\n');
}

/** Write the drop-in for a package build and return its host path. */
export async function writeToolchainDropIn(
    toolchain: ResolvedToolchain,
    pkgname: string,
    dir: string,
): Promise<string> {
    const outputPath = path.resolve(dir, 'makepkg-toolchain.conf');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(outputPath, renderToolchainDropIn(toolchain, pkgname), { encoding: 'utf8', mode: 0o644 });
    return outputPath;
}
