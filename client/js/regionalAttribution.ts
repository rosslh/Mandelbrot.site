const canadaCountryCode = "CA";
const countryCodeStorageKey = "mandelbrot.countryCode";
const githubButtonScriptSrc = "https://buttons.github.io/buttons.js";
const countryCodeLookupTimeoutMs = 3000;
const countryCodeLookupUrl =
  "https://mapledeploy.ca/api/badge?theme=dark&size=large";

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

// MapleDeploy's CDN adds the visitor's country to every badge response and
// exposes it to other origins, so fetching the badge doubles as the lookup.
// `no-store` keeps a cached response from answering with an old country.
async function lookupCountryCodeFromBadge() {
  const response = await fetch(countryCodeLookupUrl, {
    cache: "no-store",
    signal: AbortSignal.timeout(countryCodeLookupTimeoutMs),
  });

  if (!response.ok) return null;

  return normalizeCountryCode(response.headers.get("CDN-RequestCountryCode"));
}

async function getVisitorCountryCode() {
  const storedCountryCode = getStoredCountryCode();
  if (storedCountryCode) return storedCountryCode;

  try {
    const countryCode = await lookupCountryCodeFromBadge();

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
