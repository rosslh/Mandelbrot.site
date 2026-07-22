import debounce from "lodash/debounce";
import throttle from "lodash/throttle";
import snakeCase from "lodash/snakeCase";
import type MandelbrotMap from "./MandelbrotMap";
import {
  CheckboxSpec,
  CoordinateSpec,
  MagnificationSpec,
  MandelbrotConfig,
  NumberSpec,
  SelectNumberSpec,
  SelectSpec,
  SettingSpec,
  SliderSpec,
  isFixedPaletteMethod,
  settingsSchema,
  syncAllInputsToConfig,
  syncInputToConfig,
} from "./config";
import FormModal from "./FormModal";
import ConfirmModal from "./ConfirmModal";
import {
  AnimationCancelledError,
  AnimationProgress,
  canRecordAnimation,
} from "./ZoomAnimator";
import type { AnimationKind, AnimationSpec } from "./animationFrames";
import PinnedLocations from "./PinnedLocations";
import PaletteHistogram from "./PaletteHistogram";
import { isValidDecimalCoordinate } from "./highPrecision";
import { zoomFromMagnification } from "./magnification";
import { describeZoomScale } from "./zoomScale";
import { tierLegendEntries } from "./tierOverlay";
import * as api from "./api";

type ResetButtonConfig = {
  buttonId: string;
  configKeys: Array<keyof MandelbrotConfig>;
  specialHandling?: () => void;
  checkDiff?: () => boolean;
  // Applies the reset visually. Defaults to a full re-render; sections whose
  // settings only affect coloring repaint the tiles in place instead.
  // Receives the keys that actually differed before the reset.
  apply?: (changedKeys: Array<keyof MandelbrotConfig>) => void;
};

const DETAILS_STATE_STORAGE_KEY = "mandelbrot-details-state";
const OPTIMIZE_IMAGE_STORAGE_KEY = "mandelbrot-optimize-image";
const SMALL_SCREEN_WIDTH_PX = 800;

class MandelbrotControls {
  map: MandelbrotMap;
  resetButtonConfigs: ResetButtonConfig[];
  private changePowerModal: ConfirmModal;
  private pinnedLocations: PinnedLocations;
  private paletteHistogram: PaletteHistogram;

