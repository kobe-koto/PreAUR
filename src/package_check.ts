import * as path from 'node:path';
import type { SimpleGit } from 'simple-git';

import type { PreaurPackage, PreaurRepo } from './config';
import type { CheckerResult } from './checker';
import { applyVersionTemplate, fetchLatestVersion } from './checker';
import { preparePackageDiff, type GitCloneResult } from './git';
import { parsePkgBuild, updateDynamicPkgver, updatePkgBuild, type PkgBuildData, type PkgBuildParser } from './pkgbuild';
import { VersionStore } from './version_store';
import { hasBuiltPackage } from './repo';

export interface PackageBuildPlan {
    pkg: PreaurPackage;
    pkgDir: string;
    git: SimpleGit;
    builderType: string;
    finalData: PkgBuildData;
    pkgbuildModified: boolean;
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

function hasStoredVersion(info: ReturnType<VersionStore['get']>): boolean {
    return !!info?.pkgver && info.pkgrel !== undefined;
}

function versionChanged(current: ReturnType<VersionStore['get']>, next: PkgBuildData): boolean {
    if (!hasStoredVersion(current)) return true;

    const stored = current!;
    return next.epoch !== stored.epoch
        || next.pkgver !== stored.pkgver
        || next.pkgrel !== stored.pkgrel;
}

function formatVersion(data: { epoch?: string; pkgver: string; pkgrel: number }): string {
    return `${data.epoch ? `${data.epoch}:` : ''}${data.pkgver}-${data.pkgrel}`;
}

function formatStoredVersion(data: NonNullable<ReturnType<VersionStore['get']>>): string {
    return `${data.epoch ? `${data.epoch}:` : ''}${data.pkgver!}-${data.pkgrel!}`;
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
        deps?: PackageVersionCheckDeps;
    } = {}
): Promise<PackageVersionCheckResult> {
    const {
        baseDir = process.cwd(),
        pkgbuildParser = 'native',
        repo,
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
        console.log(`[Check] Preparing version check for ${pkg.pkgname}...`);

        const pkgbuildsBase = path.resolve(baseDir, 'pkgbuilds');
        const { path: pkgDir, git }: GitCloneResult = await prepare(
            pkg.pkgname,
            pkg.git,
            !!pkg.push,
            pkgbuildsBase
        );

        let templateUpdates: Record<string, string> = {};
        if (pkg.checker) {
            console.log(`[Checker] Checking version using ${pkg.checker.type} provider for ${pkg.pkgname}...`);
            const checkerRes = await fetchVersion(pkg.checker);
            if (checkerRes) {
                console.log(`[Checker] Latest version for ${pkg.pkgname} is v${checkerRes.version}${checkerRes.epoch ? ` (epoch: ${checkerRes.epoch})` : ''}`);
                templateUpdates = resolveTemplateUpdates(pkg, checkerRes);
            } else {
                console.log(`[Checker] Could not ascertain latest version for ${pkg.pkgname}.`);
            }
        }

        const pkgbuildPath = path.resolve(pkgDir, 'PKGBUILD');
        await updateDynamic(pkgbuildPath);

        const builderType = pkg.builder || 'extra-x86_64-build';
        const pkgbuildModified = await updatePkg(pkgbuildPath, templateUpdates, false, pkgbuildParser);
        const finalData = await parse(pkgbuildPath, pkgbuildParser);
        const localData = versionStore.get(pkg.pkgname);
        const changed = pkgbuildModified || versionChanged(localData, finalData);
        let missingRepoArtifact = false;

        if (!changed) {
            if (repo) {
                const alreadyBuilt = await hasBuilt(repo, pkg.pkgname, finalData.pkgver, finalData.pkgrel, baseDir);
                if (alreadyBuilt) {
                    skippedPackages.push({
                        pkg,
                        reason: `version unchanged and artifact already exists (${formatVersion(finalData)})`,
                    });
                    console.log(`[Check] Skipping ${pkg.pkgname}: version unchanged and artifact already exists (${formatVersion(finalData)}).`);
                    continue;
                }

                console.log(`[Check] ${pkg.pkgname} version is unchanged (${formatVersion(finalData)}), but no matching repo artifact exists; scheduling build.`);
                missingRepoArtifact = true;
            } else {
                skippedPackages.push({
                    pkg,
                    reason: `version unchanged (${formatVersion(finalData)})`,
                });
                console.log(`[Check] Skipping ${pkg.pkgname}: version unchanged (${formatVersion(finalData)}).`);
                continue;
            }
        }

        if (hasStoredVersion(localData)) {
            if (changed) {
                console.log(`[Check] Update detected for ${pkg.pkgname}: ${formatStoredVersion(localData!)} -> ${formatVersion(finalData)}`);
            } else if (missingRepoArtifact) {
                console.log(`[Check] Rebuild required for ${pkg.pkgname}: repo artifact missing for ${formatVersion(finalData)}.`);
            }
        } else {
            console.log(`[Check] No stored successful build version for ${pkg.pkgname}; scheduling build for ${formatVersion(finalData)}.`);
        }

        buildPlans.push({
            pkg,
            pkgDir,
            git,
            builderType,
            finalData,
            pkgbuildModified,
        });
    }

    return { buildPlans, skippedPackages };
}
