// Siigo — asegurar el tercero antes de facturar (HU #11297). Un bloque por criterio.
//
// Esta es la primera historia del programa que ESCRIBE fuera de FLITO, así que el test que más
// importa no es ninguno de los del camino feliz: es el que comprueba que actualizar no borra en
// Siigo Nube lo que FLITO no modela. Ese daño no tiene vuelta atrás y no produce ningún error.
//
// El armado del objeto es puro y se interroga sin red. La orquestación se prueba contra el
// simulador REAL del módulo —no un mock del mock—, porque el AC7 pide justamente que el ciclo
// completo se pueda ensayar ahí, y un simulador que no imponga las reglas de Siigo daría por bueno
// código que crea duplicados en producción.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));

/** El cliente es facturable salvo que un test diga lo contrario (AC5). */
const exigirClienteFacturableMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/siigo/siigo.validador-cliente.service.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.validador-cliente.service.js')>();
  return { ...real, exigirClienteFacturable: (id: number) => exigirClienteFacturableMock(id) };
});

/** Las peticiones se atienden con el SIMULADOR del módulo, que es lo que el AC7 quiere ensayar. */
const { respuestaSimulada, olvidarTercerosSimulados } = await import(
  '../../src/modules/siigo/siigo.mock.js');

const siigoRequestOrThrowMock = vi.fn(async (req: { metodo: string; ruta: string; cuerpo?: unknown }) => {
  const r = respuestaSimulada(req.metodo as 'GET', req.ruta, { cuerpo: req.cuerpo });
  if (!r.ok) throw Object.assign(new Error('Siigo rechazó la operación'), { datos: r.datos, status: r.status });
  return r.datos;
});
vi.mock('../../src/modules/siigo/siigo.client.js', () => ({
  siigoRequestOrThrow: (req: unknown) => siigoRequestOrThrowMock(req as never),
  siigoRequest: vi.fn(),
  SiigoRequestError: class extends Error {},
}));

vi.mock('../../src/modules/siigo/siigo.resiliencia.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.resiliencia.js')>();
  return { ...real, ejecutarConResiliencia: async (op: () => Promise<unknown>) => op() };
});

const registrarOperacionMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.operaciones.repo.js')>();
  return { ...real, registrarOperacion: (r: unknown) => registrarOperacionMock(r) };
});

const {
  armarTercero, asegurarTercero, buscarTercero, fusionarConExistente, huellaDeTercero,
  SiigoTerceroError,
} = await import('../../src/modules/siigo/siigo.terceros.service.js');

/** Una compañía con la ficha fiscal completa. */
function ficha(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    name: 'Transportes del Sur S.A.S.',
    document: '900123456',
    // `id_type` sale de la columna que la 0132 creó PARA esto, no de `document_type` (libre y
    // heredado). 31 = NIT en el catálogo de Siigo.
    idType: '31',
    personType: 'Company',
    branchOffice: 0,
    commercialName: 'Transur',
    fiscalResponsibilities: ['R-99-PN'],
    countryCode: 'CO',
    stateCode: '11',
    cityCode: '11001',
    address: 'Calle 100 # 20-30',
    contactFirstName: 'Ana',
    contactLastName: 'Ramírez',
    contactEmail: 'ana@transur.test',
    phoneIndicative: '601',
    phoneNumber: '3001234',
    ...over,
  };
}

beforeEach(() => {
  kdb.reset();
  olvidarTercerosSimulados();
  siigoRequestOrThrowMock.mockClear();
  registrarOperacionMock.mockClear();
  exigirClienteFacturableMock.mockClear().mockResolvedValue(undefined);
});

