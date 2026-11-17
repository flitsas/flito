// FLITO SOAT — carga de factura → Pagado (Fase 3, cierra Fase 2 3/3). Verifica el veredicto (RN-04/
// CA-06), y las fronteras de la ruta (RBAC, dedup CA-08, OCR caído, no-cruce). Las invariantes de BD
// (pago atómico + soporte, RN-03) se cubren además con smoke real contra Postgres (como Fase 1-2):
// aquí drizzle está mockeado. Ver docs/MIGRACION_FLITO_A_OPERACIONES.md §8/Anexo A.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { CampoSoat, MotivoRevision } from '@operaciones/shared-types';
import { conAlcance } from '../helpers/frontera.js';

const selectMock = vi.fn();
const updateMock = vi.fn();
const insertMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, update: updateMock, insert: insertMock, delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

// Motor OCR y storage mockeados: los tests prueban el FLUJO, no la lectura ni la subida real.
const extraerMock = vi.fn();
vi.mock('../../src/modules/flito-ocr/flito-ocr.service.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, extraerFacturaSoat: extraerMock };
});
const uploadMock = vi.fn().mockResolvedValue('flito/soat/facturas/k.pdf');
vi.mock('../../src/services/storage.js', () => ({ uploadEntityDocument: uploadMock }));

// Bug #14569: el descifrado (qpdf) se simula; por defecto un PDF sin cifrado sale tal cual, así los
// tests de arriba no cambian. Las clases de error son las reales.
const abrirPdfMock = vi.fn(async (buf: Buffer) => ({ estado: 'abierto' as const, buffer: buf }));
vi.mock('../../src/shared/pdf/pdf-cifrado.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, abrirPdf: abrirPdfMock };
});

const { evaluarExtraccionSoat } = await import('../../src/modules/flito-soat/flito-soat.service.js');
const { PdfContrasenaIncorrectaError, QpdfNoDisponibleError } = await import('../../src/shared/pdf/pdf-cifrado.js');
const { audit: auditMock } = await import('../../src/shared/middleware/audit.js');
const { OcrNoDisponibleError } = await import('../../src/modules/flito-ocr/flito-ocr.service.js');

beforeEach(() => {
  selectMock.mockReset(); updateMock.mockReset(); insertMock.mockReset(); transactionMock.mockReset();
  extraerMock.mockReset(); uploadMock.mockClear();
  abrirPdfMock.mockClear(); abrirPdfMock.mockImplementation(async (buf: Buffer) => ({ estado: 'abierto' as const, buffer: buf }));
  vi.mocked(auditMock).mockClear();
});

// Campo confiable/no confiable de ayuda.
const campo = (valor: string | null, confianza: number) => ({ valor, confianza, confiable: confianza >= 0.85 });

// ─────────────────────────── evaluarExtraccionSoat (puro) ────────────────────

