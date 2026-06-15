import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PreaurChrootPacmanConfig, PreaurChrootPacmanRepository } from './config';

const DEVTOOLS_DIR = '/usr/share/devtools';

function safePathSegment(value: string): string {
    return value.replace(/[\/\\\s]+/g, '_');
}

export function hasChrootPacmanConfig(config?: PreaurChrootPacmanConfig): boolean {
    return !!(
        config
        && (
            (config.include?.length ?? 0) > 0
            || (config.lines?.length ?? 0) > 0
            || (config.repositories?.length ?? 0) > 0
        )
    );
}

export function resolveDevtoolsBuildTarget(builderCmd: string): { repo: string; arch: string } | undefined {
    const cmd = path.basename(builderCmd);
    if (!cmd.endsWith('-build')) return undefined;

    const tag = cmd.slice(0, -'-build'.length);
    if (tag === 'multilib') {
        return { repo: 'multilib', arch: 'x86_64' };
    }

    const archSeparator = tag.lastIndexOf('-');
    if (archSeparator <= 0 || archSeparator === tag.length - 1) return undefined;

    return {
        repo: tag.slice(0, archSeparator),
        arch: tag.slice(archSeparator + 1),
    };
}

async function resolveBasePacmanConfig(builderCmd: string, devtoolsDir: string): Promise<string> {
    const target = resolveDevtoolsBuildTarget(builderCmd);
    if (!target) {
        throw new Error(`Cannot determine devtools repository and architecture from builder: ${builderCmd}`);
    }

    const pacmanConfigDir = path.join(devtoolsDir, 'pacman.conf.d');
    const archConfig = path.join(pacmanConfigDir, `${target.repo}-${target.arch}.conf`);
    try {
        await fs.access(archConfig);
        return archConfig;
    } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
    }

    return path.join(pacmanConfigDir, `${target.repo}.conf`);
}

function renderRawLines(lines: string[] | undefined): string[] {
    return lines?.length ? lines : [];
}

async function renderHostIncludes(include: string[] | undefined): Promise<string[]> {
    if (!include?.length) return [];

    const lines: string[] = [];
    for (const includePath of include) {
        const content = await fs.readFile(includePath, 'utf8');
        lines.push('', `# PreAUR host include: ${includePath}`, content.trimEnd());
    }

    return lines;
}

async function renderRepository(repo: PreaurChrootPacmanRepository): Promise<string[]> {
    const lines = ['', `[${repo.name}]`];
    if (repo.siglevel !== undefined) {
        const siglevel = Array.isArray(repo.siglevel) ? repo.siglevel.join(' ') : repo.siglevel;
        lines.push(`SigLevel = ${siglevel}`);
    }

    lines.push(...await renderHostIncludes(repo.include));
    lines.push(...renderRawLines(repo.lines));
    return lines;
}

export async function writeChrootPacmanConfig(options: {
    builderCmd: string;
    config: PreaurChrootPacmanConfig;
    baseDir: string;
    devtoolsDir?: string;
}): Promise<string> {
    const devtoolsDir = options.devtoolsDir ?? DEVTOOLS_DIR;
    const baseConfigPath = await resolveBasePacmanConfig(options.builderCmd, devtoolsDir);
    const baseConfig = await fs.readFile(baseConfigPath, 'utf8');
    const outputDir = path.resolve(options.baseDir, 'work', 'chroot-pacman', safePathSegment(path.basename(options.builderCmd)));
    const outputPath = path.join(outputDir, 'pacman.conf');

    const lines = [
        baseConfig.trimEnd(),
        '',
        '# PreAUR chroot pacman additions',
        ...await renderHostIncludes(options.config.include),
        ...renderRawLines(options.config.lines),
    ];

    for (const repo of options.config.repositories ?? []) {
        lines.push(...await renderRepository(repo));
    }

    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
    return outputPath;
}
