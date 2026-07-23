<p align="center">
  <a href="https://mandelbrot.site">
    <img src="https://raw.githubusercontent.com/rosslh/mandelbrot.site/main/icon.png" height="50px" width="50px" alt="Mandelbrot.site icon">
  </a>
</p>

<h1 align="center">Mandelbrot.site</h1>

<p align="center">
  <a href="https://mandelbrot.site">Mandelbrot.site</a> is an interactive Mandelbrot set explorer that runs in your browser. Zoom, adjust the rendering, save images, and share exact views with a link.
</p>

<p align="center">
  <img src="https://img.shields.io/github/check-runs/rosslh/mandelbrot.site/main?style=flat&label=Checks" alt="GitHub branch check runs">
  <img src="https://img.shields.io/uptimerobot/status/m792388109-4c544ded2b0e440130ddd401?up_message=online&style=flat&label=Status" alt="Uptime Robot status">
  <img src="https://img.shields.io/uptimerobot/ratio/m792388109-4c544ded2b0e440130ddd401?style=flat&label=Uptime%20(1mo)" alt="Uptime Robot ratio (30 days)">
  <a href="https://mapledeploy.ca"><img src="https://mapledeploy.ca/api/badge/shields" alt="Hosted in Canada with MapleDeploy"></a>
</p>

<p align="center">
  As seen in:
  <a href="https://www.sciencefocus.com/science/the-two-numbers-that-could-solve-maths-biggest-mysteries/">BBC Science Focus</a> •
  <a href="https://www.creativemachine.io/cm-tam/educational-art/benoit-mandelbrot">Creative Machine</a> •
  <a href="https://news.ycombinator.com/item?id=43375676">Hacker News</a> •
  <a href="https://www.sciencenews.org/article/fractals-math-science-society-50-years">Science News</a>
</p>

## Features

- Explore the Mandelbrot set with scroll zooming, region selection, live coordinates, and a caption that compares your view's scale to real-world objects.
- Zoom far beyond floating-point limits: deep views are rendered with arbitrary-precision perturbation theory.
- Tune the image with iteration, resolution, palette, and exponent controls, including multibrot exponents.
- Choose between escape-time, distance-estimate, and atom-domain (period) coloring, with histogram equalization, palette auto-fit, and a live iteration histogram. Color changes recolor cached pixels instantly instead of re-rendering.
- Inspect any point with a ctrl+hover tooltip showing full-precision coordinates, escape time, distance to the set boundary, and orbit period.
- Preview the Julia set for the point under your cursor in a navigator panel that doubles as a full-set minimap.
- Pin, rename, and revisit interesting locations from the sidebar.
- Export high-resolution PNGs with view parameters embedded in the metadata, plus optional raw iteration data, or record a zoom animation as a video.
- Share links that preserve the exact location, zoom level, and rendering settings.

## Gallery

Example images generated with Mandelbrot.site:

<img src="https://raw.githubusercontent.com/rosslh/mandelbrot.site/main/example-images/mandelbrot-01.png" height="200px" alt="Mandelbrot Example 1"> <img src="https://raw.githubusercontent.com/rosslh/mandelbrot.site/main/example-images/mandelbrot-02.png" height="200px" alt="Mandelbrot Example 2">

[View more images](/example-images)

## Architecture

The app renders fractal tiles in the browser. The computation-heavy Mandelbrot code is written in [Rust](https://github.com/rust-lang/rust), compiled to [WebAssembly](https://webassembly.org/) with [wasm-pack](https://github.com/rustwasm/wasm-pack), and run in parallel with [Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API) through [threads.js](https://github.com/andywer/threads.js). The interface is built with [TypeScript](https://github.com/microsoft/TypeScript) and [Leaflet.js](https://github.com/Leaflet/Leaflet), giving the fractal a map-like pan and zoom experience.

Ordinary 64-bit floats run out of precision around zoom level 44, so deep zooms use [perturbation theory](https://en.wikipedia.org/wiki/Plotting_algorithms_for_the_Mandelbrot_set#Perturbation_theory_and_series_approximation): each view computes one reference orbit with arbitrary-precision arithmetic ([dashu](https://github.com/cmpute/dashu)), and every pixel iterates only its tiny delta from that orbit using fast hardware floats with an extended exponent range, rebasing against the orbit to avoid glitches. Coordinates are tracked as arbitrary-precision decimal strings, and Leaflet's own f64-limited zoom is kept shallow by periodically re-anchoring the map origin to the view center, so the effective zoom depth is unlimited.

The render kernels are heavily optimized: pixels stream through SIMD lanes with lane refill, provably-interior regions are skipped via Mariani-Silver subdivision, and two WebAssembly builds ship side by side. Engines that support relaxed SIMD (detected at runtime with a tiny probe module) get a hardware-FMA build with a substantially faster escape loop, while other engines get a portable build with identical output. Every optimization is validated by a benchmark harness ([`bench/`](bench)) that measures real user views in Chrome, checks output pixel-for-pixel, and records each experiment, shipped or rejected, in [`bench/LOG.md`](bench/LOG.md).

Mandelbrot.site is also a [Progressive Web App](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps), with service-worker support for offline use and reduced network dependency.

## Development

To work on the project, install [Node.js](https://nodejs.org/) and [Rust](https://rust-lang.org/). Use the Node.js version in [`client/.nvmrc`](client/.nvmrc), then run the npm scripts from the `client` directory.

A complete guide can be found in [CONTRIBUTING.md](CONTRIBUTING.md#your-first-code-contribution).

## Contributors

|                                                                                                                    | Name                     | GitHub Profile                                                              |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------ | --------------------------------------------------------------------------- |
| <img src="https://avatars.githubusercontent.com/u/8635605?v=4" width="50" height="50" alt="Ross Hill">             | **Ross Hill**            | [rosslh](https://github.com/rosslh)                                         |
| <img src="https://avatars.githubusercontent.com/u/122646?v=4" width="50" height="50" alt="Joseph Weissman">        | **Joseph Weissman**      | [jweissman](https://github.com/jweissman)                                   |
| <img src="https://avatars.githubusercontent.com/u/78155393?v=4" width="50" height="50" alt="Shubhankar Shandilya"> | **Shubhankar Shandilya** | [shubhankar-shandilya-india](https://github.com/shubhankar-shandilya-india) |

Want to contribute? Check out the list of [open issues](https://github.com/rosslh/Mandelbrot.site/issues) and read our [contributing guidelines](CONTRIBUTING.md).
