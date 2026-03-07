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

export async function buildPackage(
    pkgDir: string,
    builder: string = 'extra-x86_64-build',
    resources?: PreaurResources,
    dummyPkgs?: string[],
    logStream?: fs.WriteStream
): Promise<void> {
    const nproc = calculateNproc(resources?.cpu);

    console.log(`[Builder] Starting build for ${path.basename(pkgDir)} using ${builder} with MAKEFLAGS="-j${nproc}"`);

    return new Promise((resolve, reject) => {
        // Determine the command and arguments. `extra-x86_64-build` usually takes no required args
        // but relies on being in the correct directory.
        const [cmd, ...args] = builder.split(' ');

        if (!cmd) {
            reject(new Error('Invalid builder command'));
            return;
        }

        if (dummyPkgs && dummyPkgs.length > 0) {
            if (cmd.endsWith('-build')) {
                args.push('--');
            }
            for (const p of dummyPkgs) {
                args.push('-I', p);
            }
        }

        const buildProcess = spawn(cmd, args, {
            cwd: pkgDir,
            stdio: logStream ? ['ignore', 'pipe', 'pipe'] : 'inherit',
            env: {
                ...process.env,
                MAKEFLAGS: `-j${nproc}`,
            }
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
