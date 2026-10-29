// HU #14112 (C1.5, ADR-0030 C8a / NQ4) — PDF con cédula completa, logPiiAccess en generar y descargar,
// GET /pdf exige `logistica.actas.descargar` (URL prefirmada), DTO de listado/detalle sin cédula.
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { inflateSync } from 'node:zlib';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { protegerDocumento } from '../../src/modules/flito-logistica/flito-logistica.cifrado.js';
import type { Request } from 'express';

const selectMock = vi.fn();
const updateMock = vi.fn();
const insertMock = vi.fn();
const piiMock = vi.fn();
const uploadMock = vi.fn().mockResolvedValue('storage/acta.pdf');
const presignMock = vi.fn().mockResolvedValue('http://signed/acta.pdf');

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: piiMock }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/historial/permisos-intentos-denegados.js', () => ({
  registrarIntentoDenegado: vi.fn().mockResolvedValue(undefined), ventanaActual: () => new Date(), VENTANA_DEDUP_MS: 3_600_000,
}));
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: (...a: unknown[]) => uploadMock(...a),
  presignedGetEntityDocument: (...a: unknown[]) => presignMock(...a),
  getEntityDocumentStream: vi.fn().mockResolvedValue([]),
}));

const svc = await import('../../src/modules/flito-logistica/flito-logistica.service.js');
const { default: logisticaRoutes } = await import('../../src/modules/flito-logistica/flito-logistica.routes.js');

function leyendo(rows: unknown[]) {
  const c = chain(rows) as unknown as Record<string, (...a: unknown[]) => unknown>;
  const apuntar = () => c;
  c.from = apuntar; c.leftJoin = apuntar; c.innerJoin = apuntar;
  return c;
}

function textoDibujado(bytes: Buffer): string {
  const crudo = bytes.toString('latin1');
  const trozos: string[] = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (const m of crudo.matchAll(re)) {
    let contenido = m[1]!;
    try { contenido = inflateSync(Buffer.from(contenido, 'latin1')).toString('latin1'); } catch { /* sin comprimir */ }
    for (const h of contenido.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) trozos.push(Buffer.from(h[1]!, 'hex').toString('latin1'));
    for (const l of contenido.matchAll(/\(([^)]*)\)\s*Tj/g)) trozos.push(l[1]!);
  }
  return trozos.join('\n');
}

const ACTA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FIRMA_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CEDULA = '1036640908';
const NOMBRE = 'Ana Receptor';

function cabConCifrado() {
  const prot = protegerDocumento(CEDULA, FIRMA_ID);
  return {
    companiaNombre: 'ACME', direccion: 'Calle 1', contactoNombre: 'Contacto', creadoEn: new Date('2026-09-16T08:00:00Z'),
    firmaEntregaKey: null, entregaNombre: 'Operaciones', firmaRecibeKey: null,
    receptorNombre: NOMBRE, receptorDocumento: null, entregadoEn: new Date('2026-09-16T12:00:00Z'),
    punto: 'cliente', firmanteId: null,
    recibeCifrado: prot.cifrado, recibeFirmaId: FIRMA_ID, recibeNombre: NOMBRE,
  };
}

const DOC = { placa: 'QOX858', secretaria: 'STT', organismoCodigo: '001', propietario: 'EMMANUEL', numeroLicencia: '100', numeroLt: 'LT-1' };
const CAB_DETALLE = {
  id: ACTA, companiaId: 5, companiaNombre: 'ACME', estado: 'entregada', mensajeroId: 9, mensajeroNombre: 'Msj',
  receptorNombre: NOMBRE, entregadoEn: new Date('2026-09-16T12:00:00Z'), creadoEn: new Date('2026-09-16T08:00:00Z'),
  pdfStorageKey: 'k/acta.pdf', firmaEntregaKey: null, entregaNombre: 'Operaciones', firmaRecibeKey: 'k/firma.png', punto: 'cliente',
};
const DOC_DETALLE = { id: 'd1', estado: 'entregado', placa: 'QOX858', secretaria: 'STT', propietario: 'EMMANUEL', numeroLicencia: '100', numeroLt: 'LT-1', idFlit: 'F1' };
const EVENTO = { id: 'e1', documentoId: 'd1', placa: 'QOX858', estadoAnterior: 'despachado', estadoNuevo: 'entregado', actorNombre: 'Op', motivo: null, origen: 'usuario', creadoEn: new Date('2026-09-16T12:00:00Z') };

const fakeReq = { user: { sub: 1, role: 'admin' }, headers: {}, ip: '127.0.0.1' } as unknown as Request;

async function appGet(ruta: string, token: string) {
  const app = express();
  app.use(express.json());
  app.use('/api/flito/logistica', logisticaRoutes);
  return request(app).get(`/api/flito/logistica${ruta}`).set('Authorization', `Bearer ${token}`);
}

beforeEach(() => {
  selectMock.mockReset(); updateMock.mockReset(); insertMock.mockReset();
  piiMock.mockReset().mockResolvedValue(undefined);
  uploadMock.mockClear().mockResolvedValue('storage/acta.pdf');
  presignMock.mockClear().mockResolvedValue('http://signed/acta.pdf');
});