  constructor(map: MandelbrotMap) {
    this.map = map;

    this.changePowerModal = new ConfirmModal({
      dialogId: "changePowerModal",
      formId: "changePowerForm",
      cancelId: "changePowerCancel",
    });

    this.pinnedLocations = new PinnedLocations();

    this.resetButtonConfigs = [
      {
        buttonId: "resetRender",
        configKeys: [
          "maxIterations",
          "power",
          "supersampling",
          "showTierOverlay",
        ],
        specialHandling: () => {
          this.resetPaletteCeilingToMaxIterations(
            this.map.config.maxIterations,
          );
        },
        apply: (changedKeys) => {
          // The reset may have flipped the overlay flag; keep its legend in
          // step either way.
          this.syncTierLegend();
          // The tier overlay is cosmetic, so a reset that only toggles it off
          // repaints in place; anything else re-renders.
          const needsRerender = changedKeys.some(
            (key) => key !== "showTierOverlay",
          );
          if (needsRerender) {
            this.map.refresh();
          } else {
            this.map.applyTierOverlayToggle();
          }
        },
      },
      {
        buttonId: "resetColorPalette",
        configKeys: [
          "palette",
          "colorDensity",
          "paletteOffset",
          "reverseColors",
        ],
        // All color-only settings: repaint in place, no re-render.
        apply: () => this.map.applyColorSettings(),
      },
      {
        buttonId: "resetColorMapping",
        configKeys: [
          "coloringMethod",
          "smoothColoring",
          "paletteMinIter",
          "paletteAutoFit",
          "histogramColoring",
        ],
        specialHandling: () => {
          // Reset paletteMaxIter based on the current iteration cap
          this.map.config.paletteMaxIter = this.map.config.maxIterations;
          syncInputToConfig(this.map.config, "paletteMaxIter");
        },
        apply: (changedKeys) => {
          // The coloring method and smooth coloring are baked into the
          // cached escape values, so resetting either needs a full re-render
          // (which re-fits the range once the tiles load). A method reset
          // can also have turned off a fixed-palette method, re-enabling the
          // range controls.
          if (changedKeys.includes("coloringMethod")) {
            this.syncColorMappingAvailability();
          }
          if (
            changedKeys.includes("coloringMethod") ||
            changedKeys.includes("smoothColoring")
          ) {
            this.map.refresh();
            return;
          }
          // The remaining keys only affect coloring: fit (auto) or apply the
          // reset values (manual) via an in-place repaint. The fit also
          // rebuilds the equalization CDF, so a restored mapping strength
          // takes effect.
          this.map.refitPaletteAndRecolor();
        },
        checkDiff: () => {
          if (
            this.map.config.coloringMethod !==
              this.map.initialConfig.coloringMethod ||
            this.map.config.smoothColoring !==
              this.map.initialConfig.smoothColoring ||
            this.map.config.paletteAutoFit !==
              this.map.initialConfig.paletteAutoFit ||
            this.map.config.histogramColoring !==
              this.map.initialConfig.histogramColoring
          ) {
            return true;
          }
          if (this.map.config.paletteAutoFit) {
            // Auto-applied values are machine-set, not user divergence.
            return false;
          }
          return (
            this.map.config.paletteMinIter !==
              this.map.initialConfig.paletteMinIter ||
            this.map.config.paletteMaxIter !== this.map.config.maxIterations
          );
        },
      },
      {
        buttonId: "resetAdjustColors",
        configKeys: [
          "colorSpace",
          "shiftHueAmount",
          "saturateAmount",
          "lightenAmount",
        ],
        // All color-only settings: repaint in place, no re-render.
        apply: () => this.map.applyColorSettings(),
      },
      {
        buttonId: "resetLocation",
        configKeys: ["re", "im", "zoom"],
        apply: () => {
          this.map.refresh(true);
          this.setCoordinateInputValues();
        },
        checkDiff: () => {
          return (
            this.map.config.re !== this.map.initialConfig.re ||
            this.map.config.im !== this.map.initialConfig.im ||
            this.map.config.zoom !== this.map.initialConfig.zoom
          );
        },
      },
    ];

    // The precision-tier overlay is a rendering diagnostic; only expose its
    // control in dev builds. The config default is off and the setting has
    // no share-URL parameter, so hiding the checkbox removes the feature.
    if (process.env.NODE_ENV === "production") {
      const tierOverlayWrapper = document
        .getElementById("showTierOverlay")
        ?.closest(".checkbox-wrapper") as HTMLElement | null;
      if (tierOverlayWrapper) {
        tierOverlayWrapper.hidden = true;
      }
    }

    this.setUpSupersamplingOptions();
    // The config may already carry share-URL values (applied before the
    // controls exist); this writes every setting into its input once.
    syncAllInputsToConfig(this.map.config);
    this.handleInputs();
    this.syncColorMappingAvailability();
    this.syncTierLegend();
    this.updateResetButtonsVisibility();
    this.loadDetailsState();
    this.paletteHistogram = new PaletteHistogram(this.map);

    window.addEventListener(
      "resize",
      throttle(() => {
        this.handleSmallScreenExpansion();
      }, 250),
    );
  }

  throttleSetCoordinateInputValues = throttle(() => {
    this.setCoordinateInputValues();
    this.updateResetButtonsVisibility();
  }, 200);

  private handleInputs() {
    this.handleShortcutHints();
    this.wireSettingInputs();
    this.setupButtons();
    this.setupDetailsToggle();
  }

  /** The supersampling select's "native" option resolves to the display's
   * devicePixelRatio, only known at runtime: show that effective multiplier
   * in its label. On a 1x display native would just repeat "Fast", so the
   * option is dropped instead. The numeric options are multiples of native,
   * so the factors are already monotonic in markup order — no sorting
   * needed. */
  private setUpSupersamplingOptions() {
    const select = document.getElementById(
      "supersampling",
    ) as HTMLSelectElement | null;
    const nativeOption = select?.querySelector('option[value="native"]');
    if (!(nativeOption instanceof HTMLOptionElement)) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    if (dpr === 1) {
      nativeOption.remove();
      return;
    }
    nativeOption.textContent = `Native (${Number(dpr.toFixed(2))}×)`;
  }

