import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import * as path from 'node:path';

export interface PreaurMaintainer {
    id: string;
    name: string;
    email: string;
}

export interface PreaurResources {
    cpu?: string; // e.g., "-2", "2", "--all"
    parallel?: string | number; // For concurrent package processing
}

export interface PreaurRepo {
    name: string;
}

export interface PreaurChecker {
    type: string;

    // Generic
    strip_version?: boolean;
    normalize?: boolean;
    template?: string;

    // GitHub
    repo?: string;
    use?: 'release' | 'prerelease' | string;
    prefix?: string;
    suffix?: string;

    // Deb / RPM providers
    url?: string;
    pkg?: string;
    dist?: string;
    component?: string;
    arch?: string;
}

export interface PreaurDummyPackage {
    dummy: string;
    epoch?: string | number;
    pkgver?: string | number;
    pkgrel?: string | number;
    files?: string[];
}

export interface PreaurPackage {
    pkgname: string;
    maintainer: string;
    git?: string;
    checker?: PreaurChecker;
    builder?: string; // 'pkgctl build', 'extra-x86_64-build', etc.
    push?: boolean; // Optional, push on succeed
    dummy_packages?: PreaurDummyPackage[];
    repo_packages?: string[]; // Packages that must be built before this package
}

export interface PreaurConfig {
    maintainers: PreaurMaintainer[];
    resources?: PreaurResources;
    repo?: PreaurRepo;
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

        return config;
    } catch (error: any) {
        throw new Error(`Failed to load config from ${configPath}: ${error.message}`);
    }
}
