import "./static";
import debounce from "lodash/debounce";
import MandelbrotMap from "./MandelbrotMap";

type MandelbrotConfig = {
  iterations: number;
  exponent: number;
  colorScheme: string;
  reverseColors: boolean;
  highDpiTiles: boolean;

  re: number;
  im: number;
  zoom: number;
};

type NumberInput = {
  id: "iterations" | "exponent" | "re" | "im" | "zoom";
  map: MandelbrotMap;
  minValue: number;
  maxValue: number;
  allowFraction?: boolean;
  resetView?: boolean;
};

type SelectInput = {
  id: "colorScheme";
  map: MandelbrotMap;
};

type CheckboxInput = {
  id: "reverseColors" | "highDpiTiles";
  map: MandelbrotMap;
  hidden?: boolean;
};

const configDefaults: MandelbrotConfig = {
  iterations: 200,
  exponent: 2,
  colorScheme: "turbo",
  reverseColors: false,
  highDpiTiles: false,

  re: 0,
  im: 0,
  zoom: 3,
};

export const config: MandelbrotConfig = {
  ...configDefaults,
};

function handleNumberInput({
  id,
  map,
  minValue,
  maxValue,
  resetView,
  allowFraction,
}: NumberInput) {
  const input = <HTMLInputElement>document.getElementById(id);
  input.value = String(config[id]);
  input.oninput = debounce(({ target }) => {
    let parsedValue = allowFraction
      ? Number.parseFloat(target.value)
      : Number.parseInt(target.value, 10);
    if (
      isNaN(parsedValue) ||
      parsedValue < minValue ||
      parsedValue > maxValue
    ) {
      parsedValue = config[id];
    }
    input.value = String(parsedValue);
    config[id] = parsedValue;
    if (resetView) {
      config.iterations = configDefaults.iterations;
      (document.getElementById("iterations") as HTMLInputElement).value =
        String(configDefaults.iterations);
    }
    map.refresh(resetView);
  }, 1000);
}

function handleIterationButtons(map: MandelbrotMap) {
  const multiplyButton = <HTMLButtonElement>(
    document.getElementById("iterations-mul-2")
  );
  const divideButton = <HTMLButtonElement>(
    document.getElementById("iterations-div-2")
  );
  const iterationsInput = <HTMLInputElement>(
    document.getElementById("iterations")
  );

  multiplyButton.onclick = () => {
    config.iterations *= 2;
    iterationsInput.value = String(config.iterations);
    map.refresh();
  };

  divideButton.onclick = () => {
    config.iterations = Math.ceil(config.iterations / 2);
    iterationsInput.value = String(config.iterations);
    map.refresh();
  };
}

function handleSelectInput({ id, map }: SelectInput) {
  const select = <HTMLSelectElement>document.getElementById(id);
  select.value = String(config[id]);
  select.onchange = ({ target }) => {
    config[id] = (<HTMLSelectElement>target).value;
    map.refresh();
  };
}

function handleCheckboxInput({ id, map }: CheckboxInput) {
  const checkbox = <HTMLInputElement>document.getElementById(id);
  checkbox.checked = Boolean(config[id]);
  checkbox.onchange = ({ target }) => {
    config[id] = (<HTMLInputElement>target).checked;
    map.refresh();
  };
}

function handleSaveImageButton(map: MandelbrotMap) {
  const saveImageButton = document.getElementById("save-image");
  const saveImageDialog = document.getElementById(
    "save-image-modal"
  ) as HTMLDialogElement;
  const saveImageForm = document.getElementById(
    "save-image-form"
  ) as HTMLFormElement;
  const widthInput = document.getElementById("image-width") as HTMLInputElement;
  const heightInput = document.getElementById(
    "image-height"
  ) as HTMLInputElement;
  const saveImageSubmitButton = document.getElementById("save-image-submit");
  const closeModalButton = document.getElementById("save-image-cancel");

  const toggleSaveImageModalOpen = () => {
    saveImageSubmitButton.innerText = "Save";
    saveImageSubmitButton.removeAttribute("disabled");
    saveImageForm.reset();
    if (saveImageDialog.open) {
      saveImageDialog.close();
    } else {
      saveImageDialog.showModal();
    }
  };

  // eslint-disable-next-line no-constant-condition
  if (new Blob()) {
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

    saveImageSubmitButton.innerText = "Working...";
    saveImageSubmitButton.setAttribute("disabled", "true");

    map.saveVisibleImage(width, height).then(() => {
      toggleSaveImageModalOpen();
    });
  });

  closeModalButton.onclick = () => {
    toggleSaveImageModalOpen();
  };

  return toggleSaveImageModalOpen;
}