  /** Wires every schema-declared setting to its sidebar input. */
  private wireSettingInputs() {
    for (const spec of settingsSchema) {
      switch (spec.control) {
        case "number":
          this.wireNumberInput(spec);
          break;
        case "coordinate":
          this.wireCoordinateInput(spec);
          break;
        case "magnification":
          this.wireMagnificationInput(spec);
          break;
        case "select":
        case "selectNumber":
          this.wireSelectInput(spec);
          break;
        case "checkbox":
          this.wireCheckboxInput(spec);
          break;
        case "slider":
          this.wireSliderInput(spec);
          break;
      }
    }
  }

  /** Routes a settings change to the cheapest way of making it visible:
   * color-only settings repaint the cached tiles in place, anything baked
   * into the escape values re-renders. */
  private applySettingEffect(spec: SettingSpec) {
    if (spec.effect === "recolor") {
      this.map.applyColorSettings();
    } else if (spec.effect === "rerender") {
      const resetView = spec.control === "number" && Boolean(spec.resetView);
      this.map.refresh(resetView);
    }
  }

  private setupDetailsToggle() {
    this.getControlPanelDetails().forEach((details) => {
      details.addEventListener("toggle", () => {
        this.saveDetailsState();
      });
    });
  }

  private handleSmallScreenExpansion() {
    const renderSettings = document.getElementById(
      "renderSettings",
    ) as HTMLDetailsElement;
    if (renderSettings && window.innerWidth <= SMALL_SCREEN_WIDTH_PX) {
      renderSettings.open = true;
    }
  }

  private getControlPanelDetails(): HTMLDetailsElement[] {
    return Array.from(document.querySelectorAll("#inputsWrapper details")).map(
      (element) => element as HTMLDetailsElement,
    );
  }

  private saveDetailsState() {
    if (!window.localStorage) return;

    const state: Record<string, boolean> = {};
    this.getControlPanelDetails().forEach((details) => {
      if (details.id) {
        state[details.id] = details.open;
      }
    });

    localStorage.setItem(DETAILS_STATE_STORAGE_KEY, JSON.stringify(state));
  }

  private loadDetailsState() {
    if (!window.localStorage) return;

    try {
      const savedState = localStorage.getItem(DETAILS_STATE_STORAGE_KEY);
      if (savedState) {
        const state = JSON.parse(savedState) as Record<string, boolean>;

        this.getControlPanelDetails().forEach((details) => {
          if (details.id && state[details.id] !== undefined) {
            details.open = state[details.id];
          }
        });
      }
    } catch (e) {
      console.error("Error loading details state from localStorage", e);
    }

    this.handleSmallScreenExpansion();
  }

  private setupButtons() {
    this.handleIterationButtons();
    this.handleFullScreen();
    this.handleHideShowUiButton();
    this.handleShareButton();
    this.handleSaveImageButton();
    this.handleAnimateButton();
    this.handleResetButtons();
  }

  private wireNumberInput(spec: NumberSpec) {
    const input = document.getElementById(spec.key) as HTMLInputElement;
    input.oninput = debounce(() => {
      let parsedValue = spec.allowFraction
        ? Number.parseFloat(input.value)
        : Number.parseInt(input.value, 10);
      if (
        isNaN(parsedValue) ||
        parsedValue < spec.min ||
        parsedValue > spec.max
      ) {
        parsedValue = this.map.config[spec.key];
      }

      // Settings that reset the view (the power) discard the current
      // position, so confirm the change before applying it; a cancel restores
      // the input to the value still held in the config.
      if (spec.resetView && parsedValue !== this.map.config[spec.key]) {
        const previousValue = this.map.config[spec.key];
        this.changePowerModal.open(
          () => this.applyNumberInput(spec, input, parsedValue),
          () => {
            input.value = String(previousValue);
          },
        );
        return;
      }

      this.applyNumberInput(spec, input, parsedValue);
    }, 1000);
  }

