# Team Vault

Git-powered team collaboration for [Obsidian](https://obsidian.md). Sync your vault, leave inline comments, track activity, and collaborate on canvases — all through Git.

## Features

**Git Sync**
- Auto-sync vault via Git (commit, pull, push)
- 3-second auto-commit after edits
- Merge-based sync (no rebase headaches)
- Conflict resolution modal (side-by-side, pick yours or theirs)
- Retry logic for concurrent pushes

**Activity Feed**
- See what your team changed, in real time
- Sessions grouped by person and time ("Alice active for 15m, 5 files")
- Expandable file lists per session
- Filter by team member or type (vault changes, comments)
- New/read separation with dimmed read items

**Inline Comments**
- Select text in any markdown file, right-click, "Add Comment"
- Threaded replies with @mentions
- Gutter dots on lines with comments
- Resolve syncs to everyone, delete is local-only
- Comments panel with All / Mentions / This File tabs

**Canvas Comments**
- Right-click any node on a canvas to add a comment
- Yellow sticky note appears connected to the node
- Reply, edit, or resolve comments — all via right-click
- Syncs across team via Git

**Inline Diff Highlighting**
- Toggle "Show Changes" in the activity tab
- Click any file to see added/removed lines highlighted
- Green = added, red + strikethrough = removed

**Team Management**
- Shared team roster (`.team-vault/team.json`) syncs via Git
- Your GitHub PAT identifies you automatically
- Edit your own display name; admins can manage everyone
- Admin status from GitHub repo permissions (not a file)

**Self-Updater**
- Plugin checks for updates on startup
- One-click "Update & Reload" with SHA256 integrity verification
- Full vault reload after update — zero manual steps

## Installation

### Option 1: Bundle with your vault (recommended for teams)

The vault owner commits the plugin to the repo. Team members get it automatically on clone.

1. Download the latest release (`main.js`, `manifest.json`, `styles.css`)
2. Place them in your vault's `.obsidian/plugins/team-vault/`
3. Add a `.gitignore` exception (share the code, not your settings):
   ```
   .obsidian/
   !.obsidian/plugins/
   !.obsidian/plugins/team-vault/
   !.obsidian/plugins/team-vault/main.js
   !.obsidian/plugins/team-vault/manifest.json
   !.obsidian/plugins/team-vault/styles.css
   ```
4. Commit and push. Team members clone, open in Obsidian, enable the plugin.

### Option 2: Manual install per person

1. Download the latest release
2. Create `.obsidian/plugins/team-vault/` in your vault
3. Copy `main.js`, `manifest.json`, `styles.css` into it
4. Enable in Settings > Community Plugins

## Setup

On first run, a setup wizard walks you through 3 steps:

1. **Connect Repository** — Enter your GitHub repo (`owner/repo` format or full URL)
2. **Authenticate** — Paste a [fine-grained GitHub PAT](https://github.com/settings/personal-access-tokens/new) with Contents read/write scope on your vault repo
3. **Identity** — Your name auto-fills from GitHub. Set display name and email.

That's it. The plugin handles everything else.

## How It Works

```
You edit a file
    | (3 seconds)
Auto-commit your changes
    |
Pull remote changes (merge)
    |
Push your commit
    |
Teammate's plugin pulls on next sync
    |
Activity feed + comments update live
```

## Security

- **PAT storage**: Stored locally in Obsidian's plugin data (never synced via Git)
- **Fine-grained tokens**: Setup wizard guides you to create minimal-scope tokens
- **Integrity verification**: Self-updater requires SHA256 checksums before applying
- **No credential leaks**: Git error messages sanitized to strip tokens
- **Admin via API only**: Admin status checked against GitHub, not a local file
- **Input validation**: Git refs, file paths, GraphQL queries all validated/parameterized
- **Path traversal protection**: All file writes validated against vault boundary

## Data Storage

| Path | Synced? | Contents |
|------|---------|----------|
| `.team-vault/comments/` | Yes | Inline comment data (JSON) |
| `.team-vault/team.json` | Yes | Shared team roster |
| `.team-vault/local/` | No | Last-seen tracking, deleted comments |
| `.obsidian/plugins/team-vault/data.json` | No | Your PAT and local settings |

## Configuration

All settings in Settings > Team Vault:

| Setting | Default | Description |
|---------|---------|-------------|
| GitHub repo | _(empty)_ | `owner/repo` format |
| GitHub PAT | _(empty)_ | Fine-grained token with Contents read/write |
| Auto-sync | On | Sync automatically on interval |
| Sync interval | 5 min | How often to auto-sync |
| Edit debounce | 30 sec | Wait after last edit before auto-syncing |

## Contributing

1. Fork the repo
2. `npm install --legacy-peer-deps`
3. `npm run dev` (watch mode)
4. Make changes in `src/`
5. `npm run build` to verify
6. Open a PR

## License

[MIT](LICENSE)
