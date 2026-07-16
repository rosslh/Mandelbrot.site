// Manages the "Pinned locations" sidebar panel: a persisted list of share
// URLs the user has saved via the share button. Each row navigates to its
// share URL when clicked and reveals copy/delete buttons on hover. The list
// is stored in localStorage so it survives reloads.

const PINNED_LOCATIONS_STORAGE_KEY = "mandelbrot-pinned-locations";

// Octicon copy-16 and trash-16 (https://icon-sets.iconify.design/octicon/).
const COPY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path fill="currentColor" d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>`;
const TRASH_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75M4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15M6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25"/></svg>`;

type PinnedLocation = {
  // The full share URL for the saved view.
  url: string;
  // Creation timestamp (epoch milliseconds), shown as a human-readable date.
  createdAt: number;
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
          typeof (entry as PinnedLocation).createdAt === "number",
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
    link.textContent = new Date(location.createdAt).toLocaleString();
    row.appendChild(link);

    const actions = document.createElement("div");
    actions.className = "pinned-location-actions";

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
}

export default PinnedLocations;
