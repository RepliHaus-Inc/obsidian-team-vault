import { App, PluginSettingTab, Setting } from "obsidian";
import type TeamVaultPlugin from "./main";

/**
 * Resolve a raw author name (git config name, GitHub username, email prefix)
 * to the hub display name from teamMembers. Returns the raw name if no match.
 */
export function resolveAuthorName(
  rawName: string,
  settings: TeamVaultSettings
): string {
  if (!rawName) return "Unknown";
  const raw = rawName.trim();
  const rawLower = raw.toLowerCase();

  for (const member of settings.teamMembers) {
    if (!member.name) continue;
    const hubLower = member.name.toLowerCase();
    const ghLower = (member.githubUsername || "").toLowerCase();

    // Exact match on hub name
    if (rawLower === hubLower) return member.name;
    // Exact match on GitHub username
    if (ghLower && rawLower === ghLower) return member.name;
    // First name match: if raw has spaces, check if first word matches hub name
    // (e.g. "Seun Badejo" → first word "seun" matches hub name "seun")
    if (raw.includes(" ")) {
      const firstWord = rawLower.split(" ")[0];
      if (firstWord === hubLower) return member.name;
    }
  }

  // Also check the current user's own settings
  if (settings.userName) {
    const selfLower = settings.userName.toLowerCase();
    if (rawLower === selfLower) return settings.userName;
  }

  return raw;
}

export interface TeamMember {
  name: string;
  githubUsername: string;
}

export interface TeamVaultSettings {
  githubPat: string;
  githubRepo: string; // "owner/repo" format
  syncIntervalMinutes: number;
  autoSync: boolean;
  teamMembers: TeamMember[];
  userName: string;
  userEmail: string;
  discussionsSyncEnabled: boolean;
  editDebounceSeconds: number;
}

export const DEFAULT_SETTINGS: TeamVaultSettings = {
  githubPat: "",
  githubRepo: "",
  syncIntervalMinutes: 5,
  autoSync: true,
  teamMembers: [],
  userName: "",
  userEmail: "",
  discussionsSyncEnabled: false,
  editDebounceSeconds: 30,
};

export class TeamVaultSettingTab extends PluginSettingTab {
  plugin: TeamVaultPlugin;

  constructor(app: App, plugin: TeamVaultPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Team Vault Settings" });

    // --- Plugin Updates ---
    containerEl.createEl("h3", { text: "Plugin Updates" });

    const versionDesc = `Installed: v${this.plugin.manifest.version}`;
    new Setting(containerEl)
      .setName("Check for updates")
      .setDesc(versionDesc)
      .addButton((btn) =>
        btn.setButtonText("Check now").onClick(async () => {
          btn.setButtonText("Checking...");
          btn.setDisabled(true);
          await this.plugin.checkForUpdates(true);
          btn.setButtonText("Check now");
          btn.setDisabled(false);
        })
      );

    // --- Identity ---
    containerEl.createEl("h3", { text: "Identity" });

    new Setting(containerEl)
      .setName("Your email")
      .setDesc("Used in git commit config")
      .addText((text) =>
        text
          .setPlaceholder("e.g. you@example.com")
          .setValue(this.plugin.settings.userEmail)
          .onChange(async (value) => {
            this.plugin.settings.userEmail = value;
            await this.plugin.saveSettings();
          })
      );

    // --- GitHub ---
    containerEl.createEl("h3", { text: "GitHub" });

    const patWarning = containerEl.createDiv({ cls: "setting-item-description" });
    patWarning.style.marginBottom = "8px";
    patWarning.style.padding = "8px 12px";
    patWarning.style.borderRadius = "4px";
    patWarning.style.background = "var(--background-secondary)";
    patWarning.style.borderLeft = "3px solid var(--text-warning, orange)";
    patWarning.innerHTML =
      "<strong>Security note:</strong> Use a <strong>fine-grained PAT</strong> " +
      "(not classic) limited to just this repo. " +
      '<a href="https://github.com/settings/personal-access-tokens/new">Create one here</a> → ' +
      "select only the vault repo → Permissions: Contents (read & write). " +
      "Your token is stored locally and never shared.";

    new Setting(containerEl)
      .setName("GitHub Personal Access Token")
      .setDesc("Fine-grained token with Contents read/write on the vault repo only")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("github_pat_...")
          .setValue(this.plugin.settings.githubPat)
          .onChange(async (value) => {
            this.plugin.settings.githubPat = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("GitHub repository")
      .setDesc("owner/repo format")
      .addText((text) =>
        text
          .setPlaceholder("owner/repo")
          .setValue(this.plugin.settings.githubRepo)
          .onChange(async (value) => {
            this.plugin.settings.githubRepo = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("GitHub Discussions sync")
      .setDesc("Sync inline comments to GitHub Discussions (experimental)")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.discussionsSyncEnabled)
          .onChange(async (value) => {
            this.plugin.settings.discussionsSyncEnabled = value;
            await this.plugin.saveSettings();
          })
      );

    // --- Sync ---
    containerEl.createEl("h3", { text: "Sync" });

    new Setting(containerEl)
      .setName("Auto-sync")
      .setDesc("Automatically sync on an interval")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSync)
          .onChange(async (value) => {
            this.plugin.settings.autoSync = value;
            await this.plugin.saveSettings();
            this.plugin.restartAutoSync();
          })
      );

    new Setting(containerEl)
      .setName("Sync interval (minutes)")
      .setDesc("How often to auto-sync (minimum 1)")
      .addSlider((slider) =>
        slider
          .setLimits(1, 30, 1)
          .setValue(this.plugin.settings.syncIntervalMinutes)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.syncIntervalMinutes = value;
            await this.plugin.saveSettings();
            this.plugin.restartAutoSync();
          })
      );