describe('El objeto que viaja a Siigo', () => {
  it('lleva la forma documentada: `name` es un ARRAY', () => {
    const t = armarTercero(ficha());
    expect(Array.isArray(t.name)).toBe(true);
    expect(t.name).toEqual(['Transportes del Sur S.A.S.']);
  });

  it('una persona natural lleva nombres y apellidos separados', () => {
    const t = armarTercero(ficha({
      personType: 'Person', name: 'Marcos Castillo', idType: '13', document: '1032456789',
    }));
    expect(t.person_type).toBe('Person');
    expect(t.name).toHaveLength(2);
  });

  it('los opcionales sin dato se OMITEN, no se mandan vacíos', () => {
    // La diferencia entre omitir y mandar vacío es la diferencia entre conservar y borrar. Con un
    // `PUT` que reemplaza, `phones: []` no significa «no tengo teléfono»: significa «bórrale el
    // teléfono». Y un array vacío en el objeto que se superpone gana sobre lo que Siigo tenía.
    const t = armarTercero(ficha({ phoneNumber: null, commercialName: '  ', contactFirstName: null }));
    expect(t).not.toHaveProperty('phones');
    expect(t).not.toHaveProperty('contacts');
    expect(t).not.toHaveProperty('commercial_name');
  });

  it('con dato sí se incluyen', () => {
    const t = armarTercero(ficha());
    expect(t.phones).toHaveLength(1);
    expect(t.contacts).toHaveLength(1);
  });

  it('un nombre que no se puede armar NO se maquilla', () => {
    // `armarNombreSiigo` devuelve el motivo nombrado. Un «NO REPORTA» de relleno sería una
    // afirmación ante la DIAN que nadie autorizó.
    expect(() => armarTercero(ficha({ personType: null }))).toThrow(SiigoTerceroError);
  });

  it('sin identificación no se arma nada', () => {
    expect(() => armarTercero(ficha({ document: '  ' }))).toThrow(SiigoTerceroError);
  });

  it('sin tipo de identificación VÁLIDO tampoco, y NO se inventa uno', () => {
    // El fallback anterior no era un código: era el mapa entero de tipos, así que el objeto que
    // viajaba a Siigo llevaba `id_type: {"11":"Person",…}`. TypeScript no lo detectaba y el build
    // pasaba en verde. Un tipo de identificación inventado sobre un documento fiscal es peor que
    // un error.
    expect(() => armarTercero(ficha({ idType: null }))).toThrow(SiigoTerceroError);
    expect(() => armarTercero(ficha({ idType: '99' }))).toThrow(SiigoTerceroError);

    const t = armarTercero(ficha());
    expect(typeof t.id_type).toBe('string');
  });
});

describe('AC4 — la huella decide si hace falta llamar', () => {
  it('el mismo objeto da la misma huella aunque cambie el orden de las claves', () => {
    const t = armarTercero(ficha());
    const reordenado = JSON.parse(JSON.stringify({ ...t, name: t.name })) as typeof t;
    expect(huellaDeTercero(reordenado)).toBe(huellaDeTercero(t));
  });

  it('un cambio real cambia la huella', () => {
    const a = huellaDeTercero(armarTercero(ficha()));
    const b = huellaDeTercero(armarTercero(ficha({ address: 'Otra dirección' })));
    expect(a).not.toBe(b);
  });

  it('un cambio que NO altera lo que Siigo ve deja la misma huella', () => {
    // Espacios de más en la razón social: la fila del cliente cambió, el objeto no. Calcular la
    // huella sobre la fila habría producido una llamada inútil a Siigo.
    const a = huellaDeTercero(armarTercero(ficha()));
    const b = huellaDeTercero(armarTercero(ficha({ name: '  Transportes del Sur S.A.S.  ' })));
    expect(a).toBe(b);
  });
});

