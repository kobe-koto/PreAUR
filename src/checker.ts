import axios from 'axios';
import * as zlib from 'node:zlib';
import { promisify } from 'node:util';
import type { PreaurChecker, PreaurDebChecker, PreaurGitHubChecker, PreaurRpmChecker } from './config';
import { constructMessager } from './logger';

const gunzip = promisify(zlib.gunzip);
const UpdateCheckerMessager = constructMessager('Update Checker');

function compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split(/[-_.]/);
    const parts2 = v2.split(/[-_.]/);
    const len = Math.max(parts1.length, parts2.length);

    for (let i = 0; i < len; i++) {
        const p1 = parts1[i] || '';
        const p2 = parts2[i] || '';

        const n1 = parseInt(p1, 10);
        const n2 = parseInt(p2, 10);

        if (!isNaN(n1) && !isNaN(n2)) {
            if (n1 !== n2) return n1 - n2;
        } else {
            if (p1 !== p2) return p1.localeCompare(p2);
        }
    }
    return 0;
}

export function applyVersionTemplate(template: string, version: string): Record<string, string> | null {
    const escapes = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const varNames: string[] = [];
    const regexStr = escapes.replace(/\\\{([a-zA-Z0-9_~]+)\\\}/g, (match, g1) => {
        varNames.push(g1);
        return '(.*?)';
    });

    const regex = new RegExp(`^${regexStr}$`, 'd');
    const match = regex.exec(version) as any;

    if (match) {
        const result: Record<string, { start: number, end: number }> = {};
        for (let i = 0; i < varNames.length; i++) {
            const vName = varNames[i] as string;
            const actualName = vName.startsWith('~') ? vName.slice(1) : vName;
            const indices = match.indices[i + 1];

            if (!result[actualName]) {
                result[actualName] = { start: indices[0], end: indices[1] };
            } else {
                result[actualName].start = Math.min(result[actualName].start, indices[0]);
                result[actualName].end = Math.max(result[actualName].end, indices[1]);
            }
        }

        const finalVars: Record<string, string> = {};
        for (const [key, span] of Object.entries(result)) {
            finalVars[key] = version.substring(span.start, span.end);
        }
        return finalVars;
    }
    return null;
}

export interface CheckerResult {
    version: string;
    epoch?: string;
}

const GITHUB_RELEASES_PER_PAGE = 100;
const GITHUB_RELEASES_MAX_PAGES = 5;

/** A configured template also acts as a filter: versions it cannot parse are ignored. */
function matchesTemplate(config: PreaurChecker, version: string): boolean {
    return !config.template || applyVersionTemplate(config.template, version) !== null;
}

function applyCommonTransforms(config: PreaurChecker, version: string): string {
    let result = version;
    if (config.strip_version) {
        result = result.split(/[-_]/)[0] || result;
    }
    return result;
}

/**
 * Turns a GitHub tag into a version, or returns null when the tag is filtered
 * out by prefix, suffix or template.
 */
export function transformGitHubTag(config: PreaurGitHubChecker, tag: string): string | null {
    let version = tag;

    if (config.prefix) {
        if (!version.startsWith(config.prefix)) return null;
        version = version.substring(config.prefix.length);
    } else {
        // Typically GitHub tags are "v1.0.0", Arch package versions prefer "1.0.0"
        version = version.replace(/^v/, '');
    }

    if (config.suffix) {
        if (!version.endsWith(config.suffix)) return null;
        version = version.substring(0, version.length - config.suffix.length);
    }

    version = applyCommonTransforms(config, version);

    if (config.normalize) {
        version = version.replace(/[:/\-\s]/g, '_');
    }

    if (!version || !matchesTemplate(config, version)) return null;
    return version;
}

interface VersionCandidate {
    version: string;
    epoch?: string;
}

function isNewerCandidate(candidate: VersionCandidate, current: VersionCandidate | undefined): boolean {
    if (!current) return true;
    const cmp = compareVersions(candidate.version, current.version);
    if (cmp !== 0) return cmp > 0;
    return !!candidate.epoch && (!current.epoch || parseInt(candidate.epoch, 10) > parseInt(current.epoch, 10));
}

/** Applies strip_version and template filtering, then picks the newest remaining candidate. */
export function selectLatestCandidate(config: PreaurChecker, candidates: VersionCandidate[]): CheckerResult | null {
    let latest: VersionCandidate | undefined;
    let latestFinal = '';

    for (const candidate of candidates) {
        const finalVersion = applyCommonTransforms(config, candidate.version);
        if (!matchesTemplate(config, finalVersion)) continue;

        if (isNewerCandidate(candidate, latest)) {
            latest = candidate;
            latestFinal = finalVersion;
        }
    }

    return latest ? { version: latestFinal, epoch: latest.epoch } : null;
}

