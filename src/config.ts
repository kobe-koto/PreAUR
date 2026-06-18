import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import * as path from 'node:path';
import type { PkgBuildParser } from './pkgbuild';

export interface PreaurMaintainer {
    id: string;
    name: string;
    email: string;
}

export interface PreaurResources {
    cpu?: string; // e.g., "-2", "2", "--all"
    parallel: number; // For concurrent package processing, at least 1, by default 2
    updateCheckCocurrent: number; // Number of concurrent version checks, at least/by default 1
}

export interface PreaurRepo {
    name: string;
}

export interface PreaurRuntimeConfig {
    pkgbuildParser?: PkgBuildParser;
    trustedAurGitPrefixes?: string[];
    chrootPacman?: PreaurChrootPacmanConfig;
}

export interface PreaurProjectGitSyncConfig {
    allowRemoteOverwriteLocal?: boolean;
    allow_remote_overwrite_local?: boolean;
}

export interface PreaurProjectGitPushConfig {
    force?: boolean;
}

export interface PreaurProjectGitConfig {
    enabled?: boolean;
    remote?: string;
    branch?: string;
    sync?: PreaurProjectGitSyncConfig;
    push?: PreaurProjectGitPushConfig;
}

export interface PreaurChrootPacmanRepository {
    name: string;
    siglevel?: string | string[];
    include?: string[];
    lines?: string[];
}

export interface PreaurChrootPacmanConfig {
    include?: string[];
    lines?: string[];
    repositories?: PreaurChrootPacmanRepository[];
}

export interface PreaurCheckerBase {
    strip_version?: boolean;
    normalize?: boolean;
    template?: string;
}

export interface PreaurGitHubChecker extends PreaurCheckerBase {
    type: 'github';
    repo: string;
    use?: 'release' | 'prerelease' | string;
    prefix?: string;
    suffix?: string;
}

export interface PreaurDebChecker extends PreaurCheckerBase {
    type: 'deb';
    url: string;
    pkg: string;
    dist: string;
    component: string;
    arch?: string;
}

export interface PreaurRpmChecker extends PreaurCheckerBase {
    type: 'rpm';
    url: string;
    pkg: string;
}

export type PreaurChecker = PreaurGitHubChecker | PreaurDebChecker | PreaurRpmChecker;

export interface PreaurDummyPackage {
    dummy: string;
    epoch?: string | number;
    pkgver?: string | number;
    pkgrel?: string | number;
    files?: string[];
}

export interface PreaurPackage {
    pkgname: string;
    maintainer?: string;
    allow_orphan_package_build?: boolean;
    aur_pkgname?: string;
    git?: string;
    checker?: PreaurChecker;
    builder?: string; // 'pkgctl build', 'extra-x86_64-build', etc.
    push?: boolean; // Optional, push on succeed
    dummy_packages?: PreaurDummyPackage[];
    repo_packages?: string[]; // Packages that must be built before this package
    'pre-build-packages'?: string[];
    'pre-build-scripts'?: string[];
    pre_build_packages?: string[];
    pre_build_scripts?: string[];
}

export interface PreaurConfig {
    maintainers: PreaurMaintainer[];
    default_maintainer?: string;
    git?: PreaurProjectGitConfig;
    config?: PreaurRuntimeConfig;
    resources: PreaurResources;
    repo: PreaurRepo;
    packages: PreaurPackage[];
}

export async function loadConfig(configPath: string): Promise<PreaurConfig> {
    try {
        const resolvedConfigPath = path.resolve(configPath);
        const configDir = path.dirname(resolvedConfigPath);
        const fileContents = await readFile(resolvedConfigPath, 'utf8');
        const config = parse(fileContents);

        // Basic validation
        if (!config.maintainers || !Array.isArray(config.maintainers)) {
            throw new Error('Config missing or invalid maintainers array');
        }
        if (!config.packages || !Array.isArray(config.packages)) {
            throw new Error('Config missing or invalid packages array');
        }

        if (config.config?.pkgbuildParser && !['native', 'makepkg'].includes(config.config.pkgbuildParser)) {
            throw new Error('Config config.pkgbuildParser must be either "native" or "makepkg"');
        }
        if (config.config?.trustedAurGitPrefixes && !Array.isArray(config.config.trustedAurGitPrefixes)) {
            throw new Error('Config config.trustedAurGitPrefixes must be an array');
        }
        normalizeChrootPacmanConfig(config.config?.chrootPacman, configDir);
        config.git ??= {};
        normalizeProjectGitConfig(config.git);

        const maintainerIds = new Set(config.maintainers.map((m: PreaurMaintainer) => m.id));
        if (config.default_maintainer && !maintainerIds.has(config.default_maintainer)) {
            throw new Error(`Config default_maintainer references unknown maintainer: ${config.default_maintainer}`);
        }

        for (const pkg of config.packages) {
            if (!pkg.maintainer) {
                if (!config.default_maintainer) {
                    throw new Error(`Package ${pkg.pkgname} missing maintainer and config default_maintainer is not set`);
                }
                pkg.maintainer = config.default_maintainer;
            }

            if (!maintainerIds.has(pkg.maintainer)) {
                throw new Error(`Package ${pkg.pkgname} references unknown maintainer: ${pkg.maintainer}`);
            }
            validateStringArray(pkg['pre-build-packages'], `Package ${pkg.pkgname} pre-build-packages`);
            validateStringArray(pkg['pre-build-scripts'], `Package ${pkg.pkgname} pre-build-scripts`);
            validateStringArray(pkg.pre_build_packages, `Package ${pkg.pkgname} pre_build_packages`);
            validateStringArray(pkg.pre_build_scripts, `Package ${pkg.pkgname} pre_build_scripts`);
        }

        config.resources ??= {};
        config.resources.parallel = Math.max(1, +config.resources.parallel || 2)
        config.resources.updateCheckCocurrent = Math.max(1, +config.resources.updateCheckCocurrent || 1);
        // have use an exclamation mark to make ts happy... 
        // undefined would be converted to NaN which would fallback to 1 which is expected

        return config as PreaurConfig;
    } catch (error: any) {
        throw new Error(`Failed to load config from ${configPath}: ${error.message}`);
    }
}

