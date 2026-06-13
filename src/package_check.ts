import * as path from 'node:path';
import type { SimpleGit } from 'simple-git';

import type { PreaurPackage, PreaurRepo } from './config';
import type { CheckerResult } from './checker';
import { applyVersionTemplate, fetchLatestVersion } from './checker';
import { preparePackageDiff, type GitCloneResult } from './git';
import { parsePkgBuild, updateDynamicPkgver, updatePkgBuild, type PkgBuildData, type PkgBuildParser } from './pkgbuild';
import { VersionStore } from './version_store';
import { hasBuiltPackage } from './repo';
import { ensurePackageCheckWorkDirs, getPackageWorkDirs, packageWorkEnv, writePackageMakepkgConfig, type PackageWorkDirs } from './workdirs';
import { formatPacmanVersion, hasPacmanVersion, pacmanVersionChanged } from './pacman_version';
import { constructMessager } from './logger';
import pc from 'picocolors';

export interface PackageBuildPlan {
    pkg: PreaurPackage;
    pkgDir: string;
    git: SimpleGit;
    builderType: string;
    finalData: PkgBuildData;
    pkgbuildModified: boolean;
    workDirs: PackageWorkDirs;
    env: Record<string, string>;
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
        repo?: PreaurRepo;
        sessionLogDir?: string;
        deps?: PackageVersionCheckDeps;
        updateCheckCocurrent?: number;
    } = {}
): Promise<PackageVersionCheckResult> {
    const {
        baseDir = process.cwd(),
        pkgbuildParser = 'native',
        repo,
        sessionLogDir,
        deps = {},
        updateCheckCocurrent = 1
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
        }).then(result => {
            if ('skipped' in result && result.skipped && result.reason) {
                skippedPackages.push({ pkg, reason: result.reason});
            } else {
                buildPlans.push(result as PackageBuildPlan);
            }
        }).catch(e => {
            console.error(UpdateCheckerMessager(`Error processing package ${pkg.pkgname}: ${e instanceof Error ? e.message : String(e)}`));
            skippedPackages.push({ pkg, reason: `error during processing: ${e instanceof Error ? e.message : String(e)}` });
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
        repo?: PreaurRepo;
        sessionLogDir?: string;
        deps: PackageVersionCheckDeps;
    }
): Promise<PackageBuildPlan | { skipped: true; reason?: string }> {
    const {
        baseDir,
        pkgbuildParser,
        repo,
        sessionLogDir,
        deps,
    } = options;

    const prepare = deps.preparePackageDiff ?? preparePackageDiff;
    const fetchVersion = deps.fetchLatestVersion ?? fetchLatestVersion;
    const parse = deps.parsePkgBuild ?? parsePkgBuild;
    const updateDynamic = deps.updateDynamicPkgver ?? updateDynamicPkgver;
    const updatePkg = deps.updatePkgBuild ?? updatePkgBuild;
    const hasBuilt = deps.hasBuiltPackage ?? hasBuiltPackage;

    const pkgMessager = constructMessager('Update Checker', pkg.pkgname);
    const pkgbuildsBase = path.resolve(baseDir, 'pkgbuilds');
    const workDirs = getPackageWorkDirs(
        baseDir,
        pkg.pkgname,
        sessionLogDir ? path.resolve(sessionLogDir, pkg.pkgname) : undefined
    );
    await ensurePackageCheckWorkDirs(workDirs);
    await writePackageMakepkgConfig(workDirs);
    const env = packageWorkEnv(workDirs);

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

    const pkgbuildPath = path.resolve(pkgDir, 'PKGBUILD');
    await updateDynamic(pkgbuildPath, env);

    const builderType = pkg.builder || 'extra-x86_64-build';
    const pkgbuildModified = await updatePkg(pkg.pkgname, pkgbuildPath, templateUpdates, false, pkgbuildParser, env);
    const finalData = await parse(pkgbuildPath, pkgbuildParser, env);
    const localData = versionStore.get(pkg.pkgname);
    const versionChanged = pacmanVersionChanged(localData, finalData);

    if (!hasPacmanVersion(localData) && repo) {
        const alreadyBuilt = await hasBuilt(repo, pkg.pkgname, finalData, baseDir);
        if (alreadyBuilt) {
            versionStore.set(pkg.pkgname, finalData);
            await versionStore.save();
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
                return {
                    skipped: true,
                    reason: `version unchanged and artifact already exists (${formatPacmanVersion(finalData)})`,
                }
            } else {
                missingRepoArtifact = true;
            }
        } else {
            return {
                skipped: true,
                reason: `version unchanged (${formatPacmanVersion(finalData)})`,
            };
        }
    }

    if (hasPacmanVersion(localData)) {
        if (versionChanged) {
            console.log(pkgMessager(pc.green(`Update detected: ${formatPacmanVersion(localData)} -> ${formatPacmanVersion(finalData)}`)));
        } else if (missingRepoArtifact) {
            console.log(pkgMessager(pc.green(`Rebuild required: repo artifact missing for ${formatPacmanVersion(finalData)}.`)));
        }
    } else {
        console.log(pkgMessager(pc.green(`No stored successful build version; scheduling build for ${formatPacmanVersion(finalData)}.`)));
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
