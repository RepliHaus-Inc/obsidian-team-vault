import { TFile, Modal, App, Setting, Menu } from "obsidian";
import type TeamVaultPlugin from "../main";
import type { CanvasData, CanvasTextData, CanvasEdgeData, AllCanvasNodeData } from "obsidian/canvas";
import { notifyInfo, notifyError } from "../utils/notifications";

/** Prefix used to identify comment nodes in canvas JSON */
const COMMENT_PREFIX = "💬 ";
const COMMENT_COLOR = "#FEF3C7"; // warm yellow
const COMMENT_WIDTH = 260;
const COMMENT_HEIGHT = 120;
const COMMENT_OFFSET = 20; // gap between target node and comment

/**
 * Internal canvas API accessed at runtime.
 * Not officially documented — used by many community plugins.
 */
interface InternalCanvas {
  selection: Set<{ id: string }>;
  nodes: Map<string, { id: string; x: number; y: number; width: number; height: number }>;
  requestSave(): void;
  getData(): CanvasData;
  setData(data: CanvasData): void;
}

function getCanvas(plugin: TeamVaultPlugin): InternalCanvas | null {
  const leaf = plugin.app.workspace.activeLeaf;
  if (!leaf || leaf.view.getViewType() !== "canvas") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (leaf.view as any).canvas ?? null;
}

function getSelectedNodeId(canvas: InternalCanvas): string | null {
  if (canvas.selection.size !== 1) return null;
  const [node] = canvas.selection;
  return node?.id ?? null;
}

function generateId(): string {
  return `comment-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;
}

/**
 * Sanitize user-supplied comment text to prevent markdown link injection
 * and HTML injection when rendered in canvas text nodes.
 *
 * Escapes `[`, `]` to block link syntax and `<`, `>` to block HTML tags.
 * Leaves `@mentions` and inline formatting (`*bold*`, `_italic_`) intact.
 */
function sanitizeCommentText(text: string): string {
  return text
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

/**
 * Format comment text as it appears in the sticky note node.
 * Uses markdown so it renders nicely in the canvas.
 */
function formatCommentText(author: string, text: string, timestamp: string): string {
  const time = new Date(timestamp);
  const timeStr = time.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${COMMENT_PREFIX}**${author}**\n${sanitizeCommentText(text)}\n\n*${timeStr}*`;
}

/**
 * Check if a canvas text node is a Team Vault comment.
 */
export function isCommentNode(node: AllCanvasNodeData): boolean {
  return node.type === "text" && node.text.startsWith(COMMENT_PREFIX);
}

/**
 * Add a comment to the selected canvas node.
 * Opens a modal to type the comment, then inserts a sticky note
 * node connected to the target with an edge.
 */
export function addCanvasComment(plugin: TeamVaultPlugin): void {
  const canvas = getCanvas(plugin);
  if (!canvas) {
    notifyInfo("Open a canvas and select a node first.");
    return;
  }

  const targetId = getSelectedNodeId(canvas);
  if (!targetId) {
    notifyInfo("Select a single node on the canvas to comment on.");
    return;
  }

  // Get target node position
  const targetNode = canvas.nodes.get(targetId);
  if (!targetNode) {
    notifyError("Could not find the selected node.");
    return;
  }

  new CanvasCommentModal(plugin.app, plugin, canvas, targetId, targetNode).open();
}

/**
 * Modal for typing a canvas comment.
 */
class CanvasCommentModal extends Modal {
  private plugin: TeamVaultPlugin;
  private canvas: InternalCanvas;
  private targetId: string;
  private targetNode: { x: number; y: number; width: number; height: number };

  constructor(
    app: App,
    plugin: TeamVaultPlugin,
    canvas: InternalCanvas,
    targetId: string,
    targetNode: { x: number; y: number; width: number; height: number }
  ) {
    super(app);
    this.plugin = plugin;
    this.canvas = canvas;
    this.targetId = targetId;
    this.targetNode = targetNode;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Add Comment" });

    let commentText = "";

    new Setting(contentEl)
      .setName("Comment")
      .addTextArea((text) => {
        text.setPlaceholder("Write your comment...");
        text.inputEl.rows = 4;
        text.inputEl.style.width = "100%";
        text.onChange((value) => {
          commentText = value;
        });
        // Focus after modal opens
        setTimeout(() => text.inputEl.focus(), 50);
      });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Add Comment")
          .setCta()
          .onClick(() => {
            if (!commentText.trim()) return;
            this.insertComment(commentText.trim());
            this.close();
          })
      )
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => this.close())
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private insertComment(text: string): void {
    const author = this.plugin.settings.userName || "Unknown";
    const timestamp = new Date().toISOString();
    const commentId = generateId();

    // Position: to the right of the target node
    const x = this.targetNode.x + this.targetNode.width + COMMENT_OFFSET;
    const y = this.targetNode.y;

    const commentNode: CanvasTextData = {
      id: commentId,
      type: "text",
      text: formatCommentText(author, text, timestamp),
      x,
      y,
      width: COMMENT_WIDTH,
      height: COMMENT_HEIGHT,
      color: COMMENT_COLOR,
    };

    // Edge connecting target → comment
    const edge: CanvasEdgeData = {
      id: `edge-${commentId}`,
      fromNode: this.targetId,
      fromSide: "right",
      fromEnd: "none",
      toNode: commentId,
      toSide: "left",
      toEnd: "none",
      color: COMMENT_COLOR,
    };

    // Update canvas data
    const data = this.canvas.getData();
    data.nodes.push(commentNode);
    data.edges.push(edge);
    this.canvas.setData(data);
    this.canvas.requestSave();

    // Also store in our comment system for activity feed integration
    const filePath = this.plugin.app.workspace.getActiveFile()?.path;
    if (filePath) {
      this.plugin.commentStore.addComment(filePath, author, text, {
        selectedText: `[Canvas node: ${this.targetId}]`,
        contextBefore: "",
        contextAfter: "",
        lineNumber: 0,
      });
      this.plugin.feedStore.addCommentEntry(author, filePath, false);
    }

    this.plugin.scheduleQuickSync();
  }
}

