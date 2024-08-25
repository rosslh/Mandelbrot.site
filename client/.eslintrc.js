module.exports = {
  env: {
    browser: true,
    es6: true,
    node: true,
  },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/eslint-recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  overrides: [
    {
      files: ["*.js"],
      rules: {
        "@typescript-eslint/no-var-requires": "off",
      },
    },
  ],
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  root: true,
  rules: {
    "brace-style": [1, "1tbs"],
    eqeqeq: [
      2,
      "always",
      {
        null: "ignore",
      },
    ],
    "no-console": [
      1,
      {
        allow: ["warn", "error"],
      },
    ],
    "no-implicit-coercion": 2,
    "no-param-reassign": 1,
    "no-var": 2,
    "prefer-const": 1,
    semi: 1,
    "@typescript-eslint/no-unused-vars": [
      2,
      {
        argsIgnorePattern: "^_",
      },
    ],
    "no-unused-vars": "off",
  },
};
