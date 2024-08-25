const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const dist = path.resolve(__dirname, "dist");
const WasmPackPlugin = require("@wasm-tool/wasm-pack-plugin");
const { marked } = require("marked");
const frontMatter = require("front-matter");
const fs = require("fs");
const template = require("lodash/template");
const Dotenv = require("dotenv-webpack");

const blogDir = "./blog";
for (const file of fs.readdirSync(blogDir)) {
  if (file.endsWith(".md")) {
    const md = fs.readFileSync(path.join(blogDir, file), "utf8");
    const metadata = frontMatter(md).attributes;
    const html = marked(md.replace(/^---$.*^---$/ms, ""));
    const htmlFile = file.replace(".md", ".html");
    const blogTemplate = fs.readFileSync("./html/blog-template.html", "utf8");

    const result = template(blogTemplate, {
      interpolate: /{{([\s\S]+?)}}/g,
    })({
      title: metadata.title,
      description: metadata.excerpt,
      content: html,
      slug: htmlFile.replace(/\.html$/, ""),
    });

    if (!fs.existsSync("./dist")) {
      fs.mkdirSync("./dist");
    }

    fs.writeFileSync(path.join("./dist", htmlFile), result);
  }
}

const appConfig = {
  entry: "./js/main.ts",
  plugins: [
    new Dotenv({
      systemvars: true,
    }),
    new HtmlWebpackPlugin({
      template: "html/index.html",
      root: path.resolve(__dirname, "."),
    }),
    new MiniCssExtractPlugin(),
  ],
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: "ts-loader",
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
        use: "ts-loader",
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
    ],
  },
  resolve: {
    extensions: [".ts", ".js", ".wasm"],
  },
  output: { path: dist, filename: "worker.js" },
  //[DDR 2020-11-20] asyncWebAssembly is broken by webpack 5. (See https://github.com/rustwasm/wasm-bindgen/issues/2343)
  experiments: { syncWebAssembly: true },
};

module.exports = [appConfig, workerConfig];
