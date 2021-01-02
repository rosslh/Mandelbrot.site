# Rust Mandelbrot Set Explorer

This project is based on [this Rust WASM worker template](https://github.com/DDR0/large-graph-editor/tree/updated-deps).

## Code directory

- [Leaflet tile generation - <code>www/app/main.js</code>](www/app/main.js)
- [Web Worker - <code>www/worker/worker.js</code>](www/worker/worker.js)
- [Mandelbrot set code - <code>crate-wasm/src/lib.rs</code>](crate-wasm/src/lib.rs)

## Building locally

This template comes pre-configured with all the boilerplate for compiling Rust
to WebAssembly and hooking into a Webpack build pipeline.

- In the project base directory, `~`, run `cargo build`.

- `npm run start` -- Serve the project locally for development at `http://localhost:8080`.

- `npm run build` -- Bundle the project (in production mode).

- If you need to change dependancies and get weird errors, try running `./clean.sh` to purge all caches.
