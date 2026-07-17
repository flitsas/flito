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

  it('uploadEntityDocument: sanitiza prefix + usa key <prefix>/<entityId>/<ts>_<hash>_<name>', async () => {
    bucketExistsMock.mockResolvedValueOnce(true);
    const { uploadEntityDocument } = await import('../../src/services/storage.js');
    const key = await uploadEntityDocument('drivers/docs', 7, 'cedula.jpg', Buffer.from('x'), 'image/jpeg');
    expect(key).toMatch(/^drivers\/docs\/7\/\d+_[0-9a-f]{12}_cedula\.jpg$/);
  });

  it('uploadEntityDocument: prefix con caracteres extraños se sanitiza (../path → _.._path)', async () => {
    bucketExistsMock.mockResolvedValueOnce(true);
    const { uploadEntityDocument } = await import('../../src/services/storage.js');
    const key = await uploadEntityDocument('../etc/passwd', 1, 'a.txt', Buffer.from('x'), 'text/plain');
    expect(key).not.toContain('../');
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