    new Setting(containerEl)
      .setName("Edit debounce (seconds)")
      .setDesc("Wait this long after the last edit before auto-syncing")
      .addSlider((slider) =>
        slider
          .setLimits(10, 120, 5)
          .setValue(this.plugin.settings.editDebounceSeconds)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.editDebounceSeconds = value;
            await this.plugin.saveSettings();
          })
      );

    // --- Team ---
    containerEl.createEl("h3", { text: "Team Members" });

    const teamSync = this.plugin.teamSync;
    const currentUser = teamSync.getCurrentGithubUser();
    const isAdmin = teamSync.isAdmin();

    containerEl.createEl("p", {
      text: currentUser
        ? `Signed in as @${currentUser}${isAdmin ? " (admin)" : ""}`
        : "Connect your GitHub PAT above to identify yourself.",
      cls: "setting-item-description",
    });

    const members = teamSync.getMembers();

    for (const member of members) {
      const isMe = teamSync.isMe(member);
      const canEdit = teamSync.canEdit(member);
      const canRemove = teamSync.canRemove(member);

      const setting = new Setting(containerEl)
        .setName(isMe ? `${member.name} (you)` : member.name || member.githubUsername)
        .setDesc(`@${member.githubUsername}`);

      if (canEdit) {
        setting.addText((text) =>
          text
            .setPlaceholder("Display name")
            .setValue(member.name)
            .onChange(async (value) => {
              await teamSync.updateMemberName(member.githubUsername, value);
              teamSync.syncToSettings();
              if (isMe) {
                this.plugin.settings.userName = value;
              }
              await this.plugin.saveSettings();
            })
        );
      }

      if (canRemove) {
        setting.addExtraButton((btn) =>
          btn.setIcon("trash").onClick(async () => {
            await teamSync.removeMember(member.githubUsername);
            teamSync.syncToSettings();
            await this.plugin.saveSettings();
            this.display();
          })
        );
      }
    }

    // Only admins can add new members
    if (isAdmin) {
      const addRow = new Setting(containerEl);
      let newName = "";
      let newGh = "";
      addRow
        .addText((text) =>
          text.setPlaceholder("Name").onChange((v) => { newName = v; })
        )
        .addText((text) =>
          text.setPlaceholder("GitHub username").onChange((v) => { newGh = v; })
        )
        .addButton((btn) =>
          btn.setButtonText("Add member").onClick(async () => {
            if (!newName.trim() || !newGh.trim()) return;
            await teamSync.addMember(newName.trim(), newGh.trim());
            teamSync.syncToSettings();
            await this.plugin.saveSettings();
            this.display();
          })
        );
    }
  }
}
