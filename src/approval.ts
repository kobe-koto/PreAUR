import axios from 'axios';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { PreaurPackage } from './config';
import { VersionStore, type VersionInfo } from './version_store';

const UNAPPROVED_PREFIX = '!!!';
const BUILTIN_TRUSTED_AUR_GIT_PREFIXES = [
    'ssh://aur@aur.archlinux.org/',
    'https://aur.archlinux.org/',
];

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

interface PackageSource {
    type: 'aur' | 'custom_git';
    aurPkgname?: string;
}

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
                const line = stripComment(rawLine);
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

    async save(comments: Map<string, string> = new Map()): Promise<void> {
        const parent = path.dirname(this.filePath);
        await fs.mkdir(parent, { recursive: true });

        const lines = [...this.entries.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([value, approved]) => {
                const entry = approved ? value : `${UNAPPROVED_PREFIX} ${value}`;
                const comment = comments.get(value);
                return comment ? `${entry} # ${comment}` : entry;
            });

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

function stripComment(line: string): string {
    const commentIndex = line.indexOf('#');
    return (commentIndex === -1 ? line : line.slice(0, commentIndex)).trim();
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
    if (current?.source === 'custom_git') {
        return false;
    }

    if (!current || !('maintainer' in current) || !Array.isArray(current.co_maintainers)) {
        return true;
    }

    const currentCoMaintainers = normalizeCoMaintainers(current.co_maintainers);
    const currentAurPkgname = current.aur_pkgname ?? next.name;

    return currentAurPkgname === next.name
        && current.maintainer === next.maintainer
        && currentCoMaintainers.length === next.coMaintainers.length
        && currentCoMaintainers.every((value, index) => value === next.coMaintainers[index]);
}

function sameCustomGitSnapshot(current: VersionInfo | undefined): boolean {
    if (!current) return true;
    if (current.source === 'custom_git') return true;

    return current.source === undefined
        && !('maintainer' in current)
        && !Array.isArray(current.co_maintainers);
}

function metadataFromVersionInfo(pkgname: string, info: VersionInfo): AurPackageMetadata | null {
    if (!('maintainer' in info) || !Array.isArray(info.co_maintainers)) {
        return null;
    }

    return {
        name: info.aur_pkgname ?? pkgname,
        maintainer: info.maintainer ?? null,
        coMaintainers: normalizeCoMaintainers(info.co_maintainers),
    };
}

function packageComment(pkgname: string, info: VersionInfo, metadata: AurPackageMetadata): string {
    const maintainers = [
        metadata.maintainer ?? 'orphan',
        ...metadata.coMaintainers,
    ];

    const aurPrefix = info.aur_pkgname && info.aur_pkgname !== pkgname
        ? `AUR: ${info.aur_pkgname}; `
        : '';

    return `${aurPrefix}Maintainer: ${maintainers.join(', ')}`;
}

function buildKnownListComments(versionStore: VersionStore): {
    packageComments: Map<string, string>;
    maintainerComments: Map<string, string>;
} {
    const packageComments = new Map<string, string>();
    const maintainerPackages = new Map<string, Set<string>>();

    for (const [pkgname, info] of versionStore.entries()) {
        if (info.source === 'custom_git') {
            packageComments.set(pkgname, 'Source: custom git');
            continue;
        }

        const metadata = metadataFromVersionInfo(pkgname, info);
        if (!metadata) continue;

        packageComments.set(pkgname, packageComment(pkgname, info, metadata));

        const maintainers = [
            ...(metadata.maintainer ? [metadata.maintainer] : []),
            ...metadata.coMaintainers,
        ];

        for (const maintainer of maintainers) {
            if (!maintainerPackages.has(maintainer)) {
                maintainerPackages.set(maintainer, new Set());
            }
            maintainerPackages.get(maintainer)!.add(pkgname);
        }
    }

    const maintainerComments = new Map<string, string>();
    for (const [maintainer, packages] of maintainerPackages.entries()) {
        const sortedPackages = [...packages].sort((a, b) => a.localeCompare(b));
        maintainerComments.set(maintainer, `Maintaining: ${sortedPackages.join(', ')}`);
    }

    return { packageComments, maintainerComments };
}

export function resolvePackageSource(
    pkg: PreaurPackage,
    trustedAurGitPrefixes: string[] = []
): PackageSource {
    if (pkg.aur_pkgname) {
        return { type: 'aur', aurPkgname: pkg.aur_pkgname };
    }

    if (!pkg.git) {
        return { type: 'aur', aurPkgname: pkg.pkgname };
    }

    const prefixes = [
        ...BUILTIN_TRUSTED_AUR_GIT_PREFIXES,
        ...trustedAurGitPrefixes,
    ].filter(Boolean);

    for (const prefix of prefixes) {
        if (!pkg.git.startsWith(prefix)) continue;

        const aurPkgname = deriveAurPkgnameFromGit(pkg.git, prefix);
        if (!aurPkgname) {
            throw new Error(`Could not derive AUR package name from trusted git URL for ${pkg.pkgname}: ${pkg.git}`);
        }

        return { type: 'aur', aurPkgname };
    }

    return { type: 'custom_git' };
}

function deriveAurPkgnameFromGit(gitUrl: string, prefix: string): string | null {
    const remainder = gitUrl
        .slice(prefix.length)
        .split(/[?#]/)[0]
        ?.replace(/\/+$/, '');

    const lastSegment = remainder
        ?.split('/')
        .filter(Boolean)
        .at(-1);

    if (!lastSegment) return null;

    const withoutGitSuffix = lastSegment.endsWith('.git')
        ? lastSegment.slice(0, -'.git'.length)
        : lastSegment;

    return withoutGitSuffix ? decodeURIComponent(withoutGitSuffix) : null;
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
    fetcher: AurMetadataFetcher = fetchAurPackageMetadata,
    trustedAurGitPrefixes: string[] = []
): Promise<ApprovalCheckResult> {
    console.log(`[Check] Checking AUR ownership metadata for ${packages.length} package(s)...`);

    const dataDir = path.resolve(baseDir, 'data');
    const knownPackages = new KnownListStore(path.resolve(dataDir, 'known_packages'));
    const knownMaintainers = new KnownListStore(path.resolve(dataDir, 'known_maintainers'));

    await knownPackages.load();
    await knownMaintainers.load();

    const sourcesByPackage = new Map<string, PackageSource>();
    const aurPkgnames = new Set<string>();

    for (const pkg of packages) {
        const source = resolvePackageSource(pkg, trustedAurGitPrefixes);
        sourcesByPackage.set(pkg.pkgname, source);

        if (source.type === 'aur' && source.aurPkgname) {
            aurPkgnames.add(source.aurPkgname);
        }
    }

    const aurPkgnameList = [...aurPkgnames];
    const metadataByPackage = aurPkgnameList.length > 0
        ? await fetcher(aurPkgnameList)
        : new Map<string, AurPackageMetadata>();
    const unapprovedPackages = new Set<string>();
    const unapprovedMaintainers = new Set<string>();
    const buildablePackages: PreaurPackage[] = [];
    const skippedPackages: ApprovalCheckResult['skippedPackages'] = [];

    for (const pkg of packages) {
        knownPackages.ensure(pkg.pkgname);
        const source = sourcesByPackage.get(pkg.pkgname);

        if (!source) {
            throw new Error(`Could not resolve package source for ${pkg.pkgname}`);
        }

        if (source.type === 'custom_git') {
            const previous = versionStore.get(pkg.pkgname);
            if (!sameCustomGitSnapshot(previous)) {
                console.warn(`[Check] Package source changed to custom git for ${pkg.pkgname}; marking package unapproved.`);
                knownPackages.markUnapproved(pkg.pkgname);
            }

            versionStore.set(pkg.pkgname, {
                source: 'custom_git',
                aur_pkgname: undefined,
                maintainer: undefined,
                co_maintainers: undefined,
            });

            if (!knownPackages.isApproved(pkg.pkgname)) {
                unapprovedPackages.add(pkg.pkgname);
            }

            buildablePackages.push(pkg);
        } else {
            const metadata = metadataByPackage.get(source.aurPkgname!);
            if (!metadata) {
                throw new Error(`AUR metadata not found for package: ${source.aurPkgname}`);
            }

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
                source: 'aur',
                aur_pkgname: source.aurPkgname,
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
    }

    await versionStore.save();

    const { packageComments, maintainerComments } = buildKnownListComments(versionStore);
    await knownPackages.save(packageComments);
    await knownMaintainers.save(maintainerComments);

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
