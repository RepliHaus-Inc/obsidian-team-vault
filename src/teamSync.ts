import { requestUrl } from "obsidian";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import type { TeamVaultSettings, TeamMember } from "./settings";

export interface TeamData {
  members: TeamMember[];
  admins: string[]; // GitHub usernames with admin rights
}

const TEAM_FILE = ".team-vault/team.json";

/**
 * Manages the shared team roster stored in .team-vault/team.json.
 * Syncs via git like everything else. Each user is identified by
 * their GitHub PAT → GitHub username.
 */
export class TeamSync {
  private teamData: TeamData = { members: [], admins: [] };
  private currentGithubUser: string | null = null;
  private isRepoAdmin = false;

  constructor(
    private vaultPath: string,
    private settings: TeamVaultSettings
  ) {}

  /** Load team data from shared file + detect current user identity. */
  async init(): Promise<void> {
    await this.loadTeamFile();
    await this.detectIdentity();
  }

  /** Get the team roster. */
  getMembers(): TeamMember[] {
    return this.teamData.members;
  }

  /** Get the current user's GitHub username (from PAT). */
  getCurrentGithubUser(): string | null {
    return this.currentGithubUser;
  }

  /** Check if the current user is a team admin. */
  isAdmin(): boolean {
    return this.isRepoAdmin;
  }

  /** Check if a member is the current user. */
  isMe(member: TeamMember): boolean {
    if (!this.currentGithubUser) return false;
    return member.githubUsername.toLowerCase() === this.currentGithubUser.toLowerCase();
  }

  /** Can the current user edit this member's info? */
  canEdit(member: TeamMember): boolean {
    return this.isMe(member) || this.isAdmin();
  }

  /** Can the current user remove this member? */
  canRemove(member: TeamMember): boolean {
    // Only admins can remove others; you can't remove yourself
    return this.isAdmin() && !this.isMe(member);
  }

  /** Update a member's display name. Saves to shared file. */
  async updateMemberName(githubUsername: string, newName: string): Promise<void> {
    const member = this.teamData.members.find(
      (m) => m.githubUsername.toLowerCase() === githubUsername.toLowerCase()
    );
    if (member) {
      member.name = newName;
      await this.saveTeamFile();
    }
  }

  /** Add a new team member. Only admins. */
  async addMember(name: string, githubUsername: string): Promise<void> {
    // Don't add duplicates
    const exists = this.teamData.members.some(
      (m) => m.githubUsername.toLowerCase() === githubUsername.toLowerCase()
    );
    if (exists) return;
    this.teamData.members.push({ name, githubUsername });
    await this.saveTeamFile();
  }

  /** Remove a team member. Only admins. */
  async removeMember(githubUsername: string): Promise<void> {
    this.teamData.members = this.teamData.members.filter(
      (m) => m.githubUsername.toLowerCase() !== githubUsername.toLowerCase()
    );
    await this.saveTeamFile();
  }

  /**
   * Sync team data into settings.teamMembers so the rest of the plugin
   * (name resolution, mentions, etc.) works without changes.
   */
  syncToSettings(): void {
    this.settings.teamMembers = [...this.teamData.members];

    // Auto-set userName from identity if not set
    if (this.currentGithubUser && !this.settings.userName) {
      const me = this.teamData.members.find((m) => this.isMe(m));
      if (me) {
        this.settings.userName = me.name;
      }
    }
  }

  // --- Private ---

  private validateTeamData(data: unknown): TeamData {
    if (!data || typeof data !== "object") throw new Error("Invalid team data");
    const d = data as Record<string, unknown>;

    const members: TeamMember[] = [];
    if (Array.isArray(d.members)) {
      for (const m of d.members) {
        if (m && typeof m === "object" && typeof (m as any).name === "string" && typeof (m as any).githubUsername === "string") {
          members.push({ name: (m as any).name, githubUsername: (m as any).githubUsername });
        }
      }
    }

    const admins: string[] = [];
    if (Array.isArray(d.admins)) {
      for (const a of d.admins) {
        if (typeof a === "string") admins.push(a);
      }
    }

    return { members, admins };
  }

  private async loadTeamFile(): Promise<void> {
    try {
      const filePath = join(this.vaultPath, TEAM_FILE);
      const data = await readFile(filePath, "utf-8");
      this.teamData = this.validateTeamData(JSON.parse(data));
    } catch {
      // File doesn't exist yet or failed validation — seed from current settings
      this.teamData = {
        members: [...this.settings.teamMembers],
        admins: this.settings.teamMembers.length > 0
          ? [this.settings.teamMembers[0].githubUsername] // first member = initial admin
          : [],
      };
      await this.saveTeamFile();
    }
  }

  private async saveTeamFile(): Promise<void> {
    const dir = join(this.vaultPath, ".team-vault");
    await mkdir(dir, { recursive: true });
    const filePath = join(this.vaultPath, TEAM_FILE);
    await writeFile(filePath, JSON.stringify(this.teamData, null, 2), "utf-8");
  }

  private async detectIdentity(): Promise<void> {
    if (!this.settings.githubPat) return;

    try {
      // Get authenticated user from PAT
      const userRes = await requestUrl({
        url: "https://api.github.com/user",
        headers: {
          Authorization: `Bearer ${this.settings.githubPat}`,
          "User-Agent": "TeamVault",
        },
      });
      if (userRes.status === 200) {
        this.currentGithubUser = userRes.json.login;
      }
    } catch {
      // PAT might be invalid — identity unknown
    }

    // Check if user is repo admin
    if (this.currentGithubUser && this.settings.githubRepo) {
      try {
        const permRes = await requestUrl({
          url: `https://api.github.com/repos/${this.settings.githubRepo}/collaborators/${this.currentGithubUser}/permission`,
          headers: {
            Authorization: `Bearer ${this.settings.githubPat}`,
            "User-Agent": "TeamVault",
          },
        });
        if (permRes.status === 200) {
          const perm = permRes.json.permission;
          this.isRepoAdmin = perm === "admin" || perm === "write";
        }
      } catch {
        // Do not fall back to the admins array in team.json.
        // team.json is git-tracked and writable by any team member, so
        // trusting it for privilege checks would let anyone self-escalate
        // to admin by pushing a modified file. Default to non-admin instead.
        this.isRepoAdmin = false;
      }
    }
  }
}
