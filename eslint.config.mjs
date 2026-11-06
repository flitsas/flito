import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

// Techos congelados (ratchet): archivos que hoy superan el límite global de 800.
// Solo pueden bajar; si crecen una línea, el gate falla. Reducirlos es deuda
// registrada en el reporte modo D. Al bajar de 800, quitar la entrada.
const FROZEN_CEILINGS = {
  'apps/web/src/pages/FlitoTramites.tsx': 1190,
  'apps/api/src/modules/tramites/identidad.routes.ts': 901, // Feature #14097: bajó al sacar el cifrado local
  'apps/api/src/modules/flito-soat/flito-soat.service.ts': 1090,
  'apps/api/src/modules/tramites/tramites.service.ts': 880,
  'apps/web/src/pages/FlitoImpuestos.tsx': 870,
  'apps/api/src/modules/tramites/tramites.routes.ts': 860,
  'apps/api/src/modules/flito-derechos/flito-derechos.service.ts': 820,
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/playwright-report/**',
      '**/test-results/**',
      // Worktrees de agentes: son COPIAS COMPLETAS del repo. Sin esto, `npm run lint` analiza el
      // código tres veces y el conteo de warnings —que la regla 20 usa como umbral— deja de
      // significar nada.
      '.claude/**',
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
      'no-empty': ['error', { allowEmptyCatch: true }],
      'max-lines': ['error', { max: 800, skipBlankLines: true, skipComments: true }],

      // Selladas (HU #13985): llegaron a 0 warnings y no se reabren. scripts/lint-baseline.json
      // las lista y el job `lint` falla si alguna deja de estar en 'error'.
      '@typescript-eslint/no-require-imports': 'error',
      '@typescript-eslint/no-this-alias': 'error',
      'getter-return': 'error',
      'no-case-declarations': 'error',
      'no-cond-assign': 'error',
      'no-constant-binary-expression': 'error',
      'no-fallthrough': 'error',
      'no-func-assign': 'error',
      'no-prototype-builtins': 'error',
      'no-sparse-arrays': 'error',
      'no-unassigned-vars': 'error',
      'no-unsafe-finally': 'error',

      // Deuda preexistente con ratchet por regla (HU #13985): cada 'warn' tiene su conteo en
      // scripts/lint-baseline.json, que solo baja. Con 0 warnings se sube a 'error' y se sella.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-unused-expressions': 'warn',
      'no-useless-assignment': 'warn',
      'no-useless-escape': 'warn',
      'prefer-const': 'warn',
      'no-irregular-whitespace': 'warn',
      'no-control-regex': 'warn',
      'no-useless-catch': 'warn',
      'preserve-caught-error': 'warn',
      '@typescript-eslint/no-namespace': 'warn',
    },
  },
  {
    // Tests y specs pueden ser largos legítimamente (fixtures y casos Gherkin).
    files: ['**/__tests__/**', '**/e2e/**', '**/*.test.ts', '**/*.spec.ts'],
    rules: { 'max-lines': 'off' },
  },
  {
    // HU #13853 (ADR-0027): artefactos generados por script (fichas de Ayuda para Dr. Flit). Solo
    // `*.generated.ts`: no amplía la exclusión a otro código de producto.
    files: ['**/*.generated.ts'],
    rules: { 'max-lines': 'off' },
  },
  ...Object.entries(FROZEN_CEILINGS).map(([file, max]) => ({
    files: [file],
    rules: { 'max-lines': ['error', { max, skipBlankLines: true, skipComments: true }] },
  })),
);
