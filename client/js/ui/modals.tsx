// The app's three <dialog> modals. The `open` attribute is never rendered —
// that would open a dialog non-modally, without the top layer or backdrop —
// so useDialog drives showModal()/close() from the open signals instead.
//
// Busy-state choreography (ported from the old FormModal): while a submitted
// task runs, the submit and cancel buttons are disabled, Escape and
// resubmission are ignored, and the submit button's label reports progress.
// A cancellable task (the zoom animation) keeps its cancel button and Escape
// live, invoking cancellation instead of closing; the task is still
// responsible for finishing (which closes the modal) once it actually stops.

import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { AnimationCancelledError, AnimationProgress } from "../ZoomAnimator";
import type { AnimationKind, AnimationSpec } from "../animationFrames";
import { logEvent } from "../analytics";
import { applyNumberSetting } from "../state/settingsController";
import { useApp } from "./AppContext";
import { useDialog } from "./hooks";

function Modal({
  id,
  open,
  onCancel,
  children,
}: {
  id: string;
  open: boolean;
  onCancel: (event: Event) => void;
  children: ComponentChildren;
}): JSX.Element {
  const ref = useDialog(open);

  return (
    <dialog id={id} class="overlay form-modal" ref={ref} onCancel={onCancel}>
      {children}
    </dialog>
  );
}

/** The shared submit/cancel button pair, with the busy label and disabled
 * states. `cancelEnabledWhileBusy` marks a cancellable task. */
function SubmitOrCancel({
  submitId,
  cancelId,
  idleLabel,
  busyLabel,
  busy,
  cancelEnabledWhileBusy = false,
  onCancel,
}: {
  submitId: string;
  cancelId: string;
  idleLabel: string;
  busyLabel: string | null;
  busy: boolean;
  cancelEnabledWhileBusy?: boolean;
  onCancel: () => void;
}): JSX.Element {
  return (
    <div class="submit-or-cancel">
      <button type="submit" id={submitId} disabled={busy}>
        {busy && busyLabel !== null ? busyLabel : idleLabel}
      </button>
      <button
        type="button"
        id={cancelId}
        class="underline-button"
        disabled={busy && !cancelEnabledWhileBusy}
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
  );
}

export function SaveImageModal(): JSX.Element {
  const { map, ui } = useApp();
  const open = ui.saveImageModalOpen.value;
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const widthRef = useRef<HTMLInputElement>(null);
  const heightRef = useRef<HTMLInputElement>(null);
  const exportRawDataRef = useRef<HTMLInputElement>(null);
  const optimizeImage = ui.optimizeImage.value;

  // Prepare the form's fields each time the modal opens; the optimize
  // preference persists (it lives in uiState), everything else resets.
  useEffect(() => {
    if (!open) {
      return;
    }
    const scale = 2 * (window.devicePixelRatio || 1);
    if (widthRef.current) {
      widthRef.current.value = String(Math.ceil(window.screen.width * scale));
    }
    if (heightRef.current) {
      heightRef.current.value = String(Math.ceil(window.screen.height * scale));
    }
    if (exportRawDataRef.current) {
      exportRawDataRef.current.checked = false;
    }
  }, [open]);

  const close = () => {
    if (!busy) {
      ui.saveImageModalOpen.value = false;
    }
  };

  const onSubmit = (event: Event) => {
    event.preventDefault();
    if (busy) {
      return;
    }
    const width = Number(widthRef.current?.value);
    const height = Number(heightRef.current?.value);

    if (!width || Number.isNaN(width) || width <= 0) {
      return;
    }
    if (!height || Number.isNaN(height) || height <= 0) {
      return;
    }

    void logEvent(map, "imageSave");

    setBusy(true);
    setBusyLabel("Generating...");
    const shouldOptimize = ui.optimizeImage.peek();
    const shouldExportRawData = exportRawDataRef.current?.checked ?? false;

    map.imageSaver
      .saveVisibleImage(
        width,
        height,
        shouldOptimize,
        shouldOptimize ? () => setBusyLabel("Optimizing...") : undefined,
      )
      .then(() => {
        if (!shouldExportRawData) {
          return;
        }
        setBusyLabel("Exporting data...");
        return map.imageSaver.saveVisibleData(width, height);
      })
      .catch((error: unknown) => {
        alert("Error saving image\n\n" + error);
        console.error(error);
      })
      .finally(() => {
        setBusy(false);
        setBusyLabel(null);
        ui.saveImageModalOpen.value = false;
      });
  };

  return (
    <Modal
      id="saveImageModal"
      open={open}
      onCancel={(event) => {
        // Escape can't dismiss the modal while its task runs.
        if (busy) {
          event.preventDefault();
        } else {
          ui.saveImageModalOpen.value = false;
        }
      }}
    >
      <form id="saveImageForm" onSubmit={onSubmit}>
        <strong>Save image</strong>
        <div class="input-wrapper">
          <label for="imageWidth">Width (px)</label>
          <input
            type="number"
            required
            id="imageWidth"
            name="imageWidth"
            ref={widthRef}
          />
        </div>
        <div class="input-wrapper">
          <label for="imageHeight">Height (px)</label>
          <input
            type="number"
            required
            id="imageHeight"
            name="imageHeight"
            ref={heightRef}
          />
        </div>
        <div class="checkbox-wrapper">
          <input
            type="checkbox"
            id="optimizeImage"
            name="optimizeImage"
            checked={optimizeImage}
            onChange={(event) => {
              ui.optimizeImage.value = event.currentTarget.checked;
            }}
          />
          <label for="optimizeImage">
            Reduce file size <span class="secondary">(slow)</span>
          </label>
        </div>
        <div class="checkbox-wrapper">
          <input
            type="checkbox"
            id="exportRawData"
            name="exportRawData"
            ref={exportRawDataRef}
          />
          <label for="exportRawData">
            Also export raw iteration data{" "}
            <span class="secondary">(.npy in a .zip)</span>
          </label>
        </div>
        <SubmitOrCancel
          submitId="saveImageSubmit"
          cancelId="saveImageCancel"
          idleLabel="Save"
          busyLabel={busyLabel}
          busy={busy}
          onCancel={close}
        />
      </form>
    </Modal>
  );
}

