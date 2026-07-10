const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const WasmPackPlugin = require("@wasm-tool/wasm-pack-plugin");
const { marked } = require("marked");
const frontMatter = require("front-matter");
const fs = require("fs");
const camelCase = require("lodash/camelCase");
const fromPairs = require("lodash/fromPairs");
const Dotenv = require("dotenv-webpack");

const dist = path.resolve(__dirname, "dist");

function getBlogPostPlugins() {
  const blogDir = "./blog";
  const blogPostPlugins = [];

  for (const file of fs.readdirSync(blogDir)) {
    if (!file.endsWith(".md")) continue;

    const md = fs.readFileSync(path.join(blogDir, file), "utf8");
    const { attributes, body } = frontMatter(md);
    const html = marked(body);
    const htmlFile = file.replace(".md", ".html");
    const slug = htmlFile.replace(/\.html$/, "");
    const slugCamel = camelCase(slug);

    const linkClasses = fromPairs(
      [
        "howMandelbrotSiteWasBuiltClass",
        "whatIsMandelbrotSetClass",
        "historyOfMandelbrotSetClass",
        "whoWasBenoitMandelbrotClass",
        "whyMandelbrotSetImportantClass",
      ].map((c) => {
        const checkSlug = c.split("Class")[0];
        return [c, slugCamel === checkSlug ? "active" : ""];
      }),
    );

    blogPostPlugins.push(
      new HtmlWebpackPlugin({
        filename: htmlFile,
        template: "./html/blog-template.html",
        templateParameters: {
          title: attributes.title,
          description: attributes.excerpt,
          content: html,
          slug,
          ...linkClasses,
        },
      }),
    );
  }

  return blogPostPlugins;
}

const privacyPolicyPlugin = new HtmlWebpackPlugin({
  filename: "privacy-policy.html",
  template: path.join(__dirname, "html", "privacy-policy.html"),
});

const blogPostPlugins = getBlogPostPlugins();

// The service worker is generated after the build by `generate-sw.js`, which
// globs the complete `dist` so the app bundle and the worker/WASM (emitted by a
// separate webpack compilation) are precached together as one consistent set.
const appConfig = {
  entry: "./js/index.ts",
  plugins: [
    new Dotenv({ systemvars: true }),
    new HtmlWebpackPlugin({
      template: "html/index.html",
      root: path.resolve(__dirname, "."),
    }),
    ...blogPostPlugins,
    privacyPolicyPlugin,
    new MiniCssExtractPlugin(),
  ],
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: [
          {
            loader: "ts-loader",
            options: {
              transpileOnly: true,
              compilerOptions: {
                sourceMap: true,
              },
            },
          },
        ],
        exclude: /node_modules/,
      },
      {
        test: /\.(css|scss)$/i,
        use: [
          {
            loader: MiniCssExtractPlugin.loader,
            options: { publicPath: "css/" },
          },
          "css-loader",
          "sass-loader",
        ],
      },
      {
        test: /\.(png|jpe?g|gif|svg|ico)$/i,
        use: [{ loader: "file-loader?name=./static/[name].[ext]" }],
      },
      {
        test: /\.(webmanifest|xml)$/i,
        use: [{ loader: "file-loader?name=./[name].[ext]" }],
      },
    ],
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
  output: { path: dist, filename: "app.js" },
  experiments: { syncWebAssembly: true },
  devtool: "source-map",
};

const workerConfig = {
  entry: "./js/worker.js",
  target: "webworker",
  plugins: [
    new WasmPackPlugin({
      crateDirectory: path.resolve(__dirname, "../mandelbrot"),
    }),
  ],
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: [
          {
            loader: "ts-loader",
            options: {
              transpileOnly: true,
              compilerOptions: {
                sourceMap: true,
              },
            },
          },
        ],
        exclude: /node_modules/,
      },
      {
        test: /\.wasm$/,
        // Both wasm-pack outputs (pkg/ and pkg-relaxed/) are wasm modules
        // compiled by syncWebAssembly, not file assets.
        exclude: /pkg(-relaxed)?\/.*\.wasm$/,
        type: "asset/resource",
        generator: {
          filename: "[name][ext]",
        },
      },
    ],
  },
  resolve: {
    extensions: [".ts", ".js", ".wasm"],
  },
  output: { path: dist, filename: "worker.js" },
  experiments: { syncWebAssembly: true },
  devtool: "source-map",
};

module.exports = [appConfig, workerConfig];
