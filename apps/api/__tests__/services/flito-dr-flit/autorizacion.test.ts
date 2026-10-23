// HU #13803 (Feature #13695) — Dr. Flit: autorización de tratamiento de datos (Ley 1581). AC1–AC5, AC7.
// AC6 (la BD impide UPDATE/DELETE/TRUNCATE) y AC8 (migración dos veces) viven en
// `__tests__/db/migracion-0245.test.ts` (contra PostgreSQL) y en la verificación P6 del HANDOFF.
//
// App mínima con el router REAL montado como en `app.ts` (sin `conAlcance`), el `authMiddleware` REAL
// (que llama a la `guardiaFrontera` real con las `RUTAS_TRANSVERSALES` reales) y la guarda real de páginas
// con ficha de Ayuda (`exigirPaginaConAyuda`, motor de permisos). Dobles: `resolverPermisos` (enlace y
// funciones, por `sub`), el repositorio (almacén en memoria con la misma
// clave única usuario × finalidad × versión que la 0245), `audit` y la configuración del ambiente.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { SignJWT } from 'jose';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PermisosResueltos } from '../../../src/shared/permisos-efectivos.js';
import type { ConfigDrFlit } from '../../../src/modules/flito-dr-flit/dr-flit.config.js';

const resolverMock = vi.fn<(userId: number) => Promise<PermisosResueltos>>();
const auditMock = vi.fn();
const CFG: ConfigDrFlit = { NODE_ENV: 'production', DRFLIT_ADO_MODO: 'simulado', DEPLOY_ENVIRONMENT: 'QA' };
// HU #13854: interruptor de la IA y cupo del día (el UPSERT real se prueba en `db/migracion-0247.test.ts`).
const CFG_IA: { DRFLIT_IA_HABILITADA: boolean; ANTHROPIC_API_KEY?: string } = { DRFLIT_IA_HABILITADA: false };
const cupoMock = vi.fn();

vi.mock('../../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../../src/shared/permisos-efectivos.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/shared/permisos-efectivos.js')>()),
  resolverPermisos: (id: number) => resolverMock(id),
}));
vi.mock('../../../src/shared/middleware/audit.js', () => ({ audit: (...a: unknown[]) => auditMock(...a) }));
vi.mock('../../../src/modules/flito-dr-flit/dr-flit.config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/modules/flito-dr-flit/dr-flit.config.js')>();
  return {
    ...real,
    ambienteDespliegue: () => real.ambienteDespliegue(CFG),
    soporteDisponible: () => real.soporteDisponible(CFG),
    iaDisponible: () => real.iaDisponible(CFG_IA),
  };
});
vi.mock('../../../src/modules/flito-dr-flit/dr-flit-ia.cupo.js', () => ({
  consultarCupoIa: (...a: unknown[]) => cupoMock(...a),
}));

const { default: drFlitRoutes } = await import('../../../src/modules/flito-dr-flit/dr-flit.routes.js');
const { repoAutorizaciones, sha256Texto } = await import('../../../src/modules/flito-dr-flit/dr-flit.service.js');
const { AUTORIZACIONES_DRFLIT, PAGINAS_AYUDA_DRFLIT } = await import('@operaciones/shared-types');

const VIGENTE = AUTORIZACIONES_DRFLIT.soporte.version;
const RUTA = '/api/flito/dr-flit/autorizacion';

type Enlace = 'ninguno' | 'compania' | 'proveedor' | 'organismos_transito' | null;
const ok = (userId: number, rol: string, tipoEnlace: Enlace, funciones: string[]): PermisosResueltos => ({
  ok: true, userId, rol, tipoEnlace, funciones: new Set(funciones), version: `v${userId}`, resueltoEn: new Date(),
});

/** Por `sub`: [rol del token, enlace resuelto en base, funciones efectivas]. */
const USUARIOS: Record<number, [string, Enlace, string[]]> = {
  10: ['financiera', 'ninguno', ['pagina.finanzas_gastos_diarios']],
  11: ['proveedor', 'proveedor', ['pagina.flito_soat']],                 // Corredor SOAT
  12: ['gestor_impuestos', 'organismos_transito', ['pagina.flito_impuestos']], // Corredor Impuestos
  13: ['cliente', 'compania', ['pagina.flito_soat']],                    // tiene página con ficha: lo saca el enlace
  14: ['admin', 'compania', ['pagina.flito_tablero']],                   // rol de sistema con enlace de compañía
  15: ['admin', null, ['pagina.flito_tablero']],                         // enlace que el resolutor no decide
  16: ['admin', 'ninguno', ['pagina.flito_ayuda', 'pagina.admin_rendimiento']], // ninguna página con ficha (HU #13774: `users` ya tiene ficha)
  17: ['financiera', 'ninguno', []],                                     // sin funciones
};

