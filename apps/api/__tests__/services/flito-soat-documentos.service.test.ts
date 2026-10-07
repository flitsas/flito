// HU #13362 (Feature #13360, Épica #13201) — clasificación de los documentos adicionales del alta
// de SOAT (`clasificarAdicionales`, puro) y piezas del servicio que no necesitan HTTP.
//
// Matriz AC → casos (qa-a-13362, archivo [S]):
//   TC-02 formatos aceptados POR BYTES: PDF, JPG, PNG, WEBP, HEIC/HEIF (ftyp heic/heix/mif1/msf1).
//   TC-03 etiqueta ausente / "" / espacios → el nombre del archivo; truncada a 150.
//   TC-06 vacío, <4 bytes y texto → «formato no permitido», sin excepción.
//   TC-07 15 MB exactos se aceptan; 15 MB + 1 → «supera el tamaño máximo de 15 MB».
//   TC-08 22 válidos → los 20 primeros EN ORDEN; 21 y 22 «supera el máximo de 20».
//   TC-09 17 × 15 MB → acumulado ≤ 250 MB en orden; el resto «supera el total de 250 MB».
//   TC-12 dos idénticos → el primero se acepta, el segundo «documento repetido»; y el idéntico a la
//         factura de venta del mismo envío, también.
//   + AC10 `detalleBitacoraAdicional`: sin nombre completo; vínculo de completar acotado por SQL.

import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { renderizar } from '../helpers/sql-ligado.js';

vi.mock('../../src/db/client.js', () => ({ db: {}, getPoolStats: vi.fn() }));
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: vi.fn(), deleteEntityDocument: vi.fn(), firmarDescargaEntidad: vi.fn(),
  removeEntityDocument: vi.fn(),
}));

const {
  clasificarAdicionales, detalleBitacoraAdicional, normalizarEtiquetas, vincularAdicionalesAlSoat,
  UMBRALES_ADICIONALES, LARGO_ETIQUETA,
} = await import('../../src/modules/flito-soat/flito-soat-documentos.service.js');
type Recibido = import('../../src/modules/flito-soat/flito-soat-documentos.upload.js').ArchivoAdicionalRecibido;

const MB = 1024 * 1024;

