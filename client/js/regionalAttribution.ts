const canadaCountryCode = "CA";
const countryCodeStorageKey = "mandelbrot.countryCode";
const githubButtonScriptSrc = "https://buttons.github.io/buttons.js";
const countryCodeLookupTimeoutMs = 3000;

function normalizeCountryCode(countryCode: string | undefined | null) {
  return countryCode?.trim().toUpperCase() || null;
}

function getStoredCountryCode() {
  try {
    return normalizeCountryCode(sessionStorage.getItem(countryCodeStorageKey));
  } catch {
    return null;
  }
}

function storeCountryCode(countryCode: string) {
  try {
    sessionStorage.setItem(countryCodeStorageKey, countryCode);
  } catch {
    // Storage can be disabled; geolocation should still work for this page load.
  }
}

async function lookupCountryCodeFromIpApi() {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => {
    controller.abort();
  }, countryCodeLookupTimeoutMs);

  try {
    const response = await fetch("https://ipapi.co/country/", {
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) return null;

    return normalizeCountryCode(await response.text());
  } finally {
    window.clearTimeout(timeout);
  }
}

async function getVisitorCountryCode() {
  const storedCountryCode = getStoredCountryCode();
  if (storedCountryCode) return storedCountryCode;

  try {
    const countryCode = await lookupCountryCodeFromIpApi();

    if (countryCode) {
      storeCountryCode(countryCode);
      return countryCode;
    }
  } catch {
    // If geolocation fails, fall back to GitHub.
  }

  return null;
}

function revealElements(selector: string) {
  document.querySelectorAll<HTMLElement>(selector).forEach((element) => {
    element.hidden = false;
  });
}

function revealCanadianHostingBadges() {
  document
    .querySelectorAll<HTMLAnchorElement>(".canadian-hosting-badge")
    .forEach((badge) => {
      const image = badge.querySelector("img");
      if (!image) return;

      const { src, srcset } = image.dataset;
      if (src) image.src = src;
      if (srcset) image.srcset = srcset;
      badge.hidden = false;
    });
}

function loadGithubButtonScript() {
  if (document.querySelector(`script[src="${githubButtonScriptSrc}"]`)) return;

  const script = document.createElement("script");
  script.src = githubButtonScriptSrc;
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
}

export async function initRegionalAttribution() {
  const visitorCountryCode = await getVisitorCountryCode();

  if (visitorCountryCode === canadaCountryCode) {
    revealCanadianHostingBadges();
    return;
  }

  revealElements(".geo-github-button");
  loadGithubButtonScript();
}