const secret = () => new TextEncoder().encode(process.env.JWT_SECRET);
const token = (sub: number) => new SignJWT({ username: 'u', role: USUARIOS[sub]![0] })
  .setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub)).setIssuedAt().setExpirationTime('1h').sign(secret());

/** Almacén en memoria con la clave única de la 0245. Solo inserción: no hay método para cambiar filas. */
interface Fila { id: number; usuarioId: number; finalidad: string; version: string; textoSha256: string; aceptadaEn: Date; ip: string | null; userAgent: string | null }
let filas: Fila[] = [];

function app(): Express {
  const a = express();
  a.use(express.json());
  a.use('/api/flito/dr-flit', drFlitRoutes);
  return a;
}

const get = async (sub: number | null, finalidad = 'soporte') => {
  const r = request(app()).get(`${RUTA}?finalidad=${finalidad}`);
  return sub === null ? r : r.set('Authorization', `Bearer ${await token(sub)}`);
};
const post = async (sub: number | null, body: unknown, ua = 'Mozilla/5.0 prueba') => {
  const r = request(app()).post(RUTA).set('User-Agent', ua);
  return (sub === null ? r : r.set('Authorization', `Bearer ${await token(sub)}`)).send(body as object);
};

beforeEach(() => {
  filas = [];
  vi.restoreAllMocks();
  auditMock.mockReset().mockResolvedValue(undefined);
  Object.assign(CFG, { NODE_ENV: 'production', DRFLIT_ADO_MODO: 'simulado', DEPLOY_ENVIRONMENT: 'QA' });
  Object.assign(CFG_IA, { DRFLIT_IA_HABILITADA: false, ANTHROPIC_API_KEY: undefined });
  cupoMock.mockReset().mockResolvedValue({ usados: 4, tope: 30, restantes: 26 });
  resolverMock.mockReset().mockImplementation(async (id) => {
    const u = USUARIOS[id];
    return u ? ok(id, u[0], u[1], u[2]) : { ok: false, userId: id, motivo: 'sin_usuario' };
  });
  vi.spyOn(repoAutorizaciones, 'buscar').mockImplementation(async (usuarioId, finalidad, version) => {
    const f = filas.find((x) => x.usuarioId === usuarioId && x.finalidad === finalidad && x.version === version);
    return f ? { id: f.id, version: f.version, aceptadaEn: f.aceptadaEn } : null;
  });
  vi.spyOn(repoAutorizaciones, 'insertar').mockImplementation(async (n) => {
    if (filas.some((x) => x.usuarioId === n.usuarioId && x.finalidad === n.finalidad && x.version === n.version)) return null;
    const f: Fila = { id: filas.length + 1, aceptadaEn: new Date(), ...n };
    filas.push(f);
    return { id: f.id, version: f.version, aceptadaEn: f.aceptadaEn };
  });
});

