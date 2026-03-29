import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";

export interface CommentAnchor {
  selectedText: string;
  contextBefore: string;
  contextAfter: string;
  lineNumber: number;
}

export interface Comment {
  id: string;
  author: string;
  text: string;
  anchor: CommentAnchor;
  createdAt: string;
  resolved: boolean;
  discussionCommentId?: string;
  replies: CommentReply[];
}

export interface CommentReply {
  id: string;
  author: string;
  text: string;
  createdAt: string;
  discussionCommentId?: string;
}

export interface FileComments {
  filePath: string;
  comments: Comment[];
}

interface CommentIndex {
  [hash: string]: string; // hash → file path
}

export class CommentStore {
  private commentsDir: string;
  private localDir: string;
  private index: CommentIndex = {};
  private cache: Map<string, FileComments> = new Map();
  /** Comment IDs hidden locally (not synced — stored in .team-vault/local/) */
  private locallyDeleted: Set<string> = new Set();

  constructor(private vaultPath: string) {
    this.commentsDir = join(vaultPath, ".team-vault", "comments");
    this.localDir = join(vaultPath, ".team-vault", "local");
  }

  async load(): Promise<void> {
    await mkdir(this.commentsDir, { recursive: true });
    await mkdir(this.localDir, { recursive: true });
    await this.loadIndex();
    await this.loadLocallyDeleted();
  }

  // --- Public API ---

  async getCommentsForFile(filePath: string): Promise<Comment[]> {
    const hash = this.hashPath(filePath);
    const cached = this.cache.get(hash);
    const comments = cached
      ? cached.comments
      : await this.readFileComments(hash, filePath);

    // Filter out locally deleted comments
    return comments.filter((c) => !this.locallyDeleted.has(c.id));
  }

  private async readFileComments(
    hash: string,
    filePath: string
  ): Promise<Comment[]> {
    try {
      const data = await readFile(
        join(this.commentsDir, `${hash}.json`),
        "utf-8"
      );
      const fileComments: FileComments = JSON.parse(data);
      this.cache.set(hash, fileComments);
      return fileComments.comments;
    } catch {
      return [];
    }
  }

  async addComment(
    filePath: string,
    author: string,
    text: string,
    anchor: CommentAnchor
  ): Promise<Comment> {
    const comments = await this.getCommentsForFile(filePath);

    const comment: Comment = {
      id: this.generateId(),
      author,
      text,
      anchor,
      createdAt: new Date().toISOString(),
      resolved: false,
      replies: [],
    };

    comments.push(comment);
    await this.saveFileComments(filePath, comments);
    return comment;
  }

  async addReply(
    filePath: string,
    commentId: string,
    author: string,
    text: string
  ): Promise<CommentReply | null> {
    const comments = await this.getCommentsForFile(filePath);
    const comment = comments.find((c) => c.id === commentId);
    if (!comment) return null;

    const reply: CommentReply = {
      id: this.generateId(),
      author,
      text,
      createdAt: new Date().toISOString(),
    };

    comment.replies.push(reply);
    await this.saveFileComments(filePath, comments);
    return reply;
  }

  async resolveComment(
    filePath: string,
    commentId: string
  ): Promise<void> {
    const comments = await this.getCommentsForFile(filePath);
    const comment = comments.find((c) => c.id === commentId);
    if (comment) {
      comment.resolved = true;
      await this.saveFileComments(filePath, comments);
    }
  }

  /**
   * Delete is local-only — hides the comment for this user without
   * removing it from the shared JSON. Other team members still see it.
   * Resolve is the shared action (syncs via git).
   */
  async deleteComment(
    _filePath: string,
    commentId: string
  ): Promise<void> {
    this.locallyDeleted.add(commentId);
    await this.saveLocallyDeleted();
  }

  async getUnresolvedCount(filePath: string): Promise<number> {
    const comments = await this.getCommentsForFile(filePath);
    return comments.filter((c) => !c.resolved).length;
  }

  async getAllFilesWithComments(): Promise<string[]> {
    // Reload index and clear cache to pick up changes synced via git
    await this.loadIndex();
    this.cache.clear();
    const files = Object.values(this.index);
    return files;
  }

  async getFilesWithUnresolvedComments(): Promise<string[]> {
    const files: string[] = [];
    for (const filePath of Object.values(this.index)) {
      const count = await this.getUnresolvedCount(filePath);
      if (count > 0) files.push(filePath);
    }
    return files;
  }