/** Validates the animation modal's inputs into an `AnimationSpec`, or null
 * when any value is missing or out of range. */
function readAnimationSpec(refs: {
  kind: HTMLSelectElement | null;
  width: HTMLInputElement | null;
  height: HTMLInputElement | null;
  duration: HTMLInputElement | null;
  fps: HTMLInputElement | null;
}): AnimationSpec | null {
  const width = Number(refs.width?.value);
  const height = Number(refs.height?.value);
  const durationSeconds = Number(refs.duration?.value);
  const fps = Number(refs.fps?.value);
  const kind = refs.kind?.value as AnimationKind;

  const positive = (value: number) => Number.isFinite(value) && value > 0;
  if (
    !positive(width) ||
    !positive(height) ||
    !positive(durationSeconds) ||
    !positive(fps) ||
    (kind !== "in" && kind !== "out")
  ) {
    return null;
  }

  return { kind, width, height, durationSeconds, fps };
}

function animationProgressLabel(progress: AnimationProgress): string {
  const percent = Math.round(progress.fraction * 100);
  if (progress.phase === "rendering") {
    return `Rendering ${progress.frame}/${progress.totalFrames} (${percent}%)`;
  }
  return `Encoding (${percent}%)`;
}

/** The zoom-animation modal (issue #13). The current view is the animation's
 * target; the user picks the direction (zoom in to / out of it), resolution,
 * duration, and frame rate. Generation runs on the shared worker pool with
 * per-frame progress on the submit button and mid-run cancellation via the
 * (kept-live) cancel button. */