function handleHideShowUiButton() {
  const hideShowControlsButton = document.getElementById("hide-show-controls");
  hideShowControlsButton.onclick = () => {
    document.body.classList.toggle("hideOverlays");
  };
}

function handleFullScreen() {
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

  return toggleFullScreen;
}

function handleRefreshButton(map: MandelbrotMap) {
  const refreshButton = document.getElementById("refresh");
  refreshButton.onclick = () => map.refresh();
}

function handleHotKeys(
  map: MandelbrotMap,
  toggleSaveImageModalOpen: () => void,
  toggleFullScreen: () => void
) {
  const mobileBreakpoint = 800;
  document.addEventListener("keypress", (event) => {
    if (window.innerWidth < mobileBreakpoint) {
      return;
    }
    if (event.key === "h") {
      document.body.classList.toggle("hideOverlays");
    }
    if (event.key === "s") {
      toggleSaveImageModalOpen();
    }
    if (event.key === "r") {
      map.refresh();
    }
    if (event.key === "f") {
      toggleFullScreen();
    }
  });
}

function handleShortcutHints() {
  const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  const windowsShortcut =
    document.querySelector<HTMLSpanElement>(".windowsShortcut");
  const macShortcut = document.querySelector<HTMLSpanElement>(".macShortcut");

  if (isMac && windowsShortcut && macShortcut) {
    windowsShortcut.style.display = "none";
    macShortcut.style.display = "inline-block";
  }
}

function handleDom(map: MandelbrotMap) {
  handleNumberInput({
    id: "iterations",
    map,
    minValue: 1,
    maxValue: 10 ** 9,
  });
  handleIterationButtons(map);

  handleNumberInput({
    id: "exponent",
    map,
    minValue: 2,
    maxValue: 10 ** 9,
    resetView: true,
  });
  handleNumberInput({
    id: "re",
    map,
    minValue: -2,
    maxValue: 2,
    allowFraction: true,
  });
  handleNumberInput({
    id: "im",
    map,
    minValue: -2,
    maxValue: 2,
    allowFraction: true,
  });
  handleNumberInput({
    id: "zoom",
    map,
    minValue: 0,
    maxValue: 48,
  });
  handleSelectInput({ id: "colorScheme", map });
  handleCheckboxInput({ id: "reverseColors", map });
  handleCheckboxInput({
    id: "highDpiTiles",
    map,
  });

  handleRefreshButton(map);
  handleHideShowUiButton();
  handleShortcutHints();

  const toggleFullScreen = handleFullScreen();
  const toggleSaveImageModalOpen = handleSaveImageButton(map);
  handleHotKeys(map, toggleSaveImageModalOpen, toggleFullScreen);
}

const map = new MandelbrotMap({
  htmlId: "leaflet-map",
});
handleDom(map);

const setConfigFromUrl = () => {
  const queryParams = new URLSearchParams(window.location.search);
  const re = queryParams.get("re");
  const im = queryParams.get("im");
  const zoom = queryParams.get("z");
  const iterations = queryParams.get("i");
  const exponent = queryParams.get("e");
  const colorScheme = queryParams.get("c");
  const reverseColors = queryParams.get("r");
  const sharing = queryParams.get("sharing");

  if (re && im && zoom) {
    config.re = Number(re);
    config.im = Number(im);
    config.zoom = Number(zoom);

    if (iterations) {
      config.iterations = Number(iterations);
      (<HTMLInputElement>document.getElementById("iterations")).value =
        iterations;
    }
    if (exponent) {
      config.exponent = Number(exponent);
      (<HTMLInputElement>document.getElementById("exponent")).value = exponent;
    }
    if (colorScheme) {
      config.colorScheme = colorScheme;
      (<HTMLSelectElement>document.getElementById("colorScheme")).value =
        colorScheme;
    }
    if (reverseColors) {
      config.reverseColors = reverseColors === "true";
      (<HTMLInputElement>document.getElementById("reverseColors")).checked =
        config.reverseColors;
    }

    if (sharing) {
      window.history.replaceState(
        {},
        document.title,
        window.location.href.replace("&sharing=true", "")
      );
    } else {
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    if (config.re !== 0 && config.im !== 0 && config.zoom !== 3) {
      map.refresh();
    }
  }
};

window.addEventListener("load", setConfigFromUrl);
