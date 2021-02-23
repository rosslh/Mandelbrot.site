module.exports = {
    env: {
        browser: true,
        es6: true,
        node: true
    },
    extends: ['plugin:editorconfig/all', 'eslint:recommended', 'plugin:@typescript-eslint/recommended'],
    overrides: [{
        files: ["*.js"],
        rules: {
            "@typescript-eslint/no-var-requires": "off"
        }
    }],
    parser: '@typescript-eslint/parser',
    plugins: ['@typescript-eslint', 'editorconfig'],
    root: true,
    rules: {
        "brace-style": [1, "1tbs"],
        curly: [1, "multi-line"],
        eqeqeq: [2, "always", {
            "null": "ignore"
        }],
        "no-console": [1, {
            allow: ["warn", "error"]
        }],
        "no-implicit-coercion": 2,
        "no-param-reassign": 1,
        "no-unused-vars": [1, {
            argsIgnorePattern: "^_"
        }],
        "no-var": 2,
        "prefer-const": 1,
        semi: 1
    }
};
