import { describe, it, expect, vi, beforeEach } from 'vitest';

const bucketExistsMock = vi.fn();
const makeBucketMock = vi.fn();
const putObjectMock = vi.fn();
const getObjectMock = vi.fn();
const removeObjectMock = vi.fn();
// vi.fn().mockImplementation(arrowFn) NO es construible. Usamos una clase real
// y tracking de instancias vía un spy externo.
const ClientCtor = vi.fn();
class MockClient {
  bucketExists = bucketExistsMock;
  makeBucket = makeBucketMock;
  putObject = putObjectMock;
  getObject = getObjectMock;
  removeObject = removeObjectMock;
  constructor(cfg: any) { ClientCtor(cfg); }
}

vi.mock('minio', () => ({
  Client: MockClient,
}));

beforeEach(() => {
  bucketExistsMock.mockReset();
  makeBucketMock.mockReset();
  putObjectMock.mockReset().mockResolvedValue(undefined);
  getObjectMock.mockReset();
  removeObjectMock.mockReset().mockResolvedValue(undefined);
  ClientCtor.mockClear();
});

describe('storage — ensureBucket', () => {
  it('bucket no existe → makeBucket en us-east-1', async () => {
    bucketExistsMock.mockResolvedValueOnce(false);
    const { ensureBucket } = await import('../../src/services/storage.js');
    await ensureBucket();
    expect(makeBucketMock).toHaveBeenCalledWith('operaciones-biometrics', 'us-east-1');
  });

  it('bucket existe → NO crea', async () => {
    bucketExistsMock.mockResolvedValueOnce(true);
    const { ensureBucket } = await import('../../src/services/storage.js');
    await ensureBucket();
    expect(makeBucketMock).not.toHaveBeenCalled();
  });
});

describe('storage — uploadPhoto', () => {
  it('decodifica base64 y guarda en validaciones/<id>/<tipo>_<hash>.jpg', async () => {
    const { uploadPhoto } = await import('../../src/services/storage.js');
    const b64 = Buffer.from('hello').toString('base64');
    const key = await uploadPhoto(42, 'rostro', `data:image/jpeg;base64,${b64}`);

    expect(key).toMatch(/^validaciones\/42\/rostro_[0-9a-f]{16}\.jpg$/);
    expect(putObjectMock).toHaveBeenCalledTimes(1);
    const [bucket, calledKey, buf, len, headers] = putObjectMock.mock.calls[0];
    expect(bucket).toBe('operaciones-biometrics');
    expect(calledKey).toBe(key);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.toString('utf-8')).toBe('hello');
    expect(len).toBe(5);
    expect(headers['Content-Type']).toBe('image/jpeg');
  });

  it('acepta base64 sin prefijo data:image', async () => {
    const { uploadPhoto } = await import('../../src/services/storage.js');
    const b64 = Buffer.from('rawpayload').toString('base64');
    await uploadPhoto(7, 'cedfrontal', b64);
    expect(putObjectMock.mock.calls[0][2].toString('utf-8')).toBe('rawpayload');
  });

  it('claves únicas por random hex aún con mismos inputs', async () => {
    const { uploadPhoto } = await import('../../src/services/storage.js');
    const b64 = Buffer.from('x').toString('base64');
    const k1 = await uploadPhoto(1, 'rostro', b64);
    const k2 = await uploadPhoto(1, 'rostro', b64);
    expect(k1).not.toBe(k2);
  });
});

