import * as L from "leaflet";
import debounce from "lodash/debounce";
import type MandelbrotMap from "./MandelbrotMap";
import throttle from "lodash/throttle";
import api from "./api";

type NumberInput = {
  id: "iterations" | "exponent" | "re" | "im" | "zoom";
  minValue: number;
  maxValue: number;
  allowFraction?: boolean;
  resetView?: boolean;
};

type SelectInput = {
  id: "colorScheme" | "colorSpace";
};

type CheckboxInput = {
  id: "reverseColors" | "highDpiTiles";
  hidden?: boolean;
};

type SliderInput = {
  id: "lightenAmount" | "saturateAmount" | "shiftHueAmount";
};

class MandelbrotControls {
  map: MandelbrotMap;

  constructor(map: MandelbrotMap) {
    this.map = map;

    this.handleInputs();
  }

  throttleSetInputValues = throttle(() => this.setInputValues(), 200);

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
      input.value = String(parsedValue);
      this.map.config[id] = parsedValue;
      if (resetView) {
        this.map.config.iterations = this.map.initialConfig.iterations;
        (document.getElementById("iterations") as HTMLInputElement).value =
          String(this.map.initialConfig.iterations);
      }
      this.map.refresh(resetView);
    }, 1000);
  }

  private handleIterationButtons() {
    const multiplyButton = document.getElementById(
      "iterations-mul-2",
    ) as HTMLButtonElement;
    const divideButton = document.getElementById(
      "iterations-div-2",
    ) as HTMLButtonElement;
    const iterationsInput = document.getElementById(
      "iterations",
    ) as HTMLInputElement;

    const debouncedRefresh = debounce(() => this.map.refresh(), 500);

    multiplyButton.onclick = () => {
      this.map.config.iterations *= 2;
      iterationsInput.value = String(this.map.config.iterations);
      debouncedRefresh();
    };

    divideButton.onclick = () => {
      this.map.config.iterations = Math.ceil(this.map.config.iterations / 2);
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
      this.map.refresh();
    };
  }

  private handleCheckboxInput({ id }: CheckboxInput) {
    const checkbox = document.getElementById(id) as HTMLInputElement;
    checkbox.checked = Boolean(this.map.config[id]);
    checkbox.onchange = ({ target }) => {
      this.map.config[id] = (target as HTMLInputElement).checked;
      this.map.refresh();
    };
  }

  private handleSliderInput({ id }: SliderInput) {
    const slider = document.getElementById(id) as HTMLInputElement;
    slider.value = String(this.map.config[id]);
    slider.oninput = debounce(({ target }) => {
      this.map.config[id] = Number.parseFloat(
        (target as HTMLInputElement).value,
      );
      this.map.refresh();
    }, 300);
  }

  private async logEvent(eventName: "image_save" | "share") {
    await api.client?.from("events").insert([
      {
        event_name: eventName,
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

    const saveImageButton = document.getElementById("save-image");
    const saveImageDialog = document.getElementById(
      "save-image-modal",
    ) as HTMLDialogElement;
    const saveImageForm = document.getElementById(
      "save-image-form",
    ) as HTMLFormElement;
    const widthInput = document.getElementById(
      "image-width",
    ) as HTMLInputElement;
    const heightInput = document.getElementById(
      "image-height",
    ) as HTMLInputElement;
    const saveImageSubmitButton = document.getElementById("save-image-submit");
    const closeModalButton = document.getElementById("save-image-cancel");

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
      saveImageDialog.removeEventListener("cancel", ignoreCancelListener);
      saveImageForm.reset();
      if (saveImageDialog.open) {
        saveImageDialog.close();
      } else {
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

      this.logEvent("image_save");

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
    const hideControlsButton = document.getElementById("hide-controls");
    hideControlsButton.onclick = () => {
      document.body.classList.add("hideOverlays");
    };

    const showControlsButton = document.getElementById("show-controls");
    showControlsButton.onclick = () => {
      document.body.classList.remove("hideOverlays");
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
    } = this.map.config;

    const url = new URL(window.location.origin);

    Object.entries({ re, im, z, i, e, c, r, h, s, l, cs }).forEach(
      ([key, value]) => {
        url.searchParams.set(key, String(value));
      },
    );

    return url.toString();
  }

  private handleShareButton() {
    const shareButton = document.getElementById(
      "share-button",
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

    const fullScreenButton = document.getElementById("full-screen");
    const exitFullScreenButton = document.getElementById("exit-full-screen");
    fullScreenButton.onclick = toggleFullScreen;
    exitFullScreenButton.onclick = toggleFullScreen;

    document.addEventListener("fullscreenchange", () => {
      const fullScreenButton = document.getElementById("full-screen");
      const exitFullScreenButton = document.getElementById("exit-full-screen");
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
    const windowsShortcut =
      document.querySelector<HTMLSpanElement>("windowsShortcut");
    const macShortcut = document.querySelector<HTMLSpanElement>("macShortcut");

    if (isMac && windowsShortcut && macShortcut) {
      windowsShortcut.style.display = "none";
      macShortcut.style.display = "inline-block";
    }
  }

  private handleInputs() {
    this.handleShortcutHints();

    this.handleNumberInput({
      id: "iterations",
      minValue: 1,
      maxValue: 10 ** 9,
    });
    this.handleIterationButtons();

    this.handleNumberInput({
      id: "exponent",
      minValue: 2,
      maxValue: 10 ** 9,
      resetView: true,
    });
    this.handleCheckboxInput({
      id: "highDpiTiles",
    });

    this.handleSelectInput({ id: "colorScheme" });
    this.handleCheckboxInput({ id: "reverseColors" });
    this.handleSliderInput({ id: "lightenAmount" });
    this.handleSliderInput({ id: "saturateAmount" });
    this.handleSliderInput({ id: "shiftHueAmount" });
    this.handleSelectInput({ id: "colorSpace" });

    this.handleNumberInput({
      id: "re",
      minValue: -2,
      maxValue: 2,
      allowFraction: true,
    });
    this.handleNumberInput({
      id: "im",
      minValue: -2,
      maxValue: 2,
      allowFraction: true,
    });
    this.handleNumberInput({
      id: "zoom",
      minValue: 0,
      maxValue: 48,
    });

    this.handleFullScreen();
    this.handleHideShowUiButton();
    this.handleShareButton();
    this.handleSaveImageButton();
  }

  private setInputValues() {
    const tileSize = [
      this.map.mandelbrotLayer.getTileSize().x,
      this.map.mandelbrotLayer.getTileSize().y,
    ];
    const point = this.map
      .project(this.map.getCenter(), this.map.getZoom())
      .unscaleBy(new L.Point(tileSize[0], tileSize[1]));

    const position = { ...point, z: this.map.getZoom() };

    const { re, im } = this.map.tilePositionToComplexParts(
      position.x,
      position.y,
      position.z,
    );

    this.map.config.re = re;
    (document.getElementById("re") as HTMLInputElement).value = String(re);

    this.map.config.im = im;
    (document.getElementById("im") as HTMLInputElement).value = String(im);

    this.map.config.zoom = position.z;
    (document.getElementById("zoom") as HTMLInputElement).value = String(
      position.z,
    );
  }
}

export default MandelbrotControls;