  /** Commits a validated number input to the config and applies its effect. */
  private applyNumberInput(
    spec: NumberSpec,
    input: HTMLInputElement,
    parsedValue: number,
  ) {
    if (spec.key === "maxIterations") {
      this.resetPaletteCeilingToMaxIterations(parsedValue);
    }

    input.value = String(parsedValue);
    this.map.config[spec.key] = parsedValue;
    if (spec.resetView) {
      // Changing the power picks a different fractal; iteration tuning
      // for the old one doesn't carry over.
      this.map.config.maxIterations = this.map.initialConfig.maxIterations;
      syncInputToConfig(this.map.config, "maxIterations");
    }

    this.updateResetButtonsVisibility();
    this.applySettingEffect(spec);

    // An iteration-cap change resets the palette ceiling, which moves the
    // histogram markers.
    if (spec.key === "maxIterations") {
      this.refreshPaletteHistogram();
    }
  }

  private wireCoordinateInput(spec: CoordinateSpec) {
    const input = document.getElementById(spec.key) as HTMLInputElement;
    input.oninput = debounce(() => {
      const rawValue = input.value.trim();
      // Coordinates are kept as decimal strings so deep-zoom precision
      // survives; only their approximate magnitude is range checked.
      const approximateValue = Number.parseFloat(rawValue);
      const isValid =
        isValidDecimalCoordinate(rawValue) &&
        approximateValue >= spec.min &&
        approximateValue <= spec.max;

      const newValue = isValid ? rawValue : this.map.config[spec.key];

      input.value = newValue;
      this.map.config[spec.key] = newValue;

      this.updateResetButtonsVisibility();
      this.map.refresh();
    }, 1000);
  }

  private wireMagnificationInput(spec: MagnificationSpec) {
    const input = document.getElementById(spec.key) as HTMLInputElement;
    input.oninput = debounce(() => {
      // The input holds a magnification factor; the config stores the
      // effective zoom level it snaps to (spec.min/max bound the zoom).
      const zoom = zoomFromMagnification(input.value);
      const isValid = zoom !== null && zoom >= spec.min && zoom <= spec.max;
      // Entered magnifications snap to a zoom level, so an edit can resolve
      // to the current view; re-rendering would be a no-op then.
      const changed = isValid && zoom !== this.map.config.zoom;

      if (changed) {
        this.map.config.zoom = zoom;
      }
      // Redisplay the magnification of the zoom level actually applied.
      syncInputToConfig(this.map.config, spec.key);

      this.updateResetButtonsVisibility();
      if (changed) {
        this.applySettingEffect(spec);
      }
    }, 1000);
  }

  private wireSelectInput(spec: SelectSpec | SelectNumberSpec) {
    const select = document.getElementById(spec.key) as HTMLSelectElement;
    select.onchange = () => {
      if (spec.control === "select") {
        this.map.config[spec.key] = select.value;
      } else {
        this.map.config[spec.key] = Number(select.value);
      }
      this.updateResetButtonsVisibility();
      // The fixed-palette methods suspend the Color mapping panel's range
      // controls (they ignore its bounds), so a method change updates their
      // availability.
      if (spec.key === "coloringMethod") {
        this.syncColorMappingAvailability();
        this.refreshPaletteHistogram();
      }
      this.applySettingEffect(spec);
    };
  }

  private wireCheckboxInput(spec: CheckboxSpec) {
    const checkbox = document.getElementById(spec.key) as HTMLInputElement;
    checkbox.onchange = () => {
      this.map.config[spec.key] = checkbox.checked;
      this.updateResetButtonsVisibility();
      if (spec.key === "paletteAutoFit") {
        // Disabling keeps the current values (edited by dragging the
        // histogram markers); enabling fits to the visible tiles via an
        // in-place recolor, no re-render.
        if (this.map.config.paletteAutoFit) {
          this.map.refitPaletteAndRecolor();
        }
        this.refreshPaletteHistogram();
        return;
      }
      if (spec.key === "showTierOverlay") {
        // Cosmetic overlay on already-rendered tiles: draw or clear it on the
        // on-screen tiles instead of re-rendering (effect "none").
        this.syncTierLegend();
        this.map.applyTierOverlayToggle();
        return;
      }
      this.applySettingEffect(spec);
    };
  }

  private wireSliderInput(spec: SliderSpec) {
    const slider = document.getElementById(spec.key) as HTMLInputElement;
    slider.oninput = debounce(() => {
      this.map.config[spec.key] = Number.parseFloat(slider.value);
      this.updateResetButtonsVisibility();
      // The color-mapping strength reshapes the equalization table, which
      // needs a CDF rebuild before the repaint — not a plain recolor (the
      // setting's effect is "none").
      if (spec.key === "histogramColoring") {
        this.map.applyPaletteWindowChange();
        return;
      }
      this.applySettingEffect(spec);
    }, 300);
  }

