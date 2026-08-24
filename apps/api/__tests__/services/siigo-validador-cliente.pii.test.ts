// HU #11299 — registro de acceso a las fichas de cliente del informe de facturabilidad.
//
// El hallazgo que cierran estas pruebas: `GET /siigo/clientes/validacion/detalle` devuelve nombre e
// identificación —cédula de personas naturales, NIT de jurídicas— de hasta 500 clientes por llamada,
// y el módulo `siigo/` entero no escribía una sola línea en `pii_access_log` (Ley 1581 art. 17,
// AGENTS.md §16). El permiso ya estaba bien; lo que no se podía era reconstruir QUIÉN leyó el
// padrón.
//
// Lo que se demuestra, y por qué cada cosa:
//
//   1. **Leer deja rastro**, en las tres rutas de lectura, con recurso, acción y campos. Sin esto,
//      mañana alguien quita la línea y nada se pone rojo — que es exactamente cómo llegamos aquí.
//   2. **Cada ruta declara lo que ELLA entrega.** El resumen devuelve conteos y va con la lista de
//      campos VACÍA: un log que dijera que ahí se leyeron documentos haría inservible la consulta
//      «¿quién ha leído documentos?».
//   3. **El rastro no es un segundo almacén de identidades**: registra nombres de campo y el id del
//      cliente, nunca los valores leídos, y un filtro personal —el día que exista— va enmascarado.
//   4. **Un 404 y un 403 no registran acceso**: nadie miró los datos de nadie.
//   5. **La respuesta no cambió.** Añadir auditoría no puede alterar el DTO; el veredicto sigue
//      saliendo con `nombre` y `documento` en claro, que es lo que el panel pinta hoy.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(),
    transaction: vi.fn(), execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

/**
 * Se mockea `logPiiAccess` en vez de mirar el INSERT sobre `pii_access_log`.
 *
 * Lo que este módulo tiene que garantizar es QUÉ le pasa al helper compartido —recurso, acción,
 * campos, motivo—, no cómo ese helper escribe la fila: eso es asunto de `shared/pii-audit.ts` y
 * tiene sus propias pruebas.
 */
const logPiiAccessMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/pii-audit.js', () => ({
  logPiiAccess: (...args: unknown[]) => logPiiAccessMock(...args),
}));

const {
  CAMPOS_PII_RESUMEN, CAMPOS_PII_VEREDICTO, RECURSO_CLIENTE, registrarAccesoCliente,
} = await import('../../src/modules/siigo/siigo.pii.js');

beforeEach(() => {
  selectMock.mockReset();
  logPiiAccessMock.mockClear();
});

const BASE = '/api/siigo/clientes';

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/siigo/validador-cliente.routes.js');
  app.use(BASE, router);
  return app;
}

const auth = async (role: 'admin' | 'auditor' | 'financiera' | 'conductor' = 'admin') =>
  `Bearer ${await testToken({ sub: 7, role })}`;

/** Un cliente al que le falta la dirección: no facturable, así que sale en el informe por defecto. */
const cliente = (over: Record<string, unknown> = {}) => ({
  id: 41, name: 'PEDRO ANTONIO GÓMEZ', document: '79345612', personType: 'Person', idType: '13',
  fiscalResponsibilities: ['R-99-PN'], address: null, countryCode: 'Co', stateCode: '11',
  cityCode: '11001', phoneIndicative: '57', phoneNumber: '3001234567',
  contactFirstName: 'Pedro', contactLastName: 'Gómez', facturacionBloqueos: [], ...over,
});

/** `select()` del servicio: `.from().where().orderBy()` o `.from().where().limit()`. */
function cartera(filas: unknown[]) {
  selectMock.mockReturnValue(chain(filas));
}

/** Lo que el helper recibió en su última llamada. */
const ultimoAcceso = () => logPiiAccessMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;

