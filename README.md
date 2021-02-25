# Rust Mandelbrot Set Explorer

This project is based on [this Rust WASM worker template](https://github.com/DDR0/large-graph-editor/tree/updated-deps).

## Code directory

- [Mandelbrot set code - <code>crate-wasm/src/lib.rs</code>](crate-wasm/src/lib.rs)
- [Rust tests - <code>crate-wasm/src/lib_test.rs</code>](crate-wasm/src/lib_test.rs)
- [Web Worker - <code>www/app/worker.js</code>](www/app/worker.js)
- [Leaflet tile generation - <code>www/app/main.ts</code>](www/app/main.ts)

## Local development

- Build scripts are available in [<code>www/package.json</code>](www/package.json). You can use the following commands from within `www/`:
    - `npm install` -- Install npm dependencies
    - `npm run start` -- Serve the project locally for development at `http://localhost:9090`
    - `npm run build` -- Build the project for production
    - `npm run test` -- Run Rust tests
    - `npm run lint` -- Find problems with code
    - `npm run format` -- Fix code formatting

If you get weird errors, try running `./clean.sh` to purge all dependency caches.
