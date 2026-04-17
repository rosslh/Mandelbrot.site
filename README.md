<p align="center">
  <a href="https://mandelbrot.site">
    <img src="https://raw.githubusercontent.com/rosslh/mandelbrot.site/main/icon.png" height="50px" width="50px" alt="Mandelbrot.site icon">
  </a>
</p>

<h1 align="center">Mandelbrot.site</h1>

<p align="center">
  <a href="https://mandelbrot.site">Mandelbrot.site</a> is an interactive fractal viewer that runs in your web browser. It offers a fast and intuitive way to explore the Mandelbrot set and share your discoveries. This website is built with Rust, WebAssembly, TypeScript, and Leaflet.js.
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

Mandelbrot.site allows you to discover the Mandelbrot set through intuitive **zoom controls** using scrolling or region selection, while **viewport coordinates** continuously track your position on the complex plane.

The visualization experience can be customized by adjusting the **iteration count** or **resolution** settings for varying levels of detail, switching between **color palettes** to reveal different structures, and even exploring **multibrot sets** by changing the exponent parameter.

Beyond exploration, this web app allows you to share discoveries with high-resolution **image downloads** and **shareable URLs** that preserve exact locations and zoom levels, enabling others to access and experience the fractal views you found.

## Gallery

Example images generated with Mandelbrot.site:

<img src="https://raw.githubusercontent.com/rosslh/mandelbrot.site/main/example-images/mandelbrot-01.png" height="200px" alt="Mandelbrot Example 1"> <img src="https://raw.githubusercontent.com/rosslh/mandelbrot.site/main/example-images/mandelbrot-02.png" height="200px" alt="Mandelbrot Example 2">

[View more images](/example-images)

## Architecture

Mandelbrot.site uses a WebAssembly-based architecture for high-performance fractal computation in the browser. The computational backend is implemented in [Rust](https://github.com/rust-lang/rust) for performance and safety. This Rust code is compiled to [WebAssembly](https://webassembly.org/) (Wasm) using the [wasm-pack](https://github.com/rustwasm/wasm-pack) plugin, allowing fast computations directly in the browser. The frontend uses [TypeScript](https://github.com/microsoft/TypeScript) for type safety and [Leaflet.js](https://github.com/Leaflet/Leaflet) to render the Mandelbrot set tiles in a zoomable, map-like interface.

Performance is optimized using [Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API) via the [threads.js](https://github.com/andywer/threads.js) library. This prevents computations from blocking the main browser thread by creating a pool of workers that generate Mandelbrot set tiles in parallel. The "rectangle checking" optimization reduces computation time for areas entirely within the set by checking only the perimeter of a tile.

The site is a [Progressive Web App](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps) (PWA), using [Service Workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API) for offline functionality and reduced network dependencies.

## Development

This project requires [Node.js](https://nodejs.org/) and [Rust](https://rust-lang.org/) to be installed on your system. Check the [`client/.nvmrc`](client/.nvmrc) file for the recommended Node.js version. Development scripts are available in [`client/package.json`](client/package.json).

A complete guide can be found in [CONTRIBUTING.md](CONTRIBUTING.md#your-first-code-contribution).

## Contributors

|                                                                                                                    | Name                     | GitHub Profile                                                              |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------ | --------------------------------------------------------------------------- |
| <img src="https://avatars.githubusercontent.com/u/8635605?v=4" width="50" height="50" alt="Ross Hill">             | **Ross Hill**            | [rosslh](https://github.com/rosslh)                                         |
| <img src="https://avatars.githubusercontent.com/u/122646?v=4" width="50" height="50" alt="Joseph Weissman">        | **Joseph Weissman**      | [jweissman](https://github.com/jweissman)                                   |
| <img src="https://avatars.githubusercontent.com/u/78155393?v=4" width="50" height="50" alt="Shubhankar Shandilya"> | **Shubhankar Shandilya** | [shubhankar-shandilya-india](https://github.com/shubhankar-shandilya-india) |

Want to contribute? Check out the list of [open issues](https://github.com/rosslh/Mandelbrot.site/issues) and read our [contributing guidelines](CONTRIBUTING.md).