describe('storage — getPhoto', () => {
  it('lee stream y devuelve data:image/jpeg;base64,<b64>', async () => {
    const handlers: Record<string, (arg?: any) => void> = {};
    const stream = {
      on: vi.fn((event: string, cb: (arg?: any) => void) => { handlers[event] = cb; return stream; }),
    };
    getObjectMock.mockResolvedValueOnce(stream);

    const { getPhoto } = await import('../../src/services/storage.js');
    const promise = getPhoto('validaciones/1/rostro_abc.jpg');
    // getPhoto await client.getObject() → handlers se registran tras 1 microtask
    await Promise.resolve();
    await Promise.resolve();

    handlers.data(Buffer.from('hello'));
    handlers.data(Buffer.from(' world'));
    handlers.end();

    const r = await promise;
    expect(r.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(Buffer.from(r.replace('data:image/jpeg;base64,', ''), 'base64').toString('utf-8'))
      .toBe('hello world');
  });

  it('stream emite error → promesa rechaza', async () => {
    const handlers: Record<string, (arg?: any) => void> = {};
    const stream = {
      on: vi.fn((event: string, cb: (arg?: any) => void) => { handlers[event] = cb; return stream; }),
    };
    getObjectMock.mockResolvedValueOnce(stream);

    const { getPhoto } = await import('../../src/services/storage.js');
    const promise = getPhoto('x');
    await Promise.resolve();
    await Promise.resolve();
    handlers.error(new Error('S3 fail'));
    await expect(promise).rejects.toThrow('S3 fail');
  });
});

describe('storage — deletePhoto', () => {
  it('llama removeObject con bucket+key', async () => {
    const { deletePhoto } = await import('../../src/services/storage.js');
    await deletePhoto('validaciones/1/rostro_a.jpg');
    expect(removeObjectMock).toHaveBeenCalledWith('operaciones-biometrics', 'validaciones/1/rostro_a.jpg');
  });

  it('throws de removeObject se PROPAGAN (a diferencia de deleteFleetDocument)', async () => {
    removeObjectMock.mockRejectedValueOnce(new Error('boom'));
    const { deletePhoto } = await import('../../src/services/storage.js');
    await expect(deletePhoto('x')).rejects.toThrow('boom');
  });
});

// Formato de clave nueva, fijado a mano: <prefix>/<entityId>/<timestamp>_<uuid v4>.<ext>.
const UUID_KEY =
  /^[A-Za-z0-9_/-]+\/[^/]+\/\d+_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/;

describe('storage — uploadFleetDocument / uploadEntityDocument', () => {
  it('uploadFleetDocument: sanitiza filename + usa prefijo fleet/documents/<vehicleId>/', async () => {
    bucketExistsMock.mockResolvedValueOnce(true);
    const { uploadFleetDocument } = await import('../../src/services/storage.js');
    const key = await uploadFleetDocument(99, 'mi documento (final).pdf', Buffer.from('pdf'), 'application/pdf');

    // [^A-Za-z0-9._-]+ es greedy: " (" matches en 1 (no 2) → un solo "_" entre tokens
    expect(key).toMatch(/^fleet\/documents\/99\/\d+_[0-9a-f]{12}_mi_documento_final_\.pdf$/);
    expect(putObjectMock.mock.calls[0][4]['Content-Type']).toBe('application/pdf');
  });

  it('uploadFleetDocument: ensureBucket inline cuando no existe', async () => {
    bucketExistsMock.mockResolvedValueOnce(false);
    const { uploadFleetDocument } = await import('../../src/services/storage.js');
    await uploadFleetDocument(1, 'a.pdf', Buffer.from('x'), 'application/pdf');
    expect(makeBucketMock).toHaveBeenCalled();
  });

  it('uploadFleetDocument: filename limita a 100 chars', async () => {
    bucketExistsMock.mockResolvedValueOnce(true);
    const { uploadFleetDocument } = await import('../../src/services/storage.js');
    const longName = 'a'.repeat(150) + '.pdf';
    const key = await uploadFleetDocument(1, longName, Buffer.from('x'), 'application/pdf');
    // key incluye la parte truncada (100 chars), no debería contener los 150
    const filenamePart = key.split('_').slice(-1)[0];
    expect(filenamePart.length).toBeLessThanOrEqual(100);
  });

  it('uploadEntityDocument: sanitiza prefix + usa key <prefix>/<entityId>/<ts>_<uuid>.<ext>', async () => {
    bucketExistsMock.mockResolvedValueOnce(true);
    const { uploadEntityDocument } = await import('../../src/services/storage.js');
    const key = await uploadEntityDocument('drivers/docs', 7, 'cedula.jpg', Buffer.from('x'), 'image/jpeg');
    // Formato escrito a mano, no derivado del helper: <ts>_<uuid v4>.<ext>.
    expect(key).toMatch(UUID_KEY);
    expect(key.startsWith('drivers/docs/7/')).toBe(true);
  });

  it('uploadEntityDocument: prefix con caracteres extraños se sanitiza (../path → _.._path)', async () => {
    bucketExistsMock.mockResolvedValueOnce(true);
    const { uploadEntityDocument } = await import('../../src/services/storage.js');
    const key = await uploadEntityDocument('../etc/passwd', 1, 'a.txt', Buffer.from('x'), 'text/plain');
    expect(key).not.toContain('../');
  });
});

// Bug #11694 — el nombre del archivo lo escribe el cliente y la clave viaja entera en el query
// string del enlace firmado. Lo que estos tests fijan es que ese nombre NO entre en la clave.
describe('storage — uploadEntityDocument: la clave no lleva el nombre del cliente (Bug #11694)', () => {
  it('un nombre con placa dentro NO aparece en la clave (ni entero ni a trozos)', async () => {
    bucketExistsMock.mockResolvedValueOnce(true);
    const { uploadEntityDocument } = await import('../../src/services/storage.js');
    const key = await uploadEntityDocument(
      'bolsas-transito/b1/cargas', 'b1',
      'comprobante-ABC123 Juan Pérez CC 79.123.456.pdf', Buffer.from('x'), 'application/pdf',
    );

    expect(key).not.toContain('ABC123');
    expect(key).not.toContain('comprobante');
    expect(key).not.toContain('Juan');
    expect(key).not.toContain('79.123.456');
    expect(key).toMatch(UUID_KEY);
    // Y es la MISMA clave que se manda a MinIO: no vale devolver una y guardar otra.
    expect(putObjectMock.mock.calls[0][1]).toBe(key);
  });

  it('dos subidas del mismo archivo dan claves distintas (el UUID no depende del nombre)', async () => {
    bucketExistsMock.mockResolvedValue(true);
    const { uploadEntityDocument } = await import('../../src/services/storage.js');
    const a = await uploadEntityDocument('p', 1, 'x.pdf', Buffer.from('x'), 'application/pdf');
    const b = await uploadEntityDocument('p', 1, 'x.pdf', Buffer.from('x'), 'application/pdf');
    expect(a).not.toBe(b);
  });

  it('conserva la extensión del nombre — `tipoPorExtension` de /api/files depende de ella', async () => {
    bucketExistsMock.mockResolvedValue(true);
    const { uploadEntityDocument } = await import('../../src/services/storage.js');
    const pdf = await uploadEntityDocument('p', 1, 'recibo ABC123.PDF', Buffer.from('x'), 'application/pdf');
    const xlsx = await uploadEntityDocument('p', 1, 'padron.xlsx', Buffer.from('x'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(pdf.endsWith('.pdf')).toBe(true);   // se normaliza a minúsculas
    expect(xlsx.endsWith('.xlsx')).toBe(true);
  });

  it('sin extensión utilizable manda el mime declarado, no un trozo del nombre', async () => {
    bucketExistsMock.mockResolvedValue(true);
    const { uploadEntityDocument } = await import('../../src/services/storage.js');
    // Sin punto: `split('.').pop()` devolvería el nombre entero. Es el caso que reabriría el hueco.
    const sinPunto = await uploadEntityDocument('p', 1, 'comprobante-ABC123', Buffer.from('x'), 'image/png');
    // Con punto pero con una "extensión" que no lo es (lleva espacio y 20 caracteres).
    const falsa = await uploadEntityDocument('p', 1, 'foto.de la placa ABC123', Buffer.from('x'), 'image/jpeg');
    // Mime desconocido y sin extensión → `bin`, nunca el nombre.
    const raro = await uploadEntityDocument('p', 1, 'ABC123', Buffer.from('x'), 'application/x-cosa');

    expect(sinPunto.endsWith('.png')).toBe(true);
    expect(falsa.endsWith('.jpg')).toBe(true);
    expect(raro.endsWith('.bin')).toBe(true);
    for (const k of [sinPunto, falsa, raro]) expect(k).not.toContain('ABC123');
  });

  // Lo que va después del último punto NO es «la extensión»: es lo que el cliente haya escrito ahí,
  // y `.` es un carácter perfectamente válido dentro de un nombre. La forma de una placa colombiana
  // (ABC123, WGY45F) y la de una cédula o un NIT caben ENTERAS dentro de «alfanumérico y corto», que
  // era el filtro. O sea que el dato que este Bug persigue volvía a la clave —y de ahí al `?key=`—
  // por la puerta de atrás. Solo un conjunto CERRADO de extensiones lo cierra.
  const EVASIONES: Array<[string, string, string, string]> = [
    ['comprobante.ABC123', 'application/pdf', 'abc123', '.pdf'],
    ['soporte.WGY45F', 'application/pdf', 'wgy45f', '.pdf'],
    ['cedula.79483215', 'image/jpeg', '79483215', '.jpg'],
    ['nit.900123', 'application/pdf', '900123', '.pdf'],
    ['a.b.c.SXG87H', 'application/pdf', 'sxg87h', '.pdf'], // varios puntos: se toma el último
  ];

  it.each(EVASIONES)(
    'sufijo con forma de placa/cédula (%s): NO entra en la clave, manda el mime',
    async (filename, mime, sufijo, extEsperada) => {
      bucketExistsMock.mockResolvedValue(true);
      const { uploadEntityDocument } = await import('../../src/services/storage.js');
      const key = await uploadEntityDocument(
        'bolsas-transito/b1/cargas', 'b1', filename, Buffer.from('x'), mime,
      );

      // Se compara contra el nombre SIN el prefijo de epoch: los casos numéricos («900123») podrían
      // colisionar por azar con los dígitos del timestamp y el test dejaría de medir lo suyo.
      const nombre = key.split('/').pop()!.replace(/^\d+_/, '');
      expect(nombre.toLowerCase()).not.toContain(sufijo);
      expect(key.toLowerCase().endsWith(extEsperada)).toBe(true);
      expect(key).toMatch(UUID_KEY);
      // Y es la misma clave que se manda a MinIO.
      expect(putObjectMock.mock.calls.at(-1)![1]).toBe(key);
    },
  );

  it('entityId se sanea como el prefix: no puede abrir segmentos nuevos en la clave', async () => {
    bucketExistsMock.mockResolvedValue(true);
    const { uploadEntityDocument } = await import('../../src/services/storage.js');
    // `flito-bolsas.routes.ts` pasa `req.params.bolsaId` CRUDO y sube antes de tocar la BD: nada lo
    // obliga a ser un UUID, y Express ya decodificó el `%2F`.
    const key = await uploadEntityDocument(
      'bolsas-transito/cargas', '../../etc/x', 'a.pdf', Buffer.from('x'), 'application/pdf',
    );
    expect(key.startsWith('bolsas-transito/cargas/')).toBe(true);
    expect(key).not.toContain('../');
    // prefix (2 segmentos) + entityId (1) + archivo (1): el entityId no aporta profundidad extra.
    expect(key.split('/')).toHaveLength(4);
    expect(key.split('/')[2]).toBe('_etc_x');
  });

  it('`conservarNombreEnClave` (excepción PESV) mantiene el formato legado <ts>_<hash>_<nombre>', async () => {
    bucketExistsMock.mockResolvedValueOnce(true);
    const { uploadEntityDocument } = await import('../../src/services/storage.js');
    const key = await uploadEntityDocument(
      'pesv/diagnostico-evidencia', 12, 'Politica de alcohol.pdf', Buffer.from('x'), 'application/pdf',
      { conservarNombreEnClave: true },
    );
    // PESV recupera el nombre parseando la clave con /^\d+_[0-9a-f]+_/: el formato es su contrato.
    expect(key).toMatch(/^pesv\/diagnostico-evidencia\/12\/\d+_[0-9a-f]{12}_Politica_de_alcohol\.pdf$/);
    expect(key.split('/').pop()!.replace(/^\d+_[0-9a-f]+_/, '')).toBe('Politica_de_alcohol.pdf');
  });
});

// Las claves ya escritas NO se reescriben (decisión de alcance del Bug #11694): la migración más la
// copia de objetos en MinIO no desharía lo que ya está en los logs de nginx. Así que tienen que
// seguir descargándose exactamente igual — esto es lo que lo fija.
describe('storage — firma de descarga: las claves del formato VIEJO siguen sirviendo', () => {
  const CLAVE_VIEJA = 'bolsas-transito/b1/cargas/1755000000000_a1b2c3d4e5f6_comprobante-ABC123.pdf';

  it('firmar + verificar una clave legada → válida', async () => {
    const { firmarDescargaEntidad, verificarDescargaEntidad } =
      await import('../../src/services/storage.js');
    const url = firmarDescargaEntidad(CLAVE_VIEJA, 300);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('key')).toBe(CLAVE_VIEJA);
    expect(verificarDescargaEntidad(params.get('key')!, params.get('exp')!, params.get('sig')!)).toBe(true);
  });

  it('firma de una clave legada NO vale para otra clave', async () => {
    const { firmarDescargaEntidad, verificarDescargaEntidad } =
      await import('../../src/services/storage.js');
    const params = new URLSearchParams(firmarDescargaEntidad(CLAVE_VIEJA, 300).split('?')[1]);
    expect(verificarDescargaEntidad(`${CLAVE_VIEJA}x`, params.get('exp')!, params.get('sig')!)).toBe(false);
  });

  it('clave legada expirada → inválida (el TTL no depende del formato)', async () => {
    const { firmarDescargaEntidad, verificarDescargaEntidad } =
      await import('../../src/services/storage.js');
    const params = new URLSearchParams(firmarDescargaEntidad(CLAVE_VIEJA, -1).split('?')[1]);
    expect(verificarDescargaEntidad(CLAVE_VIEJA, params.get('exp')!, params.get('sig')!)).toBe(false);
  });

  it('clave NUEVA (opaca): mismo camino de firma y verificación', async () => {
    bucketExistsMock.mockResolvedValueOnce(true);
    const { uploadEntityDocument, firmarDescargaEntidad, verificarDescargaEntidad } =
      await import('../../src/services/storage.js');
    const key = await uploadEntityDocument('p', 1, 'recibo ABC123.pdf', Buffer.from('x'), 'application/pdf');
    const url = firmarDescargaEntidad(key, 300);
    expect(url).not.toContain('ABC123');
    const params = new URLSearchParams(url.split('?')[1]);
    expect(verificarDescargaEntidad(params.get('key')!, params.get('exp')!, params.get('sig')!)).toBe(true);
  });
});

describe('storage — deleteFleetDocument / deleteEntityDocument (errores silenciosos)', () => {
  it('deleteFleetDocument: si removeObject throws → log warn pero NO propaga', async () => {
    removeObjectMock.mockRejectedValueOnce(new Error('boom'));
    const { deleteFleetDocument } = await import('../../src/services/storage.js');
    await expect(deleteFleetDocument('fleet/documents/1/x')).resolves.toBeUndefined();
  });

  it('deleteEntityDocument: si removeObject throws → silencioso', async () => {
    removeObjectMock.mockRejectedValueOnce(new Error('boom'));
    const { deleteEntityDocument } = await import('../../src/services/storage.js');
    await expect(deleteEntityDocument('x/1/y')).resolves.toBeUndefined();
  });
});

describe('storage — Client singleton (lazy)', () => {
  it('Client se instancia 1 sola vez (lazy + cache) — invalidando módulo', async () => {
    // Resetea storage.ts → nuevo singleton interno + cuenta limpia de ClientCtor.
    vi.resetModules();
    ClientCtor.mockClear();
    const { uploadPhoto, deletePhoto } = await import('../../src/services/storage.js');
    await uploadPhoto(1, 't', Buffer.from('x').toString('base64'));
    await deletePhoto('x');
    await uploadPhoto(2, 't', Buffer.from('y').toString('base64'));
    expect(ClientCtor).toHaveBeenCalledTimes(1);
  });
});
