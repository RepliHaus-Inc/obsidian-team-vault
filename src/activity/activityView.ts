import { ItemView, WorkspaceLeaf } from "obsidian";
import type TeamVaultPlugin from "../main";
import type { FeedEntry, FeedEntryType } from "./feedStore";

export const ACTIVITY_VIEW_TYPE = "tv-activity";

const AVATAR_COLORS: Record<string, string> = {
  S: "#e74c3c",
  J: "#3498db",
  A: "#2ecc71",
  T: "#f39c12",
};

function getAvatarColor(name: string | undefined): string {
  if (!name) return "#9b59b6";
  const initial = name.charAt(0).toUpperCase();
  return AVATAR_COLORS[initial] || "#9b59b6";
}

function relativeTime(timestamp: number): string {
  const now = Date.now() / 1000;
  const diff = now - timestamp;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(timestamp * 1000).toLocaleDateString();
}

export class ActivityView extends ItemView {
  private plugin: TeamVaultPlugin;
  private activeFilter: { author?: string; type?: FeedEntryType; types?: FeedEntryType[] } = {};
  private diffMode = false;

  constructor(leaf: WorkspaceLeaf, plugin: TeamVaultPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return ACTIVITY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Team Vault Activity";
  }

  getIcon(): string {
    return "activity";
  }

  private dataLoaded = false;
  private refreshing: Promise<void> | null = null;

