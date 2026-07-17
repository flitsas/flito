// Vitest global setup — corre antes de cualquier import de los tests.
// Setea env vars válidas (zod en config/env.ts hace process.exit si fallan).
//
// IMPORTANTE: cualquier var añadida al schema de env.ts con regex/min debe tener
// aquí un valor que pase la validación, o el primer import del test crasheará.

process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-jwt-secret-test-jwt-secret-1234';
process.env.RUNT_INTERNAL_KEY = 'test-runt-internal-key-12345';
process.env.INTEGRACIONES_MODE = 'cea-proxy';
process.env.PII_ENC_KEY = 'test-pii-enc-key-test-pii-enc-key-1234';
// 64 hex chars con entropía Shannon suficiente (>3.5 bits/byte). Generadas con
// crypto.randomBytes(32).toString('hex') y fijadas para que los tests sean determinísticos.
process.env.PII_HMAC_KEY = 'de7a1edb98c0e94e21c1cb91eb7836bf32b50a6e35c01c17f12c0d7b8c8a4ef0';
process.env.RNDC_ENC_KEY = '4f9a2c81e63b07b8a5d11fce4982071c34ad6e58927b1f0c39ea4d1be8c6f205';
process.env.RNDC_MODE = 'mock';
process.env.S3_ACCESS_KEY = 'test-access';
process.env.S3_SECRET_KEY = 'test-secret-key';
process.env.PUBLIC_URL = 'https://test.kyverum.com';
process.env.CORS_ORIGIN = 'https://test.kyverum.com';
// Suite-wide: deshabilitar check de session_invalidated_at en tests para no consumir
// mocks de selectMock destinados a los handlers. Tests específicos hacen override puntual.
process.env.AUTH_SKIP_SESSION_INVAL_CHECK = '1';
// Mismo motivo, para el lookup de bloqueo LAFT en el login (auth.routes → isUserLaftBlocked):
// evita consumir selectMock del handler y que su caché en memoria filtre estado entre
// archivos. Tests específicos (laft.auth-block.test.ts) lo desactivan.
process.env.AUTH_SKIP_LAFT_BLOCK_CHECK = '1';
