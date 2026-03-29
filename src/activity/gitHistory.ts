import { Git } from "../utils/git";

export interface GitHistoryEntry {
  hash: string;
  author: string;
  timestamp: number;
  message: string;
  files: string[];
}

export class GitHistory {
  private git: Git;

  constructor(vaultPath: string) {
    this.git = new Git(vaultPath);
  }

  async getRecentHistory(maxCount = 50): Promise<GitHistoryEntry[]> {
    return this.git.logNameOnly(maxCount);
  }

  async getChangesSince(sinceHash: string): Promise<GitHistoryEntry[]> {
    const all = await this.getRecentHistory(100);
    const entries: GitHistoryEntry[] = [];
    for (const entry of all) {
      if (entry.hash === sinceHash) break;
      entries.push(entry);
    }
    return entries;
  }

  async getChangedFilesSince(sinceHash: string): Promise<string[]> {
    try {
      return await this.git.diff(sinceHash);
    } catch {
      return [];
    }
  }
}