  /** In auto mode, changing the iteration cap resets the palette upper bound
   * to the new cap as a provisional range (the lower bound is kept, clamped
   * under the new ceiling): re-rendering with the old fit would clamp
   * everything above it into a maxed-out band around the set until the
   * re-fit, so the stale detection is dropped and the proper range is fitted
   * once all tiles finish rendering. A user-set range is untouched. */
  private resetPaletteCeilingToMaxIterations(newIterations: number) {
    if (!this.map.config.paletteAutoFit) {
      return;
    }

    // Invalidating (not just clearing) also keeps old-cap tiles that are
    // still rendering from repopulating the cache before the debounced
    // refresh runs, which would overwrite this provisional ceiling with a
    // fit to the previous iteration cap.
    this.map.invalidateTileCache();

    this.map.config.paletteMaxIter = newIterations;
    this.map.config.paletteMinIter = Math.min(
      this.map.config.paletteMinIter,
      newIterations,
    );

    syncInputToConfig(this.map.config, "paletteMaxIter");
    syncInputToConfig(this.map.config, "paletteMinIter");
  }

  private handleIterationButtons() {
    const multiplyButton = document.getElementById(
      "maxIterationsMul2",
    ) as HTMLButtonElement;
    const divideButton = document.getElementById(
      "maxIterationsDiv2",
    ) as HTMLButtonElement;

    const debouncedRefresh = debounce(() => {
      this.updateResetButtonsVisibility();
      this.map.refresh();
    }, 500);

    multiplyButton.onclick = () => {
      this.map.config.maxIterations *= 2;
      this.resetPaletteCeilingToMaxIterations(this.map.config.maxIterations);
      syncInputToConfig(this.map.config, "maxIterations");

      debouncedRefresh();
    };

    divideButton.onclick = () => {
      this.map.config.maxIterations = Math.ceil(
        this.map.config.maxIterations / 2,
      );
      this.resetPaletteCeilingToMaxIterations(this.map.config.maxIterations);
      syncInputToConfig(this.map.config, "maxIterations");

      debouncedRefresh();
    };
  }

  /** Called after the palette bounds are set from outside the sidebar inputs
   * (e.g. dragging the histogram markers) so the reset button reflects the
   * divergence from the initial config. */
  notifyPaletteBoundsChanged() {
    this.updateResetButtonsVisibility();
  }

  /** Redraws the palette-range histogram — its bound markers track the config,
   * so any palette min/max change (a manual edit, a refit) must repaint it. */
  refreshPaletteHistogram() {
    this.paletteHistogram?.update();
  }

  /** Builds the precision-tier legend (once) and shows it only while the tier
   * overlay is enabled, so the tinted borders/badges on the tiles have a key.
   * Idempotent: rebuilds nothing once the entries exist. */
  syncTierLegend() {
    const legend = document.getElementById("tierLegend");
    if (!legend) {
      return;
    }

    if (legend.childElementCount === 0) {
      for (const { label, color } of tierLegendEntries()) {
        const item = document.createElement("li");
        const swatch = document.createElement("span");
        swatch.className = "tier-legend-swatch";
        swatch.style.backgroundColor = color;
        const text = document.createElement("span");
        text.textContent = label;
        item.append(swatch, text);
        legend.append(item);
      }
    }

    legend.hidden = !this.map.config.showTierOverlay;
  }

  /** The palette range only applies to escape-time coloring; the fixed-range
   * methods (distance estimate, atom domains) ignore it, so hide the panel's
   * color-mapping slider and auto-fit checkbox while one is active (the
   * histogram itself blanks out; see PaletteHistogram). The coloring-method
   * select stays enabled so the user can switch back. */
  syncColorMappingAvailability() {
    const hidden = isFixedPaletteMethod(this.map.config);
    const autoFitWrapper = document
      .getElementById("paletteAutoFit")
      ?.closest(".checkbox-wrapper") as HTMLElement | null;
    if (autoFitWrapper) {
      autoFitWrapper.hidden = hidden;
    }
    const mappingWrapper = document
      .getElementById("histogramColoring")
      ?.closest(".input-wrapper") as HTMLElement | null;
    if (mappingWrapper) {
      mappingWrapper.hidden = hidden;
    }
  }