  async onOpen(): Promise<void> {
    // Show loading state immediately
    this.contentEl.empty();
    this.contentEl.createDiv({
      cls: "tv-feed-empty",
      text: "Loading activity...",
    });

    // Refresh and re-render once data is ready
    this.refreshing = this.plugin.feedStore.refresh(
      this.plugin.getVaultPath(),
      this.plugin.commentStore
    );
    await this.refreshing;
    this.refreshing = null;
    this.dataLoaded = true;
    await this.render();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  async render(): Promise<void> {
    // Wait for any pending refresh to complete before rendering
    if (this.refreshing) {
      await this.refreshing;
    }

    const container = this.contentEl;
    container.empty();
    container.addClass("tv-activity-view");

    // Header
    const header = container.createDiv({ cls: "tv-activity-header" });
    header.createEl("h4", { text: "Activity" });

    // Show/Hide changes toggle
    const diffToggle = header.createEl("button", {
      text: this.diffMode ? "Hide Changes" : "Show Changes",
      cls: `tv-filter-btn ${this.diffMode ? "active" : ""}`,
    });
    diffToggle.addEventListener("click", () => {
      this.diffMode = !this.diffMode;
      if (!this.diffMode) {
        this.plugin.clearAllDiffs();
      }
      this.render();
    });

    // Filters
    this.renderFilters(container);

    // Feed entries
    const allEntries = this.plugin.feedStore.getEntries();
    const entries = this.plugin.feedStore.getEntries(this.activeFilter);

    if (entries.length === 0) {
      container.createDiv({
        cls: "tv-feed-empty",
        text: "No activity yet. Sync to see updates from your team.",
      });
      return;
    }

    // Split into new and read, both newest-first
    const feedStore = this.plugin.feedStore;
    const newEntries = entries.filter((e) => feedStore.isNewEntry(e));
    const readEntries = entries.filter((e) => !feedStore.isNewEntry(e));

    // New items at the top
    if (newEntries.length > 0) {
      const header = container.createDiv({ cls: "tv-new-section-header" });
      header.createSpan({ text: `New (${newEntries.length})`, cls: "tv-new-label" });
      const markReadBtn = header.createEl("button", {
        text: "Mark all read",
        cls: "tv-filter-btn",
      });
      markReadBtn.addEventListener("click", async () => {
        await feedStore.markFeedViewed(this.plugin.getVaultPath());
        await this.render();
      });

      for (const entry of newEntries.slice(0, 50)) {
        this.renderEntry(container, entry, true);
      }
    }

    // Divider
    if (newEntries.length > 0 && readEntries.length > 0) {
      container.createDiv({ cls: "tv-feed-divider" });
    }

    // Read items below
    for (const entry of readEntries.slice(0, 50)) {
      this.renderEntry(container, entry, false);
    }
  }

  private renderFilters(container: HTMLElement): void {
    const filters = container.createDiv({ cls: "tv-feed-filters" });
    const store = this.plugin.feedStore;

    // All filter — show total count
    const allCount = store.getEntries().length;
    const allBtn = filters.createEl("button", {
      cls: "tv-filter-btn",
      text: `All (${allCount})`,
    });
    if (!this.activeFilter.author && !this.activeFilter.type && !this.activeFilter.types) {
      allBtn.addClass("active");
    }
    allBtn.addEventListener("click", () => {
      this.activeFilter = {};
      this.render();
    });

    // Per-member filters
    for (const member of this.plugin.settings.teamMembers) {
      const count = store.getEntries({ author: member.name }).length;
      const btn = filters.createEl("button", {
        cls: "tv-filter-btn",
        text: count > 0 ? `${member.name} (${count})` : member.name,
      });
      if (this.activeFilter.author === member.name) {
        btn.addClass("active");
      }
      btn.addEventListener("click", () => {
        this.activeFilter = { author: member.name };
        this.render();
      });
    }

    // Type filters
    const typeFilters: {
      label: string;
      types: FeedEntryType[];
    }[] = [
      { label: "Vault", types: ["vault-change", "vault-session"] },
      { label: "Comments", types: ["comment", "mention"] },
    ];
    for (const t of typeFilters) {
      const count = store.getEntries({ types: t.types }).length;
      const btn = filters.createEl("button", {
        cls: "tv-filter-btn",
        text: count > 0 ? `${t.label} (${count})` : t.label,
      });
      const isActive =
        this.activeFilter.types &&
        t.types.length === this.activeFilter.types.length &&
        t.types.every((tp) => this.activeFilter.types!.includes(tp));
      if (isActive) btn.addClass("active");
      btn.addEventListener("click", () => {
        this.activeFilter = { types: t.types };
        this.render();
      });
    }
  }

  private renderEntry(container: HTMLElement, entry: FeedEntry, isNew = false): void {
    const el = container.createDiv({
      cls: `tv-feed-item ${isNew ? "tv-feed-item-new" : ""}`,
    });

    // Avatar
    const authorName = entry.author || "Unknown";
    const avatar = el.createDiv({ cls: "tv-feed-avatar" });
    avatar.style.backgroundColor = getAvatarColor(authorName);
    avatar.textContent = authorName.charAt(0).toUpperCase();

    // Content
    const content = el.createDiv({ cls: "tv-feed-content" });

    const action = content.createDiv({ cls: "tv-feed-action" });
    action.createEl("strong", { text: authorName });
    action.appendText(" ");
    this.renderActionText(action, entry.action);

    const hasMultipleFiles = entry.files && entry.files.length > 1;

    // For single-file entries, show the file name inline
    if (!hasMultipleFiles && entry.target) {
      action.appendText(" ");
      const targetEl = action.createEl("span", {
        cls: "tv-feed-target",
        text: this.truncateTarget(entry.target),
      });
      targetEl.setAttr("title", entry.target);
    }

    // Time
    const timeText = entry.sessionStart
      ? `${this.formatTime(entry.sessionStart)} – ${this.formatTime(entry.timestamp)}`
      : relativeTime(entry.timestamp);
    content.createDiv({ cls: "tv-feed-time", text: timeText });

    // Multi-file entries get an expandable file list
    if (hasMultipleFiles) {
      const toggle = content.createDiv({ cls: "tv-session-toggle" });
      toggle.textContent = `▸ ${entry.files!.length} files`;
      toggle.style.cursor = "pointer";
      toggle.style.fontSize = "11px";
      toggle.style.color = "var(--text-muted)";
      toggle.style.marginTop = "4px";

      const fileList = content.createDiv({ cls: "tv-session-files" });
      fileList.style.display = "none";
      fileList.style.marginTop = "4px";

      for (const filePath of entry.files!) {
        const fileName = filePath.split("/").pop() || filePath;
        const fileEl = fileList.createDiv({ cls: "tv-session-file" });
        fileEl.createSpan({ text: fileName, cls: "tv-feed-target" });
        fileEl.style.fontSize = "11px";
        fileEl.style.padding = "2px 0";
        fileEl.style.cursor = "pointer";
        fileEl.setAttr("title", filePath);
        fileEl.addEventListener("click", (e) => {
          e.stopPropagation();
          if (this.diffMode) {
            this.plugin.showDiffForFile(filePath);
          } else {
            this.app.workspace.openLinkText(filePath, "", false);
          }
        });
      }

      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        const visible = fileList.style.display !== "none";
        fileList.style.display = visible ? "none" : "block";
        toggle.textContent = visible
          ? `▸ ${entry.files!.length} files`
          : `▾ ${entry.files!.length} files`;
      });
    } else if (entry.targetPath) {
      // Single file — click opens it (with diff if enabled)
      el.addEventListener("click", () => {
        if (this.diffMode) {
          this.plugin.showDiffForFile(entry.targetPath!);
        } else {
          this.app.workspace.openLinkText(entry.targetPath!, "", false);
        }
      });
    }
  }

  private formatTime(ts: number): string {
    return new Date(ts * 1000).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  private renderActionText(container: HTMLElement, text: string): void {
    const myName = (this.plugin.settings.userName || "").toLowerCase();
    const parts = text.split(/(@\w+)/g);
    for (const part of parts) {
      if (part.startsWith("@")) {
        const mentionedName = part.substring(1).toLowerCase();
        const isMe = myName && mentionedName === myName;
        const cls = isMe ? "mention mention-me" : "mention";
        container.createSpan({ cls, text: part });
      } else {
        container.appendText(part);
      }
    }
  }

  private truncateTarget(target: string): string {
    if (target.length <= 40) return target;
    return target.substring(0, 37) + "...";
  }
}
