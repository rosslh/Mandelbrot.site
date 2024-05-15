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
  defaultValue: number;
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
  defaultValue,
  minValue,
  maxValue,
  resetView,
  allowFraction,
}: NumberInput) {
  const input = <HTMLInputElement>document.getElementById(id);
  input.value = String(config[id]);
  input.oninput = debounce(({ target }) => {
    let parsedValue = allowFraction
      ? Number.parseFloat((<HTMLInputElement>target).value)
      : Number.parseInt((<HTMLInputElement>target).value, 10);
    if (
      isNaN(parsedValue) ||
      parsedValue < minValue ||
      parsedValue > maxValue
    ) {
      parsedValue = defaultValue;
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

function handleDom(map: MandelbrotMap) {
  handleNumberInput({
    id: "iterations",
    map,
    minValue: 1,
    defaultValue: 200,
    maxValue: 10 ** 9,
  });
  handleNumberInput({
    id: "exponent",
    map,
    minValue: 2,
    defaultValue: Number(config.exponent),
    maxValue: 10 ** 9,
    resetView: true,
  });
  handleNumberInput({
    id: "re",
    map,
    minValue: -2,
    defaultValue: 0,
    maxValue: 2,
    allowFraction: true,
  });
  handleNumberInput({
    id: "im",
    map,
    minValue: -2,
    defaultValue: 0,
    maxValue: 2,
    allowFraction: true,
  });
  handleNumberInput({
    id: "zoom",
    map,
    minValue: 0,
    defaultValue: 3,
    maxValue: 48,
  });
  handleSelectInput({ id: "colorScheme", map });
  handleCheckboxInput({ id: "reverseColors", map });
  handleCheckboxInput({
    id: "highDpiTiles",
    map,
  });

  const refreshButton = document.getElementById("refresh");
  refreshButton.onclick = () => map.refresh();

  const fullScreenButton = document.getElementById("full-screen");
  const exitFullScreenButton = document.getElementById("exit-full-screen");
  fullScreenButton.onclick = toggleFullScreen;
  exitFullScreenButton.onclick = toggleFullScreen;

  const hideShowControlsButton = document.getElementById("hide-show-controls");
  hideShowControlsButton.onclick = () => {
    document.body.classList.toggle("hideOverlays");
  };

  const saveButton = document.getElementById("save-image");
  try {
    // eslint-disable-next-line no-constant-condition
    if (new Blob()) {
      saveButton.onclick = () => map.saveImage();
    } else {
      throw "FileSaver not supported";
    }
  } catch {
    saveButton.style.display = "none";
  }

  const saveLargeImageButton = document.getElementById("save-large-image");
  try {
    // eslint-disable-next-line no-constant-condition
    if (new Blob()) {
      saveLargeImageButton.onclick = () => {
        saveLargeImageButton.innerHTML = "Saving...";
        saveLargeImageButton.setAttribute("disabled", "true");
        map.saveLargeImage().then(() => {
          saveLargeImageButton.innerHTML = "Save large image";
          saveLargeImageButton.removeAttribute("disabled");
        });
      };
    } else {
      throw "FileSaver not supported";
    }
  } catch {
    saveLargeImageButton.style.display = "none";
  }

  function toggleFullScreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.body.requestFullscreen();
    }
  }

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

  const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  const windowsShortcut =
    document.querySelector<HTMLSpanElement>(".windowsShortcut");
  const macShortcut = document.querySelector<HTMLSpanElement>(".macShortcut");

  if (isMac && windowsShortcut && macShortcut) {
    windowsShortcut.style.display = "none";
    macShortcut.style.display = "inline-block";
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "h") {
      document.body.classList.toggle("hideOverlays");
    }
    if (event.key === "s") {
      map.saveImage();
    }
    if (event.key === "r") {
      map.refresh();
    }
    if (event.key === "f") {
      toggleFullScreen();
    }
  });
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
