---
title: How Mandelbrot.site Was Built
excerpt: Learn how Mandelbrot.site uses browser-based rendering, map-style navigation, and shareable views to make fractal exploration fast.
---

Mandelbrot.site is a web-based viewer for exploring the Mandelbrot set by panning, zooming, changing colors, and saving interesting views. The goal is to make a mathematically rich object feel as immediate as using an online map.

The site is built with Rust, WebAssembly, TypeScript, and Leaflet.js. Leaflet is usually used for geographic maps, but it works well here because the Mandelbrot set can also be explored as a tiled, zoomable surface. Instead of requesting map tiles from a server, the app generates fractal tiles in the browser.

## Integration and Workflow

The calculation-heavy part of the viewer is written in Rust and compiled to WebAssembly. This keeps the fractal rendering fast while still running inside the browser. The user interface is written in TypeScript, which helps keep the application predictable as features are added.

Generating a Mandelbrot image can take real work, especially at deeper zoom levels. To keep the page responsive, the app uses Web Workers through `threads.js`. These workers calculate tiles away from the main browser thread, so panning and zooming can stay smooth while new imagery is being produced.

When a tile is needed, the app queues the job, sends the tile bounds to the WebAssembly module, and receives pixel data back for display. The work is split into small pieces so the viewer can fill in the screen progressively instead of waiting for one large render to finish.

One useful optimization is "rectangle checking." When a tile's boundary can be confirmed as inside the Mandelbrot set, the app can fill the tile without testing every single point. That saves time in large solid regions, where extra calculation would not change the final image.

## User Interface and Features

The viewer includes the controls people expect from an exploratory tool:

- **Dynamic zoom:** Zoom into any region with the mouse, trackpad, or area selection.
- **Iteration adjustment:** Increase detail for deeper views or lower it for faster rendering.
- **Multibrot sets:** Explore related fractals by changing the exponent in the formula.
- **Color palettes:** Switch the visual style without changing the underlying math.
- **Viewport coordinates:** See where the current view sits on the complex plane.
- **Image export:** Save high-resolution PNG images.
- **Shareable views:** Create URLs that open the same location and settings.

## Conclusion

Mandelbrot.site combines a familiar map-style interface with in-browser computation. Rust and WebAssembly handle the demanding calculations, while TypeScript and Leaflet provide the interactive experience around them.

The project will continue to improve, but its core idea is already in place: make fractal exploration fast, visual, and easy to share.
