# 🦀🕸 `rust-wasm-worker-template`

[![Build Status](https://travis-ci.org/VictorGavrish/rust-wasm-worker-template.svg?branch=master)](https://travis-ci.org/VictorGavrish/rust-wasm-worker-template)

> **Kickstart your Rust, WebAssembly, Webpack and Web Worker project!**

This template is designed for creating monorepo-style Web applications with
Rust-generated WebAssembly running inside a Web Worker and Webpack without
publishing your wasm to NPM.

## 🔋 Batteries Included

This template comes pre-configured with all the boilerplate for compiling Rust
to WebAssembly and hooking into a Webpack build pipeline.

- `npm run start` -- Serve the project locally for development at
  `http://localhost:8080`.

- `npm run build` -- Bundle the project (in production mode).

## 🚴 Using This Template

- In the project base directory, `~`, run `cargo build`.
- In `~/www`, run `npm install`.
- If you need to change dependancies and get weird errors, try running `./clean.sh` to purge all caches.