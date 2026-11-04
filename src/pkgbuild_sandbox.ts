import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PreaurPkgbuildSandboxConfig } from './config.ts';
import { envAssignments, shellQuote, type EnvPair, type EnvPairs } from './env.ts';
import { PKGBASE_SHELL_EXPR, normalizePkgbase, parseSrcInfoPkgbase, updatePkgBuildWithOps, withPkgbase, type PkgBuildData, type PkgBuildParser } from './pkgbuild.ts';
import { DEVTOOLS_DIR, resolveBasePacmanConfig, resolveDevtoolsBuildTarget } from './chroot_pacman.ts';
import type { PackageWorkDirs } from './workdirs.ts';
import { constructMessager } from './logger.ts';

const SANDBOX_PKG_DIR = '/mnt/preaur-pkg';
const DEFAULT_SANDBOX_COMMAND = 'systemd-nspawn';
const DEFAULT_SANDBOX_USER = 'preaur';
const DEFAULT_METADATA_ROOT_DIR = '/var/lib/preaur/metadata';
const DEVTOOLS_CHROOTS_DIR = '/var/lib/archbuild';
const HOST_MIRRORLIST = '/etc/pacman.d/mirrorlist';
const CHROOT_PACMAN_CACHE = '/var/cache/pacman/pkg';
const SANDBOX_HOME = '/tmp/preaur-home';
const SANDBOX_GNUPG_HOME = '/tmp/preaur-gnupg';
const VERSION_OUTPUT_BEGIN = '__PREAUR_VERSION_BEGIN__';
const VERSION_OUTPUT_END = '__PREAUR_VERSION_END__';
// Tools baked into the dedicated metadata root so individual metadata commands
// never have to install anything.
const METADATA_ROOT_BASE_PACKAGES = ['base-devel', 'git', 'pacman-contrib'];

// makepkg maps VCS source prefixes (e.g. git+https://) to these tools. Because
// `makepkg -odc` skips dependency checks, the PKGBUILD's makedepends do not get
// installed, so dynamic pkgver() needs the matching VCS client installed here.
const VCS_SOURCE_PACKAGES: Record<string, string> = {
    git: 'git',
    svn: 'subversion',
    hg: 'mercurial',
    bzr: 'bzr',
    fossil: 'fossil',
};

const PkgbuildSandboxMessager = constructMessager('PKGBUILD Sandbox');

interface MetadataRootState {
    prepared: boolean;
    installed: Set<string>;
    chain: Promise<void>;
}

const metadataRootStates = new Map<string, MetadataRootState>();

export interface PkgbuildSandboxOptions {
    config?: PreaurPkgbuildSandboxConfig;
    builder: string;
    workDirs: PackageWorkDirs;
}

export interface ResolvedPkgbuildSandboxOptions {
    enabled: boolean;
    root: string;
    command: string;
    sudo: boolean;
    user: string;
    network: boolean;
    ephemeral: boolean;
    initRoot: boolean;
    packages: string[];
    builder: string;
}

export interface PkgbuildSandboxCommandPlan {
    cmd: string;
    args: string[];
    env: EnvPair[];
}

interface SandboxRunOptions {
    pkgbuildPath: string;
    env?: EnvPairs;
    sandbox: ResolvedPkgbuildSandboxOptions;
    workDirs: PackageWorkDirs;
    command: string;
    captureStdout?: boolean;
    packages?: string[];
}

export function resolvePkgbuildSandboxOptions(options: PkgbuildSandboxOptions): ResolvedPkgbuildSandboxOptions | undefined {
    const enabled = options.config?.enabled ?? true;
    if (!enabled) return undefined;

    const configuredRoot = options.config?.root ?? deriveMetadataRoot(options.builder);
    if (!configuredRoot) {
        throw new Error(`PKGBUILD sandbox root could not be derived from builder "${options.builder}". Set config.pkgbuildSandbox.root or disable config.pkgbuildSandbox.enabled.`);
    }

    const root = path.resolve(configuredRoot);
    if (isInsideDir(root, DEVTOOLS_CHROOTS_DIR)) {
        throw new Error(`PKGBUILD sandbox root ${root} is inside ${DEVTOOLS_CHROOTS_DIR}. PreAUR installs metadata tools into the sandbox root, so it must be a dedicated chroot and not a devtools build chroot. Remove config.pkgbuildSandbox.root to use the default ${DEFAULT_METADATA_ROOT_DIR}/<repo>-<arch>.`);
    }

    return {
        enabled,
        root,
        command: options.config?.command ?? DEFAULT_SANDBOX_COMMAND,
        sudo: options.config?.sudo ?? true,
        user: options.config?.user ?? DEFAULT_SANDBOX_USER,
        network: options.config?.network ?? true,
        ephemeral: options.config?.ephemeral ?? true,
        initRoot: options.config?.initRoot ?? true,
        packages: options.config?.packages ?? [],
        builder: options.builder,
    };
}