describe('evaluarExtraccionSoat — veredicto (RN-04/CA-06)', () => {
  const esperado = { vin: '9BWZZZ377VT004251', placa: 'QTQ100' };
  const completa = () => ({
    [CampoSoat.PLACA]: campo('QTQ100', 0.95),
    [CampoSoat.VIN]: campo('9BWZZZ377VT004251', 0.95),
    [CampoSoat.NUMERO_POLIZA]: campo('FLIT-1', 0.95),
    [CampoSoat.VALOR_TOTAL]: campo('250000', 0.95),
    [CampoSoat.ASEGURADORA]: campo('SURA', 0.95),
  });

  it('todo confiable y la llave cruza → aprobada', () => {
    expect(evaluarExtraccionSoat(completa(), esperado, 0.85)).toEqual({ aprobada: true });
  });

  it('sin placa ni VIN → SIN_LLAVE_DE_CRUCE', () => {
    const e = { ...completa(), [CampoSoat.PLACA]: campo(null, 0), [CampoSoat.VIN]: campo(null, 0) };
    expect(evaluarExtraccionSoat(e, esperado, 0.85).motivo).toBe(MotivoRevision.SIN_LLAVE_DE_CRUCE);
  });

  it('placa y VIN leídos pero ninguno cruza → LLAVE_NO_CRUZA', () => {
    const e = { ...completa(), [CampoSoat.PLACA]: campo('XYZ999', 0.95), [CampoSoat.VIN]: campo('OTRO', 0.95) };
    expect(evaluarExtraccionSoat(e, esperado, 0.85).motivo).toBe(MotivoRevision.LLAVE_NO_CRUZA);
  });

  it('cruza por VIN aunque la placa no se haya leído → aprobada', () => {
    const e = { ...completa(), [CampoSoat.PLACA]: campo(null, 0) };
    expect(evaluarExtraccionSoat(e, esperado, 0.85)).toEqual({ aprobada: true });
  });

  it('un requerido bajo umbral → CONFIANZA_INSUFICIENTE (no se paga, va a revisión)', () => {
    const e = { ...completa(), [CampoSoat.VALOR_TOTAL]: campo('250000', 0.6) };
    const v = evaluarExtraccionSoat(e, esperado, 0.85);
    expect(v.aprobada).toBe(false);
    expect(v.motivo).toBe(MotivoRevision.CONFIANZA_INSUFICIENTE);
    expect(v.detalle).toContain(CampoSoat.VALOR_TOTAL);
  });

  it('la llave cruza pero con confianza baja → CONFIANZA_INSUFICIENTE', () => {
    const e = { ...completa(), [CampoSoat.PLACA]: campo('QTQ100', 0.3), [CampoSoat.VIN]: campo(null, 0) };
    expect(evaluarExtraccionSoat(e, esperado, 0.85).motivo).toBe(MotivoRevision.CONFIANZA_INSUFICIENTE);
  });

  it('vigencia/expedición ausentes NO bloquean (D-7): siguen aprobando', () => {
    // completa() no trae vigencia ni expedición y aun así aprueba.
    expect(evaluarExtraccionSoat(completa(), esperado, 0.85).aprobada).toBe(true);
  });

  it('umbral del proveedor más laxo (0.5) aprueba lo que 0.85 mandaría a revisión', () => {
    const e = { ...completa(), [CampoSoat.VALOR_TOTAL]: campo('250000', 0.6), [CampoSoat.PLACA]: campo('QTQ100', 0.6) };
    expect(evaluarExtraccionSoat(e, esperado, 0.85).aprobada).toBe(false);
    expect(evaluarExtraccionSoat(e, esperado, 0.5).aprobada).toBe(true);
  });
});

// ─────────────────────────── Rutas de carga ──────────────────────────────────

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  app.use('/api/flito/soat', conAlcance('soat', router));
  return app;
}
const auth = async (role: string) => `Bearer ${await testToken({ sub: 7, username: 'gestor@x.io', role: role as never })}`;
const UUID = '00000000-0000-0000-0000-000000000001';

const soatEnAdquisicion = { soat: { id: UUID, vin: '9BWZZZ377VT004251', estado: 'solicitado', proveedorSoatId: null, extraccion: null, pagadoEn: null }, dentroDeFrontera: true };
const datosCarga = [{ soatId: UUID, vin: '9BWZZZ377VT004251', estado: 'solicitado', placa: 'QTQ100', companiaId: 1, document: '900', carpeta: null, umbralOcr: null }];
const extraccionCruza = {
  [CampoSoat.PLACA]: campo('QTQ100', 0.95), [CampoSoat.VIN]: campo('9BWZZZ377VT004251', 0.95),
  [CampoSoat.NUMERO_POLIZA]: campo('FLIT-1', 0.95), [CampoSoat.VALOR_TOTAL]: campo('250000', 0.95),
  [CampoSoat.ASEGURADORA]: campo('SURA', 0.95),
};

describe('flito-soat carga factura — RBAC y validación', () => {
  it('auditor (solo lectura) → POST /:id/factura 403', async () => {
    const r = await request(await buildApp()).post(`/api/flito/soat/${UUID}/factura`)
      .set('Authorization', await auth('auditor')).attach('archivo', Buffer.from('%PDF'), 'f.pdf');
    expect(r.status).toBe(403);
  });
  it('gestor_impuestos → POST /facturas 403 (no participa en SOAT)', async () => {
    const r = await request(await buildApp()).post('/api/flito/soat/facturas')
      .set('Authorization', await auth('gestor_impuestos')).attach('archivos', Buffer.from('%PDF'), 'f.pdf');
    expect(r.status).toBe(403);
  });
  it('sin archivo → 400', async () => {
    const r = await request(await buildApp()).post(`/api/flito/soat/${UUID}/factura`)
      .set('Authorization', await auth('admin'));
    expect(r.status).toBe(400);
  });
});

