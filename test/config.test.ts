import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadConfig } from '../src/config';

const tmpDirs: string[] = [];

async function writeConfig(content: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preaur-config-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'preaur.config.yaml');
    await fs.writeFile(configPath, content, 'utf8');
    return configPath;
}

afterEach(async () => {
    while (tmpDirs.length) {
        const dir = tmpDirs.pop()!;
        await fs.rm(dir, { recursive: true, force: true });
    }
});

describe('loadConfig', () => {
    test('enables project git automation by default', async () => {
        const configPath = await writeConfig(`
maintainers:
  - id: johndoe
    name: John Doe
    email: john@example.com
default_maintainer: johndoe
packages:
  - pkgname: demo
`);

        const config = await loadConfig(configPath);

        expect(config.git).toMatchObject({
            enabled: true,
            remote: 'origin',
            sync: { allow_remote_overwrite_local: false },
            push: { force: false },
        });
        expect(config.resources).toEqual({
            parallel: 2,
            updateCheckCocurrent: 1,
        });
    });

    test('accepts project git sync and push options', async () => {
        const configPath = await writeConfig(`
git:
  enabled: true
  remote: upstream
  branch: packages
  sync:
    allow_remote_overwrite_local: true
  push:
    force: true
maintainers:
  - id: johndoe
    name: John Doe
    email: john@example.com
default_maintainer: johndoe
packages:
  - pkgname: demo
`);

        const config = await loadConfig(configPath);

        expect(config.git).toMatchObject({
            enabled: true,
            remote: 'upstream',
            branch: 'packages',
            sync: { allow_remote_overwrite_local: true },
            push: { force: true },
        });
    });

    test('rejects unknown config keys', async () => {
        const configPath = await writeConfig(`
unknown: true
maintainers:
  - id: johndoe
    name: John Doe
    email: john@example.com
default_maintainer: johndoe
packages:
  - pkgname: demo
`);

        await expect(loadConfig(configPath)).rejects.toThrow(/Unrecognized key/);
    });

    test('fills missing package maintainer from default_maintainer', async () => {
        const configPath = await writeConfig(`
maintainers:
  - id: johndoe
    name: John Doe
    email: john@example.com
default_maintainer: johndoe
packages:
  - pkgname: demo
`);

        const config = await loadConfig(configPath);

        expect(config.packages[0]?.maintainer).toBe('johndoe');
    });

    test('rejects packages without maintainer when default_maintainer is not set', async () => {
        const configPath = await writeConfig(`
maintainers:
  - id: johndoe
    name: John Doe
    email: john@example.com
packages:
  - pkgname: demo
`);

        await expect(loadConfig(configPath)).rejects.toThrow(/missing maintainer/);
    });

    test('rejects unknown default_maintainer', async () => {
        const configPath = await writeConfig(`
maintainers:
  - id: johndoe
    name: John Doe
    email: john@example.com
default_maintainer: nobody
packages:
  - pkgname: demo
`);

        await expect(loadConfig(configPath)).rejects.toThrow(/unknown maintainer/);
    });

    test('resolves chroot pacman host include paths relative to config file', async () => {
        const configPath = await writeConfig(`
config:
  chrootPacman:
    include:
      - pacman-global.conf
    repositories:
      - name: localrepo
        siglevel:
          - Optional
          - TrustAll
        include:
          - pacman-localrepo.conf
        lines:
          - "Server = file:///srv/repo/$arch"
maintainers:
  - id: johndoe
    name: John Doe
    email: john@example.com
default_maintainer: johndoe
packages:
  - pkgname: demo
`);

        const config = await loadConfig(configPath);
        const configDir = path.dirname(configPath);

        expect(config.config?.chrootPacman?.include).toEqual([
            path.join(configDir, 'pacman-global.conf'),
        ]);
        expect(config.config?.chrootPacman?.repositories?.[0]).toMatchObject({
            name: 'localrepo',
            siglevel: ['Optional', 'TrustAll'],
            include: [path.join(configDir, 'pacman-localrepo.conf')],
            lines: ['Server = file:///srv/repo/$arch'],
        });
    });

    test('accepts package-level pre-build packages and scripts', async () => {
        const configPath = await writeConfig(`
maintainers:
  - id: johndoe
    name: John Doe
    email: john@example.com
default_maintainer: johndoe
packages:
  - pkgname: demo
    pre-build-packages:
      - custom-tool
    pre-build-scripts:
      - "echo preparing chroot"
`);

        const config = await loadConfig(configPath);

        expect(config.packages[0]?.['pre-build-packages']).toEqual(['custom-tool']);
        expect(config.packages[0]?.['pre-build-scripts']).toEqual(['echo preparing chroot']);
    });
});
