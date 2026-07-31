import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { PinnedLocation } from "../../state/uiState";
import { useApp } from "../AppContext";
import { CopyIcon, PencilIcon, PinIcon, TrashIcon } from "../icons";
import { Panel } from "./Panel";

function dateLabel(location: PinnedLocation): string {
  return new Date(location.createdAt).toLocaleString();
}

/** The inline rename input that swaps in for a row's label. Enter or
 * clicking away commits (a blank value clears the name, restoring the date
 * label); Escape cancels. */
function RenameInput({
  location,
  onFinish,
}: {
  location: PinnedLocation;
  onFinish: (committedName: string | null) => void;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter commits and then blurs; the guard keeps the blur from
  // double-committing.
  const finishedRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (finishedRef.current) {
      return;
    }
    finishedRef.current = true;
    onFinish(commit ? (inputRef.current?.value ?? "") : null);
  };

  return (
    <input
      type="text"
      class="pinned-location-rename-input"
      ref={inputRef}
      defaultValue={location.name ?? ""}
      placeholder={dateLabel(location)}
      aria-label="Location name"
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          // Keep the Escape from also dismissing app-level state (the pinned
          // point tooltip listens for it on window).
          event.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

function PinnedLocationRow({
  location,
}: {
  location: PinnedLocation;
}): JSX.Element {
  const { ui } = useApp();
  const [renaming, setRenaming] = useState(false);

  return (
    <li class="pinned-location">
      {/* The row itself is a link to the share URL: clicking (or activating
          with the keyboard) navigates there, which reapplies the saved view
          on load. */}
      <a
        class="pinned-location-link"
        href={location.url}
        title={location.url}
        hidden={renaming}
      >
        {location.name ?? dateLabel(location)}
      </a>
      {renaming && (
        <RenameInput
          location={location}
          onFinish={(committedName) => {
            setRenaming(false);
            if (committedName !== null) {
              ui.renamePinnedLocation(location.url, committedName);
            }
          }}
        />
      )}
      <div class="pinned-location-actions">
        <button
          type="button"
          class="pinned-location-action"
          title="Rename"
          aria-label="Rename"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setRenaming(true);
          }}
        >
          <PencilIcon />
        </button>
        <button
          type="button"
          class="pinned-location-action"
          title="Copy link"
          aria-label="Copy link"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            navigator.clipboard.writeText(location.url);
          }}
        >
          <CopyIcon />
        </button>
        <button
          type="button"
          class="pinned-location-action"
          title="Remove"
          aria-label="Remove"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            ui.removePinnedLocation(location.url);
          }}
        >
          <TrashIcon />
        </button>
      </div>
    </li>
  );
}

/** The persisted list of share URLs saved via the share button. Each row
 * navigates to its share URL when clicked and reveals rename/copy/delete
 * buttons on hover. */
export function PinnedLocationsPanel(): JSX.Element {
  const { ui } = useApp();
  const locations = ui.pinnedLocations.value;

  return (
    <Panel
      id="pinnedLocations"
      class="mobile-hidden"
      summary={<span>Pinned locations</span>}
    >
      <p
        class="secondary"
        id="pinnedLocationsEmpty"
        hidden={locations.length > 0}
      >
        Pin the current view with the share button <PinIcon aria-hidden /> to
        save it here.
      </p>
      <ul id="pinnedLocationsList">
        {locations.map((location) => (
          <PinnedLocationRow key={location.url} location={location} />
        ))}
      </ul>
    </Panel>
  );
}
