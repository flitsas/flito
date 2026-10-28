// HU #14132 (Feature #14013, ADR-0032) — el worker de la carga masiva de Renovaciones, fila a fila. AC1–AC10.
//
// Sin base ni RUNT: los colaboradores de `procesarFila` se inyectan (`DepsFila`) y la decisión es una función
// pura. El reclamo con SKIP LOCKED, el tope por compañía, el cierre y la anonimización se prueban contra
// Postgres real en `__tests__/db/flito-soat.masivo-worker.pg.test.ts` (solo con TEST_DATABASE_URL).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { registro } = vi.hoisted(() => ({ registro: [] as string[] }));
vi.mock('../../src/shared/logger.js', () => {
  const mk = () => {
    const f = (...a: unknown[]) => { registro.push(JSON.stringify(a)); };
    const l: Record<string, unknown> = { info: f, warn: f, error: f, debug: f, trace: f, fatal: f };
    l.child = () => l;
    return l;
  };
  return { loggerFor: () => mk(), logger: mk() };
});
vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), execute: vi.fn(), transaction: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { aparcarSolicitudMock } = vi.hoisted(() => ({ aparcarSolicitudMock: vi.fn() }));
vi.mock('../../src/modules/flito-soat/flito-soat-incompletas.service.js', async (original) => ({
  ...(await original<typeof import('../../src/modules/flito-soat/flito-soat-incompletas.service.js')>()),
  aparcarSolicitud: aparcarSolicitudMock,
}));

const { reclamarMock, cerrarMock } = vi.hoisted(() => ({ reclamarMock: vi.fn(), cerrarMock: vi.fn() }));
vi.mock('../../src/shared/utils/lock.js', () => ({ withLock: async (_n: string, _t: number, fn: () => unknown) => fn() }));
vi.mock('../../src/modules/flito-soat/flito-soat-masivo-reclamo.js', async (original) => ({
  ...(await original<typeof import('../../src/modules/flito-soat/flito-soat-masivo-reclamo.js')>()),
  reclamarFilas: reclamarMock, cerrarLoteSiTermino: cerrarMock,
  recuperarHuerfanas: vi.fn().mockResolvedValue(0), cerrarLotesSinPendientes: vi.fn().mockResolvedValue(0), cerrarLotesSinAvance: vi.fn().mockResolvedValue(0),
}));

import { SolicitudSoatError } from '../../src/modules/flito-soat/flito-soat-cliente.service.js';
import { CodigoErrorSolicitudSoat } from '@operaciones/shared-types';
import type { DesenlaceRunt } from '../../src/modules/flito-soat/flito-soat-cliente-runt.js';
import { decidir, textoMotivo, siguienteBackoff, MAX_INTENTOS_RUNT } from '../../src/modules/flito-soat/flito-soat-masivo-motivos.js';
import { procesarFila, motivoDeError, type DepsFila } from '../../src/modules/flito-soat/flito-soat-masivo-procesar-fila.js';
import type { FilaReclamada } from '../../src/modules/flito-soat/flito-soat-masivo-reclamo.js';
import { aparcarFila, propietarioDeFila } from '../../src/modules/flito-soat/flito-soat-masivo-crear.js';

const PII = { placa: 'ABC123', documento: '1098765432', nombre: 'Maria Fernanda Lopez', correo: 'maria.lopez@ejemplo.com', celular: '3101234567' };
const RESERVADO = '22222222-2222-4222-8222-222222222222';
const fila = (o: Partial<FilaReclamada> = {}): FilaReclamada => ({
  id: 'f1', loteId: 'l1', nFila: 2, companiaId: 7, creadoPorId: 9, creadoPorNombre: 'Ana',
  soatIdReservado: RESERVADO, intentos: 0, ...PII, ...o,
});
const ok = { clase: 'ok', vinEfectivo: 'VIN12345678901234', organismoCodigo: null, datos: { placa: 'ABC123' } } as unknown as DesenlaceRunt;
const anticipada = { clase: 'renovacion_anticipada', venceEl: '2026-11-10', soatActivo: {}, vinEfectivo: 'V', organismoCodigo: null, datos: {} } as unknown as DesenlaceRunt;

