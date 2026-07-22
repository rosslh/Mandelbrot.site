---
title: How Mandelbrot.site Was Built
excerpt: Learn how Mandelbrot.site uses browser-based rendering, map-style navigation, and deep-zoom mathematics to make fractal exploration fast.
---

Mandelbrot.site is a web-based viewer for exploring the Mandelbrot set by panning, zooming, changing colors, and saving interesting views. The goal is to make a mathematically rich object feel as immediate as using an online map.

The site is built with Rust, WebAssembly, TypeScript, and Leaflet.js. Leaflet is usually used for geographic maps, but it works well here because the Mandelbrot set can also be explored as a tiled, zoomable surface. Instead of requesting map tiles from a server, the app generates fractal tiles in the browser.

## What You Can Do

The viewer includes the controls people expect from an exploratory tool, plus some that reward a closer look:

- **Unlimited zoom:** Zoom into any region with the mouse, trackpad, or area selection, far past the point where ordinary computer arithmetic gives out. A caption keeps the scale relatable: if the whole set were the size of Earth, it tells you whether your view is the size of a city, a coin, or an atom.
- **Coloring modes:** Beyond classic escape-time coloring, a distance-estimate mode draws crisp boundary images and an "atom domain" mode colors regions by their mathematical period. A histogram slider spreads the palette evenly across whatever is on screen, and color changes apply instantly without re-rendering.
- **Point inspection:** Hold ctrl and hover to see any point's exact coordinates, how quickly it escapes, how far it sits from the set's boundary, and its orbit period. Click to pin the readout and copy full-precision coordinates.
- **Julia navigator:** A sidebar panel live-previews the Julia set for the point under your cursor, and doubles as a minimap of the full set.
- **Pinned locations:** Save, rename, and revisit interesting places.
- **Multibrot sets:** Explore related fractals by changing the exponent in the formula.
- **Export:** Save high-resolution PNG images with the view's parameters embedded in the file, download the raw iteration data, or record a zoom animation as a video.
- **Shareable views:** Create URLs that open the same location and settings.

## How It Works

The calculation-heavy part of the viewer is written in Rust and compiled to WebAssembly. This keeps the fractal rendering fast while still running inside the browser. The user interface is written in TypeScript, which helps keep the application predictable as features are added.

Generating a Mandelbrot image can take real work, especially at deeper zoom levels. To keep the page responsive, the app uses Web Workers through `threads.js`. These workers calculate tiles away from the main browser thread, so panning and zooming can stay smooth while new imagery is being produced.

When a tile is needed, the app queues the job, sends the tile bounds to the WebAssembly module, and receives pixel data back for display. The work is split into small pieces so the viewer can fill in the screen progressively instead of waiting for one large render to finish.

One useful optimization is "rectangle checking." When a region's boundary can be confirmed as inside the Mandelbrot set, the app can fill it without testing every single point. That saves time in large solid regions, where extra calculation would not change the final image.

## Zooming Past Floating Point

Ordinary 64-bit numbers run out of precision surprisingly quickly: deep enough into a zoom, neighboring pixels become mathematically identical and the image dissolves into blocks. Mandelbrot.site keeps going by using perturbation theory: it computes one point per view with extremely high precision, then describes every other pixel as a tiny offset from that reference. The offsets are small enough for fast hardware arithmetic, so deep views stay quick even though the underlying coordinates have hundreds of digits.

## Making It Fast

Performance work on the site is measured, not guessed. A benchmark harness runs candidate builds in a real copy of Chrome against a corpus of views, including views real users actually visited, and compares them against the current build. A change only ships if it is measurably faster and produces exactly the same pixels, and every experiment is logged so the same question never gets investigated twice. That process has paid for itself: the renderer now uses SIMD instructions to compute several pixels at once, and browsers that support the newest WebAssembly features automatically receive an even faster build.

## Conclusion

Mandelbrot.site combines a familiar map-style interface with in-browser computation. Rust and WebAssembly handle the demanding calculations, while TypeScript and Leaflet provide the interactive experience around them.

The project will continue to improve, but its core idea is already in place: make fractal exploration fast, visual, and easy to share.
