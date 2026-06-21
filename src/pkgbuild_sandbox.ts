import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PreaurPkgbuildSandboxConfig } from './config';
import { envAssignments, shellQuote, type EnvPair, type EnvPairs } from './env';
import { updatePkgBuildWithOps, type PkgBuildData, type PkgBuildParser } from './pkgbuild';
import { resolveDevtoolsBuildTarget } from './chroot_pacman';
import type { PackageWorkDirs } from './workdirs';
import { constructMessager } from './logger';

const SANDBOX_PKG_DIR = '/mnt/preaur-pkg';
const DEFAULT_SANDBOX_COMMAND = 'systemd-nspawn';
const DEFAULT_SANDBOX_USER = 'preaur';
const INIT_PKG_NAME = 'preaur-chroot-init';

const PkgbuildSandboxMessager = constructMessager('PKGBUILD Sandbox');
const chrootInitLocks = new Map<string, Promise<void>>();

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
}

export function resolvePkgbuildSandboxOptions(options: PkgbuildSandboxOptions): ResolvedPkgbuildSandboxOptions | undefined {
    const enabled = options.config?.enabled ?? true;
    if (!enabled) return undefined;

    const root = options.config?.root ?? deriveDevtoolsChrootRoot(options.builder);
    if (!root) {
        throw new Error(`PKGBUILD sandbox root could not be derived from builder "${options.builder}". Set config.pkgbuildSandbox.root or disable config.pkgbuildSandbox.enabled.`);
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
        builder: options.builder,
    };
}

function deriveDevtoolsChrootRoot(builder: string): string | undefined {
    const [builderCmd] = builder.split(' ');
    if (!builderCmd) return undefined;

    const target = resolveDevtoolsBuildTarget(builderCmd);
    if (!target) return undefined;

    return path.resolve('/var/lib/archbuild', `${target.repo}-${target.arch}`, 'root');
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

    const script = `export CARCH="$(uname -m)"; source ./PKGBUILD >/dev/null 2>&1; printf '%s\\n%s\\n%s\\n' "\${epoch-}" "\${pkgver-}" "\${pkgrel-}"`;
    const stdout = await runSandboxCommand({
        pkgbuildPath,
        env,
        sandbox,
        workDirs,
        command: `bash -lc ${shellQuote(script)}`,
        captureStdout: true,
    });
    const [epoch = '', pkgver = '', pkgrel = ''] = stdout.split('\n');

    const parsedPkgrel = parseInt(pkgrel.trim(), 10);
    if (isNaN(parsedPkgrel)) {
        throw new Error(`Could not parse pkgrel from sandbox PKGBUILD evaluation (got "${pkgrel.trim()}")`);
    }

    const parsedEpoch = epoch.trim() ? parseInt(epoch.trim(), 10) : 0;
    if (isNaN(parsedEpoch) || parsedEpoch < 0) {
        throw new Error(`Could not parse epoch from sandbox PKGBUILD evaluation (got "${epoch.trim()}")`);
    }

    if (!pkgver.trim()) {
        throw new Error('Could not parse pkgver from sandbox PKGBUILD evaluation');
    }

    return { epoch: parsedEpoch, pkgver: pkgver.trim(), pkgrel: parsedPkgrel };
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
    });

    return true;
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

    const pkgrel = parseInt(fields.pkgrel, 10);
    if (isNaN(pkgrel)) {
        throw new Error(`Could not parse pkgrel from sandbox makepkg --printsrcinfo (got "${fields.pkgrel}")`);
    }

    const epoch = fields.epoch ? parseInt(fields.epoch, 10) : 0;
    if (isNaN(epoch) || epoch < 0) {
        throw new Error(`Could not parse epoch from sandbox makepkg --printsrcinfo (got "${fields.epoch}")`);
    }

    return { epoch, pkgver: fields.pkgver, pkgrel };
}

async function runSandboxCommand(options: SandboxRunOptions): Promise<string> {
    const plan = await buildPkgbuildSandboxCommand(options);
    const rootInfo = options.sandbox.ephemeral
        ? `temporary copy of ${options.sandbox.root}`
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
    await ensureSandboxRoot(options.sandbox);
    await ensureSandboxEnvDirs(options.env);

    const envPairs = sandboxEnvPairs(options.env);
    const nspawnArgs = [
        '--quiet',
        `--directory=${options.sandbox.root}`,
        ...(options.sandbox.ephemeral ? ['--ephemeral'] : []),
        `--bind=${pkgDir}:${SANDBOX_PKG_DIR}`,
        `--chdir=${SANDBOX_PKG_DIR}`,
        '--setenv=HOME=/tmp/preaur-home',
        '--setenv=GNUPGHOME=/tmp/preaur-gnupg',
        ...envAssignments(envPairs).map(item => `--setenv=${item}`),
        ...sandboxEnvBinds(options.env),
        ...(options.sandbox.network ? [] : ['--private-network']),
        '/bin/bash',
        '-lc',
        sandboxEntrypointCommand(options.sandbox.user, options.command, envPairs),
    ];

    if (shouldUseSudo(options.sandbox)) {
        return {
            cmd: 'sudo',
            args: [options.sandbox.command, ...nspawnArgs],
            env: cleanHostEnv(),
        };
    }

    return {
        cmd: options.sandbox.command,
        args: nspawnArgs,
        env: cleanHostEnv(),
    };
}

