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
  /**
   * El número tal y como lo emite el UTS municipal: la letra del portal delante de los veinte
   * dígitos del número único nacional. La FORMA es la real (medida el 2026-08-20 en Medellín).
   *
   * Desde la HU #11806 esta constante es una TRAMPA a propósito y no un literal más: ya no es lo que
   * se guarda. `numeroCanonico` normaliza esto a `numeroMunicipalCanonico`, así que un test que
   * espere ver este valor en `numero_comparendo` está afirmando que la regla NO se aplicó. Donde sí
   * sigue apareciendo intacto es en `payload_municipal`, que es lo que hace reversible la decisión.
   */
  numeroMunicipal: 'D99999000000099999901',
  /** Lo que la columna guarda de verdad para `numeroMunicipal`: los veinte dígitos, sin la letra. */
  numeroMunicipalCanonico: '99999000000099999901',
  placaMunicipal: 'ZYX654',
  nitMunicipal: '800999888',
  direccionMunicipal: 'Calle 99 con Carrera 88 Sur - COMUNA 99',
  organismoMunicipal: 'STRIA DE TTOyTTE VILLADEMO',
  /** Número legible de resolución de una multa de SIMIT (HU #11712). Fabricado, con su formato. */
  numeroResolucionSimit: '3000000123',
  /** Identificador de SISTEMA de la resolución. La FORMA (dígitos, sin guiones) es la real. */
  idResolucionSimit: '115697134',
  /** Y el del UTS, que numera de otra manera. */
  numeroResolucionMunicipal: 'RES-2026-4471',
} as const;

/**
 * El cuerpo TAL Y COMO lo manda el UTS municipal: el JSON serializado DOS veces (Bug #11711).
 *
 * Se genera con `JSON.stringify(JSON.stringify(...))` y no se pega una cadena escapada a mano, para
 * que la fixture no pueda desincronizarse de `payloadUts()` y para que se lea lo que representa.
 *
 * La forma está medida contra el proveedor el 2026-08-21 en CINCO de los OCHO municipios sembrados
 * (BELLO, MEDELLIN, ITAGUI, ENVIGADO y SABANETA; sin CALI, MANIZALES ni RIONEGRO): `HTTP 200`,
 * `application/json; charset=utf-8`,
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
    // HU #11712. Los dos campos de la resolución llegan EXPLÍCITAMENTE en `null` mientras el
    // registro sigue siendo un comparendo: la clave está, el valor no. Es lo que hace que su
    // ausencia sea información y no un hueco del proveedor. `estadoPago` es el candidato que la v3
    // suma a la cadena de `estadoFuente`.
    numeroResolucion: null,
    idResolucion: null,
    estadoPago: 'No pagado',
  };
}

/**
 * El mismo ítem de SIMIT cuando el comparendo YA se convirtió en multa (HU #11712): los dos campos
 * de resolución con valor.
 *
 * Va aparte y no como bandera de `itemSimit` para que los tests que no hablan del tipo sigan
 * leyéndose igual, y porque el par «mismo ítem, un campo distinto» es exactamente la comparación que
 * un test de promoción necesita hacer.
 */
export function itemSimitMulta(i = 0): Record<string, unknown> {
  return {
    ...itemSimit(i),
    numeroResolucion: FABRICADO.numeroResolucionSimit,
    idResolucion: FABRICADO.idResolucionSimit,
    estadoPago: 'En cobro coactivo',
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
    // HU #11712, y esta pareja es una TRAMPA del proveedor real, no un adorno: el ítem de Medellín
    // trae `fechaResolucion` CON valor y `nroResolucion` en `null` a la vez. Quien tome la fecha
    // como señal de que hay resolución fabrica multas que no existen; por eso `fechaResolucion` no
    // se mapea a nada en la v3 y esta fixture es la que lo demuestra.
    nroResolucion: null,
    fechaResolucion: '2026-09-22',
  };
}

/** El mismo ítem del UTS cuando ya es multa: `nroResolucion` con valor (HU #11712). */
export function itemMunicipalMulta(): Record<string, unknown> {
  return { ...itemMunicipal(), nroResolucion: FABRICADO.numeroResolucionMunicipal };
}

/**
 * **El MISMO comparendo que `itemSimit(i)`, escrito como lo escribe el UTS municipal** (HU #11806).
 *
 * Esto es lo que faltaba y por lo que la suite pasaba en verde con el defecto vivo: hasta aquí cada
 * fuente fabricaba su número por su cuenta —`numeroSimit(i)` frente a `FABRICADO.numeroMunicipal`—,
 * así que NINGÚN test cruzaba las dos grafías del mismo comparendo. Con dos números que nunca
 * coinciden, dos filas es el resultado correcto y una fila también lo parecía.
 *
 * El número se compone, no se copia: `'D' + numeroSimit(i)` es exactamente la pareja real medida
 * —veinte dígitos en SIMIT y esos mismos veinte con la letra del portal delante en el municipio—, y
 * componerlo impide que alguien «arregle» un test cambiando un literal y dejando de cruzar nada.
 *
 * El resto del ítem es el de `itemMunicipal()`: la misma envoltura, la misma PII que la poda tira y
 * el mismo `estadoCuenta.numeroComparendo`, que también lleva la grafía prefijada porque el
 * proveedor repite el número ahí dentro (y es candidato de prioridad 2 en la v3 del mapa).
 */
export function itemMunicipalDeSimit(i = 0): Record<string, unknown> {
  const numero = `D${numeroSimit(i)}`;
  const base = itemMunicipal();
  return {
    ...base,
    numeroComparendo: numero,
    estadoCuenta: { ...(base.estadoCuenta as Record<string, unknown>), numeroComparendo: numero },
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