export interface CheckerProvider<T extends PreaurChecker = PreaurChecker> {
    name: T['type'];
    check(config: T): Promise<CheckerResult>;
}

export class GitHubProvider implements CheckerProvider<PreaurGitHubChecker> {
    name = 'github' as const;

    async check(config: PreaurGitHubChecker): Promise<CheckerResult> {
        const { repo, use } = config;
        if (!repo) throw new Error('GitHub provider requires a "repo" configuration.');

        const headers: Record<string, string> = {
            'Accept': 'application/vnd.github.v3+json',
        };

        if (process.env.GITHUB_TOKEN) {
            headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
        }

        const includePrerelease = use === 'prerelease';
        const hasFilters = !!(config.prefix || config.suffix || config.template);

        try {
            // Without filters, keep relying on GitHub's own "latest release" designation.
            if (!includePrerelease && !hasFilters) {
                const response = await axios.get(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
                const tag = response.data?.tag_name;
                if (!tag) {
                    throw new Error('Could not determine tag_name from GitHub API response');
                }

                const version = transformGitHubTag(config, tag);
                if (!version) {
                    throw new Error(`Latest release tag ${tag} produced an empty version`);
                }
                return { version };
            }

            // Otherwise walk releases newest-first and take the first one that passes the filters.
            for (let page = 1; page <= GITHUB_RELEASES_MAX_PAGES; page++) {
                const response = await axios.get(`https://api.github.com/repos/${repo}/releases`, {
                    headers,
                    params: { per_page: GITHUB_RELEASES_PER_PAGE, page },
                });
                const releases = Array.isArray(response.data) ? response.data : [];

                for (const release of releases) {
                    if (release?.draft) continue;
                    if (release?.prerelease && !includePrerelease) continue;
                    if (typeof release?.tag_name !== 'string') continue;

                    const version = transformGitHubTag(config, release.tag_name);
                    if (version) return { version };
                }

                if (releases.length < GITHUB_RELEASES_PER_PAGE) break;
            }

            const filters = [
                config.prefix ? `prefix "${config.prefix}"` : '',
                config.suffix ? `suffix "${config.suffix}"` : '',
                config.template ? `template "${config.template}"` : '',
            ].filter(Boolean).join(', ');
            throw new Error(`No ${includePrerelease ? '' : 'non-prerelease '}GitHub release matched${filters ? ` ${filters}` : ''} in the newest ${GITHUB_RELEASES_PER_PAGE * GITHUB_RELEASES_MAX_PAGES} releases`);
        } catch (error: any) {
            console.error(UpdateCheckerMessager(`Failed to fetch version from GitHub for ${repo}: ${error.message}`));
            throw error;
        }
    }
}

export class DebProvider implements CheckerProvider<PreaurDebChecker> {
    name = 'deb' as const;

    async check(config: PreaurDebChecker): Promise<CheckerResult> {
        const { url, pkg, dist, component, arch = 'amd64' } = config;
        if (!url || !pkg || !dist || !component) {
            throw new Error('Deb provider requires "url", "pkg", "dist", and "component" configuration.');
        }

        const baseUrl = url.replace(/\/$/, '');
        const packagesUrl = `${baseUrl}/dists/${dist}/${component}/binary-${arch}/Packages`;
        let data = '';

        try {
            const response = await axios.get(packagesUrl, { responseType: 'text' });
            data = response.data;
        } catch (e: any) {
            if (e.response && e.response.status === 404) {
                // Try gzipped fallback
                try {
                    const gzResponse = await axios.get(`${packagesUrl}.gz`, { responseType: 'arraybuffer' });
                    const unzipped = await gunzip(gzResponse.data);
                    data = unzipped.toString('utf-8');
                } catch (gzErr: any) {
                    throw new Error(`Failed to fetch Packages list from ${packagesUrl} or ${packagesUrl}.gz`);
                }
            } else {
                throw new Error(`Failed to fetch Packages list from ${packagesUrl}: ${e.message}`);
            }
        }

        // Parse Debian Control format
        const blocks = data.split(/\n\s*\n/);
        const candidates: VersionCandidate[] = [];

        for (const block of blocks) {
            const pkgMatch = block.match(/^Package:\s*(.+)$/m);
            if (pkgMatch && pkgMatch[1]?.trim() === pkg) {
                const verMatch = block.match(/^Version:\s*(.+)$/m);
                if (verMatch && verMatch[1]) {
                    let version = verMatch[1].trim();
                    let epoch: string | undefined = undefined;

                    const epochMatch = version.match(/^(\d+):/);
                    if (epochMatch) {
                        epoch = epochMatch[1];
                        version = version.substring(epochMatch[0].length);
                    }

                    // Arch Linux packages usually replace hyphens with underscores
                    // e.g., 1.86.0-1706698114 -> 1.86.0_1706698114
                    version = version.replace(/-/g, '_');
                    candidates.push({ version, epoch });
                }
            }
        }

        if (candidates.length === 0) {
            throw new Error(`Package ${pkg} not found in Debian repository.`);
        }

        const latest = selectLatestCandidate(config, candidates);
        if (!latest) {
            throw new Error(`No version of ${pkg} in Debian repository matched template "${config.template}".`);
        }
        return latest;
    }
}

export class RpmProvider implements CheckerProvider<PreaurRpmChecker> {
    name = 'rpm' as const;

