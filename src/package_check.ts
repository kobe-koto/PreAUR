import * as path from 'node:path';
import type { SimpleGit } from 'simple-git';

import type { PreaurPackage, PreaurPkgbuildSandboxConfig, PreaurRepo } from './config';
import type { EnvPairs } from './env';
import type { CheckerResult } from './checker';
import { applyVersionTemplate, fetchLatestVersion } from './checker';
import { preparePackageDiff, type GitCloneResult } from './git';
import { parsePkgBuild, updateDynamicPkgver, updatePkgBuild, type PkgBuildData, type PkgBuildParser } from './pkgbuild';
import { VersionStore } from './version_store';
import { hasBuiltPackage } from './repo';
import { ensurePackageCheckWorkDirs, getPackageWorkDirs, packageWorkEnvPairs, type PackageWorkDirs } from './workdirs';
import { formatPacmanVersion, hasPacmanVersion, pacmanVersionChanged } from './pacman_version';
import { constructMessager } from './logger';
import { saveVersionStoreUpdate, type ProjectGitManager } from './project_git';
import type { WebhookNotifier } from './webhook';
import {
    parsePkgBuildInSandbox,
    resolvePkgbuildSandboxOptions,
    updateDynamicPkgverInSandbox,
    updatePkgBuildInSandbox,
} from './pkgbuild_sandbox';
import pc from 'picocolors';

export interface PackageBuildPlan {
    pkg: PreaurPackage;
    pkgDir: string;
    git: SimpleGit;
    builderType: string;
    finalData: PkgBuildData;
    pkgbuildModified: boolean;
    workDirs: PackageWorkDirs;
    env: EnvPairs;
}

export interface PackageVersionCheckResult {
    buildPlans: PackageBuildPlan[];
    skippedPackages: Array<{ pkg: PreaurPackage; reason: string }>;
}

export interface PackageVersionCheckDeps {
    preparePackageDiff?: typeof preparePackageDiff;
    fetchLatestVersion?: typeof fetchLatestVersion;
    parsePkgBuild?: typeof parsePkgBuild;
    updateDynamicPkgver?: typeof updateDynamicPkgver;
    updatePkgBuild?: typeof updatePkgBuild;
    hasBuiltPackage?: typeof hasBuiltPackage;
}

const UpdateCheckerMessager = constructMessager('Update Checker');

function resolveTemplateUpdates(pkg: PreaurPackage, checkerRes: CheckerResult, pkgMessager: (msg: string) => string): Record<string, string> {
    if (pkg.checker?.template) {
        const tplResult = applyVersionTemplate(pkg.checker.template, checkerRes.version);
        if (tplResult) {
            console.log(pkgMessager(`Template override applied: ${JSON.stringify(tplResult)}`));
            return checkerRes.epoch ? { ...tplResult, epoch: checkerRes.epoch } : tplResult;
        }

        console.warn(pkgMessager(`Template parsing failed for ${checkerRes.version}`));
    }

    return checkerRes.epoch
        ? { pkgver: checkerRes.version, epoch: checkerRes.epoch }
        : { pkgver: checkerRes.version };
}

export async function runPackageVersionCheck(
    packages: PreaurPackage[],
    versionStore: VersionStore,
    options: {
        baseDir?: string;
        pkgbuildParser?: PkgBuildParser;
        repo?: Pick<PreaurRepo, 'name'>;
        sessionLogDir?: string;
        deps?: PackageVersionCheckDeps;
        updateCheckCocurrent?: number;
        projectGit?: ProjectGitManager;
        pkgbuildSandbox?: PreaurPkgbuildSandboxConfig;
        webhook?: WebhookNotifier;
    } = {}
): Promise<PackageVersionCheckResult> {
    const {
        baseDir = process.cwd(),
        pkgbuildParser = 'native',
        repo,
        sessionLogDir,
        deps = {},
        updateCheckCocurrent = 1,
        projectGit,
        pkgbuildSandbox,
        webhook,
    } = options;

    console.log(UpdateCheckerMessager(`Checking package versions for ${packages.length} package(s) with concurrency of ${updateCheckCocurrent}...`));

    const buildPlans: PackageBuildPlan[] = [];
    const skippedPackages: PackageVersionCheckResult['skippedPackages'] = [];

    // generate all tasks first to enable concurrent processing, especially for version checks which may involve network requests
    const tasks = packages.map(pkg => async () => {
        await processPackageVersionCheck(pkg, versionStore, {
            baseDir,
            pkgbuildParser,
            repo,
            sessionLogDir,
            deps,
            projectGit,
            pkgbuildSandbox,
            webhook,
        }).then(result => {
            if ('skipped' in result && result.skipped && result.reason) {
                console.log(UpdateCheckerMessager(`Package ${pkg.pkgname} skipped, reason: ${result.reason}`))
                skippedPackages.push({ pkg, reason: result.reason});
            } else {
                buildPlans.push(result as PackageBuildPlan);
            }
        }).catch(async e => {
            const message = e instanceof Error ? e.message : String(e);
            console.error(UpdateCheckerMessager(`Error processing package ${pkg.pkgname}: ${message}`));
            skippedPackages.push({ pkg, reason: `error during processing: ${message}` });
            await webhook?.notify('PACKAGE_CHECK_FAILED', { pkgname: pkg.pkgname, error: message });
        });
    });

    await limitConcurrency(tasks, updateCheckCocurrent);

    return { buildPlans, skippedPackages };
}

