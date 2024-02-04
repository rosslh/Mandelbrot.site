# Rust Mandelbrot Set Explorer

[Rust Mandelbrot Set Explorer](https://rust-mandelbrot.netlify.app) is a web app that lets you explore the Mandelbrot set fractal. Built with Rust, compiled to WebAssembly, running on Web Workers.

[![img](https://raw.githubusercontent.com/rosslh/rust-mandelbrot-set/master/readme-images/site-image.png)](https://rust-mandelbrot.netlify.app)

[![img](https://raw.githubusercontent.com/rosslh/rust-mandelbrot-set/master/readme-images/example-output.png)](https://rust-mandelbrot.netlify.app)

## Code directory

- [Mandelbrot set code - <code>mandelbrot/src/lib.rs</code>](mandelbrot/src/lib.rs)
- [Rust tests - <code>mandelbrot/src/lib_test.rs</code>](mandelbrot/src/lib_test.rs)
- [Web Worker - <code>client/app/worker.ts</code>](client/app/worker.ts)
- [Leaflet tile generation - <code>client/app/main.ts</code>](client/app/main.ts)

## Features

- Set max iterations to adjust speed vs render quality
- "Multibrot" sets can be rendered by increasing the exponent parameter
- Adjust the size of map tiles
- Enter fullscreen mode
- Save the visible portion of the fractal as an image

## Local development

- Build scripts are available in [<code>client/package.json</code>](client/package.json). You can use the following commands from within `client/`:
  - `npm install` -- Install npm dependencies
  - `npm run start` -- Serve the project locally for development at `http://localhost:9090`
  - `npm run build` -- Build the project for production
  - `npm run test` -- Run Rust tests
  - `npm run lint` -- Find problems with code

If you get weird errors, try running `./clean.sh` to purge all dependency caches.
