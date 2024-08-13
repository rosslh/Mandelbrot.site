# Mandelbrot.site

[Mandelbrot.site](https://mandelbrot.site) is a web-based viewer that allows you to explore the fascinating world of the Mandelbrot set, a mathematical fractal. The project leverages cutting-edge web technologies, including Rust, WebAssembly (Wasm), TypeScript, and Leaflet.js, to create a high-performance, interactive, and visually captivating experience.

![GitHub branch check runs](https://img.shields.io/github/check-runs/rosslh/mandelbrot.site/master?style=flat-square&label=Checks)
![Uptime Robot status](https://img.shields.io/uptimerobot/status/m792388109-4c544ded2b0e440130ddd401?up_message=online&style=flat-square&label=Status)
![Uptime Robot ratio (30 days)](<https://img.shields.io/uptimerobot/ratio/m792388109-4c544ded2b0e440130ddd401?style=flat-square&label=Uptime%20(1mo)>)

## Project Structure

- **Mandelbrot Set Implementation**: [`mandelbrot/src/lib.rs`](mandelbrot/src/lib.rs)
- **Rust Unit Tests**: [`mandelbrot/src/lib_test.rs`](mandelbrot/src/lib_test.rs)
- **TypeScript Entry Point**: [`client/js/main.ts`](client/js/main.ts)

## Key Features

- **Dynamic Zoom**: Use your mouse to scroll or select a region, diving deeper into the fractal.
- **Iteration Adjustment**: Control the detail level with iteration count.
- **Multibrot Sets**: Explore "multibrot" sets by changing the exponent.
- **High-Resolution Rendering**: Enjoy crystal clear fractal images.
- **Customizable Color Schemes**: Personalize your fractal exploration.
- **Viewport Coordinates**: View and update the viewport's coordinates on the complex plane.
- **Image Export**: Save your discoveries as PNG images.
- **Shareable Views**: Generate URLs to share your current view with others.

## Gallery

View some of the stunning images generated with mandelbrot.site:

![Mandelbrot Set Image](https://raw.githubusercontent.com/rosslh/mandelbrot.site/master/example-images/mandelbrot-4.png)

![Mandelbrot Set Image](https://raw.githubusercontent.com/rosslh/mandelbrot.site/master/example-images/mandelbrot-2.png)

[Explore more images](/example-images)

## Getting Started Locally

To set up and run the project on your local environment, navigate to the `client/` directory and use the following commands:

- **Install Dependencies**: `npm install`
- **Start Development Server**: `npm run start` - serves the project at `http://localhost:9090`
- **Build for Production**: `npm run build`
- **Run Rust Tests**: `npm run test`
- **Lint**: `npm run lint` - identifies potential code issues
- **Cleanup**: `npm run clean` - removes caches and build artifacts

## Contributors

Many thanks to the following contributors who have helped shape this project:

<!-- readme: collaborators,contributors,ImgBotApp/- -start -->
<!-- readme: collaborators,contributors,ImgBotApp/- -end -->
