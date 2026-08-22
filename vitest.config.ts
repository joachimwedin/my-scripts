import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Ticket #2 only scaffolds the project; zero test files should report
    // zero passing, not fail the run. Later tickets add real tests.
    passWithNoTests: true,
  },
});
