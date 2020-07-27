module.exports = {
    root: true,
    parser: '@typescript-eslint/parser',
    env: {
      node: true,
    },
    parserOptions: {
      ecmaVersion: 2020,
      sourceType: "module",
    },
    plugins: [
      '@typescript-eslint',
    ],
    extends: [
      'eslint:recommended',
      'plugin:@typescript-eslint/recommended',
      "prettier/@typescript-eslint",
      "plugin:prettier/recommended",
    ],
  };
