import { Plugin, WorkspaceLeaf, MarkdownView, Editor, type MarkdownFileInfo } from "obsidian";
import { EditorView } from "@codemirror/view";
import {
  TeamVaultSettings,
  DEFAULT_SETTINGS,
  TeamVaultSettingTab,
  resolveAuthorName,
} from "./settings";
import { GitSync } from "./sync/gitSync";
import { SyncStatusBar } from "./sync/statusBar";
import { ActivityView, ACTIVITY_VIEW_TYPE } from "./activity/activityView";
import { FeedStore } from "./activity/feedStore";
import { CommentStore } from "./comments/commentStore";
import { CommentView, COMMENT_VIEW_TYPE } from "./comments/commentView";
import { GutterMarkerPlugin } from "./comments/gutterMarkers";
import { FileDecorator } from "./explorer/fileDecorator";
import { PluginUpdater, showUpdateNotice } from "./updater";
import { TeamSync } from "./teamSync";
import { addCanvasComment, replyToCanvasComment, resolveCanvasComment, editCanvasComment, registerCanvasContextMenu } from "./comments/canvasComments";
import { diffHighlightExtension, applyDiffHighlight, clearDiffHighlight } from "./diff/diffHighlight";
import { notifyError, notifyInfo, notifySuccess } from "./utils/notifications";
import { SetupWizard, shouldShowSetup } from "./setupWizard";

export default class TeamVaultPlugin extends Plugin {
  settings!: TeamVaultSettings;
  gitSync!: GitSync;
  statusBar!: SyncStatusBar;
  feedStore!: FeedStore;
  commentStore!: CommentStore;
  fileDecorator!: FileDecorator;
  updater!: PluginUpdater;
  teamSync!: TeamSync;

  /** Stored selection context for the "Add comment" command flow */
  pendingCommentContext: {
    selection: string;
    contextBefore: string;
    contextAfter: string;
    lineNumber: number;
    filePath: string;
  } | null = null;

  private autoSyncInterval: number | null = null;
  private quickSyncTimer: number | null = null;
  private lastEditTime = 0;
  private isSyncing = false;
  private lastSyncCompleted = 0;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Check for Obsidian Sync — warn if enabled
    this.checkObsidianSync();

    // Initialize core services
    const vaultPath = this.getVaultPath();

    // Load shared team roster + detect identity from PAT
    this.teamSync = new TeamSync(vaultPath, this.settings);
    await this.teamSync.init();
    this.teamSync.syncToSettings();

    this.gitSync = new GitSync(vaultPath, this.settings);
    this.commentStore = new CommentStore(vaultPath);
    this.feedStore = new FeedStore(this.settings);
    this.statusBar = new SyncStatusBar(this);
    this.fileDecorator = new FileDecorator(this, this.commentStore);
    this.updater = new PluginUpdater(this, this.settings);
    await this.updater.loadState();

    // Register views
    this.registerView(
      ACTIVITY_VIEW_TYPE,
      (leaf) => new ActivityView(leaf, this)
    );
    this.registerView(
      COMMENT_VIEW_TYPE,
      (leaf) => new CommentView(leaf, this)
    );

    // Ribbon icon — sync button
    this.addRibbonIcon("refresh-cw", "Team Vault Sync", async () => {
      await this.performSync();
    });

    // Commands
    this.addCommand({
      id: "tv-sync",
      name: "Sync vault",
      callback: () => this.performSync(),
    });

    this.addCommand({
      id: "tv-open-activity",
      name: "Open activity feed",
      callback: () => this.activateView(ACTIVITY_VIEW_TYPE),
    });

    this.addCommand({
      id: "tv-open-comments",
      name: "Open comments panel",
      callback: () => this.activateView(COMMENT_VIEW_TYPE),
    });

    this.addCommand({
      id: "tv-check-updates",
      name: "Check for plugin updates",
      callback: () => this.checkForUpdates(true),
    });

    // Canvas comment commands
    this.addCommand({
      id: "tv-canvas-comment",
      name: "Add comment to canvas node",
      checkCallback: (checking) => {
        const leaf = this.app.workspace.activeLeaf;
        if (leaf?.view.getViewType() !== "canvas") return false;
        if (!checking) addCanvasComment(this);
        return true;
      },
    });

