import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type { PreaurResources } from './config';

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
    } = opts;

    const nproc = calculateNproc(resources?.cpu);

    const workerInfo = chrootWorker ? ` chroot=[${chrootWorker}]` : '';
    console.log(`[Builder] Starting build for ${path.basename(pkgDir)} using ${builder} with MAKEFLAGS="-j${nproc}"${workerInfo}`);

    return new Promise((resolve, reject) => {
        // Determine the command and arguments. `extra-x86_64-build` usually takes no required args
        // but relies on being in the correct directory.
        const [cmd, ...args] = builder.split(' ');

        if (!cmd) {
            reject(new Error('Invalid builder command'));
            return;
        }

        // For devtools *-build commands, extra arguments are passed to makechrootpkg
        // via `-- <makechrootpkg_args>`. We need to collect those separately.
        const isDevtoolsBuild = cmd.endsWith('-build');
        const makechrootpkgArgs: string[] = [];

        // Assign a unique chroot copy name so parallel builds don't block each other
        if (chrootWorker && isDevtoolsBuild) {
            makechrootpkgArgs.push('-l', chrootWorker);
        }

        // Inject dummy/repo dependency packages via -I
        if (dummyPkgs && dummyPkgs.length > 0) {
            for (const p of dummyPkgs) {
                makechrootpkgArgs.push('-I', p);
            }
        }

        // Append the `--` separator and makechrootpkg args if needed
        if (isDevtoolsBuild && makechrootpkgArgs.length > 0) {
            args.push('--', ...makechrootpkgArgs);
        } else if (!isDevtoolsBuild && dummyPkgs && dummyPkgs.length > 0) {
            // Non-devtools builder: just pass -I directly
            for (const p of dummyPkgs) {
                args.push('-I', p);
            }
        }

        const env: Record<string, string> = {
            ...process.env as Record<string, string>,
            MAKEFLAGS: `-j${nproc}`,
            COMPRESSZST: `zstd -c -T${nproc} -`,
        };

        if (packager) {
            env.PACKAGER = packager;
        }

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
