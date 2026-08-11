import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

/**
 * ESLint flat config.
 *
 * `next lint` is deprecated (removed in Next 16) and was never configured
 * here, so `pnpm lint` used to drop into an interactive setup prompt and
 * exit non-zero. This runs the ESLint CLI directly instead.
 *
 * `eslint-config-next` is still published in the legacy .eslintrc format,
 * so FlatCompat bridges it into flat config. That bridge goes away when
 * the config ships a native flat export.
 */
const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      // Generated SQL/journal artifacts from drizzle-kit.
      "drizzle/**",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default config;
