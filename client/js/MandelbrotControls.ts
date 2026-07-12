import debounce from "lodash/debounce";
import throttle from "lodash/throttle";
import snakeCase from "lodash/snakeCase";
import type MandelbrotMap from "./MandelbrotMap";
import { MandelbrotConfig } from "./MandelbrotMap";
import { isValidDecimalCoordinate } from "./highPrecision";
import { describeZoomScale } from "./zoomScale";
import * as api from "./api";

type NumberInput = {
  id:
    | "iterations"
    | "exponent"
    | "zoom"
    | "paletteMinIter"
    | "paletteMaxIter"
    | "colorCycles";
  minValue: number;
  maxValue: number;
  resetView?: boolean;
  allowFraction?: boolean;
};

type CoordinateInput = {
  id: "re" | "im";
  minValue: number;
  maxValue: number;
};

type SelectInput = {
  id: "colorScheme" | "colorSpace";
};

type CheckboxInput = {
  id: "reverseColors" | "highDpiTiles" | "smoothColoring" | "paletteAutoAdjust";
};

type SliderInput = {
  id: "lightenAmount" | "saturateAmount" | "shiftHueAmount";
};

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
          (
            document.getElementById("paletteMaxIter") as HTMLInputElement
          ).value = String(this.map.config.iterations);
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
    this.setupNumberInputs();
    this.setupSelectInputs();
    this.setupCheckboxInputs();
    this.setupSliderInputs();
    this.setupButtons();
    this.setupDetailsToggle();
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

  private setupNumberInputs() {
    const numberInputs: NumberInput[] = [
      { id: "iterations", minValue: 1, maxValue: 10 ** 9 },
      { id: "exponent", minValue: 2, maxValue: 10 ** 9, resetView: true },
      { id: "zoom", minValue: 0, maxValue: 10 ** 6 },
      {
        id: "paletteMinIter",
        minValue: -(10 ** 9),
        maxValue: 10 ** 9,
        allowFraction: false,
      },
      {
        id: "paletteMaxIter",
        minValue: -(10 ** 9),
        maxValue: 10 ** 9,
        allowFraction: false,
      },
      {
        id: "colorCycles",
        minValue: 1,
        maxValue: 100,
        allowFraction: false,
      },
    ];

    numberInputs.forEach((input) => this.handleNumberInput(input));

    const coordinateInputs: CoordinateInput[] = [
      { id: "re", minValue: -2, maxValue: 2 },
      { id: "im", minValue: -2, maxValue: 2 },
    ];

    coordinateInputs.forEach((input) => this.handleCoordinateInput(input));
  }

  private setupSelectInputs() {
    const selectInputs: SelectInput[] = [
      { id: "colorScheme" },
      { id: "colorSpace" },
    ];

    selectInputs.forEach((input) => this.handleSelectInput(input));
  }

  private setupCheckboxInputs() {
    const checkboxInputs: CheckboxInput[] = [
      { id: "reverseColors" },
      { id: "highDpiTiles" },
      { id: "smoothColoring" },
      { id: "paletteAutoAdjust" },
    ];

    checkboxInputs.forEach((input) => this.handleCheckboxInput(input));
  }

  private setupSliderInputs() {
    const sliderInputs: SliderInput[] = [
      { id: "lightenAmount" },
      { id: "saturateAmount" },
      { id: "shiftHueAmount" },
    ];

    sliderInputs.forEach((input) => this.handleSliderInput(input));
  }

  private setupButtons() {
    this.handleIterationButtons();
    this.handleFullScreen();
    this.handleHideShowUiButton();
    this.handleShareButton();
    this.handleSaveImageButton();
    this.handleResetButtons();
  }

  private handleNumberInput({
    id,
    minValue,
    maxValue,
    resetView,
    allowFraction,
  }: NumberInput) {
    const input = document.getElementById(id) as HTMLInputElement;
    input.value = String(this.map.config[id]);
    input.oninput = debounce(({ target }) => {
      let parsedValue = allowFraction
        ? Number.parseFloat(target.value)
        : Number.parseInt(target.value, 10);
      if (
        isNaN(parsedValue) ||
        parsedValue < minValue ||
        parsedValue > maxValue
      ) {
        parsedValue = this.map.config[id];
      }

      if (
        id === "paletteMinIter" &&
        parsedValue > this.map.config.paletteMaxIter
      ) {
        parsedValue = this.map.config[id]; // Reset to previous value
      } else if (
        id === "paletteMaxIter" &&
        parsedValue < this.map.config.paletteMinIter
      ) {
        parsedValue = this.map.config[id]; // Reset to previous value
      }

      if (id === "iterations") {
        this.resetPaletteCeilingToIterations(parsedValue);
      }

      input.value = String(parsedValue);
      this.map.config[id] = parsedValue;
      if (resetView) {
        this.map.config.iterations = this.map.initialConfig.iterations;
        (document.getElementById("iterations") as HTMLInputElement).value =
          String(this.map.initialConfig.iterations);
      }

      this.updateResetButtonsVisibility();
      if (
        id === "paletteMinIter" ||
        id === "paletteMaxIter" ||
        id === "colorCycles"
      ) {
        // The palette range and cycle count only affect coloring, not escape
        // values: repaint the tiles in place instead of re-rendering.
        this.map.applyColorSettings();
      } else {
        this.map.refresh(resetView);
      }
    }, 1000);
  }

  private handleCoordinateInput({ id, minValue, maxValue }: CoordinateInput) {
    const input = document.getElementById(id) as HTMLInputElement;
    input.value = this.map.config[id];
    input.oninput = debounce(({ target }) => {
      const rawValue = String((target as HTMLInputElement).value).trim();
      // Coordinates are kept as decimal strings so deep-zoom precision
      // survives; only their approximate magnitude is range checked.
      const approximateValue = Number.parseFloat(rawValue);
      const isValid =
        isValidDecimalCoordinate(rawValue) &&
        approximateValue >= minValue &&
        approximateValue <= maxValue;

      const newValue = isValid ? rawValue : this.map.config[id];

      input.value = newValue;
      this.map.config[id] = newValue;

      this.updateResetButtonsVisibility();
      this.map.refresh();
    }, 1000);
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

    (document.getElementById("paletteMaxIter") as HTMLInputElement).value =
      String(this.map.config.paletteMaxIter);
    (document.getElementById("paletteMinIter") as HTMLInputElement).value =
      String(this.map.config.paletteMinIter);
  }

  private handleIterationButtons() {
    const multiplyButton = document.getElementById(
      "iterationsMul2",
    ) as HTMLButtonElement;
    const divideButton = document.getElementById(
      "iterationsDiv2",
    ) as HTMLButtonElement;
    const iterationsInput = document.getElementById(
      "iterations",
    ) as HTMLInputElement;

    const debouncedRefresh = debounce(() => {
      this.updateResetButtonsVisibility();
      this.map.refresh();
    }, 500);

    multiplyButton.onclick = () => {
      this.map.config.iterations *= 2;
      this.resetPaletteCeilingToIterations(this.map.config.iterations);
      iterationsInput.value = String(this.map.config.iterations);

      debouncedRefresh();
    };

    divideButton.onclick = () => {
      this.map.config.iterations = Math.ceil(this.map.config.iterations / 2);
      this.resetPaletteCeilingToIterations(this.map.config.iterations);
      iterationsInput.value = String(this.map.config.iterations);

      debouncedRefresh();
    };
  }

  private handleSelectInput({ id }: SelectInput) {
    const select = document.getElementById(id) as HTMLSelectElement;
    select.value = String(this.map.config[id]);
    select.onchange = ({ target }) => {
      const value = (target as HTMLSelectElement).value;
      if (id === "colorScheme") {
        this.map.config[id] = value;
      } else {
        this.map.config[id] = Number(value);
      }
      this.updateResetButtonsVisibility();
      // Color scheme and color space only affect coloring, not escape
      // values: repaint the tiles in place instead of re-rendering.
      this.map.applyColorSettings();
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

  private handleCheckboxInput({ id }: CheckboxInput) {
    const checkbox = document.getElementById(id) as HTMLInputElement;
    checkbox.checked = Boolean(this.map.config[id]);
    checkbox.onchange = ({ target }) => {
      this.map.config[id] = (target as HTMLInputElement).checked;
      this.updateResetButtonsVisibility();
      if (id === "paletteAutoAdjust") {
        this.syncAutoAdjustUi();
        // Disabling keeps the current values for the user to edit; enabling
        // fits to the visible tiles via an in-place recolor, no re-render.
        if (this.map.config.paletteAutoAdjust) {
          this.map.refitPaletteAndRecolor();
        }
      } else if (id === "reverseColors") {
        // Reversal only affects coloring, not escape values: repaint the
        // tiles in place instead of re-rendering.
        this.map.applyColorSettings();
      } else {
        this.map.refresh();
      }
    };
  }

  private handleSliderInput({ id }: SliderInput) {
    const slider = document.getElementById(id) as HTMLInputElement;
    slider.value = String(this.map.config[id]);
    slider.oninput = debounce(({ target }) => {
      const newValue = Number.parseFloat((target as HTMLInputElement).value);

      this.map.config[id] = newValue;
      this.updateResetButtonsVisibility();
      // The hue/saturate/lighten sliders only affect coloring, not escape
      // values: repaint the tiles in place instead of re-rendering.
      this.map.applyColorSettings();
    }, 300);
  }

  private async logEvent(eventName: "imageSave" | "share") {
    await api.client?.from("events").insert([
      {
        event_name: snakeCase(eventName),
        share_url: this.getShareUrl(),
        re: String(this.map.config.re),
        im: String(this.map.config.im),
        zoom: this.map.config.zoom,
        iterations: this.map.config.iterations,
        session_id: api.sessionId,
      },
    ]);
  }

  private handleSaveImageButton() {
    let isSavingImage = false;

    const saveImageButton = document.getElementById(
      "saveImage",
    ) as HTMLButtonElement;
    const saveImageDialog = document.getElementById(
      "saveImageModal",
    ) as HTMLDialogElement;
    const saveImageForm = document.getElementById(
      "saveImageForm",
    ) as HTMLFormElement;
    const widthInput = document.getElementById(
      "imageWidth",
    ) as HTMLInputElement;
    const heightInput = document.getElementById(
      "imageHeight",
    ) as HTMLInputElement;
    const saveImageSubmitButton = document.getElementById("saveImageSubmit");
    const closeModalButton = document.getElementById("saveImageCancel");
    const optimizeImageCheckbox = document.getElementById(
      "optimizeImage",
    ) as HTMLInputElement;

    const ignoreSubmitListener: EventListener = (event) =>
      event.preventDefault();

    const ignoreCancelListener: EventListener = (event) =>
      event.preventDefault();

    const toggleSaveImageModalOpen = () => {
      if (isSavingImage) {
        return;
      }
      saveImageSubmitButton.innerText = "Save";
      saveImageSubmitButton.removeAttribute("disabled");
      saveImageForm.removeEventListener("submit", ignoreSubmitListener);
      closeModalButton.removeAttribute("disabled");

      const currentOptimizeState = optimizeImageCheckbox.checked;
      saveImageForm.reset();
      optimizeImageCheckbox.checked = currentOptimizeState;

      if (saveImageDialog.open) {
        saveImageDialog.close();
      } else {
        widthInput.value = String(
          window.screen.width * 2 * (window.devicePixelRatio || 1),
        );
        heightInput.value = String(
          window.screen.height * 2 * (window.devicePixelRatio || 1),
        );
        saveImageDialog.showModal();
      }
    };

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

    if (typeof Blob !== "undefined") {
      saveImageButton.onclick = (e) => {
        e.stopPropagation();
        toggleSaveImageModalOpen();
      };
    } else {
      saveImageButton.style.display = "none";
    }

    saveImageForm.addEventListener("submit", (event) => {
      event.preventDefault();

      const width = Number(widthInput.value);
      const height = Number(heightInput.value);

      if (!width || Number.isNaN(width) || width <= 0) {
        return;
      }

      if (!height || Number.isNaN(height) || height <= 0) {
        return;
      }

      isSavingImage = true;
      saveImageForm.addEventListener("submit", ignoreSubmitListener);
      saveImageDialog.addEventListener("cancel", ignoreCancelListener);
      saveImageSubmitButton.innerText = "Working...";
      saveImageSubmitButton.setAttribute("disabled", "true");
      closeModalButton.setAttribute("disabled", "true");

      this.logEvent("imageSave");

      saveImageSubmitButton.innerText = "Generating...";
      const shouldOptimize = optimizeImageCheckbox.checked;

      this.map.imageSaver
        .saveVisibleImage(
          width,
          height,
          shouldOptimize,
          shouldOptimize
            ? () => {
                saveImageSubmitButton.innerText = "Optimizing...";
              }
            : undefined,
        )
        .catch((error: unknown) => {
          alert("Error saving image\n\n" + error);
          console.error(error);
        })
        .finally(() => {
          isSavingImage = false;
          toggleSaveImageModalOpen();
        });
    });

    closeModalButton.onclick = () => {
      toggleSaveImageModalOpen();
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

  getShareUrl() {
    const {
      re,
      im,
      zoom: z,
      iterations: i,
      exponent: e,
      colorScheme: c,
      colorCycles: cc,
      reverseColors: r,
      shiftHueAmount: h,
      saturateAmount: s,
      lightenAmount: l,
      colorSpace: cs,
      paletteMinIter: pmin,
      paletteMaxIter: pmax,
      paletteAutoAdjust,
    } = this.map.config;

    const url = new URL(window.location.origin);

    Object.entries({
      re,
      im,
      z,
      i,
      e,
      c,
      cc,
      r,
      h,
      s,
      l,
      cs,
      pmin,
      pmax,
      pm: paletteAutoAdjust ? "auto" : "manual",
    }).forEach(([key, value]) => {
      url.searchParams.set(key, String(value));
    });

    return url.toString();
  }

  private handleShareButton() {
    const shareButton = document.getElementById(
      "shareButton",
    ) as HTMLButtonElement;

    shareButton.onclick = () => {
      navigator.clipboard.writeText(this.getShareUrl()).then(() => {
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
    (document.getElementById("re") as HTMLInputElement).value = finalRe;

    this.map.config.im = finalIm;
    (document.getElementById("im") as HTMLInputElement).value = finalIm;

    this.map.config.zoom = finalZoom;
    (document.getElementById("zoom") as HTMLInputElement).value =
      String(finalZoom);

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

      const element = document.getElementById(String(key));
      if (element) {
        if (element instanceof HTMLInputElement) {
          if (element.type === "checkbox") {
            element.checked = Boolean(initialValue);
          } else {
            element.value = String(initialValue);
          }
        } else if (element instanceof HTMLSelectElement) {
          element.value = String(initialValue);
        }
      } else {
        console.warn(
          `Could not find element with ID: ${String(key)} to reset.`,
        );
      }
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
