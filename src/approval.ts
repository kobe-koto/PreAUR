import axios from 'axios';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { PreaurPackage } from './config';
import { VersionStore, type VersionInfo } from './version_store';

const UNAPPROVED_PREFIX = '!!!';

export interface AurPackageMetadata {
    name: string;
    maintainer: string | null;
    coMaintainers: string[];
}

export interface ApprovalCheckResult {
    buildablePackages: PreaurPackage[];
    skippedPackages: Array<{ pkg: PreaurPackage; reason: string }>;
}

export type AurMetadataFetcher = (pkgnames: string[]) => Promise<Map<string, AurPackageMetadata>>;

export class KnownListStore {
    private entries = new Map<string, boolean>();

    constructor(private readonly filePath: string) {}

    async load(): Promise<void> {
        this.entries.clear();

        try {
            const parent = path.dirname(this.filePath);
            await fs.mkdir(parent, { recursive: true });
            const content = await fs.readFile(this.filePath, 'utf8');

            for (const rawLine of content.split(/\r?\n/)) {
                const line = rawLine.trim();
                if (!line) continue;

                if (line.startsWith(UNAPPROVED_PREFIX)) {
                    const value = line.slice(UNAPPROVED_PREFIX.length).trim();
                    if (value) this.entries.set(value, false);
                } else {
                    this.entries.set(line, true);
                }
            }
        } catch (e: any) {
            if (e.code !== 'ENOENT') throw e;
        }
    }

    async save(): Promise<void> {
        const parent = path.dirname(this.filePath);
        await fs.mkdir(parent, { recursive: true });

        const lines = [...this.entries.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([value, approved]) => approved ? value : `${UNAPPROVED_PREFIX} ${value}`);

        await fs.writeFile(this.filePath, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8');
    }

    ensure(value: string): void {
        if (!this.entries.has(value)) {
            this.entries.set(value, false);
        }
    }

    markUnapproved(value: string): void {
        this.entries.set(value, false);
    }

    isApproved(value: string): boolean {
        return this.entries.get(value) === true;
    }
}

export function normalizeCoMaintainers(value: unknown): string[] {
    if (!Array.isArray(value)) return [];

    return [...new Set(
        value
            .filter((item): item is string => typeof item === 'string')
            .map(item => item.trim())
            .filter(Boolean)
    )].sort((a, b) => a.localeCompare(b));
}

function sameMaintainerSnapshot(current: VersionInfo | undefined, next: AurPackageMetadata): boolean {
    if (!current || !('maintainer' in current) || !Array.isArray(current.co_maintainers)) {
        return true;
    }

    const currentCoMaintainers = normalizeCoMaintainers(current.co_maintainers);
    return current.maintainer === next.maintainer
        && currentCoMaintainers.length === next.coMaintainers.length
        && currentCoMaintainers.every((value, index) => value === next.coMaintainers[index]);
}

export async function fetchAurPackageMetadata(pkgnames: string[]): Promise<Map<string, AurPackageMetadata>> {
    const uniqueNames = [...new Set(pkgnames)].sort((a, b) => a.localeCompare(b));
    const metadata = new Map<string, AurPackageMetadata>();
    const batchSize = 100;

    for (let i = 0; i < uniqueNames.length; i += batchSize) {
        const batch = uniqueNames.slice(i, i + batchSize);
        const query = batch.map(name => `arg[]=${encodeURIComponent(name)}`).join('&');
        const url = `https://aur.archlinux.org/rpc/v5/info?${query}`;
        const response = await axios.get(url);
        const results = Array.isArray(response.data?.results) ? response.data.results : [];

        for (const item of results) {
            if (typeof item?.Name !== 'string') continue;

            metadata.set(item.Name, {
                name: item.Name,
                maintainer: typeof item.Maintainer === 'string' ? item.Maintainer : null,
                coMaintainers: normalizeCoMaintainers(item.CoMaintainers),
            });
        }
    }

    const missing = uniqueNames.filter(name => !metadata.has(name));
    if (missing.length > 0) {
        throw new Error(`AUR metadata not found for package(s): ${missing.join(', ')}`);
    }

    return metadata;
}

export async function runApprovalCheck(
    packages: PreaurPackage[],
    versionStore: VersionStore,
    baseDir: string = process.cwd(),
    fetcher: AurMetadataFetcher = fetchAurPackageMetadata
): Promise<ApprovalCheckResult> {
    console.log(`[Check] Checking AUR ownership metadata for ${packages.length} package(s)...`);

    const dataDir = path.resolve(baseDir, 'data');
    const knownPackages = new KnownListStore(path.resolve(dataDir, 'known_packages'));
    const knownMaintainers = new KnownListStore(path.resolve(dataDir, 'known_maintainers'));

    await knownPackages.load();
    await knownMaintainers.load();

    const metadataByPackage = await fetcher(packages.map(pkg => pkg.pkgname));
    const unapprovedPackages = new Set<string>();
    const unapprovedMaintainers = new Set<string>();
    const buildablePackages: PreaurPackage[] = [];
    const skippedPackages: ApprovalCheckResult['skippedPackages'] = [];

    for (const pkg of packages) {
        const metadata = metadataByPackage.get(pkg.pkgname);
        if (!metadata) {
            throw new Error(`AUR metadata not found for package: ${pkg.pkgname}`);
        }

        knownPackages.ensure(pkg.pkgname);

        const previous = versionStore.get(pkg.pkgname);
        if (!sameMaintainerSnapshot(previous, metadata)) {
            console.warn(`[Check] AUR maintainer ownership changed for ${pkg.pkgname}; marking package unapproved.`);
            knownPackages.markUnapproved(pkg.pkgname);
        }

        const maintainers = [
            ...(metadata.maintainer ? [metadata.maintainer] : []),
            ...metadata.coMaintainers,
        ];

        for (const maintainer of maintainers) {
            knownMaintainers.ensure(maintainer);
        }

        versionStore.set(pkg.pkgname, {
            maintainer: metadata.maintainer,
            co_maintainers: metadata.coMaintainers,
        });

        if (!knownPackages.isApproved(pkg.pkgname)) {
            unapprovedPackages.add(pkg.pkgname);
        }

        for (const maintainer of maintainers) {
            if (!knownMaintainers.isApproved(maintainer)) {
                unapprovedMaintainers.add(maintainer);
            }
        }

        if (metadata.maintainer === null && pkg.allow_orphan_package_build !== true) {
            skippedPackages.push({
                pkg,
                reason: 'AUR package is orphan and allow_orphan_package_build is not true',
            });
        } else {
            buildablePackages.push(pkg);
        }
    }

    await knownPackages.save();
    await knownMaintainers.save();
    await versionStore.save();

    if (unapprovedPackages.size > 0 || unapprovedMaintainers.size > 0) {
        const details = [
            unapprovedPackages.size > 0 ? `packages: ${[...unapprovedPackages].sort().join(', ')}` : '',
            unapprovedMaintainers.size > 0 ? `maintainers: ${[...unapprovedMaintainers].sort().join(', ')}` : '',
        ].filter(Boolean).join('; ');

        throw new Error(`Unapproved AUR ownership entries found (${details}). Approve them in data/known_packages and data/known_maintainers before building.`);
    }

    for (const skipped of skippedPackages) {
        console.log(`[Check] Skipping ${skipped.pkg.pkgname}: ${skipped.reason}.`);
    }

    return { buildablePackages, skippedPackages };
}
