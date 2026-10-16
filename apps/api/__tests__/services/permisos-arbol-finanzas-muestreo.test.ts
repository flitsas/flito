// HU #13427 AC2 — Cada endpoint exige su acción. Muestreo 200/403 POR PAR ítem/acción, por HTTP: la guarda
// real (`exigirFuncion`) sobre el resolutor real (fuente de filas de pruebas), como el de #12873. Y el router
// REAL de credenciales de Siigo, que decide en línea por ambiente (POST por el cuerpo, DELETE por la fila).
// No se monta el router de Finanzas ni de liquidación (arrastran la base y cientos de tests seriales).
//
// Mutantes nombrados:
//   · en `credenciales.routes.ts`, invertir las ramas de `puedeAmbiente` → caen los 4 casos por ambiente.
//   · en `credenciales.routes.ts`, decidir el DELETE antes de leer el ambiente (p. ej. siempre «pruebas»)
//     → cae «DELETE de una credencial de producción con solo pruebas: 403 y no desactiva».
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { conCadenaEnFuente } from '../helpers/auth.js';

vi.mock('../../src/db/client.js', () => ({ db: {}, getPoolStats: vi.fn() }));
// Implementación en el constructor (sobrevive a `mockReset`): el escritor real devuelve una promesa y `decidir` le hace `.catch`.
const bitacora = vi.hoisted(() => ({ registrarIntentoDenegado: vi.fn(async (_fila: { metodo: string; codigo: string; userId: number }) => undefined) }));
vi.mock('../../src/shared/historial/permisos-intentos-denegados.js', () => bitacora);
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/logger.js', () => {
  const l = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { loggerFor: () => l, logger: l };
});
vi.mock('../../src/shared/middleware/auth.js', () => ({
  authMiddleware: (req: Request, _res: Response, next: NextFunction) => {
    const sub = Number(req.header('x-sub'));
    req.user = { sub, username: 'prueba', role: `rol_${sub}` } as Request['user'];
    next();
  },
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
const svc = vi.hoisted(() => ({
  ambienteDeCredencial: vi.fn(),
  desactivarCredencial: vi.fn(),
  guardarCredencial: vi.fn(),
  listarCredenciales: vi.fn(),
}));
vi.mock('../../src/modules/siigo/credenciales.service.js', () => ({ ...svc, SiigoCredencialError: class extends Error {} }));
vi.mock('../../src/modules/siigo/siigo.diagnostico.service.js', () => ({ probarConexion: vi.fn().mockResolvedValue({ ok: true }) }));

const { exigirFuncion } = await import('../../src/shared/middleware/exigir-funcion.js');
const { fijarFuenteDePermisos, invalidarPermisosDe } = await import('../../src/shared/permisos-efectivos.js');
const { ACCIONES_POR_AREA, operacionesDe } = await import('../../src/modules/permisos/arbol/expansion.js');
const credenciales = (await import('../../src/modules/siigo/credenciales.routes.js')).default;

const ACCIONES = ACCIONES_POR_AREA.finanzas;
/** La operación de muestra de cada acción: la primera que ninguna otra acción concede. */
const MUESTRA = ACCIONES.map((accion) => {
  const op = operacionesDe(accion).find((o) => ACCIONES.every((otra) => otra === accion || !operacionesDe(otra).includes(o)));
  return { accion, op: op! };
});

let conjuntos: Record<number, readonly string[]> = {};
function fijar(c: Record<number, readonly string[]>) {
  conjuntos = c;
  for (const id of Object.keys(c)) invalidarPermisosDe(Number(id));
  fijarFuenteDePermisos(conCadenaEnFuente(async (userId) => ({ rol: `rol_${userId}`, tipoEnlace: 'ninguno', excepciones: [], funcionesDelRol: [...(conjuntos[userId] ?? [])] })));
}

const lab = express();
lab.use((req: Request, _res: Response, next: NextFunction) => {
  const sub = Number(req.header('x-sub'));
  req.user = { sub, username: 'prueba', role: `rol_${sub}` } as Request['user'];
  next();
});
const ok = (_req: Request, res: Response) => { res.json({ ok: true }); };
MUESTRA.forEach(({ op }, i) => lab.get(`/m/${i}`, exigirFuncion(op), ok));
// El ejemplo del AC2: las guardas reales del listado y de liquidar (individual y lote).
lab.get('/reporte-costos', exigirFuncion('finanzas.reporte_costos.ver'), ok);
lab.post('/liquidar', exigirFuncion('liquidacion.liquidacion.liquidar'), ok);
lab.post('/liquidar-lote', exigirFuncion('liquidacion.liquidacion.liquidar_lote'), ok);
lab.post('/exportar', exigirFuncion('finanzas.reporte_costos.exportar'), ok);

describe('AC2 — muestreo 200/403 por par ítem/acción (guarda real, resolutor real)', () => {
  beforeAll(() => {
    expect(MUESTRA.filter((m) => !m.op).map((m) => m.accion)).toEqual([]);
    expect(MUESTRA).toHaveLength(41);
  });

  it.each(MUESTRA.map((m, i) => [m.accion, m.op, i] as const))('%s → %s', async (accion, op, i) => {
    fijar({ 1: [accion], 2: ACCIONES.filter((a) => a !== accion) });
    const si = await request(lab).get(`/m/${i}`).set('x-sub', '1');
    expect(si.status, `${accion} debería conceder ${op}`).toBe(200);
    const no = await request(lab).get(`/m/${i}`).set('x-sub', '2');
    expect(no.status).toBe(403);
    expect(JSON.stringify(no.body)).not.toMatch(/no reconocida/);
  });

  it('con «Reporte de costos: ver» y sin «liquidar»: listado 200, liquidar (individual y lote) 403, exportar 403', async () => {
    fijar({ 1: ['accion.reporte_costos.ver_listado'], 2: ['accion.reporte_costos.ver_listado', 'accion.reporte_costos.liquidar'] });
    expect((await request(lab).get('/reporte-costos').set('x-sub', '1')).status).toBe(200);
    expect((await request(lab).post('/liquidar').set('x-sub', '1')).status).toBe(403);
    expect((await request(lab).post('/liquidar-lote').set('x-sub', '1')).status).toBe(403);
    expect((await request(lab).post('/exportar').set('x-sub', '1')).status).toBe(403);
    // Control: con «Liquidar» pasan las dos.
    expect((await request(lab).post('/liquidar').set('x-sub', '2')).status).toBe(200);
    expect((await request(lab).post('/liquidar-lote').set('x-sub', '2')).status).toBe(200);
  });
});

describe('AC2 — Integración con Siigo: el router real decide por ambiente', () => {
  const app = express();
  app.use(express.json());
  app.use('/c', credenciales);
  const PRUEBAS = 'accion.integracion_siigo.credenciales_pruebas';
  const PRODUCCION = 'accion.integracion_siigo.credenciales_produccion';
  const PROBAR = 'accion.integracion_siigo.probar_conexion';
  const cuerpo = (ambiente: string) => ({ ambiente, username: 'usuario', accessKey: '12345678' });

  beforeEach(() => {
    for (const f of Object.values(svc)) f.mockReset();
    bitacora.registrarIntentoDenegado.mockClear();
    svc.guardarCredencial.mockImplementation(async (x: { ambiente: string }) => ({ id: 7, ambiente: x.ambiente, username: 'usuario' }));
    svc.desactivarCredencial.mockResolvedValue(true);
    svc.listarCredenciales.mockResolvedValue([]);
    fijar({ 1: [PRUEBAS], 2: [PRODUCCION], 3: [PROBAR], 4: [] });
  });

  it('POST: pruebas con «pruebas» 201 y con «producción» 403; producción al revés', async () => {
    expect((await request(app).post('/c').set('x-sub', '1').send(cuerpo('pruebas'))).status).toBe(201);
    expect((await request(app).post('/c').set('x-sub', '1').send(cuerpo('produccion'))).status).toBe(403);
    expect((await request(app).post('/c').set('x-sub', '2').send(cuerpo('produccion'))).status).toBe(201);
    expect((await request(app).post('/c').set('x-sub', '2').send(cuerpo('pruebas'))).status).toBe(403);
    expect(svc.guardarCredencial).toHaveBeenCalledTimes(2);
  });

  it('DELETE lee el ambiente de la credencial ANTES de decidir: producción con solo «pruebas» → 403 y no desactiva', async () => {
    svc.ambienteDeCredencial.mockResolvedValue('produccion');
    expect((await request(app).delete('/c/5').set('x-sub', '1')).status).toBe(403);
    expect(svc.ambienteDeCredencial).toHaveBeenCalledWith(5);
    expect(svc.desactivarCredencial).not.toHaveBeenCalled();
    expect((await request(app).delete('/c/5').set('x-sub', '2')).status).toBe(200);
    expect(svc.desactivarCredencial).toHaveBeenCalledTimes(1);
  });

  it('sin ninguna de las dos: 403 antes de validar el cuerpo o de leer la base; inexistente con permiso → 404', async () => {
    expect((await request(app).post('/c').set('x-sub', '3').send({})).status).toBe(403);
    expect((await request(app).delete('/c/5').set('x-sub', '4')).status).toBe(403);
    expect(svc.ambienteDeCredencial).not.toHaveBeenCalled();
    svc.ambienteDeCredencial.mockResolvedValue(null);
    expect((await request(app).delete('/c/5').set('x-sub', '1')).status).toBe(404);
  });

  it('sin ninguna de las dos: el 403 temprano deja fila en la bitácora de intentos denegados (POST con su ambiente; DELETE como producción)', async () => {
    const filas = () => bitacora.registrarIntentoDenegado.mock.calls.map(([f]) => `${f.metodo} ${f.codigo} ${f.userId}`);
    expect((await request(app).post('/c').set('x-sub', '3').send({ ambiente: 'pruebas' })).status).toBe(403);
    expect((await request(app).post('/c').set('x-sub', '4').send({})).status).toBe(403);
    expect((await request(app).delete('/c/5').set('x-sub', '4')).status).toBe(403);
    expect(filas()).toEqual([
      'POST siigo.credenciales.registrar_pruebas 3',
      'POST siigo.credenciales.registrar_produccion 4',
      'DELETE siigo.credenciales.registrar_produccion 4',
    ]);
    // Sin tocar la base de credenciales ni el servicio.
    expect(svc.ambienteDeCredencial).not.toHaveBeenCalled();
    expect(svc.guardarCredencial).not.toHaveBeenCalled();
    expect(svc.desactivarCredencial).not.toHaveBeenCalled();
  });

  it('probar la conexión solo con «Probar la conexión»; el listado con cualquiera de las tres (apoyo)', async () => {
    expect((await request(app).post('/c/probar-conexion').set('x-sub', '3').send({})).status).toBe(200);
    expect((await request(app).post('/c/probar-conexion').set('x-sub', '1').send({})).status).toBe(403);
    for (const sub of ['1', '2', '3']) expect((await request(app).get('/c').set('x-sub', sub)).status, sub).toBe(200);
    expect((await request(app).get('/c').set('x-sub', '4')).status).toBe(403);
  });
});
