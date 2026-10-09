// HU #13426 (Feature #12871) — Impuestos abierto a `compania` y a `organismos_transito`: AC2, AC3,
// AC5, AC6, AC8, AC9 (rol renombrado) y la contingencia de Operaciones (P-3).
//
// Router REAL montado como en `app.ts`; doble de drizzle que captura los `where` (asertos sobre el SQL
// del COUNT y de la página, no sobre filas inventadas).
import 'express-async-errors';
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
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
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.analisis.service.js', () => ({
  encolarAnalisis: vi.fn(), marcarEnCursoEnTx: vi.fn().mockResolvedValue([]),
}));
await import('../../src/db/client.js');

const FUNCIONES = [
  'impuestos.cola.ver', 'impuestos.cola.filtrar', 'impuestos.tramite.enviar', 'impuestos.tramite.asumir',
  'impuestos.tramite.devolver', 'impuestos.tramite.reactivar',
];
const C = 42;
const S1 = '05001';
const S2 = '11001';
const I1 = '00000000-0000-0000-0000-0000000000a1';
const I_AJENO = '00000000-0000-0000-0000-0000000000b2';

async function app() {
  const a = express();
  a.use(express.json());
  const { default: router } = await import('../../src/modules/flito-impuestos/flito-impuestos.routes.js');
  const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');
  a.use('/api/flito/impuestos', conAlcance('impuestos', router));
  a.use(errorHandler);
  return a;
}

let sub = 8200;
const como = async (tipoEnlace: string, role = 'xyz_renombrado') =>
  `Bearer ${await testToken({ sub: ++sub, role: role as never, tipoEnlace, funciones: FUNCIONES })}`;

/** WHEREs de la cola (sin las lecturas del alcance: `users` y la puente). */
const wheresCola = () => h.cap.sqlDeWheres().filter((w) => !w.sql.includes('"users"') && !w.sql.includes('flito_gestor_organismos'));

beforeEach(() => { h.cap.reset(); });

describe('AC2 — compañía: la cola, el COUNT y las facetas solo de C', () => {
  it('GET / → `flito_impuestos.compania_id = C` en el COUNT y en la página', async () => {
    h.cap.responder([{ c: C, p: null }], [{ total: 0 }], []);
    const r = await request(await app()).get('/api/flito/impuestos').set('Authorization', await como('compania'));
    expect(r.status).toBe(200);
    const w = wheresCola();
    expect(w).toHaveLength(2);
    for (const x of w) {
      const m = /"flito_impuestos"\."compania_id" = \$(\d+)/.exec(x.sql);
      expect(m, x.sql).not.toBeNull();
      expect(x.params[Number(m![1]) - 1]).toBe(C);
    }
  });

  it('AC7 — facetas: las dos consultas acotadas a C', async () => {
    h.cap.responder([{ c: C, p: null }]);
    const r = await request(await app()).get('/api/flito/impuestos/facetas').set('Authorization', await como('compania'));
    expect(r.status).toBe(200);
    const w = wheresCola();
    expect(w).toHaveLength(2);
    for (const x of w) expect(x.params).toContain(C);
  });

  it('AC8 — un `admin` con enlace compañía queda acotado a C', async () => {
    h.cap.responder([{ c: C, p: null }], [{ total: 0 }], []);
    await request(await app()).get('/api/flito/impuestos').set('Authorization', await como('compania', 'admin'));
    expect(wheresCola().every((x) => x.params.includes(C))).toBe(true);
  });
});