function deriveMetadataRoot(builder: string): string | undefined {
    const target = resolveBuilderTarget(builder);
    if (!target) return undefined;

    return path.resolve(DEFAULT_METADATA_ROOT_DIR, `${target.repo}-${target.arch}`);
}

function resolveBuilderTarget(builder: string): { repo: string; arch: string } | undefined {
    const [builderCmd] = builder.split(' ');
    if (!builderCmd) return undefined;

    return resolveDevtoolsBuildTarget(builderCmd);
}

function isInsideDir(target: string, dir: string): boolean {
    const relative = path.relative(dir, target);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export async function parsePkgBuildInSandbox(
    pkgbuildPath: string,
    parser: PkgBuildParser = 'native',
    env: EnvPairs | undefined,
    sandbox: ResolvedPkgbuildSandboxOptions,
    workDirs: PackageWorkDirs
): Promise<PkgBuildData> {
    if (parser === 'makepkg') {
        const stdout = await runSandboxCommand({
            pkgbuildPath,
            env,
            sandbox,
            workDirs,
            command: 'makepkg --printsrcinfo',
            captureStdout: true,
        });

        return parseSrcInfoVersion(stdout);
    }

    // The fifth line reports whether sourcing defined pkgver(), for the version marker.
    const script = `export CARCH="$(uname -m)"; source ./PKGBUILD >/dev/null 2>&1; if declare -F pkgver >/dev/null; then _preaur_pkgver_fn=1; else _preaur_pkgver_fn=0; fi; printf '%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n' ${shellQuote(VERSION_OUTPUT_BEGIN)} "\${epoch-}" "\${pkgver-}" "\${pkgrel-}" ${PKGBASE_SHELL_EXPR} "$_preaur_pkgver_fn" ${shellQuote(VERSION_OUTPUT_END)}`;
    const stdout = await runSandboxCommand({
        pkgbuildPath,
        env,
        sandbox,
        workDirs,
        command: `bash -lc ${shellQuote(script)}`,
        captureStdout: true,
    });
    return parseSandboxVersionOutput(stdout);
}

export async function updateDynamicPkgverInSandbox(
    pkgbuildPath: string,
    env: EnvPairs | undefined,
    sandbox: ResolvedPkgbuildSandboxOptions,
    workDirs: PackageWorkDirs
): Promise<boolean> {
    const content = await fs.readFile(pkgbuildPath, 'utf8');
    if (!content.match(/^pkgver\(\)\s*\{/m)) {
        return false;
    }

    console.log(PkgbuildSandboxMessager(`Running dynamic pkgver() in chroot for ${path.basename(path.dirname(pkgbuildPath))}...`));
    await runSandboxCommand({
        pkgbuildPath,
        env,
        sandbox,
        workDirs,
        command: 'makepkg -odc --noconfirm --skipinteg',
        packages: detectVcsSourcePackages(content),
    });

    return true;
}

export function detectVcsSourcePackages(pkgbuildContent: string): string[] {
    const packages = new Set<string>();

    // Match VCS fragments such as git+https://, svn+ssh://, hg+https://.
    for (const match of pkgbuildContent.matchAll(/\b(git|svn|hg|bzr|fossil)\+/g)) {
        const pkg = VCS_SOURCE_PACKAGES[match[1]!];
        if (pkg) packages.add(pkg);
    }

    return [...packages];
}

export async function updatePkgBuildInSandbox(
    pkgname: string,
    pkgbuildPath: string,
    updates: Record<string, string>,
    forceBumpRel: boolean,
    parser: PkgBuildParser,
    env: EnvPairs | undefined,
    sandbox: ResolvedPkgbuildSandboxOptions,
    workDirs: PackageWorkDirs
): Promise<boolean> {
    return updatePkgBuildWithOps(
        pkgname,
        pkgbuildPath,
        updates,
        forceBumpRel,
        parser,
        env,
        {
            parse: (pathToParse, parserToUse, envToUse) => parsePkgBuildInSandbox(pathToParse, parserToUse, envToUse, sandbox, workDirs),
            updateChecksums: (pathToUpdate, envToUse) => runSandboxCommand({
                pkgbuildPath: pathToUpdate,
                env: envToUse,
                sandbox,
                workDirs,
                command: 'updpkgsums',
            }).then(() => undefined),
        }
    );
}

function parseSrcInfoVersion(stdout: string): PkgBuildData {
    const fields: Record<string, string> = {};
    for (const line of stdout.split('\n')) {
        const match = line.match(/^\s*(epoch|pkgver|pkgrel)\s*=\s*(.+)$/);
        if (match && match[1] && match[2] && fields[match[1]] === undefined) {
            fields[match[1]] = match[2].trim();
        }
    }

    if (!fields.pkgver || !fields.pkgrel) {
        throw new Error('Could not parse pkgver or pkgrel from sandbox makepkg --printsrcinfo');
    }

    const pkgrel = parseRequiredNonNegativeInt(fields.pkgrel, 'pkgrel', 'sandbox makepkg --printsrcinfo');
    const epoch = parseOptionalNonNegativeInt(fields.epoch, 'epoch', 'sandbox makepkg --printsrcinfo');

    return withPkgbase({ epoch, pkgver: fields.pkgver, pkgrel }, parseSrcInfoPkgbase(stdout));
}

export function parseSandboxVersionOutput(stdout: string): PkgBuildData {
    const lines = extractVersionOutputLines(stdout);
    const [epoch = '', pkgver = '', pkgrel = '', pkgbase = '', pkgverFunction = ''] = lines;
    const parsedPkgrel = parseRequiredNonNegativeInt(pkgrel, 'pkgrel', 'sandbox PKGBUILD evaluation');
    const parsedEpoch = parseOptionalNonNegativeInt(epoch, 'epoch', 'sandbox PKGBUILD evaluation');

    if (!pkgver.trim()) {
        throw new Error('Could not parse pkgver from sandbox PKGBUILD evaluation');
    }

    const data = withPkgbase({ epoch: parsedEpoch, pkgver: pkgver.trim(), pkgrel: parsedPkgrel }, normalizePkgbase(pkgbase));
    const fn = pkgverFunction.trim();
    // Older output has no fifth line; leave the field unset so nothing is inferred.
    return fn === '1' || fn === '0' ? { ...data, pkgverFunction: fn === '1' } : data;
}

function extractVersionOutputLines(stdout: string): string[] {
    const beginIndex = stdout.lastIndexOf(VERSION_OUTPUT_BEGIN);
    if (beginIndex === -1) return stdout.split(/\r?\n/);

    const contentStart = beginIndex + VERSION_OUTPUT_BEGIN.length;
    const endIndex = stdout.indexOf(VERSION_OUTPUT_END, contentStart);
    if (endIndex === -1) {
        throw new Error('Could not parse sandbox PKGBUILD evaluation output: missing end marker');
    }

    const payload = stdout
        .slice(contentStart, endIndex)
        .replace(/^\r?\n/, '')
        .replace(/\r?\n$/, '');

    return payload.split(/\r?\n/);
}

function parseRequiredNonNegativeInt(value: string | undefined, field: string, context: string): number {
    const trimmed = value?.trim() ?? '';
    const parsed = Number.parseInt(trimmed, 10);
    if (!trimmed || Number.isNaN(parsed) || parsed < 0) {
        throw new Error(`Could not parse ${field} from ${context} (got "${trimmed}")`);
    }

    return parsed;
}

function parseOptionalNonNegativeInt(value: string | undefined, field: string, context: string): number {
    const trimmed = value?.trim() ?? '';
    if (trimmed === '') return 0;

    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isNaN(parsed) || parsed < 0) {
        throw new Error(`Could not parse ${field} from ${context} (got "${trimmed}")`);
    }

    return parsed;
}

async function runSandboxCommand(options: SandboxRunOptions): Promise<string> {
    await prepareMetadataRoot(options.sandbox, options.packages ?? []);
    const plan = await buildPkgbuildSandboxCommand(options);
    const rootInfo = options.sandbox.ephemeral
        ? `volatile overlay of ${options.sandbox.root}`
        : options.sandbox.root;
    console.log(PkgbuildSandboxMessager(`Executing in ${rootInfo}: ${options.command}`));

    return new Promise((resolve, reject) => {
        const child = spawn(plan.cmd, plan.args, {
            env: Object.fromEntries(plan.env),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (chunk) => {
            const text = chunk.toString();
            stdout += text;
            if (!options.captureStdout) process.stdout.write(text);
        });
        child.stderr?.on('data', (chunk) => {
            const text = chunk.toString();
            stderr += text;
            process.stderr.write(text);
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve(stdout);
                return;
            }

            reject(new Error(`PKGBUILD sandbox command failed with exit code ${code}: ${stderr.trim()}`));
        });

        child.on('error', reject);
    });
}

export async function buildPkgbuildSandboxCommand(options: SandboxRunOptions): Promise<PkgbuildSandboxCommandPlan> {
    const pkgDir = path.dirname(path.resolve(options.pkgbuildPath));
    // Metadata commands never run makepkg with --log, so LOGDEST is not needed here.
    // Dropping it avoids creating per-package log directories for packages that are
    // only checked and never built; the real build creates it before starting.
    const env = options.env?.filter(([key]) => key !== 'LOGDEST');
    await ensureSandboxEnvDirs(env);

    const envPairs = sandboxEnvPairs(env);
    const nspawnArgs = [
        '--quiet',
        // Concurrent commands share one root; skip machined registration and
        // use a unique machine name so they do not collide on the name derived
        // from the directory.
        '--register=no',
        `--machine=${uniqueMachineName()}`,
        `--directory=${options.sandbox.root}`,
        // Mount the root read-only with a tmpfs overlay on top instead of
        // copying it (--ephemeral copies the whole tree on non-btrfs roots).
        ...(options.sandbox.ephemeral ? ['--volatile=overlay'] : []),
        `--bind=${pkgDir}:${SANDBOX_PKG_DIR}`,
        `--chdir=${SANDBOX_PKG_DIR}`,
        `--setenv=HOME=${SANDBOX_HOME}`,
        `--setenv=GNUPGHOME=${SANDBOX_GNUPG_HOME}`,
        ...envAssignments(envPairs).map(item => `--setenv=${item}`),
        ...sandboxEnvBinds(env),
        ...(options.sandbox.network ? [] : ['--private-network']),
        '/bin/bash',
        '-lc',
        sandboxEntrypointCommand(options.sandbox.user, options.command, envPairs),
    ];

    // Overlay lower directories must not change while mounted, so volatile
    // commands share the root lock and anything writing to the root takes it
    // exclusively.
    return withRootLock(
        sandboxCommandPlan(options.sandbox, nspawnArgs),
        await resolveMetadataRootLockFile(options.sandbox.root),
        options.sandbox.ephemeral ? 'shared' : 'exclusive',
    );
}

let machineNameCounter = 0;

/**
 * nspawn keeps per-machine runtime state under /run/systemd/nspawn/<machine>
 * (such as unix-export) even with --register=no, and refuses to start when it
 * already exists. A name unique per process and call avoids clashes between
 * concurrent commands and with state left by a killed container.
 */
export function uniqueMachineName(): string {
    machineNameCounter += 1;
    return `preaur-meta-${process.pid}-${machineNameCounter}`;
}

function withRootLock(plan: PkgbuildSandboxCommandPlan, lockFile: string | undefined, mode: 'shared' | 'exclusive'): PkgbuildSandboxCommandPlan {
    if (!lockFile) return plan;

    return {
        cmd: 'flock',
        args: [mode === 'shared' ? '--shared' : '--exclusive', lockFile, plan.cmd, ...plan.args],
        env: plan.env,
    };
}

/**
 * Lock file coordinating metadata commands with root maintenance across
 * PreAUR processes. mkarchroot leaves a world-readable `<root>.lock` next to
 * roots it creates; other roots fall back to a per-root file in the temp dir.
 */
export async function resolveMetadataRootLockFile(root: string): Promise<string> {
    const devtoolsLock = `${root}.lock`;
    if (await pathExists(devtoolsLock)) return devtoolsLock;

    const digest = createHash('sha256').update(root).digest('hex').slice(0, 16);
    return path.join(os.tmpdir(), `preaur-metadata-${digest}.lock`);
}

function sandboxCommandPlan(sandbox: ResolvedPkgbuildSandboxOptions, nspawnArgs: string[]): PkgbuildSandboxCommandPlan {
    if (shouldUseSudo(sandbox)) {
        return {
            cmd: 'sudo',
            args: [sandbox.command, ...nspawnArgs],
            env: cleanHostEnv(),
        };
    }

    return {
        cmd: sandbox.command,
        args: nspawnArgs,
        env: cleanHostEnv(),
    };
}

/**
 * Packages installed in the dedicated metadata root: the PKGBUILD tooling
 * PreAUR needs plus `pkgbuildSandbox.packages`.
 */
export function metadataRootPackages(sandbox: ResolvedPkgbuildSandboxOptions): string[] {
    return mergePackages(METADATA_ROOT_BASE_PACKAGES, sandbox.packages);
}

/**
 * Make sure the persistent metadata root exists, is updated once per PreAUR
 * process, and contains the requested packages. Metadata commands then run in
 * disposable views of this root without installing anything themselves.
 */
async function prepareMetadataRoot(sandbox: ResolvedPkgbuildSandboxOptions, packages: string[]): Promise<void> {
    const state = metadataRootState(sandbox.root);
    const isReady = () => state.prepared && packages.every(pkg => state.installed.has(pkg));
    if (isReady()) return;

    const run = state.chain.then(async () => {
        if (!state.prepared) {
            await ensureMetadataRootExists(sandbox);
            const basePackages = metadataRootPackages(sandbox);
            try {
                await runMetadataRootMaintenance(sandbox, basePackages, true);
            } catch (e: any) {
                // Metadata commands can usually still run against a stale root,
                // so an update failure (for example, no network) is not fatal.
                console.warn(PkgbuildSandboxMessager(`Failed to update metadata chroot ${sandbox.root}; continuing with the existing root: ${e.message}`));
            }
            for (const pkg of basePackages) state.installed.add(pkg);
            state.prepared = true;
        }

        const missing = mergePackages(packages).filter(pkg => !state.installed.has(pkg));
        if (missing.length > 0) {
            await runMetadataRootMaintenance(sandbox, missing, false);
            for (const pkg of missing) state.installed.add(pkg);
        }
    });
    state.chain = run.catch(() => undefined);
    await run;
}

function metadataRootState(root: string): MetadataRootState {
    let state = metadataRootStates.get(root);
    if (!state) {
        state = { prepared: false, installed: new Set(), chain: Promise.resolve() };
        metadataRootStates.set(root, state);
    }

    return state;
}

async function ensureMetadataRootExists(sandbox: ResolvedPkgbuildSandboxOptions): Promise<void> {
    if (await pathExists(sandbox.root)) return;

    if (!sandbox.initRoot) {
        throw new Error(`PKGBUILD sandbox root does not exist: ${sandbox.root}`);
    }

    const plan = await buildMetadataRootInitCommand(sandbox);
    console.log(PkgbuildSandboxMessager(`Creating metadata chroot ${sandbox.root} with mkarchroot...`));
    try {
        await runLoggedCommand(plan.cmd, plan.args, 'Metadata chroot creation');
    } catch (e) {
        // Another PreAUR process may have created the root concurrently.
        if (!await pathExists(sandbox.root)) throw e;
    }

    await fs.access(sandbox.root);
}

async function pathExists(target: string): Promise<boolean> {
    try {
        await fs.access(target);
        return true;
    } catch (e: any) {
        if (e.code === 'ENOENT') return false;
        throw e;
    }
}

/**
 * Build the devtools `mkarchroot` command that creates the dedicated metadata
 * root, mirroring how `archbuild` creates its build root.
 */
export async function buildMetadataRootInitCommand(
    sandbox: ResolvedPkgbuildSandboxOptions,
    devtoolsDir: string = DEVTOOLS_DIR,
    hostArch: string = os.machine(),
): Promise<{ cmd: string; args: string[] }> {
    const [builderCmd] = sandbox.builder.split(' ');
    const target = resolveBuilderTarget(sandbox.builder);
    if (!builderCmd || !target) {
        throw new Error(`Cannot initialize PKGBUILD sandbox root with non-devtools builder: ${sandbox.builder}. Create ${sandbox.root} manually or use a devtools *-build builder.`);
    }

    const pacmanConfig = await resolveBasePacmanConfig(builderCmd, devtoolsDir);
    const makepkgConfig = path.join(devtoolsDir, 'makepkg.conf.d', `${target.arch}.conf`);
    const packages = mergePackages(
        target.repo.startsWith('multilib') ? ['base-devel', 'multilib-devel'] : [],
        metadataRootPackages(sandbox),
    );
    const mkarchrootArgs = ['-C', pacmanConfig, '-M', makepkgConfig, sandbox.root, ...packages];

    const setArch = await resolveSetArch(target.arch, devtoolsDir);
    if (setArch === hostArch) {
        return { cmd: 'mkarchroot', args: mkarchrootArgs };
    }

    return { cmd: 'setarch', args: [setArch, 'mkarchroot', ...mkarchrootArgs] };
}

async function resolveSetArch(arch: string, devtoolsDir: string): Promise<string> {
    try {
        const alias = await fs.readFile(path.join(devtoolsDir, 'setarch-aliases.d', arch), 'utf8');
        return alias.trim() || arch;
    } catch (e: any) {
        if (e.code === 'ENOENT') return arch;
        throw e;
    }
}

async function runMetadataRootMaintenance(sandbox: ResolvedPkgbuildSandboxOptions, packages: string[], refresh: boolean): Promise<void> {
    const plan = buildMetadataRootMaintenanceCommand(sandbox, packages, {
        refresh,
        cacheDir: await resolveHostPacmanCacheDir(),
        mirrorlist: await pathExists(HOST_MIRRORLIST) ? HOST_MIRRORLIST : undefined,
        lockFile: await resolveMetadataRootLockFile(sandbox.root),
    });
    const action = refresh ? 'Updating' : `Installing ${packages.join(' ')} into`;
    console.log(PkgbuildSandboxMessager(`${action} metadata chroot ${sandbox.root}...`));
    await runLoggedCommand(plan.cmd, plan.args, 'Metadata chroot maintenance', plan.env);
}

/**
 * Build the command that updates the persistent metadata root or installs
 * extra packages into it. Runs directly on the root (not ephemeral) with the
 * host package cache and mirrorlist, like devtools' arch-nspawn.
 */
export function buildMetadataRootMaintenanceCommand(
    sandbox: ResolvedPkgbuildSandboxOptions,
    packages: string[],
    options: { refresh: boolean; cacheDir?: string; mirrorlist?: string; lockFile?: string },
): PkgbuildSandboxCommandPlan {
    const quotedPackages = mergePackages(packages).map(shellQuote).join(' ');
    const pacmanSteps = options.refresh
        ? [
            'pacman -Sy --needed --noconfirm archlinux-keyring',
            `pacman -Su --needed --noconfirm ${quotedPackages}`,
        ]
        : [`pacman -S --needed --noconfirm ${quotedPackages}`];

    const nspawnArgs = [
        '--quiet',
        '--register=no',
        `--machine=${uniqueMachineName()}`,
        `--directory=${sandbox.root}`,
        ...(options.cacheDir ? [`--bind=${options.cacheDir}:${CHROOT_PACMAN_CACHE}`] : []),
        ...(options.mirrorlist ? [`--bind-ro=${options.mirrorlist}:${HOST_MIRRORLIST}`] : []),
        '/bin/bash',
        '-lc',
        [
            'set -e',
            ...pacmanSteps,
            ...(options.refresh ? ensureSandboxUserScript(sandbox.user) : []),
        ].join('\n'),
    ];

    return withRootLock(sandboxCommandPlan(sandbox, nspawnArgs), options.lockFile, 'exclusive');
}

async function resolveHostPacmanCacheDir(): Promise<string | undefined> {
    const output = await new Promise<string>((resolve) => {
        const child = spawn('pacman-conf', ['CacheDir'], { stdio: ['ignore', 'pipe', 'ignore'] });
        let stdout = '';
        child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
        child.on('close', code => resolve(code === 0 ? stdout : ''));
        child.on('error', () => resolve(''));
    });
    const cacheDir = output.split('\n').map(line => line.trim()).find(Boolean);
    if (cacheDir && await pathExists(cacheDir)) return cacheDir;

    return await pathExists(CHROOT_PACMAN_CACHE) ? CHROOT_PACMAN_CACHE : undefined;
}

async function runLoggedCommand(cmd: string, args: string[], label: string, env: EnvPair[] = cleanHostEnv()): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn(cmd, args, {
            env: Object.fromEntries(env),
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stderr = '';
        child.stdout?.on('data', chunk => process.stdout.write(chunk));
        child.stderr?.on('data', chunk => {
            stderr += chunk.toString();
            process.stderr.write(chunk);
        });

        child.on('close', code => {
            if (code === 0) {
                resolve();
                return;
            }

            reject(new Error(`${label} failed with exit code ${code}: ${stderr.trim()}`));
        });

        child.on('error', reject);
    });
}

