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

function resolveTemplateUpdates(pkg: PreaurPackage, checkerRes: CheckerResult): Record<string, string> {
    if (pkg.checker?.template) {
        const tplResult = applyVersionTemplate(pkg.checker.template, checkerRes.version);
        if (tplResult) {
            console.log(`[Checker] Template override applied: ${JSON.stringify(tplResult)}`);
            return checkerRes.epoch ? { ...tplResult, epoch: checkerRes.epoch } : tplResult;
        }

        console.warn(`[Checker] Template parsing failed for ${checkerRes.version}`);
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
    } = {}
): Promise<PackageVersionCheckResult> {
    const {
        baseDir = process.cwd(),
        pkgbuildParser = 'native',
        repo,
        sessionLogDir,
        deps = {},
    } = options;

    const prepare = deps.preparePackageDiff ?? preparePackageDiff;
    const fetchVersion = deps.fetchLatestVersion ?? fetchLatestVersion;
    const parse = deps.parsePkgBuild ?? parsePkgBuild;
    const updateDynamic = deps.updateDynamicPkgver ?? updateDynamicPkgver;
    const updatePkg = deps.updatePkgBuild ?? updatePkgBuild;
    const hasBuilt = deps.hasBuiltPackage ?? hasBuiltPackage;

    console.log(`[Check] Checking package versions for ${packages.length} package(s)...`);

    const buildPlans: PackageBuildPlan[] = [];
    const skippedPackages: PackageVersionCheckResult['skippedPackages'] = [];

    for (const pkg of packages) {
        console.log(``);
        console.log(`[Check] [${pkg.pkgname}] Preparing version check...`);

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
            console.log(`[Checker] [${pkg.pkgname}] Checking version using ${pkg.checker.type} provider...`);
            const checkerRes = await fetchVersion(pkg.checker);
            if (checkerRes) {
                console.log(`[Checker] [${pkg.pkgname}] The latest version is v${checkerRes.version}${checkerRes.epoch ? ` (epoch: ${checkerRes.epoch})` : ''}`);
                templateUpdates = resolveTemplateUpdates(pkg, checkerRes);
            } else {
                console.log(`[Checker] [${pkg.pkgname}] Could not ascertain latest version.`);
            }
        }

        const pkgbuildPath = path.resolve(pkgDir, 'PKGBUILD');
        await updateDynamic(pkgbuildPath, env);

        const builderType = pkg.builder || 'extra-x86_64-build';
        const pkgbuildModified = await updatePkg(pkgbuildPath, templateUpdates, false, pkgbuildParser, env);
        const finalData = await parse(pkgbuildPath, pkgbuildParser, env);
        const localData = versionStore.get(pkg.pkgname);
        const versionChanged = pacmanVersionChanged(localData, finalData);
        let missingRepoArtifact = false;

        console.log(`[Check] [${pkg.pkgname}] Checking version...`);
        if (!versionChanged) {
            if (repo) {
                const alreadyBuilt = await hasBuilt(repo, pkg.pkgname, finalData, baseDir);
                if (alreadyBuilt) {
                    skippedPackages.push({
                        pkg,
                        reason: `version unchanged and artifact already exists (${formatPacmanVersion(finalData)})`,
                    });
                    console.log(`[Check] [${pkg.pkgname}] Skipping: version unchanged and artifact already exists (${formatPacmanVersion(finalData)}).`);
                    continue;
                }

                console.log(`[Check] [${pkg.pkgname}] version is unchanged (${formatPacmanVersion(finalData)}), but no matching repo artifact exists; scheduling build.`);
                missingRepoArtifact = true;
            } else {
                skippedPackages.push({
                    pkg,
                    reason: `version unchanged (${formatPacmanVersion(finalData)})`,
                });
                console.log(`[Check] [${pkg.pkgname}] Skipping: version unchanged (${formatPacmanVersion(finalData)}).`);
                continue;
            }
        }

        if (hasPacmanVersion(localData)) {
            if (versionChanged) {
                console.log(`[Check] [${pkg.pkgname}] Update detected: ${formatPacmanVersion(localData)} -> ${formatPacmanVersion(finalData)}`);
            } else if (missingRepoArtifact) {
                console.log(`[Check] [${pkg.pkgname}] Rebuild required: repo artifact missing for ${formatPacmanVersion(finalData)}.`);
            }
        } else {
            console.log(`[Check] [${pkg.pkgname}] No stored successful build version; scheduling build for ${formatPacmanVersion(finalData)}.`);
        }

        buildPlans.push({
            pkg,
            pkgDir,
            git,
            builderType,
            finalData,
            pkgbuildModified,
            workDirs,
            env,
        });
    }

    return { buildPlans, skippedPackages };
}
