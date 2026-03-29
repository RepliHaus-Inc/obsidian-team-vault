import { execFile } from "child_process";
import { stat, unlink } from "fs/promises";
import { join } from "path";

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GitErrorType =
  | "auth"
  | "network"
  | "conflict"
  | "lock"
  | "not-repo"
  | "unknown";

export class GitError extends Error {
  type: GitErrorType;
  stderr: string;

  constructor(message: string, type: GitErrorType, stderr: string) {
    super(message);
    this.name = "GitError";
    this.type = type;
    this.stderr = stderr;
  }
}

const DEFAULT_TIMEOUT = 60_000;
const LARGE_OP_TIMEOUT = 300_000;

/** Strip potential credentials from git output */
function sanitizeGitOutput(text: string): string {
  // Remove PAT from URLs: https://ghp_xxx@github.com → https://***@github.com
  return text.replace(/https?:\/\/[^@\s]+@/g, "https://***@");
}

export class Git {
  constructor(private cwd: string) {}

  private run(args: string[], timeout = DEFAULT_TIMEOUT): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        "git",
        args,
        {
          cwd: this.cwd,
          timeout,
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        },
        (error, stdout, stderr) => {
          if (error && "code" in error && error.code === "ETIMEDOUT") {
            reject(
              new GitError(
                `Git operation timed out: git ${args.join(" ")}`,
                "unknown",
                sanitizeGitOutput(stderr)
              )
            );
            return;
          }

          const exitCode =
            error && "code" in error && typeof error.code === "number"
              ? error.code
              : error
                ? 1
                : 0;

          if (exitCode !== 0) {
            const sanitizedStderr = sanitizeGitOutput(stderr);
            const errType = this.classifyError(sanitizedStderr);
            reject(
              new GitError(
                `git ${args[0]} failed: ${sanitizedStderr.trim() || stdout.trim()}`,
                errType,
                sanitizedStderr
              )
            );
            return;
          }

          resolve({ stdout, stderr, exitCode: 0 });
        }
      );

      child.on("error", (err) => {
        reject(
          new GitError(
            `Failed to execute git: ${err.message}`,
            "unknown",
            ""
          )
        );
      });
    });
  }

  /** Validate a git ref string to prevent argument injection */
  private validateRef(ref: string): void {
    if (!/^[a-zA-Z0-9_.\/~^@{}:\-]+$/.test(ref)) {
      throw new GitError(`Invalid git ref: ${ref}`, "unknown", "");
    }
  }

  /** Validate a file path to prevent traversal */
  private validatePath(path: string): void {
    if (path.includes("..") || path.startsWith("/")) {
      throw new GitError(`Invalid path: ${path}`, "unknown", "");
    }
  }

  private classifyError(stderr: string): GitErrorType {
    const s = stderr.toLowerCase();
    if (
      s.includes("authentication") ||
      s.includes("permission denied") ||
      s.includes("could not read username") ||
      s.includes("invalid credentials") ||
      s.includes("401") ||
      s.includes("403")
    ) {
      return "auth";
    }
    if (
      s.includes("could not resolve host") ||
      s.includes("unable to access") ||
      s.includes("network") ||
      s.includes("timed out") ||
      s.includes("connection refused")
    ) {
      return "network";
    }
    if (
      s.includes("conflict") ||
      s.includes("merge") ||
      s.includes("unmerged")
    ) {
      return "conflict";
    }
    if (s.includes("lock") || s.includes("index.lock")) {
      return "lock";
    }
    if (s.includes("not a git repository") || s.includes("fatal: not a git")) {
      return "not-repo";
    }
    return "unknown";
  }

  // --- Public API ---

  async status(): Promise<string> {
    const result = await this.run(["status", "--porcelain"]);
    return result.stdout;
  }

  async statusFiles(): Promise<{ status: string; path: string }[]> {
    const output = await this.status();
    if (!output.trim()) return [];
    return output
      .trim()
      .split("\n")
      .map((line) => ({
        status: line.substring(0, 2).trim(),
        path: line.substring(3),
      }));
  }

  async hasChanges(): Promise<boolean> {
    const output = await this.status();
    return output.trim().length > 0;
  }

  async fetch(): Promise<void> {
    await this.run(["fetch", "origin"], LARGE_OP_TIMEOUT);
  }

  async pull(): Promise<GitResult> {
    return this.run(
      ["pull", "--no-rebase", "origin", "main"],
      LARGE_OP_TIMEOUT
    );
  }

  async stash(): Promise<boolean> {
    const result = await this.run([
      "stash",
      "push",
      "-m",
      "tv-autostash",
    ]);
    return !result.stdout.includes("No local changes");
  }

  async stashPop(): Promise<void> {
    await this.run(["stash", "pop"]);
  }

  async add(paths: string[] = ["-A"]): Promise<void> {
    await this.run(["add", ...paths]);
  }

  async commit(message: string): Promise<string> {
    const result = await this.run(["commit", "-m", message]);
    const match = result.stdout.match(/\[[\w/]+ ([a-f0-9]+)\]/);
    return match ? match[1] : "";
  }

  async push(): Promise<void> {
    await this.run(["push", "origin", "main"], LARGE_OP_TIMEOUT);
  }

  async log(
    maxCount = 20,
    format = "%H|%an|%ae|%at|%s"
  ): Promise<
    {
      hash: string;
      author: string;
      email: string;
      timestamp: number;
      message: string;
    }[]
  > {
    const result = await this.run([
      "log",
      `--max-count=${maxCount}`,
      `--format=${format}`,
    ]);

    if (!result.stdout.trim()) return [];

    return result.stdout
      .trim()
      .split("\n")
      .map((line) => {
        const [hash, author, email, timestamp, ...messageParts] =
          line.split("|");
        return {
          hash,
          author,
          email,
          timestamp: parseInt(timestamp, 10),
          message: messageParts.join("|"),
        };
      });
  }

  async logNameOnly(
    maxCount = 20
  ): Promise<
    {
      hash: string;
      author: string;
      timestamp: number;
      message: string;
      files: string[];
    }[]
  > {
    // Use a separator that can't appear in filenames
    const SEP = "<<<TEAMVAULT>>>";
    const result = await this.run([
      "log",
      `--max-count=${maxCount}`,
      `--format=${SEP}%H${SEP}%an${SEP}%at${SEP}%s`,
      "--name-only",
    ]);

    if (!result.stdout.trim()) return [];

    const entries: {
      hash: string;
      author: string;
      timestamp: number;
      message: string;
      files: string[];
    }[] = [];

    // Split into commit blocks by our unique separator
    const parts = result.stdout.split(SEP);
    // parts[0] is empty (before first separator), then groups of 4 (hash, author, ts, msg+files)
    let i = 1;
    while (i + 3 < parts.length) {
      const hash = parts[i].trim();
      const author = parts[i + 1];
      const timestamp = parts[i + 2];
      const msgAndFiles = parts[i + 3];
      i += 4;

      const lines = msgAndFiles.split("\n").filter((l) => l.length > 0);
      const message = lines[0] || "";
      const files = lines.slice(1);

      entries.push({
        hash,
        author,
        timestamp: parseInt(timestamp, 10),
        message,
        files,
      });
    }

    return entries;
  }

  async diff(ref1: string, ref2 = "HEAD"): Promise<string[]> {
    this.validateRef(ref1);
    this.validateRef(ref2);
    const result = await this.run(["diff", "--name-only", `${ref1}..${ref2}`]);
    if (!result.stdout.trim()) return [];
    return result.stdout.trim().split("\n");
  }

  async getHeadHash(): Promise<string> {
    const result = await this.run(["rev-parse", "HEAD"]);
    return result.stdout.trim();
  }

  async getShortHash(): Promise<string> {
    const result = await this.run(["rev-parse", "--short", "HEAD"]);
    return result.stdout.trim();
  }

  async showFile(ref: string, path: string): Promise<string> {
    this.validateRef(ref);
    this.validatePath(path);
    const result = await this.run(["show", `${ref}:${path}`]);
    return result.stdout;
  }

  async getConflictedFiles(): Promise<string[]> {
    const statusOutput = await this.status();
    if (!statusOutput.trim()) return [];

    return statusOutput
      .trim()
      .split("\n")
      .filter((line) => {
        const code = line.substring(0, 2);
        return (
          code === "UU" || code === "AA" || code === "UA" || code === "AU"
        );
      })
      .map((line) => line.substring(3));
  }

  async getOursVersion(path: string): Promise<string> {
    return this.showFile(":2", path);
  }

  async getTheirsVersion(path: string): Promise<string> {
    return this.showFile(":3", path);
  }

  async markResolved(path: string): Promise<void> {
    await this.run(["add", path]);
  }

  async abortRebase(): Promise<void> {
    await this.run(["rebase", "--abort"]);
  }

  async continueRebase(): Promise<void> {
    await this.run(["rebase", "--continue"]);
  }

  async getUserName(): Promise<string | null> {
    try {
      const result = await this.run(["config", "user.name"]);
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async getUserEmail(): Promise<string | null> {
    try {
      const result = await this.run(["config", "user.email"]);
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async setUserName(name: string): Promise<void> {
    await this.run(["config", "user.name", name]);
  }

  async setUserEmail(email: string): Promise<void> {
    await this.run(["config", "user.email", email]);
  }

  async getBranch(): Promise<string> {
    const result = await this.run(["branch", "--show-current"]);
    return result.stdout.trim();
  }

  async getRemoteUrl(): Promise<string> {
    const result = await this.run(["remote", "get-url", "origin"]);
    return result.stdout.trim();
  }

  async isRebaseInProgress(): Promise<boolean> {
    const rebaseMerge = join(this.cwd, ".git", "rebase-merge");
    const rebaseApply = join(this.cwd, ".git", "rebase-apply");
    try {
      await stat(rebaseMerge);
      return true;
    } catch {
      /* not found */
    }
    try {
      await stat(rebaseApply);
      return true;
    } catch {
      return false;
    }
  }

  async pullMerge(): Promise<GitResult> {
    return this.run(
      ["pull", "--no-rebase", "origin", "main"],
      LARGE_OP_TIMEOUT
    );
  }

  async hasStash(name: string): Promise<boolean> {
    try {
      const result = await this.run(["stash", "list"]);
      return result.stdout.includes(name);
    } catch {
      return false;
    }
  }

  async stashDrop(name: string): Promise<void> {
    try {
      const result = await this.run(["stash", "list"]);
      const lines = result.stdout.trim().split("\n");
      for (const line of lines) {
        if (line.includes(name)) {
          const ref = line.split(":")[0]; // e.g. "stash@{0}"
          if (!/^stash@\{\d+\}$/.test(ref)) continue; // validate format
          await this.run(["stash", "drop", ref]);
          return;
        }
      }
    } catch {
      /* ignore — stash may already be gone */
    }
  }

  /**
   * Get unified diff for a specific file between two commits (or HEAD~1..HEAD).
   * Returns added/removed line numbers in the current file.
   */
  async diffFileLines(
    filePath: string,
    fromRef = "HEAD~1",
    toRef = "HEAD"
  ): Promise<{ added: number[]; removed: number[] }> {
    this.validateRef(fromRef);
    this.validateRef(toRef);
    this.validatePath(filePath);
    const added: number[] = [];
    const removed: number[] = [];
    try {
      const result = await this.run([
        "diff",
        "-U0",
        `${fromRef}..${toRef}`,
        "--",
        filePath,
      ]);
      // Parse unified diff hunks: @@ -old,count +new,count @@
      const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
      for (const line of result.stdout.split("\n")) {
        const m = hunkRe.exec(line);
        if (m) {
          const oldStart = parseInt(m[1], 10);
          const oldCount = parseInt(m[2] ?? "1", 10);
          const newStart = parseInt(m[3], 10);
          const newCount = parseInt(m[4] ?? "1", 10);
          for (let i = 0; i < oldCount; i++) removed.push(oldStart + i);
          for (let i = 0; i < newCount; i++) added.push(newStart + i);
        }
      }
    } catch {
      // diff might fail if file didn't exist before — treat as all-new
    }
    return { added, removed };
  }

  async checkAndCleanLock(): Promise<boolean> {
    const lockPath = join(this.cwd, ".git", "index.lock");
    try {
      const lockStat = await stat(lockPath);
      const ageMs = Date.now() - lockStat.mtimeMs;
      if (ageMs > 10 * 60 * 1000) {
        await unlink(lockPath);
        return true;
      }
      return false;
    } catch {
      return true;
    }
  }
}