describe('AGENTS.md §16 — toda lectura de fichas de cliente deja rastro', () => {
  it('el detalle registra recurso, acción, campos y cuántas fichas entregó', async () => {
    cartera([cliente(), cliente({ id: 42, name: 'ACME S.A.S.', document: '900123456' })]);
    const app = await buildApp();

    const r = await request(app).get(`${BASE}/validacion/detalle`).set('Authorization', await auth('auditor'));

    expect(r.status).toBe(200);
    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    expect(ultimoAcceso()).toMatchObject({
      resourceTipo: RECURSO_CLIENTE,
      accion: 'search',
      camposAccedidos: ['name', 'document'],
      // Un listado no apunta a una ficha: apunta a un tramo del padrón.
      resourceId: null,
    });
    expect(ultimoAcceso().motivo).toContain('filas=2');
  });

  it('la ficha puntual registra `read` y el id del cliente en `resource_id`', async () => {
    cartera([cliente()]);
    const app = await buildApp();

    const r = await request(app).get(`${BASE}/41/validacion`).set('Authorization', await auth('financiera'));

    expect(r.status).toBe(200);
    expect(ultimoAcceso()).toMatchObject({
      resourceTipo: RECURSO_CLIENTE,
      accion: 'read',
      camposAccedidos: ['name', 'document'],
      // `pii_access_log.resource_id` es `integer` y `clients.id` también: aquí sí cabe.
      resourceId: 41,
    });
  });

  it('el resumen registra el barrido SIN declarar campos que no entrega', async () => {
    // Devuelve conteos por motivo, ni un nombre ni una identificación. Declarar `document` aquí
    // haría que «¿quién ha leído documentos?» devolviera a todo el que abrió el panel.
    cartera([cliente(), cliente({ id: 42 })]);
    const app = await buildApp();

    const r = await request(app).get(`${BASE}/validacion`).set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    expect(ultimoAcceso()).toMatchObject({
      resourceTipo: RECURSO_CLIENTE,
      accion: 'search',
      camposAccedidos: [],
    });
    expect(ultimoAcceso().motivo).toContain('evaluados=2');
    expect(CAMPOS_PII_RESUMEN).toEqual([]);
    expect(CAMPOS_PII_VEREDICTO).toEqual(['name', 'document']);
  });
});

