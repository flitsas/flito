// HU #12997 (Feature #12841) — lectura de las solicitudes INCOMPLETAS por RUNT caído:
// `POST /api/flito/soat/cliente/incompletas/buscar` y `GET /api/flito/soat/cliente/incompletas/:id`.
//
// Cubre AC1 (200 + alcance por enlace + proveedor = 0 + filtro solo en body), AC2 (400 sin tocar la
// tabla), AC3 (detalle, logPiiAccess con resource_tipo propio y VIN en HMAC, 404-no-403), AC4 (403 sin
// `soat.cola.ver`; lectura sin reintento sí ve) y AC7 (porNombre «FLITO» vs nombre real).
//
// Lecciones que este archivo respeta: el mock `chain` devuelve la fila ENTERA aunque el select pida
// menos y no filtra por `where`, y `orderBy` es passthrough. Por eso el alcance se prueba sobre el SQL
// renderizado (`espia.condicionesLeidas()`), no sobre las filas que el propio test registró.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { SignJWT } from 'jose';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { ligadoA, renderizar } from '../helpers/sql-ligado.js';
import { registrarUsuarioDePrueba } from '../helpers/auth.js';

const kdb = createKeyedDb();
const piiMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: piiMock }));

const COMPANIA = 7;
const OTRA_COMPANIA = 8;
const ID = '1c0a0000-0000-4000-8000-00000000aa01';
const ID_DESC = '1c0a0000-0000-4000-8000-00000000aa02';
const VIN = '9BWZZZ377VT004251';
const T0 = new Date('2026-09-27T15:00:00Z');
const T1 = new Date('2026-09-28T10:00:00Z');

let sub = 9600;

async function auth(opts: {
  tipoPrincipal: 'interno' | 'externo'; tipoEnlace: string; funciones: string[]; rol?: string;
}) {
  sub += 1;
  const rol = opts.rol ?? 'rol_prueba';
  await registrarUsuarioDePrueba(sub, {
    rol, tipoPrincipal: opts.tipoPrincipal, tipoEnlace: opts.tipoEnlace, excepciones: [],
    funcionesDelRol: ['pagina.flito_soat', ...opts.funciones],
  });
  const t = await new SignJWT({ username: 'u@x.co', role: rol })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub)).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  return `Bearer ${t}`;
}

const LECTURA = ['soat.incompletas.buscar', 'soat.incompleta.ver'];
const clienteCompania = () => auth({ tipoPrincipal: 'externo', tipoEnlace: 'compania', funciones: LECTURA });
const operaciones = () => auth({ tipoPrincipal: 'interno', tipoEnlace: 'ninguno', funciones: LECTURA });
const gestorProveedor = () => auth({ tipoPrincipal: 'interno', tipoEnlace: 'proveedor_soat', funciones: LECTURA });

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat-incompletas.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}

const filaIncompleta = {
  id: ID, estado: 'incompleta', vin: VIN, companiaId: COMPANIA, companiaNombre: 'Motos SAS',
  titular: 'ANA PÉREZ', solicitadoPorNombre: 'ana@motos.co', solicitadoEn: T0, intentos: 2,
  ultimoIntentoEn: T1, motivoDescarte: null, resueltaEn: null, resueltaPorId: null,
  resueltaPorNombre: null, soatId: null,
  facturaNombreArchivo: 'factura.pdf', facturaContentType: 'application/pdf', facturaTamanoBytes: 1234,
};
const filaDescartada = {
  ...filaIncompleta, id: ID_DESC, estado: 'descartada', motivoDescarte: 'soat_vigente', resueltaEn: T1,
  resueltaPorId: 50, resueltaPorNombre: 'Pedro Operaciones',
};
const propietario = {
  tipoDocumento: 'CC', nombres: 'ANA', apellidos: 'PÉREZ', razonSocial: null, numeroDocumento: '1020304050',
  correo: 'ana@x.co', celular: '3001234567', direccion: 'Cra 1 # 2-3', municipio: 'Bogotá', departamento: 'Cundinamarca',
  // Columna que el select NO pide: el mock la devuelve igual; el DTO no debe publicarla.
  procedencia: { nombres: 'runt' },
};

