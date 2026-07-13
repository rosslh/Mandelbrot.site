import debounce from "lodash/debounce";
import throttle from "lodash/throttle";
import snakeCase from "lodash/snakeCase";
import type MandelbrotMap from "./MandelbrotMap";
import {
  CheckboxSpec,
  CoordinateSpec,
  MandelbrotConfig,
  NumberSpec,
  SelectNumberSpec,
  SelectSpec,
  SettingSpec,
  SliderSpec,
  settingsSchema,
  syncAllInputsToConfig,
  syncInputToConfig,
} from "./config";
import FormModal from "./FormModal";
import { isValidDecimalCoordinate } from "./highPrecision";
import { describeZoomScale } from "./zoomScale";
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

  constructor(map: MandelbrotMap) {
    this.map = map;

    this.resetButtonConfigs = [
      {
        buttonId: "resetRender",
        configKeys: ["iterations", "exponent", "highDpiTiles"],
        specialHandling: () => {
          this.resetPaletteCeilingToIterations(this.map.config.iterations);
        },
      },
      {
        buttonId: "resetColorScheme",
        configKeys: [
          "colorScheme",
          "colorCycles",
          "reverseColors",
          "smoothColoring",
        ],
        apply: (changedKeys) => {
          // Smooth coloring is baked into the cached escape values, so
          // resetting it needs a re-render; the other keys only recolor.
          if (changedKeys.includes("smoothColoring")) {
            this.map.refresh();
          } else {
            this.map.applyColorSettings();
          }
        },
      },
      {
        buttonId: "resetPaletteRange",
        configKeys: ["paletteMinIter", "paletteAutoAdjust"],
        specialHandling: () => {
          // Reset paletteMaxIter based on current iterations
          this.map.config.paletteMaxIter = this.map.config.iterations;
          syncInputToConfig(this.map.config, "paletteMaxIter");
          this.syncAutoAdjustUi();
        },
        // The range only affects coloring: fit (auto) or apply the reset
        // values (manual) via an in-place repaint.
        apply: () => this.map.refitPaletteAndRecolor(),
        checkDiff: () => {
          if (
            this.map.config.paletteAutoAdjust !==
            this.map.initialConfig.paletteAutoAdjust
          ) {
            return true;
          }
          if (this.map.config.paletteAutoAdjust) {
            // Auto-applied values are machine-set, not user divergence.
            return false;
          }
          return (
            this.map.config.paletteMinIter !==
              this.map.initialConfig.paletteMinIter ||
            this.map.config.paletteMaxIter !== this.map.config.iterations
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
        buttonId: "resetCoordinates",
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

    // The config may already carry share-URL values (applied before the
    // controls exist); this writes every setting into its input once.
    syncAllInputsToConfig(this.map.config);
    this.handleInputs();
    this.syncAutoAdjustUi();
    this.updateResetButtonsVisibility();
    this.loadDetailsState();

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

      // The palette bounds must stay ordered; an inversion reverts to the
      // previous value.
      if (
        spec.key === "paletteMinIter" &&
        parsedValue > this.map.config.paletteMaxIter
      ) {
        parsedValue = this.map.config[spec.key];
      } else if (
        spec.key === "paletteMaxIter" &&
        parsedValue < this.map.config.paletteMinIter
      ) {
        parsedValue = this.map.config[spec.key];
      }

      if (spec.key === "iterations") {
        this.resetPaletteCeilingToIterations(parsedValue);
      }

      input.value = String(parsedValue);
      this.map.config[spec.key] = parsedValue;
      if (spec.resetView) {
        // Changing the exponent picks a different fractal; iteration tuning
        // for the old one doesn't carry over.
        this.map.config.iterations = this.map.initialConfig.iterations;
        syncInputToConfig(this.map.config, "iterations");
      }

      this.updateResetButtonsVisibility();
      this.applySettingEffect(spec);
    }, 1000);
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

  private wireSelectInput(spec: SelectSpec | SelectNumberSpec) {
    const select = document.getElementById(spec.key) as HTMLSelectElement;
    select.onchange = () => {
      if (spec.control === "select") {
        this.map.config[spec.key] = select.value;
      } else {
        this.map.config[spec.key] = Number(select.value);
      }
      this.updateResetButtonsVisibility();
      this.applySettingEffect(spec);
    };
  }

  private wireCheckboxInput(spec: CheckboxSpec) {
    const checkbox = document.getElementById(spec.key) as HTMLInputElement;
    checkbox.onchange = () => {
      this.map.config[spec.key] = checkbox.checked;
      this.updateResetButtonsVisibility();
      if (spec.key === "paletteAutoAdjust") {
        this.syncAutoAdjustUi();
        // Disabling keeps the current values for the user to edit; enabling
        // fits to the visible tiles via an in-place recolor, no re-render.
        if (this.map.config.paletteAutoAdjust) {
          this.map.refitPaletteAndRecolor();
        }
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
      this.applySettingEffect(spec);
    }, 300);
  }

  /** In auto mode, changing the iteration cap resets the palette upper bound
   * to the new cap as a provisional range (the lower bound is kept, clamped
   * under the new ceiling): re-rendering with the old fit would clamp
   * everything above it into a maxed-out band around the set until the
   * re-fit, so the stale detection is dropped and the proper range is fitted
   * once all tiles finish rendering. A user-set range is untouched. */
  private resetPaletteCeilingToIterations(newIterations: number) {
    if (!this.map.config.paletteAutoAdjust) {
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
      "iterationsMul2",
    ) as HTMLButtonElement;
    const divideButton = document.getElementById(
      "iterationsDiv2",
    ) as HTMLButtonElement;

    const debouncedRefresh = debounce(() => {
      this.updateResetButtonsVisibility();
      this.map.refresh();
    }, 500);

    multiplyButton.onclick = () => {
      this.map.config.iterations *= 2;
      this.resetPaletteCeilingToIterations(this.map.config.iterations);
      syncInputToConfig(this.map.config, "iterations");

      debouncedRefresh();
    };

    divideButton.onclick = () => {
      this.map.config.iterations = Math.ceil(this.map.config.iterations / 2);
      this.resetPaletteCeilingToIterations(this.map.config.iterations);
      syncInputToConfig(this.map.config, "iterations");

      debouncedRefresh();
    };
  }

  /** Reflects the auto-adjust state in the panel: while enabled the min/max
   * inputs become read-only displays of the applied values. */
  syncAutoAdjustUi() {
    const isAuto = this.map.config.paletteAutoAdjust;

    (document.getElementById("paletteMinIter") as HTMLInputElement).disabled =
      isAuto;
    (document.getElementById("paletteMaxIter") as HTMLInputElement).disabled =
      isAuto;
  }

  private async logEvent(eventName: "imageSave" | "share") {
    await api.client?.from("events").insert([
      {
        event_name: snakeCase(eventName),
        share_url: this.map.getShareUrl(),
        re: String(this.map.config.re),
        im: String(this.map.config.im),
        zoom: this.map.config.zoom,
        iterations: this.map.config.iterations,
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
            window.screen.width * 2 * (window.devicePixelRatio || 1),
          );
          heightInput.value = String(
            window.screen.height * 2 * (window.devicePixelRatio || 1),
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

          this.map.imageSaver
            .saveVisibleImage(
              width,
              height,
              shouldOptimize,
              shouldOptimize
                ? () => modal.setBusyLabel("Optimizing...")
                : undefined,
            )
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
      navigator.clipboard.writeText(this.map.getShareUrl()).then(() => {
        alert("The URL for this view has been copied!");
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
    const windowsShortcut = document.getElementById("windowsShortcut");
    const macShortcut = document.getElementById("macShortcut");

    if (isMac && windowsShortcut && macShortcut) {
      windowsShortcut.style.display = "none";
      macShortcut.style.display = "inline-block";
    }
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
