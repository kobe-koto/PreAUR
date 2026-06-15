import * as fs from 'node:fs/promises';
import { WriteStream } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PreaurPackage } from './config';

const execAsync = promisify(exec);

export interface PreBuildConfig {
    packages: string[];
    scripts: string[];
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function safePkgnameSegment(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9@._+-]+/g, '-').replace(/^-+|-+$/g, '') || 'package';
}

export function packagePreBuildConfig(pkg: PreaurPackage): PreBuildConfig {
    return {
        packages: [
            ...(pkg['pre-build-packages'] ?? []),
            ...(pkg.pre_build_packages ?? []),
        ],
        scripts: [
            ...(pkg['pre-build-scripts'] ?? []),
            ...(pkg.pre_build_scripts ?? []),
        ],
    };
}

export function hasPreBuildConfig(config: PreBuildConfig): boolean {
    return config.packages.length > 0 || config.scripts.length > 0;
}

export function renderPreBuildPkgbuild(pkgname: string, config: PreBuildConfig): string {
    const helperPkgname = `preaur-prebuild-${safePkgnameSegment(pkgname)}`;
    const dependsLine = config.packages.length > 0
        ? `depends=(${config.packages.map(shellQuote).join(' ')})\n`
        : '';
    const installLine = config.scripts.length > 0
        ? 'install=preaur-prebuild.install\n'
        : '';

    return [
        `pkgname=${helperPkgname}`,
        'pkgver=1',
        'pkgrel=1',
        `pkgdesc=${shellQuote(`PreAUR pre-build helper for ${pkgname}`)}`,
        "arch=('any')",
        dependsLine.trimEnd(),
        installLine.trimEnd(),
        'package() {',
        '  :',
        '}',
        '',
    ].filter(line => line !== '').join('\n');
}

export function renderPreBuildInstall(config: PreBuildConfig): string {
    const body = config.scripts.map(script => script.trim()).filter(Boolean).join('\n\n');
    return [
        'post_install() {',
        '  set -e',
        body,
        '}',
        '',
        'post_upgrade() {',
        '  post_install "$@"',
        '}',
        '',
    ].join('\n');
}

export async function createPreBuildPackage(
    pkgname: string,
    config: PreBuildConfig,
    logStream?: WriteStream
): Promise<string | undefined> {
    if (!hasPreBuildConfig(config)) return undefined;

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `preaur-prebuild-${safePkgnameSegment(pkgname)}-`));
    await fs.writeFile(path.join(workDir, 'PKGBUILD'), renderPreBuildPkgbuild(pkgname, config), 'utf8');

    if (config.scripts.length > 0) {
        await fs.writeFile(path.join(workDir, 'preaur-prebuild.install'), renderPreBuildInstall(config), 'utf8');
    }

    console.log(`[PreBuild] Building pre-build helper package for ${pkgname} in ${workDir}...`);
    const child = exec('makepkg -df --noconfirm', { cwd: workDir });
    if (logStream && child.stdout && child.stderr) {
        child.stdout.pipe(logStream, { end: false });
        child.stderr.pipe(logStream, { end: false });
    }

    await new Promise<void>((resolve, reject) => {
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Pre-build helper package failed with exit code ${code}`));
        });
        child.on('error', reject);
    });

    const files = await fs.readdir(workDir);
    const pkgFile = files.find(f => f.endsWith('.pkg.tar.zst'));
    if (!pkgFile) {
        throw new Error(`[PreBuild] Built package not found in ${workDir}`);
    }

    return path.join(workDir, pkgFile);
}
