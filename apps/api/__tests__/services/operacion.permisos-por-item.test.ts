// HU #13422 (ADR-0023) — Mantenimiento, Vehículos, Flota, RNDC, Rutas, Liquidación, Finanzas y Clientes
// piden permiso, no rol. Comportamiento HTTP de las guardas nuevas contra el motor real
// (`exigirFuncion` → `resolverPermisos`), con la lectura de filas sustituida por el double de
// `helpers/auth.ts` (`registrarUsuarioDePrueba`). Mismo esquema que pesv.permisos-por-item.test.ts.
//
//   · AC1: ninguna ruta de maintenance/ pide la página única `maintenance` (con solo ella → 403).
//   · AC2: ítem A habilitado y B no → 200 en A; 403 en B, sin datos de B (ni consulta).
//   · AC3: los siete directorios restantes piden su permiso: un rol LLAMADO `admin` sin la función →
//     403; con ella, la misma respuesta que hoy. La partida del catálogo (`testToken` por rol) conserva
//     lo de antes: financiera y auditor leen clientes y el reporte de costos.
//   · AC4: escribir exige «Administrar <ítem>» aunque se tenga la página.
//   · AC8 (en línea): el documento del propietario en /api/vehicles lo decide una función, no el rol.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { SignJWT } from 'jose';
import { chain } from '../helpers/db.js';
import { registrarUsuarioDePrueba, testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();
const executeMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: deleteMock, execute: executeMock, transaction: transactionMock },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('express-rate-limit', () => ({ default: () => (_req: any, _res: any, next: any) => next() }));

let app: any;
beforeEach(async () => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset();
  deleteMock.mockReset(); executeMock.mockReset(); transactionMock.mockReset();
  executeMock.mockResolvedValue([]);
  selectMock.mockImplementation(() => chain([]));
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

/** Un usuario con EXACTAMENTE estas funciones en su rol (nombre de rol a elección). */
async function usuario(sub: number, rol: string, funciones: string[]): Promise<string> {
  await registrarUsuarioDePrueba(sub, { rol, tipoEnlace: 'ninguno', funcionesDelRol: funciones, excepciones: [] });
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  const jwt = await new SignJWT({ username: `u${sub}`, role: rol })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub)).setExpirationTime('1h').sign(secret);
  return `Bearer ${jwt}`;
}

describe('AC2 — un ítem de Mantenimiento habilitado y otro no', () => {
  it('con solo `pagina.maintenance_ordenes`: 200 en las órdenes de trabajo y 403 en indicadores y rutinas, sin tocar la base', async () => {
    const auth = await usuario(9201, 'supervisor_flota', ['pagina.maintenance_ordenes']);
    const ok = await request(app).get('/api/maintenance/work-orders').set('Authorization', auth);
    expect(ok.status).toBe(200);

    selectMock.mockClear();
    const ind = await request(app).get('/api/maintenance/indicators').set('Authorization', auth);
    expect(ind.status).toBe(403);
    expect(ind.body).toMatchObject({ funcion: 'pagina.maintenance_indicadores' });
    const rut = await request(app).get('/api/maintenance/routines').set('Authorization', auth);
    expect(rut.status).toBe(403);
    expect(rut.body).toMatchObject({ funcion: 'pagina.maintenance_inicio' });
    expect(rut.body).not.toHaveProperty('data');
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('el catálogo de /api/maintenance ya no deja pasar a /work-orders con otra página: con solo `pagina.maintenance_inicio` → 403 en órdenes', async () => {
    const auth = await usuario(9202, 'lider_pesv', ['pagina.maintenance_inicio']);
    expect((await request(app).get('/api/maintenance/jobs').set('Authorization', auth)).status).toBe(200);
    const r = await request(app).get('/api/maintenance/work-orders').set('Authorization', auth);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ funcion: 'pagina.maintenance_ordenes' });
  });

  it('rutas: con solo `pagina.pesv_pernocta` entra a /api/rutas/pernocta y no a /api/rutas', async () => {
    const auth = await usuario(9203, 'conductor', ['pagina.pesv_pernocta']);
    expect((await request(app).get('/api/rutas/pernocta').set('Authorization', auth)).status).toBe(200);
    const r = await request(app).get('/api/rutas').set('Authorization', auth);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ funcion: 'pagina.pesv_rutas' });
  });
});

