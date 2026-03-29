import { Git } from "../utils/git";

export class ChangeBadges {
  private git: Git;
  private changedFiles: Set<string> = new Set();
  private lastSyncHead: string | null = null;

  constructor(vaultPath: string) {
    this.git = new Git(vaultPath);
  }

  async refresh(syncHead?: string): Promise<void> {
    this.changedFiles.clear();

    try {
      // Use provided syncHead or try to detect from last sync
      const ref = syncHead || (await this.getLastSyncRef());
      if (!ref) {
        // No reference — show all uncommitted changes
        const status = await this.git.statusFiles();
        for (const f of status) {
          this.changedFiles.add(f.path);
        }
        return;
      }

      const changed = await this.git.diff(ref);
      for (const file of changed) {
        this.changedFiles.add(file);
      }
    } catch {
      // Git errors — just show empty
    }
  }

  isChanged(filePath: string): boolean {
    return this.changedFiles.has(filePath);
  }

  getChangedFiles(): string[] {
    return Array.from(this.changedFiles);
  }

  getChangedCount(): number {
    return this.changedFiles.size;
  }

  setLastSyncHead(head: string): void {
    this.lastSyncHead = head;
  }

  private async getLastSyncRef(): Promise<string | null> {
    if (this.lastSyncHead) return this.lastSyncHead;

    try {
      // Use origin/main as reference
      const result = await this.git.showFile("origin/main", "");
      return "origin/main";
    } catch {
      return null;
    }
  }
}