async function processPackageVersionCheck(
    pkg: PreaurPackage,
    versionStore: VersionStore,
    options: {
        baseDir: string;
        pkgbuildParser: PkgBuildParser;
        repo?: Pick<PreaurRepo, 'name'>;
        sessionLogDir?: string;
        deps: PackageVersionCheckDeps;
        projectGit?: ProjectGitManager;
        pkgbuildSandbox?: PreaurPkgbuildSandboxConfig;
        webhook?: WebhookNotifier;
    }
): Promise<PackageBuildPlan | { skipped: true; reason?: string }> {
    const {
        baseDir,
        pkgbuildParser,
        repo,
        sessionLogDir,
        deps,
        projectGit,
        pkgbuildSandbox,
        webhook,
    } = options;

    const prepare = deps.preparePackageDiff ?? preparePackageDiff;
    const fetchVersion = deps.fetchLatestVersion ?? fetchLatestVersion;
    const hasBuilt = deps.hasBuiltPackage ?? hasBuiltPackage;

    const pkgMessager = constructMessager('Update Checker', pkg.pkgname);
    const pkgbuildsBase = path.resolve(baseDir, 'pkgbuilds');
    const workDirs = getPackageWorkDirs(
        baseDir,
        pkg.pkgname,
        sessionLogDir ? path.resolve(sessionLogDir, pkg.pkgname) : undefined
    );
    await ensurePackageCheckWorkDirs(workDirs);
    const env = packageWorkEnvPairs(workDirs);

    const { path: pkgDir, git }: GitCloneResult = await prepare(
        pkg.pkgname,
        pkg.git,
        !!pkg.push,
        pkgbuildsBase
    );

    let templateUpdates: Record<string, string> = {};
    if (pkg.checker) {
        const checkerRes = await fetchVersion(pkg.checker);
        if (checkerRes) {
            templateUpdates = resolveTemplateUpdates(pkg, checkerRes, pkgMessager);
        } else {
            console.warn(pkgMessager(pc.yellow(`Could not ascertain latest version from ${pkg.checker.type}.`)));
            console.debug(pkgMessager(pc.gray(`Original reponse: ${JSON.stringify(checkerRes)}`)));
        }
    }

    const builderType = pkg.builder || 'extra-x86_64-build';
    const sandbox = deps.parsePkgBuild || deps.updateDynamicPkgver || deps.updatePkgBuild
        ? undefined
        : resolvePkgbuildSandboxOptions({ config: pkgbuildSandbox, builder: builderType, workDirs });
    const parse = deps.parsePkgBuild
        ?? (sandbox
            ? ((pkgbuildPath: string, parser: PkgBuildParser = 'native', env?: EnvPairs) => parsePkgBuildInSandbox(pkgbuildPath, parser, env, sandbox, workDirs))
            : parsePkgBuild);
    const updateDynamic = deps.updateDynamicPkgver
        ?? (sandbox
            ? ((pkgbuildPath: string, env?: EnvPairs) => updateDynamicPkgverInSandbox(pkgbuildPath, env, sandbox, workDirs))
            : updateDynamicPkgver);
    const updatePkg = deps.updatePkgBuild
        ?? (sandbox
            ? ((
                pkgname: string,
                pkgbuildPath: string,
                updates: Record<string, string>,
                forceBumpRel: boolean = false,
                parser: PkgBuildParser = 'native',
                env?: EnvPairs
            ) => updatePkgBuildInSandbox(pkgname, pkgbuildPath, updates, forceBumpRel, parser, env, sandbox, workDirs))
            : updatePkgBuild);

    const pkgbuildPath = path.resolve(pkgDir, 'PKGBUILD');
    await updateDynamic(pkgbuildPath, env);

    const pkgbuildModified = await updatePkg(pkg.pkgname, pkgbuildPath, templateUpdates, false, pkgbuildParser, env);
    const finalData = await parse(pkgbuildPath, pkgbuildParser, env);
    const localData = versionStore.get(pkg.pkgname);
    const versionChanged = pacmanVersionChanged(localData, finalData);

    if (!hasPacmanVersion(localData) && repo) {
        const alreadyBuilt = await hasBuilt(repo, pkg.pkgname, finalData, baseDir);
        if (alreadyBuilt) {
            await saveVersionStoreUpdate(versionStore, pkg.pkgname, finalData, projectGit);
            await webhook?.notify('PACKAGE_NO_UPDATE', {
                pkgname: pkg.pkgname,
                version: formatPacmanVersion(finalData),
                reason: 'no stored successful build version but artifact already exists; synced version store',
            });
            return {
                skipped: true,
                reason: `no stored successful build version but artifact already exists; synced version store (${formatPacmanVersion(finalData)})`,
            };
        }
    }

    let missingRepoArtifact = false;
    if (!versionChanged) { // version unchanged
        if (repo) {
            const alreadyBuilt = await hasBuilt(repo, pkg.pkgname, finalData, baseDir);
            if (alreadyBuilt) {
                await webhook?.notify('PACKAGE_NO_UPDATE', {
                    pkgname: pkg.pkgname,
                    version: formatPacmanVersion(finalData),
                    reason: 'version unchanged and artifact already exists',
                });
                return {
                    skipped: true,
                    reason: `version unchanged and artifact already exists (${formatPacmanVersion(finalData)})`,
                }
            } else {
                missingRepoArtifact = true;
            }
        } else {
            await webhook?.notify('PACKAGE_NO_UPDATE', {
                pkgname: pkg.pkgname,
                version: formatPacmanVersion(finalData),
                reason: 'version unchanged',
            });
            return {
                skipped: true,
                reason: `version unchanged (${formatPacmanVersion(finalData)})`,
            };
        }
    }

    if (hasPacmanVersion(localData)) {
        if (versionChanged) {
            console.log(pkgMessager(pc.green(`Update detected: ${formatPacmanVersion(localData)} -> ${formatPacmanVersion(finalData)}`)));
            await webhook?.notify('PACKAGE_UPDATED', {
                pkgname: pkg.pkgname,
                version: formatPacmanVersion(finalData),
                pkgver: finalData.pkgver,
                pkgrel: String(finalData.pkgrel),
                epoch: finalData.epoch ? String(finalData.epoch) : undefined,
            });
        } else if (missingRepoArtifact) {
            console.log(pkgMessager(pc.green(`Rebuild required: repo artifact missing for ${formatPacmanVersion(finalData)}.`)));
        }
    } else {
        console.log(pkgMessager(pc.green(`No stored successful build version; scheduling build for ${formatPacmanVersion(finalData)}.`)));
        await webhook?.notify('PACKAGE_UPDATED', {
            pkgname: pkg.pkgname,
            version: formatPacmanVersion(finalData),
            pkgver: finalData.pkgver,
            pkgrel: String(finalData.pkgrel),
            epoch: finalData.epoch ? String(finalData.epoch) : undefined,
        });
    }

    return {
        pkg,
        pkgDir,
        git,
        builderType,
        finalData,
        pkgbuildModified,
        workDirs,
        env,
    };
}


async function limitConcurrency(tasks: (() => Promise<void>)[], limit: number) {
  const iterator = tasks.entries();
  
  async function doWork() {
    for (const [index, task] of iterator) {
      await task();
    }
  }

  const workers = Array(Math.min(limit, tasks.length))
    .fill(null)
    .map(() => doWork());

  await Promise.all(workers);
}