describe('flito-soat carga factura — reglas del flujo', () => {
  it('factura que no cruza → 400 y no se archiva (no se cuelga del registro equivocado)', async () => {
    selectMock.mockReturnValueOnce(chain([soatEnAdquisicion])); // buscarConAcceso
    selectMock.mockReturnValueOnce(chain(datosCarga));          // datosCargaPorId
    extraerMock.mockResolvedValueOnce({ ...extraccionCruza, [CampoSoat.PLACA]: campo('XYZ999', 0.95), [CampoSoat.VIN]: campo('OTRO', 0.95) });

    const r = await request(await buildApp()).post(`/api/flito/soat/${UUID}/factura`)
      .set('Authorization', await auth('admin')).attach('archivo', Buffer.from('%PDF'), 'f.pdf');
    expect(r.status).toBe(400);
    expect(uploadMock).not.toHaveBeenCalled(); // no se subió nada
  });

  it('factura duplicada (mismo hash) → 409 (CA-08)', async () => {
    selectMock.mockReturnValueOnce(chain([soatEnAdquisicion]));
    selectMock.mockReturnValueOnce(chain(datosCarga));
    extraerMock.mockResolvedValueOnce(extraccionCruza);
    selectMock.mockReturnValueOnce(chain([{ id: 'sop-previo' }])); // facturaDuplicada → existe

    const r = await request(await buildApp()).post(`/api/flito/soat/${UUID}/factura`)
      .set('Authorization', await auth('admin')).attach('archivo', Buffer.from('%PDF'), 'f.pdf');
    expect(r.status).toBe(409);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('OCR no disponible → 503 (degradación)', async () => {
    selectMock.mockReturnValueOnce(chain([soatEnAdquisicion]));
    selectMock.mockReturnValueOnce(chain(datosCarga));
    extraerMock.mockRejectedValueOnce(new OcrNoDisponibleError(503, 'Servicio de IA no configurado'));

    const r = await request(await buildApp()).post(`/api/flito/soat/${UUID}/factura`)
      .set('Authorization', await auth('admin')).attach('archivo', Buffer.from('%PDF'), 'f.pdf');
    expect(r.status).toBe(503);
  });

  it('SOAT que no está En adquisición → 400 (no hay factura que cargar)', async () => {
    selectMock.mockReturnValueOnce(chain([{ soat: { ...soatEnAdquisicion.soat, estado: 'pagado' }, dentroDeFrontera: true }]));
    const r = await request(await buildApp()).post(`/api/flito/soat/${UUID}/factura`)
      .set('Authorization', await auth('admin')).attach('archivo', Buffer.from('%PDF'), 'f.pdf');
    expect(r.status).toBe(400);
  });

  it('factura válida que cruza y supera umbral → paga (RN-03): update a pagado + soporte, 200', async () => {
    selectMock.mockReturnValueOnce(chain([soatEnAdquisicion])); // buscarConAcceso
    selectMock.mockReturnValueOnce(chain(datosCarga));          // datosCargaPorId
    selectMock.mockReturnValueOnce(chain([]));                  // facturaDuplicada → no
    extraerMock.mockResolvedValueOnce(extraccionCruza);

    // Transacción: insert soporte(returning), pagarEnTx{ select count, update, insert audit +
    // historial de estado }. Solo el primero se lee; el resto responde vacío por respaldo, para que
    // añadir una escritura más a la transacción no rompa este test por algo que no comprueba.
    const txSelect = vi.fn().mockReturnValueOnce(chain([{ n: 1 }]));
    const txUpdate = vi.fn().mockReturnValue(chain([]));
    const txInsert = vi.fn()
      .mockReturnValueOnce(chain([{ id: 'sop-nuevo' }])) // soporte returning
      .mockReturnValue(chain([]));
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ select: txSelect, update: txUpdate, insert: txInsert }));

    selectMock.mockReturnValueOnce(chain([])); // detalle → buscarConAcceso vacío → null → responde {id}

    const r = await request(await buildApp()).post(`/api/flito/soat/${UUID}/factura`)
      .set('Authorization', await auth('admin')).attach('archivo', Buffer.from('%PDF-real'), 'QTQ100.pdf');

    expect(r.status).toBe(200);
    expect(uploadMock).toHaveBeenCalledTimes(1);   // se archivó (CA-11: storage antes de pagar)
    expect(txUpdate).toHaveBeenCalledTimes(1);      // pasó a Pagado
    // soporte + bitácora de pago + historial de estado. El historial entra en la MISMA transacción
    // a propósito: un SOAT en `pagado` sin la fila que cuenta cuándo pasó es el agujero que el
    // historial viene a tapar, así que o entran los tres o no entra ninguno.
    expect(txInsert).toHaveBeenCalledTimes(3);
  });

  it('factura que cruza pero con baja confianza → revisión (CA-06), NO paga', async () => {
    selectMock.mockReturnValueOnce(chain([soatEnAdquisicion]));
    selectMock.mockReturnValueOnce(chain(datosCarga));
    selectMock.mockReturnValueOnce(chain([])); // no dup
    extraerMock.mockResolvedValueOnce({ ...extraccionCruza, [CampoSoat.VALOR_TOTAL]: campo('250000', 0.3) });

    const txSelect = vi.fn();
    const txUpdate = vi.fn().mockReturnValue(chain([]));
    const txInsert = vi.fn()
      .mockReturnValueOnce(chain([{ id: 'sop-nuevo' }])) // soporte
      .mockReturnValueOnce(chain([]))                     // revisión
      .mockReturnValueOnce(chain([]));                    // audit
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ select: txSelect, update: txUpdate, insert: txInsert }));
    selectMock.mockReturnValueOnce(chain([])); // detalle vacío

    const r = await request(await buildApp()).post(`/api/flito/soat/${UUID}/factura`)
      .set('Authorization', await auth('admin')).attach('archivo', Buffer.from('%PDF'), 'QTQ100.pdf');

    expect(r.status).toBe(200);
    expect(txUpdate).not.toHaveBeenCalled();   // NO pasó a Pagado (RN-03: solo con lectura confiable)
    expect(txInsert).toHaveBeenCalledTimes(3); // soporte + revisión + bitácora "ocr a revisión" (sin pago)
  });
});

