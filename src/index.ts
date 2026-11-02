#!/usr/bin/env bun

import 'dotenv/config';
import { Command } from 'commander';
import * as path from 'node:path';

import { loadConfig } from './config';
import { commitAndPush } from './git';
import { buildPackage } from './builder';
import { createDummyPackages } from './dummy';
import { createPreBuildPackage, packagePreBuildConfig } from './prebuild';
import { manageRepository, hasBuiltPackage, resolveBuiltPackage, orphanRepoPackageNames, removeRepoPackages } from './repo';
import { initMainLogger, createTaskLogger, getSessionLogDir, getTaskLogPath, loggerContext, constructMessager } from './logger';
import { Semaphore } from './semaphore';
import { ChrootPool } from './chroot_pool';
import { describeToolchain, isDefaultToolchain, resolveToolchain, toolchainPackages, toolchainScripts, writeToolchainDropIn } from './toolchain';
import { VersionStore, findOrphanVersions } from './version_store';
import { runApprovalCheck } from './approval';
import { runPackageVersionCheck, type PackageBuildPlan } from './package_check';
import { ensurePackageLogDir } from './workdirs';
import { ProjectGitManager, saveVersionStoreUpdate } from './project_git';
import { createWebhookNotifier, type WebhookNotifier } from './webhook';
import { formatPacmanVersion } from './pacman_version';

declare const VERSION: string;
let displayVersion;
try {
  displayVersion = VERSION;
} catch (e) {
  const { readFileSync } = await import("node:fs");
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
  displayVersion = version;
}

