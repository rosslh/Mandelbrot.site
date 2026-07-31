import { useEffect, useMemo, useRef } from "preact/hooks";
import type { MutableRef } from "preact/hooks";
import { useSignalEffect } from "@preact/signals";
import debounce from "lodash/debounce";

/** Binds a text-like input (number, text, range) to the settings store the
 * way the old sidebar behaved: the input mirrors the config signal whenever
 * it changes (including engine-side writes like the view publishing its
 * coordinates), and edits commit debounced. After a commit the input is
 * rewritten with the canonical value — an invalid edit visibly reverts, and
 * a magnification snap redisplays the zoom actually applied — unless the
 * commit returns false (a pending confirmation keeps the typed value).
 *
 * The input stays uncontrolled: its value is written imperatively, exactly
 * like the old id-based sync, so high-frequency signal writes never fight
 * the user's in-progress edit through the virtual DOM. */
export function useSyncedInput({
  display,
  commit,
  debounceMs,
}: {
  // The canonical display string; reads config signals reactively.
  display: () => string;
  // Applies the raw input text. Return false to skip the post-commit
  // redisplay (a view-resetting change awaiting confirmation).
  commit: (raw: string) => boolean | void;
  debounceMs: number;
}): {
  ref: MutableRef<HTMLInputElement | null>;
  onInput: () => void;
} {
  const ref = useRef<HTMLInputElement>(null);

  useSignalEffect(() => {
    const value = display();
    if (ref.current) {
      ref.current.value = value;
    }
  });

  const onInput = useMemo(
    () =>
      debounce(() => {
        const input = ref.current;
        if (!input) {
          return;
        }
        if (commit(input.value) !== false) {
          input.value = display();
        }
      }, debounceMs),
    // The input components pass stable closures over the app singletons, so
    // the debounced handler is created once per mount.
    [],
  );

  return { ref, onInput };
}

/** Runs showModal()/close() on a <dialog> from the given open flag. The
 * `open` attribute is never rendered — setting it directly would open the
 * dialog non-modally, without the top layer or backdrop. */
export function useDialog(open: boolean): MutableRef<HTMLDialogElement | null> {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return ref;
}
