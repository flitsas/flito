import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./__tests__/setup.ts'],
    include: [
      '__tests__/**/*.test.ts',
      '../../packages/shared-types/__tests__/**/*.test.ts',
    ],
    testTimeout: 10000,
    hookTimeout: 10000,
    pool: 'forks',
    // Ejecución serial de archivos: muchos tests comparten mocks de módulo
    // (db/client, https, etc.) y colisionan si corren en paralelo. En Vitest 3
    // esto lo daba `poolOptions.forks.singleFork`; en Vitest 4 ese flag quedó
    // deprecado y el equivalente es `fileParallelism: false`.
    fileParallelism: false,
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
