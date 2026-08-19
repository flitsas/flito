// Cómo se arma el `name` que se le envía a Siigo (HU #11295, Feature #11241).
//
// Siigo pide `name` como ARREGLO, y su forma depende del tipo de persona:
//   · compañía        → `["TRANSPORTES 3M S.A.S."]`, un solo elemento
//   · persona natural → `["Marcos", "Castillo"]`, nombres y apellidos separados
//
// **La limpieza también depende del tipo, y ahí está lo que se hace mal por defecto.** Para una
// persona natural hay que quitar dígitos y signos porque Siigo los rechaza; aplicar esa misma
// limpieza a una razón social la destruye: «TRANSPORTES 3M S.A.S.» se convertiría en «TRANSPORTES M
// SAS», y ese es el nombre que saldría impreso en una factura ante la DIAN. La regla de la
// implementación de referencia (`limpiarNombre`) vale SOLO para el caso Person.
//
// Función pura, sin base de datos: la consumen el informe de no facturables (HU #11296) y el
// aseguramiento del tercero (HU #11297).

import type { PersonaTipo } from '@operaciones/shared-types';

/** Tope de Siigo para cada elemento del arreglo. */
const LARGO_MAXIMO = 100;

export type MotivoNombreInvalido =
  | 'tipo_persona_sin_clasificar'
  | 'razon_social_vacia'
  | 'nombre_vacio_tras_saneamiento'
  | 'apellidos_faltantes';

export const MOTIVO_NOMBRE_TEXTO: Record<MotivoNombreInvalido, string> = {
  tipo_persona_sin_clasificar:
    'El cliente no tiene tipo de persona: sin saber si es empresa o persona natural no se puede armar el nombre.',
  razon_social_vacia: 'La compañía no tiene razón social.',
  nombre_vacio_tras_saneamiento:
    'El nombre queda vacío al quitarle los caracteres que Siigo rechaza.',
  apellidos_faltantes: 'No se pudieron separar nombres y apellidos: el nombre tiene una sola palabra.',
};

export interface NombreParaSiigo {
  /** Lo que viaja en el campo `name`. */
  name: string[];
  /**
   * `true` cuando la partición en nombres y apellidos la DEDUJO el sistema a partir de un campo
   * único, en vez de venir capturada. Se propone, no se impone (AC3).
   */
  particionPropuesta: boolean;
}

export type ResultadoNombre =
  | { ok: true; valor: NombreParaSiigo }
  | { ok: false; motivo: MotivoNombreInvalido; detalle: string };

export interface EntradaNombre {
  personType: string | null | undefined;
  /** Razón social si es compañía, nombre completo si es persona y no hay partición capturada. */
  name: string | null | undefined;
  /** Partición capturada por una persona. Si viene, manda sobre cualquier deducción. */
  contactFirstName?: string | null;
  contactLastName?: string | null;
}

/** Colapsa espacios y recorta. Lo único que se le hace a una razón social. */
function colapsar(texto: string): string {
  return texto.replace(/\s+/g, ' ').trim();
}

/**
 * Limpieza para PERSONA NATURAL únicamente.
 *
 * Fuera dígitos y todo lo que no sea letra, espacio, apóstrofo o guion. Se conservan:
 *   · las tildes y la ñ — son parte del nombre legal;
 *   · el guion — «García-López» es un apellido compuesto real;
 *   · el apóstrofo — «D'Angelo», «O'Brien».
 *
 * Nunca se aplica a una compañía: ver el encabezado del archivo.
 */
