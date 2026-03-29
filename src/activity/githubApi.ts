import { requestUrl } from "obsidian";
import type {
  GitHubCommit,
  GitHubPullRequest,
  GitHubRateLimit,
} from "../utils/github";
import type { TeamVaultSettings } from "../settings";

export class GitHubApi {
  private etagCache: Map<string, { etag: string; data: unknown }> = new Map();
  private rateLimit: GitHubRateLimit = { remaining: 5000, reset: 0 };

  constructor(private settings: TeamVaultSettings) {}

  private get headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "TeamVault-Obsidian",
    };
    if (this.settings.githubPat) {
      h["Authorization"] = `Bearer ${this.settings.githubPat}`;
    }
    return h;
  }

  private get baseUrl(): string {
    return `https://api.github.com/repos/${this.settings.githubRepo}`;
  }

  private async request<T>(
    path: string,
    useEtag = true
  ): Promise<T | null> {
    if (this.rateLimit.remaining <= 10) {
      const now = Math.floor(Date.now() / 1000);
      if (now < this.rateLimit.reset) {
        return null; // Rate limited
      }
    }

    const url = `${this.baseUrl}${path}`;
    const headers = { ...this.headers };

    // ETag caching
    if (useEtag) {
      const cached = this.etagCache.get(url);
      if (cached) {
        headers["If-None-Match"] = cached.etag;
      }
    }

    try {
      const response = await requestUrl({
        url,
        headers,
        method: "GET",
      });

      // Update rate limit
      const remaining = response.headers["x-ratelimit-remaining"];
      const reset = response.headers["x-ratelimit-reset"];
      if (remaining) this.rateLimit.remaining = parseInt(remaining, 10);
      if (reset) this.rateLimit.reset = parseInt(reset, 10);

      // Handle 304 Not Modified
      if (response.status === 304) {
        const cached = this.etagCache.get(url);
        return cached ? (cached.data as T) : null;
      }

      // Cache with ETag
      const etag = response.headers["etag"];
      if (etag) {
        this.etagCache.set(url, { etag, data: response.json });
      }

      return response.json as T;
    } catch (err) {
      // Network errors, 404s, etc — return null
      return null;
    }
  }

  async getRecentCommits(count = 30): Promise<GitHubCommit[]> {
    const result = await this.request<GitHubCommit[]>(
      `/commits?per_page=${count}`
    );
    return result || [];
  }

  async getOpenPullRequests(): Promise<GitHubPullRequest[]> {
    const result = await this.request<GitHubPullRequest[]>(
      "/pulls?state=open&per_page=10"
    );
    return result || [];
  }

  async getRecentPullRequests(count = 10): Promise<GitHubPullRequest[]> {
    const result = await this.request<GitHubPullRequest[]>(
      `/pulls?state=all&per_page=${count}&sort=updated&direction=desc`
    );
    return result || [];
  }

  getRateLimitInfo(): GitHubRateLimit {
    return { ...this.rateLimit };
  }
}
