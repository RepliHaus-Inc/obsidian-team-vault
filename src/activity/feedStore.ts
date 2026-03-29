import { GitHistory, type GitHistoryEntry } from "./gitHistory";
import { GitHubApi } from "./githubApi";
import { resolveAuthorName, type TeamVaultSettings } from "../settings";
import type { CommentStore } from "../comments/commentStore";
import type { GitHubCommit, GitHubPullRequest } from "../utils/github";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

export type FeedEntryType =
  | "vault-change"
  | "vault-session"
  | "github-commit"
  | "github-pr"
  | "comment"
  | "mention";

export interface FeedEntry {
  id: string;
  type: FeedEntryType;
  author: string;
  action: string;
  target: string;
  targetPath?: string;
  url?: string;
  timestamp: number;
  /** For vault-session: list of changed files */
  files?: string[];
  /** For vault-session: session start time */
  sessionStart?: number;
  /** For vault-session: number of comments in session */
  commentCount?: number;
}

export class FeedStore {
  private entries: FeedEntry[] = [];
  private gitHistory: GitHistory | null = null;
  private githubApi: GitHubApi;
  private lastSeenHash: string | null = null;
  private lastViewedTimestamp: number = 0;

  constructor(private settings: TeamVaultSettings) {
    this.githubApi = new GitHubApi(settings);
  }

  async refresh(vaultPath: string, commentStore?: CommentStore): Promise<void> {
    this.gitHistory = new GitHistory(vaultPath);
    this.entries = [];

    // Load last-seen tracking
    await this.loadLastSeen(vaultPath);

    // Fetch from all sources in parallel
    const [gitEntries, commentEntries] = await Promise.all([
      this.fetchGitEntries(),
      commentStore ? this.fetchCommentEntries(commentStore) : Promise.resolve([]),
    ]);

    this.entries = [...gitEntries, ...commentEntries];

    // Sort by timestamp descending
    this.entries.sort((a, b) => b.timestamp - a.timestamp);

    // Deduplicate (git log and GitHub commits overlap)
    this.dedup();

  }

  getEntries(filter?: {
    author?: string;
    type?: FeedEntryType;
    types?: FeedEntryType[];
  }): FeedEntry[] {
    let result = this.entries;
    if (filter?.author) {
      const name = filter.author;
      const nameLower = name.toLowerCase();
      // Both directions: activity BY this person OR @mentioning this person
      result = result.filter(
        (e) =>
          e.author === name ||
          (e.action && e.action.toLowerCase().includes(`@${nameLower}`))
      );
    }
    if (filter?.types) {
      result = result.filter((e) => filter.types!.includes(e.type));
    } else if (filter?.type) {
      result = result.filter((e) => e.type === filter.type);
    }
    return result;
  }

  getNewSinceLastSync(): FeedEntry[] {
    if (!this.lastSeenHash) return this.entries;
    // Find entries newer than the last-seen commit
    const lastEntry = this.entries.find(
      (e) => e.type === "vault-change" && e.id.startsWith(this.lastSeenHash!)
    );
    if (!lastEntry) return this.entries;
    return this.entries.filter((e) => e.timestamp > lastEntry.timestamp);
  }

  addCommentEntry(
    author: string,
    filePath: string,
    isMention: boolean,
    mentionedNames?: string[]
  ): void {
    const fileName = filePath.split("/").pop() || filePath;
    let action: string;
    if (isMention && mentionedNames && mentionedNames.length > 0) {
      const names = mentionedNames.map((n) => `@${n}`).join(", ");
      action = `mentioned ${names} on`;
    } else if (isMention) {
      action = "mentioned someone on";
    } else {
      action = "commented on";
    }

    const entry: FeedEntry = {
      id: `comment-${Date.now()}`,
      type: isMention ? "mention" : "comment",
      author,
      action,
      target: fileName,
      targetPath: filePath,
      timestamp: Date.now() / 1000,
    };
    this.entries.unshift(entry);
  }

  isNewEntry(entry: FeedEntry): boolean {
    return entry.timestamp > this.lastViewedTimestamp;
  }

  async markFeedViewed(vaultPath: string): Promise<void> {
    this.lastViewedTimestamp = Date.now() / 1000;
    const dir = join(vaultPath, ".team-vault", "local");
    await mkdir(dir, { recursive: true });
    const data = JSON.stringify({
      lastSeenHash: this.lastSeenHash,
      lastViewedTimestamp: this.lastViewedTimestamp,
    });
    await writeFile(join(dir, "last-seen.json"), data, "utf-8");
  }

  async saveLastSeen(vaultPath: string, hash: string): Promise<void> {
    const dir = join(vaultPath, ".team-vault", "local");
    await mkdir(dir, { recursive: true });
    const data = JSON.stringify({
      lastSeenHash: hash,
      lastViewedTimestamp: this.lastViewedTimestamp,
    });
    await writeFile(join(dir, "last-seen.json"), data, "utf-8");
    this.lastSeenHash = hash;
  }

  // --- Private ---

  private async loadLastSeen(vaultPath: string): Promise<void> {
    try {
      const data = await readFile(
        join(vaultPath, ".team-vault", "local", "last-seen.json"),
        "utf-8"
      );
      const parsed = JSON.parse(data);
      this.lastSeenHash = parsed.lastSeenHash || null;
      this.lastViewedTimestamp = parsed.lastViewedTimestamp || 0;
    } catch {
      this.lastSeenHash = null;
      this.lastViewedTimestamp = 0;
    }
  }