describe('AC1 — GET de un financiera que nunca aceptó', () => {
  it('200 con autorizado=false, versión y texto vigentes, soporteDisponible y etiqueta del ambiente', async () => {
    const r = await get(10);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      finalidad: 'soporte',
      autorizado: false,
      versionVigente: VIGENTE,
      textoVigente: AUTORIZACIONES_DRFLIT.soporte.texto,
      aceptadaEn: null,
      soporte: {
        disponible: true,
        ambiente: 'QA',
        ambienteEtiqueta: 'QA',
        adjuntos: { maxArchivos: 3, maxBytesArchivo: 5 * 1024 * 1024, tipos: ['image/png', 'image/jpeg', 'application/pdf'] },
      },
    });
  });

  it.each([
    ['PDN', 'real', true, 'Producción'],
    ['DEV', 'simulado', true, 'Otro (DEV)'],
  ] as const)('ambiente %s (%s) → etiqueta de solo lectura', async (amb, modo, conPat, etiqueta) => {
    Object.assign(CFG, {
      DEPLOY_ENVIRONMENT: amb, DRFLIT_ADO_MODO: modo,
      DRFLIT_ADO_PAT: conPat ? 'x' : undefined, DRFLIT_ADO_ORG_URL: conPat ? 'https://dev.azure.com/org' : undefined,
    });
    const r = await get(10);
    expect(r.body.soporte).toMatchObject({ disponible: true, ambiente: amb, ambienteEtiqueta: etiqueta });
  });

  it('modo real sin PAT → soporte.disponible=false (P9-1)', async () => {
    Object.assign(CFG, { DEPLOY_ENVIRONMENT: 'PDN', DRFLIT_ADO_MODO: 'real', DRFLIT_ADO_PAT: undefined, DRFLIT_ADO_ORG_URL: undefined });
    const r = await get(10);
    expect(r.body.soporte.disponible).toBe(false);
  });

  it('HU #13913 AC1: producción sin DEPLOY_ENVIRONMENT, real con PAT y organización → disponible en PDN', async () => {
    Object.assign(CFG, {
      NODE_ENV: 'production', DEPLOY_ENVIRONMENT: undefined, DRFLIT_ADO_MODO: 'real',
      DRFLIT_ADO_PAT: 'x', DRFLIT_ADO_ORG_URL: 'https://dev.azure.com/org',
    });
    const r = await get(10);
    expect(r.body.soporte).toMatchObject({ disponible: true, ambiente: 'PDN', ambienteEtiqueta: 'Producción' });
  });

  it.each([
    ['sin PAT', { DRFLIT_ADO_PAT: undefined, DRFLIT_ADO_ORG_URL: 'https://dev.azure.com/org' }],
    ['sin ORG_URL', { DRFLIT_ADO_PAT: 'x', DRFLIT_ADO_ORG_URL: undefined }],
  ])('HU #13913 AC4: producción sin DEPLOY_ENVIRONMENT, real %s → disponible=false (ambiente PDN)', async (_n, cfg) => {
    Object.assign(CFG, { NODE_ENV: 'production', DEPLOY_ENVIRONMENT: undefined, DRFLIT_ADO_MODO: 'real', ...cfg });
    const r = await get(10);
    expect(r.body.soporte).toMatchObject({ disponible: false, ambiente: 'PDN', ambienteEtiqueta: 'Producción' });
  });

  it('finalidad fuera del enum → 400 finalidad-invalida sin eco del valor', async () => {
    const r = await get(10, 'PLACA-ABC123');
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('finalidad-invalida');
    expect(JSON.stringify(r.body)).not.toContain('ABC123');
  });
});

describe('HU #13854 — bloque `ia` del GET (AC6, AC7)', () => {
  it('AC6: IA disponible → ia: { disponible: true, cupo } del propio usuario', async () => {
    Object.assign(CFG_IA, { DRFLIT_IA_HABILITADA: true, ANTHROPIC_API_KEY: 'sk-prueba' });
    const r = await get(10, 'ia');
    expect(r.status).toBe(200);
    expect(r.body.finalidad).toBe('ia');
    expect(r.body.ia).toEqual({ disponible: true, cupo: { usados: 4, tope: 30, restantes: 26 } });
    expect(cupoMock).toHaveBeenCalledTimes(1);
    expect(cupoMock.mock.calls[0]![0]).toBe(10);
  });

  it('AC6: `finalidad=soporte` responde igual que hoy (sin bloque `ia`), aunque la IA esté encendida', async () => {
    Object.assign(CFG_IA, { DRFLIT_IA_HABILITADA: true, ANTHROPIC_API_KEY: 'sk-prueba' });
    const r = await get(10, 'soporte');
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('ia');
    expect(Object.keys(r.body).sort()).toEqual(['aceptadaEn', 'autorizado', 'finalidad', 'soporte', 'textoVigente', 'versionVigente']);
    expect(cupoMock).not.toHaveBeenCalled();
  });

  it.each([
    ['interruptor apagado', { DRFLIT_IA_HABILITADA: false, ANTHROPIC_API_KEY: 'sk-prueba' }],
    ['sin ANTHROPIC_API_KEY', { DRFLIT_IA_HABILITADA: true, ANTHROPIC_API_KEY: undefined }],
  ])('AC7: %s → ia: { disponible: false, cupo: null } y no consulta el cupo', async (_n, cfg) => {
    Object.assign(CFG_IA, cfg);
    const r = await get(10, 'ia');
    expect(r.status).toBe(200);
    expect(r.body.ia).toEqual({ disponible: false, cupo: null });
    expect(cupoMock).not.toHaveBeenCalled();
  });
});

