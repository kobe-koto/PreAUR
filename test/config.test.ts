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
});
