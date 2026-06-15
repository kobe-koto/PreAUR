import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveDevtoolsBuildTarget, writeChrootPacmanConfig } from '../src/chroot_pacman';

const tmpDirs: string[] = [];

async function makeBaseDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preaur-chroot-pacman-'));
    tmpDirs.push(dir);
    return dir;
}

afterEach(async () => {
    while (tmpDirs.length) {
        const dir = tmpDirs.pop()!;
        await fs.rm(dir, { recursive: true, force: true });
    }
});

describe('resolveDevtoolsBuildTarget', () => {
    test('resolves common devtools build wrapper names', () => {
        expect(resolveDevtoolsBuildTarget('extra-x86_64-build')).toEqual({ repo: 'extra', arch: 'x86_64' });
        expect(resolveDevtoolsBuildTarget('/usr/bin/multilib-build')).toEqual({ repo: 'multilib', arch: 'x86_64' });
        expect(resolveDevtoolsBuildTarget('core-testing-x86_64_v3-build')).toEqual({ repo: 'core-testing', arch: 'x86_64_v3' });
    });
});

describe('writeChrootPacmanConfig', () => {
    test('appends host includes, raw lines, and custom repositories to devtools pacman.conf', async () => {
        const baseDir = await makeBaseDir();
        const devtoolsDir = path.join(baseDir, 'devtools');
        await fs.mkdir(path.join(devtoolsDir, 'pacman.conf.d'), { recursive: true });
        await fs.writeFile(path.join(devtoolsDir, 'pacman.conf.d', 'extra.conf'), [
            '[options]',
            'Architecture = auto',
            '',
            '[core]',
            'Include = /etc/pacman.d/mirrorlist',
            '',
        ].join('\n'));

        const globalInclude = path.join(baseDir, 'global.conf');
        const repoInclude = path.join(baseDir, 'custom-repo.conf');
        await fs.writeFile(globalInclude, 'Color\n');
        await fs.writeFile(repoInclude, 'Server = file:///srv/custom/$arch\n');

        const outputPath = await writeChrootPacmanConfig({
            builderCmd: 'extra-x86_64-build',
            baseDir,
            devtoolsDir,
            config: {
                include: [globalInclude],
                lines: ['# raw global fragment'],
                repositories: [{
                    name: 'custom',
                    siglevel: ['Optional', 'TrustAll'],
                    include: [repoInclude],
                    lines: ['Usage = Sync Search'],
                }],
            },
        });

        const output = await fs.readFile(outputPath, 'utf8');
        expect(output).toContain('[options]\nArchitecture = auto');
        expect(output).toContain(`# PreAUR host include: ${globalInclude}\nColor`);
        expect(output).toContain('# raw global fragment');
        expect(output).toContain('[custom]\nSigLevel = Optional TrustAll');
        expect(output).toContain(`# PreAUR host include: ${repoInclude}\nServer = file:///srv/custom/$arch`);
        expect(output).toContain('Usage = Sync Search');
    });
});
