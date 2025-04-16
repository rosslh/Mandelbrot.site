import * as L from "leaflet";
import debounce from "lodash/debounce";
import throttle from "lodash/throttle";
import snakeCase from "lodash/snakeCase";
import type MandelbrotMap from "./MandelbrotMap";
import * as api from "./api";
import {
  NumberInput,
  SelectInput,
  CheckboxInput,
  SliderInput,
  MandelbrotConfig,
  ResetButtonConfig,
} from "./types";

const DETAILS_STATE_STORAGE_KEY = "mandelbrot-details-state";
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
        specialHandling: (oldIterations) => {
          if (this.map.config.scaleWithIterations && oldIterations) {
            const newIterations = this.map.config.iterations;
            const ratio = newIterations / oldIterations;

            const newMinIter = Math.floor(
              this.map.config.paletteMinIter * ratio,
            );
            const newMaxIter = Math.floor(
              this.map.config.paletteMaxIter * ratio,
            );

            this.map.config.paletteMinIter = newMinIter;
            this.map.config.paletteMaxIter = newMaxIter;

            const minIterInput = document.getElementById(
              "paletteMinIter",
            ) as HTMLInputElement;
            const maxIterInput = document.getElementById(
              "paletteMaxIter",
            ) as HTMLInputElement;
            minIterInput.value = String(newMinIter);
            maxIterInput.value = String(newMaxIter);
          }
        },
      },
      {
        buttonId: "resetColorScheme",
        configKeys: ["colorScheme", "reverseColors", "smoothColoring"],
      },
      {
        buttonId: "resetPaletteRange",
        configKeys: ["paletteMinIter", "scaleWithIterations"],
        specialHandling: () => {
          // Reset paletteMaxIter based on current iterations
          this.map.config.paletteMaxIter = this.map.config.iterations;
          (
            document.getElementById("paletteMaxIter") as HTMLInputElement
          ).value = String(this.map.config.iterations);
        },
        checkDiff: () => {
          return (
            this.map.config.paletteMinIter !==
              this.map.initialConfig.paletteMinIter ||
            this.map.config.paletteMaxIter !== this.map.config.iterations ||
            this.map.config.scaleWithIterations !==
              this.map.initialConfig.scaleWithIterations
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
      },
      {
        buttonId: "resetCoordinates",
        configKeys: ["re", "im", "zoom"],
        specialHandling: () => {
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
      { id: "re", minValue: -2, maxValue: 2, allowFraction: true },
      { id: "im", minValue: -2, maxValue: 2, allowFraction: true },
      { id: "zoom", minValue: 0, maxValue: 48 },
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
    ];

    numberInputs.forEach((input) => this.handleNumberInput(input));
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
      { id: "scaleWithIterations" },
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

      if (id === "iterations" && this.map.config.scaleWithIterations) {
        this.updatePaletteMinMaxWithIterations(parsedValue);
      }

      input.value = String(parsedValue);
      this.map.config[id] = parsedValue;
      if (resetView) {
        this.map.config.iterations = this.map.initialConfig.iterations;
        (document.getElementById("iterations") as HTMLInputElement).value =
          String(this.map.initialConfig.iterations);
      }

      this.updateResetButtonsVisibility();
      this.map.refresh(resetView);
    }, 1000);
  }

  private updatePaletteMinMaxWithIterations(newIterations: number) {
    const oldIterations = this.map.config.iterations;

    if (oldIterations === 0) return;

    const ratio = newIterations / oldIterations;

    const newMinIter = Math.floor(this.map.config.paletteMinIter * ratio);
    const newMaxIter = Math.floor(this.map.config.paletteMaxIter * ratio);

    this.map.config.paletteMinIter = newMinIter;
    this.map.config.paletteMaxIter = newMaxIter;

    const minIterInput = document.getElementById(
      "paletteMinIter",
    ) as HTMLInputElement;
    const maxIterInput = document.getElementById(
      "paletteMaxIter",
    ) as HTMLInputElement;
    minIterInput.value = String(newMinIter);
    maxIterInput.value = String(newMaxIter);
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
      if (this.map.config.scaleWithIterations) {
        this.updatePaletteMinMaxWithIterations(this.map.config.iterations * 2);
      }

      this.map.config.iterations *= 2;
      iterationsInput.value = String(this.map.config.iterations);

      debouncedRefresh();
    };

    divideButton.onclick = () => {
      const newIterations = Math.ceil(this.map.config.iterations / 2);

      if (this.map.config.scaleWithIterations) {
        this.updatePaletteMinMaxWithIterations(newIterations);
      }

      this.map.config.iterations = newIterations;
      iterationsInput.value = String(this.map.config.iterations);

      debouncedRefresh();
    };
  }

  private handleSelectInput({ id }: SelectInput) {
    const select = document.getElementById(id) as HTMLSelectElement;
    select.value = String(this.map.config[id]);
    select.onchange = ({ target }) => {
      if (id === "colorScheme") {
        this.map.config[id] = (target as HTMLSelectElement).value;
      } else if (id === "colorSpace") {
        this.map.config[id] = Number((target as HTMLSelectElement).value);
      }
      this.updateResetButtonsVisibility();
      this.map.refresh();
    };
  }

  private handleCheckboxInput({ id }: CheckboxInput) {
    const checkbox = document.getElementById(id) as HTMLInputElement;
    checkbox.checked = Boolean(this.map.config[id]);
    checkbox.onchange = ({ target }) => {
      this.map.config[id] = (target as HTMLInputElement).checked;
      this.updateResetButtonsVisibility();
      this.map.refresh();
    };
  }

  private handleSliderInput({ id }: SliderInput) {
    const slider = document.getElementById(id) as HTMLInputElement;
    slider.value = String(this.map.config[id]);
    slider.oninput = debounce(({ target }) => {
      const newValue = Number.parseFloat((target as HTMLInputElement).value);

      this.map.config[id] = newValue;
      this.updateResetButtonsVisibility();
      this.map.refresh();
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
      saveImageForm.reset();
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

      this.map
        .saveVisibleImage(width, height)
        .catch((error) => {
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
      reverseColors: r,
      shiftHueAmount: h,
      saturateAmount: s,
      lightenAmount: l,
      colorSpace: cs,
      paletteMinIter: pmin,
      paletteMaxIter: pmax,
    } = this.map.config;

    const url = new URL(window.location.origin);

    Object.entries({ re, im, z, i, e, c, r, h, s, l, cs, pmin, pmax }).forEach(
      ([key, value]) => {
        url.searchParams.set(key, String(value));
      },
    );

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
    const tileSize = [
      this.map.mandelbrotLayer.getTileSize().x,
      this.map.mandelbrotLayer.getTileSize().y,
    ];
    const point = this.map
      .project(this.map.getCenter(), this.map.getZoom())
      .unscaleBy(new L.Point(tileSize[0], tileSize[1]));

    const currentPosition = { ...point, z: this.map.getZoom() };

    const { re: currentRe, im: currentIm } =
      this.map.tilePositionToComplexParts(
        currentPosition.x,
        currentPosition.y,
        currentPosition.z,
      );
    const currentZoom = currentPosition.z;

    const reDiff = Math.abs(currentRe - this.map.initialConfig.re);
    const imDiff = Math.abs(currentIm - this.map.initialConfig.im);
    const zoomDiff = Math.abs(currentZoom - this.map.initialConfig.zoom);

    let finalRe = currentRe;
    let finalIm = currentIm;
    let finalZoom = currentZoom;

    const tolerance = 0.02;
    if (reDiff <= tolerance && imDiff <= tolerance && zoomDiff <= tolerance) {
      finalRe = this.map.initialConfig.re;
      finalIm = this.map.initialConfig.im;
      finalZoom = this.map.initialConfig.zoom;
    }

    this.map.config.re = finalRe;
    (document.getElementById("re") as HTMLInputElement).value = String(finalRe);

    this.map.config.im = finalIm;
    (document.getElementById("im") as HTMLInputElement).value = String(finalIm);

    this.map.config.zoom = finalZoom;
    (document.getElementById("zoom") as HTMLInputElement).value =
      String(finalZoom);
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
          const oldIterations =
            config.buttonId === "resetRender"
              ? this.map.config.iterations
              : undefined;

          this.resetConfigValues(config.configKeys);

          if (config.specialHandling) {
            config.specialHandling(oldIterations);
          }

          this.updateResetButtonsVisibility();

          if (config.buttonId !== "resetCoordinates") {
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