const ctx = { userId: 9, username: 'Ana' } as never;
const canal = { companiaId: 7, carpetaStorage: null };

function deps(o: Partial<DepsFila> = {}): DepsFila & { marcar: ReturnType<typeof vi.fn> } {
  return {
    yaCreado: vi.fn().mockResolvedValue(null),
    contexto: vi.fn().mockResolvedValue({ ctx, canal }),
    incompletaAbierta: vi.fn().mockResolvedValue(undefined),
    consultar: vi.fn().mockResolvedValue(ok),
    crear: vi.fn().mockResolvedValue(RESERVADO),
    aparcar: vi.fn().mockResolvedValue('aparcada'),
    marcar: vi.fn().mockResolvedValue(true),
    ...o,
  } as never;
}

beforeEach(() => { registro.length = 0; aparcarSolicitudMock.mockReset(); });

describe('AC1 — fila en cola con placa y documento correctos y SOAT anterior en el RUNT', () => {
  it('crea la Renovación con el id reservado y los datos de la fila como propietario', async () => {
    const d = deps();
    expect(await procesarFila(fila(), d)).toBe('aceptada');
    expect(d.consultar).toHaveBeenCalledWith({ modalidad: 'placa', placa: 'ABC123', documento: PII.documento });
    expect(d.crear).toHaveBeenCalledTimes(1);
    const arg = (d.crear as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(arg.fila.soatIdReservado).toBe(RESERVADO);
    expect(arg.canal.companiaId).toBe(7);
  });
  it('el propietario es el de la fila: nombre COMPLETO en nombres, apellidos nulos, sin tipo ni ubicación inventados', () => {
    expect(propietarioDeFila(fila())).toEqual({
      tipoDocumento: null, numeroDocumento: PII.documento, nombres: PII.nombre, apellidos: null, razonSocial: null,
      correo: PII.correo, celular: PII.celular, direccion: null, municipio: null, departamento: null,
    });
  });
  it('la renovación anticipada (vigente dentro de la ventana) también se crea', () => {
    expect(decidir(anticipada, 0)).toEqual({ tipo: 'crear' });
  });
});

describe('AC2 — RUNT caído: un reintento automático y luego «Por validar»', () => {
  const caido = { clase: 'caido', causa: 'timeout' } as DesenlaceRunt;
  it('la 1.ª caída devuelve la fila a pendiente con espera y gasta un intento', async () => {
    const d = deps({ consultar: vi.fn().mockResolvedValue(caido) });
    expect(await procesarFila(fila({ intentos: 0 }), d)).toBe('reintento');
    const cambios = d.marcar.mock.calls[0]![1];
    expect(cambios).toMatchObject({ estado: 'pendiente', intentos: 1, ultimaCausa: 'timeout' });
    expect(cambios.proximoIntentoEn.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(d.aparcar).not.toHaveBeenCalled();
  });
  it('la 2.ª caída aparca en Por validar', async () => {
    const d = deps({ consultar: vi.fn().mockResolvedValue(caido) });
    expect(await procesarFila(fila({ intentos: MAX_INTENTOS_RUNT - 1 }), d)).toBe('por_validar');
    expect(d.aparcar).toHaveBeenCalledWith(expect.objectContaining({ intentos: 2, causa: 'timeout' }));
  });
  it('aparcar escribe la incompleta de placa sin factura, motivo del servicio, con el propietario y el id reservado', async () => {
    aparcarSolicitudMock.mockResolvedValue({ aparcada: true, id: 'inc-1', soatIdReservado: RESERVADO, adicionalesGuardados: [] });
    // `marcarFila` toca la base: se aísla probando la entrada que recibe `aparcarSolicitud`.
    await aparcarFila({ fila: fila(), canal, ctx, intentos: 2, causa: 'red' }).catch(() => undefined);
    const entrada = aparcarSolicitudMock.mock.calls[0]![0];
    expect(entrada).toMatchObject({
      tipoSoat: 'renovacion', modalidad: 'placa', vin: null, placa: 'ABC123', companiaId: 7, archivo: null,
      soatIdReservado: RESERVADO, nombreCompleto: PII.nombre,
    });
    expect(entrada.propietario.numeroDocumento).toBe(PII.documento);
  });
});

describe('AC3 — la incompleta aparcada por el worker es reintentable desde «Por validar»', () => {
  it('queda con lo que exige el reintento manual (HU #14018): renovación, placa, sin VIN, sin factura y comprador orden 0 con documento', async () => {
    aparcarSolicitudMock.mockResolvedValue({ aparcada: true, id: 'inc-1', soatIdReservado: RESERVADO, adicionalesGuardados: [] });
    await aparcarFila({ fila: fila(), canal, ctx, intentos: 2, causa: 'otro' }).catch(() => undefined);
    const e = aparcarSolicitudMock.mock.calls[0]![0];
    // `aparcarSolicitud` fija motivo_pendiente = runt_sin_respuesta (el único que `reintentarIncompleta` admite)
    // y `consultaDe` lee placa + documento del comprador orden 0: las dos cosas están en la entrada.
    expect([e.tipoSoat, e.modalidad, e.vin, e.archivo]).toEqual(['renovacion', 'placa', null, null]);
    expect(e.placa).toBe('ABC123');
    expect(e.propietario.numeroDocumento).toBe(PII.documento);
  });
});

describe('AC4–AC7 — rechazos de negocio con su motivo y texto', () => {
  it('AC4 sin SOAT anterior: «use la plantilla de SOAT inicial»', async () => {
    const d = deps({ consultar: vi.fn().mockResolvedValue({ clase: 'sin_soat_anterior' }) });
    expect(await procesarFila(fila(), d)).toBe('rechazada');
    expect(d.marcar.mock.calls[0]![1]).toMatchObject({ estado: 'rechazada', motivoRechazo: 'sin_soat_anterior' });
    expect(textoMotivo('sin_soat_anterior')).toBe('Este vehículo no registra SOAT anterior: use la plantilla de SOAT inicial');
  });
  it('AC5 vigente fuera de ventana: guarda hasta cuándo y el texto lo dice', async () => {
    const d = deps({ consultar: vi.fn().mockResolvedValue({ clase: 'vigente', fechaVencimiento: '2026-12-31', soatActivo: {} }) });
    expect(await procesarFila(fila(), d)).toBe('rechazada');
    expect(d.marcar.mock.calls[0]![1]).toMatchObject({ motivoRechazo: 'soat_vigente', vigenteHasta: '2026-12-31' });
    expect(textoMotivo('soat_vigente', '2026-12-31')).toContain('31/12/2026');
  });
  it('AC6 placa con una incompleta abierta: «Esta placa ya tiene un SOAT en gestión», sin llamar al RUNT', async () => {
    const e409 = new SolicitudSoatError(409, CodigoErrorSolicitudSoat.SOLICITUD_INCOMPLETA_EXISTENTE, 'x');
    const d = deps({ incompletaAbierta: vi.fn().mockRejectedValue(e409) });
    expect(await procesarFila(fila(), d)).toBe('rechazada');
    expect(d.consultar).not.toHaveBeenCalled();
    expect(d.marcar.mock.calls[0]![1]).toMatchObject({ motivoRechazo: 'solicitud_existente' });
    expect(textoMotivo('solicitud_existente')).toBe('Esta placa ya tiene un SOAT en gestión');
  });
  it('AC6 SOAT abierto (409 al crear) y carrera por el índice único (23505): solicitud_existente', async () => {
    const abierto = new SolicitudSoatError(409, CodigoErrorSolicitudSoat.VIN_YA_TIENE_SOAT, 'x');
    expect(motivoDeError(abierto)).toBe('solicitud_existente');
    expect(motivoDeError(Object.assign(new Error('dup'), { code: '23505' }))).toBe('solicitud_existente');
    const d = deps({ crear: vi.fn().mockRejectedValue(abierto) });
    expect(await procesarFila(fila(), d)).toBe('rechazada');
    expect(d.marcar.mock.calls[0]![1]).toMatchObject({ motivoRechazo: 'solicitud_existente' });
  });
  it('AC6 aparcar con la placa ya ocupada por otra incompleta: solicitud_existente', async () => {
    const d = deps({ consultar: vi.fn().mockResolvedValue({ clase: 'caido' }), aparcar: vi.fn().mockResolvedValue('ocupada') });
    expect(await procesarFila(fila({ intentos: 1 }), d)).toBe('rechazada');
    expect(d.marcar.mock.calls[0]![1]).toMatchObject({ motivoRechazo: 'solicitud_existente' });
  });
  it('AC7 sin registro en el RUNT para placa+documento: pide revisar placa y documento', async () => {
    for (const codigo of ['runt_sin_registro', 'runt_no_cuadra'] as const) {
      const d = deps({ consultar: vi.fn().mockResolvedValue({ clase: 'revise', codigo }) });
      expect(await procesarFila(fila(), d)).toBe('rechazada');
      expect(d.marcar.mock.calls[0]![1]).toMatchObject({ motivoRechazo: codigo });
      expect(textoMotivo(codigo)).toMatch(/revise la placa y el documento/);
    }
  });
});

describe('AC8 — campos inválidos: se nombra el campo y NO se consulta el RUNT', () => {
  it.each([
    [{ placa: '12' }, 'placa_invalida'],
    [{ documento: '1' }, 'documento_invalido'],
    [{ correo: 'no-es-correo' }, 'correo_invalido'],
    [{ celular: '1234' }, 'celular_invalido'],
  ])('%j → %s', async (campo, motivo) => {
    const d = deps();
    expect(await procesarFila(fila(campo), d)).toBe('rechazada');
    expect(d.consultar).not.toHaveBeenCalled();
    expect(d.marcar.mock.calls[0]![1]).toMatchObject({ estado: 'rechazada', motivoRechazo: motivo });
    expect(textoMotivo(motivo)).toMatch(/inválid/i);
  });
});

describe('AC9 — reinicio a mitad: sin duplicar ni perder', () => {
  it('si el SOAT con el id reservado ya existe, la fila solo se marca aceptada: no se consulta ni se crea otro', async () => {
    const d = deps({ yaCreado: vi.fn().mockResolvedValue({ soatId: RESERVADO }) });
    expect(await procesarFila(fila(), d)).toBe('aceptada');
    expect(d.consultar).not.toHaveBeenCalled();
    expect(d.crear).not.toHaveBeenCalled();
    expect(d.marcar.mock.calls[0]![1]).toMatchObject({ estado: 'aceptada', soatId: RESERVADO });
  });
  it('si la incompleta con el id reservado ya existe, la fila se marca por_validar', async () => {
    const d = deps({ yaCreado: vi.fn().mockResolvedValue({ incompletaId: 'inc-9' }) });
    expect(await procesarFila(fila(), d)).toBe('por_validar');
    expect(d.aparcar).not.toHaveBeenCalled();
    expect(d.marcar.mock.calls[0]![1]).toMatchObject({ estado: 'por_validar', incompletaId: 'inc-9' });
  });
  it('un fallo transitorio reintenta y al tercero rechaza como no_procesada', async () => {
    const d = deps({ consultar: vi.fn().mockRejectedValue(new Error('boom')) });
    expect(await procesarFila(fila({ intentos: 0 }), d)).toBe('reintento');
    const d2 = deps({ consultar: vi.fn().mockRejectedValue(new Error('boom')) });
    expect(await procesarFila(fila({ intentos: 2 }), d2)).toBe('rechazada');
    expect(d2.marcar.mock.calls[0]![1]).toMatchObject({ motivoRechazo: 'no_procesada' });
    expect(textoMotivo('no_procesada')).toBe('No se pudo procesar a tiempo; vuelva a subir el archivo');
  });
});

describe('429 — backoff sin gastar intento', () => {
  it('decidir: 429 es `limite` aunque sea la 2.ª llamada; cualquier otro caído sí gasta intento', () => {
    expect(decidir({ clase: 'caido', httpStatus: 429 }, 1)).toEqual({ tipo: 'limite' });
    expect(decidir({ clase: 'caido', httpStatus: 503 }, 0)).toMatchObject({ tipo: 'reintentar', intentos: 1 });
  });
  it('la fila vuelve a pendiente SIN tocar intentos', async () => {
    const d = deps({ consultar: vi.fn().mockResolvedValue({ clase: 'caido', httpStatus: 429 }) });
    expect(await procesarFila(fila({ intentos: 1 }), d)).toBe('limite');
    const cambios = d.marcar.mock.calls[0]![1];
    expect(cambios.estado).toBe('pendiente');
    expect(cambios).not.toHaveProperty('intentos');
  });
  it('la pausa va de 5 s a 60 s duplicando', () => {
    expect([0, 5_000, 10_000, 30_000, 60_000].map(siguienteBackoff)).toEqual([5_000, 10_000, 20_000, 60_000, 60_000]);
  });
});

describe('AC10 — ningún log con placa, documento, nombre, correo ni celular', () => {
  it('recorre aceptada, rechazada, reintento, por validar, 429 y error con una excepción cuyo mensaje trae PII', async () => {
    const trampa = new Error(`fallo con ${PII.placa} ${PII.documento} ${PII.correo}`);
    const casos: Array<Partial<DepsFila>> = [
      {}, { consultar: vi.fn().mockResolvedValue({ clase: 'sin_soat_anterior' }) },
      { consultar: vi.fn().mockResolvedValue({ clase: 'caido', causa: 'red' }) },
      { consultar: vi.fn().mockResolvedValue({ clase: 'caido', httpStatus: 429 }) },
      { consultar: vi.fn().mockRejectedValue(trampa) },
      { crear: vi.fn().mockRejectedValue(trampa) },
    ];
    for (const c of casos) await procesarFila(fila(), deps(c));
    await procesarFila(fila({ intentos: 1 }), deps({ consultar: vi.fn().mockResolvedValue({ clase: 'caido' }) }));
    expect(registro.length).toBeGreaterThan(0);
    const todo = registro.join('\n');
    for (const v of Object.values(PII)) expect(todo).not.toContain(v);
  });
});

describe('worker — tick: concurrencia 2 y pausa por 429', () => {
  it('reclama con el cupo local de 2, cierra los lotes tocados y, tras un 429, se pausa sin reclamar', async () => {
    const w = await import('../../src/modules/flito-soat/flito-soat-masivo.worker.js');
    w.reiniciarEstadoWorker();
    reclamarMock.mockReset(); cerrarMock.mockReset();
    reclamarMock.mockResolvedValueOnce([fila({ id: 'a' }), fila({ id: 'b' })]);
    const d = deps({ consultar: vi.fn().mockResolvedValueOnce({ clase: 'caido', httpStatus: 429 }).mockResolvedValue(ok) });
    const r = await w.tickMasivo(d, new Date());
    expect(reclamarMock).toHaveBeenCalledWith(w.CONCURRENCIA_LOCAL, expect.any(Date));
    expect(w.CONCURRENCIA_LOCAL).toBe(2);
    expect(r.sort()).toEqual(['aceptada', 'limite']);
    expect(cerrarMock).toHaveBeenCalledTimes(1); // un solo lote tocado
    // Hubo un 429 y una fila aceptada en el mismo tick: el backoff se rearma al volver a contestar el RUNT.
    reclamarMock.mockClear();
    w.reiniciarEstadoWorker();
    reclamarMock.mockResolvedValueOnce([fila({ id: 'c' })]);
    await w.tickMasivo(deps({ consultar: vi.fn().mockResolvedValue({ clase: 'caido', httpStatus: 429 }) }), new Date());
    expect(w.estadoBackoff().backoffMs).toBe(5_000);
    reclamarMock.mockClear();
    await w.tickMasivo(deps(), new Date()); // dentro de la pausa
    expect(reclamarMock).not.toHaveBeenCalled();
    reclamarMock.mockResolvedValue([]);
    await w.tickMasivo(deps(), new Date(Date.now() + 6_000)); // pasada la pausa
    expect(reclamarMock).toHaveBeenCalledTimes(1);
  });
});
