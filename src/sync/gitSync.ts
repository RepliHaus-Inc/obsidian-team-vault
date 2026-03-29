import { Git, GitError } from "../utils/git";
import type { TeamVaultSettings } from "../settings";

export interface SyncResult {
  success: boolean;
  error: string | null;
  pulledFiles: { filename: string; author: string }[];
  pushedCount: number;
  conflicts: string[];
  commitHash: string | null;
}

const MAX_PUSH_RETRIES = 3;

export class GitSync {
  private git: Git;

  constructor(
    private vaultPath: string,
    private settings: TeamVaultSettings
  ) {
    this.git = new Git(vaultPath);
  }

  /**
   * Sync flow: commit → pull (merge) → push, with retry.
   *
   * If push fails because remote has new commits (someone pushed
   * between our pull and push), we pull again and retry. Up to 3 attempts.
   */
  async sync(): Promise<SyncResult> {
    const result: SyncResult = {
      success: false,
      error: null,
      pulledFiles: [],
      pushedCount: 0,
      conflicts: [],
      commitHash: null,
    };

    const lockClean = await this.git.checkAndCleanLock();
    if (!lockClean) {
      result.error =
        "Git lock file exists (another process may be running). Try again in a moment.";
      return result;
    }

    // Recovery: clean up any stuck rebase/merge state
    try {
      if (await this.git.isRebaseInProgress()) {
        console.log("[TeamVault] Aborting stuck rebase from previous sync");
        await this.git.abortRebase();
      }
    } catch {
      result.error =
        "Git is in a broken state. Please run 'git rebase --abort' in the vault folder.";
      return result;
    }

    try {
      // Step 1: Commit local changes first (so nothing is in limbo)
      const hasLocalChanges = await this.git.hasChanges();
      if (hasLocalChanges) {
        const statusFiles = await this.git.statusFiles();
        const count = statusFiles.length;
        const name = this.settings.userName || "Unknown";
        const message = `Vault sync by ${name} - ${count} file(s)`;

        await this.git.add();
        const hash = await this.git.commit(message);
        result.commitHash = hash;
        result.pushedCount = count;
      }

      // Step 2: Pull + Push with retry loop
      const headBefore = await this.git.getHeadHash();

      for (let attempt = 1; attempt <= MAX_PUSH_RETRIES; attempt++) {
        // Pull with merge to get remote changes
        try {
          await this.git.pull();
        } catch (err) {
          if (err instanceof GitError && err.type === "conflict") {
            const conflictedFiles = await this.git.getConflictedFiles();
            if (conflictedFiles.length > 0) {
              result.conflicts = conflictedFiles;
              return result;
            }
          }
          // Network errors on pull are fatal — no point retrying push
          throw err;
        }

        // Push
        try {
          await this.git.push();
          // Success — break out of retry loop
          break;
        } catch (err) {
          if (err instanceof GitError && err.type === "auth") {
            result.error =
              "Push failed: authentication error. Check your GitHub PAT in settings.";
            return result;
          }

          // If push was rejected (non-fast-forward), retry pull+push
          if (attempt < MAX_PUSH_RETRIES) {
            console.log(
              `[TeamVault] Push failed (attempt ${attempt}/${MAX_PUSH_RETRIES}), pulling and retrying...`
            );
            continue;
          }

          // Final attempt failed
          throw err;
        }
      }

      // Step 3: Detect pulled changes (unique user files only)
      const headAfter = await this.git.getHeadHash();
      if (headBefore !== headAfter) {
        const seen = new Set<string>();
        const commits = await this.git.logNameOnly(50);
        for (const commit of commits) {
          if (commit.hash === headBefore) break;
          for (const file of commit.files) {
            if (
              file.startsWith(".team-vault/") ||
              file.startsWith(".obsidian/") ||
              file === ".gitignore"
            )
              continue;
            if (seen.has(file)) continue;
            seen.add(file);
            result.pulledFiles.push({
              filename: file,
              author: commit.author || this.settings.userName || "Unknown",
            });
          }
        }
      }

      result.success = true;
    } catch (err) {
      if (err instanceof GitError) {
        switch (err.type) {
          case "auth":
            result.error =
              "Authentication failed. Check your GitHub PAT in settings.";
            break;
          case "network":
            result.error =
              "Network error — unable to reach GitHub. Changes saved locally.";
            break;
          case "lock":
            result.error =
              "Git lock file exists. Another git process may be running.";
            break;
          case "not-repo":
            result.error =
              "This vault is not a git repository. Please initialize git first.";
            break;
          default:
            result.error = err.message;
        }
      } else {
        result.error =
          err instanceof Error ? err.message : "Unknown sync error";
      }
    }

    return result;
  }

  async hasGitUserConfig(): Promise<boolean> {
    const name = await this.git.getUserName();
    const email = await this.git.getUserEmail();
    return name !== null && email !== null;
  }

  async setGitUserConfig(name: string, email: string): Promise<void> {
    await this.git.setUserName(name);
    await this.git.setUserEmail(email);
  }

  getGit(): Git {
    return this.git;
  }
}