const URL_BUSCAR = '/api/flito/soat/cliente/incompletas/buscar';
const sobreIncompletas = (espia: ReturnType<typeof crearEspia>) => espia.condicionesLeidas()
  .filter((c) => c !== undefined)
  .map((c) => renderizar(c as never)).filter((q) => q.sql.includes('"flito_soat_incompletas".'));

/** ¿Alguna consulta tocó `flito_soat_incompletas`? Se mira el `from` real de cada select. */
function seLeyoIncompletas(espia: ReturnType<typeof crearEspia>): boolean {
  return sobreIncompletas(espia).length > 0;
}

beforeEach(() => { kdb.reset(); piiMock.mockClear(); });

describe('AC1 — POST …/incompletas/buscar con soat.incompletas.buscar', () => {
  it('Cliente con enlace compañía: 200 { items, total, conteos } y el WHERE lleva SU compania_id', async () => {
    const espia = crearEspia(kdb);
    kdb.when
      .selectOnce('users', [{ c: COMPANIA, p: null }])
      .selectOnce('flito_soat_incompletas', [{ estado: 'incompleta', n: 1 }, { estado: 'descartada', n: 4 }])
      .selectOnce('flito_soat_incompletas', [filaIncompleta]);

    const r = await request(await buildApp()).post(URL_BUSCAR)
      .set('Authorization', await clienteCompania())
      .send({ estados: ['incompleta'], pagina: 1, porPagina: 25 });

    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.conteos).toEqual({ incompleta: 1, descartada: 4 });
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toEqual({
      id: ID, estado: 'incompleta', vin: VIN, companiaId: COMPANIA, companiaNombre: 'Motos SAS',
      placa: null, marca: null, linea: null, titular: 'ANA PÉREZ',
      solicitadoPorNombre: 'ana@motos.co', solicitadoEn: T0.toISOString(), intentos: 2,
      ultimoIntentoRuntEn: T1.toISOString(), descarte: null, soatId: null,
    });
    // Las DOS consultas (conteos e items) van acotadas a la compañía del usuario, sin literales de rol.
    const qs = sobreIncompletas(espia);
    expect(qs.length).toBe(2);
    for (const q of qs) {
      expect(ligadoA(q, '"flito_soat_incompletas"."compania_id"')).toBe(COMPANIA);
      expect(q.sql).not.toMatch(/tipo_principal|cliente/);
    }
    // Los items además filtran por los estados pedidos.
    expect(qs[1]!.sql).toMatch(/"flito_soat_incompletas"\."estado" in \(\$\d+\)/);
    expect(qs[1]!.params).toContain('incompleta');
    // Hubo filas con titular y VIN → se anota el acceso con resource_tipo propio.
    expect(piiMock).toHaveBeenCalledTimes(1);
    expect(piiMock.mock.calls[0]![1]).toMatchObject({ resourceTipo: 'flito_soat_incompleta', accion: 'search' });
  });

  it('Operaciones (enlace ninguno): sin recorte por compañía', async () => {
    const espia = crearEspia(kdb);
    kdb.when
      .selectOnce('flito_soat_incompletas', [{ estado: 'incompleta', n: 1 }])
      .selectOnce('flito_soat_incompletas', [filaIncompleta]);

    const r = await request(await buildApp()).post(URL_BUSCAR)
      .set('Authorization', await operaciones()).send({});

    expect(r.status).toBe(200);
    const qs = sobreIncompletas(espia);
    expect(qs.length).toBeGreaterThanOrEqual(1);
    for (const q of qs) expect(q.sql).not.toContain('"flito_soat_incompletas"."compania_id"');
  });

  it('enlace proveedor: cero filas y ni siquiera consulta la tabla', async () => {
    const espia = crearEspia(kdb);
    kdb.when.selectOnce('users', [{ c: null, p: '0000aaaa-0000-4000-8000-000000000001' }])
      .select('flito_soat_incompletas', [filaIncompleta]);

    const r = await request(await buildApp()).post(URL_BUSCAR)
      .set('Authorization', await gestorProveedor()).send({ estados: ['incompleta', 'descartada'] });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ items: [], total: 0, conteos: { incompleta: 0, descartada: 0 } });
    expect(seLeyoIncompletas(espia)).toBe(false);
    // La única lectura es la de `users` que resuelve el contexto (ni una consulta sin WHERE a la tabla).
    expect(espia.condicionesLeidas()).toHaveLength(1);
    expect(piiMock).not.toHaveBeenCalled();
  });

  it('el texto (VIN o documento) viaja en el body y entra PARAMETRIZADO en el WHERE (VIN contiene, documento exacto)', async () => {
    const espia = crearEspia(kdb);
    kdb.when
      .selectOnce('users', [{ c: COMPANIA, p: null }])
      .selectOnce('flito_soat_incompletas', []);

    const r = await request(await buildApp()).post(URL_BUSCAR)
      .set('Authorization', await clienteCompania()).send({ estados: ['incompleta'], texto: '1020304050' });

    expect(r.status).toBe(200);
    const [q] = sobreIncompletas(espia);
    expect(q!.sql).toMatch(/"flito_soat_incompletas"\."vin" ilike \$\d+/);
    expect(q!.params).toContain('%1020304050%');
    expect(q!.sql).toMatch(/"flito_compradores"\."numero_documento" = \$\d+/);
    expect(q!.params).toContain('1020304050');
    expect(q!.sql).not.toContain('1020304050');
  });
});

