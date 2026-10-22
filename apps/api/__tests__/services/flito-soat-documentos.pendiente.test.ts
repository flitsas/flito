// HU #13410 (Feature #13408, Épica #13201) — el borrado de un documento adicional deja un BORRADO
// PENDIENTE en la MISMA transacción que borra la fila (AC1), y lo cierra o anota el fallo tras el
// intento inmediato sin cambiar la respuesta (AC2). Matriz qa-a-13410, archivo F1.
//
// `db.transaction` es manual: entrega un `tx` DISTINTO de `db` y registra cada operación con quién la
// emitió. Así «el INSERT va por la transacción» se afirma sobre el objeto que lo recibió, no sobre
// el orden de llamadas de un mock que ejecuta el callback contra el mismo `db`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { getTableName, type SQL } from 'drizzle-orm';
import { ligadoA, renderizar } from '../helpers/sql-ligado.js';

type Op = { quien: 'tx' | 'db'; op: string; tabla: string; datos?: Record<string, unknown>; cond?: SQL };

const h = vi.hoisted(() => ({
  eventos: [] as string[],
  ops: [] as unknown[],
  filasDelete: [] as unknown[],
  insertLanza: null as Error | null,
  updateLanza: null as Error | null,
}));

const removeMock = vi.hoisted(() => vi.fn());
const accesoMock = vi.hoisted(() => vi.fn());
const logMock = vi.hoisted(() => {
  const l: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() };
  l.child = () => l;
  return l as Record<string, ReturnType<typeof vi.fn>>;
});

function nombre(tbl: unknown): string { return getTableName(tbl as never); }

function cliente(quien: 'tx' | 'db') {
  const registrar = (o: Op) => { (h.ops as Op[]).push(o); h.eventos.push(`${quien}:${o.op}:${o.tabla}`); };
  return {
    delete: (tbl: unknown) => ({
      where: (cond: SQL) => ({
        returning: async () => { registrar({ quien, op: 'delete', tabla: nombre(tbl), cond }); return h.filasDelete; },
      }),
    }),
    insert: (tbl: unknown) => ({
      values: (datos: Record<string, unknown>) => ({
        returning: async () => {
          registrar({ quien, op: 'insert', tabla: nombre(tbl), datos });
          if (h.insertLanza) throw h.insertLanza;
          return [{ id: PEND }];
        },
      }),
    }),
    update: (tbl: unknown) => ({
      set: (datos: Record<string, unknown>) => ({
        where: async (cond: SQL) => {
          registrar({ quien, op: 'update', tabla: nombre(tbl), datos, cond });
          if (h.updateLanza) throw h.updateLanza;
          return [];
        },
      }),
    }),
  };
}

const PEND = '9e000000-0000-4000-8000-000000013410';

vi.mock('../../src/db/client.js', () => {
  const db = {
    ...cliente('db'),
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      h.eventos.push('begin');
      const r = await cb(cliente('tx'));
      h.eventos.push('commit');
      return r;
    }),
  };
  return { db, getPoolStats: vi.fn() };
});
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: vi.fn(), deleteEntityDocument: vi.fn(), firmarDescargaEntidad: vi.fn(),
  removeEntityDocument: (k: string) => { h.eventos.push('remove'); return removeMock(k); },
}));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));
vi.mock('../../src/modules/flito-soat/flito-soat.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buscarConAcceso: accesoMock,
}));

const { eliminarDocumentoAdicional, ORIGEN_ADICIONAL_SOAT } =
  await import('../../src/modules/flito-soat/flito-soat-documentos.service.js');

const ID = '0d0c0000-0000-4000-8000-000000013410';
const SOP = '5d0c0000-0000-4000-8000-0000000134aa';
// NIT sintético y nombre con PII: ninguno de los dos puede aparecer en el log.
const KEY = `clientes/900123456/soat/documentos-adicionales/${ID}/cedula-de-juan-perez.pdf`;
const HASH = createHash('sha256').update(KEY).digest('hex').slice(0, 16);
const FILA = { id: SOP, storageKey: KEY, etiqueta: 'Cédula', nombreArchivo: 'cedula-de-juan-perez.pdf' };
const CTX = { userId: 1, username: 'op', role: 'admin', proyeccionCliente: false, alcance: 'todo' } as never;
const AHORA = new Date('2026-10-07T15:00:00.000Z');
const SIN_ESPERA = [0, 0, 0];

