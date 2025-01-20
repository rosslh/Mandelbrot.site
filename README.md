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
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat" alt="MIT license">
</p>

## Features

Mandelbrot.site offers a variety of features to enhance your experience:

- **Zoom in** by scrolling or selecting a region.
- Adjust the **detail level** by modifying the iteration count or resolution.
- Download **high-resolution images** of your current view.
- Generate URLs to **share** your favorite Mandelbrot set locations.
- Customize your experience with different **color palettes**.
- Explore **multibrot sets** by changing the exponent parameter.
- View and update **viewport coordinates** on the complex plane.

## Gallery

Explore some stunning images generated with Mandelbrot.site:

<img src="https://raw.githubusercontent.com/rosslh/mandelbrot.site/main/example-images/mandelbrot-01.png" height="200px" alt="Mandelbrot Example 1"> <img src="https://raw.githubusercontent.com/rosslh/mandelbrot.site/main/example-images/mandelbrot-02.png" height="200px" alt="Mandelbrot Example 2">

[View more images](/example-images)

## Architecture

Mandelbrot.site is built using modern web technologies to deliver a high-performance, interactive tool for exploring fractals. The computational backend is implemented in [Rust](https://github.com/rust-lang/rust), chosen for its performance and safety features. This Rust code is compiled to [WebAssembly](https://webassembly.org/) (Wasm) using the [wasm-pack](https://github.com/rustwasm/wasm-pack) plugin, enabling high-speed computations directly in the browser. On the frontend, the user interface is crafted with [TypeScript](https://github.com/microsoft/TypeScript), enhancing code quality and maintainability. [Leaflet.js](https://github.com/Leaflet/Leaflet) is creatively adapted to render the Mandelbrot set tiles in a zoomable, map-like interface.

For performance optimization, it employs [Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API) via the [threads.js](https://github.com/andywer/threads.js) library. This setup prevents intensive computations from blocking the main browser thread by creating a pool of workers that handle the generation of Mandelbrot set tiles in parallel. A key optimization technique used is "rectangle checking," which saves computation time for areas entirely within the set by checking only the perimeter of a tile.

It is a [Progressive Web App](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps) (PWA), leveraging [Service Workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API) to prioritize a local-first experience. This ensures that users can explore the Mandelbrot set with minimal network dependencies.

This robust architecture allows Mandelbrot.site to provide a seamless and responsive experience for users exploring the intricate details of the Mandelbrot set through an online interface.

## Development

This project requires [Node.js](https://nodejs.org/) to be installed on your system. Check the [`client/.nvmrc`](client/.nvmrc) file for the recommended Node.js version. Development scripts are available in [`client/package.json`](client/package.json).

A complete guide can be found in [CONTRIBUTING.md](CONTRIBUTING.md#your-first-code-contribution).

## Contributors

Many thanks to the following contributors who have helped shape this project:

|                                                                                                                    | Name                     | GitHub Profile                                                              |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------ | --------------------------------------------------------------------------- |
| <img src="https://avatars.githubusercontent.com/u/8635605?v=4" width="50" height="50" alt="Ross Hill">             | **Ross Hill**            | [rosslh](https://github.com/rosslh)                                         |
| <img src="https://avatars.githubusercontent.com/u/122646?v=4" width="50" height="50" alt="Joseph Weissman">        | **Joseph Weissman**      | [jweissman](https://github.com/jweissman)                                   |
| <img src="https://avatars.githubusercontent.com/u/78155393?v=4" width="50" height="50" alt="Shubhankar Shandilya"> | **Shubhankar Shandilya** | [shubhankar-shandilya-india](https://github.com/shubhankar-shandilya-india) |

Want to contribute? Check out the list of [open issues](https://github.com/rosslh/Mandelbrot.site/issues) and read our [contributing guidelines](CONTRIBUTING.md).