describe('AC2 — validación del filtro: 400 y no consulta la tabla', () => {
  const casos: [string, unknown][] = [
    ['estados vacío', { estados: [] }],
    ['estado desconocido', { estados: ['pagado'] }],
    ['texto de 41 caracteres', { texto: 'X'.repeat(41) }],
    ['porPagina 0', { porPagina: 0 }],
    ['porPagina 101', { porPagina: 101 }],
    ['pagina 0', { pagina: 0 }],
    ['campo extra', { estados: ['incompleta'], vin: VIN }],
  ];
  for (const [nombre, body] of casos) {
    it(nombre, async () => {
      const espia = crearEspia(kdb);
      const r = await request(await buildApp()).post(URL_BUSCAR)
        .set('Authorization', await clienteCompania()).send(body as object);
      expect(r.status).toBe(400);
      expect(seLeyoIncompletas(espia)).toBe(false);
      // Ni siquiera se resolvió el contexto: la tabla `users` tampoco se leyó.
      expect(espia.condicionesLeidas()).toHaveLength(0);
    });
  }
});

describe('AC4 — sin la función de lectura', () => {
  it('sin soat.incompletas.buscar → 403 (aunque tenga el detalle y la cola de hoy)', async () => {
    const espia = crearEspia(kdb);
    const r = await request(await buildApp()).post(URL_BUSCAR)
      .set('Authorization', await auth({ tipoPrincipal: 'externo', tipoEnlace: 'compania', funciones: ['soat.incompleta.ver', 'soat.cola.ver'] }))
      .send({});
    expect(r.status).toBe(403);
    expect(seLeyoIncompletas(espia)).toBe(false);
  });

  it('con lectura pero SIN soat.solicitud.reintentar_runt → sí ve las filas', async () => {
    kdb.when
      .selectOnce('users', [{ c: COMPANIA, p: null }])
      .selectOnce('flito_soat_incompletas', [{ estado: 'incompleta', n: 1 }])
      .selectOnce('flito_soat_incompletas', [filaIncompleta]);
    const r = await request(await buildApp()).post(URL_BUSCAR)
      .set('Authorization', await clienteCompania()).send({});
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
  });
});

