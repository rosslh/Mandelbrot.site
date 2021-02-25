# Rust Mandelbrot Set Explorer

This project is based on [this Rust WASM worker template](https://github.com/DDR0/large-graph-editor/tree/updated-deps).

## Code directory

- [Mandelbrot set code - <code>mandelbrot/src/lib.rs</code>](mandelbrot/src/lib.rs)
- [Rust tests - <code>mandelbrot/src/lib_test.rs</code>](mandelbrot/src/lib_test.rs)
- [Web Worker - <code>client/app/worker.js</code>](client/app/worker.js)
- [Leaflet tile generation - <code>client/app/main.ts</code>](client/app/main.ts)

## Local development

- Build scripts are available in [<code>client/package.json</code>](client/package.json). You can use the following commands from within `client/`:
    - `npm install` -- Install npm dependencies
    - `npm run start` -- Serve the project locally for development at `http://localhost:9090`
    - `npm run build` -- Build the project for production
    - `npm run test` -- Run Rust tests
    - `npm run lint` -- Find problems with code
    - `npm run format` -- Fix code formatting

If you get weird errors, try running `./clean.sh` to purge all dependency caches.
