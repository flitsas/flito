import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: auditMock,
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset();
  auditMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/clients/clients.routes.js');
  app.use('/api/clients', router);
  return app;
}

const adminToken = () => testToken({ sub: 1, role: 'admin' });

/** Cliente previo tal como lo devuelve el SELECT del PATCH. */
function previo(extra: Record<string, unknown> = {}) {
  return {
    id: 1, name: 'Acme SAS', document: '900123456', documentType: 'NIT',
    personType: 'Company', idType: '31', checkDigit: null, fiscalResponsibilities: [],
    countryCode: null, stateCode: null, cityCode: null, commercialName: null,
    branchOffice: 0, contactFirstName: null, contactLastName: null, contactEmail: null,
    phoneIndicative: null, phoneNumber: null,
    ...extra,
  };
}

/**
 * Deja el PATCH listo: primero el SELECT del estado previo, luego el UPDATE.
 *
 * `parejaLibre` añade el SELECT de unicidad que el handler hace solo cuando el cuerpo toca la
 * identidad del tercero (documento o sucursal).
 */
function prepararPatch(
  anterior: Record<string, unknown>,
  resultado: Record<string, unknown> | null,
  parejaLibre = false,
) {
  selectMock.mockReturnValueOnce(chain([anterior]));
  if (parejaLibre) selectMock.mockReturnValueOnce(chain([]));
  updateMock.mockReturnValueOnce({
    set: () => ({ where: () => ({ returning: () => Promise.resolve(resultado ? [resultado] : []) }) }),
  });
}

describe('clients — auth', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/clients');
    expect(r.status).toBe(401);
  });

  it('proveedor → POST 403 (admin only)', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`)
      .send({ name: 'X' });
    expect(r.status).toBe(403);
  });
});

describe('GET /', () => {
  it('admin → 200 con array', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1, name: 'Cliente A' }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/clients').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
  });

  it('limit y offset query params', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/clients?limit=50&offset=10').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  it('devuelve los campos fiscales nuevos (AC6)', async () => {
    selectMock.mockReturnValueOnce(chain([previo({ facturacionBloqueos: ['identificacion_duplicada'] })]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).get('/api/clients').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body[0]).toMatchObject({ personType: 'Company', idType: '31', branchOffice: 0 });
    expect(r.body[0].facturacionBloqueos).toEqual(['identificacion_duplicada']);
  });
});

describe('POST /', () => {
  it('name vacío → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`)
      .send({ name: '' });
    expect(r.status).toBe(400);
  });

  it('email inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`)
      .send({ name: 'X', email: 'no-arroba' });
    expect(r.status).toBe(400);
  });

  it('éxito → 201 + audit', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 100, name: 'Acme SAS' }]) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Acme SAS', email: 'admin@acme.com' });
    expect(r.status).toBe(201);
    expect(r.body.id).toBe(100);
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'create', resource: 'client' }),
    );
  });

  it('sin ningún dato fiscal sigue creándose: nada nuevo es obligatorio (AC1)', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 101, name: 'Mínimo' }]) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Mínimo' });
    expect(r.status).toBe(201);
  });
});

