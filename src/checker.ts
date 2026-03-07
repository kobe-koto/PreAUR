import axios from 'axios';
import * as zlib from 'node:zlib';
import { promisify } from 'node:util';
import type { PreaurChecker } from './config';

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

export interface CheckerProvider {
  name: string;
  check(config: PreaurChecker): Promise<string>;
}

export class GitHubProvider implements CheckerProvider {
  name = 'github';

  async check(config: PreaurChecker): Promise<string> {
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

      return tag;
    } catch (error: any) {
      console.error(`[Checker] Failed to fetch version from GitHub for ${repo}: ${error.message}`);
      throw error;
    }
  }
}

export class DebProvider implements CheckerProvider {
  name = 'deb';

  async check(config: PreaurChecker): Promise<string> {
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

    for (const block of blocks) {
      const pkgMatch = block.match(/^Package:\s*(.+)$/m);
      if (pkgMatch && pkgMatch[1]?.trim() === pkg) {
        const verMatch = block.match(/^Version:\s*(.+)$/m);
        if (verMatch && verMatch[1]) {
          let version = verMatch[1].trim();
          // Arch Linux packages usually replace hyphens with underscores
          // e.g., 1.86.0-1706698114 -> 1.86.0_1706698114
          version = version.replace(/-/g, '_');
          // Optional: strip epochs if any (e.g. 1:1.86.0 -> 1.86.0)
          version = version.replace(/^\d+:/, '');
          
          if (!latestVersion || compareVersions(version, latestVersion) > 0) {
            latestVersion = version;
          }
        }
      }
    }

    if (latestVersion) {
      if (config.strip_version) {
        return latestVersion.split(/[-_]/)[0] || latestVersion;
      }
      return latestVersion;
    }

    throw new Error(`Package ${pkg} not found in Debian repository.`);
  }
}

export class RpmProvider implements CheckerProvider {
  name = 'rpm';

  async check(config: PreaurChecker): Promise<string> {
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

    // Parse chunks of package blocks to avoid crazy regex traversal
    const packageBlocks = primaryXml.split('</package>');
    let latestVersion = '';

    const escapedPkg = pkg.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const nameRegex = new RegExp(`<name>${escapedPkg}</name>`);
    const versionRegex = /<version[^>]+ver="([^"]+)"(?:[^>]+rel="([^"]+)")?[^>]*\/>/;

    for (const block of packageBlocks) {
      if (nameRegex.test(block)) {
        const match = block.match(versionRegex);
        if (match && match[1]) {
          let version = match[1];
          // optionally, we append the rel version replacing hyphens
          if (match[2]) {
              version += `_${match[2].replace(/-/g, '_')}`;
          }
          // replace any internal hyphens with underscores
          version = version.replace(/-/g, '_');

          if (!latestVersion || compareVersions(version, latestVersion) > 0) {
             latestVersion = version;
          }
        }
      }
    }
    
    if (latestVersion) {
      if (config.strip_version) {
        return latestVersion.split(/[-_]/)[0] || latestVersion;
      }
      return latestVersion;
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

export async function fetchLatestVersion(config: PreaurChecker): Promise<string | null> {
  const provider = checkerRegistry.get(config.type);
  if (!provider) {
    console.warn(`[Checker] Unknown checker type: ${config.type}`);
    return null;
  }

  return provider.check(config);
}