function shouldUseSudo(sandbox: ResolvedPkgbuildSandboxOptions): boolean {
    return sandbox.sudo && typeof process.getuid === 'function' && process.getuid() !== 0;
}

function hostUid(): number {
    return typeof process.getuid === 'function' ? process.getuid() : 1000;
}

function ensureSandboxUserScript(user: string): string[] {
    const uid = hostUid();
    const quotedUser = shellQuote(user);

    return [
        `if id -u ${quotedUser} >/dev/null 2>&1; then`,
        `  if [ "$(id -u ${quotedUser})" != "${uid}" ]; then`,
        '    echo "PreAUR sandbox user exists with a different UID; set config.pkgbuildSandbox.user to a free username." >&2',
        '    exit 1',
        '  fi',
        'else',
        `  useradd -M -u ${uid} -d ${shellQuote(SANDBOX_HOME)} -s /bin/bash ${quotedUser}`,
        'fi',
    ];
}

function sandboxEntrypointCommand(user: string, command: string, envPairs: EnvPairs): string {
    const uid = hostUid();
    const gid = typeof process.getgid === 'function' ? process.getgid() : uid;
    const quotedUser = shellQuote(user);
    const quotedHome = shellQuote(SANDBOX_HOME);
    const quotedGnupgHome = shellQuote(SANDBOX_GNUPG_HOME);
    const runCommand = `cd ${shellQuote(SANDBOX_PKG_DIR)} && ${command}`;
    const commandEnv = [
        `HOME=${SANDBOX_HOME}`,
        `GNUPGHOME=${SANDBOX_GNUPG_HOME}`,
        ...envAssignments(envPairs),
    ].map(shellQuote).join(' ');

    return [
        'set -e',
        ...ensureSandboxUserScript(user),
        `mkdir -p ${quotedHome} ${quotedGnupgHome}`,
        `chown ${uid}:${gid} ${quotedHome} ${quotedGnupgHome} 2>/dev/null || chown ${uid} ${quotedHome} ${quotedGnupgHome}`,
        `runuser -u ${quotedUser} -- env ${commandEnv} bash -lc ${shellQuote(runCommand)}`,
    ].join('\n');
}

