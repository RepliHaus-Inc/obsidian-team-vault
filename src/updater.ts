import { Plugin, Notice } from "obsidian";
import { requestUrl } from "obsidian";
import { createHash } from "crypto";
import type { TeamVaultSettings } from "./settings";

interface VersionInfo {
  currentVersion: string;
  remoteVersion: string;
  hasUpdate: boolean;
}

const PLUGIN_FILES = ["main.js", "manifest.json", "styles.css"];

/** The repo where plugin releases are published */
const PLUGIN_REPO = "RepliHaus-Inc/obsidian-team-vault";

export class PluginUpdater {
  private pluginDir: string;
  /** Prevents duplicate notices within the same session */
  private noticeShown = false;
  /** The version we last notified about or dismissed — persisted via plugin data */
  private dismissedVersion: string | null = null;

  constructor(
    private plugin: Plugin,
    private settings: TeamVaultSettings
  ) {
    const configDir = plugin.app.vault.configDir; // ".obsidian"
    this.pluginDir = `${configDir}/plugins/${plugin.manifest.id}`;
  }

  /** Load the dismissed version from plugin data (call once on startup). */
  async loadState(): Promise<void> {
    try {
      const data = await this.plugin.loadData();
      this.dismissedVersion = data?.dismissedUpdateVersion ?? null;
    } catch {
      this.dismissedVersion = null;
    }
  }

  private async saveDismissedVersion(version: string): Promise<void> {
    this.dismissedVersion = version;
    const data = (await this.plugin.loadData()) || {};
    data.dismissedUpdateVersion = version;
    await this.plugin.saveData(data);
  }

  async checkForUpdate(manual: boolean): Promise<VersionInfo> {
    const currentVersion = this.plugin.manifest.version;
    const remoteManifest = await this.fetchFile("manifest.json");
    const remote = JSON.parse(remoteManifest);
    const remoteVersion: string = remote.version;

    const hasUpdate = this.isNewer(remoteVersion, currentVersion);

    return { currentVersion, remoteVersion, hasUpdate };
  }

  /**
   * Returns true if the update notice should be shown.
   * Prevents: duplicate notices in the same session, re-nagging for a dismissed version.
   */
  shouldNotify(info: VersionInfo, manual: boolean): boolean {
    if (!info.hasUpdate) return false;
    if (manual) return true; // manual check always shows
    if (this.noticeShown) return false; // already showing one this session
    // Don't re-nag for a version the user already dismissed
    if (
      this.dismissedVersion &&
      !this.isNewer(info.remoteVersion, this.dismissedVersion)
    ) {
      return false;
    }
    return true;
  }

  /** Mark a version as dismissed so we don't nag again until a newer one appears. */
  async dismiss(version: string): Promise<void> {
    await this.saveDismissedVersion(version);
  }

  markNoticeShown(): void {
    this.noticeShown = true;
  }

  clearNoticeShown(): void {
    this.noticeShown = false;
  }

  async applyUpdate(): Promise<void> {
    const adapter = this.plugin.app.vault.adapter;

    // Fetch all plugin files into memory before writing anything
    const fetched: Record<string, string> = {};
    for (const file of PLUGIN_FILES) {
      fetched[file] = await this.fetchFile(file);
    }

    // Attempt to fetch checksums.json for integrity verification
    let checksums: Record<string, string> | null = null;
    try {
      const raw = await this.fetchFile("checksums.json");
      checksums = JSON.parse(raw) as Record<string, string>;
    } catch {
      // checksums.json not found — backwards compatibility path
      checksums = null;
    }

    if (checksums !== null) {
      // Verify SHA256 of every fetched file against the manifest
      const failures: string[] = [];
      for (const file of PLUGIN_FILES) {
        if (file === "manifest.json") continue; // manifest is already trusted (used for version check)
        const expected = checksums[file];
        if (!expected) continue; // file not listed in checksums — skip
        const actual = createHash("sha256").update(fetched[file]).digest("hex");
        if (actual !== expected) {
          failures.push(file);
        }
      }

      if (failures.length > 0) {
        throw new Error(
          `Checksum mismatch — update aborted. Affected files: ${failures.join(", ")}. ` +
          "The downloaded files do not match the expected checksums. " +
          "This may indicate repository tampering."
        );
      }
    } else {
      // No checksums.json — refuse to apply. Integrity verification is mandatory.
      throw new Error(
        "Update aborted: checksums.json not found in the release. " +
        "Cannot verify file integrity. Please contact the plugin maintainer."
      );
    }

    // All checks passed — write files to disk
    for (const file of PLUGIN_FILES) {
      const path = `${this.pluginDir}/${file}`;
      await adapter.write(path, fetched[file]);
    }
  }

