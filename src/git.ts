import simpleGit, { type SimpleGit } from 'simple-git';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface GitCloneResult {
  path: string;
  git: SimpleGit;
}

export async function preparePackageDiff(
  pkgname: string,
  gitOverride: string | undefined,
  enablePush: boolean,
  baseDir: string = process.cwd()
): Promise<GitCloneResult> {
  const pkgDir = path.resolve(baseDir, pkgname);
  const gitUrl = gitOverride || (enablePush
    ? `ssh://aur@aur.archlinux.org/${pkgname}.git`
    : `https://aur.archlinux.org/${pkgname}.git`);

  let exists = false;
  try {
    const stat = await fs.stat(pkgDir);
    exists = stat.isDirectory();
  } catch (e: any) {
    if (e.code !== 'ENOENT') {
      throw e;
    }
  }

  const git = simpleGit();

  if (exists) {
    console.log(`[Git] Resetting and cleaning ${pkgname} before pulling...`);
    const repoGit = simpleGit(pkgDir);
    await repoGit.reset(['--hard']);
    await repoGit.raw(['clean', '-Xdff']);
    console.log(`[Git] Pulling latest changes for ${pkgname}...`);
    await repoGit.pull();
    return { path: pkgDir, git: repoGit };
  } else {
    console.log(`[Git] Cloning ${pkgname} from ${gitUrl}...`);
    await git.clone(gitUrl, pkgDir);
    return { path: pkgDir, git: simpleGit(pkgDir) };
  }
}

export async function commitAndPush(
  git: SimpleGit,
  pkgname: string,
  newVersion: string,
  enablePush: boolean
): Promise<void> {
  const status = await git.status();

  if (status.files.length === 0) {
    console.log(`[Git] No changes to commit for ${pkgname}.`);
    return;
  }

  console.log(`[Git] Committing changes for ${pkgname} (v${newVersion})...`);
  await git.add('.');
  await git.commit(`upgpkg: ${pkgname} ${newVersion}`);

  if (enablePush) {
    console.log(`[Git] Pushing changes to AUR for ${pkgname}...`);
    await git.push();
  } else {
    console.log(`[Git] Push is disabled for ${pkgname}, skipping push.`);
  }
}
