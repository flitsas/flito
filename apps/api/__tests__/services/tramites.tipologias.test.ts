// TRAM-INNOV A5 — checklist por tipología.
//
// Dos bloques:
//   1. `computeChecklist` / catálogo: lógica pura (sin IO) desde shared-types.
//   2. Rutas: GET /tipologias, GET /:id/checklist y el gate de envío a tránsito
//      en PATCH /:id (mismo harness de mocks que tramites.routes.test.ts).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import {
  TRAMITE_TIPOLOGIAS, getTipologia, isValidTipologia, mergeChecklist, computeChecklist, computeChecklistWithOverride,
} from '@operaciones/shared-types';

// ---------------------------------------------------------------------------
// 1. Catálogo + computeChecklist (puro)
// ---------------------------------------------------------------------------
describe('A5 · catálogo de tipologías', () => {
  it('expone al menos las 4 tipologías seed del epic', () => {
    const codigos = TRAMITE_TIPOLOGIAS.map((t) => t.codigo);
    expect(codigos).toEqual(expect.arrayContaining(['traspaso_standard', 'sucesion', 'remate', 'flota_corporativa']));
  });

  it('cada tipología tiene checklist no vacío y al menos un obligatorio', () => {
    for (const t of TRAMITE_TIPOLOGIAS) {
      expect(t.checklist.length).toBeGreaterThan(0);
      expect(t.checklist.some((i) => i.obligatorio)).toBe(true);
    }
  });

  it('isValidTipologia / getTipologia', () => {
    expect(isValidTipologia('traspaso_standard')).toBe(true);
    expect(isValidTipologia('inexistente')).toBe(false);
    expect(isValidTipologia(null)).toBe(false);
    expect(getTipologia('remate')?.nombre).toMatch(/remate/i);
    expect(getTipologia('nope')).toBeUndefined();
  });
});

describe('TRAM-TIPO-02 · importación + remate docTipos', () => {
  it('importacion en catálogo con obligatorios aduaneros', () => {
    const t = getTipologia('importacion')!;
    expect(t.nombre).toMatch(/importación/i);
    const ids = t.checklist.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining(['factura_importacion', 'levante_aduana', 'declaracion_importacion']));
    expect(t.checklist.find((i) => i.id === 'declaracion_importacion')!.docTipo).toBe('declaracion_aduana');
  });

  it('remate: acta_remate y oficio_juzgado ahora tienen docTipo judicial', () => {
    const t = getTipologia('remate')!;
    expect(t.checklist.find((i) => i.id === 'acta_remate')!.docTipo).toBe('acta_remate');
    expect(t.checklist.find((i) => i.id === 'oficio_juzgado')!.docTipo).toBe('oficio_judicial');
  });

  it('gate importacion: declaración subida (docTipo) auto-marca el obligatorio', () => {
    const res = computeChecklist('importacion', {}, ['declaracion_aduana'])!;
    expect(res.items.find((i) => i.id === 'declaracion_importacion')!.via).toBe('documento');
    expect(res.faltanObligatorios).not.toContain('declaracion_importacion');
  });

  it('gate remate: acta + oficio subidos auto-marcan obligatorios', () => {
    const res = computeChecklist('remate', {}, ['acta_remate', 'oficio_judicial'])!;
    expect(res.faltanObligatorios).not.toContain('acta_remate');
    expect(res.faltanObligatorios).not.toContain('oficio_juzgado');
  });
});