/**
 * Reply to an existing canvas comment node.
 */
export function replyToCanvasComment(plugin: TeamVaultPlugin): void {
  const canvas = getCanvas(plugin);
  if (!canvas) {
    notifyInfo("Open a canvas first.");
    return;
  }

  const targetId = getSelectedNodeId(canvas);
  if (!targetId) {
    notifyInfo("Select a comment node to reply to.");
    return;
  }

  // Check if selected node is a comment
  const data = canvas.getData();
  const node = data.nodes.find((n) => n.id === targetId);
  if (!node || !isCommentNode(node)) {
    notifyInfo("Select a comment node (💬) to reply to.");
    return;
  }

  const targetPos = canvas.nodes.get(targetId);
  if (!targetPos) return;

  new CanvasReplyModal(plugin.app, plugin, canvas, targetId, targetPos, node as CanvasTextData).open();
}

class CanvasReplyModal extends Modal {
  private plugin: TeamVaultPlugin;
  private canvas: InternalCanvas;
  private targetId: string;
  private targetPos: { x: number; y: number; width: number; height: number };
  private targetNode: CanvasTextData;

  constructor(
    app: App,
    plugin: TeamVaultPlugin,
    canvas: InternalCanvas,
    targetId: string,
    targetPos: { x: number; y: number; width: number; height: number },
    targetNode: CanvasTextData
  ) {
    super(app);
    this.plugin = plugin;
    this.canvas = canvas;
    this.targetId = targetId;
    this.targetPos = targetPos;
    this.targetNode = targetNode;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Reply to Comment" });

    // Show existing comment
    contentEl.createDiv({
      cls: "tv-comment-anchor",
      text: this.targetNode.text.replace(COMMENT_PREFIX, ""),
    });

    let replyText = "";

    new Setting(contentEl)
      .setName("Reply")
      .addTextArea((text) => {
        text.setPlaceholder("Write your reply...");
        text.inputEl.rows = 3;
        text.inputEl.style.width = "100%";
        text.onChange((value) => {
          replyText = value;
        });
        setTimeout(() => text.inputEl.focus(), 50);
      });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Reply")
          .setCta()
          .onClick(() => {
            if (!replyText.trim()) return;
            this.insertReply(replyText.trim());
            this.close();
          })
      )
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => this.close())
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private insertReply(text: string): void {
    const author = this.plugin.settings.userName || "Unknown";
    const timestamp = new Date().toISOString();
    const replyId = generateId();

    // Position: below the parent comment
    const x = this.targetPos.x;
    const y = this.targetPos.y + this.targetPos.height + COMMENT_OFFSET;

    const replyNode: CanvasTextData = {
      id: replyId,
      type: "text",
      text: formatCommentText(author, text, timestamp),
      x,
      y,
      width: COMMENT_WIDTH,
      height: COMMENT_HEIGHT,
      color: COMMENT_COLOR,
    };

    const edge: CanvasEdgeData = {
      id: `edge-${replyId}`,
      fromNode: this.targetId,
      fromSide: "bottom",
      fromEnd: "none",
      toNode: replyId,
      toSide: "top",
      toEnd: "none",
      color: COMMENT_COLOR,
    };

    const data = this.canvas.getData();
    data.nodes.push(replyNode);
    data.edges.push(edge);
    this.canvas.setData(data);
    this.canvas.requestSave();

    this.plugin.scheduleQuickSync();
  }
}

/**
 * Edit an existing canvas comment node's text.
 */
export function editCanvasComment(plugin: TeamVaultPlugin): void {
  const canvas = getCanvas(plugin);
  if (!canvas) return;

  const targetId = getSelectedNodeId(canvas);
  if (!targetId) {
    notifyInfo("Select a comment node (💬) to edit.");
    return;
  }

  const data = canvas.getData();
  const node = data.nodes.find((n) => n.id === targetId);
  if (!node || !isCommentNode(node)) {
    notifyInfo("Select a comment node (💬) to edit.");
    return;
  }

  new CanvasEditModal(plugin.app, plugin, canvas, targetId, node as CanvasTextData).open();
}