describe('HU #14112 AC2 — el PDF imprime la cédula completa del firmante', () => {
  it('descifra documento_cifrado y el texto dibujado contiene la cédula; no usa el legado en claro', async () => {
    selectMock
      .mockReturnValueOnce(leyendo([cabConCifrado()]))
      .mockReturnValueOnce(leyendo([DOC]));
    updateMock.mockReturnValueOnce(chain([]));
    const key = await svc.generarActaPdf(ACTA, fakeReq);
    expect(key).toBe('storage/acta.pdf');
    const bytes = uploadMock.mock.calls[0]![3] as Buffer;
    const texto = textoDibujado(bytes);
    expect(texto).toContain(CEDULA);
    expect(texto).toContain(NOMBRE);
    expect(texto).toContain('ACME');
  });
});

describe('HU #14112 AC3 — logPiiAccess en generar y en descargar', () => {
  it('generarActaPdf registra el acceso con uuid en motivo y sin resource_id', async () => {
    selectMock
      .mockReturnValueOnce(leyendo([cabConCifrado()]))
      .mockReturnValueOnce(leyendo([DOC]));
    updateMock.mockReturnValueOnce(chain([]));
    await svc.generarActaPdf(ACTA, fakeReq);
    expect(piiMock).toHaveBeenCalledTimes(1);
    const [, opts] = piiMock.mock.calls[0];
    expect(opts).toMatchObject({
      resourceTipo: 'flito_logistica_acta_pdf', accion: 'read', camposAccedidos: ['documento'],
    });
    expect(opts.resourceId).toBeUndefined();
    expect(opts.motivo).toBe(`generar:${ACTA}`);
    expect(opts.motivo).not.toContain(CEDULA);
  });

  it('GET /actas/:id/pdf (URL prefirmada) registra la descarga; no regenera si ya hay key', async () => {
    selectMock.mockReturnValueOnce(leyendo([{ key: 'k/acta.pdf' }]));
    const r = await appGet(`/actas/${ACTA}/pdf`, await testToken({ role: 'admin', sub: 1 }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ url: 'http://signed/acta.pdf' });
    expect(r.headers['cache-control']).toBe('no-store');
    expect(presignMock).toHaveBeenCalledWith('k/acta.pdf', 300);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(piiMock).toHaveBeenCalledTimes(1);
    const [, opts] = piiMock.mock.calls[0];
    expect(opts).toMatchObject({
      resourceTipo: 'flito_logistica_acta_pdf', accion: 'read', camposAccedidos: ['documento'],
    });
    expect(opts.motivo).toBe(`descargar:${ACTA}`);
    expect(opts.motivo).not.toContain(CEDULA);
  });
});

describe('HU #14112 AC4 — sin función descargar → 403; no audita', () => {
  it('un cliente sin logistica.actas.descargar recibe 403 y no llama logPiiAccess', async () => {
    const r = await appGet(`/actas/${ACTA}/pdf`, await testToken({ role: 'cliente', sub: 77 }));
    expect(r.status).toBe(403);
    expect(piiMock).not.toHaveBeenCalled();
    expect(presignMock).not.toHaveBeenCalled();
  });
});

describe('HU #14112 — DTO de listado y detalle nunca traen cédula completa', () => {
  it('GET /actas no expone receptorDocumento ni la cédula', async () => {
    selectMock.mockReturnValueOnce(leyendo([{
      id: ACTA, companiaId: 5, companiaNombre: 'ACME', estado: 'entregada', mensajeroId: 9, mensajeroNombre: 'Msj',
      receptorNombre: NOMBRE, entregadoEn: new Date('2026-09-16T12:00:00Z'), creadoEn: new Date('2026-09-16T08:00:00Z'),
      documentos: 1,
    }]));
    const r = await appGet('/actas', await testToken({ role: 'admin', sub: 1 }));
    expect(r.status).toBe(200);
    const json = JSON.stringify(r.body);
    expect(json).not.toContain(CEDULA);
    expect(json).not.toMatch(/receptorDocumento|contactoDocumento|"documento":/);
    expect(r.body[0]).not.toHaveProperty('receptorDocumento');
    expect(r.body[0]).not.toHaveProperty('contactoDocumento');
  });

  it('GET /actas/:id no expone receptorDocumento ni la cédula', async () => {
    selectMock
      .mockReturnValueOnce(leyendo([CAB_DETALLE]))
      .mockReturnValueOnce(leyendo([DOC_DETALLE]))
      .mockReturnValueOnce(leyendo([EVENTO]));
    const r = await appGet(`/actas/${ACTA}`, await testToken({ role: 'admin', sub: 1 }));
    expect(r.status).toBe(200);
    const json = JSON.stringify(r.body);
    expect(json).not.toContain(CEDULA);
    expect(json).not.toMatch(/receptorDocumento|contactoDocumento/);
    expect(r.body.acta).not.toHaveProperty('receptorDocumento');
    expect(r.body.acta).not.toHaveProperty('contactoDocumento');
  });
});
