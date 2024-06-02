---
title: How Mandelbrot.site Was Built
excerpt: Learn about the architecture of Mandelbrot.site, an advanced web-based viewer designed to navigate the Mandelbrot set in stunning detail.
---

Exploring the intricacies of the Mandelbrot set through a web-based viewer provides a fascinating insight into the beauty of mathematics and complex systems. This Mandelbrot set viewer leverages modern web technologies, including Rust, WebAssembly (Wasm), TypeScript, and Leaflet.js, to deliver a high-performance, interactive fractal exploration tool. This blog post delves into the technical architecture, challenges, and innovative solutions employed in the creation of this viewer.

The Mandelbrot set viewer is designed to allow users to navigate and explore different regions of the Mandelbrot set in high resolution by panning and zooming. The application uses a map interface powered by Leaflet.js, which is traditionally used for geospatial data applications but has been creatively adapted for rendering fractals.

## Integration and Workflow

The computational backend of the viewer is written in Rust, a language chosen for its performance and safety features. Rust code is compiled to WebAssembly using a webpack plugin called `wasm-pack`, which simplifies the integration of Wasm with the frontend technologies. The frontend of the viewer is developed using TypeScript, enhancing code quality and maintainability with its strong typing system.

To prevent the intensive computations from blocking the main browser thread, it utilizes Web Workers through the `threads.js` library, which facilitates creating a pool of workers. These workers handle the generation of Mandelbrot set tiles. When a tile is needed, it is queued, and workers fetch tasks from this queue as they become available.

The Wasm module accepts the bounds of a tile and computes the Mandelbrot set for those bounds. The result is then encoded as a `Uint8ClampedArray` and transferred back to the main thread to be rendered on the map.

One of the significant optimizations in this application is "rectangle checking." Utilizing the property that the Mandelbrot set is connected, it first checks the perimeter of a tile. If the entire perimeter is determined to be within the set, we can infer that all points within are also part of the set, thus saving immense computation time by avoiding checking every point individually.

## User Interface and Features

The viewer is equipped with a range of interactive features:

- **Dynamic Zoom:** Users can zoom into any region of the set using mouse scroll or by selecting a specific area, facilitating deep exploration.
- **Iteration Adjustment:** This feature allows users to adjust the number of iterations used in the calculations, affecting the detail and rendering time of the fractal.
- **Multibrot Sets:** Beyond the traditional Mandelbrot set, users can explore multibrot sets by adjusting the exponent in the generating formula.
- **Customizable Color Schemes:** Users can personalize their visual experience by choosing different color schemes.
- **Viewport Coordinates:** Display and update the coordinates of the current viewport on the complex plane.
- **Image Export:** High-resolution images of the fractal can be saved as PNG files.
- **Shareable Views:** Users can generate URLs that encapsulate their current view, allowing them to share their fractal explorations with others.

## Challenges and Solutions

Integrating high-performance computational code with a web-based interface posed several challenges, particularly in terms of performance optimization and seamless integration of different technologies. The use of WebAssembly and Web Workers helped overcome these by offloading the computational workload and enabling parallel processing.

## Conclusion

The Mandelbrot set viewer is a testament to the capabilities of modern web technologies and the power of Rust, WebAssembly, and TypeScript in creating complex, CPU-intensive web applications. This project not only provides a tool for mathematical exploration but also showcases how traditional web mapping tools like Leaflet.js can be extended beyond their typical use cases.

This viewer is an ongoing project, and I will continue to refine its functionality and performance, ensuring it remains an exciting tool for both educational purposes and personal exploration for enthusiasts and researchers alike.
