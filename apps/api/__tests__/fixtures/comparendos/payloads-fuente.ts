// FLITO comparendos — payloads de las dos fuentes (Feature #11492 17a, HU #11501 AC1).
//
// **Esto NO son capturas crudas.** La FORMA es la de las respuestas reales del 2026-08-20
// —envoltura, anidamiento y, sobre todo, los arrays hermanos VACÍOS que conviven con el que sí trae
// los datos, que es justo la trampa que arreglan las `RUTAS_LISTA` de los adapters y el mapa v2—.
// Los VALORES son FABRICADOS: número de comparendo, placa, NIT del infractor, dirección y organismo
// se inventaron conservando longitud y formato, que es de lo único que dependen las aserciones.
//
// Por eso esto se puede versionar. Si algún día hace falta contrastar contra una captura de verdad,
// se mira fuera del repo y no se pega aquí: lo que entra a git no sale sin reescribir historia.

/** Literales que las aserciones nombran. Viven aquí para que no se dupliquen en cada test. */
export const FABRICADO = {
  placaSimit: 'QWE321',
  documentoInfractor: '800111222',
  organismoSimit: 'Villademo',
  numeroMunicipal: 'D99999000000099999901',
  placaMunicipal: 'ZYX654',
  nitMunicipal: '800999888',
  direccionMunicipal: 'Calle 99 con Carrera 88 Sur - COMUNA 99',
  organismoMunicipal: 'STRIA DE TTOyTTE VILLADEMO',
} as const;

/**
 * El cuerpo TAL Y COMO lo manda el UTS municipal: el JSON serializado DOS veces (Bug #11711).
 *
 * Se genera con `JSON.stringify(JSON.stringify(...))` y no se pega una cadena escapada a mano, para
 * que la fixture no pueda desincronizarse de `payloadUts()` y para que se lea lo que representa.
 *
 * La forma está medida contra el proveedor el 2026-08-21 en los 5 municipios consultados (BELLO,
 * MEDELLIN, ITAGUI, ENVIGADO y SABANETA): `HTTP 200`, `application/json; charset=utf-8`,
 * `Content-Length` presente, `Transfer-Encoding` ausente, y el primer byte del cuerpo una comilla
 * doble. `JSON.parse` NO lanza ahí —devuelve un string— y ahí empezaba el silencio del bug.
 */
export function cuerpoDobleEncodeado(objeto: unknown): string {
  return JSON.stringify(JSON.stringify(objeto));
}

/** Número de comparendo de SIMIT: 20 dígitos, como el del proveedor. */
export function numeroSimit(i = 0): string {
  return `9999900000001234567${i}`;
}

/**
 * Un ítem de `data.multas[]`.
 *
 * Trae tres cosas a propósito: `comparendo` como BOOLEANO (el candidato que la v1 usaba de número y
 * que habría sombreado a los demás), `fechaComparendo` CON HORA junto a una `fechaNotificacion` con
 * el centinela `01/01/1900`, y el subobjeto `infractor` —PII de un tercero— que la poda debe tirar.
 */
export function itemSimit(i = 0): Record<string, unknown> {
  return {
    numeroComparendo: numeroSimit(i),
    comparendo: true,
    comparendoElectronico: true,
    placa: FABRICADO.placaSimit,
    fechaComparendo: '11/05/2026 14:20:00',
    fechaNotificacion: '01/01/1900 00:00:00',
    organismoTransito: FABRICADO.organismoSimit,
    estadoComparendo: 'Pendiente',
    infracciones: [{
      codigoInfraccion: 'D02',
      descripcionInfraccion: 'Conducir sin portar el SOAT',
      valorInfraccion: '1266222',
    }],
    infractor: {
      nombre: 'D** DEMO**** S* A* ', numeroDocumento: FABRICADO.documentoInfractor,
      tipoDocumento: 'Nit', apellido: null,
    },
    valorPagar: '1308422',
  };
}

/**
 * Respuesta COMPLETA de Verifik SIMIT: `data` es un OBJETO (no un array) y `comparendos` llega
 * VACÍO al lado de `multas`, que es donde están los comparendos vivos.
 */
export function payloadSimit(multas = 5): Record<string, unknown> {
  return {
    data: {
      comparendos: [],
      multas: Array.from({ length: multas }, (_, i) => itemSimit(i)),
      cursos: [],
      pazSalvo: null,
      totalMultas: multas,
    },
    signature: 'firma-fabricada',
    id: 'id-fabricado',
  };
}

/**
 * Un ítem de `informacionComparendo[]`.
 *
 * El organismo NO está en el ítem sino en `estadoCuenta.secretaria`, y ese mismo `estadoCuenta`
 * lleva dentro la `direccion` del hecho: es el caso que obliga a que la poda reconstruya la HOJA
 * autorizada y no el subárbol. `identificador` es el NIT consultado y tampoco puede persistirse.
 */
export function itemMunicipal(): Record<string, unknown> {
  return {
    numeroComparendo: FABRICADO.numeroMunicipal,
    identificador: FABRICADO.nitMunicipal,
    placa: FABRICADO.placaMunicipal,
    fechaComparendo: '2026-07-19',
    valor: 633232.0,
    codigoInfraccion: 'C29',
    descripcionInfraccion: 'Conducir un vehículo a velocidad superior',
    idEstadoComparendo: 1,
    descripcionEstado: 'Se adeuda',
    tipoComparendo: 'Electrónico',
    nombres: 'T**** ****** ******** ***',
    apellidos: null,
    contraventores: [],
    estadoCuenta: {
      direccion: FABRICADO.direccionMunicipal,
      numeroComparendo: FABRICADO.numeroMunicipal,
      infraccion: [{ codigoInfraccion: 'C29', descripcion: 'Conducir un vehículo a velocidad superior' }],
      secretaria: { identificador: '99', nombreAutoridadTransito: FABRICADO.organismoMunicipal },
    },
  };
}

/**
 * Respuesta COMPLETA del UTS municipal: eco de la consulta en la raíz —`criterio` ES el NIT, y por
 * eso ningún mensaje de error puede arrastrarlo— y el envelope con su `estado` y sus cuatro listas.
 *
 * `informacionComparendoAdicional` va vacía y ANTES que la buena, que es lo que rompía «quédate con
 * la primera lista que encuentres». `tarifasComparendos` es un catálogo de tarifas, no comparendos.
 */
export function payloadUts(opciones: {
  nit?: string;
  estado?: Record<string, unknown> | null;
  comparendos?: Record<string, unknown>[];
} = {}): Record<string, unknown> {
  const { nit = FABRICADO.nitMunicipal, estado, comparendos = [itemMunicipal()] } = opciones;
  return {
    idTipoIdentificacion: 3,
    criterio: nit,
    response: null,
    consultaMultaOComparendoOutDTO: {
      estado: estado === undefined ? { codigoEstado: 1, descripcion: 'EXITOSO' } : estado,
      informacionComparendoAdicional: [],
      informacionComparendo: comparendos,
      informacionMulta: [],
      tarifasComparendos: [],
    },
  };
}
