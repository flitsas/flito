// PESV · autodiagnóstico — el nombre de la evidencia sigue saliendo en la lista.
//
// Este archivo existe por la EXCEPCIÓN del Bug #11694. El resto del monorepo pasó a claves opacas
// (`<ts>_<uuid>.<ext>`) para que el nombre que escribe el cliente no viaje en el query string del
// enlace firmado. Esta ruta no pudo: `pesv_diagnostico_items.evidencia_keys` es un `text[]` de
// claves y no hay columna donde guardar el nombre, así que la pantalla lo recupera PARSEANDO la
// clave (`decodeFilename`). Por eso conserva el formato legado — y por eso hace falta un test que
// lo note si alguien «limpia» la excepción: el síntoma sería un UUID en la lista de evidencias, no
// un error, y sin esto no lo vería nadie hasta que un auditor abriera la pantalla.
//
// MinIO está mockeado pero `uploadEntityDocument` es el REAL: la clave que se afirma es la que
// produce el helper hoy, no una que fabrique el test.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { chain } from '../helpers/db.js';
import { adminAuth } from '../helpers/auth.js';

const PDF = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1');

const putObjectMock = vi.fn();
const statObjectMock = vi.fn();
const clavesSubidas: string[] = [];

class MockClient {
  bucketExists = vi.fn().mockResolvedValue(true);
  makeBucket = vi.fn();
  putObject = putObjectMock;
  getObject = vi.fn();
  statObject = statObjectMock;
  removeObject = vi.fn().mockResolvedValue(undefined);
}
vi.mock('minio', () => ({ Client: MockClient }));

const selectMock = vi.fn();
const executeMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: executeMock,
    transaction: transactionMock,
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('express-rate-limit', () => ({
  default: () => (_req: any, _res: any, next: any) => next(),
}));

const ITEM = {
  diagnostico_id: 3, estandar_id: 7, score_pct: '75', nivel_rubrica: 'implementado',
  evidencia_keys: [] as string[], comentarios: null, updated_at: new Date('2026-08-21T12:00:00Z'),
  codigo: 'E-07', paso: 2, fase: 'planear', nombre: 'Política', descripcion: 'desc', peso: '3', orden: 7,
};

let app: any;

beforeEach(async () => {
  selectMock.mockReset();
  executeMock.mockReset().mockResolvedValue([{ '?column?': 1 }]);
  transactionMock.mockReset();
  putObjectMock.mockReset().mockImplementation(async (_bucket: string, key: string) => {
    clavesSubidas.push(key);
  });
  statObjectMock.mockReset().mockResolvedValue({ size: 1024, metaData: { 'content-type': 'application/pdf' } });
  clavesSubidas.length = 0;

  // El diagnóstico existe y está abierto.
  selectMock.mockReturnValue(chain([{ id: 3, estado: 'abierto', createdBy: 1 }]));

  // La tx: lock → append → relectura. La relectura devuelve la clave que el handler acaba de subir
  // (la captura `putObjectMock`), que es como se comporta el `array_append` real.
  transactionMock.mockImplementation(async (cb: any) => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [ITEM] })
      .mockResolvedValueOnce({ rows: [] })
      .mockImplementation(async () => ({ rows: [{ ...ITEM, evidencia_keys: [...clavesSubidas] }] }));
    return cb({ execute });
  });

  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

