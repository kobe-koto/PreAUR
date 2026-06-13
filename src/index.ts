#!/usr/bin/env bun

import 'dotenv/config';
import { Command } from 'commander';
import * as path from 'node:path';

import { loadConfig } from './config';
import { commitAndPush } from './git';
import { buildPackage } from './builder';
import { createDummyPackages } from './dummy';
import { manageRepository, hasBuiltPackage, resolveBuiltPackage } from './repo';
import { initMainLogger, createTaskLogger, getSessionLogDir, getTaskLogPath, loggerContext } from './logger';
import { Semaphore } from './semaphore';
import { ChrootPool } from './chroot_pool';
import { VersionStore } from './version_store';
import { runApprovalCheck } from './approval';
import { runPackageVersionCheck, type PackageBuildPlan } from './package_check';

const program = new Command();

program
    .name('preaur')
    .description('Archlinux AUR Package Builder Helper')
    .version('0.1.0')
    .option('-c, --config <path>', 'path to config file', 'preaur.config.yaml')
    .option('-p, --pkg <name>', 'only run for a specific package')
    .action(async (options) => {
        try {
            initMainLogger(process.cwd());
            console.log(`[Preaur] Loading config from ${options.config}`);

            const configPath = path.resolve(process.cwd(), options.config);
            const config = await loadConfig(configPath);
            const pkgbuildParser = config.config?.pkgbuildParser || 'native';

            const packagesToProcess = options.pkg
                ? config.packages.filter(p => p.pkgname === options.pkg)
                : config.packages;

            if (packagesToProcess.length === 0) {
                console.log('[Preaur] No packages to process.');
                return;
            }

            const versionStore = new VersionStore(process.cwd());
            await versionStore.load();

            const { buildablePackages: approvedPackages } = await runApprovalCheck(
                packagesToProcess,
                versionStore,
                process.cwd(),
                undefined,
                config.config?.trustedAurGitPrefixes
            );

            if (approvedPackages.length === 0) {
                console.log('[Preaur] No packages are eligible for build after check phase.');
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
                }
            );

            if (buildPlans.length === 0) {
                console.log('[Preaur] No packages have version updates after check phase.');
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

                const loggerStream = createTaskLogger(pkg.pkgname);
                const taskLogPath = getTaskLogPath(pkg.pkgname);

                await loggerContext.run(loggerStream, async () => {
                    console.log(`\n================================`);
                    console.log(`[Preaur] Processing package: ${pkg.pkgname} (Logs streaming to ${taskLogPath})`);
                    console.log(`================================`);

                    try {
                        let shouldBuild = true;
                        if (config.repo) {
                            const alreadyBuilt = await hasBuiltPackage(config.repo, pkg.pkgname, finalData, process.cwd());
                            if (alreadyBuilt) {
                                console.log(`[Preaur] Package ${pkg.pkgname}-${finalData.pkgver}-${finalData.pkgrel} already exists in repo. Skipping build.`);
                                shouldBuild = false;
                            }
                        }

                        if (shouldBuild) {
                            let extraPaths: string[] = [];

                            // Resolve repository dependencies (built packages)
                            if (pkg.repo_packages && pkg.repo_packages.length > 0 && config.repo) {
                                for (const dep of pkg.repo_packages) {
                                    try {
                                        const p = await resolveBuiltPackage(config.repo, dep, process.cwd());
                                        extraPaths.push(p);
                                    } catch (e: any) {
                                        console.warn(`[Repo] Could not resolve dependency ${dep} inside repository for ${pkg.pkgname}. Make sure it is built!`);
                                    }
                                }
                            }

                            // Resolve dummy dependencies
                            if (pkg.dummy_packages && pkg.dummy_packages.length > 0) {
                                const dummyPkgs = await createDummyPackages(pkg.dummy_packages, loggerStream);
                                extraPaths.push(...dummyPkgs);
                            }

                            // Execute build — acquire a chroot worker for unique copy name
                            const isDevtoolsBuild = builderType.split(' ')[0]?.endsWith('-build') ?? false;
                            const chrootWorker = isDevtoolsBuild ? await chrootPool.acquire() : undefined;

                            // Resolve PACKAGER from maintainer config
                            const maintainer = config.maintainers.find(m => m.id === pkg.maintainer);
                            const packager = maintainer
                                ? `PreAUR (on behalf of ${maintainer.name}) <${maintainer.email}>`
                                : undefined;

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
                                });
                            } finally {
                                if (chrootWorker) chrootPool.release(chrootWorker);
                            }

                            const status = await git.status();
                            const hasGitChanges = status.files.length > 0;

                            if ((pkgbuildModified || hasGitChanges) && pkg.push) {
                                await commitAndPush(git, pkg.pkgname, finalData.pkgver, true);
                            } else {
                                console.log(`[Preaur] Skipping push phase for ${pkg.pkgname}.`);
                            }

                            if (config.repo) {
                                await manageRepository(config.repo, workDirs.pkgdest, process.cwd());
                            }

                            // Sync successful build variables
                            versionStore.set(pkg.pkgname, finalData);
                            await versionStore.save();
                        } else {
                            console.log(`[Preaur] Skipping build map execution for ${pkg.pkgname} since shouldBuild=false.`);
                        }

                    } catch (pkgError: any) {
                        console.error(`[Preaur] Error processing ${pkg.pkgname}: ${pkgError.message}`);
                    } finally {
                        loggerStream.end();
                        pool.release();
                        // Notify any downstream packages waiting on this one that it has finished
                        const resolveTrigger = pkgResolvers.get(pkg.pkgname);
                        if (resolveTrigger) resolveTrigger();
                    }
                });
            };

            // Kick off processing (they will wait on dependencies internally)
            for (const plan of buildPlans) {
                processPackage(plan); // Don't await here, we let them orchestrate themselves
            }

            // Wait for all pre-registered topological promises to resolve
            await Promise.all(pkgPromises.values());

            console.log(`\n[Preaur] All tasks finished.`);
        } catch (err: any) {
            console.error(`[Preaur] Fatal Error: ${err.message}`);
            process.exit(1);
        }
    });

program.parse(process.argv);
