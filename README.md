<p align="center">
  <a href="https://mandelbrot.site">
    <img src="https://raw.githubusercontent.com/rosslh/mandelbrot.site/master/example-images/logo.png" height="50px" width="50px" alt="Mandelbrot Logo">
  </a>
</p>

<h1 align="center">Mandelbrot.site</h1>

<p align="center">
  <a href="https://mandelbrot.site">Mandelbrot.site</a> is an interactive fractal viewer that runs in the browser. It offers a fast and intuitive way to explore the Mandelbrot set and share your discoveries. This project is built with Rust, WebAssembly, TypeScript, and Leaflet.js.
</p>

<p align="center">
  <img src="https://img.shields.io/github/check-runs/rosslh/mandelbrot.site/master?style=flat&label=Checks" alt="GitHub branch check runs">
  <img src="https://img.shields.io/uptimerobot/status/m792388109-4c544ded2b0e440130ddd401?up_message=online&style=flat&label=Status" alt="Uptime Robot status">
  <img src="https://img.shields.io/uptimerobot/ratio/m792388109-4c544ded2b0e440130ddd401?style=flat&label=Uptime%20(1mo)" alt="Uptime Robot ratio (30 days)">
</p>

## Features

Mandelbrot.site offers a variety of features to enhance your experience:

- **Zoom in** by scrolling or selecting a region.
- Adjust the **detail level** by modifying the iteration count or resolution.
- Explore **multibrot sets** by changing the exponent parameter.
- Download **high-resolution images** of your view.
- Customize your experience with different **color palettes**.
- View and update **viewport coordinates** on the complex plane.
- Generate URLs to **share** your favorite views.

## Gallery

Explore some stunning images generated with Mandelbrot.site:

<table>
  <tr>
    <td><img src="https://raw.githubusercontent.com/rosslh/mandelbrot.site/master/example-images/mandelbrot-4.png" height="200px" alt="Mandelbrot Example"></td>
    <td><img src="https://raw.githubusercontent.com/rosslh/mandelbrot.site/master/example-images/mandelbrot-2.png" height="200px" alt="Mandelbrot Example"></td>
  </tr>
</table>

[Explore more images](/example-images)

## Architecture

Mandelbrot.site is built using modern web technologies to deliver a high-performance, interactive tool for exploring fractals. The computational backend is implemented in [Rust](https://github.com/rust-lang/rust), chosen for its performance and safety features. This Rust code is compiled to [WebAssembly](https://webassembly.org/) (Wasm) using the [wasm-pack](https://github.com/rustwasm/wasm-pack) plugin, enabling high-speed computations directly in the browser. On the frontend, the user interface is crafted with [TypeScript](https://github.com/microsoft/TypeScript), enhancing code quality and maintainability. To render the fractals, [Leaflet.js](https://github.com/Leaflet/Leaflet) is creatively adapted for this purpose.

For performance optimization, Mandelbrot.site employs [Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API) via the [threads.js](https://github.com/andywer/threads.js) library. This setup prevents intensive computations from blocking the main browser thread by creating a pool of workers that handle the generation of Mandelbrot set tiles in parallel. A key optimization technique used is "rectangle checking," which saves computation time for areas entirely within the set by checking only the perimeter of a tile.

This robust architecture ensures that Mandelbrot.site provides a seamless and responsive experience for users exploring the intricate details of the Mandelbrot set directly in their web browser.

## Development

To set up and run the project on your local environment, navigate to the `client` directory and use the following commands:

- **Install dependencies**: `npm install`
- **Build the project**: `npm run build`
- **Start development server**: `npm run start`
- **Run Rust tests**: `npm run test`
- **Identify code issues**: `npm run lint`
- **Cleanup**: `npm run clean` - removes caches and build artifacts

### Project Structure

- **Mandelbrot set implementation**: [`mandelbrot/src/lib.rs`](mandelbrot/src/lib.rs)
- **Rust unit tests**: [`mandelbrot/src/lib_test.rs`](mandelbrot/src/lib_test.rs)
- **TypeScript entry point**: [`client/js/main.ts`](client/js/main.ts)

## Contributors

Many thanks to the following contributors who have helped shape this project:

| Avatar                                                                                                             | Name                     | GitHub Profile                                                              |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------ | --------------------------------------------------------------------------- |
| <img src="https://avatars.githubusercontent.com/u/8635605?v=4" width="60" height="60" alt="Ross Hill">             | **Ross Hill**            | [rosslh](https://github.com/rosslh)                                         |
| <img src="https://avatars.githubusercontent.com/u/122646?v=4" width="60" height="60" alt="Joseph Weissman">        | **Joseph Weissman**      | [jweissman](https://github.com/jweissman)                                   |
| <img src="https://avatars.githubusercontent.com/u/78155393?v=4" width="60" height="60" alt="Shubhankar Shandilya"> | **Shubhankar Shandilya** | [shubhankar-shandilya-india](https://github.com/shubhankar-shandilya-india) |

Want to contribute? Check out the list of [open issues](https://github.com/rosslh/Mandelbrot.site/issues)!