  private async logEvent(eventName: "imageSave" | "share") {
    await api.client?.from("events").insert([
      {
        event_name: snakeCase(eventName),
        share_url: this.map.getShareUrl(),
        re: String(this.map.config.re),
        im: String(this.map.config.im),
        zoom: this.map.config.zoom,
        iterations: this.map.config.maxIterations,
        session_id: api.sessionId,
      },
    ]);
  }

  private handleSaveImageButton() {
    const saveImageButton = document.getElementById(
      "saveImage",
    ) as HTMLButtonElement;

    if (typeof Blob === "undefined") {
      saveImageButton.style.display = "none";
      return;
    }

    const widthInput = document.getElementById(
      "imageWidth",
    ) as HTMLInputElement;
    const heightInput = document.getElementById(
      "imageHeight",
    ) as HTMLInputElement;
    const optimizeImageCheckbox = document.getElementById(
      "optimizeImage",
    ) as HTMLInputElement;
    const exportRawDataCheckbox = document.getElementById(
      "exportRawData",
    ) as HTMLInputElement;

    const savedOptimizeState = localStorage.getItem(OPTIMIZE_IMAGE_STORAGE_KEY);
    if (savedOptimizeState !== null) {
      optimizeImageCheckbox.checked = JSON.parse(savedOptimizeState);
    }

    optimizeImageCheckbox.onchange = () => {
      localStorage.setItem(
        OPTIMIZE_IMAGE_STORAGE_KEY,
        JSON.stringify(optimizeImageCheckbox.checked),
      );
    };

    const modal = new FormModal(
      {
        dialogId: "saveImageModal",
        formId: "saveImageForm",
        submitId: "saveImageSubmit",
        cancelId: "saveImageCancel",
      },
      {
        onOpen: () => {
          // Reset the form but keep the persisted optimize preference.
          const currentOptimizeState = optimizeImageCheckbox.checked;
          modal.form.reset();
          optimizeImageCheckbox.checked = currentOptimizeState;
          widthInput.value = String(
            Math.ceil(window.screen.width * 2 * (window.devicePixelRatio || 1)),
          );
          heightInput.value = String(
            Math.ceil(
              window.screen.height * 2 * (window.devicePixelRatio || 1),
            ),
          );
        },
        onSubmit: () => {
          const width = Number(widthInput.value);
          const height = Number(heightInput.value);

          if (!width || Number.isNaN(width) || width <= 0) {
            return;
          }
          if (!height || Number.isNaN(height) || height <= 0) {
            return;
          }

          this.logEvent("imageSave");

          modal.beginBusy("Generating...");
          const shouldOptimize = optimizeImageCheckbox.checked;
          const shouldExportRawData = exportRawDataCheckbox.checked;

          this.map.imageSaver
            .saveVisibleImage(
              width,
              height,
              shouldOptimize,
              shouldOptimize
                ? () => modal.setBusyLabel("Optimizing...")
                : undefined,
            )
            .then(() => {
              if (!shouldExportRawData) {
                return;
              }
              modal.setBusyLabel("Exporting data...");
              return this.map.imageSaver.saveVisibleData(width, height);
            })
            .catch((error: unknown) => {
              alert("Error saving image\n\n" + error);
              console.error(error);
            })
            .finally(() => {
              modal.finishBusy();
            });
        },
      },
    );

    saveImageButton.onclick = (e) => {
      e.stopPropagation();
      modal.toggle();
    };
  }

