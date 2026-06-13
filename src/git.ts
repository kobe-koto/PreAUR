import simpleGit, { type SimpleGit } from 'simple-git';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { constructMessager } from './logger';

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
    const pkgMessager = constructMessager('Git', pkgname);
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
        // console.log(pkgMessager('Updating and cleaning...'));
        const repoGit = simpleGit(pkgDir);
        await repoGit.fetch();
        await repoGit.reset(['--hard', '@{u}']);
        await repoGit.clean('ff', ['-d']);
        return { path: pkgDir, git: repoGit };
    } else {
        console.log(pkgMessager(`Cloning from ${gitUrl}...`));
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
    const pkgMessager = constructMessager('Git', pkgname);
    const status = await git.status();

    if (status.files.length === 0) {
        console.log(pkgMessager('No changes to commit.'));
        return;
    }

    console.log(pkgMessager(`Committing changes (v${newVersion})...`));
    await git.add('.');
    await git.commit(`upgpkg: ${pkgname} ${newVersion}`);

    if (enablePush) {
        console.log(pkgMessager('Pushing changes to AUR...'));
        await git.push();
    } else {
        console.log(pkgMessager('Push is disabled, skipping push.'));
    }
}
