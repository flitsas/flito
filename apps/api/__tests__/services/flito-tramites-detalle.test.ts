// ADR-0046 — Detalle de trámite en modal y ZIP de soportes por trámite (Gestión Trámites, `flito-tramites`).
//
// - `GET /api/flito/tramites/:id/detalle`: `tramites.cola.ver` + alcance del listado. Inexistente, fuera de
//   alcance o id que no es uuid → el mismo 404 (el ADR descarta el 400: no hay cuerpo). 200 con
//   `no-store` y rastro PII `read` con NOMBRES de campos y el uuid en el motivo, sin valores.
// - `POST /api/flito/tramites/soportes/zip`: con UN trámite el archivo se llama `[ID del trámite]-DOCS.zip`
//   (id_flit, nunca la placa); con varios conserva `soportes_AAAAMMDD-HHMM.zip`.
//
// Router REAL montado como en `app.ts` (`conAlcance`) sobre el doble de drizzle que CAPTURA los `where`.
import 'express-async-errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { testToken } from '../helpers/auth.js';
import { conAlcance } from '../helpers/frontera.js';
import type { crearCaptura } from '../helpers/alcance-captura.js';

const h = vi.hoisted(() => ({ cap: null as unknown as ReturnType<typeof crearCaptura> }));
vi.mock('../../src/db/client.js', async () => {
  const { crearCaptura: crear } = await import('../helpers/alcance-captura.js');
  h.cap = crear();
  return { db: h.cap.db, getPoolStats: vi.fn() };
});
const pii = vi.hoisted(() => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/pii-audit.js', () => pii);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/modules/flito-soat/flito-soat.service.js', () => ({ enviarAlGestor: vi.fn() }));
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.service.js', () => ({ enviarAlGestor: vi.fn() }));
// El ZIP: sin MinIO ni FLIT. La resolución y la consolidación se sustituyen; el EMISOR es el real, que es
// quien pone `Content-Disposition`.
vi.mock('../../src/shared/soportes/soportes-zip.js', async (orig) => ({
  ...(await orig<typeof import('../../src/shared/soportes/soportes-zip.js')>()),
  resolverEntradasZip: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/shared/soportes/soportes-zip-consolidar.js', async (orig) => ({
  ...(await orig<typeof import('../../src/shared/soportes/soportes-zip-consolidar.js')>()),
  consolidarPorRegistro: vi.fn().mockResolvedValue({
    entradas: [], incluidos: 0, omitidos: 0, limpiar: vi.fn().mockResolvedValue(undefined),
  }),
}));
await import('../../src/db/client.js'); // evalúa la factory del doble y deja `h.cap` listo

const T1 = '00000000-0000-0000-0000-0000000000d1';
const T2 = '00000000-0000-0000-0000-0000000000d2';
const URL_DETALLE = `/api/flito/tramites/${T1}/detalle`;
const URL_ZIP = '/api/flito/tramites/soportes/zip';
const C = 42;

async function app() {
  const a = express();
  a.use(express.json());
  const { default: router } = await import('../../src/modules/flito-tramites/flito-tramites.routes.js');
  const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');
  a.use('/api/flito/tramites', conAlcance('tramites', router));
  a.use(errorHandler);
  return a;
}

let sub = 44_000;
const admin = async () => `Bearer ${await testToken({ sub: ++sub, role: 'admin' })}`;
const deCompania = async () => `Bearer ${await testToken({
  sub: ++sub, role: 'xyz_renombrado' as never, tipoEnlace: 'compania', funciones: ['tramites.cola.ver'],
})}`;
const wheresTramites = () => h.cap.sqlDeWheres().filter((w) => !w.sql.includes('"users"') && w.sql.includes('"flito_tramites"'));

/** Fila cruda de la proyección del listado (la misma que usa el detalle). */
const fila = {
  tramiteId: T1, idFlit: 'FLIT-DEMO-101', fuente: 'flit', estadoTramite: 'activo', flitEstado: 'Asignado',
  placa: 'QTQ100', vin: '9BWZZZ377VT004251', marca: 'MAZDA', linea: 'CX-30', tipoVehiculo: 'AUTOMOVIL',
  companiaId: C, companiaNombre: 'Gestora Uno', companiaNit: '900123456',
  soatAutogestionable: false, impuestosAutogestionable: false, logisticaAutogestionable: false,
  tipoTramite: 'Matrícula inicial', ciudad: 'Bogotá', transitoNombreFlit: 'STT Bogotá', organismoCodigo: '11001',
  fechaCreacionFlit: new Date('2026-10-01T10:00:00Z'), creadoEn: new Date('2026-10-02T10:00:00Z'),
  fechaAprobacion: null, derechoValor: '150000', tipoTitularFlit: 'cc', sincronizadoEn: new Date('2026-10-03T10:00:00Z'),
  facturaVentaFlitId: 'FV-1', nombreGestor: 'Marta Gómez', correoGestor: 'marta@gestora.co',
  soatId: '00000000-0000-0000-0000-00000000005a', soatEstado: 'pagado', soatValorPagado: '850000',
  soatProveedorId: null, soatProveedorNombre: 'Aseguradora X',
  impuestoId: null,
};
const comprador = {
  nombreCompleto: 'Ana Pérez', numeroDocumento: '1012345678', correo: 'ana@correo.co',
  celular: '3001234567', direccion: 'Cra 1 # 2-3', orden: 1, porcentajeParticipacion: '100',
};