    async check(config: PreaurRpmChecker): Promise<CheckerResult> {
        const { url, pkg } = config;
        if (!url || !pkg) {
            throw new Error('Rpm provider requires "url" and "pkg" configuration.');
        }

        const baseUrl = url.replace(/\/$/, '');
        const repomdUrl = `${baseUrl}/repodata/repomd.xml`;
        let repomdXml = '';

        try {
            const response = await axios.get(repomdUrl, { responseType: 'text' });
            repomdXml = response.data;
        } catch (e: any) {
            throw new Error(`Failed to fetch repomd.xml from ${repomdUrl}: ${e.message}`);
        }

        // Match primary sqlite or xml package mapping
        // Usually <data type="primary"><location href="repodata/0e6ef...-primary.xml.gz"/></data>
        const primaryLocMatch = repomdXml.match(/<data type="primary">[\s\S]*?<location href="([^"]+)"\s*\/>/);
        if (!primaryLocMatch) {
            throw new Error('Could not find primary database location in repomd.xml');
        }

        const primaryUrl = `${baseUrl}/${primaryLocMatch[1]}`;
        let primaryXml = '';

        try {
            const dbResponse = await axios.get(primaryUrl, { responseType: 'arraybuffer' });
            const unzipped = await gunzip(dbResponse.data);
            primaryXml = unzipped.toString('utf-8');
        } catch (dbErr: any) {
            throw new Error(`Failed to fetch primary.xml.gz from ${primaryUrl}: ${dbErr.message}`);
        }

        const packageBlocks = primaryXml.split('</package>');
        const candidates: VersionCandidate[] = [];

        const escapedPkg = pkg.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
        const nameRegex = new RegExp(`<name>${escapedPkg}</name>`);
        const versionRegex = /<version\s+([^>]+)\/?>/;

        for (const block of packageBlocks) {
            if (nameRegex.test(block)) {
                const match = block.match(versionRegex);
                if (match && match[1]) {
                    const attrs = match[1];
                    const verMatch = attrs.match(/ver="([^"]+)"/);
                    const relMatch = attrs.match(/rel="([^"]+)"/);
                    const epochMatch = attrs.match(/epoch="([^"]+)"/);

                    if (verMatch && verMatch[1]) {
                        let version = verMatch[1];
                        if (relMatch && relMatch[1]) {
                            version += `_${relMatch[1].replace(/-/g, '_')}`;
                        }
                        version = version.replace(/-/g, '_');
                        const epoch = epochMatch && epochMatch[1] && epochMatch[1] !== '0' ? epochMatch[1] : undefined;
                        candidates.push({ version, epoch });
                    }
                }
            }
        }

        if (candidates.length === 0) {
            throw new Error(`Package ${pkg} not found in RPM repository.`);
        }

        const latest = selectLatestCandidate(config, candidates);
        if (!latest) {
            throw new Error(`No version of ${pkg} in RPM repository matched template "${config.template}".`);
        }
        return latest;
    }
}

class CheckerRegistry {
    private providers: Map<string, CheckerProvider> = new Map();

    register(provider: CheckerProvider) {
        this.providers.set(provider.name, provider);
    }

    get(name: string): CheckerProvider | undefined {
        return this.providers.get(name);
    }
}

export const checkerRegistry = new CheckerRegistry();
checkerRegistry.register(new GitHubProvider());
checkerRegistry.register(new DebProvider());
checkerRegistry.register(new RpmProvider());

export async function fetchLatestVersion(config: PreaurChecker): Promise<CheckerResult | null> {
    const provider = checkerRegistry.get(config.type);
    if (!provider) {
        console.warn(UpdateCheckerMessager(`Unknown checker type: ${config.type}`));
        return null;
    }

    return provider.check(config);
}
