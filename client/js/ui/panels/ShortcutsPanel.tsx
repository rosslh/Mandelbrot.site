import type { JSX } from "preact";
import { Panel } from "./Panel";

// The stylesheet hides .mac-shortcut by default; on a Mac the inline styles
// swap which platform's hint shows, exactly as the old handleShortcutHints
// did.
const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;

export function ShortcutsPanel(): JSX.Element {
  return (
    <Panel
      id="shortcuts"
      class="mobile-hidden"
      summary={<span>Shortcuts</span>}
    >
      <div class="shortcut-wrapper">
        <code>shift + drag</code>
        <span>Zoom in</span>
      </div>
      <div class="shortcut-wrapper">
        <code
          class="windows-shortcut"
          style={isMac ? { display: "none" } : undefined}
        >
          alt + click
        </code>
        <code
          class="mac-shortcut"
          style={isMac ? { display: "inline-block" } : undefined}
        >
          option + click
        </code>
        <div>Center point</div>
      </div>
      <div class="shortcut-wrapper">
        <code>ctrl + hover</code>
        <div>Inspect point</div>
      </div>
    </Panel>
  );
}