beforeEach(() => { h.cap.reset(); pii.logPiiAccess.mockClear(); });

describe('ADR-0046 · GET /:id/detalle — autenticación y permiso', () => {
  it('401 sin token, sin BD ni rastro', async () => {
    const r = await request(await app()).get(URL_DETALLE);
    expect(r.status).toBe(401);
    expect(h.cap.consultas).toHaveLength(0);
    expect(pii.logPiiAccess).not.toHaveBeenCalled();
  });

  it('403 sin la función tramites.cola.ver, sin consultar trámites ni escribir rastro', async () => {
    const t = await testToken({ sub: ++sub, role: 'xyz_sin_nada' as never, funciones: ['tramites.tramite.ver_soportes'] });
    const r = await request(await app()).get(URL_DETALLE).set('Authorization', `Bearer ${t}`);
    expect(r.status).toBe(403);
    expect(wheresTramites()).toHaveLength(0);
    expect(pii.logPiiAccess).not.toHaveBeenCalled();
  });
});

describe('ADR-0046 · GET /:id/detalle — 404 sin enumeración', () => {
  it('id que no es uuid → 404 «El trámite no existe», sin tocar la BD ni rastro (el ADR descarta el 400)', async () => {
    const r = await request(await app()).get('/api/flito/tramites/QTQ100/detalle').set('Authorization', await admin());
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'El trámite no existe' });
    expect(wheresTramites()).toHaveLength(0);
    expect(pii.logPiiAccess).not.toHaveBeenCalled();
  });

  it('inexistente → 404 con el mismo texto, sin rastro', async () => {
    h.cap.responder([]);
    const r = await request(await app()).get(URL_DETALLE).set('Authorization', await admin());
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'El trámite no existe' });
    expect(pii.logPiiAccess).not.toHaveBeenCalled();
  });

  it('fuera de alcance: con enlace compañía el WHERE lleva id Y compania_id = C; sin fila → 404 sin rastro', async () => {
    h.cap.responder([{ c: C, p: null }], []);
    const r = await request(await app()).get(URL_DETALLE).set('Authorization', await deCompania());
    expect(r.status).toBe(404);
    const [w] = wheresTramites();
    expect(w.sql).toContain('"flito_tramites"."id" = $');
    const m = /"flito_tramites"\."compania_id" = \$(\d+)/.exec(w.sql);
    expect(m).not.toBeNull();
    expect(w.params[Number(m![1]) - 1]).toBe(C);
    expect(w.params).toContain(T1);
    expect(pii.logPiiAccess).not.toHaveBeenCalled();
  });
});

