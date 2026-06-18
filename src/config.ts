import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import * as path from 'node:path';
import { z } from 'zod';

import {
    PreaurRawConfigSchema,
    type PreaurChrootPacmanConfig,
    type PreaurChrootPacmanRepository,
    type PreaurChecker,
    type PreaurDebChecker,
    type PreaurDummyPackage,
    type PreaurGitHubChecker,
    type PreaurMaintainer,
    type PreaurPackage,
    type PreaurProjectGitConfig,
    type PreaurProjectGitPushConfig,
    type PreaurProjectGitSyncConfig,
    type PreaurRawConfig,
    type PreaurRepo,
    type PreaurResources,
    type PreaurRpmChecker,
    type PreaurRuntimeConfig,
} from './config_schema';

export type {
    PreaurChrootPacmanConfig,
    PreaurChrootPacmanRepository,
    PreaurChecker,
    PreaurDebChecker,
    PreaurDummyPackage,
    PreaurGitHubChecker,
    PreaurMaintainer,
    PreaurPackage,
    PreaurProjectGitConfig,
    PreaurProjectGitPushConfig,
    PreaurProjectGitSyncConfig,
    PreaurRepo,
    PreaurResources,
    PreaurRpmChecker,
    PreaurRuntimeConfig,
};

export type LoadedPreaurPackage = PreaurPackage & { maintainer: string };

export interface PreaurConfig extends Omit<PreaurRawConfig, 'packages' | 'git' | 'resources'> {
    git: PreaurProjectGitConfig;
    resources: PreaurResources;
    packages: LoadedPreaurPackage[];
}

export async function loadConfig(configPath: string): Promise<PreaurConfig> {
    try {
        const resolvedConfigPath = path.resolve(configPath);
        const configDir = path.dirname(resolvedConfigPath);
        const fileContents = await readFile(resolvedConfigPath, 'utf8');
        const parsed = PreaurRawConfigSchema.parse(parse(fileContents));

        return normalizeConfig(parsed, configDir);
    } catch (error: any) {
        const message = error instanceof z.ZodError
            ? z.prettifyError(error)
            : error.message;
        throw new Error(`Failed to load config from ${configPath}: ${message}`);
    }
}

function normalizeConfig(config: PreaurRawConfig, configDir: string): PreaurConfig {
    const maintainerIds = new Set(config.maintainers.map(maintainer => maintainer.id));
    if (config.default_maintainer && !maintainerIds.has(config.default_maintainer)) {
        throw new Error(`Config default_maintainer references unknown maintainer: ${config.default_maintainer}`);
    }

    normalizeChrootPacmanConfig(config.config?.chrootPacman, configDir);
    normalizeProjectGitConfig(config.git);

    const packages = config.packages.map(pkg => normalizePackage(pkg, config.default_maintainer, maintainerIds));

    return {
        ...config,
        packages,
    };
}

function normalizePackage(
    pkg: PreaurPackage,
    defaultMaintainer: string | undefined,
    maintainerIds: Set<string>
): LoadedPreaurPackage {
    const maintainer = pkg.maintainer ?? defaultMaintainer;
    if (!maintainer) {
        throw new Error(`Package ${pkg.pkgname} missing maintainer and config default_maintainer is not set`);
    }
    if (!maintainerIds.has(maintainer)) {
        throw new Error(`Package ${pkg.pkgname} references unknown maintainer: ${maintainer}`);
    }

    return {
        ...pkg,
        maintainer,
    };
}

function normalizeProjectGitConfig(value: PreaurProjectGitConfig): void {
    value.sync.allow_remote_overwrite_local = value.sync.allow_remote_overwrite_local
        || value.sync.allowRemoteOverwriteLocal
        || false;
    delete value.sync.allowRemoteOverwriteLocal;
}

function normalizeIncludePaths(paths: string[] | undefined, configDir: string): string[] | undefined {
    return paths?.map(item => path.isAbsolute(item) ? item : path.resolve(configDir, item));
}

function normalizeChrootPacmanConfig(value: PreaurChrootPacmanConfig | undefined, configDir: string): void {
    if (!value) return;

    value.include = normalizeIncludePaths(value.include, configDir);

    for (const repo of value.repositories ?? []) {
        normalizeChrootPacmanRepository(repo, configDir);
    }
}

function normalizeChrootPacmanRepository(repo: PreaurChrootPacmanRepository, configDir: string): void {
    repo.include = normalizeIncludePaths(repo.include, configDir);
}
