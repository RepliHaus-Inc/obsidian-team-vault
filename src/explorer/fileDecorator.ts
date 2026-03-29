import type TeamVaultPlugin from "../main";
import type { CommentStore } from "../comments/commentStore";
import { ChangeBadges } from "./badges";

export class FileDecorator {
  private badges: ChangeBadges;
  private plugin: TeamVaultPlugin;
  private commentStore: CommentStore;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private observer: MutationObserver | null = null;
  /** Cached badge data so re-apply is synchronous and doesn't need async refresh */
  private cachedChangedFiles: Set<string> = new Set();
  private cachedCommentCounts: Map<string, number> = new Map();
  /** Prevent observer from re-triggering while we're applying */
  private isApplying = false;

  constructor(plugin: TeamVaultPlugin, commentStore: CommentStore) {
    this.plugin = plugin;
    this.commentStore = commentStore;
    this.badges = new ChangeBadges(plugin.getVaultPath());
  }

  async refresh(): Promise<void> {
    // Debounce rapid refreshes
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = setTimeout(async () => {
      await this.badges.refresh();

      // Build cached badge data
      this.cachedChangedFiles = new Set(this.badges.getChangedFiles());
      this.cachedCommentCounts.clear();
      const filesWithComments =
        await this.commentStore.getFilesWithUnresolvedComments();
      for (const filePath of filesWithComments) {
        const count = await this.commentStore.getUnresolvedCount(filePath);
        this.cachedCommentCounts.set(filePath, count);
      }

      this.applyDecorations();
      this.startObserving();
    }, 300);
  }

  /** Start a MutationObserver on the file explorer so we can re-apply badges
   *  after Obsidian re-renders the tree (folder expand/collapse, file rename, etc.) */
  private startObserving(): void {
    // Only set up once
    if (this.observer) return;

    const explorerContainer = this.getExplorerContainer();
    if (!explorerContainer) return;

    this.observer = new MutationObserver(() => {
      if (this.isApplying) return;
      // Debounce: Obsidian may fire many mutations in a burst
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => {
        this.applyDecorations();
      }, 100);
    });

    this.observer.observe(explorerContainer, {
      childList: true,
      subtree: true,
    });
  }

  /** Synchronously apply badges using cached data. */
  private applyDecorations(): void {
    this.isApplying = true;
    try {
      const explorerContainer = this.getExplorerContainer();
      if (!explorerContainer) return;

      // Remove existing badges
      explorerContainer
        .querySelectorAll(".tv-badge")
        .forEach((el: Element) => el.remove());

      // Find all file items in explorer
      const fileItems = explorerContainer.querySelectorAll(".nav-file-title");

      for (const item of Array.from(fileItems)) {
        const filePath = item.getAttribute("data-path");
        if (!filePath) continue;

        const isChanged = this.cachedChangedFiles.has(filePath);
        const commentCount = this.cachedCommentCounts.get(filePath) || 0;

        if (isChanged) {
          const badge = document.createElement("span");
          badge.className = "tv-badge modified";
          badge.textContent = "M";
          badge.title = "Modified since last sync";
          item.appendChild(badge);
        }

        if (commentCount > 0) {
          const badge = document.createElement("span");
          badge.className = "tv-badge has-comments";
          badge.textContent = String(commentCount);
          badge.title = `${commentCount} unresolved comment(s)`;
          item.appendChild(badge);
        }
      }
    } finally {
      this.isApplying = false;
    }
  }

  private getExplorerContainer(): HTMLElement | null {
    const fileExplorer = this.plugin.app.workspace.getLeavesOfType("file-explorer");
    if (fileExplorer.length === 0) return null;
    return fileExplorer[0].view.containerEl;
  }

  destroy(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
