// Convertir la ciudad en texto libre de cada cliente al código de Siigo (HU #11294, Feature #11241).
//
// **Esto no es una actualización masiva.** Es propuesta más confirmación humana, y la diferencia no
// es de proceso sino de consecuencia: un municipio equivocado sale impreso en una factura ante la
// DIAN, y `clients.city` es un `varchar(100)` donde a lo largo de los años cabe cualquier cosa —
// «BOGOTA D.C.», «Bta», «Medellin - Ant», «Kilómetro 5 vía Cota». Aplicar automáticamente la
// coincidencia más parecida convertiría un dato dudoso en un dato con apariencia de verificado, que
// es peor que no tener nada: lo primero se corrige, lo segundo nadie lo vuelve a mirar.
//
// Por el mismo motivo la ambigüedad se declara en vez de resolverse. En Colombia hay municipios
// homónimos en departamentos distintos, y elegir «el más grande» o «el primero» es inventar.

import { and, eq, isNull, isNotNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { clients, siigoCiudades } from '../../db/schema.js';
import { normalizarNombre } from './siigo.ciudades.service.js';

/**
 * País por defecto de la propuesta.
 *
 * Restringir a Colombia no es un capricho: el catálogo trae 4.605 ciudades de 220 países y muchos
 * nombres se repiten entre ellos —«Medellín» existe también fuera—, así que buscar en todo el
 * mundo fabricaría ambigüedades que no existen para una cartera de transporte terrestre nacional.
 * Es un parámetro para el día que haya clientes de otro país.
 */
export const PAIS_POR_DEFECTO = 'Co';

export type CertezaEquivalencia = 'exacta' | 'aproximada' | 'ambigua' | 'sin_equivalencia';

export interface CandidataCiudad {
  countryCode: string;
  stateCode: string;
  stateName: string;
  cityCode: string;
  cityName: string;
  /** 1 = el texto normalizado es idéntico. Baja con la distancia de edición. */
  puntaje: number;
}

export interface PropuestaCiudad {
  textoOrigen: string;
  certeza: CertezaEquivalencia;
  /** Vacío si no hay equivalencia; más de una si es ambigua. */
  candidatas: CandidataCiudad[];
}

/**
 * Distancia de Levenshtein. Sin librería nueva: son veinte líneas y añadir una dependencia al
 * árbol de producción para esto es peor negocio que mantenerlas.
 *
 * Corta por lo sano cuando la diferencia de longitud ya supera el umbral: comparar «Bta» contra
 * «Barranquilla» no necesita recorrer la matriz entera.
 */
export function distanciaEdicion(a: string, b: string, umbral = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > umbral) return umbral + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previa = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const actual = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1;
      actual[j] = Math.min(actual[j - 1]! + 1, previa[j]! + 1, previa[j - 1]! + costo);
    }
    previa = actual;
  }
  return previa[b.length]!;
}

/**
 * Normaliza para comparar (AC5): sin tildes, en minúsculas, sin puntuación y sin espacios de más.
 *
 * Encima de la normalización del catálogo se quitan además los sufijos administrativos que la gente
 * escribe y el listado oficial no trae: «BOGOTA D.C.» y «Bogotá» tienen que proponer lo mismo.
 * `d c` se elimina solo al final, para no mutilar un nombre que legítimamente los contenga.
 */