export function AnimateModal(): JSX.Element {
  const { map, ui } = useApp();
  const open = ui.animateModalOpen.value;
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const kindRef = useRef<HTMLSelectElement>(null);
  const widthRef = useRef<HTMLInputElement>(null);
  const heightRef = useRef<HTMLInputElement>(null);
  const durationRef = useRef<HTMLInputElement>(null);
  const fpsRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    // Default to a modest 720p-ish preset: large enough to look good, small
    // enough to render in reasonable time.
    if (kindRef.current) kindRef.current.value = "in";
    if (widthRef.current) widthRef.current.value = "1280";
    if (heightRef.current) heightRef.current.value = "720";
    if (durationRef.current) durationRef.current.value = "8";
    if (fpsRef.current) fpsRef.current.value = "30";
  }, [open]);

  const cancelBusyTask = () => {
    setBusyLabel("Cancelling...");
    map.zoomAnimator.cancel();
  };

  const onCancel = () => {
    if (busy) {
      cancelBusyTask();
    } else {
      ui.animateModalOpen.value = false;
    }
  };

  const onSubmit = (event: Event) => {
    event.preventDefault();
    if (busy) {
      return;
    }
    const spec = readAnimationSpec({
      kind: kindRef.current,
      width: widthRef.current,
      height: heightRef.current,
      duration: durationRef.current,
      fps: fpsRef.current,
    });
    if (!spec) {
      return;
    }

    setBusy(true);
    setBusyLabel("Preparing...");
    map.zoomAnimator
      .generate(spec, (progress: AnimationProgress) => {
        setBusyLabel(animationProgressLabel(progress));
      })
      .catch((error: unknown) => {
        if (error instanceof AnimationCancelledError) {
          return;
        }
        alert("Error generating animation\n\n" + error);
        console.error(error);
      })
      .finally(() => {
        setBusy(false);
        setBusyLabel(null);
        ui.animateModalOpen.value = false;
      });
  };

  return (
    <Modal
      id="animateZoomModal"
      open={open}
      onCancel={(event) => {
        if (busy) {
          // The task is cancellable: Escape requests cancellation, but the
          // modal stays up showing progress until the run actually stops.
          event.preventDefault();
          cancelBusyTask();
        } else {
          ui.animateModalOpen.value = false;
        }
      }}
    >
      <form id="animateZoomForm" onSubmit={onSubmit}>
        <strong>Generate zoom animation</strong>
        <div class="input-wrapper">
          <label for="animateKind">Kind</label>
          <select id="animateKind" name="animateKind" ref={kindRef}>
            <option value="in">Zoom in to this location</option>
            <option value="out">Zoom out from this location</option>
          </select>
        </div>
        <div class="input-wrapper">
          <label for="animateWidth">Width (px)</label>
          <input
            type="number"
            required
            id="animateWidth"
            name="animateWidth"
            min="16"
            max="3840"
            ref={widthRef}
          />
        </div>
        <div class="input-wrapper">
          <label for="animateHeight">Height (px)</label>
          <input
            type="number"
            required
            id="animateHeight"
            name="animateHeight"
            min="16"
            max="2160"
            ref={heightRef}
          />
        </div>
        <div class="input-wrapper">
          <label for="animateDuration">Duration (seconds)</label>
          <input
            type="number"
            required
            id="animateDuration"
            name="animateDuration"
            min="1"
            max="60"
            step="0.5"
            ref={durationRef}
          />
        </div>
        <div class="input-wrapper">
          <label for="animateFps">Frame rate (fps)</label>
          <input
            type="number"
            required
            id="animateFps"
            name="animateFps"
            min="1"
            max="60"
            ref={fpsRef}
          />
        </div>
        <p class="secondary" id="animateHint">
          Higher resolutions, longer durations, and deep zooms take much longer
          to render.
        </p>
        <SubmitOrCancel
          submitId="animateZoomSubmit"
          cancelId="animateZoomCancel"
          idleLabel="Generate"
          busyLabel={busyLabel}
          busy={busy}
          cancelEnabledWhileBusy
          onCancel={onCancel}
        />
      </form>
    </Modal>
  );
}

/** Confirms a power change before applying it: the power picks a different
 * fractal, so the change discards the current position. Cancel-button
 * clicks and dismissals (Escape, backdrop) both count as declining; the
 * pending request signal resolves to null either way, which also restores
 * the power input to the config's still-current value. */
export function ChangePowerModal(): JSX.Element {
  const { map, ui } = useApp();
  const request = ui.changePowerRequest.value;

  const resolve = (confirmed: boolean) => {
    const pending = ui.changePowerRequest.peek();
    // Clear the request before applying so the dialog's own close (and any
    // "cancel" event it fires) can't re-trigger the outcome.
    ui.changePowerRequest.value = null;
    if (confirmed && pending) {
      applyNumberSetting(map, pending.spec, pending.value);
    }
  };

  return (
    <Modal
      id="changePowerModal"
      open={request !== null}
      onCancel={() => resolve(false)}
    >
      <form
        id="changePowerForm"
        onSubmit={(event) => {
          event.preventDefault();
          resolve(true);
        }}
      >
        <strong>Change power?</strong>
        <p>
          Changing the power renders a different fractal and resets the view to
          its starting position.
        </p>
        <div class="submit-or-cancel">
          <button type="submit" id="changePowerSubmit">
            Change
          </button>
          <button
            type="button"
            id="changePowerCancel"
            class="underline-button"
            onClick={() => resolve(false)}
          >
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