  /** Wires the zoom-animation button and modal (issue #13). The current view
   * is the animation's target; the user picks the direction (zoom in to / out
   * of it), resolution, duration, and frame rate. Generation runs on the
   * shared worker pool with per-frame progress on the submit button and
   * mid-run cancellation via the (kept-live) cancel button. */
  private handleAnimateButton() {
    const animateButton = document.getElementById(
      "animateZoom",
    ) as HTMLButtonElement | null;
    if (!animateButton) {
      return;
    }

    // Hide the feature entirely on browsers that can't record video from a
    // canvas (no MediaRecorder / captureStream / supported codec).
    if (!canRecordAnimation()) {
      animateButton.style.display = "none";
      return;
    }

    const kindInput = document.getElementById(
      "animateKind",
    ) as HTMLSelectElement;
    const widthInput = document.getElementById(
      "animateWidth",
    ) as HTMLInputElement;
    const heightInput = document.getElementById(
      "animateHeight",
    ) as HTMLInputElement;
    const durationInput = document.getElementById(
      "animateDuration",
    ) as HTMLInputElement;
    const fpsInput = document.getElementById("animateFps") as HTMLInputElement;

    const modal = new FormModal(
      {
        dialogId: "animateZoomModal",
        formId: "animateZoomForm",
        submitId: "animateZoomSubmit",
        cancelId: "animateZoomCancel",
      },
      {
        onOpen: () => {
          modal.form.reset();
          // Default to a modest 720p-ish preset: large enough to look good,
          // small enough to render in reasonable time.
          kindInput.value = "in";
          widthInput.value = "1280";
          heightInput.value = "720";
          durationInput.value = "8";
          fpsInput.value = "30";
        },
        onCancelBusy: () => {
          modal.setBusyLabel("Cancelling...");
          this.map.zoomAnimator.cancel();
        },
        onSubmit: () => {
          const spec = this.readAnimationSpec(
            kindInput,
            widthInput,
            heightInput,
            durationInput,
            fpsInput,
          );
          if (!spec) {
            return;
          }

          modal.beginBusy("Preparing...");
          this.map.zoomAnimator
            .generate(spec, (progress: AnimationProgress) => {
              modal.setBusyLabel(this.animationProgressLabel(progress));
            })
            .catch((error: unknown) => {
              if (error instanceof AnimationCancelledError) {
                return;
              }
              alert("Error generating animation\n\n" + error);
              console.error(error);
            })
            .finally(() => {
              modal.finishBusy();
            });
        },
      },
    );

    animateButton.onclick = (e) => {
      e.stopPropagation();
      modal.toggle();
    };
  }

  /** Validates the animation modal's inputs into an `AnimationSpec`, or null
   * when any value is missing or out of range. */
  private readAnimationSpec(
    kindInput: HTMLSelectElement,
    widthInput: HTMLInputElement,
    heightInput: HTMLInputElement,
    durationInput: HTMLInputElement,
    fpsInput: HTMLInputElement,
  ): AnimationSpec | null {
    const width = Number(widthInput.value);
    const height = Number(heightInput.value);
    const durationSeconds = Number(durationInput.value);
    const fps = Number(fpsInput.value);
    const kind = kindInput.value as AnimationKind;

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

  private animationProgressLabel(progress: AnimationProgress): string {
    const percent = Math.round(progress.fraction * 100);
    if (progress.phase === "rendering") {
      return `Rendering ${progress.frame}/${progress.totalFrames} (${percent}%)`;
    }
    return `Encoding (${percent}%)`;
  }

  private handleHideShowUiButton() {
    const hideControlsButton = document.getElementById("hideControls");
    hideControlsButton.onclick = () => {
      document.body.classList.add("hide-overlays");
    };

    const showControlsButton = document.getElementById("showControls");
    showControlsButton.onclick = () => {
      document.body.classList.remove("hide-overlays");
    };
  }

  private handleShareButton() {
    const shareButton = document.getElementById(
      "shareButton",
    ) as HTMLButtonElement;

    shareButton.onclick = () => {
      const shareUrl = this.map.getShareUrl();
      // Pin the current view to the sidebar (persisted to localStorage) so it
      // can be revisited later, and keep copying the link to the clipboard.
      this.pinnedLocations.add(shareUrl);
      navigator.clipboard.writeText(shareUrl).then(() => {
        alert("The URL for this view has been copied and pinned!");
      });
      this.logEvent("share");
    };
  }

  private handleFullScreen() {
    const toggleFullScreen = () => {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        document.body.requestFullscreen();
      }
    };

    const fullScreenButton = document.getElementById("fullScreen");
    const exitFullScreenButton = document.getElementById("exitFullScreen");
    fullScreenButton.onclick = toggleFullScreen;
    exitFullScreenButton.onclick = toggleFullScreen;

    document.addEventListener("fullscreenchange", () => {
      const fullScreenButton = document.getElementById("fullScreen");
      const exitFullScreenButton = document.getElementById("exitFullScreen");
      if (document.fullscreenElement) {
        fullScreenButton.style.display = "none";
        exitFullScreenButton.style.display = "inline-block";
      } else {
        fullScreenButton.style.display = "inline-block";
        exitFullScreenButton.style.display = "none";
      }
    });
  }

