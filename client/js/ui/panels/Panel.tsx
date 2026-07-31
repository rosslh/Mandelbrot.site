import type { ComponentChildren, JSX } from "preact";
import { useApp } from "../AppContext";
import { PANEL_DEFAULT_OPEN } from "../../state/uiState";
import {
  isResetVisible,
  resetPanel,
  type ResetSpec,
} from "../../state/settingsController";

/** A sidebar <details> panel. The open/closed state lives in uiState
 * (persisted under the panel's id, the same localStorage shape the old
 * sidebar used); the native toggle event writes it back, so keyboard and
 * find-in-page toggles persist too. */
export function Panel({
  id,
  class: className,
  summaryClass,
  summary,
  children,
}: {
  id: string;
  class?: string;
  summaryClass?: string;
  summary: ComponentChildren;
  children: ComponentChildren;
}): JSX.Element {
  const { ui } = useApp();
  const open = ui.detailsOpen.value[id] ?? PANEL_DEFAULT_OPEN[id] ?? true;

  return (
    <details
      id={id}
      class={className}
      open={open}
      onToggle={(event) => ui.setPanelOpen(id, event.currentTarget.open)}
    >
      <summary class={summaryClass}>{summary}</summary>
      <div class="details-content">{children}</div>
    </details>
  );
}

/** A panel summary's reset button, shown only while the panel's settings
 * have diverged from the initial config (derived from the settings signals,
 * so engine-side writes like a view move update it too). */
export function ResetButton({
  spec,
  title,
}: {
  spec: ResetSpec;
  title: string;
}): JSX.Element {
  const { map } = useApp();
  const visible = isResetVisible(map, spec);

  return (
    <button
      type="button"
      class={`reset-button${visible ? " visible" : ""}`}
      id={spec.buttonId}
      title={title}
      onClick={() => resetPanel(map, spec)}
    >
      ↺
    </button>
  );
}