describe('AC2 — aceptar la versión vigente', () => {
  it('201, una fila con usuario, finalidad, versión, fecha, IP, user agent y hash; luego autorizado=true', async () => {
    const r = await post(10, { finalidad: 'soporte', version: VIGENTE });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ finalidad: 'soporte', version: VIGENTE, aceptadaEn: expect.any(String) });
    expect(filas).toHaveLength(1);
    const f = filas[0]!;
    expect(f).toMatchObject({
      usuarioId: 10, finalidad: 'soporte', version: VIGENTE, userAgent: 'Mozilla/5.0 prueba',
      textoSha256: sha256Texto(AUTORIZACIONES_DRFLIT.soporte.texto),
    });
    expect(f.textoSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(f.ip).toMatch(/127\.0\.0\.1|::1/);
    expect(f.aceptadaEn).toBeInstanceOf(Date);
    expect(auditMock).toHaveBeenCalledTimes(1);

    const g = await get(10);
    expect(g.body).toMatchObject({ autorizado: true, versionVigente: VIGENTE, aceptadaEn: f.aceptadaEn.toISOString() });
  });

  it('aceptar otra vez la misma versión → 200 y sigue habiendo una sola fila (idempotente)', async () => {
    await post(10, { finalidad: 'soporte', version: VIGENTE });
    const r = await post(10, { finalidad: 'soporte', version: VIGENTE });
    expect(r.status).toBe(200);
    expect(filas).toHaveLength(1);
    expect(auditMock).toHaveBeenCalledTimes(1);
  });

  it('user agent de más de 300 caracteres se recorta al ancho de la columna', async () => {
    await post(10, { finalidad: 'soporte', version: VIGENTE }, 'A'.repeat(500));
    expect(filas[0]!.userAgent).toHaveLength(300);
  });
});