async function ensureSandboxRoot(sandbox: ResolvedPkgbuildSandboxOptions): Promise<void> {
    try {
        await fs.access(sandbox.root);
        return;
    } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
    }

    if (!sandbox.initRoot) {
        throw new Error(`PKGBUILD sandbox root does not exist: ${sandbox.root}`);
    }

    let init = chrootInitLocks.get(sandbox.root);
    if (!init) {
        init = initializeSandboxRoot(sandbox)
            .finally(() => {
                chrootInitLocks.delete(sandbox.root);
            });
        chrootInitLocks.set(sandbox.root, init);
    }

    await init;
    await fs.access(sandbox.root);
}

async function initializeSandboxRoot(sandbox: ResolvedPkgbuildSandboxOptions): Promise<void> {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'preaur-chroot-init-'));
    try {
        await fs.writeFile(path.join(workDir, 'PKGBUILD'), renderChrootInitPkgbuild(), 'utf8');
        const plan = buildChrootInitCommand(sandbox.builder);
        console.log(PkgbuildSandboxMessager(`Initializing missing chroot root ${sandbox.root} with ${plan.cmd}...`));
        await runLoggedCommand(plan.cmd, plan.args, workDir);
    } finally {
        await fs.rm(workDir, { recursive: true, force: true });
    }
}

export function renderChrootInitPkgbuild(): string {
    return [
        `pkgname=${INIT_PKG_NAME}`,
        'pkgver=1',
        'pkgrel=1',
        "pkgdesc='PreAUR generated chroot initialization package'",
        "arch=('any')",
        'package() {',
        '  :',
        '}',
        '',
    ].join('\n');
}

export function buildChrootInitCommand(builder: string): { cmd: string; args: string[] } {
    const [cmd, ...args] = builder.split(' ');
    if (!cmd || !cmd.endsWith('-build')) {
        throw new Error(`Cannot initialize PKGBUILD sandbox root with non-devtools builder: ${builder}`);
    }

    return { cmd, args };
}

async function runLoggedCommand(cmd: string, args: string[], cwd: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn(cmd, args, {
            cwd,
            env: Object.fromEntries(cleanHostEnv()),
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

            reject(new Error(`Chroot root initialization failed with exit code ${code}: ${stderr.trim()}`));
        });

        child.on('error', reject);
    });
}

function shouldUseSudo(sandbox: ResolvedPkgbuildSandboxOptions): boolean {
    return sandbox.sudo && typeof process.getuid === 'function' && process.getuid() !== 0;
}

function sandboxEntrypointCommand(user: string, command: string, envPairs: EnvPairs): string {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    const gid = typeof process.getgid === 'function' ? process.getgid() : uid;
    const quotedUser = shellQuote(user);
    const quotedHome = shellQuote('/tmp/preaur-home');
    const quotedGnupgHome = shellQuote('/tmp/preaur-gnupg');
    const runCommand = `cd ${shellQuote(SANDBOX_PKG_DIR)} && ${command}`;
    const commandEnv = [
        'HOME=/tmp/preaur-home',
        'GNUPGHOME=/tmp/preaur-gnupg',
        ...envAssignments(envPairs),
    ].map(shellQuote).join(' ');

    return [
        'set -e',
        `if id -u ${quotedUser} >/dev/null 2>&1; then`,
        `  if [ "$(id -u ${quotedUser})" != "${uid}" ]; then`,
        '    echo "PreAUR sandbox user exists with a different UID; set config.pkgbuildSandbox.user to a free username." >&2',
        '    exit 1',
        '  fi',
        'else',
        `  useradd -M -u ${uid} -d ${quotedHome} -s /bin/bash ${quotedUser}`,
        'fi',
        `mkdir -p ${quotedHome} ${quotedGnupgHome}`,
        `chown ${uid}:${gid} ${quotedHome} ${quotedGnupgHome} 2>/dev/null || chown ${uid} ${quotedHome} ${quotedGnupgHome}`,
        `runuser -u ${quotedUser} -- env ${commandEnv} bash -lc ${shellQuote(runCommand)}`,
    ].join('\n');
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
