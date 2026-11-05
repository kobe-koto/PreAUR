import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SimpleGit } from 'simple-git';

import type { PreaurChecksumArch, PreaurPackage, PreaurPkgbuildSandboxConfig, PreaurRepo } from './config.ts';
import type { EnvPairs } from './env.ts';
import type { CheckerResult } from './checker.ts';
import { applyVersionTemplate, fetchLatestVersion } from './checker.ts';
import { preparePackageDiff, resolveHeadCommit, resolvePackageGitUrl, type GitCloneResult } from './git.ts';
import { isStaticVersionPkgbuild, parsePkgBuild, updateDynamicPkgver, updatePkgBuild, withPkgbase, type PkgBuildData, type PkgBuildParser } from './pkgbuild.ts';
import { VersionStore, sameVersionMarker, type VersionMarker } from './version_store.ts';
import { hasBuiltPackage } from './repo.ts';
import { ensurePackageCheckWorkDirs, getPackageWorkDirs, packageWorkEnvPairs, type PackageWorkDirs } from './workdirs.ts';
import { formatPacmanVersion, hasPacmanVersion, pacmanVersionChanged } from './pacman_version.ts';
import { constructMessager } from './logger.ts';
import { resolveDevtoolsBuildTarget } from './chroot_pacman.ts';
import { saveVersionStoreUpdate, type ProjectGitManager } from './project_git.ts';
import type { WebhookNotifier } from './webhook.ts';
import {
    parsePkgBuildInSandbox,
    resolvePkgbuildSandboxOptions,
    updateDynamicPkgverInSandbox,
    updatePkgBuildInSandbox,
} from './pkgbuild_sandbox.ts';
import pc from 'picocolors';

export interface PackageBuildPlan {
    pkg: PreaurPackage;
    pkgDir: string;
    git: SimpleGit;
    builderType: string;
    finalData: PkgBuildData;
    /** Version marker to store with finalData after a successful build; undefined clears it. */
    versionMarker?: VersionMarker;
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
    resolveHeadCommit?: typeof resolveHeadCommit;
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
        /** Default checksum scope; package checksumArch overrides it. */
        checksumArch?: PreaurChecksumArch;
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
        checksumArch,
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
            checksumArch,
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

/**
 * Architecture whose sources alone get checksummed, or undefined to update
 * checksums for every architecture. Partial checksums leave the other
 * architectures' arrays outdated, so they must never leave this machine:
 * packages pushed to the AUR are refused and need manual intervention.
 */
export function resolveChecksumTargetArch(
    pkg: Pick<PreaurPackage, 'pkgname' | 'push' | 'checksumArch'>,
    builderType: string,
    defaultMode: PreaurChecksumArch | undefined
): string | undefined {
    const mode = pkg.checksumArch ?? defaultMode ?? 'all';
    if (mode === 'all') return undefined;

    if (pkg.push) {
        throw new Error(`checksumArch "target" would push PKGBUILD checksums for ${pkg.pkgname} that only cover the builder architecture to the AUR. Set checksumArch: all for this package, or disable push.`);
    }

    const target = resolveDevtoolsBuildTarget(builderType.split(' ')[0] ?? '');
    if (!target) {
        throw new Error(`checksumArch "target" cannot determine the target architecture of ${pkg.pkgname} from builder "${builderType}". Use a devtools builder such as extra-x86_64-build, or set checksumArch: all for this package.`);
    }
    return target.arch;
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
        checksumArch?: PreaurChecksumArch;
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
        checksumArch,
        webhook,
    } = options;

    const builderType = pkg.builder || 'extra-x86_64-build';
    // Checked before anything is cloned or rewritten.
    const checksumTargetArch = resolveChecksumTargetArch(pkg, builderType, checksumArch);

    const prepare = deps.preparePackageDiff ?? preparePackageDiff;
    const fetchVersion = deps.fetchLatestVersion ?? fetchLatestVersion;
    const hasBuilt = deps.hasBuiltPackage ?? hasBuiltPackage;
    const headCommit = deps.resolveHeadCommit ?? resolveHeadCommit;

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