describe('el rastro no puede convertirse en un segundo almacén de identidades', () => {
  it('ni el motivo ni los campos llevan el nombre o el documento leídos', async () => {
    cartera([cliente()]);
    const app = await buildApp();

    await request(app).get(`${BASE}/validacion/detalle`).set('Authorization', await auth());

    const escrito = JSON.stringify(ultimoAcceso());
    expect(escrito).not.toContain('79345612');
    expect(escrito).not.toContain('PEDRO');
    // Lo que sí lleva son NOMBRES de columna, que es lo que hace consultable el log.
    expect(escrito).toContain('document');
  });

  it('un filtro por identidad NUMÉRICO también va enmascarado — es el caso que se escapó', async () => {
    // El defecto que encontró la re-auditoría: el enmascarado vivía en la rama
    // `typeof valor === 'string'`, y un `?documento=` declarado con `z.coerce.number()` —el patrón
    // que `informeSchema` ya usa dos líneas más arriba para `limit` y `offset`— llega como
    // `number`, se saltaba el enmascarado entero y escribía la cédula literal en la tabla que
    // existe para protegerla. No era el caso rebuscado: era el más probable.
    const req = { headers: {}, ip: '10.0.0.1', user: { sub: 7, role: 'admin' } } as never;
    await registrarAccesoCliente(req, {
      accion: 'search',
      campos: CAMPOS_PII_VEREDICTO,
      filtros: { documento: 1036640908, limit: 500 },
    });

    const motivo = String(ultimoAcceso().motivo);
    expect(motivo).not.toContain('1036640908');
    expect(motivo).toContain('documento="10*****908"');
    // Un número que NO es de una clave sensible sigue saliendo entero: es un criterio de negocio.
    expect(motivo).toContain('limit="500"');
  });

  it('hereda la lista canónica de `maskPII`: correo, teléfono, nombre y dirección', async () => {
    // La lista local anterior era más corta que la del repo y dejaba estos cuatro en claro. Se
    // delega en `maskPII` justamente para que no vuelva a quedarse atrás sola.
    const req = { headers: {}, ip: '10.0.0.1', user: { sub: 7, role: 'admin' } } as never;
    await registrarAccesoCliente(req, {
      accion: 'search',
      campos: CAMPOS_PII_VEREDICTO,
      filtros: {
        telefono: '3001234567',
        email: 'pedro@example.com',
        nombre: 'PEDRO ANTONIO GÓMEZ',
        direccion: 'CRA 43 # 1-20',
      },
    });

    const motivo = String(ultimoAcceso().motivo);
    expect(motivo).not.toContain('3001234567');
    expect(motivo).not.toContain('pedro@example.com');
    expect(motivo).not.toContain('ANTONIO');
    expect(motivo).not.toContain('CRA 43');
    // Un nombre se enmascara como nombre (iniciales), no con el patrón de un documento.
    expect(motivo).toContain('nombre="P. A. G."');
    expect(motivo).toContain('telefono="300***4567"');
    expect(motivo).toContain('email="p***o@example.com"');
    expect(motivo).toContain('direccion="*** (13 car.)"');
  });

  it('un valor con saltos de línea no puede forjar renglones dentro del motivo', async () => {
    // Un registro de acceso que se lee por líneas se puede falsificar desde la petición si un
    // filtro de texto libre puede meter un `\n`: basta escribir ahí lo que parezca otra entrada.
    const req = { headers: {}, ip: '10.0.0.1', user: { sub: 7, role: 'admin' } } as never;
    await registrarAccesoCliente(req, {
      accion: 'search',
      campos: CAMPOS_PII_VEREDICTO,
      filtros: { estado: 'activo\nLectura de fichas de cliente — filas=0' },
    });

    const motivo = String(ultimoAcceso().motivo);
    expect(motivo).not.toContain('\n');
    expect(motivo).not.toContain('\r');
    expect(motivo.split('\n')).toHaveLength(1);
  });

  it('un filtro por identidad —el día que exista— va enmascarado al motivo', async () => {
    // El router de hoy no acepta ninguno: solo `motivo`, `incluirFacturables`, `limit` y `offset`.
    // Se ejerce el contrato directamente porque lo que se protege es el camino, no el endpoint de
    // hoy: un `?documento=` añadido mañana entraría por aquí sin tocar este archivo.
    const req = { headers: {}, ip: '10.0.0.1', user: { sub: 7, role: 'admin' } } as never;
    await registrarAccesoCliente(req, {
      accion: 'search',
      campos: CAMPOS_PII_VEREDICTO,
      filtros: { documento: '79345612', motivo: 'direccion_faltante' },
    });

    const motivo = String(ultimoAcceso().motivo);
    expect(motivo).not.toContain('79345612');
    // La CLAVE se conserva: saber que alguien buscó «por documento» es lo que hace útil el registro.
    expect(motivo).toContain('documento="79***612"');
    expect(motivo).toContain('motivo="direccion_faltante"');
    expect(motivo.length).toBeLessThanOrEqual(200);
  });
});