function normalizeProjectGitConfig(value: Partial<PreaurProjectGitConfig> | undefined): void {
    const gitConfig = value ?? {};
    if (typeof gitConfig !== 'object' || Array.isArray(gitConfig)) {
        throw new Error('Config git must be an object');
    }

    if (gitConfig.enabled !== undefined && typeof gitConfig.enabled !== 'boolean') {
        throw new Error('Config git.enabled must be a boolean');
    }
    if (gitConfig.remote !== undefined && typeof gitConfig.remote !== 'string') {
        throw new Error('Config git.remote must be a string');
    }
    if (gitConfig.branch !== undefined && typeof gitConfig.branch !== 'string') {
        throw new Error('Config git.branch must be a string');
    }

    gitConfig.enabled ??= true;
    gitConfig.remote ??= 'origin';
    gitConfig.sync ??= {};
    gitConfig.push ??= {};

    if (typeof gitConfig.sync !== 'object' || Array.isArray(gitConfig.sync)) {
        throw new Error('Config git.sync must be an object');
    }
    if (typeof gitConfig.push !== 'object' || Array.isArray(gitConfig.push)) {
        throw new Error('Config git.push must be an object');
    }

    if (gitConfig.sync.allowRemoteOverwriteLocal !== undefined && typeof gitConfig.sync.allowRemoteOverwriteLocal !== 'boolean') {
        throw new Error('Config git.sync.allowRemoteOverwriteLocal must be a boolean');
    }
    if (gitConfig.sync.allow_remote_overwrite_local !== undefined && typeof gitConfig.sync.allow_remote_overwrite_local !== 'boolean') {
        throw new Error('Config git.sync.allow_remote_overwrite_local must be a boolean');
    }
    if (gitConfig.push.force !== undefined && typeof gitConfig.push.force !== 'boolean') {
        throw new Error('Config git.push.force must be a boolean');
    }
}

function validateStringArray(value: unknown, context: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        throw new Error(`${context} must be an array of strings`);
    }

    return value;
}

function normalizeIncludePaths(paths: unknown, configDir: string, context: string): string[] | undefined {
    if (paths === undefined) return undefined;
    if (!Array.isArray(paths) || paths.some(item => typeof item !== 'string')) {
        throw new Error(`Config ${context} must be an array of strings`);
    }

    return paths.map(item => path.isAbsolute(item) ? item : path.resolve(configDir, item));
}

function validateRawLines(lines: unknown, context: string): string[] | undefined {
    if (lines === undefined) return undefined;
    if (!Array.isArray(lines) || lines.some(item => typeof item !== 'string')) {
        throw new Error(`Config ${context} must be an array of strings`);
    }

    return lines;
}

function normalizeChrootPacmanConfig(value: PreaurChrootPacmanConfig | undefined, configDir: string): void {
    if (value === undefined) return;
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Config config.chrootPacman must be an object');
    }

    value.include = normalizeIncludePaths(value.include, configDir, 'config.chrootPacman.include');
    value.lines = validateRawLines(value.lines, 'config.chrootPacman.lines');

    if (value.repositories === undefined) return;
    if (!Array.isArray(value.repositories)) {
        throw new Error('Config config.chrootPacman.repositories must be an array');
    }

    for (const repo of value.repositories) {
        if (!repo || typeof repo !== 'object' || Array.isArray(repo)) {
            throw new Error('Config config.chrootPacman.repositories entries must be objects');
        }
        if (!repo.name || typeof repo.name !== 'string') {
            throw new Error('Config config.chrootPacman.repositories[].name must be a string');
        }
        if (repo.siglevel !== undefined && typeof repo.siglevel !== 'string' && !Array.isArray(repo.siglevel)) {
            throw new Error('Config config.chrootPacman.repositories[].siglevel must be a string or array of strings');
        }
        if (Array.isArray(repo.siglevel) && repo.siglevel.some(item => typeof item !== 'string')) {
            throw new Error('Config config.chrootPacman.repositories[].siglevel must be a string or array of strings');
        }

        repo.include = normalizeIncludePaths(repo.include, configDir, `config.chrootPacman.repositories[${repo.name}].include`);
        repo.lines = validateRawLines(repo.lines, `config.chrootPacman.repositories[${repo.name}].lines`);
    }
}
