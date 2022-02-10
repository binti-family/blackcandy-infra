module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: ["standard-with-typescript", "prettier"],
  overrides: [
    {
      files: ["*.ts"],
      rules: {
        "no-new": "off",
        "@typescript-eslint/strict-boolean-expressions": "off",
      },
    },
  ],
  parserOptions: {
    project: ".tsconfig.json",
  },
};