    const pkgbuildPath = path.resolve(pkgDir, 'PKGBUILD');
    const localData = versionStore.get(pkg.pkgname);

    // Read before any command can rewrite the PKGBUILD, so the marker describes this commit.
    const commit = pkg.checker ? undefined : await headCommit(git);
    const pristinePkgbuild = commit ? await fs.readFile(pkgbuildPath, 'utf8').catch(() => undefined) : undefined;
    const candidateMarker: VersionMarker | undefined = commit
        ? { commit, git: resolvePackageGitUrl(pkg.pkgname, pkg.git, !!pkg.push), parser: pkgbuildParser, builder: builderType }
        : undefined;

    // Same marker: the PKGBUILD is unchanged and its version is static, so skip the sandbox entirely.
    const storedPkgbase = localData?.pkgbase;
    if (candidateMarker && sameVersionMarker(localData?.version_marker, candidateMarker) && hasPacmanVersion(localData)) {
        const storedData = withPkgbase(
            { epoch: localData.epoch ?? 0, pkgver: localData.pkgver, pkgrel: localData.pkgrel },
            storedPkgbase
        );
        const version = formatPacmanVersion(storedData);
        if (!repo || await hasBuilt(repo, pkg.pkgname, storedData, baseDir)) {
            const reason = repo
                ? 'version marker unchanged and artifact already exists'
                : 'version marker unchanged';
            await webhook?.notify('PACKAGE_NO_UPDATE', { pkgname: pkg.pkgname, version, reason });
            return { skipped: true, reason: `${reason} (${version}, commit ${commit!.slice(0, 12)})` };
        }
        console.log(pkgMessager(`Version marker unchanged but repo artifact missing for ${version}; running full check.`));
    }

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
                env?: EnvPairs,
                checksumArch?: string
            ) => updatePkgBuildInSandbox(pkgname, pkgbuildPath, updates, forceBumpRel, parser, env, sandbox, workDirs, checksumArch))
            : updatePkgBuild);

    const dynamicPkgverRan = await updateDynamic(pkgbuildPath, env);

    const pkgbuildModified = await updatePkg(pkg.pkgname, pkgbuildPath, templateUpdates, false, pkgbuildParser, env, checksumTargetArch);
    const { pkgverFunction, ...finalData } = await parse(pkgbuildPath, pkgbuildParser, env);
    if (pkgverFunction && !dynamicPkgverRan) {
        console.warn(pkgMessager(pc.yellow('PKGBUILD defines pkgver() in a form PreAUR did not detect; the dynamic version was not updated.')));
    }
    // pkgverFunction comes from sourcing in the sandbox; the text check also covers parsers that do not source.
    const versionMarker = candidateMarker && pristinePkgbuild !== undefined
        && !dynamicPkgverRan && pkgverFunction !== true && isStaticVersionPkgbuild(pristinePkgbuild)
        ? candidateMarker
        : undefined;
    const versionChanged = pacmanVersionChanged(localData, finalData);

    if (!hasPacmanVersion(localData) && repo) {
        const alreadyBuilt = await hasBuilt(repo, pkg.pkgname, finalData, baseDir);
        if (alreadyBuilt) {
            await saveVersionStoreUpdate(versionStore, pkg.pkgname, { ...finalData, version_marker: versionMarker }, projectGit);
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
        // Entries written before pkgbase was recorded would otherwise wait for the next version bump.
        if (finalData.pkgbase && localData?.pkgbase !== finalData.pkgbase) {
            await saveVersionStoreUpdate(versionStore, pkg.pkgname, { pkgbase: finalData.pkgbase }, projectGit);
        }
        // The version is confirmed current, so the marker may be recorded without a build.
        const markerOutdated = !sameVersionMarker(localData?.version_marker, versionMarker);
        const saveMarker = () => markerOutdated
            ? saveVersionStoreUpdate(versionStore, pkg.pkgname, { version_marker: versionMarker }, projectGit)
            : Promise.resolve();
        if (repo) {
            const alreadyBuilt = await hasBuilt(repo, pkg.pkgname, finalData, baseDir);
            if (alreadyBuilt) {
                await saveMarker();
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
            await saveMarker();
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
        versionMarker,
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