// ─────────────────────────── PDF cifrado (Bug #14569) ────────────────────────

describe('flito-soat carga factura — PDF protegido con contraseña (Bug #14569)', () => {
  const CLAVE = '1032456789'; // como una cédula: PII que no puede filtrarse
  const CIFRADO = Buffer.from('%PDF-1.7 /Encrypt cifrado');
  const DESCIFRADO = Buffer.from('%PDF-1.7 descifrado');
  const subirIndividual = async (contrasena?: string) => {
    let r = request(await buildApp()).post(`/api/flito/soat/${UUID}/factura`).set('Authorization', await auth('admin'));
    if (contrasena !== undefined) r = r.field('contrasena', contrasena);
    return r.attach('archivo', CIFRADO, 'QTQ100.pdf');
  };
  const noSeGuardoNada = () => {
    expect(uploadMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
    expect(extraerMock).not.toHaveBeenCalled(); // tampoco se gastó OCR en un PDF ilegible
  };

  it('individual sin contraseña → 422 PDF_CIFRADO y no se guarda nada', async () => {
    selectMock.mockReturnValueOnce(chain([soatEnAdquisicion])).mockReturnValueOnce(chain(datosCarga));
    abrirPdfMock.mockResolvedValueOnce({ estado: 'requiere-contrasena' } as never);
    const r = await subirIndividual();
    expect(r.status).toBe(422);
    expect(r.body).toEqual({ error: 'Este PDF está protegido con contraseña. Escríbela para cargarlo.', codigo: 'PDF_CIFRADO' });
    noSeGuardoNada();
  });

  it('contraseña incorrecta → 422 PDF_CONTRASENA_INCORRECTA, sin guardar ni repetir la clave', async () => {
    selectMock.mockReturnValueOnce(chain([soatEnAdquisicion])).mockReturnValueOnce(chain(datosCarga));
    abrirPdfMock.mockRejectedValueOnce(new PdfContrasenaIncorrectaError());
    const r = await subirIndividual(CLAVE);
    expect(r.status).toBe(422);
    expect(r.body.codigo).toBe('PDF_CONTRASENA_INCORRECTA');
    expect(JSON.stringify(r.body)).not.toContain(CLAVE);
    expect(abrirPdfMock).toHaveBeenCalledWith(expect.any(Buffer), CLAVE);
    noSeGuardoNada();
  });

  it('qpdf no disponible → 503 PDF_CIFRADO_NO_DISPONIBLE sin guardar nada (falla cerrado)', async () => {
    selectMock.mockReturnValueOnce(chain([soatEnAdquisicion])).mockReturnValueOnce(chain(datosCarga));
    abrirPdfMock.mockRejectedValueOnce(new QpdfNoDisponibleError('timeout'));
    const r = await subirIndividual(CLAVE);
    expect(r.status).toBe(503);
    expect(r.body.codigo).toBe('PDF_CIFRADO_NO_DISPONIBLE');
    noSeGuardoNada();
  });

  it('contraseña de más de 128 caracteres → 400 sin abrir el PDF ni repetir el valor', async () => {
    const larga = 'x'.repeat(129);
    const r = await subirIndividual(larga);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain(larga);
    expect(abrirPdfMock).not.toHaveBeenCalled();
  });

  it('contraseña correcta → OCR, hash y archivo sobre el PDF DESCIFRADO; audit sin la clave', async () => {
    selectMock.mockReturnValueOnce(chain([soatEnAdquisicion])).mockReturnValueOnce(chain(datosCarga))
      .mockReturnValueOnce(chain([])); // facturaDuplicada → no
    abrirPdfMock.mockResolvedValueOnce({ estado: 'abierto', buffer: DESCIFRADO });
    extraerMock.mockResolvedValueOnce(extraccionCruza);
    const valoresSoporte = vi.fn(() => chain([{ id: 'sop-nuevo' }]));
    const txInsert = vi.fn().mockReturnValueOnce({ values: valoresSoporte }).mockReturnValue(chain([]));
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({
      select: vi.fn().mockReturnValue(chain([{ n: 1 }])), update: vi.fn().mockReturnValue(chain([])), insert: txInsert,
    }));
    selectMock.mockReturnValueOnce(chain([])); // detalle

    const r = await subirIndividual(CLAVE);
    expect(r.status).toBe(200);
    expect(extraerMock.mock.calls[0][0].contenido.equals(DESCIFRADO)).toBe(true);
    expect((uploadMock.mock.calls[0] as unknown[])[3]).toEqual(DESCIFRADO); // nunca el original cifrado
    const soporte = (valoresSoporte.mock.calls[0] as unknown[])[0] as { hash: string; tamanoBytes: number };
    expect(soporte.hash).toBe(createHash('sha256').update(DESCIFRADO).digest('hex'));
    expect(soporte.tamanoBytes).toBe(DESCIFRADO.length);
    expect(JSON.stringify(vi.mocked(auditMock).mock.calls.map((c) => c[1]))).not.toContain(CLAVE); // el detalle auditado
  });

  describe('masiva (POST /facturas)', () => {
    const NORMAL = Buffer.from('%PDF-1.7 normal');
    const masiva = async (contrasenas?: string) => {
      let r = request(await buildApp()).post('/api/flito/soat/facturas').set('Authorization', await auth('admin'));
      if (contrasenas !== undefined) r = r.field('contrasenas', contrasenas);
      return r.attach('archivos', CIFRADO, 'protegido.pdf').attach('archivos', NORMAL, 'normal.pdf');
    };
    const normalSinCruce = () => {
      // Respaldo de cualquier select (dedup, cruce): vacío → el normal termina «no cruza».
      selectMock.mockReturnValue(chain([]));
      extraerMock.mockResolvedValue({ ...extraccionCruza, [CampoSoat.PLACA]: campo('ZZZ999', 0.95), [CampoSoat.VIN]: campo(null, 0) });
    };

    it('protegido sin clave → `protegidos`; el resto del lote sigue intacto', async () => {
      normalSinCruce();
      abrirPdfMock.mockResolvedValueOnce({ estado: 'requiere-contrasena' } as never);
      const r = await masiva();
      expect(r.status).toBe(200);
      expect(r.body.protegidos).toEqual([{ archivo: 'protegido.pdf', placa: null, soatId: null, detalle: 'Protegido con contraseña.' }]);
      expect(r.body.noAsociados.map((i: { archivo: string }) => i.archivo)).toEqual(['normal.pdf']);
      expect(extraerMock).toHaveBeenCalledTimes(1); // solo el normal pasó por OCR
      expect(uploadMock).not.toHaveBeenCalled();
      expect(vi.mocked(auditMock).mock.calls[0][1].detail).toContain('1 protegidos');
    });

    it('contrasenas por posición: la clave del 2.º no se aplica al 1.º; incorrecta → `protegidos`', async () => {
      normalSinCruce();
      abrirPdfMock.mockRejectedValueOnce(new PdfContrasenaIncorrectaError());
      const r = await masiva(JSON.stringify([CLAVE, '']));
      expect(r.status).toBe(200);
      expect(abrirPdfMock.mock.calls[0][1]).toBe(CLAVE);
      expect(abrirPdfMock.mock.calls[1][1]).toBeUndefined();
      expect(r.body.protegidos[0]).toMatchObject({ archivo: 'protegido.pdf', detalle: 'La contraseña no abre este PDF.' });
      expect(JSON.stringify(vi.mocked(auditMock).mock.calls.map((c) => c[1]))).not.toContain(CLAVE); // el detalle auditado
    });

    it('qpdf no disponible en un archivo → `noAsociados`, el resto sigue', async () => {
      normalSinCruce();
      abrirPdfMock.mockRejectedValueOnce(new QpdfNoDisponibleError('qpdf no instalado'));
      const r = await masiva();
      expect(r.status).toBe(200);
      expect(r.body.protegidos).toEqual([]);
      expect(r.body.noAsociados.map((i: { archivo: string }) => i.archivo)).toEqual(['protegido.pdf', 'normal.pdf']);
      expect(extraerMock).toHaveBeenCalledTimes(1);
    });

    it('ZIP con un PDF cifrado + uno normal → el cifrado sale en `protegidos` con el nombre de su entrada; el otro sigue', async () => {
      const FIXTURE = readFileSync(fileURLToPath(new URL('../fixtures/soat/factura-cifrada.pdf', import.meta.url)));
      const zip = new JSZip();
      zip.file('lote/factura-cifrada.pdf', FIXTURE);
      zip.file('lote/normal.pdf', NORMAL);
      const contenidoZip = await zip.generateAsync({ type: 'nodebuffer' });
      normalSinCruce();
      // El detector simulado reconoce los bytes del fixture: prueba que la entrada llega intacta del ZIP.
      abrirPdfMock.mockImplementation(async (buf: Buffer) => (buf.equals(FIXTURE)
        ? { estado: 'requiere-contrasena' } as never
        : { estado: 'abierto' as const, buffer: buf }));
      const r = await request(await buildApp()).post('/api/flito/soat/facturas').set('Authorization', await auth('admin'))
        .attach('archivos', contenidoZip, { filename: 'lote.zip', contentType: 'application/zip' });
      expect(r.status).toBe(200);
      expect(r.body.protegidos).toEqual([{ archivo: 'factura-cifrada.pdf', placa: null, soatId: null, detalle: 'Protegido con contraseña.' }]);
      expect(r.body.noAsociados.map((i: { archivo: string }) => i.archivo)).toEqual(['normal.pdf']);
      expect(abrirPdfMock).toHaveBeenCalledTimes(2);
      expect(extraerMock).toHaveBeenCalledTimes(1); // solo el normal pasó por OCR
      expect(uploadMock).not.toHaveBeenCalled();
    });

    it('contrasenas con largo distinto al de archivos → 400 sin repetir el valor ni procesar nada', async () => {
      const r = await masiva(JSON.stringify([CLAVE]));
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'Contraseñas inválidas' });
      expect(abrirPdfMock).not.toHaveBeenCalled();
    });

    it('contrasenas que no es JSON → 400', async () => {
      const r = await masiva('no-es-json');
      expect(r.status).toBe(400);
      expect(abrirPdfMock).not.toHaveBeenCalled();
    });
  });
});
