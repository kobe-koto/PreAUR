import axios from 'axios';
import * as zlib from 'node:zlib';
import { promisify } from 'node:util';
import type { PreaurChecker, PreaurDebChecker, PreaurGitHubChecker, PreaurRpmChecker } from './config';

const gunzip = promisify(zlib.gunzip);

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

        const typeFilter = use === 'prerelease' ? 'releases' : 'releases/latest';
        const url = `https://api.github.com/repos/${repo}/${typeFilter}`;

        try {
            const response = await axios.get(url, { headers });

            let releaseData = response.data;

            // If asking for prerelease (which queries /releases), find the first prerelease or fallback to latest
            if (use === 'prerelease' && Array.isArray(releaseData)) {
                releaseData = releaseData[0]; // The first one is the most recent
            }

            if (!releaseData || !releaseData.tag_name) {
                throw new Error('Could not determine tag_name from GitHub API response');
            }

            let tag = releaseData.tag_name;

            if (config.prefix && tag.startsWith(config.prefix)) {
                tag = tag.substring(config.prefix.length);
            } else if (!config.prefix) {
                // Typically GitHub tags are "v1.0.0", Arch package versions prefer "1.0.0"
                tag = tag.replace(/^v/, '');
            }

            if (config.suffix && tag.endsWith(config.suffix)) {
                tag = tag.substring(0, tag.length - config.suffix.length);
            }

            if (config.strip_version) {
                tag = tag.split(/[-_]/)[0] || tag;
            }

            if (config.normalize) {
                tag = tag.replace(/[:/\-\s]/g, '_');
            }

            return { version: tag };
        } catch (error: any) {
            console.error(`[Checker] Failed to fetch version from GitHub for ${repo}: ${error.message}`);
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
        let latestVersion = '';

        let latestEpoch: string | undefined = undefined;

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

                    if (!latestVersion || compareVersions(version, latestVersion) > 0 || (version === latestVersion && epoch && (!latestEpoch || parseInt(epoch, 10) > parseInt(latestEpoch, 10)))) {
                        latestVersion = version;
                        latestEpoch = epoch;
                    }
                }
            }
        }

        if (latestVersion) {
            let finalVersion = latestVersion;
            if (config.strip_version) {
                finalVersion = finalVersion.split(/[-_]/)[0] || finalVersion;
            }
            return { version: finalVersion, epoch: latestEpoch };
        }

        throw new Error(`Package ${pkg} not found in Debian repository.`);
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
        let latestVersion = '';
        let latestEpoch: string | undefined = undefined;

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
                        let epoch = epochMatch && epochMatch[1] && epochMatch[1] !== '0' ? epochMatch[1] : undefined;

                        if (!latestVersion || compareVersions(version, latestVersion) > 0 || (version === latestVersion && epoch && (!latestEpoch || parseInt(epoch, 10) > parseInt(latestEpoch, 10)))) {
                            latestVersion = version;
                            latestEpoch = epoch;
                        }
                    }
                }
            }
        }

        if (latestVersion) {
            let finalVersion = latestVersion;
            if (config.strip_version) {
                finalVersion = finalVersion.split(/[-_]/)[0] || finalVersion;
            }
            return { version: finalVersion, epoch: latestEpoch };
        }

        throw new Error(`Package ${pkg} not found in RPM repository.`);
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
        console.warn(`[Checker] Unknown checker type: ${config.type}`);
        return null;
    }

    return provider.check(config);
}