describe('AC6 / AC9 — organismos: SUS secretarías (S1 y S2), decida el enlace y no el nombre del rol', () => {
  it('un rol RENOMBRADO con enlace organismos [S1, S2] ve lo mismo que el antiguo `gestor_impuestos`', async () => {
    const sqlDe = async (rol: string) => {
      h.cap.reset();
      h.cap.responder([{ c: S1 }, { c: S2 }], [{ total: 0 }], []);
      const r = await request(await app()).get('/api/flito/impuestos').set('Authorization', await como('organismos_transito', rol));
      expect(r.status).toBe(200);
      return wheresCola();
    };
    const renombrado = await sqlDe('xyz_renombrado');
    const antiguo = await sqlDe('gestor_impuestos');
    expect(renombrado).toEqual(antiguo);
    expect(renombrado).toHaveLength(2);
    for (const x of renombrado) {
      expect(x.sql).toMatch(/"flito_impuestos"\."organismo_codigo" in \(\$\d+, \$\d+\)/);
      expect(x.params).toEqual(expect.arrayContaining([S1, S2]));
      expect(x.sql).toContain('gestion_operaciones'); // la frontera del gestor sigue entera
    }
  });

  it('P-3 — la contingencia de Operaciones (`asumir-operaciones`, `devolver-gestor`) → 403 a todo enlace, sin consultar', async () => {
    for (const ruta of ['asumir-operaciones', 'devolver-gestor']) {
      h.cap.reset();
      const r = await request(await app()).post(`/api/flito/impuestos/${I1}/${ruta}`)
        .set('Authorization', await como('organismos_transito')).send({ motivo: 'contingencia larga' });
      expect([r.status, r.body], ruta).toEqual([403, { error: 'Sin permisos' }]);
      expect(h.cap.consultas).toEqual([]);
    }
  });

  it('P-3 — `reactivar` de un impuesto de OTRA secretaría → 403 y no se escribe', async () => {
    h.cap.responder([{ c: S1 }], []); // puente; el impuesto NO aparece con la condición de S1
    const r = await request(await app()).post(`/api/flito/impuestos/${I_AJENO}/reactivar`)
      .set('Authorization', await como('organismos_transito')).send({ motivo: 'corrección' });
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
    expect(h.cap.consultas.filter((c) => c.tipo !== 'select')).toEqual([]);
    const q = h.cap.sqlDeWheres().find((w) => w.params.includes(I_AJENO))!;
    expect(q.sql).toMatch(/"flito_impuestos"\."organismo_codigo" in \(\$\d+\)/);
  });
});

describe('AC3 — escribir para otra compañía → 403 sin guardar', () => {
  it('POST /enviar con un id ajeno en el lote → 403; no se abre transacción ni se actualiza nada', async () => {
    h.cap.responder([{ c: C, p: null }], [{ id: I1 }]); // de [I1, I_AJENO] solo I1 es de C
    const r = await request(await app()).post('/api/flito/impuestos/enviar')
      .set('Authorization', await como('compania')).send({ ids: [I1, I_AJENO] });
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
    expect(h.cap.consultas.filter((c) => c.tipo !== 'select')).toEqual([]);
  });

  it('`reactivar` con un id que no es uuid → 403 sin llegar a consultar impuestos (no un 500 de Postgres)', async () => {
    h.cap.responder([{ c: C, p: null }]);
    const r = await request(await app()).post('/api/flito/impuestos/no-es-uuid/reactivar')
      .set('Authorization', await como('compania')).send({ motivo: 'se corrigió la factura' });
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
    expect(h.cap.consultas).toHaveLength(1); // solo la lectura del alcance
  });
});

describe('P-3 — enviar con `gestionOperaciones` (contingencia) también es interno', () => {
  it('compañía con la función de enviar + `gestionOperaciones: true` → 403 sin tocar nada', async () => {
    h.cap.responder([{ c: C, p: null }]);
    const r = await request(await app()).post('/api/flito/impuestos/enviar')
      .set('Authorization', await como('compania')).send({ ids: [I1], gestionOperaciones: true });
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
    expect(h.cap.consultas).toHaveLength(1); // solo la lectura del alcance
  });
});

describe('AC1 / AC5 — sin enlace ve todo; proveedor cerrado', () => {
  it('sin enlace: la cola no lleva condición de compañía ni de organismo', async () => {
    h.cap.responder([{ total: 0 }], []);
    const r = await request(await app()).get('/api/flito/impuestos').set('Authorization', await como('ninguno', 'mensajero'));
    expect(r.status).toBe(200);
    for (const x of wheresCola()) {
      expect(x.sql).not.toContain('compania_id" =');
      expect(x.sql).not.toContain('organismo_codigo" in');
    }
  });

  it('proveedor → 403 de la frontera', async () => {
    const r = await request(await app()).get('/api/flito/impuestos').set('Authorization', await como('proveedor'));
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
  });
});