const ops = () => h.ops as Op[];
const opsEn = (op: string, tabla: string) => ops().filter((o) => o.op === op && o.tabla === tabla);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AHORA);
  h.eventos.length = 0;
  h.ops.length = 0;
  h.filasDelete = [FILA];
  h.insertLanza = null;
  h.updateLanza = null;
  removeMock.mockReset().mockResolvedValue(undefined);
  accesoMock.mockReset().mockResolvedValue({ id: ID, companiaId: 7, estado: 'pagado' });
  Object.values(logMock).forEach((f) => typeof f === 'function' && 'mockClear' in f && f.mockClear());
});

describe('AC1 — el pendiente se escribe en la MISMA transacción que borra la fila', () => {
  it('TC-1.1 DELETE e INSERT los emite el `tx`; el INSERT lleva clave exacta, huella y origen; el objeto se borra tras el commit', async () => {
    await eliminarDocumentoAdicional(ID, SOP, CTX, SIN_ESPERA);
    const [del] = opsEn('delete', 'flito_soportes');
    expect(del.quien).toBe('tx');
    expect(ligadoA(renderizar(del.cond!), '"flito_soportes"."id"')).toBe(SOP);
    const ins = opsEn('insert', 'flito_storage_borrados_pendientes');
    expect(ins).toHaveLength(1);
    expect(ins[0].quien).toBe('tx');
    expect(ins[0].datos).toEqual({ storageKey: KEY, claveHash: HASH, origen: 'soat.documento_adicional' });
    expect(ORIGEN_ADICIONAL_SOAT).toBe('soat.documento_adicional');
    expect(h.eventos.slice(0, 5)).toEqual([
      'begin', 'tx:delete:flito_soportes', 'tx:insert:flito_storage_borrados_pendientes', 'commit', 'remove',
    ]);
  });

  it('TC-1.2 borrado OK → UPDATE del pendiente (id + abierto) que lo CIERRA y pone la clave a NULL (Ley 1581)', async () => {
    const r = await eliminarDocumentoAdicional(ID, SOP, CTX, SIN_ESPERA);
    expect(r.objetoPendiente).toBe(false);
    const ups = opsEn('update', 'flito_storage_borrados_pendientes');
    expect(ups).toHaveLength(1);
    expect(ups[0].datos).toEqual({
      resueltoEn: AHORA, motivoCierre: 'borrado', storageKey: null, intentos: 1, ultimoIntentoEn: AHORA,
    });
    const q = renderizar(ups[0].cond!);
    expect(ligadoA(q, '"flito_storage_borrados_pendientes"."id"')).toBe(PEND);
    expect(q.sql).toMatch(/"flito_storage_borrados_pendientes"\."resuelto_en" is null/);
  });

  it('TC-1.2b «no existe» (NoSuchKey) cierra como `inexistente` al primer intento, también con la clave a NULL', async () => {
    removeMock.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'NoSuchKey' }));
    const r = await eliminarDocumentoAdicional(ID, SOP, CTX, SIN_ESPERA);
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(r.objetoPendiente).toBe(false);
    expect(opsEn('update', 'flito_storage_borrados_pendientes')[0].datos).toMatchObject({
      motivoCierre: 'inexistente', storageKey: null, resueltoEn: AHORA,
    });
  });

  it('TC-1.3 si el INSERT del pendiente falla, la transacción rechaza y el objeto NO se toca', async () => {
    h.insertLanza = new Error('insert falló');
    await expect(eliminarDocumentoAdicional(ID, SOP, CTX, SIN_ESPERA)).rejects.toThrow('insert falló');
    expect(removeMock).not.toHaveBeenCalled();
    expect(h.eventos).not.toContain('commit');
  });

  it('TC-1.3b el proceso «muere» durante el borrado del objeto: el pendiente ya está y no hay UPDATE de cierre', async () => {
    removeMock.mockImplementation(() => new Promise(() => {})); // nunca resuelve
    void eliminarDocumentoAdicional(ID, SOP, CTX, SIN_ESPERA);
    await vi.waitFor(() => expect(h.eventos).toContain('remove'));
    expect(opsEn('insert', 'flito_storage_borrados_pendientes')).toHaveLength(1);
    expect(h.eventos.indexOf('commit')).toBeLessThan(h.eventos.indexOf('remove'));
    expect(opsEn('update', 'flito_storage_borrados_pendientes')).toEqual([]);
  });

  it('TC-1.4 soporte inexistente (DELETE sin fila) → 404, sin pendiente ni objeto', async () => {
    h.filasDelete = [];
    await expect(eliminarDocumentoAdicional(ID, SOP, CTX, SIN_ESPERA)).rejects.toMatchObject({ status: 404 });
    expect(opsEn('insert', 'flito_storage_borrados_pendientes')).toEqual([]);
    expect(removeMock).not.toHaveBeenCalled();
  });
});

