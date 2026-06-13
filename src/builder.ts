import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type { PreaurResources } from './config';
import { writeMakepkgConfig } from './workdirs';

const DEVTOOLS_IGNORED_ENV_KEYS = new Set([
    'BUILDDIR',
    'COMPRESSZST',
]);

export function calculateNproc(cpuConfig?: string): number {
    if (!cpuConfig) return Math.max(1, os.cpus().length - 1); // default -1

    if (cpuConfig === '--all') {
        return os.cpus().length;
    }

    const parsed = parseInt(cpuConfig, 10);
    if (isNaN(parsed)) {
        return Math.max(1, os.cpus().length - 1);
    }

    if (cpuConfig.startsWith('-')) {
        return Math.max(1, os.cpus().length + parsed);
    } else {
        return Math.max(1, parsed);
    }
}

export interface BuildOptions {
    pkgDir: string;
    builder?: string;
    resources?: PreaurResources;
    dummyPkgs?: string[];
    logStream?: fs.WriteStream;
    chrootWorker?: string;
    packager?: string;
    env?: Record<string, string>;
}

export interface BuildCommandPlan {
    cmd: string;
    args: string[];
    isDevtoolsBuild: boolean;
}

export function buildCommandPlan(
    builder: string,
    opts: {
        dummyPkgs?: string[];
        chrootWorker?: string;
    } = {}
): BuildCommandPlan {
    const [cmd, ...args] = builder.split(' ');

    if (!cmd) {
        throw new Error('Invalid builder command');
    }

    const isDevtoolsBuild = cmd.endsWith('-build');
    const makechrootpkgArgs: string[] = [];

    // Assign a unique chroot copy name so parallel builds don't block each other.
    if (opts.chrootWorker && isDevtoolsBuild) {
        makechrootpkgArgs.push('-l', opts.chrootWorker);
    }

    // Inject dummy/repo dependency packages via -I.
    if (opts.dummyPkgs && opts.dummyPkgs.length > 0) {
        if (isDevtoolsBuild) {
            for (const p of opts.dummyPkgs) {
                makechrootpkgArgs.push('-I', p);
            }
        } else {
            for (const p of opts.dummyPkgs) {
                args.push('-I', p);
            }
        }
    }

    // Devtools *-build wrappers pass arguments after -- to makechrootpkg.
    if (isDevtoolsBuild && makechrootpkgArgs.length > 0) {
        args.push('--', ...makechrootpkgArgs);
    }

    return { cmd, args, isDevtoolsBuild };
}

export function buildProcessEnv(
    baseEnv: Record<string, string | undefined>,
    extraEnv: Record<string, string> | undefined,
    opts: {
        nproc: number;
        packager?: string;
        devtoolsBuild?: boolean;
    }
): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(baseEnv)) {
        if (value !== undefined) env[key] = value;
    }

    for (const [key, value] of Object.entries(extraEnv ?? {})) {
        if (opts.devtoolsBuild && DEVTOOLS_IGNORED_ENV_KEYS.has(key)) continue;
        env[key] = value;
    }

    env.MAKEFLAGS = `-j${opts.nproc}`;

    if (opts.devtoolsBuild) {
        env.NPROC = String(opts.nproc);
    } else {
        env.COMPRESSZST = `zstd -c -T${opts.nproc} -`;
    }

    if (opts.packager) {
        env.PACKAGER = opts.packager;
    }

    return env;
}

export async function buildPackage(opts: BuildOptions): Promise<void> {
    const {
        pkgDir,
        builder = 'extra-x86_64-build',
        resources,
        dummyPkgs,
        logStream,
        chrootWorker,
        packager,
        env: extraEnv,
    } = opts;

    const nproc = calculateNproc(resources?.cpu);

    const workerInfo = chrootWorker ? ` chroot=[${chrootWorker}]` : '';
    console.log(`[Builder] Starting build for ${path.basename(pkgDir)} using ${builder} with MAKEFLAGS="-j${nproc}"${workerInfo}`);

    const buildPlan = buildCommandPlan(builder, { dummyPkgs, chrootWorker });
    const { cmd, args, isDevtoolsBuild } = buildPlan;

    if (extraEnv?.MAKEPKG_CONF && extraEnv.SRCDEST && extraEnv.LOGDEST && extraEnv.BUILDDIR && extraEnv.PKGDEST) {
        await writeMakepkgConfig(extraEnv.MAKEPKG_CONF, {
            srcdest: extraEnv.SRCDEST,
            logdest: extraEnv.LOGDEST,
            builddir: extraEnv.BUILDDIR,
            pkgdest: extraEnv.PKGDEST,
            makeflags: `-j${nproc}`,
            compressZstdThreads: nproc,
            packager,
        });
    }

    return new Promise((resolve, reject) => {
        const env = buildProcessEnv(process.env, extraEnv, {
            nproc,
            packager,
            devtoolsBuild: isDevtoolsBuild,
        });

        const buildProcess = spawn(cmd, args, {
            cwd: pkgDir,
            stdio: logStream ? ['ignore', 'pipe', 'pipe'] : 'inherit',
            env,
        });

        if (logStream && buildProcess.stdout && buildProcess.stderr) {
            buildProcess.stdout.pipe(logStream, { end: false });
            buildProcess.stderr.pipe(logStream, { end: false });
        }

        buildProcess.on('close', (code: number | null) => {
            if (code === 0) {
                console.log(`[Builder] Build finished successfully for ${path.basename(pkgDir)}`);
                resolve();
            } else {
                console.error(`[Builder] Build failed for ${path.basename(pkgDir)} with code ${code}`);
                reject(new Error(`Build failed with exit code ${code}`));
            }
        });

        buildProcess.on('error', (err: Error) => {
            console.error(`[Builder] Failed to start builder process: ${err.message}`);
            reject(err);
        });
    });
}
