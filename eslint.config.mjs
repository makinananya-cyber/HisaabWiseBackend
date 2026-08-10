// Plain ESM rather than TypeScript so the lint config needs no extra loader and is not itself
// a typecheck target.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', '.wrangler/**', 'worker-configuration.d.ts'],
  },
  {
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
