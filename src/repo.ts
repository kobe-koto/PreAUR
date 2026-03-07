import * as fs from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import type { PreaurRepo } from './config';

export async function hasBuiltPackage(
  repoConfig: PreaurRepo,
  pkgname: string,
  pkgver: string,
  pkgrel: number,
  baseDir: string = process.cwd()
): Promise<boolean> {
  const repoDir = path.resolve(baseDir, 'repo', repoConfig.name);
  try {
    const files = await fs.readdir(repoDir);
    const prefix = `${pkgname}-${pkgver}-${pkgrel}-`;
    return files.some(f => f.startsWith(prefix) && f.endsWith('.pkg.tar.zst'));
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      return false;
    }
    throw e;
  }
}

const execAsync = promisify(exec);

export async function manageRepository(
  repoConfig: PreaurRepo,
  pkgbuildDirectory: string,
  baseDir: string = process.cwd()
): Promise<void> {
  const repoDir = path.resolve(baseDir, 'repo', repoConfig.name);
  
  // Ensure repo directory exists
  await fs.mkdir(repoDir, { recursive: true });

  console.log(`[Repo] Synchronizing artifacts for to ${repoDir}...`);
  
  // Find built `.pkg.tar.zst` files in the pkgbuildDirectory
  const files = await fs.readdir(pkgbuildDirectory);
  const pkgFiles = files.filter(f => f.endsWith('.pkg.tar.zst'));

  if (pkgFiles.length === 0) {
     console.log(`[Repo] No .pkg.tar.zst files found in ${pkgbuildDirectory} to copy.`);
     return;
  }

  const copiedFiles: string[] = [];

  for (const file of pkgFiles) {
    const srcPath = path.resolve(pkgbuildDirectory, file);
    const destPath = path.resolve(repoDir, file);
    
    // Copy file to repo directory
    await fs.copyFile(srcPath, destPath);
    console.log(`[Repo] Copied ${file} to repository.`);
    copiedFiles.push(destPath);
  }

  // Run repo-add
  const dbFile = path.resolve(repoDir, `${repoConfig.name}.db.tar.gz`);
  
  console.log(`[Repo] Running repo-add ${repoConfig.name}.db.tar.gz...`);
  
  try {
     // repo-add usage: repo-add [options] <path-to-db> <package1> [<package2> ...]
     const cmd = `repo-add ${dbFile} ${copiedFiles.join(' ')}`;
     await execAsync(cmd, { cwd: repoDir });
     console.log(`[Repo] Successfully updated pacman database: ${repoConfig.name}.db.tar.gz`);
  } catch (e: any) {
     console.error(`[Repo] Failed to update pacman database: ${e.message}`);
     throw e;
  }
}

