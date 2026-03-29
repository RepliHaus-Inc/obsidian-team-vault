import { App, Modal } from "obsidian";
import { readFile, writeFile } from "fs/promises";
import { join, sep } from "path";
import type { GitSync } from "./gitSync";
import { notifySuccess, notifyError } from "../utils/notifications";

interface ConflictFile {
  path: string;
  oursContent: string | null;
  theirsContent: string | null;
  isBinary: boolean;
}

export class ConflictModal extends Modal {
  private conflicts: ConflictFile[] = [];
  private resolved: Map<string, "ours" | "theirs" | "both"> = new Map();

  constructor(
    app: App,
    private conflictPaths: string[],
    private gitSync: GitSync
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.addClass("tv-conflict-modal");
    contentEl.createEl("h2", { text: "Resolve Conflicts" });
    contentEl.createEl("p", {
      text: `${this.conflictPaths.length} file(s) have conflicts. Choose how to resolve each one.`,
    });

    // Load conflict content
    const git = this.gitSync.getGit();
    for (const path of this.conflictPaths) {
      const isBinary = this.isBinaryFile(path);
      let oursContent: string | null = null;
      let theirsContent: string | null = null;

      if (!isBinary) {
        try {
          oursContent = await git.getOursVersion(path);
        } catch {
          oursContent = null;
        }
        try {
          theirsContent = await git.getTheirsVersion(path);
        } catch {
          theirsContent = null;
        }
      }

      this.conflicts.push({ path, oursContent, theirsContent, isBinary });
    }

    // Render each conflict
    for (const conflict of this.conflicts) {
      this.renderConflict(contentEl, conflict);
    }

    // Resolve All button
    const footer = contentEl.createDiv({ cls: "tv-conflict-buttons" });
    const resolveBtn = footer.createEl("button", {
      text: "Apply Resolutions",
      cls: "mod-cta",
    });
    resolveBtn.addEventListener("click", () => this.applyResolutions());
  }

  private renderConflict(container: HTMLElement, conflict: ConflictFile): void {
    const fileEl = container.createDiv({ cls: "tv-conflict-file" });

    // Header
    fileEl.createDiv({
      cls: "tv-conflict-file-header",
      text: conflict.path,
    });

    if (conflict.isBinary) {
      fileEl.createDiv({
        text: "Binary file — cannot show diff. Choose which version to keep.",
      });
    } else {
      // Side-by-side
      const sides = fileEl.createDiv({ cls: "tv-conflict-sides" });

      const oursEl = sides.createDiv({ cls: "tv-conflict-side" });
      oursEl.createDiv({
        cls: "tv-conflict-side-label",
        text: "YOURS (local)",
      });
      oursEl.createEl("pre", {
        text: conflict.oursContent || "(file not found)",
      });

      const theirsEl = sides.createDiv({ cls: "tv-conflict-side" });
      theirsEl.createDiv({
        cls: "tv-conflict-side-label",
        text: "THEIRS (remote)",
      });
      theirsEl.createEl("pre", {
        text: conflict.theirsContent || "(file not found)",
      });
    }

    // Buttons per file
    const buttons = fileEl.createDiv({ cls: "tv-conflict-buttons" });

    const keepMine = buttons.createEl("button", { text: "Keep Mine" });
    const keepTheirs = buttons.createEl("button", { text: "Keep Theirs" });
    const keepBoth = buttons.createEl("button", { text: "Keep Both" });

    const setChosen = (choice: "ours" | "theirs" | "both") => {
      this.resolved.set(conflict.path, choice);
      keepMine.removeClass("mod-cta");
      keepTheirs.removeClass("mod-cta");
      keepBoth.removeClass("mod-cta");
      if (choice === "ours") keepMine.addClass("mod-cta");
      if (choice === "theirs") keepTheirs.addClass("mod-cta");
      if (choice === "both") keepBoth.addClass("mod-cta");
    };

    keepMine.addEventListener("click", () => setChosen("ours"));
    keepTheirs.addEventListener("click", () => setChosen("theirs"));
    keepBoth.addEventListener("click", () => setChosen("both"));
  }

  private async applyResolutions(): Promise<void> {
    if (this.resolved.size !== this.conflicts.length) {
      notifyError(
        `Please resolve all ${this.conflicts.length} conflict(s) before applying.`
      );
      return;
    }

    const git = this.gitSync.getGit();
    const vaultPath = (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath();

    try {
      for (const conflict of this.conflicts) {
        const choice = this.resolved.get(conflict.path)!;
        const filePath = join(vaultPath, conflict.path);
        if (!filePath.startsWith(vaultPath + sep) && filePath !== vaultPath) {
          throw new Error("Path traversal detected");
        }

        let content: string;
        switch (choice) {
          case "ours":
            content = conflict.oursContent || "";
            break;
          case "theirs":
            content = conflict.theirsContent || "";
            break;
          case "both":
            content = [
              conflict.oursContent || "",
              "\n---\n",
              conflict.theirsContent || "",
            ].join("\n");
            break;
        }

        await writeFile(filePath, content, "utf-8");
        await git.markResolved(conflict.path);
      }

      // Commit the merge resolution
      await git.commit("Merge conflict resolution via Team Vault");

      // Try to continue rebase if one was in progress
      try {
        await git.continueRebase();
      } catch {
        // Not in a rebase — that's fine
      }

      notifySuccess(
        `Resolved ${this.conflicts.length} conflict(s) successfully.`
      );
      this.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Resolution failed";
      notifyError(msg);
    }
  }

  private isBinaryFile(path: string): boolean {
    const binaryExts = [
      ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg",
      ".pdf", ".zip", ".tar", ".gz",
      ".mp3", ".mp4", ".wav", ".ogg",
      ".woff", ".woff2", ".ttf", ".otf",
      ".exe", ".dll", ".so", ".dylib",
    ];
    const ext = path.substring(path.lastIndexOf(".")).toLowerCase();
    return binaryExts.includes(ext);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