export function normalizarParaComparar(texto: string): string {
  return normalizarNombre(texto)
    .replace(/[.,;:()/\\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+(d\s*c|dc|distrito capital)$/u, '')
    .trim();
}

/** Umbral de la distancia de edición. 2 tolera una tilde perdida o un dedazo, no un apodo. */
const UMBRAL_DISTANCIA = 2;

/** Nunca más de esto en una propuesta ambigua: una lista de 40 candidatas no ayuda a elegir. */
const MAXIMO_CANDIDATAS = 10;

export interface CiudadCatalogo {
  countryCode: string;
  stateCode: string;
  stateName: string;
  cityCode: string;
  cityName: string;
  cityBusqueda: string;
}

/**
 * Calcula la propuesta para UN texto contra el catálogo ya cargado en memoria (AC1, AC2, AC3).
 *
 * Función pura: recibe el catálogo, no lo consulta. Así se puede evaluar la cartera entera con una
 * sola lectura y probarla sin base de datos.
 */
export function proponerCiudad(texto: string | null | undefined, catalogo: CiudadCatalogo[]): PropuestaCiudad {
  const textoOrigen = (texto ?? '').toString();
  const normalizado = normalizarParaComparar(textoOrigen);

  if (normalizado === '') {
    return { textoOrigen, certeza: 'sin_equivalencia', candidatas: [] };
  }

  const exactas = catalogo.filter((c) => normalizarParaComparar(c.cityName) === normalizado);
  if (exactas.length > 0) {
    const candidatas = exactas.map((c) => ({ ...aCandidata(c), puntaje: 1 }));
    // AC2 — homónimos reales: el mismo nombre en departamentos distintos. Se declaran TODOS. No se
    // elige el primero, ni el más poblado, ni el del departamento más frecuente de la cartera:
    // cualquiera de esos criterios es una invención con apariencia de dato.
    return {
      textoOrigen,
      certeza: exactas.length === 1 ? 'exacta' : 'ambigua',
      candidatas: candidatas.slice(0, MAXIMO_CANDIDATAS),
    };
  }

  const cercanas: CandidataCiudad[] = [];
  let mejorDistancia = UMBRAL_DISTANCIA + 1;
  for (const c of catalogo) {
    const d = distanciaEdicion(normalizado, normalizarParaComparar(c.cityName), UMBRAL_DISTANCIA);
    if (d > UMBRAL_DISTANCIA) continue;
    if (d < mejorDistancia) { mejorDistancia = d; cercanas.length = 0; }
    if (d === mejorDistancia) cercanas.push({ ...aCandidata(c), puntaje: 1 - d / (normalizado.length + 1) });
  }

  if (cercanas.length === 0) {
    return { textoOrigen, certeza: 'sin_equivalencia', candidatas: [] };
  }
  return {
    textoOrigen,
    // Una coincidencia aproximada NUNCA es «exacta», aunque sea única: la confirma una persona.
    certeza: cercanas.length === 1 ? 'aproximada' : 'ambigua',
    candidatas: cercanas.slice(0, MAXIMO_CANDIDATAS),
  };
}

function aCandidata(c: CiudadCatalogo): Omit<CandidataCiudad, 'puntaje'> {
  return {
    countryCode: c.countryCode,
    stateCode: c.stateCode,
    stateName: c.stateName,
    cityCode: c.cityCode,
    cityName: c.cityName,
  };
}

export class SiigoCiudadMapeoError extends Error {
  constructor(
    public readonly codigo: 'catalogo_vacio' | 'cliente_no_encontrado' | 'candidata_invalida',
    mensaje: string,
  ) {
    super(mensaje);
    this.name = 'SiigoCiudadMapeoError';
  }
}

async function cargarCatalogo(pais: string): Promise<CiudadCatalogo[]> {
  const filas = await db
    .select({
      countryCode: siigoCiudades.countryCode,
      stateCode: siigoCiudades.stateCode,
      stateName: siigoCiudades.stateName,
      cityCode: siigoCiudades.cityCode,
      cityName: siigoCiudades.cityName,
      cityBusqueda: siigoCiudades.cityBusqueda,
    })
    .from(siigoCiudades)
    .where(and(eq(siigoCiudades.countryCode, pais), eq(siigoCiudades.activo, true)));

  if (filas.length === 0) {
    // Con el catálogo vacío TODO saldría «sin equivalencia», que es un diagnóstico falso y llevaría
    // a corregir a mano una cartera que en realidad solo necesita cargar el catálogo.
    throw new SiigoCiudadMapeoError(
      'catalogo_vacio',
      `El catálogo de ubicaciones no tiene ciudades activas de ${pais}. Cárgalo antes de proponer equivalencias.`,
    );
  }
  return filas;
}

export interface PropuestaCliente {
  clienteId: number;
  nombre: string;
  ciudadTexto: string | null;
  propuesta: PropuestaCiudad;
}

/** Propone la equivalencia de todos los clientes activos que aún no tienen código de ciudad. */
export async function proponerEquivalencias(pais = PAIS_POR_DEFECTO): Promise<PropuestaCliente[]> {
  const catalogo = await cargarCatalogo(pais);
  const pendientes = await db
    .select({ id: clients.id, name: clients.name, city: clients.city })
    .from(clients)
    .where(and(eq(clients.active, true), isNull(clients.cityCode)))
    .orderBy(clients.name);

  return pendientes.map((c) => ({
    clienteId: c.id,
    nombre: c.name,
    ciudadTexto: c.city,
    propuesta: proponerCiudad(c.city, catalogo),
  }));
}

/**
 * La propuesta de UN cliente (HU #11298).
 *
 * La ficha fiscal necesita la equivalencia de su cliente, no la de la cartera entera: pedir las
 * 4.000 propuestas para leer una es gasto puro, y además la ficha se abre por fila.
 */
export async function propuestaDeCliente(
  clienteId: number, pais = PAIS_POR_DEFECTO,
): Promise<PropuestaCiudad> {
  const [cliente] = await db
    .select({ city: clients.city })
    .from(clients)
    .where(eq(clients.id, clienteId))
    .limit(1);
  if (!cliente) {
    throw new SiigoCiudadMapeoError('cliente_no_encontrado', `El cliente ${clienteId} no existe.`);
  }
  return proponerCiudad(cliente.city, await cargarCatalogo(pais));
}

export interface EstadoMapeoCiudades {
  total: number;
  conCodigo: number;
  pendientes: number;
  /** Desglose de los pendientes por qué se puede hacer con ellos. */
  proponibles: number;
  ambiguos: number;
  sinEquivalencia: number;
}

/** Cuánto falta y de qué tipo (AC6). */
export async function estadoMapeoCiudades(pais = PAIS_POR_DEFECTO): Promise<EstadoMapeoCiudades> {
  const [conteo] = await db
    .select({
      total: sql<number>`count(*)::int`,
      conCodigo: sql<number>`count(*) FILTER (WHERE ${clients.cityCode} IS NOT NULL)::int`,
    })
    .from(clients)
    .where(eq(clients.active, true));

  const propuestas = await proponerEquivalencias(pais);
  return {
    total: conteo?.total ?? 0,
    conCodigo: conteo?.conCodigo ?? 0,
    pendientes: propuestas.length,
    proponibles: propuestas.filter(
      (p) => p.propuesta.certeza === 'exacta' || p.propuesta.certeza === 'aproximada',
    ).length,
    ambiguos: propuestas.filter((p) => p.propuesta.certeza === 'ambigua').length,
    sinEquivalencia: propuestas.filter((p) => p.propuesta.certeza === 'sin_equivalencia').length,
  };
}

export interface ConfirmacionCiudad {
  clienteId: number;
  countryCode: string;
  stateCode: string;
  cityCode: string;
  usuarioId: number;
}

/**
 * Confirma la equivalencia de un cliente (AC4).
 *
 * La terna se valida contra el catálogo: aceptar lo que llegue del cliente HTTP permitiría fijar un
 * código de ciudad que Siigo no reconoce, y eso solo se descubriría al emitir. Queda registrado
 * quién, cuándo y **con qué texto de origen**, que es lo que permite detectar más tarde que alguien
 * cambió la ciudad escrita y la equivalencia se quedó vieja.
 */
export async function confirmarCiudad(datos: ConfirmacionCiudad): Promise<{
  clienteId: number; cityCode: string; cityName: string;
}> {
  const [ciudad] = await db
    .select({ cityName: siigoCiudades.cityName })
    .from(siigoCiudades)
    .where(and(
      eq(siigoCiudades.countryCode, datos.countryCode),
      eq(siigoCiudades.stateCode, datos.stateCode),
      eq(siigoCiudades.cityCode, datos.cityCode),
      eq(siigoCiudades.activo, true),
    ))
    .limit(1);

  if (!ciudad) {
    throw new SiigoCiudadMapeoError(
      'candidata_invalida',
      `La ciudad ${datos.countryCode}/${datos.stateCode}/${datos.cityCode} no está activa en el catálogo.`,
    );
  }

  const [previo] = await db
    .select({ city: clients.city })
    .from(clients)
    .where(eq(clients.id, datos.clienteId))
    .limit(1);
  if (!previo) {
    throw new SiigoCiudadMapeoError('cliente_no_encontrado', `El cliente ${datos.clienteId} no existe.`);
  }

  await db.update(clients)
    .set({
      countryCode: datos.countryCode,
      stateCode: datos.stateCode,
      cityCode: datos.cityCode,
      // El texto libre original NO se toca: es la prueba de qué decía la ficha al confirmar.
      cityTextoOrigen: previo.city,
      cityConfirmadaPor: datos.usuarioId,
      cityConfirmadaEn: new Date(),
    })
    .where(eq(clients.id, datos.clienteId));

  return { clienteId: datos.clienteId, cityCode: datos.cityCode, cityName: ciudad.cityName };
}

/**
 * Clientes cuya equivalencia quedó OBSOLETA: alguien cambió el texto de la ciudad después de
 * confirmarla.
 *
 * No lo pedía el AC, pero sin esto una corrección posterior de `city` deja los códigos apuntando a
 * la ciudad anterior sin que nada lo señale — y los códigos son los que viajan a Siigo, no el
 * texto. El síntoma sería una factura con el municipio viejo.
 */
export async function equivalenciasObsoletas(): Promise<{
  clienteId: number; nombre: string; ciudadActual: string | null; textoConfirmado: string | null;
}[]> {
  const filas = await db
    .select({
      clienteId: clients.id,
      nombre: clients.name,
      ciudadActual: clients.city,
      textoConfirmado: clients.cityTextoOrigen,
    })
    .from(clients)
    .where(and(
      eq(clients.active, true),
      isNotNull(clients.cityConfirmadaEn),
      sql`${clients.city} IS DISTINCT FROM ${clients.cityTextoOrigen}`,
    ))
    .orderBy(clients.name);
  return filas;
}