  /** Fetch a file from the plugin's GitHub repo (main branch). */
  private async fetchFile(filename: string): Promise<string> {
    const repo = this.getRepoSlug();
    const url = `https://api.github.com/repos/${repo}/contents/${filename}?ref=main`;

    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3.raw",
      "User-Agent": "TeamVault-Updater",
    };

    if (this.settings.githubPat) {
      headers["Authorization"] = `Bearer ${this.settings.githubPat}`;
    }

    const response = await requestUrl({ url, headers });

    if (response.status !== 200) {
      throw new Error(
        `Failed to fetch ${filename}: HTTP ${response.status}`
      );
    }

    return response.text;
  }

  private getRepoSlug(): string {
    return PLUGIN_REPO;
  }

  /**
   * Compare semver strings. Returns true if `remote` is strictly newer than `current`.
   */
  isNewer(remote: string, current: string): boolean {
    const r = remote.split(".").map(Number);
    const c = current.split(".").map(Number);

    for (let i = 0; i < Math.max(r.length, c.length); i++) {
      const rv = r[i] ?? 0;
      const cv = c[i] ?? 0;
      if (rv > cv) return true;
      if (rv < cv) return false;
    }
    return false;
  }
}

/**
 * Show an update notice with "Update & Reload" and "Dismiss" buttons.
 * Only shows the latest available version — never stacks or repeats.
 */
export function showUpdateNotice(
  info: VersionInfo,
  updater: PluginUpdater,
  plugin: Plugin
): void {
  updater.markNoticeShown();

  const fragment = document.createDocumentFragment();

  const text = document.createElement("span");
  text.textContent = `Team Vault ${info.remoteVersion} available (you have ${info.currentVersion}). `;
  fragment.appendChild(text);

  const btnRow = document.createElement("span");
  btnRow.style.display = "inline-flex";
  btnRow.style.gap = "6px";
  btnRow.style.marginLeft = "8px";

  const updateBtn = document.createElement("button");
  updateBtn.textContent = "Update & Reload";
  updateBtn.style.cursor = "pointer";

  const dismissBtn = document.createElement("button");
  dismissBtn.textContent = "Dismiss";
  dismissBtn.style.cursor = "pointer";
  dismissBtn.style.opacity = "0.7";

  btnRow.appendChild(updateBtn);
  btnRow.appendChild(dismissBtn);
  fragment.appendChild(btnRow);

  const notice = new Notice(fragment, 0);

  dismissBtn.addEventListener("click", async () => {
    await updater.dismiss(info.remoteVersion);
    updater.clearNoticeShown();
    notice.hide();
  });

  updateBtn.addEventListener("click", async () => {
    updateBtn.textContent = "Updating...";
    updateBtn.disabled = true;
    dismissBtn.disabled = true;
    try {
      await updater.applyUpdate();
      notice.hide();
      new Notice("Update applied! Reloading vault...");
      // Full vault reload so everything picks up the new plugin
      setTimeout(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const app = plugin.app as any;
        if (app.commands?.executeCommandById) {
          app.commands.executeCommandById("app:reload");
        } else {
          window.location.reload();
        }
      }, 500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      new Notice(`Update failed: ${msg}`);
      updateBtn.textContent = "Update & Reload";
      updateBtn.disabled = false;
      dismissBtn.disabled = false;
    }
  });
}
