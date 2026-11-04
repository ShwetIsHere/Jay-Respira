import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Avoid Windows realpath permission failures when the project is hosted
    // on a secondary drive.
    preserveSymlinks: true,
  },
  test: {
    environment: "node",
    globals: true,
  },
});
