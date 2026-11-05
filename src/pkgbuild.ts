import * as fs from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import pc from 'picocolors';
import type { PacmanVersion } from './pacman_version.ts';
import { constructMessager } from './logger.ts';
import { shellEnvCommand, shellQuote, type EnvPairs } from './env.ts';

const execAsync = promisify(exec);

export type PkgBuildData = PacmanVersion & {
    /** makepkg pkgbase: pkgbase if set, otherwise the first pkgname. Absent when it cannot be determined. */
    pkgbase?: string;
    /** Whether sourcing the PKGBUILD defined pkgver(). Only set by parsers that source it; never stored. */
    pkgverFunction?: boolean;
};

// Same default makepkg applies: pkgbase=${pkgbase:-${pkgname[0]}}. ${pkgname[0]} works for a string and an array.
export const PKGBASE_SHELL_EXPR = '"${pkgbase:-${pkgname[0]}}"';

const PKGNAME_PATTERN = /^[a-z0-9@_+][a-z0-9@._+-]*$/;

/** Return a valid package name, or undefined for empty or invalid values. */
export function normalizePkgbase(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed && PKGNAME_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** pkgbase from makepkg --printsrcinfo output, which always opens with a pkgbase section. */
export function parseSrcInfoPkgbase(stdout: string): string | undefined {
    return normalizePkgbase(stdout.match(/^\s*pkgbase\s*=\s*(.+)$/m)?.[1]);
}

function firstShellWord(text: string): string | undefined {
    const trimmed = text.trimStart();
    const quote = trimmed[0];
    if (quote === '"' || quote === "'") {
        const end = trimmed.indexOf(quote, 1);
        return end === -1 ? undefined : trimmed.slice(1, end);
    }
    return trimmed.match(/^[^\s#;)]+/)?.[0];
}

/**
 * Read pkgbase from literal PKGBUILD assignments: pkgbase=, otherwise the first
 * entry of pkgname= (string or array). Returns 'dynamic' when the value uses
 * shell expansion and must be resolved by sourcing, undefined when absent.
 */
export function parseLiteralPkgbase(content: string): string | 'dynamic' | undefined {
    const assigned = content.match(/^pkgbase=(.*)$/m)?.[1];
    let word: string | undefined;
    if (assigned !== undefined) {
        word = firstShellWord(assigned);
    } else {
        const pkgname = content.match(/^pkgname=(.*)$/m)?.[1];
        if (pkgname === undefined) return undefined;
        if (pkgname.trimStart().startsWith('(')) {
            const array = content.match(/^pkgname=\(([^)]*)\)/m)?.[1];
            if (array === undefined) return 'dynamic';
            word = firstShellWord(array.replace(/#.*$/gm, ''));
        } else {
            word = firstShellWord(pkgname);
        }
    }

    if (word === undefined) return 'dynamic';
    if (/[$`\\]/.test(word)) return 'dynamic';
    return normalizePkgbase(word) ?? 'dynamic';
}

const FUNCTION_HEADER = /^\s*(?:function\s+[A-Za-z_][\w:.+-]*(?:\s*\(\s*\))?|[A-Za-z_][\w:.+-]*\s*\(\s*\))\s*(.*)$/;

/**
 * PKGBUILD lines outside function bodies. A multi-line body must end with `}`
 * at column 0; returns undefined when a body's end cannot be found.
 */
function topLevelLines(content: string): string[] | undefined {
    const lines: string[] = [];
    let inBody = false;
    for (const line of content.split(/\r?\n/)) {
        if (inBody) {
            if (/^\}\s*(?:#.*)?$/.test(line)) inBody = false;
            continue;
        }
        const header = line.match(FUNCTION_HEADER);
        if (header) {
            const rest = header[1]!.trim();
            // A one-line body such as `name() { ...; }` ends on the same line.
            if (!(rest.startsWith('{') && rest.endsWith('}'))) inBody = true;
            continue;
        }
        lines.push(line);
    }
    return inBody ? undefined : lines;
}

/**
 * True when the version comes only from the PKGBUILD text: no pkgver(), and no
 * top-level command substitution, eval, or sourced file. Errs towards false.
 */
export function isStaticVersionPkgbuild(content: string): boolean {
    if (/\bpkgver\s*\(\s*\)|\bfunction\s+pkgver\b/.test(content)) return false;
    const lines = topLevelLines(content);
    if (!lines) return false;
    return !lines.some(line => {
        const code = line.trim();
        if (code === '' || code.startsWith('#')) return false;
        return /\$\((?!\()|`/.test(code) || /(?:^|[;&|]\s*)(?:source|\.|eval)\s/.test(code);
    });
}

export type PkgBuildParser = 'native' | 'makepkg';

/**
 * Source the PKGBUILD in a subshell so that variable references and bash
 * parameter expansions (e.g. pkgver="${_update_pkgver//-/_}") are resolved to
 * their concrete values, which a plain regex cannot do.
 */
async function evalPkgBuildVars(pkgbuildPath: string): Promise<{ epoch?: string; pkgver?: string; pkgrel?: string; pkgbase?: string }> {
    // The path is passed as $0 so it never has to be embedded in the script body.
    const script = `export CARCH="$(uname -m)"; source "$0" >/dev/null 2>&1; printf '%s\\n%s\\n%s\\n%s\\n' "\${epoch-}" "\${pkgver-}" "\${pkgrel-}" ${PKGBASE_SHELL_EXPR}`;
    const { stdout } = await execAsync(`bash -c ${shellQuote(script)} ${shellQuote(pkgbuildPath)}`);
    const [epoch = '', pkgver = '', pkgrel = '', pkgbase = ''] = stdout.split('\n');
    return {
        epoch: epoch.trim() || undefined,
        pkgver: pkgver.trim() || undefined,
        pkgrel: pkgrel.trim() || undefined,
        pkgbase: pkgbase.trim() || undefined,
    };
}

async function parsePkgBuildNative(pkgbuildPath: string): Promise<PkgBuildData> {
    const content = await fs.readFile(pkgbuildPath, 'utf8');

    const stripQuotes = (s: string) => s.replace(/^['"]|['"]$/g, '').trim();

    // Loose capture (not \d+): pkgrel/epoch may be defined via bash variables,
    // which we resolve below — a strict numeric regex would throw prematurely.
    const pkgverMatch = content.match(/^pkgver=(.+)$/m);
    const pkgrelMatch = content.match(/^pkgrel=(.+)$/m);
    const epochMatch = content.match(/^epoch=(.+)$/m);

    if (!pkgverMatch || !pkgverMatch[1] || !pkgrelMatch || !pkgrelMatch[1]) {
        throw new Error('Could not parse pkgver or pkgrel from PKGBUILD');
    }

    let pkgver = stripQuotes(pkgverMatch[1]);
    let pkgrelRaw = stripQuotes(pkgrelMatch[1]);
    let epochRaw = epochMatch && epochMatch[1] ? stripQuotes(epochMatch[1]) : '0';

    const literalPkgbase = parseLiteralPkgbase(content);
    let pkgbase = literalPkgbase === 'dynamic' ? undefined : literalPkgbase;

    // The regex captures the raw assignment text. If any version field relies on
    // bash variables / parameter expansion (no pkgver() to let makepkg rewrite it),
    // the literal expression leaks through — resolve it by sourcing the PKGBUILD.
    const versionNeedsEval = pkgver.includes('$') || pkgrelRaw.includes('$') || epochRaw.includes('$');
    if (versionNeedsEval || literalPkgbase === 'dynamic') {
        try {
            const resolved = await evalPkgBuildVars(pkgbuildPath);
            if (versionNeedsEval) {
                if (resolved.pkgver) pkgver = resolved.pkgver;
                if (resolved.pkgrel) pkgrelRaw = resolved.pkgrel;
                epochRaw = resolved.epoch ?? '0';
            }
            if (literalPkgbase === 'dynamic') pkgbase = normalizePkgbase(resolved.pkgbase);
        } catch (e: any) {
            console.warn(pc.yellow(`Failed to resolve bash-expanded PKGBUILD fields via sourcing: ${e.message}`));
        }
    }

    const pkgrel = parseInt(pkgrelRaw, 10);
    if (isNaN(pkgrel)) {
        throw new Error(`Could not parse pkgrel from PKGBUILD (got "${pkgrelRaw}")`);
    }
    const epoch = parseInt(epochRaw || '0', 10);
    if (isNaN(epoch) || epoch < 0) {
        throw new Error(`Could not parse epoch from PKGBUILD (got "${epochRaw}")`);
    }

    return withPkgbase({ epoch, pkgver, pkgrel }, pkgbase);
}

/** Attach pkgbase only when known, so versions.json never stores an empty value. */
export function withPkgbase(version: PacmanVersion, pkgbase: string | undefined): PkgBuildData {
    return pkgbase ? { ...version, pkgbase } : version;
}

async function parsePkgBuildMakepkg(pkgbuildPath: string, env?: EnvPairs): Promise<PkgBuildData> {
    const pkgbuildDir = path.dirname(pkgbuildPath);
    const { stdout } = await execAsync(shellEnvCommand('makepkg --printsrcinfo', env), {
        cwd: pkgbuildDir,
    });

    const fields: Record<string, string> = {};
    for (const line of stdout.split('\n')) {
        const match = line.match(/^\s*(epoch|pkgver|pkgrel)\s*=\s*(.+)$/);
        if (match && match[1] && match[2] && fields[match[1]] === undefined) {
            fields[match[1]] = match[2].trim();
        }
    }

    if (!fields.pkgver || !fields.pkgrel) {
        throw new Error('Could not parse pkgver or pkgrel from makepkg --printsrcinfo');
    }

    const pkgrel = parseInt(fields.pkgrel, 10);
    if (isNaN(pkgrel)) {
        throw new Error(`Could not parse pkgrel from makepkg --printsrcinfo (got "${fields.pkgrel}")`);
    }

    const epoch = fields.epoch ? parseInt(fields.epoch, 10) : 0;
    if (isNaN(epoch) || epoch < 0) {
        throw new Error(`Could not parse epoch from makepkg --printsrcinfo (got "${fields.epoch}")`);
    }

    return withPkgbase({ epoch, pkgver: fields.pkgver, pkgrel }, parseSrcInfoPkgbase(stdout));
}

export async function parsePkgBuild(pkgbuildPath: string, parser: PkgBuildParser = 'native', env?: EnvPairs): Promise<PkgBuildData> {
    return parser === 'makepkg'
        ? parsePkgBuildMakepkg(pkgbuildPath, env)
        : parsePkgBuildNative(pkgbuildPath);
}

const TARGET_SUMS_BEGIN = '__PREAUR_TARGET_SUMS_BEGIN__';
const TARGET_SUMS_END = '__PREAUR_TARGET_SUMS_END__';
const TARGET_SUMS_UNSUPPORTED = '__PREAUR_TARGET_SUMS_UNSUPPORTED__';
const ARCH_NAME_PATTERN = /^[A-Za-z0-9_]+$/;

// makepkg's known_hash_algos; the patterns match the ones updpkgsums uses.
const SUMS_START = /^[ \t]*((?:ck|md5|sha1|sha224|sha256|sha384|sha512|b2)sums(?:_[^=+\s]+)?)\+?=/;
const SUMS_END = /\)[ \t]*(?:#.*)?$/;

/**
 * Bash script, run in the PKGBUILD directory, that generates checksums for the
 * generic sources and the sources of one architecture only. makepkg -g always
 * downloads every architecture's sources, so it runs on a temporary copy whose
 * arch=() is narrowed to the target. Prints TARGET_SUMS_UNSUPPORTED when the
 * PKGBUILD's arch=() does not list the target (including arch=('any')).
 */
export function targetArchChecksumScript(arch: string): string {
    if (!ARCH_NAME_PATTERN.test(arch)) {
        throw new Error(`Invalid target architecture for checksums: ${arch}`);
    }

    return [
        'set -euo pipefail',
        `target=${shellQuote(arch)}`,
        `archs=$(set +eu; export CARCH="$target"; source ./PKGBUILD >/dev/null 2>&1; printf '%s\\n' "\${arch[@]}")`,
        `if ! grep -qxF -- "$target" <<<"$archs"; then printf '%s\\n' ${shellQuote(TARGET_SUMS_UNSUPPORTED)}; exit 0; fi`,
        // makepkg -p only accepts a build file in the current directory.
        'tmpfile=$(mktemp .preaur-updpkgsums.XXXXXX)',
        'builddir=$(mktemp -d "${TMPDIR:-/tmp}/preaur-updpkgsums.XXXXXX")',
        `trap 'rm -rf -- "$tmpfile" "$builddir"' EXIT`,
        `{ cat ./PKGBUILD; printf '\\narch=(%q)\\n' "$target"; } > "$tmpfile"`,
        'sums=$(BUILDDIR="$builddir" makepkg -g -p "$tmpfile")',
        `printf '%s\\n%s\\n%s\\n' ${shellQuote(TARGET_SUMS_BEGIN)} "$sums" ${shellQuote(TARGET_SUMS_END)}`,
    ].join('\n');
}

/** Checksum arrays from targetArchChecksumScript output, or undefined when the target is not in arch=(). */
export function parseTargetArchChecksumOutput(stdout: string): string | undefined {
    if (stdout.includes(TARGET_SUMS_UNSUPPORTED)) return undefined;

    const begin = stdout.lastIndexOf(TARGET_SUMS_BEGIN);
    const end = begin === -1 ? -1 : stdout.indexOf(TARGET_SUMS_END, begin);
    if (begin === -1 || end === -1) {
        throw new Error('Could not parse target architecture checksum output: missing markers');
    }

    const sums = stdout.slice(begin + TARGET_SUMS_BEGIN.length, end).trim();
    if (!sums) {
        throw new Error('PKGBUILD does not contain sources to update');
    }
    return sums;
}

interface SumsBlock {
    name: string;
    start: number;
    /** Index of the last line of the block. */
    end: number;
}

function findSumsBlocks(lines: string[]): SumsBlock[] {
    const blocks: SumsBlock[] = [];
    for (let i = 0; i < lines.length; i += 1) {
        const name = lines[i]!.match(SUMS_START)?.[1];
        if (!name) continue;

        let end = i;
        while (end < lines.length && !SUMS_END.test(lines[end]!)) end += 1;
        if (end === lines.length) {
            throw new Error(`Unterminated checksum array ${name} in PKGBUILD`);
        }
        blocks.push({ name, start: i, end });
        i = end;
    }
    return blocks;
}

/**
 * Replace only the checksum arrays present in newSums (all their assignments,
 * including +=), keeping arrays of other architectures as they are. Arrays new
 * to the PKGBUILD go after the last replaced array, or at the end of the file.
 */
export function mergeChecksumArrays(content: string, newSums: string): string {
    const newLines = newSums.split(/\r?\n/);
    const replacements = new Map<string, string[]>();
    for (const block of findSumsBlocks(newLines)) {
        replacements.set(block.name, newLines.slice(block.start, block.end + 1));
    }
    if (replacements.size === 0) {
        throw new Error('No checksum arrays found in generated checksums');
    }

    const lines = content.split('\n');
    const output: string[] = [];
    const written = new Set<string>();
    let insertAt: number | undefined;
    let cursor = 0;

    for (const block of findSumsBlocks(lines)) {
        output.push(...lines.slice(cursor, block.start));
        cursor = block.end + 1;

        const replacement = replacements.get(block.name);
        if (!replacement) {
            output.push(...lines.slice(block.start, cursor));
            continue;
        }
        if (!written.has(block.name)) {
            output.push(...replacement);
            written.add(block.name);
            insertAt = output.length;
        }
    }
    output.push(...lines.slice(cursor));

    const missing = [...replacements].filter(([name]) => !written.has(name)).flatMap(([, block]) => block);
    if (missing.length > 0) {
        if (insertAt !== undefined) {
            output.splice(insertAt, 0, ...missing);
        } else {
            if (output.length > 0 && output[output.length - 1] === '') output.pop();
            output.push(...missing, '');
        }
    }

    return output.join('\n');
}

/**
 * Update the checksums of the generic and one architecture's sources, falling
 * back to updating all checksums when the PKGBUILD does not list that
 * architecture. runCapture runs a shell command in the PKGBUILD directory.
 */
export async function updateTargetArchChecksums(
    pkgbuildPath: string,
    arch: string,
    ops: {
        runCapture: (command: string) => Promise<string>;
        updateAll: () => Promise<void>;
    }
): Promise<void> {
    const pkgMessager = constructMessager('PKGBUILD Updater', path.basename(path.dirname(pkgbuildPath)));
    const stdout = await ops.runCapture(`bash -c ${shellQuote(targetArchChecksumScript(arch))}`);
    const newSums = parseTargetArchChecksumOutput(stdout);
    if (newSums === undefined) {
        console.log(pkgMessager(`arch=() does not list ${arch}; updating checksums for all architectures.`));
        await ops.updateAll();
        return;
    }

    console.log(pkgMessager(`Updated checksums for generic and ${arch} sources only; other architectures' checksums were left unchanged.`));
    const content = await fs.readFile(pkgbuildPath, 'utf8');
    const merged = mergeChecksumArrays(content, newSums);
    if (merged !== content) {
        await fs.writeFile(pkgbuildPath, merged, 'utf8');
    }
}

async function updateTargetArchChecksumsOnHost(pkgbuildPath: string, env: EnvPairs | undefined, arch: string): Promise<void> {
    const pkgbuildDir = path.dirname(pkgbuildPath);
    await updateTargetArchChecksums(pkgbuildPath, arch, {
        runCapture: async command => (await execAsync(shellEnvCommand(command, env), { cwd: pkgbuildDir })).stdout,
        updateAll: () => updateChecksums(pkgbuildPath, env),
    });
}

async function updateChecksums(pkgbuildPath: string, env?: EnvPairs): Promise<void> {
    const pkgMessager = constructMessager('PKGBUILD Updater', path.basename(path.dirname(pkgbuildPath)));
    try {
        const pkgbuildDir = path.dirname(pkgbuildPath);
        await execAsync(shellEnvCommand('updpkgsums', env), {
            cwd: pkgbuildDir,
        });
    } catch (e: any) {
        console.error(pkgMessager(pc.red(`Failed to run updpkgsums: ${e.message}`)));
        throw e;
    }
}

export async function updateDynamicPkgver(pkgbuildPath: string, env?: EnvPairs): Promise<boolean> {
    const pkgMessager = constructMessager('PKGBUILD Updater', path.basename(path.dirname(pkgbuildPath)));
    const content = await fs.readFile(pkgbuildPath, 'utf8');
    if (!content.match(/^pkgver\(\)\s*\{/m)) {
        return false; // No pkgver() function
    }

    const pkgbuildDir = path.dirname(pkgbuildPath);
    console.log(pkgMessager(`Found dynamic pkgver() in ${path.basename(pkgbuildDir)}, running makepkg -odc to update version...`));

    try {
        // -o: extract and download sources
        // -d: skip dependency checks
        // -c: clean up working directory after
        await execAsync(shellEnvCommand('makepkg -odc --noconfirm --skipinteg', env), {
            cwd: pkgbuildDir,
        });
        return true;
    } catch (e: any) {
        console.error(pkgMessager(pc.red(`Failed to run makepkg for dynamic pkgver: ${e.message}`)));
        return false;
    }
}

export async function updatePkgBuild(
    pkgname: string,
    pkgbuildPath: string,
    updates: Record<string, string>,
    forceBumpRel: boolean = false,
    parser: PkgBuildParser = 'native',
    env?: EnvPairs,
    checksumArch?: string
): Promise<boolean> {
    return updatePkgBuildWithOps(
        pkgname,
        pkgbuildPath,
        updates,
        forceBumpRel,
        parser,
        env,
        {
            parse: parsePkgBuild,
            updateChecksums: checksumArch
                ? (pathToUpdate, envToUse) => updateTargetArchChecksumsOnHost(pathToUpdate, envToUse, checksumArch)
                : updateChecksums,
        }
    );
}

export async function updatePkgBuildWithOps(
    pkgname: string,
    pkgbuildPath: string,
    updates: Record<string, string>,
    forceBumpRel: boolean = false,
    parser: PkgBuildParser = 'native',
    env: EnvPairs | undefined,
    ops: {
        parse: typeof parsePkgBuild;
        updateChecksums: (pkgbuildPath: string, env?: EnvPairs) => Promise<void>;
    }
): Promise<boolean> {
    const pkgMessager = constructMessager('PKGBUILD Updater', pkgname);
    let content = await fs.readFile(pkgbuildPath, 'utf8');
    const originalContent = content;

    const currentData = await ops.parse(pkgbuildPath, parser, env);

    if (updates.pkgver && currentData.pkgver !== updates.pkgver) {
        console.log(pkgMessager(`Updating pkgver from ${currentData.pkgver} to ${updates.pkgver} (pkgrel=1)`));
        content = content.replace(/^pkgver=.+$/m, `pkgver=${updates.pkgver}`);
        content = content.replace(/^pkgrel=\d+$/m, `pkgrel=1`);
    } else if (forceBumpRel) {
        console.log(pkgMessager(`Bumping pkgrel from ${currentData.pkgrel} to ${currentData.pkgrel + 1}`));
        content = content.replace(/^pkgrel=\d+$/m, `pkgrel=${currentData.pkgrel + 1}`);
    }

    for (const [key, value] of Object.entries(updates)) {
        if (key === 'pkgver' || key === 'pkgrel') continue;
        if (key === 'epoch') {
            if (!value || value === "0") continue;
            if (content.match(/^epoch=.+$/m)) {
                console.log(pkgMessager(`Updating epoch to ${value}`));
                content = content.replace(/^epoch=.+$/m, `epoch=${value}`);
            } else {
                console.log(pkgMessager(`Injecting new epoch ${value}`));
                content = content.replace(/^pkgver=/m, `epoch=${value}\npkgver=`);
            }
            continue;
        }

        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (content.match(regex)) {
            console.log(pkgMessager(`Updating custom variable ${key}=${value}`));
            content = content.replace(regex, `${key}=${value}`);
        } else {
            console.log(pkgMessager(`Injecting custom variable ${key}=${value}`));
            content = content.replace(/^pkgver=/m, `${key}=${value}\npkgver=`);
        }
    }

    const changed = content !== originalContent;

    if (changed) {
        await fs.writeFile(pkgbuildPath, content, 'utf8');
    }

    await ops.updateChecksums(pkgbuildPath, env);

    return changed;
}