describe('AC3 — actualizar NO borra lo que FLITO no modela', () => {
  it('conserva vendedor, cobrador y comentarios del tercero existente', () => {
    const existente = {
      id: 'cus-1',
      identification: '900123456',
      name: ['Transportes del Sur S.A.S.'],
      related_users: { seller_id: 629, collector_id: 733 },
      comments: 'Cliente heredado del maestro de contabilidad.',
      additional_fields: { CUCON: 'ABC' },
      metadata: { created: '2026-01-01' },
    };

    const completo = fusionarConExistente(existente, armarTercero(ficha({ address: 'Nueva' })));

    // ESTE es el test que importa de toda la historia. El `PUT` de Siigo reemplaza y no fusiona:
    // mandar «el objeto completo» construido solo con lo que FLITO sabe habría vaciado estos tres
    // campos en TODOS los clientes, de una pasada, sin error y sin vuelta atrás.
    expect(completo.related_users).toEqual({ seller_id: 629, collector_id: 733 });
    expect(completo.comments).toBe('Cliente heredado del maestro de contabilidad.');
    expect(completo.additional_fields).toEqual({ CUCON: 'ABC' });
    // Y lo nuestro sí se impone.
    expect((completo.address as { address: string }).address).toBe('Nueva');
  });

  it('un cliente SIN teléfono no le borra el teléfono al tercero en Siigo', () => {
    // Este es el caso concreto del borrado silencioso: FLITO no tiene el dato, Siigo sí, y una
    // sincronización rutinaria lo destruiría sin error y sin vuelta atrás.
    const existente = {
      id: 'cus-1',
      phones: [{ indicative: '601', number: '7654321' }],
      contacts: [{ first_name: 'Contacto', last_name: 'De Contabilidad' }],
    };

    const completo = fusionarConExistente(existente, armarTercero(ficha({
      phoneNumber: null, contactFirstName: null,
    })));

    expect(completo.phones).toEqual([{ indicative: '601', number: '7654321' }]);
    expect(completo.contacts).toEqual([{ first_name: 'Contacto', last_name: 'De Contabilidad' }]);
  });

  it('pero si FLITO SÍ tiene el dato, el suyo manda', () => {
    const existente = { id: 'cus-1', phones: [{ number: 'viejo' }] };
    const completo = fusionarConExistente(existente, armarTercero(ficha()));
    expect((completo.phones as { number: string }[])[0].number).toBe('3001234');
  });

  it('no reenvía `id` ni `metadata`, que los pone Siigo', () => {
    const completo = fusionarConExistente(
      { id: 'cus-1', metadata: { created: 'x' }, comments: 'hola' }, armarTercero(ficha()));
    expect(completo).not.toHaveProperty('id');
    expect(completo).not.toHaveProperty('metadata');
    expect(completo.comments).toBe('hola');
  });
});

describe('AC2 — la clave es la identificación CON la sucursal', () => {
  it('la búsqueda manda las dos', async () => {
    await buscarTercero('900123456', 3, 'pruebas');
    const ruta = (siigoRequestOrThrowMock.mock.calls[0][0] as { ruta: string }).ruta;
    expect(ruta).toContain('identification=900123456');
    expect(ruta).toContain('branch_office=3');
  });

  it('un tercero de OTRA sucursal no se vincula, aunque Siigo lo devuelva', async () => {
    // Se comprueba sobre la respuesta y no solo se confía en el filtro: quedarse con el primero que
    // llega es exactamente cómo se vincula un cliente al tercero de otra sucursal, y la factura
    // saldría contra el equivocado.
    siigoRequestOrThrowMock.mockResolvedValueOnce({
      results: [{ id: 'cus-otra', identification: '900123456', branch_office: 5 }],
    });

    expect(await buscarTercero('900123456', 0, 'pruebas')).toBeNull();
  });
});

describe('AC5 — un cliente no facturable no sale a la red', () => {
  it('se rechaza ANTES de llamar a Siigo', async () => {
    kdb.when.select('clients', [ficha()]);
    exigirClienteFacturableMock.mockRejectedValueOnce(
      new Error('Falta el código de ciudad y la responsabilidad fiscal.'));

    await expect(asegurarTercero(7)).rejects.toThrow();
    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
  });

  it('el mensaje enumera lo que falta', async () => {
    kdb.when.select('clients', [ficha()]);
    exigirClienteFacturableMock.mockRejectedValueOnce(
      new Error('Falta el código de ciudad y la responsabilidad fiscal.'));

    await expect(asegurarTercero(7)).rejects.toThrow(/ciudad/);
  });
});