describe('Habeas Data (bloqueante de security) — la compañía no recibe nombres de empleados de FLIT', () => {
  const VER = [...FUNCIONES, 'impuestos.tramite.ver', 'impuestos.tramite.ver_historial'];
  const conVer = async (tipoEnlace: string, role = 'xyz_renombrado') =>
    `Bearer ${await testToken({ sub: ++sub, role: role as never, tipoEnlace, funciones: VER })}`;
  const IMP = { id: I1, tramiteId: 't1', companiaId: C, organismoCodigo: S1, gestionOperaciones: false, pagadoEn: null, extraccion: null, extraccionFacturaVenta: null, comparacionFacturaRunt: null };
  const FILA = {
    id: I1, tramiteId: 't1', idFlit: 'F-1', placa: 'ABC123', vin: null, marca: null, linea: null, tipoTramite: 'traspaso',
    fechaAprobacion: null, fechaCreacion: null, estado: 'solicitado', companiaNombre: 'Cia', organismoCodigo: S1, organismoNombre: 'Med',
    valorLiquidado: null, valorPagado: null, marcadoPorDiferencia: false, facturaVentaFlitId: null,
    enviadoPorNombre: 'Ana Interna', enviadoEn: new Date('2026-10-01T00:00:00Z'), pagadoEn: null, gestionOperaciones: false,
    organismoSla: null, motivoRechazo: null, createdAt: new Date('2026-10-01T00:00:00Z'), analisisEstado: null, semaforo: null,
    motivoSemaforo: null, liquidadoEn: null, tipoTitularFlit: null,
  };
  const CERT = { id: 'c1', impuestoId: I1, createdAt: new Date('2026-10-02T00:00:00Z'), certificadoPorNombre: 'Beto Interno', certificadoPorId: 7 };
  const HIST = { id: 'h1', estadoAnterior: 'pendiente', estadoNuevo: 'solicitado', motivo: null, origen: 'usuario', usuarioNombre: 'Ana Interna', usuarioEmail: 'ana@flit.co', usuarioRol: 'admin', creadoEn: new Date('2026-10-01T00:00:00Z') };
  /** Las lecturas de `detalleImpuesto`: frontera, fila de la cola, compradores, certificación vigente. */
  const detalle = () => h.cap.responder([{ imp: IMP, dentroDeFrontera: true }], [FILA], [], [CERT]);
  /**
   * Respuestas vacías para el resto de lecturas de `detalleImpuesto` (soportes, envío, dirección): las
   * que haya hoy, medidas con un detalle de prueba, para que la siguiente sea la del historial.
   */
  let restantes = -1;
  const relleno = (): unknown[][] => Array.from({ length: restantes }, () => []);
  beforeAll(async () => {
    h.cap.reset();
    detalle();
    await request(await app()).get(`/api/flito/impuestos/${I1}`).set('Authorization', await conVer('ninguno', 'admin'));
    restantes = h.cap.consultas.length - 4;
    h.cap.reset();
  });

  it('compañía: detalle con `enviadoPorNombre` y `certificadoPorNombre` en null', async () => {
    h.cap.responder([{ c: C, p: null }]);
    detalle();
    const r = await request(await app()).get(`/api/flito/impuestos/${I1}`).set('Authorization', await conVer('compania'));
    expect(r.status).toBe(200);
    expect(r.body.enviadoPorNombre).toBeNull();
    expect(r.body.certificacion).toEqual(expect.objectContaining({ id: 'c1', certificadoPorNombre: null }));
    expect(JSON.stringify(r.body)).not.toMatch(/Ana Interna|Beto Interno/);
  });

  it('sin enlace: el detalle nombra a quien envió y a quien certificó', async () => {
    detalle();
    const r = await request(await app()).get(`/api/flito/impuestos/${I1}`).set('Authorization', await conVer('ninguno', 'admin'));
    expect(r.status).toBe(200);
    expect([r.body.enviadoPorNombre, r.body.certificacion.certificadoPorNombre]).toEqual(['Ana Interna', 'Beto Interno']);
  });

  it('compañía: el historial sale con `usuario` en null (ni nombre ni correo)', async () => {
    h.cap.responder([{ c: C, p: null }]);
    detalle();
    h.cap.responder(...relleno(), [HIST]);
    const r = await request(await app()).get(`/api/flito/impuestos/${I1}/historial`).set('Authorization', await conVer('compania'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual([expect.objectContaining({ id: 'h1', usuario: null })]);
    expect(JSON.stringify(r.body)).not.toMatch(/Ana Interna|ana@flit\.co/);
  });

  it('sin enlace: el historial nombra al actor', async () => {
    detalle();
    h.cap.responder(...relleno(), [HIST]);
    const r = await request(await app()).get(`/api/flito/impuestos/${I1}/historial`).set('Authorization', await conVer('ninguno', 'admin'));
    expect(r.status).toBe(200);
    expect(r.body[0].usuario).toBe('Ana Interna');
  });
});