class CanvasEditModal extends Modal {
  private plugin: TeamVaultPlugin;
  private canvas: InternalCanvas;
  private targetId: string;
  private targetNode: CanvasTextData;

  constructor(
    app: App,
    plugin: TeamVaultPlugin,
    canvas: InternalCanvas,
    targetId: string,
    targetNode: CanvasTextData
  ) {
    super(app);
    this.plugin = plugin;
    this.canvas = canvas;
    this.targetId = targetId;
    this.targetNode = targetNode;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Edit Comment" });

    // Extract just the comment body (strip author/timestamp formatting)
    const lines = this.targetNode.text.split("\n");
    // Line 0 = "💬 **Author**", line 1+ = comment body, last line = "*timestamp*"
    const bodyLines = lines.slice(1, -1).filter((l) => l.trim() !== "");
    let editText = bodyLines.join("\n");

    new Setting(contentEl)
      .setName("Comment")
      .addTextArea((text) => {
        text.setValue(editText);
        text.inputEl.rows = 4;
        text.inputEl.style.width = "100%";
        text.onChange((value) => {
          editText = value;
        });
        setTimeout(() => text.inputEl.focus(), 50);
      });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Save")
          .setCta()
          .onClick(() => {
            if (!editText.trim()) return;
            this.saveEdit(editText.trim());
            this.close();
          })
      )
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => this.close())
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private saveEdit(newText: string): void {
    const author = this.plugin.settings.userName || "Unknown";
    const timestamp = new Date().toISOString();

    const data = this.canvas.getData();
    const node = data.nodes.find((n) => n.id === this.targetId) as CanvasTextData | undefined;
    if (!node) return;

    node.text = formatCommentText(author, newText, timestamp);
    this.canvas.setData(data);
    this.canvas.requestSave();
    this.plugin.scheduleQuickSync();
  }
}

/**
 * Resolve (remove) a canvas comment node and its edge.
 */
export function resolveCanvasComment(plugin: TeamVaultPlugin): void {
  const canvas = getCanvas(plugin);
  if (!canvas) return;

  const targetId = getSelectedNodeId(canvas);
  if (!targetId) {
    notifyInfo("Select a comment node (💬) to resolve.");
    return;
  }

  const data = canvas.getData();
  const node = data.nodes.find((n) => n.id === targetId);
  if (!node || !isCommentNode(node)) {
    notifyInfo("Select a comment node (💬) to resolve.");
    return;
  }

  // Remove the comment node and any edges connected to it
  data.nodes = data.nodes.filter((n) => n.id !== targetId);
  data.edges = data.edges.filter(
    (e) => e.fromNode !== targetId && e.toNode !== targetId
  );

  canvas.setData(data);
  canvas.requestSave();
  plugin.scheduleQuickSync();
}

/**
 * Register right-click context menu on canvas views.
 * Watches for canvas views becoming active, then hooks the DOM contextmenu event.
 */
export function registerCanvasContextMenu(plugin: TeamVaultPlugin): void {
  // Track which canvas containers we've already hooked
  const hooked = new WeakSet<HTMLElement>();

  const hookCanvas = () => {
    const leaf = plugin.app.workspace.activeLeaf;
    if (!leaf || leaf.view.getViewType() !== "canvas") return;

    const container = leaf.view.containerEl;
    if (hooked.has(container)) return;
    hooked.add(container);

    container.addEventListener("contextmenu", (evt: MouseEvent) => {
      const canvas = getCanvas(plugin);
      if (!canvas) return;

      // Only show our menu if a node is selected
      if (canvas.selection.size !== 1) return;
      const [selectedNode] = canvas.selection;
      if (!selectedNode) return;

      const data = canvas.getData();
      const nodeData = data.nodes.find((n) => n.id === selectedNode.id);
      const isComment = nodeData ? isCommentNode(nodeData) : false;

      // Small delay to let Obsidian's native menu render first, then append
      setTimeout(() => {
        const menu = new Menu();

        if (isComment) {
          // Right-clicked on a comment node — show comment actions
          menu.addItem((item) =>
            item
              .setTitle("Reply to comment")
              .setIcon("reply")
              .onClick(() => replyToCanvasComment(plugin))
          );
          menu.addItem((item) =>
            item
              .setTitle("Edit comment")
              .setIcon("pencil")
              .onClick(() => editCanvasComment(plugin))
          );
          menu.addSeparator();
          menu.addItem((item) =>
            item
              .setTitle("Resolve comment")
              .setIcon("check-circle")
              .onClick(() => resolveCanvasComment(plugin))
          );
        } else {
          // Right-clicked on a regular node — show "Add comment"
          menu.addItem((item) =>
            item
              .setTitle("Add comment")
              .setIcon("message-square")
              .onClick(() => addCanvasComment(plugin))
          );
        }

        menu.showAtMouseEvent(evt);
      }, 0);
    });
  };

  // Hook when canvas views become active
  plugin.registerEvent(
    plugin.app.workspace.on("active-leaf-change", hookCanvas)
  );
  // Also hook on layout changes (canvas tab switches)
  plugin.registerEvent(
    plugin.app.workspace.on("layout-change", hookCanvas)
  );
}