describe('PESV evidencias — el nombre del archivo sobrevive a la clave (excepción Bug #11694)', () => {
  it('la lista devuelta tras subir enseña el nombre real, no un UUID', async () => {
    const r = await request(app)
      .post('/api/pesv/diagnostico/3/items/7/evidencias')
      .set('Authorization', await adminAuth())
      .attach('archivo', PDF, { filename: 'politica-alcohol-v2.pdf', contentType: 'application/pdf' });

    expect(r.status).toBe(201);
    expect(r.body.item.evidencias).toHaveLength(1);
    // Lo que ve el usuario en la pantalla del estándar.
    expect(r.body.item.evidencias[0].filename).toBe('politica-alcohol-v2.pdf');
    // El keyHash —lo único que el frontend recibe de la clave (ADR-PESV-001)— sigue emitiéndose.
    expect(r.body.item.evidencias[0].keyHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('la clave guardada conserva el formato legado <ts>_<hash>_<nombre> que PESV sabe parsear', async () => {
    await request(app)
      .post('/api/pesv/diagnostico/3/items/7/evidencias')
      .set('Authorization', await adminAuth())
      .attach('archivo', PDF, { filename: 'politica-alcohol-v2.pdf', contentType: 'application/pdf' });

    expect(clavesSubidas).toHaveLength(1);
    expect(clavesSubidas[0]).toMatch(
      /^pesv\/diagnostico-evidencia\/3\/\d+_[0-9a-f]{12}_politica-alcohol-v2\.pdf$/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4 (HU #11770) — TEST DE CARACTERIZACIÓN. Esto NO es un defecto olvidado.
//
// Lee esto entero antes de «arreglar» lo que afirma. Lo que este bloque fija es que el enlace
// temporal de una evidencia PESV TODAVÍA lleva el nombre del archivo del cliente dentro del
// `?key=`. Es decir: fija una exposición que sigue abierta, a sabiendas.
//
// Por qué está abierta. El Bug #11694 volvió opacas las claves de los ~15 puntos de carga del
// monorepo, porque `firmarDescargaEntidad` mete la clave ENTERA en el query string del enlace
// (`/api/files?key=…`) y de ahí pasa a los logs de acceso de nginx, al historial del navegador y al
// `Referer`. Las evidencias del autodiagnóstico PESV quedaron FUERA de ese cambio por una razón de
// datos, no de descuido: `pesv_diagnostico_items.evidencia_keys` es un `text[]` de claves y no hay
// ninguna columna donde guardar el nombre del archivo. Tres sitios lo recuperan PARSEANDO la clave
// —`evidenciaPublic` (lista del estándar, `diagnostico.routes.ts`), `decodeFilename` (esta misma
// respuesta) y el nombre de cada entrada del ZIP de `export-diagnostico.routes.ts`—. Con la clave
// opaca los tres enseñarían un UUID: la pantalla de un auditor dejaría de decir qué documento es.
//
// Por qué se ancla en un test en vez de dejarlo en un comentario. Un comentario no falla en CI. Esto
// hace dos cosas: deja el riesgo residual visible donde se mira, y obliga a que quien añada la
// columna `nombre_archivo` tenga que TOCAR este archivo para cerrarlo — o sea, a cerrarlo de verdad
// y no a medias.
//
// Qué hacer cuando llegue esa columna: quitar `conservarNombreEnClave` de
// `diagnostico-evidencias.routes.ts`, migrar los tres parseos a la columna, y sustituir este bloque
// por su contrario (que el `?key=` YA NO contiene el nombre). Lo que NO hay que hacer es quitar
// `conservarNombreEnClave` sin la columna: las tres pantallas pasarían a enseñar un UUID y nadie se
// enteraría, porque no es un error, es una degradación silenciosa.
// ─────────────────────────────────────────────────────────────────────────────
describe('PESV evidencias — el enlace temporal TODAVÍA lleva el nombre en el ?key= (excepción retenida)', () => {
  // Con forma de placa colombiana: el dato concreto que el Bug #11694 perseguía. El nombre del
  // archivo lo escribe el cliente y en este dominio trae placas, cédulas y NIT más veces de las que
  // parece.
  const NOMBRE_CON_PLACA = 'evidencia-ABC123.pdf';

  /** Sube una evidencia y devuelve la clave real y el keyHash con el que el frontend la pide. */
  async function subirEvidencia(): Promise<{ storageKey: string; keyHash: string }> {
    const r = await request(app)
      .post('/api/pesv/diagnostico/3/items/7/evidencias')
      .set('Authorization', await adminAuth())
      .attach('archivo', PDF, { filename: NOMBRE_CON_PLACA, contentType: 'application/pdf' });
    expect(r.status).toBe(201);
    return { storageKey: clavesSubidas[0], keyHash: r.body.item.evidencias[0].keyHash };
  }

  it('la url firmada expone la clave entera —con la placa dentro— en el query string', async () => {
    const { storageKey, keyHash } = await subirEvidencia();
    // El GET lee `evidencia_keys` por `db.execute`; se le devuelve la clave que acaba de subirse.
    executeMock.mockResolvedValue({ rows: [{ evidencia_keys: [storageKey] }] });

    const r = await request(app)
      .get(`/api/pesv/diagnostico/3/items/7/evidencias/${keyHash}`)
      .set('Authorization', await adminAuth());

    expect(r.status).toBe(200);

    const key = new URLSearchParams(String(r.body.url).split('?')[1]).get('key');
    // AFIRMACIÓN CENTRAL: la clave del `?key=` es la clave real, y la clave real trae el nombre.
    expect(key).toBe(storageKey);
    expect(key).toContain('ABC123');
    expect(key).toContain('evidencia-ABC123.pdf');
    // Y por tanto la propia URL —lo que acaba en el log de nginx y en el historial— la lleva.
    expect(String(r.body.url)).toContain('ABC123');
  });

  it('el `filename` de la respuesta sale de parsear esa clave: es lo que sostiene la excepción', async () => {
    const { storageKey, keyHash } = await subirEvidencia();
    executeMock.mockResolvedValue({ rows: [{ evidencia_keys: [storageKey] }] });

    const r = await request(app)
      .get(`/api/pesv/diagnostico/3/items/7/evidencias/${keyHash}`)
      .set('Authorization', await adminAuth());

    // `decodeFilename` quita el `<ts>_<hash>_` y devuelve el nombre. Si la clave fuera opaca esto
    // sería un UUID, y es la razón entera por la que la excepción sigue viva.
    expect(r.body.filename).toBe(NOMBRE_CON_PLACA);
  });

  // El contraste que hace legible lo anterior: cualquier OTRO punto de carga sí cierra el vector.
  // Si algún día este caso empieza a fallar, es que se rompió el Bug #11694, no que se arregló PESV.
  it('contraste — el mismo nombre por el camino normal (sin la excepción) NO llega a la url', async () => {
    const { uploadEntityDocument, firmarDescargaEntidad } = await import('../../src/services/storage.js');
    const clave = await uploadEntityDocument(
      'bolsas-transito/b1/cargas', 'b1', NOMBRE_CON_PLACA, PDF, 'application/pdf',
    );
    expect(firmarDescargaEntidad(clave, 300)).not.toContain('ABC123');
  });
});