describe('AC3 / AC7 — GET …/incompletas/:id', () => {
  it('incompleta de su alcance: 200 con propietario y factura; logPiiAccess con VIN en HMAC', async () => {
    const espia = crearEspia(kdb);
    kdb.when
      .selectOnce('users', [{ c: COMPANIA, p: null }])
      .selectOnce('flito_soat_incompletas', [filaIncompleta])
      .selectOnce('flito_compradores', [propietario]);

    const r = await request(await buildApp()).get(`/api/flito/soat/cliente/incompletas/${ID}`)
      .set('Authorization', await clienteCompania());

    expect(r.status).toBe(200);
    expect(r.body.propietario).toEqual({
      tipoDocumento: 'CC', nombres: 'ANA', apellidos: 'PÉREZ', razonSocial: null, numeroDocumento: '1020304050',
      correo: 'ana@x.co', celular: '3001234567', direccion: 'Cra 1 # 2-3', municipio: 'Bogotá', departamento: 'Cundinamarca',
    });
    expect(r.body.factura).toEqual({ nombreArchivo: 'factura.pdf', contentType: 'application/pdf', tamanoBytes: 1234 });
    expect(r.body.descarte).toBeNull();
    // La lectura va acotada por id Y por la compañía del usuario.
    const [q] = sobreIncompletas(espia);
    expect(ligadoA(q!, '"flito_soat_incompletas"."id"')).toBe(ID);
    expect(ligadoA(q!, '"flito_soat_incompletas"."compania_id"')).toBe(COMPANIA);

    expect(piiMock).toHaveBeenCalledTimes(1);
    const reg = piiMock.mock.calls[0]![1] as { resourceTipo: string; accion: string; motivo: string; camposAccedidos: string[] };
    expect(reg.resourceTipo).toBe('flito_soat_incompleta');
    expect(reg.accion).toBe('read');
    expect(reg.motivo).toMatch(/^vin=/);
    expect(reg.motivo).not.toContain(VIN);
    expect(reg.motivo).toContain(ID);
    expect(reg.camposAccedidos).toEqual(expect.arrayContaining(['numero_documento', 'vin', 'correo']));
  });

  it('fuera de su alcance (la consulta acotada no devuelve fila) → 404, no 403, y sin registro PII', async () => {
    kdb.when.selectOnce('users', [{ c: COMPANIA, p: null }]).selectOnce('flito_soat_incompletas', []);
    const r = await request(await buildApp()).get(`/api/flito/soat/cliente/incompletas/${ID}`)
      .set('Authorization', await clienteCompania());
    expect(r.status).toBe(404);
    expect(piiMock).not.toHaveBeenCalled();
  });

  it('enlace proveedor → 404 sin consultar la tabla', async () => {
    const espia = crearEspia(kdb);
    kdb.when.selectOnce('users', [{ c: null, p: '0000aaaa-0000-4000-8000-000000000001' }])
      .select('flito_soat_incompletas', [filaIncompleta]);
    const r = await request(await buildApp()).get(`/api/flito/soat/cliente/incompletas/${ID}`)
      .set('Authorization', await gestorProveedor());
    expect(r.status).toBe(404);
    expect(seLeyoIncompletas(espia)).toBe(false);
    expect(espia.condicionesLeidas()).toHaveLength(1);
  });

  it('id que no es uuid → 404 sin tocar la base', async () => {
    const espia = crearEspia(kdb);
    const r = await request(await buildApp()).get('/api/flito/soat/cliente/incompletas/no-es-uuid')
      .set('Authorization', await clienteCompania());
    expect(r.status).toBe(404);
    expect(espia.condicionesLeidas()).toHaveLength(0);
  });

  it('sin soat.incompleta.ver → 403 (aunque tenga la búsqueda y el detalle SOAT de hoy)', async () => {
    const r = await request(await buildApp()).get(`/api/flito/soat/cliente/incompletas/${ID}`)
      .set('Authorization', await auth({ tipoPrincipal: 'externo', tipoEnlace: 'compania', funciones: ['soat.incompletas.buscar', 'soat.solicitud.ver'] }));
    expect(r.status).toBe(403);
  });

  it('AC7 · descartada por alguien de OTRA compañía → el Cliente ve «FLITO»', async () => {
    kdb.when
      .selectOnce('users', [{ c: COMPANIA, p: null }])
      .selectOnce('flito_soat_incompletas', [filaDescartada])
      .selectOnce('flito_compradores', [propietario])
      .selectOnce('users', [{ id: 50, companiaId: null }]);
    const r = await request(await buildApp()).get(`/api/flito/soat/cliente/incompletas/${ID_DESC}`)
      .set('Authorization', await clienteCompania());
    expect(r.status).toBe(200);
    expect(r.body.descarte).toEqual({ motivo: 'soat_vigente', en: T1.toISOString(), porNombre: 'FLITO' });
  });

  it('AC7 · descartada por alguien de SU compañía → ve el nombre real', async () => {
    kdb.when
      .selectOnce('users', [{ c: COMPANIA, p: null }])
      .selectOnce('flito_soat_incompletas', [filaDescartada])
      .selectOnce('flito_compradores', [propietario])
      .selectOnce('users', [{ id: 50, companiaId: COMPANIA }]);
    const r = await request(await buildApp()).get(`/api/flito/soat/cliente/incompletas/${ID_DESC}`)
      .set('Authorization', await clienteCompania());
    expect(r.status).toBe(200);
    expect(r.body.descarte.porNombre).toBe('Pedro Operaciones');
  });

  it('AC7 · autor de una tercera compañía → «FLITO»', async () => {
    kdb.when
      .selectOnce('users', [{ c: COMPANIA, p: null }])
      .selectOnce('flito_soat_incompletas', [filaDescartada])
      .selectOnce('flito_compradores', [propietario])
      .selectOnce('users', [{ id: 50, companiaId: OTRA_COMPANIA }]);
    const r = await request(await buildApp()).get(`/api/flito/soat/cliente/incompletas/${ID_DESC}`)
      .set('Authorization', await clienteCompania());
    expect(r.body.descarte.porNombre).toBe('FLITO');
  });

  it('AC7 · Operaciones (enlace ninguno) ve el nombre real sin consultar al autor', async () => {
    kdb.when
      .selectOnce('flito_soat_incompletas', [filaDescartada])
      .selectOnce('flito_compradores', [propietario])
      .select('users', [{ id: 50, companiaId: OTRA_COMPANIA }]);
    const r = await request(await buildApp()).get(`/api/flito/soat/cliente/incompletas/${ID_DESC}`)
      .set('Authorization', await operaciones());
    expect(r.body.descarte.porNombre).toBe('Pedro Operaciones');
  });
});

describe('Canal externo: las dos rutas están inscritas en la allowlist', () => {
  it('rutaPermitidaParaCliente las deja pasar, y solo con su método', async () => {
    const { rutaPermitidaParaCliente } = await import('../../src/shared/middleware/canal-cliente.js');
    expect(rutaPermitidaParaCliente('POST', URL_BUSCAR)).toBe(true);
    expect(rutaPermitidaParaCliente('DELETE', URL_BUSCAR)).toBe(false);
    expect(rutaPermitidaParaCliente('POST', `/api/flito/soat/cliente/incompletas/${ID}`)).toBe(false);
    expect(rutaPermitidaParaCliente('GET', `/api/flito/soat/cliente/incompletas/${ID}`)).toBe(true);
    expect(rutaPermitidaParaCliente('GET', `/api/flito/soat/cliente/incompletas/${ID}/otra`)).toBe(false);
  });
});