describe('AC2 — 3 fallos: el pendiente queda ABIERTO con intentos = 3, y el log no lleva la clave', () => {
  it('TC-2.1 UPDATE con intentos 3, último intento y código del error; sin cierre ni clave a NULL', async () => {
    removeMock.mockRejectedValue(Object.assign(new Error(`AccessDenied on ${KEY}`), { code: 'AccessDenied' }));
    const r = await eliminarDocumentoAdicional(ID, SOP, CTX, SIN_ESPERA);
    expect(removeMock).toHaveBeenCalledTimes(3);
    expect(r.objetoPendiente).toBe(true);
    const ups = opsEn('update', 'flito_storage_borrados_pendientes');
    expect(ups).toHaveLength(1);
    expect(ups[0].datos).toEqual({ intentos: 3, ultimoIntentoEn: AHORA, ultimoError: 'AccessDenied' });
    expect(ligadoA(renderizar(ups[0].cond!), '"flito_storage_borrados_pendientes"."id"')).toBe(PEND);
  });

  it('TC-2.2 `objeto_huerfano` con soporteId + claveHash; ningún log lleva el NIT, el nombre ni el mensaje', async () => {
    removeMock.mockRejectedValue(Object.assign(new Error(`AccessDenied on ${KEY}`), { code: 'AccessDenied' }));
    await eliminarDocumentoAdicional(ID, SOP, CTX, SIN_ESPERA);
    expect(logMock.error).toHaveBeenCalledWith(
      { evento: 'soat.adicional.objeto_huerfano', soporteId: SOP, claveHash: HASH }, expect.any(String),
    );
    const serial = JSON.stringify([logMock.error.mock.calls, logMock.warn.mock.calls, logMock.info.mock.calls]);
    expect(serial).not.toContain('900123456');
    expect(serial).not.toContain('cedula-de-juan-perez');
    expect(JSON.stringify(ops().map((o) => o.op === 'update' ? o.datos : null))).not.toContain('900123456');
  });

  it('TC-2.4 falla 2 veces y el 3.º borra → cerrado con intentos 3 (no queda abierto)', async () => {
    removeMock.mockRejectedValueOnce(new Error('a')).mockRejectedValueOnce(new Error('b')).mockResolvedValueOnce(undefined);
    const r = await eliminarDocumentoAdicional(ID, SOP, CTX, SIN_ESPERA);
    expect(r.objetoPendiente).toBe(false);
    expect(opsEn('update', 'flito_storage_borrados_pendientes')[0].datos).toEqual({
      resueltoEn: AHORA, motivoCierre: 'borrado', storageKey: null, intentos: 3, ultimoIntentoEn: AHORA,
    });
  });

  it('TC-2.5 si el UPDATE de cierre falla, NO cambia la respuesta: warn con pendienteId y código, sin clave', async () => {
    h.updateLanza = Object.assign(new Error(`conexión perdida ${KEY}`), { code: 'ECONNRESET' });
    const r = await eliminarDocumentoAdicional(ID, SOP, CTX, SIN_ESPERA);
    expect(r).toMatchObject({ id: SOP, objetoPendiente: false });
    expect(logMock.warn).toHaveBeenCalledWith(
      { evento: 'soat.storage.borrado_pendiente_no_actualizado', pendienteId: PEND, err: 'ECONNRESET' }, expect.any(String),
    );
    expect(JSON.stringify(logMock.warn.mock.calls)).not.toContain('900123456');
  });
});
