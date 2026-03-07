import * as fs from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';

const execAsync = promisify(exec);

export interface PkgBuildData {
  epoch?: string;
  pkgver: string;
  pkgrel: number;
}

export async function parsePkgBuild(pkgbuildPath: string): Promise<PkgBuildData> {
  const content = await fs.readFile(pkgbuildPath, 'utf8');
  
  const pkgverMatch = content.match(/^pkgver=(.+)$/m);
  const pkgrelMatch = content.match(/^pkgrel=(\d+)$/m);
  
  const epochMatch = content.match(/^epoch=(\d+)$/m);
  
  if (!pkgverMatch || !pkgverMatch[1] || !pkgrelMatch || !pkgrelMatch[1]) {
    throw new Error('Could not parse pkgver or pkgrel from PKGBUILD');
  }

  return {
    epoch: epochMatch && epochMatch[1] ? epochMatch[1] : undefined,
    pkgver: (pkgverMatch[1] as string).replace(/^['"]|['"]$/g, ''),
    pkgrel: parseInt(pkgrelMatch[1] as string, 10),
  };
}

export async function updateDynamicPkgver(pkgbuildPath: string): Promise<boolean> {
  const content = await fs.readFile(pkgbuildPath, 'utf8');
  if (!content.match(/^pkgver\(\)\s*\{/m)) {
    return false; // No pkgver() function
  }
  
  const pkgbuildDir = path.dirname(pkgbuildPath);
  console.log(`[PKGBUILD] Found dynamic pkgver() in ${path.basename(pkgbuildDir)}, running makepkg -odc to update version...`);
  
  try {
    // -o: extract and download sources
    // -d: skip dependency checks
    // -c: clean up working directory after
    await execAsync('makepkg -odc --noconfirm', { cwd: pkgbuildDir });
    return true;
  } catch (e: any) {
    console.error(`[PKGBUILD] Failed to run makepkg for dynamic pkgver: ${e.message}`);
    return false;
  }
}

export async function updatePkgBuild(
  pkgbuildPath: string, 
  newVersion: string | null,
  newEpoch?: string | null,
  forceBumpRel: boolean = false
): Promise<boolean> {
  let content = await fs.readFile(pkgbuildPath, 'utf8');
  let changed = false;

  const currentData = await parsePkgBuild(pkgbuildPath);

  if (newVersion && currentData.pkgver !== newVersion) {
    console.log(`[PKGBUILD] Updating pkgver from ${currentData.pkgver} to ${newVersion} (pkgrel=1)`);
    content = content.replace(/^pkgver=.+$/m, `pkgver=${newVersion}`);
    content = content.replace(/^pkgrel=\d+$/m, `pkgrel=1`);
    if (newEpoch && newEpoch !== "0") {
       if (content.match(/^epoch=.+$/m)) {
          console.log(`[PKGBUILD] Updating epoch to ${newEpoch}`);
          content = content.replace(/^epoch=.+$/m, `epoch=${newEpoch}`);
       } else {
          console.log(`[PKGBUILD] Injecting new epoch ${newEpoch}`);
          content = content.replace(/^pkgver=/m, `epoch=${newEpoch}\npkgver=`);
       }
    }
    changed = true;
  } else if (forceBumpRel) {
    console.log(`[PKGBUILD] Bumping pkgrel from ${currentData.pkgrel} to ${currentData.pkgrel + 1}`);
    content = content.replace(/^pkgrel=\d+$/m, `pkgrel=${currentData.pkgrel + 1}`);
    changed = true;
  }

  if (changed) {
    await fs.writeFile(pkgbuildPath, content, 'utf8');
  }

  // ALWAYS update checksums
  try {
      const pkgbuildDir = path.dirname(pkgbuildPath);
      console.log(`[PKGBUILD] Running updpkgsums in ${pkgbuildDir}...`);
      await execAsync('updpkgsums', { cwd: pkgbuildDir });
  } catch (e: any) {
      console.error(`[PKGBUILD] Failed to run updpkgsums: ${e.message}`);
      throw e;
  }

  return changed;
}