export function limpiarNombrePersona(texto: string): string {
  return colapsar(
    texto
      .replace(/[0-9]/g, ' ')
      .replace(/[^\p{L}\s'’-]/gu, ' '),
  );
}

/**
 * Parte un nombre completo en nombres y apellidos (AC3).
 *
 * Convención colombiana: los dos últimos tokens son los apellidos. Con tres tokens se asume un
 * nombre y dos apellidos, que es el caso más frecuente y también el más ambiguo — por eso el
 * resultado viaja marcado como PROPUESTO y no como confirmado. Adivinar aquí no es un problema
 * mientras la propuesta se declare: lo grave sería presentarla como un dato capturado.
 */
export function proponerParticion(completo: string): { nombres: string; apellidos: string } | null {
  const partes = colapsar(completo).split(' ').filter(Boolean);
  if (partes.length < 2) return null;
  if (partes.length === 2) return { nombres: partes[0]!, apellidos: partes[1]! };
  const apellidos = partes.slice(-2).join(' ');
  const nombres = partes.slice(0, -2).join(' ');
  return { nombres, apellidos };
}

function recortar(texto: string): string {
  return [...texto].slice(0, LARGO_MAXIMO).join('');
}

/**
 * Arma el `name` para Siigo (AC1, AC2, AC4, AC5).
 *
 * No devuelve nunca un nombre vacío ni un texto de relleno: si el dato no da, se declara por qué.
 * Un «NO REPORTA» enviado a Siigo es una afirmación ante la DIAN que nadie autorizó.
 */
export function armarNombreSiigo(entrada: EntradaNombre): ResultadoNombre {
  const tipo = entrada.personType as PersonaTipo | null | undefined;

  // AC5 — sin tipo de persona no se arma nada. NO se asume compañía por ser lo más frecuente:
  // la forma del nombre y su limpieza dependen enteramente de esta decisión.
  if (tipo !== 'Person' && tipo !== 'Company') {
    return {
      ok: false,
      motivo: 'tipo_persona_sin_clasificar',
      detalle: MOTIVO_NOMBRE_TEXTO.tipo_persona_sin_clasificar,
    };
  }

  const crudo = (entrada.name ?? '').toString();

  if (tipo === 'Company') {
    // AC1 — la razón social se conserva ÍNTEGRA: dígitos, puntos y siglas incluidos. Lo único que
    // se toca son los espacios sobrantes.
    const razon = colapsar(crudo);
    if (razon === '') {
      return { ok: false, motivo: 'razon_social_vacia', detalle: MOTIVO_NOMBRE_TEXTO.razon_social_vacia };
    }
    return { ok: true, valor: { name: [recortar(razon)], particionPropuesta: false } };
  }

  // ── Persona natural (AC2, AC3) ────────────────────────────────────────────
  //
  // La partición capturada manda sobre cualquier deducción: si alguien se tomó el trabajo de
  // separar nombres y apellidos, el sistema no tiene por qué volver a adivinarlos.
  const capturados = {
    nombres: limpiarNombrePersona((entrada.contactFirstName ?? '').toString()),
    apellidos: limpiarNombrePersona((entrada.contactLastName ?? '').toString()),
  };
  if (capturados.nombres !== '' && capturados.apellidos !== '') {
    return {
      ok: true,
      valor: {
        name: [recortar(capturados.nombres), recortar(capturados.apellidos)],
        particionPropuesta: false,
      },
    };
  }

  const limpio = limpiarNombrePersona(crudo);
  if (limpio === '') {
    return {
      ok: false,
      motivo: 'nombre_vacio_tras_saneamiento',
      detalle: MOTIVO_NOMBRE_TEXTO.nombre_vacio_tras_saneamiento,
    };
  }

  const particion = proponerParticion(limpio);
  if (particion === null) {
    // Una sola palabra: no hay forma honesta de inventarle un apellido, y mandar la misma palabra
    // dos veces sería una afirmación falsa sobre la identidad de una persona.
    return {
      ok: false,
      motivo: 'apellidos_faltantes',
      detalle: MOTIVO_NOMBRE_TEXTO.apellidos_faltantes,
    };
  }

  return {
    ok: true,
    valor: {
      name: [recortar(particion.nombres), recortar(particion.apellidos)],
      // AC3 — se propone, no se impone: el cliente no está listo para facturar hasta que alguien
      // confirme esta partición.
      particionPropuesta: true,
    },
  };
}

/**
 * ¿Este nombre sirve para facturar TAL CUAL, sin que nadie confirme nada?
 *
 * Una partición propuesta NO cuenta (AC3): es una deducción del sistema sobre el nombre legal de
 * una persona, y sale impresa en un documento ante la DIAN.
 */
export function nombreListoParaFacturar(entrada: EntradaNombre): boolean {
  const r = armarNombreSiigo(entrada);
  return r.ok && !r.valor.particionPropuesta;
}