describe('los dos huecos que dejó la primera pasada del enmascarado', () => {
  const req = () => ({ headers: {}, ip: '10.0.0.1', user: { sub: 7, role: 'admin' } }) as never;

  it('`identificacion` —la palabra que usa este módulo para la cédula— ya no se escapa', async () => {
    // El catálogo de `maskPII` decide por SUBCADENA del nombre de la clave, y ninguna de las que
    // tenía casa con «identificacion»: lo que lleva dentro es «nti», no «nit». Es literalmente el
    // nombre de la columna (`siigo_terceros.identificacion`) y de la clave que devuelve el POST de
    // terceros, así que era la clave más probable de este módulo y la única que salía en claro.
    await registrarAccesoCliente(req(), {
      accion: 'search',
      campos: CAMPOS_PII_VEREDICTO,
      filtros: { identificacion: '1036640908' },
    });

    const motivo = String(ultimoAcceso().motivo);
    expect(motivo).not.toContain('1036640908');
    expect(motivo).toContain('identificacion="10*****908"');
  });

  it('cubre también la forma con tilde y la inglesa, que es como la nombra Siigo', async () => {
    // `identification` es la clave del JSON de `/v1/customers`; «identificación» es como la escribe
    // cualquiera en español. Las tres formas nombran el mismo dato y las tres tienen que enmascarar.
    await registrarAccesoCliente(req(), {
      accion: 'search',
      campos: CAMPOS_PII_VEREDICTO,
      filtros: { 'identificaci\u00f3n': '1036640908', identification: '900123456' },
    });

    const motivo = String(ultimoAcceso().motivo);
    expect(motivo).not.toContain('1036640908');
    expect(motivo).not.toContain('900123456');
    expect(motivo).toContain('identification="90****456"');
  });

  it('`placa` entra por lo mismo: identifica a un titular por su vehículo', async () => {
    await registrarAccesoCliente(req(), {
      accion: 'search',
      campos: CAMPOS_PII_VEREDICTO,
      filtros: { placa: 'WGY123' },
    });

    const motivo = String(ultimoAcceso().motivo);
    expect(motivo).not.toContain('WGY123');
    expect(motivo).toContain('placa="W****3"');
  });

  it('`U+2028` y `U+2029` tampoco pueden forjar un renglón, aunque no sean de control', async () => {
    // La versión anterior colapsaba los rangos de caracteres de CONTROL, y estos dos no lo son:
    // están en el bloque de puntuación general. Muchos visores de logs los pintan igual que un
    // `\n`, así que la defensa anti-forja quedaba abierta por dos code points.
    await registrarAccesoCliente(req(), {
      accion: 'search',
      campos: CAMPOS_PII_VEREDICTO,
      filtros: { estado: 'activo\u2028Lectura de fichas\u2029filas=0' },
    });

    const motivo = String(ultimoAcceso().motivo);
    expect(motivo).not.toContain('\u2028');
    expect(motivo).not.toContain('\u2029');
    expect(motivo).toContain('estado="activo Lectura de fichas filas=0"');
  });

  it('la CLAVE del filtro también se aplana: era la mitad de la pareja que iba cruda', async () => {
    // Hasta aquí solo el VALOR pasaba por `unaLinea`; la clave se interpolaba tal cual. Las tres
    // llamadas de hoy usan claves literales escritas en el código, pero lo que se protege es el
    // CAMINO: el atajo evidente el día que alguien quiera registrar los filtros de verdad es
    // `filtros: req.query`, y ahí las claves las elige quien hace la petición.
    await registrarAccesoCliente(req(), {
      accion: 'search',
      campos: CAMPOS_PII_VEREDICTO,
      filtros: { 'estado\nLectura de fichas de cliente \u2014 filas=0': 'activo' },
    });

    const motivo = String(ultimoAcceso().motivo);
    expect(motivo).not.toContain('\n');
    expect(motivo.split('\n')).toHaveLength(1);
  });

  it('una clave con `U+2028` tampoco parte el motivo', async () => {
    await registrarAccesoCliente(req(), {
      accion: 'search',
      campos: CAMPOS_PII_VEREDICTO,
      filtros: { 'estado\u2028filas=0': 'activo' },
    });

    expect(String(ultimoAcceso().motivo)).not.toContain('\u2028');
  });

  it('aplanar la clave no la enmascara: el criterio se sigue leyendo', async () => {
    // Lo que hace útil el registro es poder responder «alguien buscó POR DOCUMENTO». Si la clave
    // acabara enmascarada, el log diría que hubo una búsqueda y no de qué.
    await registrarAccesoCliente(req(), {
      accion: 'search',
      campos: CAMPOS_PII_VEREDICTO,
      filtros: { documento: '79345612' },
    });

    const motivo = String(ultimoAcceso().motivo);
    expect(motivo).toContain('documento=');
    expect(motivo).toContain('documento="79***612"');
  });
});

/**
 * Parsea `motivo` con la gramática que `siigo.pii.ts` documenta: parejas `clave=valor` separadas
 * por espacios, con el valor entrecomillado cuando viene de un filtro.
 *
 * Existe porque la garantía que hay que comprobar es la del PARSEO, no la de una subcadena: un
 * `toContain` no distingue «el valor contiene un espacio» de «hay una pareja más». Con el formato
 * anterior —valores sin delimitar— este mismo parser encuentra las parejas forjadas, que es lo que
 * hace que estas pruebas caigan si alguien quita las comillas.
 */