const PreaurMessager = constructMessager('PreAUR');
const program = new Command();
program
    .name('preaur')
    .description('Archlinux AUR Package Builder Helper')
    .version(displayVersion)
    .option('-c, --config <path>', 'path to config file', 'preaur.config.yaml')
    .option('-p, --pkg <name>', 'only run for a specific package')
    .action(async (options) => {
        let webhook: WebhookNotifier | undefined;
        try {
            initMainLogger(process.cwd());
            console.log(PreaurMessager(`Loading config from ${options.config}`));

            const configPath = path.resolve(process.cwd(), options.config);
            let config = await loadConfig(configPath);
            const projectGit = await ProjectGitManager.create(process.cwd(), config.git);
            if (projectGit) {
                config = await loadConfig(configPath);
            }
            const pkgbuildParser = config.config?.pkgbuildParser || 'native';
            webhook = createWebhookNotifier(config.webhooks);

            const packagesToProcess = options.pkg
                ? config.packages.filter(p => p.pkgname === options.pkg)
                : config.packages;

            if (packagesToProcess.length === 0) {
                console.log(PreaurMessager('No packages to process.'));
                return;
            }

            await webhook?.notify('SESSION_START');

            const versionStore = new VersionStore(process.cwd());
            await versionStore.load();

            // Use the full package list: with -p, packagesToProcess holds only one package.
            const configuredNames = config.packages.map(p => p.pkgname);
            let orphanVersions = findOrphanVersions(versionStore, configuredNames);
            if (orphanVersions.length > 0 && config.repo?.removeOrphans) {
                const orphanNames = orphanVersions.map(([pkgname]) => pkgname);
                try {
                    // Clean the repository first; keep the entries on failure so the next run retries.
                    await removeRepoPackages(
                        config.repo,
                        orphanRepoPackageNames(orphanNames, configuredNames),
                        process.cwd()
                    );
                } catch (e: any) {
                    console.error(PreaurMessager(`Failed to remove orphaned packages from repository (${orphanNames.join(', ')}); keeping their versions.json entries to retry next run: ${e.message}`));
                    orphanVersions = [];
                }
            }
            if (orphanVersions.length > 0) {
                const orphanSnapshot = await projectGit?.snapshotData();
                const names = orphanVersions.map(([pkgname]) => pkgname).join(', ');
                console.log(PreaurMessager(`Removing versions.json entries for packages no longer in config: ${names}`));
                for (const [pkgname] of orphanVersions) {
                    versionStore.delete(pkgname);
                }
                await versionStore.save();
                if (orphanSnapshot) {
                    await projectGit?.commitDataChanges(orphanSnapshot);
                }
            }

            const approvalSnapshot = await projectGit?.snapshotData();
            let approvedPackages: typeof packagesToProcess;
            try {
                const approvalResult = await runApprovalCheck(
                    packagesToProcess,
                    versionStore,
                    process.cwd(),
                    undefined,
                    config.config?.trustedAurGitPrefixes,
                    webhook
                );
                approvedPackages = approvalResult.buildablePackages;
                await webhook?.notify('APPROVAL_PASSED');
            } catch (e) {
                if (approvalSnapshot) {
                    await projectGit?.commitDataChanges(approvalSnapshot);
                    await projectGit?.pushIfNeeded();
                }
                await webhook?.notify('APPROVAL_UNAPPROVED');
                throw e;
            }
            if (approvalSnapshot) {
                await projectGit?.commitDataChanges(approvalSnapshot);
            }

            if (approvedPackages.length === 0) {
                console.log(PreaurMessager('No packages are eligible for build after check phase.'));
                await projectGit?.pushIfNeeded();
                await webhook?.notify('SESSION_END', { reason: 'no packages eligible for build' });
                return;
            }

            const { buildPlans } = await runPackageVersionCheck(
                approvedPackages,
                versionStore,
                {
                    baseDir: process.cwd(),
                    pkgbuildParser,
                    repo: config.repo,
                    sessionLogDir: getSessionLogDir(),
                    updateCheckCocurrent: config.resources.updateCheckCocurrent,
                    projectGit,
                    pkgbuildSandbox: config.config?.pkgbuildSandbox,
                    webhook,
                }
            );

            if (buildPlans.length === 0) {
                console.log(PreaurMessager('No packages have version updates after check phase.'));
                await projectGit?.pushIfNeeded();
                await webhook?.notify('SESSION_END', { reason: 'no version updates' });
                return;
            }

            const rawParallel = config.resources?.parallel || 2;
            const parallelLimit = typeof rawParallel === 'string' ? parseInt(rawParallel, 10) : rawParallel;
            const effectiveParallel = isNaN(parallelLimit) ? 2 : parallelLimit;
            const pool = new Semaphore(effectiveParallel);
            const chrootPool = new ChrootPool(effectiveParallel);

            const pkgResolvers = new Map<string, () => void>();
            const pkgPromises = new Map<string, Promise<void>>();

            // Pre-register all promises so any package can safely await any other, regardless of array order.
            for (const plan of buildPlans) {
                let resolver: () => void;
                const p = new Promise<void>((res) => { resolver = res; });
                pkgResolvers.set(plan.pkg.pkgname, resolver!);
                pkgPromises.set(plan.pkg.pkgname, p);
            }

            const processPackage = async (plan: PackageBuildPlan): Promise<void> => {
                const { pkg, pkgDir, git, builderType, finalData, pkgbuildModified, workDirs, env } = plan;

                // Wait for dependencies first
                if (pkg.repo_packages && pkg.repo_packages.length > 0) {
                    const deps = pkg.repo_packages
                        .filter(dep => pkgPromises.has(dep))
                        .map(dep => pkgPromises.get(dep));

                    if (deps.length > 0) {
                        console.log(`[Queue] ${pkg.pkgname} is waiting for ${deps.length} dependencies to finish...`);
                        await Promise.all(deps);
                    }
                }

                await pool.acquire();

                try {
                    let shouldBuild = true;
                    if (config.repo) {
                        const alreadyBuilt = await hasBuiltPackage(config.repo, pkg.pkgname, finalData, process.cwd());
                        if (alreadyBuilt) {
                            console.log(PreaurMessager(`Package ${pkg.pkgname}-${finalData.pkgver}-${finalData.pkgrel} already exists in repo. Skipping build.`));
                            shouldBuild = false;
                        }
                    }

                    if (shouldBuild) {
                        await ensurePackageLogDir(workDirs);

                        const loggerStream = createTaskLogger(pkg.pkgname);
                        const taskLogPath = getTaskLogPath(pkg.pkgname);

                        await loggerContext.run(loggerStream, async () => {
                            console.log(`\n================================`);
                            console.log(PreaurMessager(`Processing package: ${pkg.pkgname} (Logs streaming to ${taskLogPath})`));
                            console.log(`================================`);

                            try {
                                let extraPaths: string[] = [];

                                // Resolve repository dependencies (built packages)
                                if (pkg.repo_packages && pkg.repo_packages.length > 0 && config.repo) {
                                    for (const dep of pkg.repo_packages) {
                                        try {
                                            const p = await resolveBuiltPackage(config.repo, dep, process.cwd());
                                            extraPaths.push(p);
                                        } catch (e: any) {
                                            console.warn(PreaurMessager(`[Repo] Could not resolve dependency ${dep} inside repository for ${pkg.pkgname}. Make sure it is built!`));
                                        }
                                    }
                                }

                                // Resolve dummy dependencies
                                if (pkg.dummy_packages && pkg.dummy_packages.length > 0) {
                                    const dummyPkgs = await createDummyPackages(pkg.dummy_packages, loggerStream);
                                    extraPaths.push(...dummyPkgs);
                                }

                                const toolchain = resolveToolchain(config.config?.toolchain, pkg.toolchain);
                                const customToolchain = !isDefaultToolchain(toolchain);
                                const preBuildConfig = packagePreBuildConfig(pkg);
                                let toolchainDropIn: string | undefined;
                                if (customToolchain) {
                                    console.log(PreaurMessager(`Toolchain for ${pkg.pkgname}: ${describeToolchain(toolchain)}`));
                                    preBuildConfig.packages.push(...toolchainPackages(toolchain));
                                    // Toolchain setup runs before the package's own pre-build scripts.
                                    preBuildConfig.scripts.unshift(...toolchainScripts(toolchain));
                                    toolchainDropIn = await writeToolchainDropIn(toolchain, pkg.pkgname, workDirs.root);
                                }

                                const preBuildPkg = await createPreBuildPackage(
                                    pkg.pkgname,
                                    preBuildConfig,
                                    loggerStream
                                );
                                if (preBuildPkg) {
                                    extraPaths.push(preBuildPkg);
                                }

                                // Execute build — acquire a chroot worker for unique copy name
                                const isDevtoolsBuild = builderType.split(' ')[0]?.endsWith('-build') ?? false;
                                const chrootWorker = isDevtoolsBuild ? await chrootPool.acquire() : undefined;

                                // Resolve PACKAGER from maintainer config
                                const maintainer = config.maintainers.find(m => m.id === pkg.maintainer);
                                const packager = maintainer
                                    ? `PreAUR (on behalf of ${maintainer.name}) <${maintainer.email}>`
                                    : undefined;

                                const buildStartTime = Date.now();
                                await webhook?.notify('BUILD_START', {
                                    pkgname: pkg.pkgname,
                                    version: formatPacmanVersion(finalData),
                                    pkgver: finalData.pkgver,
                                    pkgrel: String(finalData.pkgrel),
                                    epoch: finalData.epoch ? String(finalData.epoch) : undefined,
                                    maintainer: maintainer?.name,
                                });

                                try {
                                    await buildPackage({
                                        pkgDir,
                                        builder: builderType,
                                        resources: config.resources,
                                        dummyPkgs: extraPaths,
                                        logStream: loggerStream,
                                        chrootWorker,
                                        packager,
                                        env,
                                        chrootPacman: config.config?.chrootPacman,
                                        baseDir: process.cwd(),
                                        toolchainDropIn,
                                    });

                                    const buildTime = ((Date.now() - buildStartTime) / 1000).toFixed(1);
                                    await webhook?.notify('BUILD_SUCCESSFUL', {
                                        pkgname: pkg.pkgname,
                                        version: formatPacmanVersion(finalData),
                                        pkgver: finalData.pkgver,
                                        pkgrel: String(finalData.pkgrel),
                                        epoch: finalData.epoch ? String(finalData.epoch) : undefined,
                                        maintainer: maintainer?.name,
                                        buildTime: Number(buildTime),
                                    });
                                } catch (buildError: any) {
                                    await webhook?.notify('BUILD_FAILED', {
                                        pkgname: pkg.pkgname,
                                        version: formatPacmanVersion(finalData),
                                        error: buildError.message,
                                    });
                                    throw buildError;
                                } finally {
                                    if (chrootWorker) chrootPool.release(chrootWorker);
                                }

                                const status = await git.status();
                                const hasGitChanges = status.files.length > 0;

                                if ((pkgbuildModified || hasGitChanges) && pkg.push) {
                                    await webhook?.notify('PUSH_START', {
                                        pkgname: pkg.pkgname,
                                        version: formatPacmanVersion(finalData),
                                    });

                                    try {
                                        await commitAndPush(git, pkg.pkgname, finalData.pkgver, true);
                                        await webhook?.notify('PUSH_SUCCESSFUL', {
                                            pkgname: pkg.pkgname,
                                            version: formatPacmanVersion(finalData),
                                        });
                                    } catch (pushError: any) {
                                        await webhook?.notify('PUSH_FAILED', {
                                            pkgname: pkg.pkgname,
                                            error: pushError.message,
                                        });
                                        throw pushError;
                                    }
                                } else {
                                    console.log(PreaurMessager(`Skipping push phase for ${pkg.pkgname}.`));
                                }

                                if (config.repo) {
                                    await manageRepository(config.repo, workDirs.pkgdest, process.cwd());
                                }

                                // Sync successful build variables
                                await saveVersionStoreUpdate(versionStore, pkg.pkgname, finalData, projectGit);

                            } catch (pkgError: any) {
                                console.error(PreaurMessager(`Error processing ${pkg.pkgname}: ${pkgError.message}`));
                            } finally {
                                loggerStream.end();
                            }
                        });
                    } else {
                        console.log(PreaurMessager(`Skipping build map execution for ${pkg.pkgname} since shouldBuild=false.`));
                    }
                } catch (pkgError: any) {
                    console.error(PreaurMessager(`Error processing ${pkg.pkgname}: ${pkgError.message}`));
                } finally {
                    pool.release();
                    // Notify any downstream packages waiting on this one that it has finished
                    const resolveTrigger = pkgResolvers.get(pkg.pkgname);
                    if (resolveTrigger) resolveTrigger();
                }
            };

            // Kick off processing (they will wait on dependencies internally)
            for (const plan of buildPlans) {
                processPackage(plan); // Don't await here, we let them orchestrate themselves
            }

            // Wait for all pre-registered topological promises to resolve
            await Promise.all(pkgPromises.values());

            await projectGit?.pushIfNeeded();

            await webhook?.notify('SESSION_END', { reason: 'all builds finished' });
            console.log(PreaurMessager(`\nAll tasks finished.`));
        } catch (err: any) {
            console.error(PreaurMessager(`Fatal Error: ${err.message}`));
            webhook && await webhook?.notify('SESSION_FAILED', { error: err.message }).catch(() => {});
            process.exit(1);
        }
    });

program.parse(process.argv);
