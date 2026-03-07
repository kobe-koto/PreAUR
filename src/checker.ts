import axios from 'axios';
import type { PreaurChecker } from './config';

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

      // Typically GitHub tags are "v1.0.0", Arch package versions prefer "1.0.0"
      return releaseData.tag_name.replace(/^v/, '');
    } catch (error: any) {
      console.error(`[Checker] Failed to fetch version from GitHub for ${repo}: ${error.message}`);
      throw error;
    }
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

export async function fetchLatestVersion(config: PreaurChecker): Promise<string | null> {
  const provider = checkerRegistry.get(config.type);
  if (!provider) {
    console.warn(`[Checker] Unknown checker type: ${config.type}`);
    return null;
  }

  return provider.check(config);
}