function parejas(motivo: string): [string, string][] {
  const re = /([A-Za-z0-9_.-]+)=(?:"((?:[^"\\]|\\.)*)"|([^\s"]*))/g;
  return [...motivo.matchAll(re)]
    .map((m) => [m[1], (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1')] as [string, string]);
}

describe('el separador del motivo: un valor no puede fabricar una pareja', () => {
  const req = () => ({ headers: {}, ip: '10.0.0.1', user: { sub: 7, role: 'admin' } }) as never;

  const registrar = async (acceso: Record<string, unknown>) => {
    await registrarAccesoCliente(req(), {
      accion: 'search', campos: CAMPOS_PII_VEREDICTO, ...acceso,
    } as never);
    return String(ultimoAcceso().motivo);
  };

  it('un espacio corriente ya no parte la pareja en dos', async () => {
    // El hallazgo: cerrar `\n`, los controles y `U+2028/29` protegía al visor que pinta renglones,
    // pero contra quien parsea parejas basta un espacio. `estado=activo filas=0` no necesita ni un
    // carácter raro para colar un conteo que el servidor nunca escribió.
    const motivo = await registrar({ filtros: { estado: 'activo filas=0' } });

    expect(parejas(motivo)).toEqual([['estado', 'activo filas=0']]);
  });

  it('tampoco cerrando la comilla a mano: se escapa', async () => {
    const motivo = await registrar({ filtros: { estado: 'activo" filas=0' } });

    expect(parejas(motivo)).toEqual([['estado', 'activo" filas=0']]);
  });

  it('ni desde la CLAVE, que se reduce a identificador', async () => {
    // La clave es la otra mitad de la pareja y el atajo evidente del día que alguien registre
    // `filtros: req.query` es que la elija quien hace la petición.
    const motivo = await registrar({ filtros: { 'estado filas=0': 'activo' } });

    const claves = parejas(motivo).map(([c]) => c);
    expect(claves).not.toContain('filas');
    expect(claves).toHaveLength(1);
    expect(claves[0]).not.toContain(' ');
  });

  it('un filtro que se llame como un contador se distingue por la forma', async () => {
    // Los contadores que pone el código van SIN comillas y los filtros CON, así que un `?filas=`
    // convive con el conteo real sin poder suplantarlo.
    const motivo = await registrar({ filas: 2, filtros: { filas: 999 } });

    expect(motivo).toContain('filas=2 ');
    expect(motivo).toContain('filas="999"');
  });

  it('el valor sigue llegando entero: el enmascarado de este repo lleva espacios', async () => {
    // Colapsar el separador dentro del valor —la otra forma de cerrarlo— habría partido lo que
    // producen `maskName` y `maskAddress`, que es justo lo que el motivo tiene que poder leer.
    const motivo = await registrar({ filtros: { nombre: 'PEDRO ANTONIO GÓMEZ' } });

    expect(parejas(motivo)).toEqual([['nombre', 'P. A. G.']]);
  });

  it('el saneado no puede dejar la comilla de cierre fuera de sitio al recortar', async () => {
    // `motivo` es `varchar(200)` y el valor se recorta a 40: si se recortara DESPUÉS de escapar,
    // un valor lleno de barras podría partir un escape por la mitad.
    const motivo = await registrar({ filtros: { estado: '\\'.repeat(60) } });

    expect(parejas(motivo)).toHaveLength(1);
    expect(motivo.length).toBeLessThanOrEqual(200);
  });
});

/**
 * La gramática ENTERA de `motivo`, anclada, tal y como la documenta `siigo.pii.ts`: el encabezado y
 * después cero o más parejas `clave=valor` separadas por un espacio, con el valor entrecomillado
 * cuando viene de un filtro y sin comillas cuando es un contador del código.
 *
 * Anclada y no por subcadenas, que es lo que la hace útil aquí: un `toContain` no ve la diferencia
 * entre un motivo bien formado y uno cuya ÚLTIMA pareja quedó cortada por la mitad. Y esa era la
 * observación: el recorte a 200 caracteres se aplicaba sobre la cadena ya ensamblada, así que podía
 * caer dentro de un valor entrecomillado y dejar un número impar de barras al final —un escape
 * partido, con la comilla de cierre en ninguna parte—. No forjaba una pareja nueva ni tocaba los
 * contadores, pero dejaba malformado justo el eslabón que este formato viene a endurecer.
 */
const PAREJA = '[A-Za-z0-9_.-]+=(?:"(?:[^"\\\\]|\\\\.)*"|[^\\s"]+)';
const MOTIVO_BIEN_FORMADO = new RegExp(
  `^Lectura de fichas de cliente(?: — ${PAREJA}(?: ${PAREJA})*)?$`,
);

describe('el motivo se presupuesta por parejas: el corte ya no parte ninguna', () => {
  const req = () => ({ headers: {}, ip: '10.0.0.1', user: { sub: 7, role: 'admin' } }) as never;

  const registrar = async (acceso: Record<string, unknown>) => {
    await registrarAccesoCliente(req(), {
      accion: 'search', campos: CAMPOS_PII_VEREDICTO, ...acceso,
    } as never);
    return String(ultimoAcceso().motivo);
  };

  /** Doce filtros de barras invertidas: cada valor ocupa el máximo y el corte cae dentro de uno. */
  const filtrosDesbordantes = () => Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`f${i}`, '\\'.repeat(60)]),
  );

  it('doce filtros llenos de barras ya no dejan un escape partido al final', async () => {
    // El caso exacto que reprodujo la auditoría: con el recorte sobre la cadena ensamblada, el
    // motivo terminaba en algo como `f11="\\"\\\\` —comilla abierta, barra suelta— y ningún parser
    // estricto podía leer la última pareja. Ahora la pareja que no cabe entera no se escribe.
    const motivo = await registrar({ filas: 500, filtros: filtrosDesbordantes() });

    expect(motivo).toMatch(MOTIVO_BIEN_FORMADO);
    expect(motivo.length).toBeLessThanOrEqual(200);
  });

  it('y ninguna barra queda desemparejada dentro de un valor', async () => {
    // La comprobación directa del hallazgo, sin pasar por la gramática: dentro de las comillas toda
    // barra viaja escapada, así que las barras solo pueden aparecer en número PAR. Un número impar
    // al final es exactamente la firma del escape partido.
    const motivo = await registrar({ filas: 500, filtros: filtrosDesbordantes() });

    const colaDeBarras = /\\+$/.exec(motivo.replace(/"$/, ''));
    expect(colaDeBarras).toBeNull();
    for (const [, valor] of parejas(motivo)) {
      expect(valor).toMatch(/^(?:\\\\)*$|^[^\\]*$|^(?:[^\\]|\\\\)*$/);
    }
  });

  it('los contadores del código sobreviven al desbordamiento: van primero', async () => {
    // La garantía que ya existía y que no se puede perder al cambiar el corte. Se ejercen los tres
    // a la vez con doce filtros detrás: si el presupuesto se gastara en otro orden, el motivo
    // dejaría de decir cuántas fichas se leyeron —que es lo único que no se puede reconstruir—.
    const motivo = await registrar({
      filas: 500, evaluados: 900, clienteId: 41, filtros: filtrosDesbordantes(),
    });

    const claves = parejas(motivo).map(([c]) => c);
    expect(claves.slice(0, 3)).toEqual(['filas', 'evaluados', 'cliente']);
    expect(motivo).toContain('filas=500');
    expect(motivo).toContain('evaluados=900');
    expect(motivo).toContain('cliente=41');
  });

  it('y el motivo DICE cuántas parejas se quedaron fuera', async () => {
    // Un rastro recortado en silencio afirma que se buscó con dos filtros cuando fueron doce. La
    // marca va sin comillas, como los contadores del código, así que un filtro llamado `truncado`
    // saldría como `truncado="…"` y se seguiría distinguiendo.
    const motivo = await registrar({ filas: 500, filtros: filtrosDesbordantes() });

    const cuenta = parejas(motivo).find(([c]) => c === 'truncado');
    expect(cuenta).toBeDefined();
    const escritas = parejas(motivo).filter(([c]) => /^f\d+$/.test(c)).length;
    // Doce filtros: los que se escribieron más los que la marca declara son los doce.
    expect(Number(cuenta![1]) + escritas).toBe(12);
  });

  it('un motivo que cabe entero no lleva marca de truncado', async () => {
    // La marca tiene que significar algo. Si apareciera siempre, dejaría de informar.
    const motivo = await registrar({ filas: 2, filtros: { pais: 'Co', estado: 'activo' } });

    expect(motivo).toMatch(MOTIVO_BIEN_FORMADO);
    expect(motivo).not.toContain('truncado');
    expect(parejas(motivo).map(([c]) => c)).toEqual(['filas', 'pais', 'estado']);
  });

  it('el corte del VALOR tampoco parte un carácter en dos', async () => {
    // El otro corte del archivo, el de 40 caracteres por valor: `slice` cuenta unidades UTF-16, así
    // que 39 caracteres y un emoji dejaban suelta la mitad alta de un par sustituto. No forja nada
    // —no cierra la comilla— pero es un carácter que no existe: UTF-8 no lo puede codificar y el
    // driver lo escribiría como `U+FFFD` dentro de un motivo que se quiere legible.
    const motivo = await registrar({ filtros: { estado: `${'a'.repeat(39)}\u{1F600}b` } });

    expect(motivo).toMatch(MOTIVO_BIEN_FORMADO);
    // Ni media pareja sustituta alta sin su baja, ni al revés.
    expect(motivo).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(motivo).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('nunca se pasa de `varchar(200)`, que es lo que el recorte protegía', async () => {
    // El presupuesto sustituye al recorte: si se hubiera quitado el corte sin ponerlo, esto sería
    // un 22001 en producción y no un rastro.
    const motivo = await registrar({
      filas: 500, evaluados: 900, clienteId: 41, filtros: filtrosDesbordantes(),
    });

    expect(motivo.length).toBeLessThanOrEqual(200);
  });
});

describe('la ubicación del titular también se enmascara', () => {
  const req = () => ({ headers: {}, ip: '10.0.0.1', user: { sub: 7, role: 'admin' } }) as never;

  it('`ciudad` y `city` ya no salen en claro al motivo', async () => {
    // El mismo ciclo declaró `city` como dato personal en `CAMPOS_PII_PROPUESTA_CIUDAD` citando
    // AGENTS.md §14, y el catálogo de `maskPII` era el único sitio donde seguía tratándose como si
    // no lo fuera. Es prevención, igual que `placa` e `identificaci`: es la clave que nombra la
    // columna que dos rutas de este módulo entregan.
    await registrarAccesoCliente(req(), {
      accion: 'search',
      campos: CAMPOS_PII_VEREDICTO,
      filtros: { ciudad: 'MEDELLIN', city: 'CHIA' },
    });

    const motivo = String(ultimoAcceso().motivo);
    expect(motivo).not.toContain('MEDELLIN');
    expect(motivo).not.toContain('CHIA');
    // Queda la constancia de que el campo venía y cuánto ocupaba, que es lo que un log necesita.
    expect(motivo).toContain('ciudad="*** (8 car.)"');
    expect(motivo).toContain('city="*** (4 car.)"');
  });
});

describe('lo que NO se registra', () => {
  it('un cliente que no existe (404) no deja registro de acceso', async () => {
    cartera([]);
    const app = await buildApp();

    const r = await request(app).get(`${BASE}/999/validacion`).set('Authorization', await auth());

    expect(r.status).toBe(404);
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });

  it('un rol sin lectura (403) no deja registro de acceso', async () => {
    const app = await buildApp();

    const r = await request(app).get(`${BASE}/validacion/detalle`).set('Authorization', await auth('conductor'));

    expect(r.status).toBe(403);
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });
});

describe('la auditoría no cambia lo que las rutas devuelven', () => {
  it('el veredicto sigue saliendo con `nombre` y `documento` en claro', async () => {
    // El tipo lo dice desde esta HU sin rodeos: no hay enmascarado en ninguna capa. Si algún día lo
    // hay, será una decisión de producto y esta prueba tendrá que cambiar a propósito, no de rebote.
    cartera([cliente()]);
    const app = await buildApp();

    const r = await request(app).get(`${BASE}/41/validacion`).set('Authorization', await auth());

    expect(r.body).toMatchObject({
      clienteId: 41, nombre: 'PEDRO ANTONIO GÓMEZ', documento: '79345612', facturable: false,
    });
  });

  it('el detalle conserva `data` y `total`', async () => {
    cartera([cliente(), cliente({ id: 42 })]);
    const app = await buildApp();

    const r = await request(app).get(`${BASE}/validacion/detalle`).set('Authorization', await auth());

    expect(r.body.total).toBe(2);
    expect(r.body.data).toHaveLength(2);
  });
});
