import { defineConfig } from 'vitest/config';
import path from 'path';

const INCLUDE = [
  '__tests__/**/*.test.ts',
  '../../packages/shared-types/__tests__/**/*.test.ts',
];

// Archivos que afirman sobre el contenido de `os.tmpdir()` (que no queden carpetas temporales
// `flito-zip-*`, `flito-recibo-*`…). El directorio es del sistema, no del proceso: corriendo en
// paralelo con otro archivo que cree temporales del mismo prefijo, verían las carpetas ajenas.
// Por eso van en un grupo aparte que arranca cuando el grupo paralelo ya terminó, y en serie.
const SERIALES_POR_TMPDIR = [
  '__tests__/services/flito-soportes-zip.test.ts',
  '__tests__/services/flito-soportes-zip-consolidar.test.ts',
  '__tests__/services/flito-recibos.compresion.test.ts',
  '__tests__/services/flito-soat.cliente-alta-documentos.test.ts',
];

// Paralelismo de archivos — solo con VITEST_PARALELO=1 (lo pone el CI).
//
// Cada archivo corre en su propio proceso (`pool: 'forks'`, aislado), así que los mocks de
// módulo (`vi.mock` de db/client, https…) NO se comparten entre archivos aunque corran a la vez.
// Lo único compartido es lo externo al proceso: el sistema de archivos (ver SERIALES_POR_TMPDIR).
// Medido el 2026-11-12 con la suite completa, 4 workers y sin retry, dos corridas: ninguna
// colisión fuera de esos archivos; solo timeouts sueltos con la máquina cargada, que absorbe el
// `retry: 1` de abajo.
//
// En local se queda en serie (lo de siempre): el mínimo P1 son pocos archivos y una máquina de
// desarrollo cargada multiplica los timeouts de 10 s.
const PARALELO = process.env.VITEST_PARALELO === '1';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./__tests__/setup.ts'],
    // `include` va en cada proyecto: con `extends: true` uno en la raíz se SUMARÍA al del proyecto.
    testTimeout: 10000,
    hookTimeout: 10000,
    pool: 'forks',
    // En serie por defecto (en Vitest 3 era `poolOptions.forks.singleFork`; en Vitest 4,
    // `fileParallelism: false`). En CI, paralelo salvo el grupo de SERIALES_POR_TMPDIR.
    fileParallelism: PARALELO,
    projects: [
      {
        extends: true,
        test: {
          name: 'api',
          include: INCLUDE,
          exclude: SERIALES_POR_TMPDIR,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'api-tmpdir',
          include: SERIALES_POR_TMPDIR,
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
    ],
    // OPS-02: se corrigió la causa raíz #1 del flake — el lookup de bloqueo LAFT en
    // el login (isUserLaftBlocked) consumía el `selectMock` del handler y su caché
    // en memoria (TTL 60s) filtraba estado entre archivos del mismo worker. Ahora
    // se salta vía AUTH_SKIP_LAFT_BLOCK_CHECK en tests (igual que el de sesión).
    //
    // Residual conocido (OPS-02b): varios módulos (soat/laft/maintenance/vehicles)
    // usan colas posicionales `selectMock.mockReturnValueOnce(...)`; una promesa
    // fire-and-forget de un test puede robar una posición de la cola del siguiente
    // → resultado vacío → fallo aleatorio. Eliminarlo requiere migrar esos mocks a
    // implementaciones keyed/stateful (refactor de harness, fuera del alcance
    // mínimo/sin-cambio-prod de OPS-02). `retry: 1` da un reintento por test: el
    // flake residual (baja probabilidad por test) deja de tumbar el CI, sin
    // enmascarar fallos reales (un test roto falla las 2 veces).
    retry: 1,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Resolver el paquete compartido a su FUENTE (no a dist) para que la suite
      // sea autocontenida: no requiere `npm run build` previo.
      '@operaciones/shared-types': path.resolve(__dirname, '../../packages/shared-types/src/index.ts'),
    },
  },
});
