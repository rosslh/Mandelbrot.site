# Contributing to Mandelbrot.site

Thanks for helping improve Mandelbrot.site. This guide covers the main ways to contribute and the commands you need for local development.

## Code of Conduct

This project follows the [Mandelbrot.site Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold it. Report unacceptable behavior to <mandelbrot@rosshill.ca>.

## Questions

Search the existing [issues](https://github.com/rosslh/Mandelbrot.site/issues) first. If you do not find an answer, open a new issue and include the context a maintainer would need, such as what you tried, what you expected, and any relevant browser, Node.js, npm, or Rust versions.

## Reporting Bugs

Before filing a bug, check the [bug tracker](https://github.com/rosslh/Mandelbrot.site/issues?q=label%3Abug) to see whether it has already been reported. A useful bug report includes:

- Clear steps to reproduce the problem.
- What you expected to happen and what actually happened.
- Error messages, stack traces, screenshots, or screen recordings when helpful.
- Browser, operating system, Node.js, npm, and Rust versions when relevant.

## Suggesting Enhancements

Enhancement suggestions are tracked as [GitHub issues](https://github.com/rosslh/Mandelbrot.site/issues). Search existing issues before opening a new one, then describe the current behavior, the change you want, and why it would help users. Screenshots or GIFs are useful for interface ideas.

## Your First Code Contribution

> [!IMPORTANT]
> By contributing to this project, you agree that you have authored 100% of the content, have the necessary rights to the content, and that the content you contribute may be provided under the project license.

Before running the project, you'll need to fork and clone the repository:

1. **Fork the repository** on GitHub.
2. **Clone your fork** to your local machine:

   ```bash
   git clone https://github.com/your-username/Mandelbrot.site.git
   ```

### Running the Project

Install [Node.js](https://nodejs.org/) and [Rust](https://rust-lang.org/) first. The recommended Node.js version is in [`client/.nvmrc`](client/.nvmrc).

From the repository root, start the development server with:

```bash
cd client
npm install
npm run dev
```

Other useful commands:

Run these from the `client` directory:

- `npm run build`: build the production app.
- `npm run serve`: preview the production build from `client/dist`.
- `npm run typecheck`: check TypeScript types.
- `npm run lint`: run ESLint and Rust clippy.
- `npm run format`: format TypeScript, CSS, HTML, and Rust files.
- `npm run test`: run the Rust test suite.
- `npm run clean`: remove local dependencies, caches, and build output.

### Project Structure

Important paths:

- [`mandelbrot/src/lib.rs`](mandelbrot/src/lib.rs): Rust Mandelbrot renderer (direct f64 tier).
- [`mandelbrot/src/perturbation.rs`](mandelbrot/src/perturbation.rs): deep-zoom rendering via perturbation theory.
- [`mandelbrot/src/float_exp.rs`](mandelbrot/src/float_exp.rs): extended-exponent floats for very deep zooms.
- [`mandelbrot/src/lib_test.rs`](mandelbrot/src/lib_test.rs): Rust tests and snapshots.
- [`client/js`](client/js): front-end behavior, tile mapping, and controls.
- [`client/html`](client/html): HTML templates.
- [`client/css`](client/css): styles.
- [`client/blog`](client/blog): blog content.
- [`bench`](bench): WebAssembly performance benchmark harness (see [`bench/README.md`](bench/README.md)).

### Performance Changes

Changes that could affect rendering speed (the Rust code, build flags, or the worker pipeline) should be measured with the benchmark harness in [`bench`](bench) rather than eyeballed. The harness compares a candidate build against a pinned baseline across a corpus of real and synthetic views and verifies that output stays pixel-identical. Results, positive or negative, are recorded in [`bench/LOG.md`](bench/LOG.md) so settled questions are not re-run.

### Opening a Pull Request

1. Make your changes in a focused branch.
2. Run the checks that match your change. From `client`, code changes should run at least:

   ```bash
   npm run typecheck
   npm run lint
   npm run test
   ```

3. Commit with a clear message:

   ```bash
   git add .
   git commit -m "Describe your change"
   ```

4. Push your branch and open a pull request against the main repository's `main` branch.
5. In the pull request, explain what changed, why it changed, and how you tested it.

For detailed guidance, see [Creating a Pull Request](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/creating-a-pull-request).