describe('ADR-0046 · GET /:id/detalle — 200', () => {
  it('200 no-store con resumen, vehículo, propietarios, gestora y costos', async () => {
    h.cap.responder([fila], [comprador]);
    const r = await request(await app()).get(URL_DETALLE).set('Authorization', await admin());
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({
      id: T1, idFlit: 'FLIT-DEMO-101',
      resumen: {
        estado: 'Asignado', asignado: true, tipoTramite: 'Matrícula inicial', fuente: 'flit',
        creado: '2026-10-01T10:00:00.000Z', aprobado: null, ciudad: 'Bogotá',
        semaforo: expect.any(String), pendientes: expect.any(Array), sincronizadoEn: '2026-10-03T10:00:00.000Z',
      },
      vehiculo: { placa: 'QTQ100', vin: '9BWZZZ377VT004251', marca: 'MAZDA', linea: 'CX-30', clase: 'AUTOMOVIL' },
      propietarios: [{
        nombreCompleto: 'Ana Pérez', numeroDocumento: '1012345678', correo: 'ana@correo.co', celular: '3001234567',
        direccion: 'Cra 1 # 2-3', orden: 1, porcentajeParticipacion: 100,
      }],
      gestora: {
        nombre: 'Gestora Uno', nit: '900123456', existe: true, nombrePersona: 'Marta Gómez', correoPersona: 'marta@gestora.co',
      },
      costos: {
        tieneFacturaVenta: true,
        conceptos: [
          { concepto: 'soat', quienCobra: 'Aseguradora X', autogestionado: false, estado: 'pagado', valor: 850000, valorLiquidado: null },
          { concepto: 'impuesto', quienCobra: 'STT Bogotá', autogestionado: false, estado: null, valor: null, valorLiquidado: null },
          { concepto: 'derecho_transito', quienCobra: 'STT Bogotá', autogestionado: false, estado: null, valor: 150000, valorLiquidado: null },
        ],
        total: 1_000_000,
      },
    });
    // Solo campos del modelo: ni motor ni año-modelo inventados.
    expect(Object.keys(r.body.vehiculo).sort()).toEqual(['clase', 'linea', 'marca', 'placa', 'vin']);
    // Los compradores se piden SOLO del trámite del path.
    expect(h.cap.sqlDeWheres().some((w) => w.sql.includes('"flito_compradores"."tramite_id" = $') && w.params.includes(T1))).toBe(true);
  });

  it('rastro PII `read`: recurso flito_tramite, uuid en el motivo (no cabe en resource_id integer), NOMBRES de campos del titular y ningún valor', async () => {
    h.cap.responder([fila], [comprador]);
    await request(await app()).get(URL_DETALLE).set('Authorization', await admin());
    expect(pii.logPiiAccess).toHaveBeenCalledTimes(1);
    const [, opts] = pii.logPiiAccess.mock.calls[0]!;
    expect(opts).toEqual({
      resourceTipo: 'flito_tramite', resourceId: null, accion: 'read',
      camposAccedidos: ['nombre_completo', 'tipo_documento', 'numero_documento', 'correo', 'celular', 'direccion', 'nombre_gestor', 'correo_gestor'],
      motivo: `Lectura de detalle de trámite — tramite=${T1}`,
    });
    expect(JSON.stringify(opts)).not.toMatch(/Ana|1012345678|ana@correo|3001234567|Cra 1|QTQ100|9BWZZZ|FLIT-DEMO-101/);
  });

  it('con enlace compañía y el trámite en su alcance → 200 y rastro', async () => {
    h.cap.responder([{ c: C, p: null }], [fila], [comprador]);
    const r = await request(await app()).get(URL_DETALLE).set('Authorization', await deCompania());
    expect(r.status).toBe(200);
    expect(pii.logPiiAccess).toHaveBeenCalledTimes(1);
  });
});

describe('ADR-0046 · POST /soportes/zip — nombre del archivo', () => {
  it('UN trámite → `[ID del trámite]-DOCS.zip` (id_flit, no la placa), con el rastro PII de export de siempre', async () => {
    // 1.ª consulta: registros del ZIP; 2.ª: el id_flit del trámite para el nombre.
    h.cap.responder([], [{ idFlit: 'FLIT-DEMO-101' }]);
    const r = await request(await app()).post(URL_ZIP).set('Authorization', await admin())
      .send({ ids: [T1], tipos: ['factura_soat'] });
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toBe('attachment; filename="FLIT-DEMO-101-DOCS.zip"');
    expect(r.headers['content-disposition']).not.toContain('QTQ100');
    expect(pii.logPiiAccess).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accion: 'export', resourceTipo: 'flito_tramite' }));
  });

  it('el mismo id repetido cuenta como UN trámite', async () => {
    h.cap.responder([], [{ idFlit: 'FLIT-DEMO-101' }]);
    const r = await request(await app()).post(URL_ZIP).set('Authorization', await admin())
      .send({ ids: [T1, T1], tipos: ['factura_soat'] });
    expect(r.headers['content-disposition']).toBe('attachment; filename="FLIT-DEMO-101-DOCS.zip"');
  });

  it('id_flit con caracteres de cabecera se sanea (sin comillas ni barras)', async () => {
    h.cap.responder([], [{ idFlit: 'FLIT"/../101' }]);
    const r = await request(await app()).post(URL_ZIP).set('Authorization', await admin())
      .send({ ids: [T1], tipos: ['factura_soat'] });
    expect(r.headers['content-disposition']).toBe('attachment; filename="FLIT-..-101-DOCS.zip"');
  });

  it('VARIOS trámites → conserva `soportes_AAAAMMDD-HHMM.zip` y no consulta el id_flit', async () => {
    h.cap.responder([]);
    const r = await request(await app()).post(URL_ZIP).set('Authorization', await admin())
      .send({ ids: [T1, T2], tipos: ['factura_soat'] });
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="soportes_\d{8}-\d{4}\.zip"$/);
    expect(h.cap.consultas.filter((c) => c.tipo === 'select')).toHaveLength(1);
  });

  it('UN trámite fuera de alcance o inexistente (sin id_flit) → nombre de siempre, nunca vacío', async () => {
    h.cap.responder([], []);
    const r = await request(await app()).post(URL_ZIP).set('Authorization', await admin())
      .send({ ids: [T1], tipos: ['factura_soat'] });
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="soportes_\d{8}-\d{4}\.zip"$/);
  });

  it('sigue exigiendo tramites.soportes.descargar: el auditor (ve soportes, no descarga) → 403', async () => {
    const t = await testToken({ sub: ++sub, role: 'auditor' });
    const r = await request(await app()).post(URL_ZIP).set('Authorization', `Bearer ${t}`)
      .send({ ids: [T1], tipos: ['factura_soat'] });
    expect(r.status).toBe(403);
  });
});