const BYTES = {
  pdf: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n'),
  jpg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.from('JFIF\0'), Buffer.alloc(20)]),
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(17)]),
  webp: Buffer.concat([Buffer.from('RIFF'), Buffer.from([30, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(20)]),
};
const ftyp = (marca: string) =>
  Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${marca}`), Buffer.alloc(4), Buffer.from(`mif1${marca}`), Buffer.alloc(8)]);

let n = 0;
/** Un recibido como lo deja el motor; `size` simulado si se pide (sin buffers de 250 MB). */
function recibido(cabecera: Buffer, over: Partial<Recibido> = {}): Recibido {
  n += 1;
  return {
    originalname: `doc-${n}.bin`, path: `/tmp/x/${n}`, size: cabecera.length,
    sha256: createHash('sha256').update(cabecera).update(String(n)).digest('hex'),
    cabecera, excedeTamano: false, excedeTotal: false, ...over,
  };
}

describe('TC-02 — formato por BYTES (RN-DA1)', () => {
  it.each([
    ['PDF %PDF-', BYTES.pdf, 'application/pdf'],
    ['JPG FFD8FF', BYTES.jpg, 'image/jpeg'],
    ['PNG 89504E47', BYTES.png, 'image/png'],
    ['WEBP RIFF....WEBP', BYTES.webp, 'image/webp'],
    ['HEIC ftyp heic', ftyp('heic'), 'image/heic'],
    ['HEIC ftyp heix', ftyp('heix'), 'image/heic'],
    ['HEIF ftyp mif1', ftyp('mif1'), 'image/heif'],
    ['HEIF ftyp msf1', ftyp('msf1'), 'image/heif-sequence'],
  ])('%s → aceptado con el mime DETECTADO', async (_n, bytes, mime) => {
    const r = await clasificarAdicionales([recibido(bytes, { originalname: 'x.exe' })], [], null);
    expect(r.descartados).toEqual([]);
    expect(r.aceptados).toHaveLength(1);
    expect(r.aceptados[0].contentType).toBe(mime);
  });
});

describe('TC-06 — lo no reconocido es «formato no permitido», sin excepción', () => {
  it.each([
    ['vacío', Buffer.alloc(0)],
    ['3 bytes', Buffer.from([1, 2, 3])],
    ['texto .txt', Buffer.from('hola mundo, esto es texto plano')],
    ['ejecutable MZ renombrado', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)])],
  ])('%s', async (_n, bytes) => {
    const r = await clasificarAdicionales([recibido(bytes, { originalname: 'factura.pdf' })], [], null);
    expect(r.aceptados).toEqual([]);
    expect(r.descartados).toEqual([
      { nombreArchivo: 'factura.pdf', codigo: 'formato_no_permitido', motivo: 'formato no permitido' },
    ]);
  });
});

describe('TC-03 — etiqueta vacía → nombre del archivo (AC2)', () => {
  it.each([[undefined], [''], ['   ']])('etiqueta %j → originalname', async (et) => {
    const r = await clasificarAdicionales([recibido(BYTES.png, { originalname: 'cedula.png' })], et === undefined ? undefined : [et], null);
    expect(r.aceptados[0].etiqueta).toBe('cedula.png');
    expect(r.aceptados[0].etiquetaDeNombre).toBe(true);
  });

  it('la etiqueta tecleada se recorta (trim) y manda; alineada por índice; ≤150', async () => {
    const r = await clasificarAdicionales(
      [recibido(BYTES.png, { originalname: 'a.png' }), recibido(BYTES.jpg, { originalname: 'b.jpg' })],
      ['  Cédula del titular  ', 'x'.repeat(200)], null,
    );
    expect(r.aceptados.map((a) => a.etiqueta)).toEqual(['Cédula del titular', 'x'.repeat(LARGO_ETIQUETA)]);
    expect(r.aceptados.map((a) => a.etiquetaDeNombre)).toEqual([false, false]);
  });

  it('una sola etiqueta llega como string (multer) y vale para el primero', () => {
    expect(normalizarEtiquetas('uno')).toEqual(['uno']);
    expect(normalizarEtiquetas(['uno', 'dos'])).toEqual(['uno', 'dos']);
    expect(normalizarEtiquetas(undefined)).toEqual([]);
  });
});

describe('TC-07 — 15 MB por archivo, inclusivo (RN-DA2)', () => {
  it('15 MB exactos → aceptado; 15 MB + 1 → «supera el tamaño máximo de 15 MB»', async () => {
    const r = await clasificarAdicionales([
      recibido(BYTES.png, { originalname: 'justo.png', size: 15 * MB }),
      recibido(BYTES.png, { originalname: 'grande.png', size: 15 * MB + 1 }),
    ], [], null);
    expect(r.aceptados.map((a) => a.nombreArchivo)).toEqual(['justo.png']);
    expect(r.descartados).toEqual([
      { nombreArchivo: 'grande.png', codigo: 'supera_tamano', motivo: 'supera el tamaño máximo de 15 MB' },
    ]);
  });

  it('el motor lo marcó `excedeTamano` (sin path) → supera_tamano, no formato', async () => {
    const r = await clasificarAdicionales([recibido(BYTES.png, { path: null, excedeTamano: true, size: 16 * MB })], [], null);
    expect(r.descartados[0].codigo).toBe('supera_tamano');
  });
});

describe('TC-08 — máximo 20 aceptados, en el orden recibido', () => {
  it('22 válidos → los 20 primeros; 21 y 22 «supera el máximo de 20 documentos por envío»', async () => {
    const archivos = Array.from({ length: 22 }, (_, i) => recibido(BYTES.png, { originalname: `f${i + 1}.png` }));
    const r = await clasificarAdicionales(archivos, [], null);
    expect(r.aceptados.map((a) => a.nombreArchivo)).toEqual(Array.from({ length: 20 }, (_, i) => `f${i + 1}.png`));
    expect(r.descartados).toEqual([
      { nombreArchivo: 'f21.png', codigo: 'supera_cantidad', motivo: 'supera el máximo de 20 documentos por envío' },
      { nombreArchivo: 'f22.png', codigo: 'supera_cantidad', motivo: 'supera el máximo de 20 documentos por envío' },
    ]);
  });
});

describe('TC-09 — 250 MB acumulados por envío, en orden', () => {
  it('17 × 15 MB → los 16 primeros (240 MB); el 17.º «supera el total de 250 MB por envío»', async () => {
    const archivos = Array.from({ length: 17 }, (_, i) => recibido(BYTES.pdf, { originalname: `g${i + 1}.pdf`, size: 15 * MB }));
    const r = await clasificarAdicionales(archivos, [], null);
    expect(r.aceptados).toHaveLength(16);
    expect(r.aceptados.reduce((s, a) => s + a.tamanoBytes, 0)).toBeLessThanOrEqual(UMBRALES_ADICIONALES.totalMax);
    expect(r.descartados).toEqual([
      { nombreArchivo: 'g17.pdf', codigo: 'supera_total', motivo: 'supera el total de 250 MB por envío' },
    ]);
  });

  it('uno pequeño DESPUÉS del que no cupo sí entra (el acumulado es de los aceptados)', async () => {
    const r = await clasificarAdicionales([
      recibido(BYTES.pdf, { originalname: 'a.pdf', size: 8 }),
      recibido(BYTES.pdf, { originalname: 'b.pdf', size: 5 }),
      recibido(BYTES.pdf, { originalname: 'c.pdf', size: 2 }),
    ], [], null, { tamanoMax: 100, cantidadMax: 20, totalMax: 10 });
    expect(r.aceptados.map((a) => a.nombreArchivo)).toEqual(['a.pdf', 'c.pdf']);
    expect(r.descartados.map((d) => [d.nombreArchivo, d.codigo])).toEqual([['b.pdf', 'supera_total']]);
  });

  it('el motor dejó de escribirlo por el tope de disco (`excedeTotal`) → supera_total', async () => {
    const r = await clasificarAdicionales([recibido(BYTES.pdf, { path: null, excedeTotal: true })], [], null);
    expect(r.descartados[0].codigo).toBe('supera_total');
  });
});

describe('TC-12 — documento repetido (RN-DA3)', () => {
  it('dos idénticos → el primero se acepta, el segundo «documento repetido»', async () => {
    const a = recibido(BYTES.png, { originalname: 'uno.png' });
    const b = { ...recibido(BYTES.png, { originalname: 'otro.png' }), sha256: a.sha256 };
    const r = await clasificarAdicionales([a, b], [], null);
    expect(r.aceptados.map((x) => x.nombreArchivo)).toEqual(['uno.png']);
    expect(r.descartados).toEqual([{ nombreArchivo: 'otro.png', codigo: 'documento_repetido', motivo: 'documento repetido' }]);
  });

  it('idéntico a la factura de venta del mismo envío → «documento repetido»', async () => {
    const hashFactura = createHash('sha256').update(BYTES.pdf).digest('hex');
    const r = await clasificarAdicionales([{ ...recibido(BYTES.pdf, { originalname: 'fv.pdf' }), sha256: hashFactura }], [], hashFactura);
    expect(r.aceptados).toEqual([]);
    expect(r.descartados[0].codigo).toBe('documento_repetido');
  });
});

describe('AC10 — el detalle de la Bitácora no lleva el nombre completo', () => {
  const base = { id: 's-1', nombreArchivo: 'n'.repeat(120) + '.pdf', contentType: 'application/pdf', tamanoBytes: 9 };
  it('con etiqueta: soporte + etiqueta, sin el nombre del archivo', () => {
    const d = detalleBitacoraAdicional({ ...base, etiqueta: 'Cédula', etiquetaDeNombre: false });
    expect(d).toBe('Documento adicional cargado (soporte=s-1, etiqueta=Cédula)');
    expect(d).not.toContain('nnnn');
  });
  it('sin etiqueta: el nombre truncado a 40 + «…»', () => {
    const d = detalleBitacoraAdicional({ ...base, etiqueta: base.nombreArchivo, etiquetaDeNombre: true });
    expect(d).toBe(`Documento adicional cargado (soporte=s-1, nombre=${'n'.repeat(40)}…)`);
    expect(d).not.toContain(base.nombreArchivo);
  });
});

describe('D3-bis §3 — completar vincula SOLO los adicionales de esa incompleta', () => {
  it('UPDATE soat_id acotado por soat_incompleta_id Y por tipo (sobre el SQL, no la llamada)', async () => {
    const llamadas: { set: unknown; where: SQL }[] = [];
    const tx = {
      update: () => ({ set: (set: unknown) => ({ where: async (where: SQL) => { llamadas.push({ set, where }); } }) }),
    };
    await vincularAdicionalesAlSoat(tx as never, 'inc-1', 'soat-1');
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].set).toEqual({ soatId: 'soat-1' });
    const q = renderizar(llamadas[0].where);
    expect(q.sql).toMatch(/"flito_soportes"\."soat_incompleta_id" = \$1/);
    expect(q.sql).toMatch(/"flito_soportes"\."tipo" = \$2/);
    expect(q.params).toEqual(['inc-1', 'documento_adicional_soat']);
  });
});

// ── HU #13364 — carga posterior: repetido contra lo YA guardado (AC2, TC-30/TC-31) ─────────────────

describe('HU #13364 TC-31 — repetido contra las huellas previas de la solicitud', () => {
  it('el idéntico a una huella previa (adicional guardado o factura) es «documento repetido»; el resto entra', async () => {
    const guardado = recibido(BYTES.pdf, { originalname: 'ya-guardado.pdf' });
    const factura = recibido(BYTES.png, { originalname: 'igual-a-la-factura.png' });
    const nuevo = recibido(BYTES.jpg, { originalname: 'nuevo.jpg' });
    const r = await clasificarAdicionales([guardado, factura, nuevo], [], [guardado.sha256, factura.sha256]);
    expect(r.aceptados.map((a) => a.nombreArchivo)).toEqual(['nuevo.jpg']);
    expect(r.descartados).toEqual([
      { nombreArchivo: 'ya-guardado.pdf', codigo: 'documento_repetido', motivo: 'documento repetido' },
      { nombreArchivo: 'igual-a-la-factura.png', codigo: 'documento_repetido', motivo: 'documento repetido' },
    ]);
  });

  it('el alta sigue pasando UN string (la factura) y lo trata igual que una lista de uno', async () => {
    const a = recibido(BYTES.pdf);
    const comoString = await clasificarAdicionales([a], [], a.sha256);
    const comoLista = await clasificarAdicionales([a], [], [a.sha256]);
    expect(comoString.descartados.map((d) => d.codigo)).toEqual(['documento_repetido']);
    expect(comoLista).toEqual(comoString);
  });

  it('TC-30: los cupos son POR ENVÍO — con 20 huellas previas, 20 nuevos distintos entran todos', async () => {
    const previos = Array.from({ length: 20 }, (_, i) => `previo-${i}`);
    const nuevos = Array.from({ length: 20 }, () => recibido(BYTES.png));
    const r = await clasificarAdicionales(nuevos, [], previos, UMBRALES_ADICIONALES);
    expect(r.aceptados).toHaveLength(20);
    expect(r.descartados).toEqual([]);
  });
});

describe('HU #13364 AC9 — Bitácora del borrado', () => {
  it('«eliminado» con la etiqueta; el nombre largo truncado si la etiqueta salió del nombre; rastro del objeto pendiente', () => {
    const conEtiqueta = { id: 's-1', etiqueta: 'Cédula', etiquetaDeNombre: false, nombreArchivo: 'cedula-de-juan-perez-completa.pdf' };
    expect(detalleBitacoraAdicional(conEtiqueta, 'eliminado')).toBe('Documento adicional eliminado (soporte=s-1, etiqueta=Cédula)');
    const largo = 'x'.repeat(60) + '.pdf';
    const deNombre = { id: 's-2', etiqueta: largo, etiquetaDeNombre: true, nombreArchivo: largo };
    expect(detalleBitacoraAdicional(deNombre, 'eliminado', true))
      .toBe(`Documento adicional eliminado (soporte=s-2, nombre=${'x'.repeat(40)}…, objeto pendiente de borrar)`);
    expect(detalleBitacoraAdicional(conEtiqueta)).toBe('Documento adicional cargado (soporte=s-1, etiqueta=Cédula)');
  });
});