// ── AC6 — enumeraciones cerradas ───────────────────────────────────────────
//
// `documentType` es cadena libre porque cerrarlo rompería filas existentes; los campos fiscales
// nuevos NO tienen esa excusa. Un `id_type` inventado no se descubre al guardarlo: se descubre
// cuando Siigo rechaza la factura, que es varios pasos y varios días más tarde.
describe('POST / — validación de los datos fiscales (AC6)', () => {
  const CASOS: { caso: string; cuerpo: Record<string, unknown> }[] = [
    { caso: 'tipo de persona fuera de los dos admitidos', cuerpo: { personType: 'Empresa' } },
    { caso: 'tipo de identificación que no es de Siigo', cuerpo: { idType: '99' } },
    { caso: 'dígito de verificación de dos cifras', cuerpo: { checkDigit: 12 } },
    { caso: 'dígito de verificación negativo', cuerpo: { checkDigit: -1 } },
    { caso: 'responsabilidad fiscal inventada', cuerpo: { fiscalResponsibilities: ['O-99'] } },
    { caso: 'sucursal por encima de 999', cuerpo: { branchOffice: 1000 } },
    { caso: 'sucursal negativa', cuerpo: { branchOffice: -1 } },
    { caso: 'sucursal con decimales', cuerpo: { branchOffice: 1.5 } },
    { caso: 'indicativo con letras', cuerpo: { phoneIndicative: '+57' } },
    { caso: 'número de teléfono de más de 10 dígitos', cuerpo: { phoneNumber: '31112223334' } },
    { caso: 'correo de contacto mal formado', cuerpo: { contactEmail: 'sin-arroba' } },
  ];

  for (const { caso, cuerpo } of CASOS) {
    it(`${caso} → 400 señalando el campo`, async () => {
      const token = await adminToken();
      const app = await buildApp();
      const r = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`)
        .send({ name: 'X', ...cuerpo });
      expect(r.status).toBe(400);
      // «señalando el campo»: un 400 sin decir cuál no sirve para corregirlo.
      expect(Object.keys(r.body.details?.fieldErrors ?? {})).toEqual(
        expect.arrayContaining([Object.keys(cuerpo)[0]]),
      );
      expect(insertMock).not.toHaveBeenCalled();
    });
  }

  it('los valores válidos sí pasan', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 5, name: 'Válido' }]) }),
    });
    selectMock.mockReturnValueOnce(chain([]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Válido', document: '900123456',
        personType: 'Company', idType: '31', checkDigit: 7,
        fiscalResponsibilities: ['R-99-PN', 'O-15'],
        countryCode: 'CO', stateCode: '11', cityCode: '11001',
        branchOffice: 3, phoneIndicative: '57', phoneNumber: '3001234567',
        contactFirstName: 'Ana', contactEmail: 'ana@acme.com',
      });
    expect(r.status).toBe(201);
  });

  it('un dato fiscal se puede BORRAR mandando null, no solo omitirlo', async () => {
    prepararPatch(previo({ idType: '31' }), { ...previo(), idType: null });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/clients/1').set('Authorization', `Bearer ${token}`)
      .send({ idType: null });
    expect(r.status).toBe(200);
  });
});

// ── AC5 — la identidad del tercero es (identificación, sucursal) ────────────
describe('identificación y sucursal (AC5)', () => {
  it('crear repitiendo la pareja → 409, sin insertar', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 7 }]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Repetido', document: '900123456', branchOffice: 0 });
    expect(r.status).toBe(409);
    expect(r.body.campo).toBe('document');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('el mismo documento en OTRA sucursal sí se permite: en Siigo son terceros distintos', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 8, name: 'Sucursal 2' }]) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Sucursal 2', document: '900123456', branchOffice: 2 });
    expect(r.status).toBe(201);
  });

  it('un cliente sin documento no se compara contra nada', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 9, name: 'Sin documento' }]) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Sin documento' });
    expect(r.status).toBe(201);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('mover a una sucursal ya ocupada → 409, sin actualizar', async () => {
    selectMock.mockReturnValueOnce(chain([previo()]));   // estado previo
    selectMock.mockReturnValueOnce(chain([{ id: 42 }])); // la pareja ya existe en otro cliente
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/clients/1').set('Authorization', `Bearer ${token}`)
      .send({ branchOffice: 5 });
    expect(r.status).toBe(409);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('editar algo que no es la identidad no gasta una consulta de unicidad', async () => {
    prepararPatch(previo(), { ...previo(), name: 'Otro nombre' });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/clients/1').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Otro nombre' });
    expect(r.status).toBe(200);
    expect(selectMock).toHaveBeenCalledTimes(1); // solo el del estado previo
  });
});

// ── Coherencia entre los tres campos de identidad fiscal ───────────────────
//
// Los CHECK son por columna: cada campo puede ser válido por separado y el conjunto ser mentira.
// El daño no se ve aquí, se ve cuando la factura sale ante la DIAN con el tipo de identificación
// equivocado.
describe('coherencia fiscal', () => {
  it('NIT declarado como persona natural → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`)
      .send({ name: 'X', documentType: 'NIT', personType: 'Person' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Datos fiscales incoherentes');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('tipo de identificación que no corresponde al tipo de documento → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`)
      .send({ name: 'X', documentType: 'CC', idType: '31' });
    expect(r.status).toBe(400);
  });

  it('un NIT de Siigo no puede ser persona natural aunque no haya documentType', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`)
      .send({ name: 'X', idType: '31', personType: 'Person' });
    expect(r.status).toBe(400);
  });

  it('cambiar SOLO el tipo de documento por PATCH no puede dejar la fila incoherente', async () => {
    // Es el caso real: alguien corrige en pantalla lo único que ve. Sin esta guarda la fila queda
    // con tipo de identificación de NIT sobre un número de cédula.
    selectMock.mockReturnValueOnce(chain([previo({ documentType: 'NIT', personType: 'Company', idType: '31' })]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/clients/1').set('Authorization', `Bearer ${token}`)
      .send({ documentType: 'CC' });
    expect(r.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('cambiar el tipo de documento junto con los otros dos sí se acepta', async () => {
    prepararPatch(
      previo({ documentType: 'NIT', personType: 'Company', idType: '31' }),
      { ...previo(), documentType: 'CC', personType: 'Person', idType: '13' },
    );
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/clients/1').set('Authorization', `Bearer ${token}`)
      .send({ documentType: 'CC', personType: 'Person', idType: '13' });
    expect(r.status).toBe(200);
  });

  it('un tipo de documento desconocido no impone nada: no se inventan reglas', async () => {
    insertMock.mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 12, name: 'Pasaporte' }]) }),
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Pasaporte', documentType: 'PA', personType: 'Person', idType: '41' });
    expect(r.status).toBe(201);
  });
});

// ── El origen del tipo de persona ───────────────────────────────────────────
describe('clasificación manual del tipo de persona', () => {
  it('fijar el tipo de persona lo marca como manual: la migración no debe volver a derivarlo', async () => {
    let guardado: Record<string, unknown> | undefined;
    selectMock.mockReturnValueOnce(chain([previo({ documentType: 'CC', personType: null, idType: null })]));
    updateMock.mockReturnValueOnce({
      set: (payload: Record<string, unknown>) => {
        guardado = payload;
        return { where: () => ({ returning: () => Promise.resolve([{ ...previo(), personType: 'Person' }]) }) };
      },
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/clients/1').set('Authorization', `Bearer ${token}`)
      .send({ personType: 'Person' });
    expect(r.status).toBe(200);
    expect(guardado).toMatchObject({ personType: 'Person', personTypeOrigen: 'manual' });
  });

  it('editar cualquier otra cosa NO toca el origen', async () => {
    let guardado: Record<string, unknown> | undefined;
    selectMock.mockReturnValueOnce(chain([previo()]));
    updateMock.mockReturnValueOnce({
      set: (payload: Record<string, unknown>) => {
        guardado = payload;
        return { where: () => ({ returning: () => Promise.resolve([previo()]) }) };
      },
    });
    const token = await adminToken();
    const app = await buildApp();
    await request(app).patch('/api/clients/1').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Otro' });
    expect(guardado).not.toHaveProperty('personTypeOrigen');
  });

  it('el origen NO es escribible desde fuera', async () => {
    let guardado: Record<string, unknown> | undefined;
    insertMock.mockReturnValueOnce({
      values: (payload: Record<string, unknown>) => {
        guardado = payload;
        return { returning: () => Promise.resolve([{ id: 30, name: 'X' }]) };
      },
    });
    const token = await adminToken();
    const app = await buildApp();
    await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`)
      .send({ name: 'X', personTypeOrigen: 'derivado', facturacionBloqueos: [] });
    // Zod descarta lo desconocido: ni el origen ni los bloqueos llegan a la base desde la petición.
    expect(guardado).not.toHaveProperty('facturacionBloqueos');
    expect(guardado?.personTypeOrigen).toBeUndefined();
  });
});

// ── El documento se guarda normalizado ──────────────────────────────────────
describe('normalización del documento', () => {
  it('se guarda sin espacios y en mayúsculas, no solo se compara así', async () => {
    let guardado: Record<string, unknown> | undefined;
    selectMock.mockReturnValueOnce(chain([]));
    insertMock.mockReturnValueOnce({
      values: (payload: Record<string, unknown>) => {
        guardado = payload;
        return { returning: () => Promise.resolve([{ id: 20, name: 'Con espacios' }]) };
      },
    });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Con espacios', document: '  ab998877  ' });
    expect(r.status).toBe(201);
    // Guardarlo con espacios dejaba dos clientes que esta ruta ve como uno y que
    // `companiaPorNit` no encuentra, con sus trámites huérfanos de compañía.
    expect(guardado?.document).toBe('AB998877');
  });
});

describe('PATCH /:id', () => {
  it('id inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/clients/abc').set('Authorization', `Bearer ${token}`)
      .send({ name: 'X' });
    expect(r.status).toBe(400);
  });

  it('no encontrado → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/clients/999').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Nuevo' });
    expect(r.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('actualizar nombre → 200', async () => {
    prepararPatch(previo(), { id: 1, name: 'Nuevo' });
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/clients/1').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Nuevo' });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Nuevo');
  });

  it('email inválido → 400', async () => {
    const token = await adminToken();
    const app = await buildApp();
    const r = await request(app).patch('/api/clients/1').set('Authorization', `Bearer ${token}`)
      .send({ email: 'mal-formato' });
    expect(r.status).toBe(400);
  });
});

// ── AC7 — escritura restringida y auditada ─────────────────────────────────
describe('auditoría de los datos fiscales (AC7)', () => {
  it('un rol de solo lectura los consulta pero no los guarda', async () => {
    selectMock.mockReturnValueOnce(chain([previo()]));
    const auditor = await testToken({ sub: 2, role: 'auditor' });
    const app = await buildApp();

    const lectura = await request(app).get('/api/clients').set('Authorization', `Bearer ${auditor}`);
    expect(lectura.status).toBe(200);

    const escritura = await request(app).patch('/api/clients/1').set('Authorization', `Bearer ${auditor}`)
      .send({ personType: 'Person' });
    expect(escritura.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('registra el valor anterior y el nuevo de cada campo fiscal', async () => {
    prepararPatch(
      previo({ personType: 'Company', idType: '31', branchOffice: 0, fiscalResponsibilities: ['R-99-PN'] }),
      { ...previo(), personType: 'Person', idType: '13', branchOffice: 2, fiscalResponsibilities: ['O-15'] },
      true, // cambia la sucursal: el handler comprueba antes que la pareja esté libre
    );
    const token = await adminToken();
    const app = await buildApp();
    // `documentType` viaja también: sin él la fila quedaría con tipo de identificación de cédula
    // sobre un documento declarado NIT, y la guarda de coherencia lo rechaza con razón.
    const r = await request(app).patch('/api/clients/1').set('Authorization', `Bearer ${token}`)
      .send({ documentType: 'CC', personType: 'Person', idType: '13', branchOffice: 2, fiscalResponsibilities: ['O-15'] });
    expect(r.status).toBe(200);

    const detalle = auditMock.mock.calls.at(-1)?.[1].detail as string;
    expect(detalle).toContain('personType: Company → Person');
    expect(detalle).toContain('idType: 31 → 13');
    expect(detalle).toContain('branchOffice: 0 → 2');
    expect(detalle).toContain('fiscalResponsibilities: R-99-PN → O-15');
  });

  it('NO escribe el contacto en la auditoría: dice que cambió, no a qué', async () => {
    prepararPatch(
      previo({ contactEmail: null, contactFirstName: null }),
      { ...previo(), contactEmail: 'ana.ramirez@acme.com', contactFirstName: 'Ana' },
    );
    const token = await adminToken();
    const app = await buildApp();
    await request(app).patch('/api/clients/1').set('Authorization', `Bearer ${token}`)
      .send({ contactEmail: 'ana.ramirez@acme.com', contactFirstName: 'Ana' });

    const detalle = auditMock.mock.calls.at(-1)?.[1].detail as string;
    // `audit_logs` no la purga ningún cron: un correo ahí sobrevive al derecho al olvido.
    expect(detalle).not.toContain('ana.ramirez@acme.com');
    expect(detalle).not.toContain('Ana');
    expect(detalle).toContain('contactEmail: modificado');
    expect(detalle).toContain('contactFirstName: modificado');
  });

  it('editar un cliente sin tocar lo fiscal no ensucia la auditoría con ruido de facturación', async () => {
    prepararPatch(previo(), { ...previo(), name: 'Acme SAS renombrada' });
    const token = await adminToken();
    const app = await buildApp();
    await request(app).patch('/api/clients/1').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Acme SAS renombrada' });

    const detalle = auditMock.mock.calls.at(-1)?.[1].detail as string;
    expect(detalle).not.toContain('Datos fiscales');
  });
});