describe('AC3 — otra versión', () => {
  it('409 version-no-vigente con mensaje claro y no guarda nada', async () => {
    const r = await post(10, { finalidad: 'soporte', version: '1999-01-vieja' });
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('version-no-vigente');
    expect(r.body.error).toMatch(/versión .* no está vigente/i);
    expect(filas).toHaveLength(0);
    expect(repoAutorizaciones.insertar).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('cuerpo inválido → 400 campo-invalido sin eco y sin guardar', async () => {
    const r = await post(10, { finalidad: 'soporte', version: '', extra: 'cedula-123456' });
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('campo-invalido');
    expect(JSON.stringify(r.body)).not.toContain('123456');
    expect(filas).toHaveLength(0);
  });
});

describe('AC4 — cambia la versión vigente', () => {
  it('una aceptación de una versión anterior no cuenta: autorizado=false', async () => {
    filas.push({
      id: 1, usuarioId: 10, finalidad: 'soporte', version: '2025-01-anterior', textoSha256: 'a'.repeat(64),
      aceptadaEn: new Date('2025-01-02T00:00:00Z'), ip: null, userAgent: null,
    });
    const r = await get(10);
    expect(r.body).toMatchObject({ autorizado: false, versionVigente: VIGENTE, aceptadaEn: null });
  });
});

describe('AC5 — finalidades independientes', () => {
  it('con «soporte» aceptada, «ia» sigue en autorizado=false', async () => {
    expect((await post(10, { finalidad: 'soporte', version: VIGENTE })).status).toBe(201);
    const ia = await get(10, 'ia');
    expect(ia.status).toBe(200);
    expect(ia.body).toMatchObject({ finalidad: 'ia', autorizado: false, versionVigente: AUTORIZACIONES_DRFLIT.ia.version });
    expect((await get(10, 'soporte')).body.autorizado).toBe(true);
  });
});

describe('HU #13856 (IA-4, AC2/AC10) — texto «ia» 2026-11-v1', () => {
  it('el GET de «ia» publica la versión y el texto nuevos; aceptarla guarda el hash de ese texto', async () => {
    const ia = await get(10, 'ia');
    expect(ia.body).toMatchObject({
      versionVigente: '2026-11-v1', textoVigente: AUTORIZACIONES_DRFLIT.ia.texto, autorizado: false,
    });
    expect(ia.body.textoVigente).toMatch(/NO se pueden ocultar/);
    expect((await post(10, { finalidad: 'ia', version: '2026-11-v1' })).status).toBe(201);
    expect(filas[0]).toMatchObject({ finalidad: 'ia', version: '2026-11-v1', textoSha256: sha256Texto(AUTORIZACIONES_DRFLIT.ia.texto) });
    expect((await get(10, 'ia')).body.autorizado).toBe(true);
  });

  it('la versión provisional anterior de «ia» ya no se acepta (todos vuelven a consentir)', async () => {
    const r = await post(10, { finalidad: 'ia', version: '2026-10-provisional-1' });
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('version-no-vigente');
    expect(filas).toHaveLength(0);
  });
});

describe('AC7 — quién no pasa (y quién sí)', () => {
  it('sin token → 401 y no se guarda nada', async () => {
    expect((await get(null)).status).toBe(401);
    expect((await post(null, { finalidad: 'soporte', version: VIGENTE })).status).toBe(401);
    expect(filas).toHaveLength(0);
  });

  it.each([
    [13, 'cliente (enlace compañía)'],
    [14, 'admin con enlace de compañía'],
    [15, 'enlace que el resolutor no decide'],
    [16, 'sin enlace pero sin ninguna página con ficha de Ayuda (aunque tenga `flito_ayuda`)'],
    [17, 'sin enlace y sin funciones'],
  ])('sub %i — %s → 403 en GET y POST y no se guarda nada', async (sub) => {
    expect((await get(sub)).status).toBe(403);
    const r = await post(sub, { finalidad: 'soporte', version: VIGENTE });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'Sin permisos' });
    expect(filas).toHaveLength(0);
  });

  it.each([
    [11, 'Corredor SOAT (proveedor)'],
    [12, 'Corredor Impuestos (organismos_transito)'],
  ])('sub %i — %s → pasa: GET 200 y POST 201', async (sub) => {
    expect((await get(sub)).status).toBe(200);
    expect((await post(sub, { finalidad: 'soporte', version: VIGENTE })).status).toBe(201);
    expect(filas.map((f) => f.usuarioId)).toEqual([sub]);
  });

  it('resolutor caído (ok:false) → 403, falla cerrado, y no se guarda nada', async () => {
    resolverMock.mockResolvedValue({ ok: false, userId: 10, motivo: 'resolucion' });
    expect((await get(10)).status).toBe(403);
    expect((await post(10, { finalidad: 'soporte', version: VIGENTE })).status).toBe(403);
    expect(filas).toHaveLength(0);
  });

  it('las páginas de `PAGINAS_AYUDA_DRFLIT` son exactamente los `permiso` del catálogo de Ayuda de la web', () => {
    const catalogo = readFileSync(
      fileURLToPath(new URL('../../../../web/src/content/ayuda/catalogo.ts', import.meta.url)), 'utf8');
    const permisos = [...new Set([...catalogo.matchAll(/permiso:\s*'([a-z_]+)'/g)].map((m) => m[1]))].sort();
    expect(permisos.length).toBeGreaterThan(0);
    expect([...PAGINAS_AYUDA_DRFLIT].sort()).toEqual(permisos);
  });

  it('HU #13853: `PAGINAS_AYUDA_DRFLIT` cubre todos los `permiso` del artefacto de fichas del API', async () => {
    const { FICHAS_AYUDA } = await import('../../../src/modules/flito-dr-flit/ayuda/fichas-ayuda.generated.js');
    const permisos = [...new Set(FICHAS_AYUDA.map((f) => f.permiso))];
    expect(permisos.length).toBeGreaterThan(0);
    for (const p of permisos) expect(PAGINAS_AYUDA_DRFLIT as readonly string[]).toContain(p);
  });

  it('una ruta del módulo que NO es transversal queda cerrada por la frontera a un enlace de proveedor', async () => {
    const r = await request(app()).post('/api/flito/dr-flit/otra').set('Authorization', `Bearer ${await token(11)}`).send({});
    expect(r.status).toBe(403);
  });
});
