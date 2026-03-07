import * as fs from 'node:fs/promises';
import { WriteStream } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as os from 'node:os';
import type { PreaurDummyPackage } from './config';

const execAsync = promisify(exec);

export async function createDummyPackages(
  dummies: PreaurDummyPackage[],
  logStream?: WriteStream
): Promise<string[]> {
  const dummyPkgs: string[] = [];
  
  for (const dummy of dummies) {
    const pkgname = `${dummy.dummy}-dummy`;
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `preaur-${pkgname}-`));
    
    let packageFuncBody = '  :\n';
    if (dummy.files && dummy.files.length > 0) {
      packageFuncBody = '';
      for (const file of dummy.files) {
         packageFuncBody += `  install -Dm644 /dev/null "$pkgdir${file}"\n`;
      }
    }

    const dummyPkgver = dummy.pkgver || '1.0';
    const dummyPkgrel = dummy.pkgrel || 1;
    const epochLine = dummy.epoch !== undefined ? `epoch=${dummy.epoch}\n` : '';
    const providesVer = dummy.epoch !== undefined 
      ? `${dummy.epoch}:${dummyPkgver}-${dummyPkgrel}` 
      : `${dummyPkgver}-${dummyPkgrel}`;

    const pkgbuildContent = `
pkgname=${pkgname}
${epochLine}pkgver=${dummyPkgver}
pkgrel=${dummyPkgrel}
pkgdesc="Dummy package provides ${dummy.dummy}"
arch=('any')
provides=('${dummy.dummy}=${providesVer}')

package() {
${packageFuncBody}
}
`;

    const pkgbuildPath = path.join(workDir, 'PKGBUILD');
    await fs.writeFile(pkgbuildPath, pkgbuildContent, 'utf8');

    console.log(`[Dummy] Building dummy package ${pkgname} in ${workDir}...`);
    try {
      const child = exec('makepkg -cf --noconfirm', { cwd: workDir });
      if (logStream && child.stdout && child.stderr) {
        child.stdout.pipe(logStream, { end: false });
        child.stderr.pipe(logStream, { end: false });
      }

      await new Promise<void>((resolve, reject) => {
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Exit code ${code}`));
        });
        child.on('error', reject);
      });
    } catch (e: any) {
      console.error(`[Dummy] Failed to build dummy package ${pkgname}: ${e.message}`);
      throw e;
    }

    const files = await fs.readdir(workDir);
    const zstFile = files.find(f => f.endsWith('.pkg.tar.zst'));
    if (!zstFile) {
        throw new Error(`[Dummy] Built package not found in ${workDir}`);
    }

    dummyPkgs.push(path.join(workDir, zstFile));
  }

  return dummyPkgs;
}
