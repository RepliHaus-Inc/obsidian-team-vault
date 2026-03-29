import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import { RangeSetBuilder } from "@codemirror/state";

/** Line numbers to highlight as added or removed */
export interface DiffLines {
  added: number[];   // 1-based line numbers
  removed: number[]; // 1-based line numbers (shown as markers, line may not exist)
}

// State effect to set/clear diff highlights
const setDiffEffect = StateEffect.define<DiffLines | null>();

// Decorations
const addedLine = Decoration.line({ class: "tv-diff-added" });
const removedLine = Decoration.line({ class: "tv-diff-removed" });

// State field that holds current diff decorations
const diffField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDiffEffect)) {
        if (!effect.value) return Decoration.none;

        const builder = new RangeSetBuilder<Decoration>();
        const doc = tr.state.doc;
        const totalLines = doc.lines;

        // Collect all lines to decorate, sorted by line number
        const decorations: { line: number; deco: Decoration }[] = [];

        for (const lineNum of effect.value.added) {
          if (lineNum >= 1 && lineNum <= totalLines) {
            decorations.push({ line: lineNum, deco: addedLine });
          }
        }
        for (const lineNum of effect.value.removed) {
          // For removed lines, highlight the nearest existing line
          const nearest = Math.min(lineNum, totalLines);
          if (nearest >= 1) {
            decorations.push({ line: nearest, deco: removedLine });
          }
        }

        // Sort by position (required for RangeSetBuilder)
        decorations.sort((a, b) => a.line - b.line);

        // Deduplicate (same line can't have two line decorations)
        const seen = new Set<number>();
        for (const d of decorations) {
          if (seen.has(d.line)) continue;
          seen.add(d.line);
          const pos = doc.line(d.line).from;
          builder.add(pos, pos, d.deco);
        }

        return builder.finish();
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Apply diff highlights to a CM6 editor view.
 */
export function applyDiffHighlight(view: EditorView, lines: DiffLines): void {
  view.dispatch({ effects: setDiffEffect.of(lines) });
}

/**
 * Clear diff highlights from a CM6 editor view.
 */
export function clearDiffHighlight(view: EditorView): void {
  view.dispatch({ effects: setDiffEffect.of(null) });
}

/**
 * The CM6 extension to register on the editor.
 * Must be registered once via `registerEditorExtension`.
 */
export const diffHighlightExtension = diffField;
