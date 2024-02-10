# mandelbrot.site

_Formerly known as Rust Mandelbrot Set Explorer_

[mandelbrot.site](https://mandelbrot.site) is a web app that lets you explore the Mandelbrot set fractal. Built with Rust (compiled to WASM) and TypeScript.

## Project Structure

- **Mandelbrot Set Implementation**: [`mandelbrot/src/lib.rs`](mandelbrot/src/lib.rs)
- **Rust Unit Tests**: [`mandelbrot/src/lib_test.rs`](mandelbrot/src/lib_test.rs)
- **TypeScript Entry Point**: [`client/app/main.ts`](client/app/main.ts)

## Key Features

- **Dynamic Zoom**: Use your mouse to scroll or select a region, diving deeper into the fractal.
- **Iteration Adjustment**: Control the detail level with iteration count.
- **Multibrot Sets**: Explore "multibrot" sets by changing the exponent.
- **High-Resolution Rendering**: Enjoy crystal clear fractal images.
- **Customizable Color Schemes**: Personalize your fractal exploration.
- **Viewport Coordinates**: View and update the viewport's coordinates.
- **Image Export**: Save your discoveries as PNG images.
- **Shareable Views**: Generate URLs to share your current view with others.

## Gallery

View some of the stunning images generated with mandelbrot.site:

[![Mandelbrot Set Image](https://raw.githubusercontent.com/rosslh/mandelbrot.site/master/example-images/mandelbrot-4.png)](https://mandelbrot.site)

[![Mandelbrot Set Image](https://raw.githubusercontent.com/rosslh/mandelbrot.site/master/example-images/mandelbrot-2.png)](https://mandelbrot.site)

[Explore more images](/example-images)

## Getting Started Locally

To set up and run the project on your local environment, navigate to the `client/` directory and use the following commands:

- **Install Dependencies**: `npm install`
- **Start Development Server**: `npm run start` - serves the project at `http://localhost:9090`
- **Build for Production**: `npm run build`
- **Run Rust Tests**: `npm run test`
- **Lint**: `npm run lint` - identifies potential code issues
- **Cleanup**: `npm run clean` - removes caches and build artifacts