describe('TRAM-MT-02 · mergeChecklist', () => {
  const base = getTipologia('traspaso_standard')!.checklist;

  it('sin override devuelve copia del base', () => {
    const merged = mergeChecklist(base, null);
    expect(merged).toEqual(base);
    expect(merged).not.toBe(base);
  });

  it('hide elimina ítems por id', () => {
    const merged = mergeChecklist(base, { hide: ['rtm', 'cert_tradicion'] });
    expect(merged.map((i) => i.id)).not.toContain('rtm');
    expect(merged.map((i) => i.id)).not.toContain('cert_tradicion');
    expect(merged.length).toBe(base.length - 2);
  });

  it('require vuelve obligatorio un ítem opcional del base', () => {
    const merged = mergeChecklist(base, { require: ['cert_tradicion'] });
    const cert = merged.find((i) => i.id === 'cert_tradicion')!;
    expect(cert.obligatorio).toBe(true);
  });

  it('add agrega ítems STT sin duplicar ids', () => {
    const merged = mergeChecklist(base, {
      add: [
        { id: 'anexo_medellin', label: 'Anexo STT Medellín', obligatorio: true },
        { id: 'soat', label: 'duplicado', obligatorio: true },
      ],
    });
    expect(merged.filter((i) => i.id === 'soat')).toHaveLength(1);
    expect(merged.find((i) => i.id === 'anexo_medellin')?.label).toBe('Anexo STT Medellín');
  });

  it('computeChecklistWithOverride aplica hide en gate efectivo', () => {
    const merged = mergeChecklist(base, { hide: ['paz_salvo'] });
    const estado: Record<string, boolean> = {};
    for (const it of merged) if (it.obligatorio) estado[it.id] = true;
    const res = computeChecklistWithOverride('traspaso_standard', estado, ['compraventa', 'impronta', 'soat'], { hide: ['paz_salvo'] });
    expect(res!.completo).toBe(true);
    expect(res!.items.some((i) => i.id === 'paz_salvo')).toBe(false);
  });

  it('combina hide + require + add en una sola pasada', () => {
    const merged = mergeChecklist(base, {
      hide: ['paz_salvo'],
      require: ['cert_tradicion'],
      add: [{ id: 'formato_stt', label: 'Formato radicación STT', obligatorio: true }],
    });
    expect(merged.some((i) => i.id === 'paz_salvo')).toBe(false);
    expect(merged.find((i) => i.id === 'cert_tradicion')!.obligatorio).toBe(true);
    expect(merged.find((i) => i.id === 'formato_stt')!.obligatorio).toBe(true);
  });
});

