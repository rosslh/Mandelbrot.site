// Schema-driven setting inputs. Each binds its config signal through
// useSyncedInput (or a controlled prop for instant controls) and commits
// through the settings controller, which routes the change to the cheapest
// visual effect. Ids and names match the setting keys, as the HTML always
// did, so the stylesheet and <label for> wiring keep working unchanged.

import type { JSX } from "preact";
import { useSignalEffect } from "@preact/signals";
import type {
  CheckboxSpec,
  CoordinateSpec,
  MagnificationSpec,
  NumberSpec,
  SelectNumberSpec,
  SelectSpec,
  SliderSpec,
} from "../config";
import { formatMagnification } from "../magnification";
import {
  applyNumberSetting,
  commitCheckboxSetting,
  commitCoordinateSetting,
  commitMagnificationSetting,
  commitSelectSetting,
  commitSliderSetting,
  parseNumberValue,
} from "../state/settingsController";
import { useApp } from "./AppContext";
import { useSyncedInput } from "./hooks";

// Debounce for typed inputs (numbers, coordinates, magnification): long
// enough to let the user finish typing before a re-render fires.
const TYPED_INPUT_DEBOUNCE_MS = 1000;
const SLIDER_DEBOUNCE_MS = 300;

type InputExtras = Omit<
  JSX.IntrinsicElements["input"],
  "id" | "name" | "type" | "value" | "onInput" | "onChange" | "checked"
>;

export function SettingNumberInput({
  spec,
  ...rest
}: { spec: NumberSpec } & InputExtras): JSX.Element {
  const { map, ui } = useApp();

  const { ref, onInput } = useSyncedInput({
    display: () => String(map.store.signals[spec.key].value),
    commit: (raw) => {
      const value = parseNumberValue(map, spec, raw);
      // Settings that reset the view (the power) discard the current
      // position, so confirm the change before applying it; the input keeps
      // the typed value while the confirmation is open.
      if (spec.resetView && value !== map.config[spec.key]) {
        ui.changePowerRequest.value = { spec, value };
        return false;
      }
      applyNumberSetting(map, spec, value);
    },
    debounceMs: TYPED_INPUT_DEBOUNCE_MS,
  });

  // A cancelled confirmation leaves the config untouched (no signal
  // notification), so restore the input to the still-current value once the
  // request resolves either way.
  useSignalEffect(() => {
    if (!spec.resetView) {
      return;
    }
    if (ui.changePowerRequest.value === null && ref.current) {
      ref.current.value = String(map.store.signals[spec.key].peek());
    }
  });

  return (
    <input
      type="number"
      required
      id={spec.key}
      name={spec.key}
      ref={ref}
      onInput={onInput}
      {...rest}
    />
  );
}

export function CoordinateInput({
  spec,
}: {
  spec: CoordinateSpec;
}): JSX.Element {
  const { map } = useApp();

  const { ref, onInput } = useSyncedInput({
    display: () => map.store.signals[spec.key].value,
    commit: (raw) => commitCoordinateSetting(map, spec, raw),
    debounceMs: TYPED_INPUT_DEBOUNCE_MS,
  });

  return (
    <input
      type="text"
      inputMode="decimal"
      required
      id={spec.key}
      name={spec.key}
      ref={ref}
      onInput={onInput}
    />
  );
}

/** The zoom setting's input: displayed and edited as a magnification factor,
 * stored as the effective zoom level it snaps to. */
export function MagnificationInput({
  spec,
}: {
  spec: MagnificationSpec;
}): JSX.Element {
  const { map } = useApp();

  const { ref, onInput } = useSyncedInput({
    display: () => formatMagnification(map.store.signals.zoom.value),
    commit: (raw) => commitMagnificationSetting(map, spec, raw),
    debounceMs: TYPED_INPUT_DEBOUNCE_MS,
  });

  return (
    <input
      type="text"
      inputMode="decimal"
      required
      id={spec.key}
      name={spec.key}
      ref={ref}
      onInput={onInput}
    />
  );
}

export function SettingSliderInput({
  spec,
  ...rest
}: { spec: SliderSpec } & InputExtras): JSX.Element {
  const { map } = useApp();

  const { ref, onInput } = useSyncedInput({
    display: () => String(map.store.signals[spec.key].value),
    commit: (raw) => commitSliderSetting(map, spec, Number.parseFloat(raw)),
    debounceMs: SLIDER_DEBOUNCE_MS,
  });

  return (
    <input
      type="range"
      id={spec.key}
      name={spec.key}
      ref={ref}
      onInput={onInput}
      {...rest}
    />
  );
}

type SelectExtras = Omit<
  JSX.IntrinsicElements["select"],
  "id" | "name" | "value" | "onChange"
>;

export function SettingSelect({
  spec,
  children,
  ...rest
}: {
  spec: SelectSpec | SelectNumberSpec;
  children: JSX.Element | JSX.Element[];
} & SelectExtras): JSX.Element {
  const { map } = useApp();
  const value = String(map.store.signals[spec.key].value);

  return (
    <select
      id={spec.key}
      name={spec.key}
      value={value}
      onChange={(event) =>
        commitSelectSetting(map, spec, event.currentTarget.value)
      }
      {...rest}
    >
      {children}
    </select>
  );
}

export function SettingCheckbox({ spec }: { spec: CheckboxSpec }): JSX.Element {
  const { map } = useApp();
  const checked = Boolean(map.store.signals[spec.key].value);

  return (
    <input
      type="checkbox"
      id={spec.key}
      name={spec.key}
      checked={checked}
      onChange={(event) =>
        commitCheckboxSetting(map, spec, event.currentTarget.checked)
      }
    />
  );
}
