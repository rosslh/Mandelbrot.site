const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const dist = path.resolve(__dirname, "dist");
const WasmPackPlugin = require("@wasm-tool/wasm-pack-plugin");
const { marked } = require("marked");
const frontMatter = require("front-matter");
const fs = require("fs");
const template = require("lodash/template");
const camelCase = require("lodash/camelCase");
const fromPairs = require("lodash/fromPairs");
const Dotenv = require("dotenv-webpack");
const WorkboxPlugin = require("workbox-webpack-plugin");

if (!fs.existsSync("./dist")) {
  fs.mkdirSync("./dist");
}

const privacyPolicySrc = path.join(__dirname, "html", "privacy-policy.html");
const privacyPolicyDest = path.join(__dirname, "dist", "privacy-policy.html");
fs.copyFileSync(privacyPolicySrc, privacyPolicyDest);

const blogDir = "./blog";
for (const file of fs.readdirSync(blogDir)) {
  if (file.endsWith(".md")) {
    const md = fs.readFileSync(path.join(blogDir, file), "utf8");
    const metadata = frontMatter(md).attributes;
    const html = marked(md.replace(/^---$.*^---$/ms, ""));
    const htmlFile = file.replace(".md", ".html");
    const blogTemplate = fs.readFileSync("./html/blog-template.html", "utf8");

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
        return [c, slugCamel === c.split("Class")[0] ? "active" : ""];
      }),
    );

    const result = template(blogTemplate, {
      interpolate: /{{([\s\S]+?)}}/g,
    })({
      title: metadata.title,
      description: metadata.excerpt,
      content: html,
      slug,
      ...linkClasses,
    });

    fs.writeFileSync(path.join("./dist", htmlFile), result);
  }
}

const oneWeekInSeconds = 60 * 60 * 24 * 7;

const workbox = new WorkboxPlugin.GenerateSW({
  clientsClaim: true,
  skipWaiting: true,
  cleanupOutdatedCaches: true,
  runtimeCaching: [
    {
      urlPattern: /.*/,
      handler: "StaleWhileRevalidate",
      options: {
        cacheName: "mandelbrot-cache",
        expiration: {
          maxAgeSeconds: oneWeekInSeconds,
        },
      },
    },
  ],
});

const appConfig = {
  entry: "./js/index.ts",
  plugins: [
    new Dotenv({
      systemvars: true,
    }),
    new HtmlWebpackPlugin({
      template: "html/index.html",
      root: path.resolve(__dirname, "."),
    }),
    new MiniCssExtractPlugin(),
    workbox,
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
        test: /\.(webmanifest|xml|toml)$/i,
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
    workbox,
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
