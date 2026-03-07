import 'dotenv/config';
import { Command } from 'commander';
import * as path from 'node:path';

import { loadConfig } from './config';
import { fetchLatestVersion } from './checker';
import { preparePackageDiff, commitAndPush } from './git';
import { updatePkgBuild, parsePkgBuild, updateDynamicPkgver } from './pkgbuild';
import { buildPackage } from './builder';
import { manageRepository, hasBuiltPackage } from './repo';

const program = new Command();

program
  .name('preaur')
  .description('Archlinux AUR Package Builder Helper')
  .version('0.1.0')
  .option('-c, --config <path>', 'path to config file', 'preaur.config.yaml')
  .option('-p, --pkg <name>', 'only run for a specific package')
  .action(async (options) => {
    try {
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

      for (const pkg of packagesToProcess) {
        console.log(`\n================================`);
        console.log(`[Preaur] Processing package: ${pkg.pkgname}`);
        console.log(`================================`);

        try {
          // Git operations mapping
          const pkgbuildsBase = path.resolve(process.cwd(), 'pkgbuilds');
          const { path: pkgDir, git } = await preparePackageDiff(
            pkg.pkgname,
            pkg.git,
            !!pkg.push,
            pkgbuildsBase
          );

          let newVersion: string | null = null;

          if (pkg.checker) {
            console.log(`[Checker] Checking version using ${pkg.checker.type} provider...`);
            newVersion = await fetchLatestVersion(pkg.checker);
            if (newVersion) {
              console.log(`[Checker] Latest version is v${newVersion}`);
            } else {
              console.log(`[Checker] Could not ascertain latest version.`);
            }
          }

          // In this simplified workflow, any time there's a git divergence or version change, 
          // we update the pkgbuild. Right now it just bumps PKGREL or sets PKGVER based on newVersion.
          // Because `packageDiff` did a clone or a pull, we should check `git status` or last commit 
          // compared to upstream if we only want to bump pkgrel when upstream changes, but here we'll 
          // just let it build if new version.

          const pkgbuildPath = path.resolve(pkgDir, 'PKGBUILD');
          
          await updateDynamicPkgver(pkgbuildPath);

          const currentData = await parsePkgBuild(pkgbuildPath).catch(e => {
            console.warn(`[PKGBUILD] Failed to parse initial PKGBUILD: ${e.message}`);
            return null;
          });

          // Check if version changed from current
          let needsRelBump = false;
          if (!newVersion || (currentData && currentData.pkgver === newVersion)) {
            // Version didn't change via checker, but maybe there were git updates?
            const status = await git.status();
            if (status.behind > 0) {
              // Or rather if we pulled changes... 
              // It's intricate to detect if we *just* pulled updates that modified source arrays
              // For now, let's assume if git says we have uncommitted changes or we want to force rebuild
              // We don't automatically bump pkgrel unless requested or configured to detect PKGBUILD diff.
            }
          }

          const builderType = pkg.builder || 'extra-x86_64-build';

          const pkgbuildModified = await updatePkgBuild(pkgbuildPath, newVersion, needsRelBump);

          const finalData = await parsePkgBuild(pkgbuildPath);

          let shouldBuild = true;
          if (config.repo) {
            const alreadyBuilt = await hasBuiltPackage(config.repo, pkg.pkgname, finalData.pkgver, finalData.pkgrel, process.cwd());
            if (alreadyBuilt) {
              console.log(`[Preaur] Package ${pkg.pkgname}-${finalData.pkgver}-${finalData.pkgrel} already exists in repo. Skipping build.`);
              shouldBuild = false;
            }
          }

          if (shouldBuild) {
            await buildPackage(pkgDir, builderType, config.resources);

            const status = await git.status();
            const hasGitChanges = status.files.length > 0;

            if ((pkgbuildModified || hasGitChanges) && pkg.push) {
              await commitAndPush(git, pkg.pkgname, finalData.pkgver, true);
            } else {
              console.log(`[Preaur] Skipping push phase. modified=${pkgbuildModified || hasGitChanges}, push=${!!pkg.push}`);
            }

            if (config.repo) {
              await manageRepository(config.repo, pkgDir, process.cwd());
            }
          }

        } catch (pkgError: any) {
          console.error(`[Preaur] Error processing ${pkg.pkgname}: ${pkgError.message}`);
        }
      }

      console.log(`\n[Preaur] All tasks finished.`);
    } catch (err: any) {
      console.error(`[Preaur] Fatal Error: ${err.message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);