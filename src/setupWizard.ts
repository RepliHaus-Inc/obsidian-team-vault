import { App, Modal, Setting, Notice, requestUrl } from "obsidian";
import type { TeamVaultSettings } from "./settings";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Returns true when the setup wizard should be shown — i.e. the user has not
 * yet connected a GitHub repository.
 */
export function shouldShowSetup(settings: TeamVaultSettings): boolean {
  return !settings.githubRepo || settings.githubRepo.trim() === "";
}

/**
 * Parse a GitHub repo input that is either a full URL or an "owner/repo" slug.
 * Returns the normalised "owner/repo" string, or null if unparseable.
 */
function parseRepoInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Full URL: https://github.com/owner/repo(.git)
  try {
    const url = new URL(trimmed);
    if (url.hostname === "github.com") {
      // pathname is like "/owner/repo" or "/owner/repo.git"
      const parts = url.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
      if (parts.length >= 2 && parts[0] && parts[1]) {
        return `${parts[0]}/${parts[1]}`;
      }
    }
  } catch {
    // Not a URL — fall through
  }

  // Plain "owner/repo" (or "owner/repo.git")
  const slug = trimmed.replace(/\.git$/, "");
  const slashParts = slug.split("/");
  if (slashParts.length === 2 && slashParts[0] && slashParts[1]) {
    return `${slashParts[0]}/${slashParts[1]}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GitHubUser {
  login: string;
  name: string | null;
  email: string | null;
}

type Step = 1 | 2 | 3;

// ---------------------------------------------------------------------------
// SetupWizard modal
// ---------------------------------------------------------------------------

export class SetupWizard extends Modal {
  private settings: TeamVaultSettings;
  private saveCallback: () => Promise<void>;
  private gitConfigCallback: (name: string, email: string) => Promise<void>;

  // Wizard state
  private currentStep: Step = 1;
  private repoInput = "";
  private patInput = "";
  private displayName = "";
  private emailInput = "";
  private patVerified = false;
  private githubUser: GitHubUser | null = null;
  private testInProgress = false;

  // Refs to dynamic UI elements
  private stepContainerEl!: HTMLElement;
  private finishBtn!: HTMLButtonElement;

  /**
   * @param app            - Obsidian App instance
   * @param settings       - The plugin's settings object (mutated on finish)
   * @param saveCallback   - Called after settings are mutated; should persist them
   * @param gitConfigCallback - Called with (name, email) to run `git config user.*`
   */
  constructor(
    app: App,
    settings: TeamVaultSettings,
    saveCallback: () => Promise<void>,
    gitConfigCallback: (name: string, email: string) => Promise<void>
  ) {
    super(app);
    this.settings = settings;
    this.saveCallback = saveCallback;
    this.gitConfigCallback = gitConfigCallback;

    // Pre-fill from existing settings so a partial setup can be resumed
    this.repoInput = settings.githubRepo || "";
    this.patInput = settings.githubPat || "";
    this.displayName = settings.userName || "";
    this.emailInput = settings.userEmail || "";
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("tv-setup-wizard");

    this.renderHeader();
    this.stepContainerEl = contentEl.createDiv({ cls: "tv-wizard-body" });
    this.renderStep();
    this.renderFooter();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  // -------------------------------------------------------------------------
  // Layout builders
  // -------------------------------------------------------------------------

  private renderHeader(): void {
    const { contentEl } = this;

    const header = contentEl.createDiv({ cls: "tv-wizard-header" });
    header.createEl("h2", { text: "Welcome to Team Vault", cls: "tv-wizard-title" });
    header.createEl("p", {
      text: "Let's connect your shared vault to GitHub. This takes about a minute.",
      cls: "tv-wizard-subtitle",
    });

    // Step indicator
    const steps = header.createDiv({ cls: "tv-wizard-steps" });
    const labels = ["Repository", "Authentication", "Identity"];
    for (let i = 1; i <= 3; i++) {
      const dot = steps.createDiv({ cls: "tv-wizard-step-dot" });
      dot.dataset.step = String(i);
      dot.createEl("span", { cls: "tv-wizard-step-number", text: String(i) });
      dot.createEl("span", { cls: "tv-wizard-step-label", text: labels[i - 1] });
    }

    this.updateStepIndicator();
  }

  private updateStepIndicator(): void {
    const dots = this.contentEl.querySelectorAll<HTMLElement>(".tv-wizard-step-dot");
    dots.forEach((dot) => {
      const n = Number(dot.dataset.step) as Step;
      dot.removeClass("tv-step-active", "tv-step-done");
      if (n < this.currentStep) dot.addClass("tv-step-done");
      else if (n === this.currentStep) dot.addClass("tv-step-active");
    });
  }

  private renderFooter(): void {
    const { contentEl } = this;
    const footer = contentEl.createDiv({ cls: "tv-wizard-footer" });

    // Back button (hidden on step 1)
    const backBtn = footer.createEl("button", {
      text: "Back",
      cls: "tv-wizard-btn tv-wizard-btn-ghost",
    });
    backBtn.style.visibility = this.currentStep === 1 ? "hidden" : "visible";
    backBtn.addEventListener("click", () => {
      if (this.currentStep > 1) {
        this.currentStep = (this.currentStep - 1) as Step;
        this.rerenderStep();
        backBtn.style.visibility = this.currentStep === 1 ? "hidden" : "visible";
        this.updateStepIndicator();
        this.updateFinishBtn();
      }
    });

    const rightActions = footer.createDiv({ cls: "tv-wizard-footer-right" });

    // Next button (steps 1–2)
    if (this.currentStep < 3) {
      const nextBtn = rightActions.createEl("button", {
        text: this.currentStep === 1 ? "Next: Authentication" : "Next: Your Identity",
        cls: "tv-wizard-btn tv-wizard-btn-primary",
      });
      nextBtn.addEventListener("click", () => {
        if (this.currentStep === 1) {
          const parsed = parseRepoInput(this.repoInput);
          if (!parsed) {
            new Notice("Please enter a valid GitHub repository (e.g. my-org/my-vault).");
            return;
          }
          this.repoInput = parsed;
        }
        if (this.currentStep === 2 && !this.patInput.trim()) {
          new Notice("Please enter your GitHub token before continuing.");
          return;
        }
        this.currentStep = (this.currentStep + 1) as Step;
        this.rerenderStep();
        backBtn.style.visibility = this.currentStep === 1 ? "hidden" : "visible";
        this.updateStepIndicator();
        this.updateFinishBtn();
      });
    }

    // Finish button (always present, enabled only when ready)
    this.finishBtn = rightActions.createEl("button", {
      text: "Finish Setup",
      cls: "tv-wizard-btn tv-wizard-btn-primary",
    });
    this.finishBtn.style.display = this.currentStep === 3 ? "inline-flex" : "none";
    this.updateFinishBtn();

    this.finishBtn.addEventListener("click", () => this.handleFinish());
  }

  private rerenderStep(): void {
    this.stepContainerEl.empty();
    this.renderStep();
    // Re-render footer with correct button visibility
    const footer = this.contentEl.querySelector<HTMLElement>(".tv-wizard-footer");
    if (!footer) return;
    footer.empty();

    const backBtn = footer.createEl("button", {
      text: "Back",
      cls: "tv-wizard-btn tv-wizard-btn-ghost",
    });
    backBtn.style.visibility = this.currentStep === 1 ? "hidden" : "visible";
    backBtn.addEventListener("click", () => {
      if (this.currentStep > 1) {
        this.currentStep = (this.currentStep - 1) as Step;
        this.rerenderStep();
        this.updateStepIndicator();
      }
    });

    const rightActions = footer.createDiv({ cls: "tv-wizard-footer-right" });

    if (this.currentStep < 3) {
      const nextBtn = rightActions.createEl("button", {
        text: this.currentStep === 1 ? "Next: Authentication" : "Next: Your Identity",
        cls: "tv-wizard-btn tv-wizard-btn-primary",
      });
      nextBtn.addEventListener("click", () => {
        if (this.currentStep === 1) {
          const parsed = parseRepoInput(this.repoInput);
          if (!parsed) {
            new Notice("Please enter a valid GitHub repository (e.g. my-org/my-vault).");
            return;
          }
          this.repoInput = parsed;
        }
        if (this.currentStep === 2 && !this.patInput.trim()) {
          new Notice("Please enter your GitHub token before continuing.");
          return;
        }
        this.currentStep = (this.currentStep + 1) as Step;
        this.rerenderStep();
        this.updateStepIndicator();
        this.updateFinishBtn();
      });
    }

    this.finishBtn = rightActions.createEl("button", {
      text: "Finish Setup",
      cls: "tv-wizard-btn tv-wizard-btn-primary",
    });
    this.finishBtn.style.display = this.currentStep === 3 ? "inline-flex" : "none";
    this.updateFinishBtn();
    this.finishBtn.addEventListener("click", () => this.handleFinish());
  }

  private renderStep(): void {
    switch (this.currentStep) {
      case 1: this.renderStep1(); break;
      case 2: this.renderStep2(); break;
      case 3: this.renderStep3(); break;
    }
  }

  // -------------------------------------------------------------------------
  // Step 1 — Connect Repository
  // -------------------------------------------------------------------------

  private renderStep1(): void {
    const el = this.stepContainerEl;

    el.createEl("h3", { text: "Step 1: Connect Repository", cls: "tv-step-heading" });
    el.createEl("p", {
      text: "Enter the GitHub repo for your shared vault (e.g. my-org/my-vault)",
      cls: "tv-step-desc",
    });

    new Setting(el)
      .setName("GitHub repository")
      .setDesc("Accepts full URLs or owner/repo format")
      .addText((text) => {
        text
          .setPlaceholder("my-org/my-vault  or  https://github.com/my-org/my-vault")
          .setValue(this.repoInput)
          .onChange((val) => {
            this.repoInput = val;
          });
        text.inputEl.style.width = "100%";
        // Allow Enter to advance
        text.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            const parsed = parseRepoInput(this.repoInput);
            if (parsed) {
              this.repoInput = parsed;
              this.currentStep = 2;
              this.rerenderStep();
              this.updateStepIndicator();
              this.updateFinishBtn();
            }
          }
        });
      });
  }

  // -------------------------------------------------------------------------
  // Step 2 — Authentication
  // -------------------------------------------------------------------------

  private renderStep2(): void {
    const el = this.stepContainerEl;

    el.createEl("h3", { text: "Step 2: Authentication", cls: "tv-step-heading" });
    el.createEl("p", {
      text: "Create a fine-grained token with Contents read/write on your vault repo only",
      cls: "tv-step-desc",
    });

    // PAT creation link
    const linkRow = el.createDiv({ cls: "tv-wizard-link-row" });
    linkRow.createEl("span", { text: "Need a token? " });
    const link = linkRow.createEl("a", {
      text: "Create a fine-grained personal access token",
      href: "https://github.com/settings/personal-access-tokens/new",
    });
    link.setAttr("target", "_blank");
    link.setAttr("rel", "noopener noreferrer");

    // PAT instructions block
    const instructions = el.createDiv({ cls: "tv-wizard-info-box" });
    instructions.createEl("strong", { text: "Token setup:" });
    const ul = instructions.createEl("ul");
    ul.createEl("li", { text: "Repository access → Only select repositories → choose your vault repo" });
    ul.createEl("li", { text: "Permissions → Repository permissions → Contents: Read and write" });
    ul.createEl("li", { text: "All other permissions can stay at No access" });

    // PAT input
    let testStatusEl: HTMLElement;

    new Setting(el)
      .setName("GitHub Personal Access Token")
      .setDesc("Your token is stored locally and never shared or transmitted to anyone except GitHub.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("github_pat_...")
          .setValue(this.patInput)
          .onChange((val) => {
            this.patInput = val;
            this.patVerified = false;
            this.githubUser = null;
            if (testStatusEl) {
              testStatusEl.empty();
              testStatusEl.removeClass("tv-test-success", "tv-test-error");
            }
          });
        text.inputEl.style.width = "100%";
      });

    // Test connection row
    const testRow = el.createDiv({ cls: "tv-wizard-test-row" });
    const testBtn = testRow.createEl("button", {
      text: "Test Connection",
      cls: "tv-wizard-btn tv-wizard-btn-secondary",
    });
    testStatusEl = testRow.createDiv({ cls: "tv-wizard-test-status" });

    testBtn.addEventListener("click", async () => {
      if (!this.patInput.trim()) {
        new Notice("Enter a token first.");
        return;
      }
      await this.testConnection(testBtn, testStatusEl);
    });
  }

  private async testConnection(
    btn: HTMLButtonElement,
    statusEl: HTMLElement
  ): Promise<void> {
    if (this.testInProgress) return;
    this.testInProgress = true;

    const originalText = btn.textContent || "Test Connection";
    btn.textContent = "Testing…";
    btn.disabled = true;
    statusEl.empty();
    statusEl.removeClass("tv-test-success", "tv-test-error");

    try {
      const response = await requestUrl({
        url: "https://api.github.com/user",
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.patInput.trim()}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });

      if (response.status === 200) {
        const data = response.json as GitHubUser;
        this.patVerified = true;
        this.githubUser = data;

        // Auto-fill identity if not already set
        if (!this.displayName && (data.name || data.login)) {
          this.displayName = data.name || data.login;
        }
        if (!this.emailInput && data.email) {
          this.emailInput = data.email;
        }

        statusEl.addClass("tv-test-success");
        statusEl.createEl("span", { text: `Connected as @${data.login}` });

        // Nudge toward next step
        new Notice(`Token verified — connected as @${data.login}`);
      } else {
        this.patVerified = false;
        this.githubUser = null;
        statusEl.addClass("tv-test-error");
        statusEl.createEl("span", {
          text: `Unexpected response: HTTP ${response.status}`,
        });
      }
    } catch (err) {
      this.patVerified = false;
      this.githubUser = null;
      statusEl.addClass("tv-test-error");
      const msg = err instanceof Error ? err.message : String(err);
      // Translate common error to human-readable
      const display =
        msg.includes("401") || msg.includes("Bad credentials")
          ? "Invalid token — check it and try again."
          : msg.includes("403")
          ? "Token lacks permission — ensure Contents read/write is enabled."
          : `Connection failed: ${msg}`;
      statusEl.createEl("span", { text: display });
    } finally {
      this.testInProgress = false;
      btn.textContent = originalText;
      btn.disabled = false;
    }
  }

  // -------------------------------------------------------------------------
  // Step 3 — Identity
  // -------------------------------------------------------------------------

  private renderStep3(): void {
    const el = this.stepContainerEl;

    el.createEl("h3", { text: "Step 3: Your Identity", cls: "tv-step-heading" });
    el.createEl("p", {
      text: "This is how your name appears in comments and activity",
      cls: "tv-step-desc",
    });

    if (this.githubUser) {
      const autofillNote = el.createDiv({ cls: "tv-wizard-info-box tv-wizard-info-box--success" });
      autofillNote.createEl("span", {
        text: `Auto-filled from your GitHub profile (@${this.githubUser.login}). Edit below if you prefer a different display name.`,
      });
    }

    new Setting(el)
      .setName("Display name")
      .setDesc("Your name as shown to teammates")
      .addText((text) => {
        text
          .setPlaceholder("e.g. Alex Chen")
          .setValue(this.displayName)
          .onChange((val) => {
            this.displayName = val;
            this.updateFinishBtn();
          });
        text.inputEl.style.width = "100%";
        // Focus the name input on step arrival
        window.setTimeout(() => text.inputEl.focus(), 50);
      });

    new Setting(el)
      .setName("Email")
      .setDesc("Used in git commit metadata — not shared publicly")
      .addText((text) => {
        text
          .setPlaceholder("e.g. alex@example.com")
          .setValue(this.emailInput)
          .onChange((val) => {
            this.emailInput = val;
            this.updateFinishBtn();
          });
        text.inputEl.style.width = "100%";
      });
  }

  // -------------------------------------------------------------------------
  // Finish
  // -------------------------------------------------------------------------

  private updateFinishBtn(): void {
    if (!this.finishBtn) return;
    const repoOk = parseRepoInput(this.repoInput) !== null;
    const patOk = this.patInput.trim().length > 0;
    const onStep3 = this.currentStep === 3;
    this.finishBtn.disabled = !(repoOk && patOk);
    this.finishBtn.style.display = onStep3 ? "inline-flex" : "none";
  }

  private async handleFinish(): Promise<void> {
    const parsedRepo = parseRepoInput(this.repoInput);
    if (!parsedRepo) {
      new Notice("Repository is invalid. Go back to step 1 and check the URL.");
      return;
    }
    if (!this.patInput.trim()) {
      new Notice("Token is required. Go back to step 2.");
      return;
    }

    this.finishBtn.textContent = "Saving…";
    this.finishBtn.disabled = true;

    try {
      // Mutate settings in place so the plugin's reference stays valid
      this.settings.githubRepo = parsedRepo;
      this.settings.githubPat = this.patInput.trim();
      this.settings.userName = this.displayName.trim();
      this.settings.userEmail = this.emailInput.trim();

      await this.saveCallback();

      // Set git user config if identity was provided
      if (this.settings.userName && this.settings.userEmail) {
        try {
          await this.gitConfigCallback(this.settings.userName, this.settings.userEmail);
        } catch {
          // Non-fatal — git may not be available yet
        }
      }

      new Notice(
        `Team Vault connected to ${parsedRepo}. You're all set!`,
        6000
      );
      this.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      new Notice(`Setup failed: ${msg}`);
      this.finishBtn.textContent = "Finish Setup";
      this.finishBtn.disabled = false;
    }
  }
}