  private handleShortcutHints() {
    const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
    if (!isMac) {
      return;
    }

    document
      .querySelectorAll<HTMLElement>(".windows-shortcut")
      .forEach((hint) => (hint.style.display = "none"));
    document
      .querySelectorAll<HTMLElement>(".mac-shortcut")
      .forEach((hint) => (hint.style.display = "inline-block"));
  }

  private setCoordinateInputValues() {
    const { re: currentRe, im: currentIm } =
      this.map.currentCenterCoordinates();
    const currentZoom = this.map.effectiveZoom;

    let finalRe = currentRe;
    let finalIm = currentIm;
    let finalZoom = currentZoom;

    // Snap to the initial view when close to it, so the reset button hides.
    // Only meaningful at shallow zooms, where f64 comparison is exact enough.
    if (this.map.zoomOffset === 0) {
      const tolerance = 0.02;
      const reDiff = Math.abs(
        Number.parseFloat(currentRe) -
          Number.parseFloat(this.map.initialConfig.re),
      );
      const imDiff = Math.abs(
        Number.parseFloat(currentIm) -
          Number.parseFloat(this.map.initialConfig.im),
      );
      const zoomDiff = Math.abs(currentZoom - this.map.initialConfig.zoom);

      if (reDiff <= tolerance && imDiff <= tolerance && zoomDiff <= tolerance) {
        finalRe = this.map.initialConfig.re;
        finalIm = this.map.initialConfig.im;
        finalZoom = this.map.initialConfig.zoom;
      }
    }

    this.map.config.re = finalRe;
    this.map.config.im = finalIm;
    this.map.config.zoom = finalZoom;
    syncInputToConfig(this.map.config, "re");
    syncInputToConfig(this.map.config, "im");
    syncInputToConfig(this.map.config, "zoom");

    const caption = document.getElementById("zoomScaleCaption");
    if (caption) {
      const description = describeZoomScale(finalZoom);
      caption.hidden = description === null;
      caption.textContent = description ?? "";
    }
  }

  private resetConfigValues(keys: Array<keyof MandelbrotConfig>) {
    keys.forEach((key) => {
      const initialValue = this.map.initialConfig[key];
      // TypeScript cannot infer that initialValue matches the type of config[key] in this dynamic assignment pattern
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.map.config as any)[key] = initialValue;
      syncInputToConfig(this.map.config, key);
    });
  }

  private handleResetButtons() {
    this.resetButtonConfigs.forEach((config) => {
      const button = document.getElementById(config.buttonId);
      if (button) {
        button.onclick = () => {
          const changedKeys = config.configKeys.filter(
            (key) => this.map.config[key] !== this.map.initialConfig[key],
          );

          this.resetConfigValues(config.configKeys);

          if (config.specialHandling) {
            config.specialHandling();
          }

          this.updateResetButtonsVisibility();

          if (config.apply) {
            config.apply(changedKeys);
          } else {
            this.map.refresh();
          }
        };
      }
    });
  }

  private updateResetButtonsVisibility() {
    this.resetButtonConfigs.forEach((config) => {
      let shouldShow: boolean;

      if (config.checkDiff) {
        shouldShow = config.checkDiff();
      } else {
        shouldShow = config.configKeys.some(
          (key) => this.map.config[key] !== this.map.initialConfig[key],
        );
      }

      this.toggleResetButtonVisibility(config.buttonId, shouldShow);
    });
  }

  private toggleResetButtonVisibility(buttonId: string, shouldShow: boolean) {
    const button = document.getElementById(buttonId) as HTMLButtonElement;
    if (button) {
      if (shouldShow) {
        button.classList.add("visible");
      } else {
        button.classList.remove("visible");
      }
    }
  }
}

export default MandelbrotControls;