describe('AC1 — ninguna ruta de maintenance/ (ni de rutas/) pide la página única', () => {
  it('quien tiene `pagina.maintenance` y ninguna de sus tres páginas NO entra a ninguno de los tres ítems', async () => {
    const auth = await usuario(9204, 'supervisor_flota', ['pagina.maintenance']);
    for (const [ruta, pagina] of [
      ['/api/maintenance/schedule', 'pagina.maintenance_inicio'],
      ['/api/parts', 'pagina.maintenance_inicio'],
      ['/api/maintenance/work-orders', 'pagina.maintenance_ordenes'],
      ['/api/maintenance/indicators', 'pagina.maintenance_indicadores'],
    ] as const) {
      const r = await request(app).get(ruta).set('Authorization', auth);
      expect(r.status, ruta).toBe(403);
      expect(r.body, ruta).toMatchObject({ funcion: pagina });
    }
  });

  it('quien tiene `pagina.pesv` y no `pagina.pesv_rutas` NO entra a /api/rutas', async () => {
    const auth = await usuario(9205, 'conductor', ['pagina.pesv']);
    const r = await request(app).get('/api/rutas/risk').set('Authorization', auth);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ funcion: 'pagina.pesv_rutas' });
  });
});

describe('AC3 — vehicles/, fleet/, rndc/, liquidacion/, finanzas/ y clients/ piden su permiso, no el nombre del rol', () => {
  it('vehicles: `admin` sin `vehicles.vehiculos.administrar` → 403 en las estadísticas; con ella → 200', async () => {
    const sin = await usuario(9206, 'admin', []);
    const r = await request(app).get('/api/vehicles/pipeline/stats').set('Authorization', sin);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ funcion: 'vehicles.vehiculos.administrar' });
    const con = await usuario(9207, 'cualquiera', ['vehicles.vehiculos.administrar']);
    expect((await request(app).get('/api/vehicles/pipeline/stats').set('Authorization', con)).status).toBe(200);
  });

  it('vehicles (OCR): `admin` sin la función → 403 antes de leer el archivo', async () => {
    const sin = await usuario(9208, 'admin', []);
    const r = await request(app).post('/api/vehicles/ocr-export').set('Authorization', sin).send({});
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ funcion: 'vehicles.vehiculos.administrar' });
  });

  it('rndc: con `pagina.rndc_admin` y sin `rndc.credenciales.administrar` → 403; con las dos → 200', async () => {
    const sin = await usuario(9209, 'admin', ['pagina.rndc_admin']);
    const r = await request(app).get('/api/rndc/credenciales').set('Authorization', sin);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ funcion: 'rndc.credenciales.administrar' });
    const con = await usuario(9210, 'cualquiera', ['pagina.rndc_admin', 'rndc.credenciales.administrar']);
    expect((await request(app).get('/api/rndc/credenciales').set('Authorization', con)).status).toBe(200);
  });

  it('liquidacion: `admin` sin `liquidacion.pago_manual.administrar` → 403; con ella → 200', async () => {
    const sin = await usuario(9211, 'admin', []);
    const r = await request(app).get('/api/liquidaciones?woId=1').set('Authorization', sin);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ funcion: 'liquidacion.pago_manual.administrar' });
    const con = await usuario(9212, 'cualquiera', ['liquidacion.pago_manual.administrar']);
    expect((await request(app).get('/api/liquidaciones?woId=1').set('Authorization', con)).status).toBe(200);
  });

  it('finanzas: un rol llamado `financiera` sin `finanzas.reporte_costos.ver` → 403 en las facetas del reporte', async () => {
    const sin = await usuario(9213, 'financiera', []);
    const r = await request(app).get('/api/finanzas/reporte-costos/facetas').set('Authorization', sin);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ funcion: 'finanzas.reporte_costos.ver' });
  });

  it('clients: un rol llamado `auditor` sin `clients.clientes.ver` → 403; la partida de financiera y auditor → 200', async () => {
    const sin = await usuario(9214, 'auditor', []);
    const r = await request(app).get('/api/clients').set('Authorization', sin);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ funcion: 'clients.clientes.ver' });
    for (const [role, sub] of [['financiera', 9215], ['auditor', 9216]] as const) {
      const auth = `Bearer ${await testToken({ role, sub })}`;
      expect((await request(app).get('/api/clients').set('Authorization', auth)).status, role).toBe(200);
    }
  });
});