describe('AC1 y AC7 — el ciclo completo contra el simulador', () => {
  it('sin vínculo y sin tercero en Siigo: se crea', async () => {
    kdb.when.select('clients', [ficha()]).select('siigo_terceros', []);
    kdb.when.insert('siigo_terceros', () => [{ id: 'v-1' }]);

    const r = await asegurarTercero(7);

    expect(r.desenlace).toBe('creado');
    expect(r.siigoCustomerId).toMatch(/^mock-customer-/);
    // Consultó ANTES de crear: crear a ciegas produce el duplicado que Siigo acepta cuando la
    // sucursal difiere, y rechaza cuando no — dos formas distintas de acabar mal.
    const metodos = siigoRequestOrThrowMock.mock.calls.map((c) => (c[0] as { metodo: string }).metodo);
    expect(metodos[0]).toBe('GET');
    expect(metodos).toContain('POST');
  });

  it('sin vínculo pero CON tercero en Siigo: se vincula, no se crea', async () => {
    // Se siembra en el simulador creando uno primero.
    respuestaSimulada('POST', '/v1/customers', {
      cuerpo: { identification: '900123456', branch_office: 0, name: ['Transportes del Sur S.A.S.'] },
    });

    kdb.when.select('clients', [ficha()]).select('siigo_terceros', []);
    kdb.when.insert('siigo_terceros', () => [{ id: 'v-2' }]);

    const r = await asegurarTercero(7);

    expect(r.desenlace).toBe('vinculado_existente');
    const metodos = siigoRequestOrThrowMock.mock.calls.map((c) => (c[0] as { metodo: string }).metodo);
    expect(metodos).not.toContain('POST');
  });

  it('el simulador RECHAZA crear un duplicado, como haría Siigo', () => {
    const cuerpo = { identification: '900123456', branch_office: 0, name: ['X'] };
    respuestaSimulada('POST', '/v1/customers', { cuerpo });

    const segunda = respuestaSimulada('POST', '/v1/customers', { cuerpo });

    // Un simulador más permisivo que Siigo es peor que no tenerlo: haría pasar en desarrollo el
    // caso que revienta en producción.
    expect(segunda.ok).toBe(false);
    expect(segunda.status).toBe(400);
  });

  it('pero la MISMA identificación en otra sucursal sí se admite', () => {
    respuestaSimulada('POST', '/v1/customers', { cuerpo: { identification: '900123456', branch_office: 0, name: ['X'] } });
    const otra = respuestaSimulada('POST', '/v1/customers', { cuerpo: { identification: '900123456', branch_office: 1, name: ['X'] } });

    // Es la regla documentada, y la razón de que la clave sea la pareja.
    expect(otra.ok).toBe(true);
  });
});

describe('AC4 en el ciclo — nada cambió, ninguna petición', () => {
  it('con la misma huella no se llama a Siigo', async () => {
    const huella = huellaDeTercero(armarTercero(ficha()));
    kdb.when.select('clients', [ficha()]).select('siigo_terceros', [{
      id: 'v-1', clientId: 7, siigoCustomerId: 'cus-1',
      identificacion: '900123456', sucursal: 0, huella,
    }]);

    const r = await asegurarTercero(7);

    // Es la rama más frecuente con diferencia: los datos fiscales cambian una vez al año y se
    // factura todas las semanas.
    expect(r.desenlace).toBe('sin_cambios');
    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
  });
});

