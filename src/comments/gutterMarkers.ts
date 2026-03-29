// CM6 types are externalized by esbuild — they come from Obsidian at runtime
// We declare minimal types here so TypeScript is happy without installing the packages
import type { CommentStore, Comment } from "./commentStore";
import type TeamVaultPlugin from "../main";

// Use Obsidian's re-exported CM6 types via dynamic access at runtime.
// At build time, esbuild externalizes @codemirror/* so this code compiles
// but doesn't bundle them.

// Minimal type shims for compile-time only
interface GutterConfig {
  class: string;
  markers: (view: unknown) => unknown;
  domEventHandlers?: Record<string, (view: unknown, line: unknown) => boolean>;
}

/**
 * GutterMarkerPlugin provides CM6 gutter decorations for inline comments.
 * It uses a synchronous cache since CM6 gutter markers must be returned synchronously.
 *
 * Because @codemirror packages are externalized (provided by Obsidian at runtime),
 * we dynamically import them to avoid TypeScript resolution issues at compile time.
 */
export class GutterMarkerPlugin {
  static create(
    commentStore: CommentStore,
    plugin: TeamVaultPlugin
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): any {
    // Dynamically require CM6 modules that Obsidian provides at runtime
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cmView = require("@codemirror/view");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cmState = require("@codemirror/state");

    const { gutter, GutterMarker } = cmView;
    const { RangeSetBuilder } = cmState;

    class CommentGutterMarker extends GutterMarker {
      hasUnresolved: boolean;
      count: number;
      constructor(hasUnresolved: boolean, count: number) {
        super();
        this.hasUnresolved = hasUnresolved;
        this.count = count;
      }

      toDOM(): HTMLElement {
        const el = document.createElement("div");
        el.className = `tv-gutter-marker ${this.hasUnresolved ? "" : "resolved"}`;
        el.title = `${this.count} comment(s)`;
        return el;
      }
    }

    const commentGutter = gutter({
      class: "tv-comment-gutter",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      markers: (view: any) => {
        const builder = new RangeSetBuilder();
        const filePath = plugin.app.workspace.getActiveFile()?.path;
        if (!filePath) return builder.finish();

        const cachedComments = GutterMarkerPlugin.getCachedComments(
          commentStore,
          filePath
        );
        if (!cachedComments || cachedComments.length === 0)
          return builder.finish();

        const doc = view.state.doc;
        const content = doc.toString();

        const decorations: { pos: number; marker: InstanceType<typeof CommentGutterMarker> }[] = [];

        for (const comment of cachedComments) {
          const line = commentStore.resolveAnchorLine(content, comment.anchor);
          if (line === null || line < 1 || line > doc.lines) continue;

          const lineStart = doc.line(line).from;
          const hasUnresolved = !comment.resolved;
          decorations.push({
            pos: lineStart,
            marker: new CommentGutterMarker(hasUnresolved, 1),
          });
        }

        decorations.sort((a, b) => a.pos - b.pos);

        const seen = new Set<number>();
        for (const dec of decorations) {
          if (seen.has(dec.pos)) continue;
          seen.add(dec.pos);
          builder.add(dec.pos, dec.pos, dec.marker);
        }

        return builder.finish();
      },
      domEventHandlers: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        click: (_view: any, _line: any) => {
          plugin.activateView("tv-comments");
          return true;
        },
      },
    });

    return commentGutter;
  }

  // Cache for synchronous access
  private static commentCache: Map<string, Comment[]> = new Map();
  private static loadingPaths: Set<string> = new Set();

  static getCachedComments(
    store: CommentStore,
    filePath: string
  ): Comment[] | null {
    const cached = this.commentCache.get(filePath);
    if (cached !== undefined) return cached;

    if (!this.loadingPaths.has(filePath)) {
      this.loadingPaths.add(filePath);
      store
        .getCommentsForFile(filePath)
        .then((comments) => {
          this.commentCache.set(filePath, comments);
          this.loadingPaths.delete(filePath);
        })
        .catch(() => {
          this.loadingPaths.delete(filePath);
        });
    }

    return null;
  }

  static invalidateCache(filePath?: string): void {
    if (filePath) {
      this.commentCache.delete(filePath);
    } else {
      this.commentCache.clear();
    }
  }

  /**
   * Pre-populate the cache so the next gutter re-render finds data immediately.
   * Must be called BEFORE dispatching a CM6 transaction to force re-render.
   */
  static async preloadCache(
    store: CommentStore,
    filePath: string
  ): Promise<void> {
    const comments = await store.getCommentsForFile(filePath);
    this.commentCache.set(filePath, comments);
    this.loadingPaths.delete(filePath);
  }
}
