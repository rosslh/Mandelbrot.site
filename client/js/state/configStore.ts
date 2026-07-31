// The app's settings state: one signal per MandelbrotConfig key, plus a
// plain-object facade for the imperative engine code. UI components bind the
// signals for fine-grained reactivity; the engine (map, tile layer, exports)
// keeps reading and writing `store.config` exactly as it did the mutable
// config object this store replaces.

import { batch, Signal, signal } from "@preact/signals";
import { defaultConfig, MandelbrotConfig } from "../config";

export type ConfigSignals = {
  [K in keyof MandelbrotConfig]: Signal<MandelbrotConfig[K]>;
};

export type ConfigStore = {
  // One signal per setting, for UI bindings and computeds.
  signals: ConfigSignals;
  // Engine-facing facade over the same signals. Reads peek() — engine code
  // called from inside a component effect must not subscribe that effect to
  // every config key it happens to touch — while writes go through
  // `.value`, so an engine-side change (the palette auto-fit, the view
  // publishing its coordinates) notifies every bound input and computed.
  // This is what replaces the old id-based syncInputToConfig contract.
  config: MandelbrotConfig;
  // A point-in-time plain copy, for long-running operations (image export,
  // animation generation) that must not see later writes.
  snapshot(): MandelbrotConfig;
  // Batched multi-key write: subscribers see one consistent update.
  patch(partial: Partial<MandelbrotConfig>): void;
  // The pristine starting settings (no share-URL overrides), diffed against
  // by the reset buttons. Frozen: resets write the live signals, never this.
  initial: Readonly<MandelbrotConfig>;
};

const configKeys = Object.keys(defaultConfig) as (keyof MandelbrotConfig)[];

/** Creates the settings store. `initial` is the app's starting config (the
 * defaults with the responsive zoom applied); `overrides` are share-URL
 * values, which seed the signals but deliberately not `store.initial`, so a
 * shared view's reset buttons still return to the app defaults. */
export function createConfigStore(
  initial: MandelbrotConfig,
  overrides: Partial<MandelbrotConfig> = {},
): ConfigStore {
  const starting: MandelbrotConfig = { ...initial, ...overrides };

  const signals = {} as Record<keyof MandelbrotConfig, Signal<unknown>>;
  for (const key of configKeys) {
    signals[key] = signal(starting[key]);
  }
  const configSignals = signals as ConfigSignals;

  const config = new Proxy({} as MandelbrotConfig, {
    get(_target, key: string) {
      return configSignals[key as keyof MandelbrotConfig]?.peek();
    },
    set(_target, key: string, value: unknown) {
      const entry = configSignals[key as keyof MandelbrotConfig];
      if (!entry) {
        return false;
      }
      (entry as Signal<unknown>).value = value;
      return true;
    },
    has(_target, key: string) {
      return key in configSignals;
    },
    ownKeys() {
      return configKeys;
    },
    getOwnPropertyDescriptor(_target, key: string) {
      const entry = configSignals[key as keyof MandelbrotConfig];
      if (!entry) {
        return undefined;
      }
      return {
        enumerable: true,
        configurable: true,
        writable: true,
        value: entry.peek(),
      };
    },
  });

  const snapshot = (): MandelbrotConfig => {
    const copy = {} as Record<keyof MandelbrotConfig, unknown>;
    for (const key of configKeys) {
      copy[key] = configSignals[key].peek();
    }
    return copy as MandelbrotConfig;
  };

  const patch = (partial: Partial<MandelbrotConfig>): void => {
    batch(() => {
      for (const [key, value] of Object.entries(partial)) {
        const entry = configSignals[key as keyof MandelbrotConfig];
        if (entry) {
          (entry as Signal<unknown>).value = value;
        }
      }
    });
  };

  return {
    signals: configSignals,
    config,
    snapshot,
    patch,
    initial: Object.freeze({ ...initial }),
  };
}