    this.addCommand({
      id: "tv-canvas-reply",
      name: "Reply to canvas comment",
      checkCallback: (checking) => {
        const leaf = this.app.workspace.activeLeaf;
        if (leaf?.view.getViewType() !== "canvas") return false;
        if (!checking) replyToCanvasComment(this);
        return true;
      },
    });

    this.addCommand({
      id: "tv-canvas-resolve",
      name: "Resolve canvas comment",
      checkCallback: (checking) => {
        const leaf = this.app.workspace.activeLeaf;
        if (leaf?.view.getViewType() !== "canvas") return false;
        if (!checking) resolveCanvasComment(this);
        return true;
      },
    });

    this.addCommand({
      id: "tv-add-comment",
      name: "Add comment on selection",
      callback: () => {
        // Find the markdown editor even if it doesn't have focus
        let mdView: MarkdownView | null = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!mdView) {
          this.app.workspace.iterateAllLeaves((leaf) => {
            if (!mdView && leaf.view instanceof MarkdownView) {
              mdView = leaf.view;
            }
          });
        }

        if (!mdView) {
          notifyInfo("Open a markdown file first.");
          return;
        }

        this.triggerAddComment(mdView.editor, mdView);
      },
    });

    // Settings tab
    this.addSettingTab(new TeamVaultSettingTab(this.app, this));

    // Right-click context menu: "Add Comment" when text is selected
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        const selection = editor.getSelection();
        if (selection) {
          menu.addItem((item) => {
            item
              .setTitle("Add Comment")
              .setIcon("message-square")
              .onClick(() => {
                this.triggerAddComment(editor, view);
              });
          });
        }
      })
    );

    // Register CM6 extensions
    this.registerEditorExtension(
      GutterMarkerPlugin.create(this.commentStore, this)
    );
    this.registerEditorExtension(diffHighlightExtension);

    // Track edits — mark pending and schedule quick sync after 3s
    const onVaultChange = () => {
      this.lastEditTime = Date.now();
      this.statusBar.setPending(0);
      this.scheduleQuickSync();
    };
    this.registerEvent(this.app.vault.on("modify", onVaultChange));
    this.registerEvent(this.app.vault.on("create", onVaultChange));
    this.registerEvent(this.app.vault.on("delete", onVaultChange));
    this.registerEvent(this.app.vault.on("rename", onVaultChange));

    // Canvas right-click menu
    registerCanvasContextMenu(this);

    // Start auto-sync
    this.restartAutoSync();

    // Load comment data
    await this.commentStore.load();

    // Re-apply file explorer badges when layout changes
    // (Obsidian re-renders the explorer on layout-change, removing our DOM badges)
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.fileDecorator.refresh();
      })
    );

    // Initial status check
    this.statusBar.setIdle();

    // First-run: show setup wizard if repo is not configured
    await this.checkFirstSetup();

    // First-run: check git config
    await this.checkFirstRun();

    // Check for plugin updates after a short delay (don't block startup)
    window.setTimeout(() => this.checkForUpdates(false), 5000);
  }

  onunload(): void {
    this.clearAutoSync();
    if (this.quickSyncTimer !== null) {
      window.clearTimeout(this.quickSyncTimer);
    }
    this.fileDecorator.destroy();
  }

  // --- Settings ---

  async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // --- Comment Trigger ---

  /** Shared logic for adding a comment (used by command palette + right-click menu) */
  private triggerAddComment(editor: Editor, view: MarkdownView | MarkdownFileInfo): void {
    const selection = editor.getSelection();
    if (!selection) {
      notifyInfo("Select text first to add a comment.");
      return;
    }

    const cursor = editor.getCursor("from");
    const lineNumber = cursor.line + 1;
    const lines = editor.getValue().split("\n");
    const contextBefore = lineNumber > 1 ? lines[lineNumber - 2] : "";
    const contextAfter = lineNumber < lines.length ? lines[lineNumber] : "";
    const filePath = view.file?.path || "";

    this.pendingCommentContext = {
      selection,
      contextBefore,
      contextAfter,
      lineNumber,
      filePath,
    };

    this.activateView(COMMENT_VIEW_TYPE).then(() => {
      const leaves = this.app.workspace.getLeavesOfType(COMMENT_VIEW_TYPE);
      if (leaves.length > 0) {
        const commentView = leaves[0].view as CommentView;
        commentView.showAddCommentFormFromContext();
      }
    });
  }

  // --- Sync ---

  async performSync(): Promise<void> {
    if (this.isSyncing) {
      notifyInfo("Sync already in progress...");
      return;
    }

    this.isSyncing = true;
    this.statusBar.setSyncing();

    try {
      const result = await this.gitSync.sync();

      if (result.conflicts.length > 0) {
        // Import dynamically to avoid circular deps
        const { ConflictModal } = await import("./sync/conflictModal");
        const modal = new ConflictModal(
          this.app,
          result.conflicts,
          this.gitSync
        );
        modal.open();
        this.statusBar.setConflict(result.conflicts.length);
      } else if (result.error) {
        this.statusBar.setError(result.error);
        notifyError(result.error);
      } else {
        this.statusBar.setSynced();
        if (result.pulledFiles.length > 0) {
          const summary = this.summarizePulledFiles(result);
          notifySuccess(summary);
        } else if (result.pushedCount > 0) {
          notifySuccess(`Pushed ${result.pushedCount} file(s).`);
        } else {
          // No changes — keep status as synced, no notification
        }
      }

      // Refresh feed + views after sync
      await this.feedStore.refresh(this.getVaultPath(), this.commentStore);
      await this.commentStore.load(); // reload comment data from disk
      this.refreshOpenViews();

      // Refresh file decorations
      this.fileDecorator.refresh();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown sync error";
      this.statusBar.setError(message);
      notifyError(message);
    } finally {
      this.isSyncing = false;
      this.lastSyncCompleted = Date.now();
    }
  }

  /**
   * Schedule a sync 3 seconds after the last change.
   * Resets on every new change so rapid edits batch into one sync.
   * If the last sync completed less than 10 seconds ago, delays until
   * the cooldown has passed to prevent sync storms from rapid file operations.
   */
  scheduleQuickSync(): void {
    if (this.quickSyncTimer !== null) {
      window.clearTimeout(this.quickSyncTimer);
    }
    const timeSinceLastSync = Date.now() - this.lastSyncCompleted;
    const cooldownMs = 10_000;
    const delay = timeSinceLastSync < cooldownMs
      ? cooldownMs - timeSinceLastSync
      : 3000;
    this.quickSyncTimer = window.setTimeout(async () => {
      this.quickSyncTimer = null;
      await this.performSync();
    }, delay);
  }

  restartAutoSync(): void {
    this.clearAutoSync();
    if (!this.settings.autoSync) return;

    const intervalMs = this.settings.syncIntervalMinutes * 60 * 1000;
    this.autoSyncInterval = window.setInterval(async () => {
      // Debounce: skip if user edited recently
      const debounceMs = this.settings.editDebounceSeconds * 1000;
      if (Date.now() - this.lastEditTime < debounceMs) return;

      await this.performSync();
    }, intervalMs);

    this.registerInterval(this.autoSyncInterval);
  }

  private clearAutoSync(): void {
    if (this.autoSyncInterval !== null) {
      window.clearInterval(this.autoSyncInterval);
      this.autoSyncInterval = null;
    }
  }

  // --- Views ---

  async activateView(viewType: string): Promise<void> {
    const { workspace } = this.app;

    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(viewType);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        leaf = rightLeaf;
        await leaf.setViewState({ type: viewType, active: true });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  // --- Helpers ---

  getVaultPath(): string {
    const adapter = this.app.vault.adapter;
    if ("getBasePath" in adapter) {
      return (adapter as { getBasePath(): string }).getBasePath();
    }
    throw new Error("Could not determine vault path.");
  }

  private checkObsidianSync(): void {
    // Check if Obsidian Sync plugin is enabled
    const syncPlugin = (this.app as unknown as Record<string, unknown>)
      .internalPlugins as
      | { getPluginById(id: string): { enabled: boolean } | null }
      | undefined;

    if (syncPlugin) {
      const sync = syncPlugin.getPluginById("sync");
      if (sync?.enabled) {
        notifyError(
          "Obsidian Sync is enabled! Please disable it — Team Vault uses git for sync. Having both active will cause conflicts."
        );
      }
    }
  }

  /** Re-render any open Activity or Comment views after sync */
  private refreshOpenViews(): void {
    const viewTypes = [ACTIVITY_VIEW_TYPE, COMMENT_VIEW_TYPE];
    for (const type of viewTypes) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        const view = leaf.view as unknown as { render?: () => Promise<void> };
        if (typeof view.render === "function") {
          view.render();
        }
      }
    }
  }

  /** Show inline diff highlights on the active file */
  async showDiffForFile(filePath: string): Promise<void> {
    // Open the file first
    await this.app.workspace.openLinkText(filePath, "", false);

    // Get diff lines from git
    const vaultPath = this.getVaultPath();
    const git = this.gitSync.getGit();
    const lines = await git.diffFileLines(filePath);

    if (lines.added.length === 0 && lines.removed.length === 0) {
      notifyInfo("No changes to highlight in this file.");
      return;
    }

    // Find the CM6 editor for this file and apply decorations
    const leaf = this.app.workspace.activeLeaf;
    if (leaf?.view instanceof MarkdownView) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cmEditor = (leaf.view.editor as any)?.cm as EditorView | undefined;
      if (cmEditor) {
        applyDiffHighlight(cmEditor, lines);
        notifySuccess(
          `Showing changes: ${lines.added.length} added, ${lines.removed.length} removed`
        );
      }
    }
  }

  /** Clear diff highlights from all open editors */
  clearAllDiffs(): void {
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cmEditor = (leaf.view.editor as any)?.cm as EditorView | undefined;
        if (cmEditor) {
          clearDiffHighlight(cmEditor);
        }
      }
    });
  }

  async checkForUpdates(manual: boolean): Promise<void> {
    try {
      const info = await this.updater.checkForUpdate(manual);
      if (this.updater.shouldNotify(info, manual)) {
        showUpdateNotice(info, this.updater, this);
      } else if (manual && !info.hasUpdate) {
        notifySuccess(
          `Team Vault is up to date (v${info.currentVersion}).`
        );
      }
    } catch (err) {
      if (manual) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        notifyError(`Update check failed: ${msg}`);
      }
      // Silent fail on auto-check — don't bother the user
    }
  }

  async checkFirstSetup(): Promise<void> {
    if (!shouldShowSetup(this.settings)) return;

    const wizard = new SetupWizard(
      this.app,
      this.settings,
      () => this.saveSettings(),
      (name, email) => this.gitSync.setGitUserConfig(name, email)
    );
    wizard.open();
  }

  private async checkFirstRun(): Promise<void> {
    try {
      const hasGitConfig = await this.gitSync.hasGitUserConfig();
      if (!hasGitConfig) {
        if (this.settings.userName && this.settings.userEmail) {
          await this.gitSync.setGitUserConfig(
            this.settings.userName,
            this.settings.userEmail
          );
          notifyInfo(
            `Git configured as ${this.settings.userName} <${this.settings.userEmail}>`
          );
        } else {
          notifyInfo(
            "Please set your name and email in Team Vault settings for git commits."
          );
        }
      }
    } catch {
      // Git might not be available — will surface during sync
    }
  }

  private summarizePulledFiles(result: {
    pulledFiles: { filename: string; author: string }[];
  }): string {
    const byAuthor = new Map<string, number>();
    for (const f of result.pulledFiles) {
      const name = resolveAuthorName(
        f.author || "Unknown",
        this.settings
      );
      byAuthor.set(name, (byAuthor.get(name) || 0) + 1);
    }
    const parts: string[] = [];
    for (const [author, count] of byAuthor) {
      parts.push(`${count} file(s) by ${author}`);
    }
    return `Updated: ${parts.join(", ")}`;
  }
}
