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
    parallel?: string | number; // For concurrent package processing
    updateCheckCocurrent: number; // Number of concurrent version checks, at least/by default 1
}

export interface PreaurRepo {
    name: string;
}

export interface PreaurRuntimeConfig {
    pkgbuildParser?: PkgBuildParser;
    trustedAurGitPrefixes?: string[];
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
}

export interface PreaurConfig {
    maintainers: PreaurMaintainer[];
    default_maintainer?: string;
    config?: PreaurRuntimeConfig;
    resources: PreaurResources;
    repo: PreaurRepo;
    packages: PreaurPackage[];
}

export async function loadConfig(configPath: string): Promise<PreaurConfig> {
    try {
        const fileContents = await readFile(path.resolve(configPath), 'utf8');
        const config = parse(fileContents) as PreaurConfig;

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

        const maintainerIds = new Set(config.maintainers.map(m => m.id));
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
        }

        config.resources ??= {};
        config.resources.updateCheckCocurrent = Math.max(1, +config.resources.updateCheckCocurrent || 1);
        // have use an exclamation mark to make ts happy... 
        // undefined would be converted to NaN which would fallback to 1 which is expected

        return config;
    } catch (error: any) {
        throw new Error(`Failed to load config from ${configPath}: ${error.message}`);
    }
}
