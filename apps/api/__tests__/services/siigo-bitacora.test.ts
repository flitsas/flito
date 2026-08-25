// HU #11251 — bitácora inalterable de las operaciones contra Siigo (Feature #11239).
//
// La inmutabilidad la garantizan disparadores en Postgres, así que AC2 se verifica contra la base
// real en el PR (ver descripción) y aquí se cubre lo que sí es lógica de aplicación: qué se escribe,
// qué NUNCA se escribe, cómo se consulta y qué pasa si la escritura falla.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain, chainReject } from '../helpers/db.js';

const insertMock = vi.fn();
const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { insert: insertMock, select: selectMock, update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const { registrarOperacion, consultarBitacora, sanearCuerpo, contarPorResultado, marcaDeOperacion } =
  await import('../../src/modules/siigo/siigo.operaciones.repo.js');
const { sanearMensaje, redactarPIIEnTextoLibre, MARCA_SQL_OMITIDO } =
  await import('../../src/modules/siigo/siigo.redaccion.js');

/** Captura los valores del INSERT. */
function espiarInsert() {
  const espia = vi.fn();
  insertMock.mockReturnValue({
    values: (v: Record<string, unknown>) => { espia(v); return Promise.resolve([]); },
  });
  return espia;
}

beforeEach(() => { insertMock.mockReset(); selectMock.mockReset(); });

describe('AC1 — toda operación deja rastro', () => {
  it('registra los campos que permiten reconstruir qué pasó', async () => {
    const espia = espiarInsert();

    await registrarOperacion({
      operacion: 'crear_factura',
      metodo: 'POST',
      ruta: '/v1/invoices',
      entidadTipo: 'tramite',
      entidadId: 'abc-123',
      intento: 2,
      ambiente: 'pruebas',
      modo: 'real',
      requestBody: { date: '2026-08-04' },
      responseBody: { id: 'inv-1' },
      statusHttp: 201,
      resultado: 'ok',
      duracionMs: 842,
      createdBy: 7,
    });

    expect(espia).toHaveBeenCalledTimes(1);
    expect(espia.mock.calls[0]![0]).toMatchObject({
      operacion: 'crear_factura', metodo: 'POST', ruta: '/v1/invoices',
      entidadTipo: 'tramite', entidadId: 'abc-123', intento: 2,
      ambiente: 'pruebas', modo: 'real', statusHttp: 201,
      resultado: 'ok', duracionMs: 842, createdBy: 7,
    });
  });

  it('los campos opcionales quedan en null, no en undefined', async () => {
    const espia = espiarInsert();
    await registrarOperacion({ operacion: 'auth', ambiente: 'pruebas', resultado: 'ok' });

    const fila = espia.mock.calls[0]![0] as Record<string, unknown>;
    expect(fila.metodo).toBeNull();
    expect(fila.entidadId).toBeNull();
    expect(fila.requestBody).toBeNull();
    expect(fila.duracionMs).toBeNull();
  });

  it('el intento y el modo tienen valores por defecto sensatos', async () => {
    const espia = espiarInsert();
    await registrarOperacion({ operacion: 'auth', ambiente: 'pruebas', resultado: 'ok' });

    expect(espia.mock.calls[0]![0]).toMatchObject({ intento: 1, modo: 'real' });
  });

  it('también registra los fallos, no solo los éxitos', async () => {
    const espia = espiarInsert();
    await registrarOperacion({
      operacion: 'crear_factura', ambiente: 'produccion',
      resultado: 'error_negocio', codigo: 'parameter_required',
      mensaje: 'Falta un parámetro obligatorio', statusHttp: 400,
    });

    expect(espia.mock.calls[0]![0]).toMatchObject({
      resultado: 'error_negocio', codigo: 'parameter_required', statusHttp: 400,
    });
  });
});

describe('AC3 — la bitácora no guarda secretos', () => {
  it('el access_key del cuerpo de autenticación se sustituye', async () => {
    const espia = espiarInsert();
    await registrarOperacion({
      operacion: 'auth', ambiente: 'pruebas', resultado: 'ok',
      requestBody: { username: 'usuario@flitsas.com', access_key: 'SECRETO-REAL' },
    });

    const fila = espia.mock.calls[0]![0] as Record<string, unknown>;
    expect(JSON.stringify(fila)).not.toContain('SECRETO-REAL');
    expect((fila.requestBody as Record<string, unknown>).access_key).toBe('[REDACTED]');
    // El resto sí se conserva: sin username no se puede diagnosticar nada.
    expect((fila.requestBody as Record<string, unknown>).username).toBe('usuario@flitsas.com');
  });

  it.each(['Authorization', 'authorization', 'AUTHORIZATION', 'Access_Key', 'token'])(
    'la clave %s se redacta sin importar cómo esté escrita', (clave) => {
      const saneado = sanearCuerpo({ [clave]: 'valor-secreto' }) as Record<string, unknown>;
      expect(saneado[clave]).toBe('[REDACTED]');
    },
  );

  it('sanea también en objetos anidados', () => {
    const saneado = sanearCuerpo({
      headers: { Authorization: 'Bearer tok-123' },
      datos: { cliente: { access_key: 'x' }, nombre: 'ACME' },
    }) as Record<string, Record<string, unknown>>;

    expect(JSON.stringify(saneado)).not.toContain('tok-123');
    expect(saneado.headers.Authorization).toBe('[REDACTED]');
    expect((saneado.datos.cliente as Record<string, unknown>).access_key).toBe('[REDACTED]');
    expect(saneado.datos.nombre).toBe('ACME');
  });

  it('sanea dentro de arreglos', () => {
    const saneado = sanearCuerpo({ items: [{ token: 'a' }, { token: 'b' }] }) as Record<string, unknown[]>;
    expect(JSON.stringify(saneado)).not.toMatch(/"a"|"b"/);
  });

  it('no muta el objeto original', () => {
    const original = { access_key: 'SECRETO' };
    sanearCuerpo(original);
    expect(original.access_key).toBe('SECRETO');
  });

  it('una estructura circular no cuelga el saneamiento', () => {
    const circular: Record<string, unknown> = { nombre: 'x' };
    circular.self = circular;
    expect(() => sanearCuerpo(circular)).not.toThrow();
  });

  it('los valores primitivos pasan tal cual', () => {
    expect(sanearCuerpo('texto')).toBe('texto');
    expect(sanearCuerpo(42)).toBe(42);
    expect(sanearCuerpo(null)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Hallazgo Medium de la auditoría (HU #11281). El saneamiento cubría `requestBody` y
// `responseBody`; `mensaje` se insertaba TAL CUAL. Desde `drizzle-orm` 0.45, cualquier error del
// driver llega envuelto en un `DrizzleQueryError` cuyo `message` es `Failed query: <SQL>\nparams:
// <valores>` — la sentencia y todos sus valores enlazados, incluidos los nombres de los vendedores.
//
// La causa concreta ya está tapada en el servicio de catálogos (el fallo de persistencia es un
// error de dominio con mensaje fijo). Esto es la red de seguridad: la bitácora es WORM real, un
// disparador prohíbe UPDATE y DELETE, y lo que se escriba ahí por error ya no se puede rectificar
// ni suprimir (Ley 1581, art. 8). El filtro va aquí para que ningún flujo futuro pueda reabrir la
// vía sin darse cuenta.
describe('la redacción alcanza también al mensaje', () => {
  /** Reproducción literal del `message` que construye drizzle ≥ 0.45. */
  const MENSAJE_CON_VOLCADO = 'Failed query: insert into "siigo_catalogos" ("ambiente", "tipo", '
    + '"codigo", "nombre") values ($1, $2, $3, $4) on conflict ("ambiente","tipo","codigo") '
    + 'do update set "nombre" = excluded.nombre'
    + '\nparams: pruebas,user,35071,Ana Ramírez';

  it('la sentencia y sus parámetros no llegan a la fila', async () => {
    const espia = espiarInsert();

    await registrarOperacion({
      operacion: 'sync_catalogo', ambiente: 'pruebas', resultado: 'error_tecnico',
      mensaje: MENSAJE_CON_VOLCADO,
    });

    const fila = espia.mock.calls[0]![0] as Record<string, unknown>;
    const escrito = JSON.stringify(fila);
    expect(escrito).not.toContain('Failed query');
    expect(escrito).not.toContain('insert into');
    expect(escrito).not.toContain('siigo_catalogos');
    expect(escrito).not.toContain('Ana Ramírez');
    expect(fila.mensaje).toBe(MARCA_SQL_OMITIDO);
  });

  it('conserva la explicación que iba delante del volcado', () => {
    const saneado = sanearMensaje(`No se pudo guardar el catálogo. ${MENSAJE_CON_VOLCADO}`);

    // Lo que sirve para operar se queda; lo que solo sirve para filtrar, no.
    expect(saneado).toContain('No se pudo guardar el catálogo.');
    expect(saneado).toContain(MARCA_SQL_OMITIDO);
    expect(saneado).not.toContain('Ana Ramírez');
  });

  it.each([
    ['un SELECT compilado', 'algo falló: select "id" from "siigo_catalogos" where "tipo" = $1'],
    ['un UPDATE compilado', 'algo falló: update "siigo_catalogos" set "activo" = $1'],
    ['un DELETE compilado', 'algo falló: delete from "siigo_operaciones" where "id" = $1'],
    ['la línea de parámetros suelta', 'error\nparams: 35071,Ana Ramírez'],
  ])('%s tampoco entra', (_caso, mensaje) => {
    const saneado = sanearMensaje(mensaje);
    expect(saneado).toContain(MARCA_SQL_OMITIDO);
    expect(saneado).not.toMatch(/siigo_catalogos|siigo_operaciones|Ana Ramírez/);
  });

  it('un mensaje operativo normal no se toca', () => {
    const mensaje = 'Catálogo "tax": 12 elementos, 1 inactivados.';
    expect(sanearMensaje(mensaje)).toBe(mensaje);
  });

  // HU #11326 — la búsqueda de la reconciliación lleva la identificación del titular en la cadena de
  // consulta, y un error que mencione la ruta la arrastra hasta aquí. `customer_identification` es
  // un NIT casi siempre y una CÉDULA cuando el cliente es persona natural; una vez escrita en una
  // tabla que prohíbe UPDATE y DELETE, los derechos de rectificación y supresión del art. 8 de la
  // Ley 1581 ya no se pueden ejercer sobre ella.
  it('recorta el valor de los filtros de URL que pueden llevar datos del titular', () => {
    const mensaje = 'Siigo rechazó GET /v1/invoices?customer_identification=1036640908&page=1 con 401.';
    const saneado = sanearMensaje(mensaje);

    expect(saneado).not.toContain('1036640908');
    // El NOMBRE del filtro se conserva: sirve para entender qué se estaba buscando.
    expect(saneado).toContain('customer_identification=');
    // Y lo que no es dato del titular sigue ahí.
    expect(saneado).toContain('page=1');
  });

  it('el recorte de filtros no se come un texto que solo los mencione', () => {
    const mensaje = 'Falta configurar el filtro customer_identification en la integración.';
    expect(sanearMensaje(mensaje)).toBe(mensaje);
  });

  it('las palabras sueltas en español no disparan el recorte', () => {
    // El corte exige un identificador entrecomillado, que es como compila drizzle. Sin eso, un
    // texto operativo que mencione «actualizar» o «seleccionar» quedaría mutilado sin motivo.
    const mensaje = 'Se intentó actualizar la selección de formas de pago y no se pudo.';
    expect(sanearMensaje(mensaje)).toBe(mensaje);
  });

  it('acota la longitud: una fila inmutable no puede crecer sin límite', () => {
    const largo = `Siigo respondió con un cuerpo enorme: ${'x'.repeat(5000)}`;
    const saneado = sanearMensaje(largo);
    expect(saneado.length).toBeLessThanOrEqual(1001);
    expect(saneado.endsWith('…')).toBe(true);
  });

  it('un mensaje ausente sigue siendo null en la fila', async () => {
    const espia = espiarInsert();
    await registrarOperacion({ operacion: 'auth', ambiente: 'pruebas', resultado: 'ok' });
    expect((espia.mock.calls[0]![0] as Record<string, unknown>).mensaje).toBeNull();
  });
});

// ── Lo que escribe una PERSONA (HU #11340) ─────────────────────────────────────────────────────
//
// `sanearMensaje` entiende volcados de SQL y parejas `clave=valor`: lo que escribe una MÁQUINA. La
// nota de un descarte la escribe una persona, y ahí no hay ninguna marca que cortar. `maskPII` del
// catálogo canónico tampoco sirve tal cual —decide por el NOMBRE DE LA CLAVE, y un texto libre no
// tiene claves—, así que lo que falta es la DETECCIÓN; el enmascarado se delega en las mismas
// funciones canónicas para no abrir un segundo criterio.
describe('redactarPIIEnTextoLibre — la PII que teclea una persona', () => {
  it.each([
    ['una cédula', 'lo autorizó la cédula 79123456', '79123456'],
    ['una cédula con puntos', 'la cédula 1.036.640.908 no coincide', '1.036.640.908'],
    ['un NIT con dígito de verificación', 'el NIT 900.123.456-7 está mal', '900.123.456-7'],
    ['un teléfono', 'llamar al 3003427829', '3003427829'],
    ['un correo', 'escribió ana.hincapie@yahoo.es', 'ana.hincapie@yahoo.es'],
    ['una placa', 'el vehículo WGY45D del titular', 'WGY45D'],
    ['un nombre y apellido', 'lo pidió Ana Ramírez por teléfono', 'Ana Ramírez'],
    ['un nombre compuesto', 'firmó Juan de la Cruz Pérez', 'Juan de la Cruz Pérez'],
    ['una placa en minúsculas', 'placa abc123 del titular', 'abc123'],
  ])('%s no sale entera', (_caso, texto, dato) => {
    expect(redactarPIIEnTextoLibre(texto)).not.toContain(dato);
  });

  // `not.toContain` dice que el dato ya no está, no que lo que quedó sirva para operar. Esto ancla
  // la salida exacta, y de paso que el enmascarado es el canónico del repositorio (`maskName`) y no
  // un segundo criterio que pueda divergir.
  it('el nombre conocido sale como iniciales, igual que en el catálogo canónico', () => {
    expect(redactarPIIEnTextoLibre(
      'ANALEANDRA HINCAPIE OSPINA pidió la corrección', ['ANALEANDRA HINCAPIE OSPINA'],
    )).toBe('A. H. O. pidió la corrección');
  });

  it.each([
    ['una fecha', 'la resolución venció el 30-06-2026'],
    ['un importe con marca', 'se cobró por fuera $1.250.000'],
    ['un conteo y un código HTTP', 'van 5 intentos y Siigo devolvió 429'],
    ['una sigla del dominio', 'la DIAN rechazó el CUFE por duplicado'],
    ['dos términos del dominio seguidos', 'hay que hacer una Nota Crédito en Siigo Nube'],
    // ── El contrapeso de admitir mayúsculas ───────────────────────────────────────────────────
    // Tapar de más tiene un precio real: una nota ilegible es una nota que nadie escribe, y la
    // gente se lleva la explicación a otro sitio peor. Estos cuatro son el texto operativo que
    // convive con los nombres y que la corrección podía arrastrar sin que nadie lo notara.
    ['dos siglas del dominio seguidas', 'revisar en SIIGO NUBE el documento'],
    ['una sigla pegada a un término del dominio', 'la NOTA CREDITO de la DIAN no cuadra'],
    ['la misma frase con los nexos en mayúsculas', 'la NOTA CREDITO DE LA DIAN no cuadra'],
    ['un código de regla con dígitos pegados', 'Regla FAJ26 incumplida en la emisión'],
    ['un código de error en mayúsculas con guion bajo', 'salió INVALID_DIAN_RESOLUTION otra vez'],
    // Los dos textos del catálogo de errores que la corrección de las mayúsculas llegó a mutilar.
    ['un estado de la cuenta en altas', 'la cuenta quedó en modo SOLO LECTURA y no deja emitir'],
    ['una descripción del catálogo', 'Una URL enviada no es válida.'],
  ])('%s se queda tal cual: taparlo dejaría la nota sin lo que la hace útil', (_caso, texto) => {
    expect(redactarPIIEnTextoLibre(texto)).toBe(texto);
  });

  // ── La prosa operativa en MAYÚSCULAS ──────────────────────────────────────────────────────
  //
  // Escribir la nota en altas es un hábito extendido en operación, no una rareza. La heurística no
  // mira las mayúsculas justamente por esto: mientras las miró, estas notas salían convertidas en
  // iniciales hacia una tabla que no admite UPDATE ni DELETE, y una explicación mutilada ahí se
  // pierde para siempre —que es lo que el AC5 existe para conservar—.
  //
  // Las dos primeras son los casos que tumbaron la versión con umbrales: `CLIENTE PIDIO ANULAR` cae
  // por debajo del suelo de letras que se probó, y la mixta baja de la fracción de altas por una
  // sola palabra en minúsculas al final. Ninguna de las dos es rara, y por eso no hay umbral.
  it.each([
    ['una nota corta', 'CLIENTE PIDIO ANULAR'],
    ['una nota mixta', 'SE REINTENTO TRES VECES Y SIGUE FALLANDO pendiente'],
    ['un parte de reintentos', 'SE REINTENTO TRES VECES Y SIGUE FALLANDO, PASAR A SOPORTE'],
    ['una espera', 'PENDIENTE RESPUESTA DE LA DIAN, NO REINTENTAR TODAVIA'],
    ['un descarte razonado', 'NO APLICA REINTENTO, FACTURA YA EMITIDA EN OTRO LOTE'],
    ['un aviso de estado', 'FACTURA YA EMITIDA'],
    ['un traspaso', 'PASAR A SOPORTE'],
  ])('%s en mayúsculas se queda tal cual: la heurística no mira las altas', (_c, texto) => {
    expect(redactarPIIEnTextoLibre(texto)).toBe(texto);
  });

  // El apagado de la heurística sería una fuga si la heurística fuera lo único que hay. No lo es:
  // el nombre del cliente del caso se tapa por COINCIDENCIA, que no depende de la caja. Esta prueba
  // es la que sostiene que relajar la heurística no reabre el hallazgo que la trajo.
  it('en esa misma nota en altas, la razón social conocida SÍ se tapa, y el resto no se toca', () => {
    const CLIENTE = 'TRANSPORTES LA SABANA SAS';
    const salida = redactarPIIEnTextoLibre(
      `NOTA: CONFIRMADO POR ${CLIENTE}, NO REINTENTAR MAS`, [CLIENTE],
    );

    expect(salida).not.toContain(CLIENTE);
    expect(salida).toBe('NOTA: CONFIRMADO POR T. L. S. S., NO REINTENTAR MAS');
  });

  it('la coincidencia no depende de la caja ni de los espacios de más', () => {
    const salida = redactarPIIEnTextoLibre(
      'lo confirmó transportes  la   sabana sas por teléfono', ['TRANSPORTES LA SABANA SAS'],
    );
    expect(salida).not.toContain('sabana');
    expect(salida).toContain('T. L. S. S.');
  });

  // ── EL HUECO ACEPTADO ─────────────────────────────────────────────────────────────────────
  //
  // Un nombre TECLEADO de memoria en mayúsculas no lo ve nadie: no hay dato con el que cotejarlo y,
  // por forma, es indistinguible de la prosa operativa de arriba. **Es una decisión tomada, no un
  // olvido**: David la aceptó explícitamente cuando el gate la declaró asumible, y el precio de la
  // alternativa era mutilar 12 de 16 notas operativas cortas de forma irreversible. Esta prueba
  // existe para que quede visible, y para que quien la vea roja sepa que está cambiando la decisión
  // y no arreglando un descuido.
  it('un nombre en MAYÚSCULAS que NO es el del caso pasa entero: el hueco está aceptado', () => {
    const texto = 'SE CONFIRMO CON MARIA GOMEZ DE CONTABILIDAD, NO REINTENTAR';
    expect(redactarPIIEnTextoLibre(texto)).toBe(texto);
  });

  // Y el contrapeso que hace asumible ese hueco: en cuanto ese mismo nombre ES el del caso —el
  // flujo que motivó el hallazgo, copiar de la fila—, deja de pasar, venga como venga escrito.
  it('ese mismo nombre, si es el del caso, SÍ se tapa: la coincidencia no depende de la caja', () => {
    expect(redactarPIIEnTextoLibre(
      'SE CONFIRMO CON MARIA GOMEZ DE CONTABILIDAD, NO REINTENTAR', ['Maria Gomez'],
    )).toBe('SE CONFIRMO CON M. G. DE CONTABILIDAD, NO REINTENTAR');
  });

  // El límite de palabra del cotejo: una razón social corta no puede mutar subcadenas.
  it('un nombre conocido corto no parte otra palabra que lo contenga', () => {
    expect(redactarPIIEnTextoLibre('quedó en CLAUSURA definitiva', ['SURA']))
      .toBe('quedó en CLAUSURA definitiva');
    expect(redactarPIIEnTextoLibre('lo pidió SURA por escrito', ['SURA']))
      .toBe('lo pidió S. por escrito');
  });

  // Lo que esta heurística NO ve, escrito para que nadie lo dé por cubierto: un detector de nombres
  // sobre prosa española no existe. Por eso el catálogo cerrado de motivos sigue siendo la defensa
  // principal, y esto la segunda línea.
  it('un nombre de pila suelto en minúsculas pasa: el hueco está declarado, no negado', () => {
    expect(redactarPIIEnTextoLibre('lo pidió juan')).toBe('lo pidió juan');
  });

  it('cuando duda, tapa: dos palabras capitalizadas desconocidas se tratan como un nombre', () => {
    // El precio del error es un término del dominio ilegible; el del error contrario, una cédula en
    // una fila que nadie puede borrar.
    expect(redactarPIIEnTextoLibre('revisar en Portal Terceros')).toBe('revisar en P. T.');
  });
});

describe('AC4 — consulta para auditoría', () => {
  it('consulta por entidad', async () => {
    selectMock.mockReturnValue(chain([{ id: 1 }]));
    const filas = await consultarBitacora({ entidadTipo: 'tramite', entidadId: 'abc' });
    expect(filas).toHaveLength(1);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('consulta por rango de fechas', async () => {
    selectMock.mockReturnValue(chain([{ id: 1 }, { id: 2 }]));
    const filas = await consultarBitacora({
      desde: new Date('2026-08-01'), hasta: new Date('2026-08-31'),
    });
    expect(filas).toHaveLength(2);
  });

  it('sin filtros también funciona', async () => {
    selectMock.mockReturnValue(chain([]));
    await expect(consultarBitacora()).resolves.toEqual([]);
  });

  it('permite filtrar solo los fallos', async () => {
    selectMock.mockReturnValue(chain([{ id: 3, resultado: 'error_negocio' }]));
    const filas = await consultarBitacora({ resultado: 'error_negocio' });
    expect(filas[0]).toMatchObject({ resultado: 'error_negocio' });
  });
});

describe('AC5 — un fallo al registrar no tumba la operación', () => {
  it('un error de base de datos no se propaga', async () => {
    insertMock.mockReturnValue({ values: () => chainReject(new Error('BD caída')) });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // La factura ya se emitió: que la bitácora falle no puede deshacerla.
    await expect(registrarOperacion({
      operacion: 'crear_factura', ambiente: 'pruebas', resultado: 'ok',
    })).resolves.toBeUndefined();

    errSpy.mockRestore();
  });

  it('el fallo queda reportado en el registro de la aplicación', async () => {
    insertMock.mockReturnValue({ values: () => chainReject(new Error('BD caída')) });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await registrarOperacion({ operacion: 'crear_factura', ambiente: 'pruebas', resultado: 'ok' });

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]![0]).toMatch(/no se pudo registrar la operación/);
    errSpy.mockRestore();
  });

  it('una excepción síncrona tampoco escapa', async () => {
    insertMock.mockImplementation(() => { throw new Error('cliente sin inicializar'); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(registrarOperacion({
      operacion: 'auth', ambiente: 'pruebas', resultado: 'ok',
    })).resolves.toBeUndefined();

    errSpy.mockRestore();
  });
});

// Agregados de solo lectura sobre la misma tabla (HU #11341). Son la única fuente del freno por
// proporción de errores: sin ellos habría que llevar un contador aparte, y un contador aparte se
// desincroniza de la bitácora en el primer reinicio.
describe('agregados para el freno por proporción de errores', () => {
  it('los conteos llegan como número, no como la cadena que devuelve el driver', async () => {
    // `count(*)` viaja como texto cuando desborda un int32, y una proporción sobre cadenas da NaN
    // —es decir, un freno que nunca se dispara sin que nadie se entere—.
    selectMock.mockReturnValue(chain([
      { resultado: 'ok', total: '120' }, { resultado: 'error_tecnico', total: '15' },
    ]));

    const conteos = await contarPorResultado({
      ambiente: 'pruebas', modo: 'real', desde: new Date('2026-08-09T12:00:00Z'),
    });

    expect(conteos).toEqual([
      { resultado: 'ok', total: 120 }, { resultado: 'error_tecnico', total: 15 },
    ]);
  });

  it('una ventana sin operaciones devuelve una lista vacía, no un error', async () => {
    selectMock.mockReturnValue(chain([]));
    await expect(contarPorResultado({
      ambiente: 'pruebas', modo: 'real', desde: new Date(), excluir: ['freno_integracion'],
    })).resolves.toEqual([]);
  });

  it('sin ninguna reactivación registrada la marca es null', async () => {
    selectMock.mockReturnValue(chain([]));
    await expect(marcaDeOperacion({
      operacion: 'freno_reactivado', ambiente: 'pruebas', modo: 'real', orden: 'ultima',
    })).resolves.toBeNull();
  });

  it('la marca trae cuándo y quién, que es lo que exige el registro de la reactivación', async () => {
    const cuando = new Date('2026-08-10T11:30:00Z');
    selectMock.mockReturnValue(chain([{ createdAt: cuando, createdBy: 42 }]));

    await expect(marcaDeOperacion({
      operacion: 'freno_reactivado', ambiente: 'pruebas', modo: 'real', orden: 'ultima',
    })).resolves.toEqual({ createdAt: cuando, createdBy: 42 });
  });
});

describe('el módulo no ofrece forma de alterar la bitácora', () => {
  it('solo exporta inserción, consulta y saneamiento', async () => {
    const modulo = await import('../../src/modules/siigo/siigo.operaciones.repo.js');
    const exportados = Object.keys(modulo).sort();

    // `contarPorResultado` y `marcaDeOperacion` se sumaron en la HU #11341 y son de SOLO LECTURA:
    // el freno por proporción de errores se calcula sobre esta misma tabla, sin contador paralelo.
    expect(exportados).toEqual([
      'consultarBitacora', 'contarPorResultado', 'marcaDeOperacion', 'registrarOperacion',
      'sanearCuerpo',
    ]);
    // Ni actualizar ni borrar: la base los prohíbe, y ofrecerlos aquí solo daría un error peor.
    // La comprobación es por forma y no por nombre concreto, para que ningún verbo de escritura
    // futuro entre por una variante que la lista literal no anticipó.
    expect(exportados.filter((n) => /actualizar|borrar|eliminar|modificar|purgar/i.test(n)))
      .toEqual([]);
  });
});
