# Contributing to Mandelbrot.site

Thank you for taking the time to contribute! ❤️

All types of contributions are encouraged and valued. Please refer to the [Table of Contents](#table-of-contents) for various ways you can help and details on how the project handles them. Reading the relevant section before contributing will make it easier for the maintainers and smooth out the experience for everyone involved. The community looks forward to your contributions.

> [!TIP]
> If you like the project but don't have time to contribute, that's totally fine! There are other ways to show your support:
>
> - Star the project
> - Tweet about it
> - Mention this project in your project's readme
> - Share it with your friends and colleagues

## Table of Contents

- [Contributing to Mandelbrot.site](#contributing-to-mandelbrotsite)
  - [Table of Contents](#table-of-contents)
  - [Code of Conduct](#code-of-conduct)
  - [I Have a Question](#i-have-a-question)
  - [Reporting Bugs](#reporting-bugs)
    - [Before Submitting a Bug Report](#before-submitting-a-bug-report)
    - [How Do I Submit a Good Bug Report?](#how-do-i-submit-a-good-bug-report)
  - [Suggesting Enhancements](#suggesting-enhancements)
    - [Before Submitting an Enhancement](#before-submitting-an-enhancement)
    - [How Do I Submit a Good Enhancement Suggestion?](#how-do-i-submit-a-good-enhancement-suggestion)
  - [Your First Code Contribution](#your-first-code-contribution)
    - [Running the Project](#running-the-project)
    - [Project Structure](#project-structure)
    - [Opening a Pull Request](#opening-a-pull-request)

## Code of Conduct

This project and everyone participating in it are governed by the [Mandelbrot.site Code of Conduct](https://github.com/rosslh/Mandelbrot.site/blob/master/CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to <mandelbrot@rosshill.ca>.

## I Have a Question

Before asking a question, please search for existing [issues](https://github.com/rosslh/Mandelbrot.site/issues) that might help you. If you find a relevant issue but still need clarification, you can comment there. It's also advisable to search the internet first.

If you still have a question:

- Open a new [issue](https://github.com/rosslh/Mandelbrot.site/issues/new).
- Provide as much context as possible.
- Include project and platform versions (Node.js, npm, etc.) as relevant.

We will address your issue as soon as possible.

## Reporting Bugs

### Before Submitting a Bug Report

A good bug report shouldn't leave others needing more information. Please investigate carefully, collect details, and describe the issue thoroughly. Before submitting, please:

- Ensure you're using the latest version.
- Determine if your issue is indeed a bug and not a misconfiguration or environment issue. If you need support, check [this section](#i-have-a-question).
- Check the [bug tracker](https://github.com/rosslh/Mandelbrot.site/issues?q=label%3Abug) to see if the issue has already been reported.
- Search the internet (including Stack Overflow) to see if others have encountered the issue.
- Collect relevant information:
  - Stack trace or error messages
  - Operating system, platform, and version (e.g., Windows 10 x64)
  - Versions of Node.js, npm, and other relevant software
  - Steps to reproduce the issue reliably
  - Any relevant input and output

### How Do I Submit a Good Bug Report?

We use GitHub issues to track bugs and errors. If you encounter an issue:

- Open a new [issue](https://github.com/rosslh/Mandelbrot.site/issues/new).
- Describe the expected behavior and the actual behavior.
- Provide as much context as possible, including steps to reproduce the issue.
- Include the information you collected above.

Once filed:

- The team will label the issue accordingly.
- A team member will try to reproduce the issue. If reproduction steps are missing or unclear, we may ask for more details.
- If the issue is confirmed, it will be labeled appropriately and left to be [implemented](#your-first-code-contribution).

## Suggesting Enhancements

This section guides you through submitting an enhancement suggestion for Mandelbrot.site, **including completely new features and minor improvements to existing functionality**.

### Before Submitting an Enhancement

- Ensure you're using the latest version.
- Search the [issues](https://github.com/rosslh/Mandelbrot.site/issues) to see if the enhancement has already been suggested. If so, comment on the existing issue.
- Consider whether your idea fits within the scope of the project. Make a strong case for your suggestion.

### How Do I Submit a Good Enhancement Suggestion?

Enhancement suggestions are tracked as [GitHub issues](https://github.com/rosslh/Mandelbrot.site/issues).

- Use a **clear and descriptive title**.
- Provide a **detailed description** of the enhancement.
- **Describe the current behavior** and **explain the desired behavior**.
- Include **screenshots or GIFs** if helpful.
- **Explain why this enhancement would be useful** to most users.

## Your First Code Contribution

> [!IMPORTANT]
> By contributing to this project, you agree that you have authored 100% of the content, have the necessary rights to the content, and that the content you contribute may be provided under the project license.

Before running the project, you'll need to fork and clone the repository:

1. **Fork the repository** on GitHub.
2. **Clone your fork** to your local machine:

   ```bash
   git clone https://github.com/your-username/Mandelbrot.site.git
   ```

Now you can run the project and start making changes to the code! We recommend using a modern code editor like Visual Studio Code, IntelliJ IDEA, or Neovim.

### Running the Project

Once you've cloned the repository, you can begin working on the project. This project requires [Node.js](https://nodejs.org/) and [Rust](https://rust-lang.org/) to be installed on your system. Check the [`.nvmrc`](client/.nvmrc) file for the recommended Node.js version. [Rust](https://rust-lang.org/) is also required to build the project.

Run all commands from within the `client` directory:

- **Install dependencies**: `npm install`
- **Build the project**: `npm run build`
- **Start development server**: `npm run dev`
- **Run code quality checks**:
  - Type errors: `npm run typecheck`
  - Linting: `npm run lint`
  - Formatting: `npm run format`
  - Rust tests: `npm run test`
- **Preview production build**: `npm run serve`
- **Clean caches and build artifacts**: `npm run clean`

### Project Structure

Below is an overview of important files and directories to help you navigate and understand the codebase.

- Rust Mandelbrot set implementation
  - **Mandelbrot set image generator**: [`mandelbrot/src/lib.rs`](mandelbrot/src/lib.rs)
  - **Unit tests**: [`mandelbrot/src/lib_test.rs`](mandelbrot/src/lib_test.rs)
- Front-end logic and UI
  - **Tile mapping and input handling**: [`client/js`](client/js)
  - **UI structure**: [`client/html`](client/html)
  - **Styling**: [`client/css`](client/css)
  - **Blog content**: [`client/blog`](client/blog)

### Opening a Pull Request

1. **Make your changes** and **commit** them with clear commit messages:

   ```bash
   git add .
   git commit -m "Add feature XYZ"
   ```

2. **Push your changes** to your fork:

   ```bash
   git push origin main
   ```

3. **Open a pull request** from your branch to the main repository's `main` branch.
4. In the pull request, **provide a clear description** of your changes and any relevant context.
5. A maintainer will review your PR and may request changes or provide feedback.
6. Once you've addressed all of the feedback, kick back and wait for your PR to be merged! 🎉

For detailed guidance, see [Creating a Pull Request](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/creating-a-pull-request).