describe('AC4 — escribir en un ítem exige «Administrar <ítem>»', () => {
  it('con la página de Mantenimiento y sin `maintenance.inicio.administrar` → 403 al crear una rutina; con ella pasa la guarda', async () => {
    const sin = await usuario(9217, 'lider_pesv', ['pagina.maintenance_inicio']);
    const r = await request(app).post('/api/maintenance/routines').set('Authorization', sin).send({});
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ funcion: 'maintenance.inicio.administrar' });
    expect(insertMock).not.toHaveBeenCalled();

    const con = await usuario(9218, 'lider_pesv', ['pagina.maintenance_inicio', 'maintenance.inicio.administrar']);
    const ok = await request(app).post('/api/maintenance/routines').set('Authorization', con).send({});
    expect(ok.status).toBe(400); // la misma validación de hoy: pasó la guarda
  });

  it('flota: con `pagina.fleet` y sin `fleet.flota.administrar` → 403 al vincular; clientes: sin `clients.clientes.administrar` → 403 al crear', async () => {
    const auth = await usuario(9219, 'supervisor_flota', ['pagina.fleet', 'clients.clientes.ver']);
    const f = await request(app).post('/api/fleet/links').set('Authorization', auth).send({});
    expect(f.status).toBe(403);
    expect(f.body).toMatchObject({ funcion: 'fleet.flota.administrar' });
    const c = await request(app).post('/api/clients').set('Authorization', auth).send({});
    expect(c.status).toBe(403);
    expect(c.body).toMatchObject({ funcion: 'clients.clientes.administrar' });
  });

  it('la partida de `supervisor_flota` (catálogo) entra a las tres páginas de Mantenimiento y NO crea órdenes (solo admin hoy)', async () => {
    const sup = `Bearer ${await testToken({ role: 'supervisor_flota', sub: 9220 })}`;
    for (const ruta of ['/api/maintenance/schedule', '/api/maintenance/work-orders', '/api/maintenance/indicators']) {
      expect((await request(app).get(ruta).set('Authorization', sup)).status, ruta).not.toBe(403);
    }
    const r = await request(app).post('/api/maintenance/work-orders').set('Authorization', sup).send({});
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ funcion: 'maintenance.ordenes.administrar' });
  });
});

describe('AC8 — el documento del propietario en /api/vehicles lo decide `vehicles.propietario.ver_documento`', () => {
  const FILA = { id: 1, plate: 'ABC123', ownerDocument: '1020304050', soatStatus: null };

  it('un rol llamado `admin` sin la función lo recibe enmascarado; con la función (cualquier rol), completo', async () => {
    selectMock.mockImplementation(() => chain([FILA]));
    // HU #13423: el listado pide además `vehicles.vehiculos.consultar` (antes bastaba la sesión).
    const sin = await usuario(9221, 'admin', ['vehicles.vehiculos.consultar']);
    const a = await request(app).get('/api/vehicles').set('Authorization', sin);
    expect(a.status).toBe(200);
    expect(a.body[0].ownerDocument).toBe('1020****');

    const con = await usuario(9222, 'supervisor_flota', ['vehicles.vehiculos.consultar', 'vehicles.propietario.ver_documento']);
    const b = await request(app).get('/api/vehicles').set('Authorization', con);
    expect(b.status).toBe(200);
    expect(b.body[0].ownerDocument).toBe('1020304050');
  });
});
