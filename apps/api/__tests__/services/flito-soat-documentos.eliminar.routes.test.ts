// HU #13364 (Feature #13361, Épica #13201) — `DELETE /api/flito/soat/:id/documentos-adicionales/:soporteId`:
// borrado DEFINITIVO de un documento adicional, en cualquier estado.
//
// Matriz (qa-a-13364, archivo F2):
//   TC-35 AC4  sin acceso a la solicitud → 404; ni DELETE ni storage ni Bitácora.
//   TC-36 AC4  `:id` o `:soporteId` no uuid → 404 sin consultar.
//   TC-37 AC5  borrado físico: DELETE de flito_soportes con id + soat_id + tipo en la condición (SQL
//              leído); `removeEntityDocument` con la clave EXACTA; ningún UPDATE de borrado lógico.
//   TC-39 AC5  orden (diseño D6): primero la fila, después el objeto; si storage falla 3 veces → 204,
//              evento `soat.adicional.objeto_huerfano` con la clave opaca y Bitácora con el rastro.
//   TC-40 AC6  la condición NO lleva al autor (cualquiera con la función borra).
//   TC-41 AC7  sin `.eliminar` → 403 sin DELETE ni storage ni Bitácora.
//   TC-42/43/44 AC8  la factura, un adicional de otra solicitud o uno inexistente → 404 sin tocar storage.
//   TC-46 AC9  Bitácora `delete` una vez con la etiqueta (o el nombre truncado); nunca en 403/404.

import 'express-async-errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createHash } from 'node:crypto';
import { SignJWT } from 'jose';
import type { SQL } from 'drizzle-orm';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { ligadoA, renderizar } from '../helpers/sql-ligado.js';
import { registrarUsuarioDePrueba } from '../helpers/auth.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);
const accesoMock = vi.hoisted(() => vi.fn());
const auditMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const deleteMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const removeMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const logMock = vi.hoisted(() => {
  const l: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() };
  l.child = () => l;
  return l as Record<string, ReturnType<typeof vi.fn>>;
});

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));
vi.mock('../../src/services/storage.js', () => ({
  firmarDescargaEntidad: vi.fn(), uploadEntityDocument: vi.fn(),
  deleteEntityDocument: deleteMock, removeEntityDocument: removeMock,
}));
vi.mock('../../src/modules/flito-soat/flito-soat.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  contextoSoat: vi.fn(async (u: { id: number; username: string; role: string }) => ({
    userId: u.id, username: u.username, role: u.role, externo: false, alcance: 'todo',
  })),
  buscarConAcceso: accesoMock,
}));

const ID = '0d0c0000-0000-4000-8000-000000013364';
const SOP = '5d0c0000-0000-4000-8000-0000000000aa';
const KEY = `clientes/acme/soat/documentos-adicionales/${ID}/k1.pdf`;
const ELIMINAR = 'soat.documentos_adicionales.eliminar';

let sub = 13364700;
async function auth(funciones: string[]) {
  sub += 1;
  await registrarUsuarioDePrueba(sub, {
    rol: 'rol_prueba', tipoPrincipal: 'interno', tipoEnlace: 'ninguno', excepciones: [],
    funcionesDelRol: ['pagina.flito_soat', ...funciones],
  });
  const t = await new SignJWT({ username: 'operador@flit.co', role: 'rol_prueba' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub)).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  return `Bearer ${t}`;
}

async function borrar(token: string, id = ID, soporteId = SOP) {
  const app = express();
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat-documentos.routes.js');
  app.use('/api/flito/soat', router);
  return request(app).delete(`/api/flito/soat/${id}/documentos-adicionales/${soporteId}`).set('Authorization', token);
}

/** Las condiciones de cada DELETE emitido (la espía no captura deletes). */
let deletes: { tabla: string; cond: SQL }[] = [];
function capturarDeletes() {
  deletes = [];
  const base = kdb.delete.getMockImplementation() as (t: unknown) => Record<string, unknown>;
  kdb.delete.mockImplementation((t: unknown) => {
    const c = base(t);
    const o = c.where as (v: unknown) => unknown;
    c.where = (cond: SQL) => {
      deletes.push({ tabla: (t as Record<symbol, string>)[Symbol.for('drizzle:Name')], cond });
      return o(cond);
    };
    return c;
  });
}
const deleteDeSoportes = () => {
  const d = deletes.find((x) => x.tabla === 'flito_soportes');
  return d ? renderizar(d.cond) : undefined;
};

const FILA = { id: SOP, storageKey: KEY, etiqueta: 'Cédula', nombreArchivo: 'cedula-de-juan-perez.pdf' };

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  capturarDeletes();
  kdb.when.delete('flito_soportes', [FILA]);
  accesoMock.mockReset().mockResolvedValue({ id: ID, companiaId: 7, estado: 'pagado' });
  auditMock.mockClear();
  deleteMock.mockClear();
  removeMock.mockReset().mockResolvedValue(undefined);
  logMock.error.mockClear();
});

describe('TC-37 AC5 — borrado físico de un adicional de una solicitud pagada', () => {
  it('204 sin cuerpo; DELETE con id + soat_id + tipo (SQL leído); objeto borrado con la clave exacta', async () => {
    const r = await borrar(await auth([ELIMINAR]));
    expect(r.status).toBe(204);
    expect(r.text).toBe('');
    const q = deleteDeSoportes()!;
    expect(ligadoA(q, '"flito_soportes"."id"')).toBe(SOP);
    expect(ligadoA(q, '"flito_soportes"."soat_id"')).toBe(ID);
    expect(ligadoA(q, '"flito_soportes"."tipo"')).toBe('documento_adicional_soat');
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith(KEY);
    expect(espia.updates, 'ni borrado lógico ni otra escritura').toEqual([]);
  });

  it('TC-39: primero la fila, después el objeto', async () => {
    await borrar(await auth([ELIMINAR]));
    expect(kdb.delete.mock.invocationCallOrder[0]).toBeLessThan(removeMock.mock.invocationCallOrder[0]);
  });
});

