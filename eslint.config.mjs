import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

// Techos congelados (ratchet): archivos que hoy superan el límite global de 800.
// Solo pueden bajar; si crecen una línea, el gate falla. Reducirlos es deuda
// registrada en el reporte modo D. Al bajar de 800, quitar la entrada.
const FROZEN_CEILINGS = {
  'apps/api/src/db/schema.ts': 3400,
  'apps/web/src/pages/TramiteTraspaso.tsx': 1250,
  'apps/web/src/pages/FlitoTramites.tsx': 1190,
  'apps/api/src/modules/tramites/identidad.routes.ts': 1130,
  'apps/api/src/modules/flito-bolsas/flito-bolsas.service.ts': 1120,
  'apps/api/src/modules/flito-soat/flito-soat.service.ts': 1090,
  'apps/api/src/modules/tramites/tramites.service.ts': 880,
  'apps/web/src/pages/FlitoImpuestos.tsx': 870,
  'apps/api/src/modules/tramites/tramites.routes.ts': 860,
  'apps/api/src/modules/flito-logistica/flito-logistica.service.ts': 840,
  'apps/api/src/modules/flito-derechos/flito-derechos.service.ts': 820,
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'docs/**',
      // Assets vendor minificados (pdf.js, tesseract) — no son código del equipo.
      'apps/web/public/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      'apps/api/**/*.ts',
      'packages/**/*.ts',
      'scripts/**/*.{js,mjs,cjs}',
      '**/*.{js,cjs,mjs}',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    // react-hooks solo en la app React: en e2e colisiona con el API `use()` de Playwright.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['apps/web/e2e/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'max-lines': ['error', { max: 800, skipBlankLines: true, skipComments: true }],

      // Deuda preexistente → 'warn' en el rollout inicial (el gate no puede
      // nacer en rojo). Subir a 'error' a medida que se limpie cada regla.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-unused-expressions': 'warn',
      'no-case-declarations': 'warn',
      'no-useless-assignment': 'warn',
      'no-fallthrough': 'warn',
      'no-prototype-builtins': 'warn',
      '@typescript-eslint/no-this-alias': 'warn',
      'no-cond-assign': 'warn',
      'no-func-assign': 'warn',
      'no-useless-escape': 'warn',
      'prefer-const': 'warn',
      'no-irregular-whitespace': 'warn',
      'getter-return': 'warn',
      'no-control-regex': 'warn',
      'no-useless-catch': 'warn',
      'preserve-caught-error': 'warn',
      'no-unassigned-vars': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      'no-unsafe-finally': 'warn',
      '@typescript-eslint/no-namespace': 'warn',
      'no-sparse-arrays': 'warn',
      'no-constant-binary-expression': 'warn',
    },
  },
  {
    // Tests y specs pueden ser largos legítimamente (fixtures y casos Gherkin).
    files: ['**/__tests__/**', '**/e2e/**', '**/*.test.ts', '**/*.spec.ts'],
    rules: { 'max-lines': 'off' },
  },
  ...Object.entries(FROZEN_CEILINGS).map(([file, max]) => ({
    files: [file],
    rules: { 'max-lines': ['error', { max, skipBlankLines: true, skipComments: true }] },
  })),
);
