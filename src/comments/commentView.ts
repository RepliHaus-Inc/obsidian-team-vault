import { ItemView, WorkspaceLeaf, MarkdownView } from "obsidian";
import type TeamVaultPlugin from "../main";
import type { Comment } from "./commentStore";
import { GutterMarkerPlugin } from "./gutterMarkers";
import { notifyInfo } from "../utils/notifications";

export const COMMENT_VIEW_TYPE = "tv-comments";

type CommentTab = "current-file" | "all" | "my-mentions";

export class CommentView extends ItemView {
  private plugin: TeamVaultPlugin;
  private currentFilePath: string | null = null;
  private activeTab: CommentTab = "all";
  /** When true, skip re-render to avoid wiping the comment form */
  private suppressNextRender = false;

  constructor(leaf: WorkspaceLeaf, plugin: TeamVaultPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return COMMENT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Team Vault Comments";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.onActiveFileChange();
      })
    );

    // Track the active file but don't force "current-file" tab
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) {
      this.currentFilePath = activeFile.path;
    }
    await this.render();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  private async onActiveFileChange(): Promise<void> {
    if (this.suppressNextRender) {
      this.suppressNextRender = false;
      return;
    }

    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) {
      this.currentFilePath = activeFile.path;
    }
    // Only re-render if on the current-file tab
    if (this.activeTab === "current-file") {
      await this.render();
    }
  }

  async render(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("tv-comment-view");

    // Header
    const header = container.createDiv({ cls: "tv-activity-header" });
    header.createEl("h4", { text: "Comments" });

    const addBtn = header.createEl("button", { text: "+ Comment" });
    addBtn.addEventListener("click", () => this.showAddCommentForm(container));

    // Tabs
    this.renderTabs(container);

    // Content based on active tab
    switch (this.activeTab) {
      case "current-file":
        await this.renderCurrentFile(container);
        break;
      case "all":
        await this.renderAllComments(container);
        break;
      case "my-mentions":
        await this.renderMyMentions(container);
        break;
    }
  }

  private renderTabs(container: HTMLElement): void {
    const tabs = container.createDiv({ cls: "tv-feed-filters" });

    const tabDefs: { id: CommentTab; label: string }[] = [
      { id: "all", label: "All" },
      { id: "my-mentions", label: "Mentions" },
      { id: "current-file", label: "This File" },
    ];

    for (const tab of tabDefs) {
      const btn = tabs.createEl("button", {
        cls: `tv-filter-btn ${this.activeTab === tab.id ? "active" : ""}`,
        text: tab.label,
      });
      btn.addEventListener("click", () => {
        this.activeTab = tab.id;
        this.render();
      });
    }
  }

  // --- Tab Renderers ---

  private async renderCurrentFile(container: HTMLElement): Promise<void> {
    if (!this.currentFilePath) {
      container.createDiv({
        cls: "tv-feed-empty",
        text: "Open a file to see its comments.",
      });
      return;
    }

    const fileName = this.currentFilePath.split("/").pop() || this.currentFilePath;
    this.renderSectionHeader(container, fileName);

    const comments = await this.plugin.commentStore.getCommentsForFile(
      this.currentFilePath
    );

    if (comments.length === 0) {
      container.createDiv({
        cls: "tv-feed-empty",
        text: "No comments on this file yet.",
      });
      return;
    }

    this.renderCommentList(container, comments, this.currentFilePath);
  }

  private async renderAllComments(container: HTMLElement): Promise<void> {
    const files = await this.plugin.commentStore.getAllFilesWithComments();

    if (files.length === 0) {
      container.createDiv({
        cls: "tv-feed-empty",
        text: "No comments in the vault yet. Select text in any file and add a comment.",
      });
      return;
    }

    // Collect all comments, newest first
    const allComments: { comment: Comment; filePath: string }[] = [];
    for (const filePath of files) {
      const comments = await this.plugin.commentStore.getCommentsForFile(filePath);
      for (const comment of comments) {
        allComments.push({ comment, filePath });
      }
    }

    allComments.sort(
      (a, b) =>
        new Date(b.comment.createdAt).getTime() -
        new Date(a.comment.createdAt).getTime()
    );

    const unresolved = allComments.filter((c) => !c.comment.resolved);
    const resolved = allComments.filter((c) => c.comment.resolved);

    if (unresolved.length > 0) {
      this.renderSectionHeader(container, `Open (${unresolved.length})`);
      for (const { comment, filePath } of unresolved) {
        this.renderCommentWithFileContext(container, comment, filePath);
      }
    }

    if (resolved.length > 0) {
      if (unresolved.length > 0) {
        container.createDiv({ cls: "tv-feed-divider" });
      }
      this.renderSectionHeader(container, `Resolved (${resolved.length})`);
      for (const { comment, filePath } of resolved) {
        this.renderCommentWithFileContext(container, comment, filePath);
      }
    }
  }

  private async renderMyMentions(container: HTMLElement): Promise<void> {
    const myName = this.plugin.settings.userName;
    if (!myName) {
      container.createDiv({
        cls: "tv-feed-empty",
        text: "Set your name in Team Vault settings to see your mentions.",
      });
      return;
    }

    const files = await this.plugin.commentStore.getAllFilesWithComments();
    const mentions: { comment: Comment; filePath: string }[] = [];

    for (const filePath of files) {
      const comments = await this.plugin.commentStore.getCommentsForFile(filePath);
      for (const comment of comments) {
        // Check if this comment or any reply mentions me
        const mentionsMe =
          comment.text.toLowerCase().includes(`@${myName.toLowerCase()}`) ||
          comment.replies.some((r) =>
            r.text.toLowerCase().includes(`@${myName.toLowerCase()}`)
          );
        if (mentionsMe) {
          mentions.push({ comment, filePath });
        }
      }
    }

    if (mentions.length === 0) {
      container.createDiv({
        cls: "tv-feed-empty",
        text: `No @${myName} mentions yet.`,
      });
      return;
    }

    mentions.sort(
      (a, b) =>
        new Date(b.comment.createdAt).getTime() -
        new Date(a.comment.createdAt).getTime()
    );

    for (const { comment, filePath } of mentions) {
      this.renderCommentWithFileContext(container, comment, filePath);
    }
  }

  /** Render a section header matching the activity tab style */
  private renderSectionHeader(container: HTMLElement, text: string): void {
    const header = container.createDiv({ cls: "tv-new-section-header" });
    header.createSpan({ text, cls: "tv-new-label" });
  }

  // --- Comment Rendering ---

  private renderCommentWithFileContext(
    container: HTMLElement,
    comment: Comment,
    filePath: string
  ): void {
    const thread = container.createDiv({ cls: "tv-comment-thread" });

    // File link header
    const fileName = filePath.split("/").pop() || filePath;
    const fileLink = thread.createEl("div", {
      cls: "tv-comment-file-link",
    });
    fileLink.createSpan({ text: fileName, cls: "tv-feed-target" });
    fileLink.style.cursor = "pointer";
    fileLink.style.fontSize = "11px";
    fileLink.style.marginBottom = "4px";
    fileLink.addEventListener("click", () => {
      this.app.workspace.openLinkText(filePath, "", false);
    });

    // Anchor text
    if (comment.anchor.selectedText) {
      thread.createDiv({
        cls: "tv-comment-anchor",
        text: `"${comment.anchor.selectedText}"`,
      });
    }

    this.renderSingleComment(thread, comment, true, filePath);

    // Replies
    for (const reply of comment.replies) {
      const replyEl = thread.createDiv({
        cls: `tv-comment ${comment.resolved ? "resolved" : ""}`,
      });
      replyEl.style.marginLeft = "16px";

      const replyHeader = replyEl.createDiv({ cls: "tv-comment-header" });
      replyHeader.createSpan({
        cls: "tv-comment-author",
        text: reply.author,
      });
      replyHeader.createSpan({
        cls: "tv-comment-date",
        text: this.formatDate(reply.createdAt),
      });

      const body = replyEl.createDiv({ cls: "tv-comment-body" });
      this.renderCommentText(body, reply.text);
    }

    // Reply button
    if (!comment.resolved) {
      const replyBtn = thread.createEl("button", {
        text: "Reply",
        cls: "tv-filter-btn",
      });
      replyBtn.style.marginTop = "4px";
      replyBtn.addEventListener("click", () => {
        this.currentFilePath = filePath;
        this.showReplyForm(thread, comment);
      });
    }
  }

  private renderCommentList(
    container: HTMLElement,
    comments: Comment[],
    filePath: string
  ): void {
    // Sort newest first
    const sorted = [...comments].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    const unresolved = sorted.filter((c) => !c.resolved);
    const resolved = sorted.filter((c) => c.resolved);

    if (unresolved.length > 0) {
      this.renderSectionHeader(container, `Open (${unresolved.length})`);
      for (const comment of unresolved) {
        this.renderCommentWithFileContext(container, comment, filePath);
      }
    }

    if (resolved.length > 0) {
      if (unresolved.length > 0) {
        container.createDiv({ cls: "tv-feed-divider" });
      }
      this.renderSectionHeader(container, `Resolved (${resolved.length})`);
      for (const comment of resolved) {
        this.renderCommentWithFileContext(container, comment, filePath);
      }
    }
  }

  private renderSingleComment(
    container: HTMLElement,
    comment: Comment,
    showActions: boolean,
    filePath: string
  ): void {
    const el = container.createDiv({
      cls: `tv-comment ${comment.resolved ? "resolved" : ""}`,
    });

    const header = el.createDiv({ cls: "tv-comment-header" });
    header.createSpan({
      cls: "tv-comment-author",
      text: comment.author,
    });
    header.createSpan({
      cls: "tv-comment-date",
      text: this.formatDate(comment.createdAt),
    });

    const body = el.createDiv({ cls: "tv-comment-body" });
    this.renderCommentText(body, comment.text);

    if (showActions) {
      const actions = el.createDiv({ cls: "tv-comment-actions" });

      if (!comment.resolved) {
        const resolveBtn = actions.createEl("button", { text: "Resolve" });
        resolveBtn.addEventListener("click", async () => {
          await this.plugin.commentStore.resolveComment(filePath, comment.id);
          GutterMarkerPlugin.invalidateCache(filePath);
          await GutterMarkerPlugin.preloadCache(this.plugin.commentStore, filePath);
          this.forceEditorRerender();
          await this.render();
          this.plugin.scheduleQuickSync();
        });
      }

      const deleteBtn = actions.createEl("button", { text: "Delete" });
      deleteBtn.addEventListener("click", async () => {
        await this.plugin.commentStore.deleteComment(filePath, comment.id);
        GutterMarkerPlugin.invalidateCache(filePath);
        this.forceEditorRerender();
        await this.render();
      });
    }
  }

  // --- Add Comment Flow ---

  async showAddCommentFormFromContext(): Promise<void> {
    const ctx = this.plugin.pendingCommentContext;
    if (!ctx) {
      notifyInfo("No selection context found. Select text and try again.");
      return;
    }

    this.suppressNextRender = true;
    this.currentFilePath = ctx.filePath;
    // Switch to current-file tab to show context
    this.activeTab = "current-file";

    await this.render();

    this.renderCommentForm(
      this.contentEl,
      ctx.selection,
      ctx.contextBefore,
      ctx.contextAfter,
      ctx.lineNumber
    );

    this.plugin.pendingCommentContext = null;
  }

  private showAddCommentForm(container: HTMLElement): void {
    const ctx = this.plugin.pendingCommentContext;
    if (ctx) {
      this.renderCommentForm(
        container,
        ctx.selection,
        ctx.contextBefore,
        ctx.contextAfter,
        ctx.lineNumber
      );
      this.plugin.pendingCommentContext = null;
      return;
    }

    const view = this.findMarkdownView();
    if (!view) {
      notifyInfo("Open a markdown file first, select text, then try again.");
      return;
    }

    const editor = view.editor;
    const selection = editor.getSelection();
    if (!selection) {
      notifyInfo("Select some text first, then use Cmd+P or right-click → 'Add Comment'.");
      return;
    }

    const cursor = editor.getCursor("from");
    const lineNumber = cursor.line + 1;
    const lines = editor.getValue().split("\n");
    const contextBefore = lineNumber > 1 ? lines[lineNumber - 2] : "";
    const contextAfter = lineNumber < lines.length ? lines[lineNumber] : "";

    this.currentFilePath = view.file?.path || this.currentFilePath;
    this.renderCommentForm(container, selection, contextBefore, contextAfter, lineNumber);
  }

  private renderCommentForm(
    container: HTMLElement,
    selection: string,
    contextBefore: string,
    contextAfter: string,
    lineNumber: number
  ): void {
    const existing = container.querySelector(".tv-comment-input-area");
    if (existing) existing.remove();

    // Insert form at the top (after header + tabs) so it's always visible
    const form = document.createElement("div");
    form.addClass("tv-comment-input-area");
    const tabs = container.querySelector(".tv-feed-filters");
    if (tabs?.nextSibling) {
      container.insertBefore(form, tabs.nextSibling);
    } else {
      container.prepend(form);
    }

    form.createDiv({
      cls: "tv-comment-anchor",
      text: `"${selection}"`,
    });

    const textarea = form.createEl("textarea", {
      attr: { placeholder: "Write a comment... Use @name to mention someone" },
    });

    const buttonRow = form.createDiv({ cls: "button-row" });
    const cancelBtn = buttonRow.createEl("button", { text: "Cancel" });
    const submitBtn = buttonRow.createEl("button", {
      text: "Comment",
      cls: "mod-cta",
    });

    cancelBtn.addEventListener("click", () => form.remove());
    submitBtn.addEventListener("click", async () => {
      const text = textarea.value.trim();
      if (!text || !this.currentFilePath) return;

      const author = this.plugin.settings.userName || "Unknown";
      await this.plugin.commentStore.addComment(
        this.currentFilePath,
        author,
        text,
        {
          selectedText: selection,
          contextBefore,
          contextAfter,
          lineNumber,
        }
      );

      // Add to feed with mention details
      const mentions = text.match(/@(\w+)/g);
      if (mentions) {
        this.plugin.feedStore.addCommentEntry(
          author,
          this.currentFilePath,
          true,
          mentions.map((m) => m.substring(1))
        );
      } else {
        this.plugin.feedStore.addCommentEntry(
          author,
          this.currentFilePath,
          false
        );
      }

      // Invalidate gutter cache and force editor re-render so dots appear immediately
      GutterMarkerPlugin.invalidateCache(this.currentFilePath);
      await GutterMarkerPlugin.preloadCache(this.plugin.commentStore, this.currentFilePath!);
      this.forceEditorRerender();

      form.remove();
      await this.render();
      this.plugin.scheduleQuickSync();
    });

    form.scrollIntoView({ behavior: "smooth", block: "start" });
    textarea.focus();
  }

  private showReplyForm(container: HTMLElement, comment: Comment): void {
    const existing = container.querySelector(".tv-comment-input-area");
    if (existing) existing.remove();

    const form = container.createDiv({ cls: "tv-comment-input-area" });
    const textarea = form.createEl("textarea", {
      attr: { placeholder: "Reply... Use @name to mention someone" },
    });

    const buttonRow = form.createDiv({ cls: "button-row" });
    const cancelBtn = buttonRow.createEl("button", { text: "Cancel" });
    const submitBtn = buttonRow.createEl("button", {
      text: "Reply",
      cls: "mod-cta",
    });

    cancelBtn.addEventListener("click", () => form.remove());
    submitBtn.addEventListener("click", async () => {
      const text = textarea.value.trim();
      if (!text || !this.currentFilePath) return;

      const author = this.plugin.settings.userName || "Unknown";
      await this.plugin.commentStore.addReply(
        this.currentFilePath,
        comment.id,
        author,
        text
      );

      // Invalidate gutter cache and force editor re-render
      GutterMarkerPlugin.invalidateCache(this.currentFilePath!);
      this.forceEditorRerender();

      form.remove();
      await this.render();
      this.plugin.scheduleQuickSync();
    });

    textarea.focus();
  }

  // --- Helpers ---

  /**
   * Force CM6 editors to re-render by dispatching a no-op state change.
   * This causes the gutter marker extension to re-query the (now-updated) cache.
   */
  private forceEditorRerender(): void {
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView) {
        // Access the CM6 EditorView through Obsidian's editor wrapper
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cmEditor = (leaf.view.editor as any)?.cm as
          | { dispatch: (tr: Record<string, unknown>) => void }
          | undefined;
        if (cmEditor) {
          // Dispatch empty transaction to force gutter re-evaluation
          cmEditor.dispatch({});
        }
      }
    });
  }

  private renderCommentText(container: HTMLElement, text: string): void {
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

  private findMarkdownView(): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) return active;

    let found: MarkdownView | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!found && leaf.view instanceof MarkdownView) {
        found = leaf.view;
      }
    });
    return found;
  }

  private formatDate(isoString: string): string {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);

    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHr < 24) return `${diffHr}h ago`;
    if (diffDay < 7) return `${diffDay}d ago`;
    return date.toLocaleDateString();
  }
}
