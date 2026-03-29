import type { TeamVaultSettings, TeamMember } from "../settings";

export class MentionSuggest {
  private members: TeamMember[];

  constructor(settings: TeamVaultSettings) {
    this.members = settings.teamMembers;
  }

  /**
   * Attach mention suggestion behavior to a textarea element.
   * Shows a dropdown when user types @ followed by characters.
   */
  attach(textarea: HTMLTextAreaElement, container: HTMLElement): void {
    let suggestEl: HTMLElement | null = null;
    let selectedIndex = 0;
    let filtered: TeamMember[] = [];

    const removeSuggest = () => {
      if (suggestEl) {
        suggestEl.remove();
        suggestEl = null;
      }
    };

    const getAtQuery = (): string | null => {
      const pos = textarea.selectionStart;
      const text = textarea.value.substring(0, pos);
      const atIndex = text.lastIndexOf("@");
      if (atIndex === -1) return null;

      // Make sure @ is at start or preceded by whitespace
      if (atIndex > 0 && !/\s/.test(text[atIndex - 1])) return null;

      const query = text.substring(atIndex + 1);
      // If there's a space after the query started, the mention is complete
      if (query.includes(" ")) return null;

      return query;
    };

    const showSuggest = (query: string) => {
      filtered = this.members.filter((m) =>
        m.name.toLowerCase().startsWith(query.toLowerCase())
      );

      if (filtered.length === 0) {
        removeSuggest();
        return;
      }

      selectedIndex = 0;

      if (!suggestEl) {
        suggestEl = container.createDiv({ cls: "tv-mention-suggest" });
      }
      suggestEl.empty();

      for (let i = 0; i < filtered.length; i++) {
        const item = suggestEl.createDiv({
          cls: `tv-mention-item ${i === selectedIndex ? "selected" : ""}`,
          text: filtered[i].name,
        });
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          this.insertMention(textarea, filtered[i].name);
          removeSuggest();
        });
      }

      // Position near textarea
      const rect = textarea.getBoundingClientRect();
      suggestEl.style.top = `${rect.bottom + 4}px`;
      suggestEl.style.left = `${rect.left}px`;
      suggestEl.style.width = `${rect.width}px`;
    };

    textarea.addEventListener("input", () => {
      const query = getAtQuery();
      if (query !== null) {
        showSuggest(query);
      } else {
        removeSuggest();
      }
    });

    textarea.addEventListener("keydown", (e) => {
      if (!suggestEl || filtered.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        selectedIndex = (selectedIndex + 1) % filtered.length;
        this.updateSelection(suggestEl, selectedIndex);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        selectedIndex =
          (selectedIndex - 1 + filtered.length) % filtered.length;
        this.updateSelection(suggestEl, selectedIndex);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        this.insertMention(textarea, filtered[selectedIndex].name);
        removeSuggest();
      } else if (e.key === "Escape") {
        removeSuggest();
      }
    });

    textarea.addEventListener("blur", () => {
      // Delay to allow click on suggest item
      setTimeout(removeSuggest, 200);
    });
  }

  private insertMention(textarea: HTMLTextAreaElement, name: string): void {
    const pos = textarea.selectionStart;
    const text = textarea.value;
    const atIndex = text.lastIndexOf("@", pos - 1);
    if (atIndex === -1) return;

    const before = text.substring(0, atIndex);
    const after = text.substring(pos);
    textarea.value = `${before}@${name} ${after}`;
    const newPos = atIndex + name.length + 2; // +2 for @ and space
    textarea.setSelectionRange(newPos, newPos);

    // Trigger input event for any listeners
    textarea.dispatchEvent(new Event("input"));
  }

  private updateSelection(
    suggestEl: HTMLElement,
    selectedIndex: number
  ): void {
    const items = suggestEl.querySelectorAll(".tv-mention-item");
    items.forEach((item, i) => {
      if (i === selectedIndex) {
        item.addClass("selected");
      } else {
        item.removeClass("selected");
      }
    });
  }
}
