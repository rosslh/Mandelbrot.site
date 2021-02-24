# Rust Mandelbrot Set Explorer

This project is based on [this Rust WASM worker template](https://github.com/DDR0/large-graph-editor/tree/updated-deps).

## Code directory

- [Mandelbrot set code - <code>crate-wasm/src/lib.rs</code>](crate-wasm/src/lib.rs)
- [Web Worker - <code>www/app/worker.js</code>](www/app/worker.js)
- [Leaflet tile generation - <code>www/app/main.ts</code>](www/app/main.ts)

## Local development

- Within the `www/` directory, run these commands:
    - `npm install` -- Install npm dependencies
    - `npm run build` -- Build the project
    - `npm run start` -- Serve the project locally for development at `http://localhost:8080`.
- If you need to change dependencies and get weird errors, try running `./clean.sh` to purge all caches.