describe('TC-39 AC5 — storage falla: 3 intentos, rastro y 204', () => {
  it('evento objeto_huerfano SIN la clave ni el nombre (hash corto); Bitácora con «objeto pendiente de borrar» sin la clave', async () => {
    removeMock.mockRejectedValue(new Error('minio caído'));
    const r = await borrar(await auth([ELIMINAR]));
    expect(r.status).toBe(204);
    expect(removeMock).toHaveBeenCalledTimes(3);
    expect(removeMock.mock.calls.every((c) => c[0] === KEY)).toBe(true);
    const huerfano = logMock.error.mock.calls.find((c) => (c[0] as { evento?: string })?.evento === 'soat.adicional.objeto_huerfano');
    const claveHash = createHash('sha256').update(KEY).digest('hex').slice(0, 16);
    expect(huerfano?.[0]).toEqual({ evento: 'soat.adicional.objeto_huerfano', soporteId: SOP, claveHash });
    const payload = JSON.stringify(huerfano);
    expect(payload).not.toContain(KEY);
    expect(payload).not.toContain('clientes/acme');
    expect(payload).not.toContain('k1.pdf');
    expect(payload).not.toContain('cedula-de-juan');
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0][1].detail).toBe(`Documento adicional eliminado (soporte=${SOP}, etiqueta=Cédula, objeto pendiente de borrar)`);
    expect(JSON.stringify(auditMock.mock.calls[0][1])).not.toContain(KEY);
  }, 10_000);

  it('al segundo intento basta: sin evento de huérfano', async () => {
    removeMock.mockRejectedValueOnce(new Error('timeout'));
    const r = await borrar(await auth([ELIMINAR]));
    expect(r.status).toBe(204);
    expect(removeMock).toHaveBeenCalledTimes(2);
    expect(logMock.error).not.toHaveBeenCalled();
  });
});

describe('TC-40 AC6 — cualquiera con la función borra, aunque lo haya cargado otra persona', () => {
  it('la condición del DELETE no lleva al autor', async () => {
    const r = await borrar(await auth([ELIMINAR]));
    expect(r.status).toBe(204);
    const q = deleteDeSoportes()!;
    expect(q.sql).not.toMatch(/subido_por/);
    expect(q.params).not.toContain(sub);
    expect(q.params).not.toContain(String(sub));
  });
});

describe('TC-41 AC7 — sin la función de eliminar → 403', () => {
  it('con cargar y ver, sin eliminar', async () => {
    const r = await borrar(await auth(['soat.documentos_adicionales.cargar', 'soat.documentos_adicionales.ver']));
    expect(r.status).toBe(403);
    expect(accesoMock).not.toHaveBeenCalled();
    expect(kdb.delete).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('TC-35/TC-36 AC4 — sin acceso o ids inválidos → 404', () => {
  it('sin acceso a la solicitud', async () => {
    accesoMock.mockResolvedValue(null);
    const r = await borrar(await auth([ELIMINAR]));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Solicitud de SOAT no encontrada' });
    expect(kdb.delete).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it.each([['id', 'no-es-uuid', SOP], ['soporteId', ID, 'no-es-uuid']])('%s no uuid → 404 sin consultar', async (_n, id, sop) => {
    const r = await borrar(await auth([ELIMINAR]), id, sop);
    expect(r.status).toBe(404);
    expect(accesoMock).not.toHaveBeenCalled();
    expect(kdb.delete).not.toHaveBeenCalled();
  });
});

describe('TC-42/TC-43/TC-44 AC8 — la factura, otra solicitud o inexistente → 404', () => {
  it('el DELETE no devuelve fila (la condición excluye la factura y otras solicitudes): 404 y storage intacto', async () => {
    kdb.when.delete('flito_soportes', []);
    const r = await borrar(await auth([ELIMINAR]));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Documento adicional no encontrado' });
    const q = deleteDeSoportes()!;
    expect(ligadoA(q, '"flito_soportes"."tipo"')).toBe('documento_adicional_soat');
    expect(ligadoA(q, '"flito_soportes"."soat_id"')).toBe(ID);
    expect(removeMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('TC-46 AC9 — Bitácora del borrado', () => {
  it('una entrada `delete` con la etiqueta; sin el nombre del archivo', async () => {
    await borrar(await auth([ELIMINAR]));
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0][1]).toEqual({
      action: 'delete', resource: 'flito_soat', resourceId: ID,
      detail: `Documento adicional eliminado (soporte=${SOP}, etiqueta=Cédula)`,
    });
  });

  it('si la etiqueta era el nombre del archivo, el nombre sale truncado a 40', async () => {
    const largo = `${'z'.repeat(60)}.pdf`;
    kdb.when.delete('flito_soportes', [{ ...FILA, etiqueta: largo, nombreArchivo: largo }]);
    await borrar(await auth([ELIMINAR]));
    expect(auditMock.mock.calls[0][1].detail).toBe(`Documento adicional eliminado (soporte=${SOP}, nombre=${'z'.repeat(40)}…)`);
  });
});