  /**
   * Group git commits into sessions. Consecutive commits by the same
   * author within 30 minutes become one "vault-session" entry.
   */
  private async fetchGitEntries(): Promise<FeedEntry[]> {
    if (!this.gitHistory) return [];
    try {
      const history = await this.gitHistory.getRecentHistory(50);
      const SESSION_GAP = 30 * 60; // 30 minutes in seconds

      // Build raw commit data (filtered, newest first)
      const commits: { author: string; timestamp: number; files: string[] }[] = [];
      for (const entry of history) {
        const userFiles = entry.files.filter(
          (f) => !f.startsWith(".team-vault/") && !f.startsWith(".obsidian/") && !f.startsWith(".gitignore")
        );
        if (userFiles.length === 0) continue;
        commits.push({
          author: resolveAuthorName(entry.author, this.settings),
          timestamp: entry.timestamp,
          files: userFiles,
        });
      }

      // Group into sessions (commits already sorted newest-first)
      const sessions: FeedEntry[] = [];
      let i = 0;
      while (i < commits.length) {
        const author = commits[i].author;
        const sessionEnd = commits[i].timestamp; // newest in session
        const allFiles = new Set(commits[i].files);
        let sessionStart = commits[i].timestamp;
        let j = i + 1;

        // Extend session: same author, within gap
        while (j < commits.length && commits[j].author === author &&
               sessionStart - commits[j].timestamp < SESSION_GAP) {
          for (const f of commits[j].files) allFiles.add(f);
          sessionStart = commits[j].timestamp;
          j++;
        }

        const fileList = [...allFiles];
        const commitCount = j - i;
        const duration = sessionEnd - sessionStart;
        const durationMin = Math.round(duration / 60);

        let action: string;
        if (commitCount === 1 && fileList.length === 1) {
          action = "updated";
        } else if (durationMin < 1) {
          action = `updated ${fileList.length} file(s)`;
        } else {
          action = `active for ${durationMin}m · ${fileList.length} file(s)`;
        }

        sessions.push({
          id: `session-${sessionEnd}-${author}`,
          type: commitCount === 1 ? "vault-change" as FeedEntryType : "vault-session" as FeedEntryType,
          author,
          action,
          target: commitCount === 1 ? fileList[0] : `${fileList.length} files`,
          targetPath: commitCount === 1 ? fileList[0] : undefined,
          timestamp: sessionEnd,
          files: fileList,
          sessionStart: commitCount > 1 ? sessionStart : undefined,
        });

        i = j;
      }

      return sessions;
    } catch {
      return [];
    }
  }

  private async fetchGitHubCommits(): Promise<FeedEntry[]> {
    try {
      const commits = await this.githubApi.getRecentCommits(20);
      return commits
        .map((c) => ({
          id: `ghcommit-${c.sha}`,
          type: "github-commit" as FeedEntryType,
          author: resolveAuthorName(
            c.author?.login || c.commit?.author?.name || "",
            this.settings
          ),
          action: "pushed",
          target: c.commit.message.split("\n")[0],
          url: `https://github.com/${this.settings.githubRepo}/commit/${c.sha}`,
          timestamp: new Date(c.commit.author.date).getTime() / 1000,
        }))
        .filter((e) => e.author !== ""); // Skip entries with no identifiable author
    } catch {
      return [];
    }
  }

  private async fetchGitHubPRs(): Promise<FeedEntry[]> {
    try {
      const prs = await this.githubApi.getRecentPullRequests(10);
      return prs.map((pr) => ({
        id: `ghpr-${pr.number}`,
        type: "github-pr" as FeedEntryType,
        author: resolveAuthorName(pr.user?.login || "Unknown", this.settings),
        action: pr.merged_at
          ? "merged"
          : pr.state === "closed"
            ? "closed"
            : "opened",
        target: `PR #${pr.number}: ${pr.title}`,
        url: pr.html_url,
        timestamp: new Date(pr.updated_at).getTime() / 1000,
      }));
    } catch {
      return [];
    }
  }

  private async fetchCommentEntries(commentStore: CommentStore): Promise<FeedEntry[]> {
    try {
      const files = await commentStore.getAllFilesWithComments();
      const entries: FeedEntry[] = [];

      for (const filePath of files) {
        const comments = await commentStore.getCommentsForFile(filePath);
        for (const comment of comments) {
          const fileName = filePath.split("/").pop() || filePath;
          entries.push({
            id: `comment-${comment.id}`,
            type: this.hasAtMentions(comment.text) ? "mention" : "comment",
            author: comment.author,
            action: this.describeCommentAction(comment.text),
            target: fileName,
            targetPath: filePath,
            timestamp: new Date(comment.createdAt).getTime() / 1000,
          });

          for (const reply of comment.replies) {
            entries.push({
              id: `comment-${reply.id}`,
              type: this.hasAtMentions(reply.text) ? "mention" : "comment",
              author: reply.author,
              action: this.hasAtMentions(reply.text)
                ? this.describeCommentAction(reply.text)
                : "replied on",
              target: fileName,
              targetPath: filePath,
              timestamp: new Date(reply.createdAt).getTime() / 1000,
            });
          }
        }
      }

      return entries;
    } catch (err) {
      console.error("[TeamVault FeedStore] fetchCommentEntries error:", err);
      return [];
    }
  }

  private hasAtMentions(text: string): boolean {
    return /@\w+/.test(text);
  }

  private describeCommentAction(text: string): string {
    const mentions = text.match(/@(\w+)/g);
    if (mentions && mentions.length > 0) {
      const names = mentions.map((m) => m).join(", ");
      return `mentioned ${names} on`;
    }
    return "commented on";
  }

  // describeCommitFiles removed — sessions handle descriptions

  private dedup(): void {
    const seen = new Set<string>();
    this.entries = this.entries.filter((e) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
  }
}
