import type TeamVaultPlugin from "../main";

export class SyncStatusBar {
  private el: HTMLElement;

  constructor(plugin: TeamVaultPlugin) {
    this.el = plugin.addStatusBarItem();
    this.el.addClass("tv-status-bar");
  }

  setIdle(): void {
    this.el.empty();
    this.el.removeClass("syncing", "error", "success");
    this.el.createSpan({ cls: "status-icon", text: "●" });
    this.el.createSpan({ text: " Team Vault" });
  }

  setSyncing(): void {
    this.el.empty();
    this.el.addClass("syncing");
    this.el.removeClass("error", "success");
    this.el.createSpan({ cls: "status-icon", text: "⟳" });
    this.el.createSpan({ text: " Syncing..." });
  }

  setSynced(): void {
    this.el.empty();
    this.el.addClass("success");
    this.el.removeClass("syncing", "error");
    this.el.createSpan({ cls: "status-icon", text: "✓" });
    this.el.createSpan({ text: " Synced" });
  }

  setPending(count: number): void {
    this.el.empty();
    this.el.addClass("pending");
    this.el.removeClass("syncing", "error", "success");
    this.el.createSpan({ cls: "status-icon", text: "●" });
    this.el.createSpan({
      text: count > 0 ? ` ${count} unsaved` : " Unsaved changes",
    });
  }

  setUpdatesAvailable(count: number): void {
    this.el.empty();
    this.el.removeClass("syncing", "error", "success");
    this.el.createSpan({ cls: "status-icon", text: "↓" });
    this.el.createSpan({ text: ` ${count} update(s)` });
  }

  setError(message: string): void {
    this.el.empty();
    this.el.addClass("error");
    this.el.removeClass("syncing", "success");
    this.el.createSpan({ cls: "status-icon", text: "⚠" });
    this.el.createSpan({ text: ` ${message.substring(0, 40)}` });
    this.el.setAttr("title", message);
  }

  setConflict(count: number): void {
    this.el.empty();
    this.el.addClass("error");
    this.el.removeClass("syncing", "success");
    this.el.createSpan({ cls: "status-icon", text: "⚠" });
    this.el.createSpan({ text: ` ${count} conflict(s)` });
  }
}