function mergePackages(...groups: Array<string[] | undefined>): string[] {
    return [...new Set(
        groups
            .flatMap(group => group ?? [])
            .map(item => item.trim())
            .filter(Boolean)
    )];
}

async function ensureSandboxEnvDirs(env: EnvPairs | undefined): Promise<void> {
    for (const [, value] of env ?? []) {
        if (!path.isAbsolute(value)) continue;
        await fs.mkdir(value, { recursive: true });
    }
}

function sandboxEnvPairs(env: EnvPairs | undefined): EnvPair[] {
    return (env ?? []).map(([key, value]) => {
        if (!path.isAbsolute(value)) return [key, value];

        return [key, sandboxEnvPath(key)];
    });
}

function sandboxEnvBinds(env: EnvPairs | undefined): string[] {
    return (env ?? [])
        .filter(([, value]) => path.isAbsolute(value))
        .map(([key, value]) => `--bind=${path.resolve(value)}:${sandboxEnvPath(key)}`);
}

function sandboxEnvPath(key: string): string {
    return path.posix.join('/mnt', `preaur-${key.toLowerCase()}`);
}

function cleanHostEnv(): EnvPair[] {
    const keep = new Set(['PATH', 'TERM', 'LANG', 'LC_ALL']);
    const pairs: EnvPair[] = [];

    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && keep.has(key)) {
            pairs.push([key, value]);
        }
    }

    if (!pairs.some(([key]) => key === 'PATH')) {
        pairs.push(['PATH', '/usr/local/sbin:/usr/local/bin:/usr/bin']);
    }

    if (!pairs.some(([key]) => key === 'TERM') && process.stdout.isTTY) {
        pairs.push(['TERM', process.env.TERM ?? 'xterm-256color']);
    }

    return pairs;
}
