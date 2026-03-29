import { requestUrl } from "obsidian";
import type { TeamVaultSettings } from "../settings";
import type { Comment, CommentReply, CommentStore } from "./commentStore";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

interface SyncQueueItem {
  action: "create-discussion" | "add-comment" | "add-reply";
  filePath: string;
  commentId?: string;
  replyId?: string;
  timestamp: number;
}

interface DiscussionMapping {
  [filePath: string]: {
    discussionId: string;
    discussionNumber: number;
    commentMappings: { [localId: string]: string }; // local ID → GitHub comment ID
  };
}

export class DiscussionSync {
  private queue: SyncQueueItem[] = [];
  private mappings: DiscussionMapping = {};
  private localDir: string;

  constructor(
    private vaultPath: string,
    private settings: TeamVaultSettings,
    private commentStore: CommentStore
  ) {
    this.localDir = join(vaultPath, ".team-vault", "local");
  }

  async init(): Promise<void> {
    await mkdir(this.localDir, { recursive: true });
    await this.loadQueue();
    await this.loadMappings();
  }

  async syncComment(filePath: string, comment: Comment): Promise<void> {
    if (!this.settings.discussionsSyncEnabled) return;

    const mapping = this.mappings[filePath];
    if (!mapping) {
      // Queue discussion creation
      this.queue.push({
        action: "create-discussion",
        filePath,
        commentId: comment.id,
        timestamp: Date.now(),
      });
    } else {
      // Queue comment addition
      this.queue.push({
        action: "add-comment",
        filePath,
        commentId: comment.id,
        timestamp: Date.now(),
      });
    }

    await this.saveQueue();
    await this.drainQueue();
  }

  async syncReply(
    filePath: string,
    commentId: string,
    reply: CommentReply
  ): Promise<void> {
    if (!this.settings.discussionsSyncEnabled) return;

    this.queue.push({
      action: "add-reply",
      filePath,
      commentId,
      replyId: reply.id,
      timestamp: Date.now(),
    });

    await this.saveQueue();
    await this.drainQueue();
  }

  async drainQueue(): Promise<void> {
    if (!this.settings.githubPat || this.queue.length === 0) return;

    const processed: number[] = [];

    for (let i = 0; i < this.queue.length; i++) {
      const item = this.queue[i];
      try {
        switch (item.action) {
          case "create-discussion":
            await this.createDiscussion(item.filePath, item.commentId!);
            processed.push(i);
            break;
          case "add-comment":
            await this.addDiscussionComment(item.filePath, item.commentId!);
            processed.push(i);
            break;
          case "add-reply":
            // Replies are added as comments in the same discussion
            await this.addDiscussionComment(item.filePath, item.commentId!);
            processed.push(i);
            break;
        }
      } catch {
        // Leave in queue for retry on next sync
        break;
      }
    }

    // Remove processed items (reverse order to maintain indices)
    for (const idx of processed.reverse()) {
      this.queue.splice(idx, 1);
    }

    await this.saveQueue();
    await this.saveMappings();
  }

  // --- GraphQL Operations ---

  private async createDiscussion(
    filePath: string,
    commentId: string
  ): Promise<void> {
    const [owner, repo] = this.settings.githubRepo.split("/");
    const fileName = filePath.split("/").pop() || filePath;

    // Get repository ID and discussion category ID
    const repoData = await this.graphql(
      `query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          id
          discussionCategories(first: 10) {
            nodes { id name }
          }
        }
      }`,
      { owner, name: repo }
    );

    const repoId = repoData?.data?.repository?.id;
    const categories = repoData?.data?.repository?.discussionCategories?.nodes;
    if (!repoId || !categories || categories.length === 0) return;

    // Use "General" category or first available
    const category =
      categories.find(
        (c: { name: string }) => c.name.toLowerCase() === "general"
      ) || categories[0];

    // Get comment content
    const comments = await this.commentStore.getCommentsForFile(filePath);
    const comment = comments.find((c) => c.id === commentId);
    if (!comment) return;

    const body = this.formatCommentAsMarkdown(comment, filePath);

    const result = await this.graphql(
      `mutation($repoId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
        createDiscussion(input: {
          repositoryId: $repoId,
          categoryId: $categoryId,
          title: $title,
          body: $body
        }) {
          discussion {
            id
            number
          }
        }
      }`,
      { repoId, categoryId: category.id, title: `Comments: ${fileName}`, body }
    );

    const discussion = result?.data?.createDiscussion?.discussion;
    if (discussion) {
      this.mappings[filePath] = {
        discussionId: discussion.id,
        discussionNumber: discussion.number,
        commentMappings: { [commentId]: discussion.id },
      };
    }
  }

  private async addDiscussionComment(
    filePath: string,
    commentId: string
  ): Promise<void> {
    const mapping = this.mappings[filePath];
    if (!mapping) return;

    // Skip if already synced
    if (mapping.commentMappings[commentId]) return;

    const comments = await this.commentStore.getCommentsForFile(filePath);
    const comment = comments.find((c) => c.id === commentId);
    if (!comment) return;

    const body = this.formatCommentAsMarkdown(comment, filePath);

    const result = await this.graphql(
      `mutation($discussionId: ID!, $body: String!) {
        addDiscussionComment(input: {
          discussionId: $discussionId,
          body: $body
        }) {
          comment { id }
        }
      }`,
      { discussionId: mapping.discussionId, body }
    );

    const ghCommentId = result?.data?.addDiscussionComment?.comment?.id;
    if (ghCommentId) {
      mapping.commentMappings[commentId] = ghCommentId;
    }
  }

  /** Escape markdown formatting chars in author names */
  private escapeMarkdown(text: string): string {
    return text.replace(/([*_`~\[\]\\])/g, "\\$1");
  }

  private formatCommentAsMarkdown(
    comment: Comment,
    filePath: string
  ): string {
    const parts: string[] = [];
    parts.push(`**${this.escapeMarkdown(comment.author)}** commented on \`${filePath}\`:`);
    parts.push("");

    if (comment.anchor.selectedText) {
      parts.push(`> ${comment.anchor.selectedText}`);
      parts.push("");
    }

    parts.push(comment.text);

    if (comment.replies.length > 0) {
      parts.push("");
      parts.push("---");
      for (const reply of comment.replies) {
        parts.push(`**${this.escapeMarkdown(reply.author)}**: ${reply.text}`);
      }
    }

    return parts.join("\n");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async graphql(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<any> {
    try {
      const response = await requestUrl({
        url: "https://api.github.com/graphql",
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.settings.githubPat}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });
      return response.json;
    } catch {
      return null;
    }
  }

  // --- Persistence ---

  private async loadQueue(): Promise<void> {
    try {
      const data = await readFile(
        join(this.localDir, "sync-queue.json"),
        "utf-8"
      );
      this.queue = JSON.parse(data);
    } catch {
      this.queue = [];
    }
  }

  private async saveQueue(): Promise<void> {
    await writeFile(
      join(this.localDir, "sync-queue.json"),
      JSON.stringify(this.queue, null, 2),
      "utf-8"
    );
  }

  private async loadMappings(): Promise<void> {
    try {
      const data = await readFile(
        join(this.localDir, "discussion-mappings.json"),
        "utf-8"
      );
      this.mappings = JSON.parse(data);
    } catch {
      this.mappings = {};
    }
  }

  private async saveMappings(): Promise<void> {
    await writeFile(
      join(this.localDir, "discussion-mappings.json"),
      JSON.stringify(this.mappings, null, 2),
      "utf-8"
    );
  }
}
