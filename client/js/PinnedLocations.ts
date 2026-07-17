// Manages the "Pinned locations" sidebar panel: a persisted list of share
// URLs the user has saved via the share button. Each row navigates to its
// share URL when clicked and reveals rename/copy/delete buttons on hover.
// The list is stored in localStorage so it survives reloads.

const PINNED_LOCATIONS_STORAGE_KEY = "mandelbrot-pinned-locations";

// Octicon pencil-16, copy-16, and trash-16
// (https://icon-sets.iconify.design/octicon/).
const PENCIL_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.609Zm.176 4.823L9.75 4.81l-6.286 6.287a.25.25 0 0 0-.064.108l-.558 1.953 1.953-.558a.249.249 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"/></svg>`;
const COPY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path fill="currentColor" d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>`;
const TRASH_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75M4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15M6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25"/></svg>`;

type PinnedLocation = {
  // The full share URL for the saved view.
  url: string;
  // Creation timestamp (epoch milliseconds), shown as a human-readable date.
  createdAt: number;
  // Optional user-given name; rows without one are labeled by their date.
  name?: string;
};

class PinnedLocations {
  private locations: PinnedLocation[];
  private listElement: HTMLElement;
  private emptyElement: HTMLElement;

  constructor() {
    this.locations = this.load();

    this.listElement = document.getElementById(
      "pinnedLocationsList",
    ) as HTMLElement;
    this.emptyElement = document.getElementById(
      "pinnedLocationsEmpty",
    ) as HTMLElement;

    this.render();
  }

  /** Saves the current view's share URL to the top of the list (unless it is
   * already pinned) and persists it. */
  add(url: string) {
    if (this.locations.some((location) => location.url === url)) {
      return;
    }

    this.locations.unshift({ url, createdAt: Date.now() });
    this.save();
    this.render();
  }

  private remove(url: string) {
    this.locations = this.locations.filter((location) => location.url !== url);
    this.save();
    this.render();
  }

  /** Sets (or, given a blank name, clears) a location's user-given name and
   * repaints the list. A cleared name falls back to the date label. */
  private rename(url: string, rawName: string) {
    const location = this.locations.find((entry) => entry.url === url);
    if (location) {
      const name = rawName.trim();
      if (name) {
        location.name = name;
      } else {
        delete location.name;
      }
      this.save();
    }
    this.render();
  }

  private load(): PinnedLocation[] {
    if (!window.localStorage) {
      return [];
    }

    try {
      const raw = localStorage.getItem(PINNED_LOCATIONS_STORAGE_KEY);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter(
        (entry): entry is PinnedLocation =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as PinnedLocation).url === "string" &&
          typeof (entry as PinnedLocation).createdAt === "number" &&
          ["undefined", "string"].includes(
            typeof (entry as PinnedLocation).name,
          ),
      );
    } catch (e) {
      console.error("Error loading pinned locations from localStorage", e);
      return [];
    }
  }

  private save() {
    if (!window.localStorage) {
      return;
    }
    localStorage.setItem(
      PINNED_LOCATIONS_STORAGE_KEY,
      JSON.stringify(this.locations),
    );
  }

  private render() {
    this.listElement.textContent = "";
    this.emptyElement.hidden = this.locations.length > 0;

    for (const location of this.locations) {
      this.listElement.appendChild(this.buildRow(location));
    }
  }

  private buildRow(location: PinnedLocation): HTMLElement {
    const row = document.createElement("li");
    row.className = "pinned-location";

    // The row itself is a link to the share URL: clicking (or activating with
    // the keyboard) navigates there, which reapplies the saved view on load.
    const link = document.createElement("a");
    link.className = "pinned-location-link";
    link.href = location.url;
    link.title = location.url;
    link.textContent =
      location.name ?? new Date(location.createdAt).toLocaleString();
    row.appendChild(link);

    const actions = document.createElement("div");
    actions.className = "pinned-location-actions";

    const renameButton = document.createElement("button");
    renameButton.type = "button";
    renameButton.className = "pinned-location-action";
    renameButton.title = "Rename";
    renameButton.setAttribute("aria-label", "Rename");
    renameButton.innerHTML = PENCIL_ICON;
    renameButton.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.startRename(row, link, location);
    };
    actions.appendChild(renameButton);

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "pinned-location-action";
    copyButton.title = "Copy link";
    copyButton.setAttribute("aria-label", "Copy link");
    copyButton.innerHTML = COPY_ICON;
    copyButton.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard.writeText(location.url);
    };
    actions.appendChild(copyButton);

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "pinned-location-action";
    deleteButton.title = "Remove";
    deleteButton.setAttribute("aria-label", "Remove");
    deleteButton.innerHTML = TRASH_ICON;
    deleteButton.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.remove(location.url);
    };
    actions.appendChild(deleteButton);

    row.appendChild(actions);

    return row;
  }

  /** Swaps the row's label for an inline text input editing the location's
   * name. Enter or clicking away commits (a blank value clears the name,
   * restoring the date label); Escape cancels. */
  private startRename(
    row: HTMLElement,
    link: HTMLElement,
    location: PinnedLocation,
  ) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "pinned-location-rename-input";
    input.value = location.name ?? "";
    input.placeholder = new Date(location.createdAt).toLocaleString();
    input.setAttribute("aria-label", "Location name");

    link.hidden = true;
    row.insertBefore(input, link.nextSibling);
    input.focus();
    input.select();

    // Enter commits and then blurs; the guard keeps the blur from
    // double-committing (render() below detaches the input, which also
    // fires blur).
    let finished = false;
    const finish = (commit: boolean) => {
      if (finished) {
        return;
      }
      finished = true;
      if (commit) {
        this.rename(location.url, input.value);
      } else {
        this.render();
      }
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        // Keep the Escape from also dismissing app-level state (the pinned
        // point tooltip listens for it on window).
        e.stopPropagation();
        finish(false);
      }
    };
    input.onblur = () => finish(true);
  }
}

export default PinnedLocations;