describe('AC6 — los fallos se explican y no dejan el vínculo a medias', () => {
  it('si Siigo rechaza la creación, NO se escribe el vínculo local', async () => {
    kdb.when.select('clients', [ficha()]).select('siigo_terceros', []);
    siigoRequestOrThrowMock
      .mockResolvedValueOnce({ results: [] })
      .mockRejectedValueOnce(new Error('Siigo rechazó la creación'));

    await expect(asegurarTercero(7)).rejects.toThrow(SiigoTerceroError);

    // El vínculo se escribe DESPUÉS de que Siigo confirme, nunca antes: si no, quedaría un cliente
    // que FLITO cree vinculado a un tercero que no existe.
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('todo intento queda en la bitácora con su ambiente y su modo', async () => {
    kdb.when.select('clients', [ficha()]).select('siigo_terceros', []);
    kdb.when.insert('siigo_terceros', () => [{ id: 'v-1' }]);

    await asegurarTercero(7);

    const anotado = registrarOperacionMock.mock.calls[0][0] as { ambiente: string; modo?: string };
    expect(anotado.ambiente).toBeTruthy();
    expect(anotado.modo).toBeDefined();
  });

  it('no poder LEER el tercero antes de actualizar aborta: no se sobrescribe a ciegas', async () => {
    kdb.when.select('clients', [ficha({ address: 'cambió' })]).select('siigo_terceros', [{
      id: 'v-1', clientId: 7, siigoCustomerId: 'cus-1',
      identificacion: '900123456', sucursal: 0, huella: 'otra-huella',
    }]);
    siigoRequestOrThrowMock.mockRejectedValueOnce(new Error('502 Bad Gateway'));

    await expect(asegurarTercero(7)).rejects.toThrow();

    // Actualizar sin saber qué había es justo el borrado silencioso que la fusión existe para
    // impedir. Ante la duda, no se escribe.
    const metodos = siigoRequestOrThrowMock.mock.calls.map((c) => (c[0] as { metodo: string }).metodo);
    expect(metodos).not.toContain('PUT');
  });
});

describe('AC8 — la concurrencia la resuelve la base', () => {
  it('una violación de único se lee como «ya estaba vinculado», no como fallo', async () => {
    kdb.when.select('clients', [ficha()]).select('siigo_terceros', []);
    kdb.when.insert('siigo_terceros', () => {
      throw Object.assign(new Error('duplicate key'), { code: '23505' });
    });
    // La relectura devuelve el vínculo que ganó la carrera.
    kdb.when.selectOnce('siigo_terceros', []).selectOnce('siigo_terceros', [{
      id: 'v-ganador', clientId: 7, siigoCustomerId: 'cus-ganador',
      identificacion: '900123456', sucursal: 0, huella: 'x',
    }]);

    const r = await asegurarTercero(7);

    expect(r.desenlace).toBe('vinculado_existente');
    expect(r.siigoCustomerId).toBe('cus-ganador');
  });
});

describe('Correcciones de la auditoría — los caminos que borraban o mezclaban', () => {
  it('B2 — la fusión conserva también lo anidado que FLITO no modela', () => {
    const existente = {
      id: 'cus-1',
      address: { address: 'Vieja', postal_code: '110111', city: { country_code: 'CO' } },
      phones: [{ indicative: '601', number: 'viejo', extension: '204' }, { number: 'segundo' }],
      contacts: [{ first_name: 'Ana', phone: '3009999' }, { first_name: 'Otro contacto' }],
    };

    const completo = fusionarConExistente(existente, armarTercero(ficha()));

    // El spread solo protege el PRIMER nivel. Sin fusión dirigida, `postal_code` se borraría en
    // CADA actualización de CADA tercero, y con él la extensión y los elementos sobrantes.
    expect((completo.address as { postal_code: string }).postal_code).toBe('110111');
    const phones = completo.phones as Record<string, unknown>[];
    expect(phones[0].extension).toBe('204');
    expect(phones[0].number).toBe('3001234');   // lo nuestro sí manda
    expect(phones[1].number).toBe('segundo');   // la cola sobrevive
    const contacts = completo.contacts as Record<string, unknown>[];
    expect(contacts[0].phone).toBe('3009999');
    expect(contacts[1].first_name).toBe('Otro contacto');
  });

  it('B1 — un 200 con cuerpo ilegible NO se trata como «no existe»', async () => {
    kdb.when.select('clients', [ficha({ address: 'cambió' })]).select('siigo_terceros', [{
      id: 'v-1', clientId: 7, siigoCustomerId: 'cus-1',
      identificacion: '900123456', sucursal: 0, huella: 'otra',
    }]);
    // `siigo.client.ts` convierte un cuerpo no-JSON en `null` SIN lanzar. Tratarlo como «no existe»
    // y mandar el objeto crudo era el borrado que toda la historia previene, entrando por la única
    // puerta que quedaba abierta.
    siigoRequestOrThrowMock.mockResolvedValueOnce(null as never);

    // Se afirma el MENSAJE y no solo que lance: el `catch` exterior convierte cualquier error en
    // `SiigoTerceroError`, así que «lanza» lo cumple también un `TypeError` por reventar al leer un
    // `null`. La diferencia entre negarse a escribir y estrellarse importa: la primera es una
    // decisión y la segunda es suerte.
    await expect(asegurarTercero(7)).rejects.toThrow(/no devolvió el tercero|sin saber qué había/);
    const metodos = siigoRequestOrThrowMock.mock.calls.map((c) => (c[0] as { metodo: string }).metodo);
    expect(metodos).not.toContain('PUT');
  });

  it('B3 — si Siigo devuelve OTRO tercero, no se actualiza nada', async () => {
    kdb.when.select('clients', [ficha({ address: 'cambió' })]).select('siigo_terceros', [{
      id: 'v-1', clientId: 7, siigoCustomerId: 'cus-1',
      identificacion: '900123456', sucursal: 0, huella: 'otra',
    }]);
    siigoRequestOrThrowMock.mockResolvedValueOnce({
      id: 'cus-DE-OTRO', identification: '800999888', branch_office: 0,
      related_users: { seller_id: 111 },
    } as never);

    // Fusionar con el tercero equivocado incorporaría el vendedor, el cobrador y los comentarios de
    // OTRO cliente al `PUT` sobre este: mezcla de datos contables entre terceros, irreversible.
    await expect(asegurarTercero(7)).rejects.toThrow(SiigoTerceroError);
    const metodos = siigoRequestOrThrowMock.mock.calls.map((c) => (c[0] as { metodo: string }).metodo);
    expect(metodos).not.toContain('PUT');
  });

  it('B4 — al actualizar se refresca la pareja local, no solo la huella', async () => {
    kdb.when.select('clients', [ficha({ document: '900999888' })]).select('siigo_terceros', [{
      id: 'v-1', clientId: 7, siigoCustomerId: 'cus-1',
      identificacion: '900999888', sucursal: 0, huella: 'vieja',
    }]);
    siigoRequestOrThrowMock
      .mockResolvedValueOnce({ id: 'cus-1', identification: '900999888', branch_office: 0 } as never)
      .mockResolvedValueOnce({ id: 'cus-1' } as never);
    kdb.when.update('siigo_terceros', () => [{ id: 'v-1' }]);

    await asegurarTercero(7);

    // Sin refrescar la pareja, el índice único queda desalineado de la realidad y deja de proteger:
    // dos clientes podrían acabar facturando contra el mismo tercero.
    expect(kdb.update).toHaveBeenCalled();
  });

  it('B5 — si el choque fue con OTRO cliente, se dice; no se finge un vínculo', async () => {
    kdb.when.select('clients', [ficha()]);
    kdb.when.selectOnce('siigo_terceros', []);      // sin vínculo propio al empezar
    kdb.when.insert('siigo_terceros', () => {
      throw Object.assign(new Error('duplicate key'), { code: '23505' });
    });
    kdb.when.selectOnce('siigo_terceros', []);      // la relectura por cliente tampoco encuentra

    // Devolver un vínculo que este cliente NO tiene haría que `vinculoDeCliente` siguiera diciendo
    // `null` y nadie entendería por qué. Y si acabábamos de crear en Siigo, hay un tercero huérfano
    // allá: se dice en el mensaje, porque callado nadie lo encuentra.
    await expect(asegurarTercero(7)).rejects.toThrow(/ya está vinculado|SIN vincular/);
  });

  it('B7 — la identificación se anonimiza en el olvido', async () => {
    const { anonimizarTercerosDeClientes } = await import(
      '../../src/modules/siigo/siigo.terceros.service.js');
    kdb.when.update('siigo_terceros', () => [{ id: 'v-1' }]);

    // La tabla guarda la cédula EN CLARO porque hace falta para reencontrar el tercero. El flujo de
    // olvido anonimiza el cliente y no borra la fila, así que el CASCADE no alcanzaba.
    expect(await anonimizarTercerosDeClientes([7], 'ANON-abc123')).toBe(1);
    expect(await anonimizarTercerosDeClientes([], 'ANON-abc123')).toBe(0);
  });

  it('la identificación se compara sin distinguir mayúsculas', async () => {
    const { normalizarIdentificacion } = await import(
      '../../src/modules/siigo/siigo.terceros.service.js');

    // El catálogo admite tipos alfanuméricos (pasaporte, CE, PEP, PPT). Tratar `ab123` y `AB123`
    // como distintos hace que no se encuentre el tercero, se intente crear, Siigo responda
    // «duplicada» y el cliente quede bloqueado para siempre.
    expect(normalizarIdentificacion(' ab123 ')).toBe('AB123');
  });
});
