#!/usr/bin/env bun

import 'dotenv/config';
import { Command } from 'commander';
import * as path from 'node:path';

import { loadConfig } from './config';
import type { PreaurPackage, PreaurConfig } from './config';
import { fetchLatestVersion, applyVersionTemplate } from './checker';
import { preparePackageDiff, commitAndPush } from './git';
import { updatePkgBuild, parsePkgBuild, updateDynamicPkgver } from './pkgbuild';
import { buildPackage } from './builder';
import { createDummyPackages } from './dummy';
import { manageRepository, hasBuiltPackage, resolveBuiltPackage } from './repo';
import { initMainLogger, createTaskLogger } from './logger';
import { Semaphore } from './semaphore';
import { VersionStore } from './version_store';

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

      const packagesToProcess = options.pkg
        ? config.packages.filter(p => p.pkgname === options.pkg)
        : config.packages;

      if (packagesToProcess.length === 0) {
        console.log('[Preaur] No packages to process.');
        return;
      }

      const versionStore = new VersionStore(process.cwd());
      await versionStore.load();

      const rawParallel = config.resources?.parallel || 2;
      const parallelLimit = typeof rawParallel === 'string' ? parseInt(rawParallel, 10) : rawParallel;
      const pool = new Semaphore(isNaN(parallelLimit) ? 2 : parallelLimit);

      const pkgResolvers = new Map<string, () => void>();
      const pkgPromises = new Map<string, Promise<void>>();

      // Pre-register all promises so any package can safely await any other, regardless of array order.
      for (const pkg of packagesToProcess) {
        let resolver: () => void;
        const p = new Promise<void>((res) => { resolver = res; });
        pkgResolvers.set(pkg.pkgname, resolver!);
        pkgPromises.set(pkg.pkgname, p);
      }

      const processPackage = async (pkg: PreaurPackage): Promise<void> => {
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
        console.log(`\n================================`);
        console.log(`[Preaur] Processing package: ${pkg.pkgname} (Logs streaming to ${pkg.pkgname}.log)`);
        console.log(`================================`);

        try {
          const pkgbuildsBase = path.resolve(process.cwd(), 'pkgbuilds');
          const { path: pkgDir, git } = await preparePackageDiff(
            pkg.pkgname,
            pkg.git,
            !!pkg.push,
            pkgbuildsBase
          );

          let newVersion: string | null = null;
          let newEpoch: string | undefined = undefined;
          let templateUpdates: Record<string, string> = {};

          if (pkg.checker) {
            console.log(`[Checker] Checking version using ${pkg.checker.type} provider for ${pkg.pkgname}...`);
            const checkerRes = await fetchLatestVersion(pkg.checker);
            if (checkerRes) {
              newVersion = checkerRes.version;
              newEpoch = checkerRes.epoch;
              console.log(`[Checker] Latest version for ${pkg.pkgname} is v${newVersion}${newEpoch ? ` (epoch: ${newEpoch})` : ''}`);
              
              if (pkg.checker.template) {
                 const tplResult = applyVersionTemplate(pkg.checker.template, newVersion);
                 if (tplResult) {
                     templateUpdates = tplResult;
                     console.log(`[Checker] Template override applied: ${JSON.stringify(templateUpdates)}`);
                 } else {
                     console.warn(`[Checker] Template parsing failed for ${newVersion}`);
                     templateUpdates = { pkgver: newVersion };
                 }
              } else {
                 templateUpdates = { pkgver: newVersion };
              }
              if (newEpoch) {
                 templateUpdates.epoch = newEpoch;
              }
            } else {
              console.log(`[Checker] Could not ascertain latest version for ${pkg.pkgname}.`);
            }
          }

          // Read PKGBUILD before any dynamic changes to ensure we have initial state if needed
          const pkgbuildPath = path.resolve(pkgDir, 'PKGBUILD');
          const currentData = await parsePkgBuild(pkgbuildPath).catch(e => {
            console.warn(`[PKGBUILD] Failed to parse initial PKGBUILD for ${pkg.pkgname}: ${e.message}`);
            return null;
          });

          let localData = versionStore.get(pkg.pkgname);
          // If not in local store, sync PKGBUILD into local
          if (!localData && currentData) {
            versionStore.set(pkg.pkgname, currentData);
            await versionStore.save();
            localData = currentData;
          }

          await updateDynamicPkgver(pkgbuildPath);

          let needsRelBump = false;
          // In case of git packages, their checking is embedded in makepkg. If checker was specified, use that explicitly.
          const builderType = pkg.builder || 'extra-x86_64-build';
          const pkgbuildModified = await updatePkgBuild(pkgbuildPath, templateUpdates, needsRelBump);
          const finalData = await parsePkgBuild(pkgbuildPath);

          let updateFound = pkgbuildModified;
          if (!updateFound) {
             if (localData) {
                if (finalData.epoch !== localData.epoch || finalData.pkgver !== localData.pkgver || finalData.pkgrel !== localData.pkgrel) {
                   updateFound = true;
                   console.log(`[Preaur] Update detected: local(${localData.epoch ? localData.epoch+':' : ''}${localData.pkgver}-${localData.pkgrel}) -> new(${finalData.epoch ? finalData.epoch+':' : ''}${finalData.pkgver}-${finalData.pkgrel})`);
                }
             } else {
                updateFound = true;
             }
          }

          let shouldBuild = updateFound;
          if (config.repo) {
            const alreadyBuilt = await hasBuiltPackage(config.repo, pkg.pkgname, finalData.pkgver, finalData.pkgrel, process.cwd());
            if (alreadyBuilt) {
              console.log(`[Preaur] Package ${pkg.pkgname}-${finalData.pkgver}-${finalData.pkgrel} already exists in repo. Skipping build.`);
              shouldBuild = false;
            } else if (!shouldBuild) {
              console.log(`[Preaur] Package ${pkg.pkgname}-${finalData.pkgver}-${finalData.pkgrel} not found in repo, forcing build.`);
              shouldBuild = true;
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
                } catch(e: any) {
                  console.warn(`[Repo] Could not resolve dependency ${dep} inside repository for ${pkg.pkgname}. Make sure it is built!`);
                }
              }
            }

            // Resolve dummy dependencies
            if (pkg.dummy_packages && pkg.dummy_packages.length > 0) {
              const dummyPkgs = await createDummyPackages(pkg.dummy_packages, loggerStream);
              extraPaths.push(...dummyPkgs);
            }

            // Execute build
            await buildPackage(pkgDir, builderType, config.resources, extraPaths, loggerStream);

            const status = await git.status();
            const hasGitChanges = status.files.length > 0;

            if ((pkgbuildModified || hasGitChanges) && pkg.push) {
              await commitAndPush(git, pkg.pkgname, finalData.pkgver, true);
            } else {
              console.log(`[Preaur] Skipping push phase for ${pkg.pkgname}.`);
            }

            if (config.repo) {
              await manageRepository(config.repo, pkgDir, process.cwd());
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
      };

      // Kick off processing (they will wait on dependencies internally)
      for (const pkg of packagesToProcess) {
        processPackage(pkg); // Don't await here, we let them orchestrate themselves
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