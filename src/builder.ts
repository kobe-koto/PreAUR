import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type { PreaurChrootPacmanConfig, PreaurResources } from './config';
import { envAssignments, filterEnvPairs, mergeEnvPairs, type EnvPair, type EnvPairs } from './env';
import { hasChrootPacmanConfig, writeChrootPacmanConfig } from './chroot_pacman';

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
    env?: EnvPairs;
    chrootPacman?: PreaurChrootPacmanConfig;
    baseDir?: string;
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
        chrootPacmanConfig?: string;
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

    if (opts.chrootPacmanConfig && isDevtoolsBuild) {
        makechrootpkgArgs.push('-D', `${opts.chrootPacmanConfig}:/etc/pacman.conf`);
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

export function buildProcessEnvPairs(
    extraEnv: EnvPairs | undefined,
    opts: {
        nproc: number;
        packager?: string;
        devtoolsBuild?: boolean;
    }
): EnvPair[] {
    const normalizedExtraEnv = mergeEnvPairs(extraEnv);
    const filteredExtraEnv = opts.devtoolsBuild
        ? filterEnvPairs(normalizedExtraEnv, DEVTOOLS_IGNORED_ENV_KEYS)
        : normalizedExtraEnv;
    const generatedEnv: EnvPair[] = [
        ['MAKEFLAGS', `-j${opts.nproc}`],
    ];

    if (opts.devtoolsBuild) {
        generatedEnv.push(['NPROC', String(opts.nproc)]);
    } else {
        generatedEnv.push(['COMPRESSZST', `zstd -c -T${opts.nproc} -`]);
    }

    if (opts.packager) {
        generatedEnv.push(['PACKAGER', opts.packager]);
    }

    return mergeEnvPairs(filteredExtraEnv, generatedEnv);
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
        chrootPacman,
        baseDir = process.cwd(),
    } = opts;

    const nproc = calculateNproc(resources?.cpu);

    const workerInfo = chrootWorker ? ` chroot=[${chrootWorker}]` : '';
    console.log(`[Builder] Starting build for ${path.basename(pkgDir)} using ${builder} with MAKEFLAGS="-j${nproc}"${workerInfo}`);

    const [builderCmd] = builder.split(' ');
    const chrootPacmanConfig = builderCmd && builderCmd.endsWith('-build') && hasChrootPacmanConfig(chrootPacman)
        ? await writeChrootPacmanConfig({
            builderCmd,
            config: chrootPacman!,
            baseDir,
        })
        : undefined;

    const buildPlan = buildCommandPlan(builder, { dummyPkgs, chrootWorker, chrootPacmanConfig });
    const { cmd, args, isDevtoolsBuild } = buildPlan;

    return new Promise((resolve, reject) => {
        const envPairs = buildProcessEnvPairs(extraEnv, {
            nproc,
            packager,
            devtoolsBuild: isDevtoolsBuild,
        });

        const buildProcess = spawn('env', [...envAssignments(envPairs), cmd, ...args], {
            cwd: pkgDir,
            stdio: logStream ? ['ignore', 'pipe', 'pipe'] : 'inherit',
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