describe('A5 · computeChecklist', () => {
  it('tipología inválida → null', () => {
    expect(computeChecklist('nope', {}, [])).toBeNull();
    expect(computeChecklist(null, {}, [])).toBeNull();
  });

  it('sin marcas ni documentos → faltan todos los obligatorios, no completo', () => {
    const res = computeChecklist('traspaso_standard', {}, [])!;
    expect(res.completo).toBe(false);
    expect(res.faltanObligatorios.length).toBe(res.obligatoriosTotal);
    expect(res.satisfechos).toBe(0);
  });

  it('auto-marca por documento subido (via=documento)', () => {
    const res = computeChecklist('traspaso_standard', {}, ['soat'])!;
    const soat = res.items.find((i) => i.id === 'soat')!;
    expect(soat.satisfecho).toBe(true);
    expect(soat.via).toBe('documento');
    expect(res.faltanObligatorios).not.toContain('soat');
  });

  it('marca manual (via=manual) y no pisa la del documento', () => {
    const res = computeChecklist('traspaso_standard', { rtm: true }, ['soat'])!;
    expect(res.items.find((i) => i.id === 'rtm')!.via).toBe('manual');
    expect(res.items.find((i) => i.id === 'soat')!.via).toBe('documento');
  });

  it('todos los obligatorios satisfechos → completo, faltan=[]', () => {
    const tip = getTipologia('traspaso_standard')!;
    const estado: Record<string, boolean> = {};
    for (const it of tip.checklist) estado[it.id] = true;
    const res = computeChecklist('traspaso_standard', estado, [])!;
    expect(res.completo).toBe(true);
    expect(res.faltanObligatorios).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Rutas (harness con db mockeado)
// ---------------------------------------------------------------------------
const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    delete: deleteMock,
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset(); deleteMock.mockReset();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/tramites/tramites.routes.js');
  app.use('/api/tramites', router);
  return app;
}

const ORG_MEDELLIN = { _orgTransito: { codigo: '05001', nombre: 'STRIA TTEyTTO MEDELLIN', ciudad: 'Medellín' } };

describe('GET /api/tramites/tipologias', () => {
  it('devuelve el catálogo (≥4) sin tocar BD', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/tipologias').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.length).toBeGreaterThanOrEqual(4);
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/tramites/:id/checklist', () => {
  it('trámite sin tipología → checklist null', async () => {
    selectMock.mockReturnValueOnce(chain([{ tipologiaCodigo: null, checklistEstado: null }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/5/checklist').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.checklist).toBeNull();
  });

  it('no encontrado → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/999/checklist').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });

  it('con tipología → computa combinando manual + documentos', async () => {
    selectMock.mockReturnValueOnce(chain([{
      tipologiaCodigo: 'traspaso_standard', checklistEstado: { rtm: true }, vehiculo: ORG_MEDELLIN, organismoCodigo: null,
    }]));
    selectMock.mockReturnValueOnce(chain([{ tipo: 'soat' }, { tipo: 'impronta' }]));
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/5/checklist').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.checklist.codigo).toBe('traspaso_standard');
    expect(r.body.checklist.items.find((i: any) => i.id === 'soat').via).toBe('documento');
    expect(r.body.checklist.items.find((i: any) => i.id === 'rtm').via).toBe('manual');
    expect(r.body.checklist.satisfechos).toBe(3); // soat + impronta + rtm
  });
});

describe('PATCH /api/tramites/:id — gate de checklist al enviar a tránsito (A5)', () => {
  it('tipología con obligatorios faltantes → 409 checklist_incompleto + NO actualiza', async () => {
    // current: borrador con tipología, sin marcas manuales
    selectMock.mockReturnValueOnce(chain([{ estado: 'borrador', tipologiaCodigo: 'traspaso_standard', checklistEstado: {}, vehiculo: ORG_MEDELLIN }]));
    // uploadedDocTipos: sin documentos
    selectMock.mockReturnValueOnce(chain([]));
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/tramites/1').set('Authorization', `Bearer ${token}`)
      .send({ estado: 'enviado_transito' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('checklist_incompleto');
    expect(Array.isArray(r.body.faltan)).toBe(true);
    expect(r.body.faltan.length).toBeGreaterThan(0);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('tipología con obligatorios completos (vía documentos) → pasa el gate → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ estado: 'borrador', tipologiaCodigo: 'traspaso_standard', checklistEstado: { rtm: true, paz_salvo: true, cedulas: true }, vehiculo: ORG_MEDELLIN, comprador: { documento: '123' } }]));
    // documentos que cubren contrato_compraventa, impronta y soat
    selectMock.mockReturnValueOnce(chain([{ tipo: 'compraventa' }, { tipo: 'impronta' }, { tipo: 'soat' }]));
    selectMock.mockReturnValueOnce(chain([]));
    // gate de identidad (M1): comprador con validación aprobada
    selectMock.mockReturnValueOnce(chain([{ documento: '123' }]));
    updateMock.mockReturnValueOnce({ set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1, estado: 'enviado_transito', paso: 5 }]) }) }) });
    insertMock.mockReturnValueOnce({ values: () => Promise.resolve([]).catch(() => {}) });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/tramites/1').set('Authorization', `Bearer ${token}`)
      .send({ estado: 'enviado_transito' });
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('enviado_transito');
  });

  it('sin tipología → gate NO aplica (retrocompat) → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ estado: 'borrador', tipologiaCodigo: null, checklistEstado: null, vehiculo: ORG_MEDELLIN, comprador: { documento: '123' } }]));
    // gate de identidad (M1): comprador con validación aprobada
    selectMock.mockReturnValueOnce(chain([{ documento: '123' }]));
    updateMock.mockReturnValueOnce({ set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1, estado: 'enviado_transito', paso: 5 }]) }) }) });
    insertMock.mockReturnValueOnce({ values: () => Promise.resolve([]).catch(() => {}) });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/tramites/1').set('Authorization', `Bearer ${token}`)
      .send({ estado: 'enviado_transito' });
    expect(r.status).toBe(200);
  });

  it('matrícula sin identidad del comprador aprobada → 409 identidad_requerida + NO actualiza', async () => {
    // current: borrador con organismo pero el comprador no tiene validación aprobada
    selectMock.mockReturnValueOnce(chain([{ estado: 'borrador', tipologiaCodigo: null, checklistEstado: null, vehiculo: ORG_MEDELLIN, comprador: { documento: '123' } }]));
    // gate de identidad (M1): sin filas aprobadas
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/tramites/1').set('Authorization', `Bearer ${token}`)
      .send({ estado: 'enviado_transito' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('identidad_requerida');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('enviar a tránsito sin organismo → 409 organismo_requerido', async () => {
    selectMock.mockReturnValueOnce(chain([{ estado: 'borrador', tipologiaCodigo: null, checklistEstado: null, vehiculo: {} }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/tramites/1').set('Authorization', `Bearer ${token}`)
      .send({ estado: 'enviado_transito' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('organismo_requerido');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('acepta tipologiaCodigo + checklistEstado en un PATCH normal', async () => {
    // Dual-actor: checklist/tipología son mutación de gestión → 1 SELECT de gate.
    selectMock.mockReturnValueOnce(chain([{ modalidad: 'matricula_inicial', estado: 'borrador' }]));
    let captured: any = null;
    updateMock.mockReturnValueOnce({ set: (v: any) => { captured = v; return { where: () => ({ returning: () => Promise.resolve([{ id: 1, estado: 'borrador', paso: 1 }]) }) }; } });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).patch('/api/tramites/1').set('Authorization', `Bearer ${token}`)
      .send({ tipologiaCodigo: 'sucesion', checklistEstado: { registro_defuncion: true } });
    expect(r.status).toBe(200);
    expect(captured.tipologiaCodigo).toBe('sucesion');
    expect(captured.checklistEstado).toEqual({ registro_defuncion: true });
    expect(selectMock).toHaveBeenCalledTimes(1); // solo gate dual-actor; sin estado → sin check de transición
  });
});