  // --- Anchor Resolution ---

  resolveAnchorLine(
    fileContent: string,
    anchor: CommentAnchor
  ): number | null {
    const lines = fileContent.split("\n");

    // Strategy 1: exact match at original line number
    if (anchor.lineNumber > 0 && anchor.lineNumber <= lines.length) {
      const line = lines[anchor.lineNumber - 1];
      if (line.includes(anchor.selectedText)) {
        return anchor.lineNumber;
      }
    }

    // Strategy 2: search for exact selectedText with context
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(anchor.selectedText)) {
        // Check context
        const before =
          i > 0 ? lines[i - 1] : "";
        const after =
          i < lines.length - 1 ? lines[i + 1] : "";
        if (
          this.fuzzyMatch(before, anchor.contextBefore) ||
          this.fuzzyMatch(after, anchor.contextAfter)
        ) {
          return i + 1;
        }
      }
    }

    // Strategy 3: search for selectedText anywhere (no context match)
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(anchor.selectedText)) {
        return i + 1;
      }
    }

    // Strategy 4: fuzzy match using longest common subsequence
    let bestLine = -1;
    let bestScore = 0;
    for (let i = 0; i < lines.length; i++) {
      const score = this.lcsLength(lines[i], anchor.selectedText);
      const ratio = score / Math.max(lines[i].length, anchor.selectedText.length, 1);
      if (ratio > 0.6 && score > bestScore) {
        bestScore = score;
        bestLine = i + 1;
      }
    }

    if (bestLine > 0) return bestLine;

    // Orphaned — return null
    return null;
  }

  // --- Private ---

  private async loadIndex(): Promise<void> {
    try {
      const data = await readFile(
        join(this.commentsDir, "_index.json"),
        "utf-8"
      );
      this.index = JSON.parse(data);
    } catch {
      this.index = {};
    }
  }

  private async saveIndex(): Promise<void> {
    await writeFile(
      join(this.commentsDir, "_index.json"),
      JSON.stringify(this.index, null, 2),
      "utf-8"
    );
  }

  private async saveFileComments(
    filePath: string,
    comments: Comment[]
  ): Promise<void> {
    const hash = this.hashPath(filePath);

    // Update index
    if (comments.length > 0) {
      this.index[hash] = filePath;
    } else {
      delete this.index[hash];
    }
    await this.saveIndex();

    // Save comment file
    const fileComments: FileComments = { filePath, comments };
    this.cache.set(hash, fileComments);

    await mkdir(this.commentsDir, { recursive: true });
    await writeFile(
      join(this.commentsDir, `${hash}.json`),
      JSON.stringify(fileComments, null, 2),
      "utf-8"
    );
  }

  private hashPath(filePath: string): string {
    return createHash("sha256").update(filePath).digest("hex").substring(0, 12);
  }

  private generateId(): string {
    return crypto.randomUUID();
  }

  private async loadLocallyDeleted(): Promise<void> {
    try {
      const data = await readFile(
        join(this.localDir, "deleted-comments.json"),
        "utf-8"
      );
      const ids: string[] = JSON.parse(data);
      this.locallyDeleted = new Set(ids);
    } catch {
      this.locallyDeleted = new Set();
    }
  }

  private async saveLocallyDeleted(): Promise<void> {
    await mkdir(this.localDir, { recursive: true });
    await writeFile(
      join(this.localDir, "deleted-comments.json"),
      JSON.stringify([...this.locallyDeleted]),
      "utf-8"
    );
  }

  private fuzzyMatch(a: string, b: string): boolean {
    if (!a || !b) return false;
    const ratio =
      this.lcsLength(a.trim(), b.trim()) /
      Math.max(a.trim().length, b.trim().length, 1);
    return ratio > 0.5;
  }

  private lcsLength(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    // Optimized: use two rows instead of full matrix
    let prev = new Array<number>(n + 1).fill(0);
    let curr = new Array<number>(n + 1).fill(0);

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          curr[j] = prev[j - 1] + 1;
        } else {
          curr[j] = Math.max(prev[j], curr[j - 1]);
        }
      }
      [prev, curr] = [curr, prev];
      curr.fill(0);
    }

    return prev[n];
  }
}
