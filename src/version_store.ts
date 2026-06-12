import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface VersionInfo {
    epoch?: string;
    pkgver?: string;
    pkgrel?: number;
    maintainer?: string | null;
    co_maintainers?: string[];
}

export class VersionStore {
    private dataFile: string;
    private data: Record<string, VersionInfo> = {};

    constructor(baseDir: string = process.cwd()) {
        this.dataFile = path.resolve(baseDir, 'data', 'versions.json');
    }

    async load() {
        try {
            const parent = path.dirname(this.dataFile);
            await fs.mkdir(parent, { recursive: true });
            const content = await fs.readFile(this.dataFile, 'utf8');
            this.data = JSON.parse(content);
        } catch (e: any) {
            this.data = {};
        }
    }

    async save() {
        const parent = path.dirname(this.dataFile);
        await fs.mkdir(parent, { recursive: true });
        await fs.writeFile(this.dataFile, JSON.stringify(this.data, null, 2), 'utf8');
    }

    get(pkgname: string): VersionInfo | undefined {
        return this.data[pkgname];
    }

    set(pkgname: string, info: VersionInfo) {
        this.data[pkgname] = {
            ...this.data[pkgname],
            ...info,
        };
    }
}
