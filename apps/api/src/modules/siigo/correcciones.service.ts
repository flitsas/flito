// Siigo — registro de la corrección de una factura ya emitida (HU #11343, Feature #11244).
//
// La decisión de qué es admisible vive en `siigo.correcciones.ts`, que es puro. Aquí está lo que
// toca la base: leer la situación de la factura, registrar lo que se hizo por fuera y responder
// «¿este trámite ya se corrigió?» al reporte y a la bandeja.
//
// **Por qué esta historia existe aunque la pregunta 8 siga abierta.** No está decidido si corregir
// una factura emitida entra en el alcance del sistema o se maneja a mano en Siigo Nube. Esta es la
// mitad que no depende de la respuesta: «se maneja a mano» TAMBIÉN necesita software. Alguien hace
// la corrección en Siigo Nube; si no la registra aquí, FLITO sigue creyendo que la factura está
// vigente, el trámite figura como resuelto cuando no lo está, y dentro de seis meses nadie puede
// explicar qué pasó.
//
// **Nada de esto toca `siigo_facturas`.** Una factura corregida sigue emitida: el documento existe
// ante la DIAN y existirá siempre. Lo que cambia es que deja de estar pendiente de resolver, y eso
// se sabe por la existencia de una fila en esta tabla, no por un campo que se reescribe encima de la
// historia (AC4).

import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  SIIGO_CORRECCION_MOTIVO_MAX, SIIGO_CORRECCION_MOTIVO_MIN,
  type SiigoCorreccionEjecutor, type SiigoCorreccionRegistrada, type SiigoCorreccionTipo,
  type SiigoEvaluacionCorreccion, type SiigoFacturaEstado, type SiigoTramiteCorregido,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  siigoFacturaCorrecciones, siigoFacturaTramites, siigoFacturas, users,
} from '../../db/schema.js';
import { TZ_COLOMBIA } from '../../shared/utils/fecha-rango.js';
import { evaluarCorreccion, opcionDe, resumirVia, type SituacionFactura } from './siigo.correcciones.js';
import { registrarOperacion } from './siigo.operaciones.repo.js';

/**
 * Error de negocio de este módulo. Clase propia y no `siigo.errors.ts`: aquel traduce los códigos
 * que devuelve la API de Siigo, y aquí no ha habido ninguna llamada a Siigo — el error es de FLITO.
 */
export class SiigoCorreccionError extends Error {
  constructor(readonly codigo: 'no_existe' | 'datos' | 'no_corregible' | 'duplicada', message: string) {
    super(message);
    this.name = 'SiigoCorreccionError';
  }
}

/** Hoy en Colombia (`yyyy-MM-dd`). La fecha de la corrección es un día civil, no un instante. */
function hoyColombia(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_COLOMBIA, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * La situación de una factura tal como la ve `evaluarCorreccion()`.
 *
 * `enviadaEn` **no** se usa para deducir el envío a la DIAN: en el modelo de la HU #11323 esa
 * columna registra el envío a Siigo, no el sellado ante la autoridad. Confundirlas haría que una
 * factura sin CUFE pareciera intocable. El eje ante la DIAN llega con la HU #11330 y entrará por
 * `enTransitoAnteDian`.
 */
function situacionDe(f: typeof siigoFacturas.$inferSelect, yaCorregida: boolean): SituacionFactura {
  return {
    estado: f.estado as SiigoFacturaEstado,
    siigoInvoiceId: f.siigoInvoiceId,
    cufe: f.cufe,
    emitidaEn: f.enviadaEn ?? f.createdAt,
    yaCorregida,
  };
}

async function facturaPorId(facturaId: string) {
  const [f] = await db.select().from(siigoFacturas).where(eq(siigoFacturas.id, facturaId)).limit(1);
  if (!f) throw new SiigoCorreccionError('no_existe', 'La factura no existe.');
  return f;
}

async function correccionesDe(facturaId: string): Promise<SiigoCorreccionRegistrada[]> {
  const filas = await db.select({
    c: siigoFacturaCorrecciones,
    nombre: users.name,
  })
    .from(siigoFacturaCorrecciones)
    .leftJoin(users, eq(users.id, siigoFacturaCorrecciones.registradoPor))
    .where(eq(siigoFacturaCorrecciones.facturaId, facturaId))
    .orderBy(desc(siigoFacturaCorrecciones.createdAt));

  return filas.map(({ c, nombre }) => ({
    id: c.id,
    facturaId: c.facturaId,
    tipo: c.tipo as SiigoCorreccionTipo,
    ejecutor: c.ejecutor as SiigoCorreccionEjecutor,
    documentoSiigo: c.documentoSiigo,
    motivo: c.motivo,
    fechaCorreccion: c.fechaCorreccion,
    registradaEn: c.createdAt.toISOString(),
    registradoPor: c.registradoPor,
    registradoPorNombre: nombre ?? null,
  }));
}

export interface FacturaConCorrecciones {
  facturaId: string;
  estado: SiigoFacturaEstado;
  numero: string | null;
  evaluacion: SiigoEvaluacionCorreccion;
  correcciones: SiigoCorreccionRegistrada[];
}

/** AC1 — qué admite esta factura, más lo que ya se le registró. Una sola lectura para la pantalla. */
export async function consultarCorrecciones(facturaId: string): Promise<FacturaConCorrecciones> {
  const f = await facturaPorId(facturaId);
  const correcciones = await correccionesDe(facturaId);
  return {
    facturaId: f.id,
    estado: f.estado as SiigoFacturaEstado,
    numero: f.numero,
    evaluacion: evaluarCorreccion(situacionDe(f, correcciones.length > 0)),
    correcciones,
  };
}

export interface NuevaCorreccion {
  tipo: SiigoCorreccionTipo;
  documentoSiigo: string;
  motivo: string;
  /** `yyyy-MM-dd`. Por defecto hoy en Colombia. */
  fechaCorreccion?: string;
}

/** El formato lo valida Zod en la ruta; aquí se comprueba lo que Zod no puede saber: el calendario. */
function fechaValida(fecha: string): boolean {
  return fecha <= hoyColombia();
}

/**
 * AC3 — registra una corrección hecha por fuera de FLITO.
 *
 * El ejecutor es `manual` y no es un parámetro: **es el único que hoy existe**. Cuando llegue el
 * automático (HU #11344) será otra función que inserte en esta misma tabla con otro valor — sin
 * migrar nada ni cambiar las consultas de arriba. Esa es toda la razón por la que la columna nace
 * hoy con un solo valor posible en vez de nacer el día que haya dos.
 */
export async function registrarCorreccion(
  facturaId: string, datos: NuevaCorreccion, usuarioId: number | null,
): Promise<SiigoCorreccionRegistrada> {
  const motivo = datos.motivo.trim();
  const documento = datos.documentoSiigo.trim();
  const fecha = datos.fechaCorreccion ?? hoyColombia();

  if (motivo.length < SIIGO_CORRECCION_MOTIVO_MIN || motivo.length > SIIGO_CORRECCION_MOTIVO_MAX) {
    throw new SiigoCorreccionError('datos',
      `Explica el motivo de la corrección (entre ${SIIGO_CORRECCION_MOTIVO_MIN} y ${SIIGO_CORRECCION_MOTIVO_MAX} caracteres).`);
  }
  if (!documento) {
    throw new SiigoCorreccionError('datos',
      'Indica el número o identificador del documento en Siigo: sin él la corrección no se puede verificar.');
  }
  if (!fechaValida(fecha)) {
    throw new SiigoCorreccionError('datos', 'La fecha de la corrección no puede estar en el futuro.');
  }

  const f = await facturaPorId(facturaId);
  const previas = await correccionesDe(facturaId);
  const evaluacion = evaluarCorreccion(situacionDe(f, previas.length > 0));

  // AC6 — no se corrige lo que no llegó a existir. El mensaje lleva la vía, porque un rechazo que no
  // dice qué hacer obliga a preguntar por WhatsApp y ahí se pierde la trazabilidad.
  if (!evaluacion.puedeCorregirse) {
    throw new SiigoCorreccionError('no_corregible',
      `No hay documento que corregir. ${evaluacion.viaTexto}`);
  }

  const opcion = opcionDe(evaluacion, datos.tipo);
  if (!opcion?.admisible) {
    throw new SiigoCorreccionError('no_corregible',
      opcion?.motivo ?? 'Ese tipo de corrección no es admisible para esta factura.');
  }

  // El duplicado lo impide un UNIQUE en la base (esta tabla prohíbe DELETE: una fila repetida por un
  // doble envío se quedaría para siempre). Esta comprobación solo sirve para dar un mensaje decente;
  // la garantía es el índice, y por eso el `catch` de abajo traduce su violación.
  if (previas.some((p) => p.documentoSiigo.toLowerCase() === documento.toLowerCase())) {
    throw new SiigoCorreccionError('duplicada',
      `El documento ${documento} ya está registrado como corrección de esta factura.`);
  }

  let filas: (typeof siigoFacturaCorrecciones.$inferSelect)[];
  try {
    filas = await db.insert(siigoFacturaCorrecciones).values({
      facturaId, tipo: datos.tipo, ejecutor: 'manual',
      documentoSiigo: documento, motivo, fechaCorreccion: fecha, registradoPor: usuarioId,
    }).returning();
  } catch (e) {
    if (esViolacionUnica(e)) {
      throw new SiigoCorreccionError('duplicada',
        `El documento ${documento} ya está registrado como corrección de esta factura.`);
    }
    throw e;
  }

  // AC3 — la bitácora inalterable. La tabla ya es append-only por disparador; esta fila añade el
  // registro en la MISMA bitácora donde consta la emisión, para que la historia del documento se lea
  // seguida y no haya que cruzar dos tablas para entender qué le pasó.
  await registrarOperacion({
    operacion: 'registrar_correccion',
    entidadTipo: 'factura', entidadId: facturaId,
    ambiente: f.ambiente,
    resultado: 'ok',
    codigo: datos.tipo,
    // Sin el motivo: lo escribe una persona en texto libre y puede acabar nombrando al cliente. La
    // bitácora es WORM, así que un dato personal escrito ahí ya no se puede rectificar ni suprimir
    // (Ley 1581, art. 8). El motivo completo vive en la tabla de correcciones, que sí está acotada
    // a quien tiene permiso de leerla.
    mensaje: `Corrección ${datos.tipo} registrada · documento ${documento} · ${fecha}`,
    createdBy: usuarioId,
  });

  const fila = filas[0]!;
  return {
    id: fila.id,
    facturaId,
    tipo: datos.tipo,
    ejecutor: 'manual',
    documentoSiigo: documento,
    motivo,
    fechaCorreccion: fecha,
    registradaEn: fila.createdAt.toISOString(),
    registradoPor: usuarioId,
    registradoPorNombre: null,
  };
}

/** `23505` es unique_violation. Drizzle envuelve el error del driver, así que se busca en cadena. */
function esViolacionUnica(e: unknown): boolean {
  for (let cur: unknown = e, i = 0; cur && i < 5; i++) {
    if (typeof cur === 'object' && (cur as { code?: string }).code === '23505') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * AC4 — cómo ven el reporte y la bandeja un trámite ya corregido.
 *
 * Devuelve una fila por trámite consultado, incluidos los que no tienen factura: quien pregunta
 * necesita poder distinguir «no corregido» de «no lo conozco», y una lista más corta que la pedida
 * obliga a adivinar cuál es cuál.
 *
 * Solo mira las filas puente `activo`: una factura fallida no ocupa el trámite (HU #11323) y sus
 * correcciones —si las hubiera— no dicen nada del estado actual.
 */
export async function correccionesDeTramites(tramiteIds: string[]): Promise<SiigoTramiteCorregido[]> {
  if (!tramiteIds.length) return [];

  const filas = await db.select({
    tramiteId: siigoFacturaTramites.tramiteId,
    facturaId: siigoFacturaTramites.facturaId,
    tipo: siigoFacturaCorrecciones.tipo,
    documentoSiigo: siigoFacturaCorrecciones.documentoSiigo,
    fechaCorreccion: siigoFacturaCorrecciones.fechaCorreccion,
    createdAt: siigoFacturaCorrecciones.createdAt,
  })
    .from(siigoFacturaTramites)
    .leftJoin(siigoFacturaCorrecciones,
      eq(siigoFacturaCorrecciones.facturaId, siigoFacturaTramites.facturaId))
    .where(and(
      inArray(siigoFacturaTramites.tramiteId, tramiteIds),
      eq(siigoFacturaTramites.activo, true),
    ))
    .orderBy(desc(siigoFacturaCorrecciones.createdAt));

  const porTramite = new Map<string, SiigoTramiteCorregido>();
  for (const f of filas) {
    // La primera que llega es la más reciente por el ORDER BY; las demás del mismo trámite son
    // correcciones anteriores y no cambian la respuesta.
    if (porTramite.has(f.tramiteId)) continue;
    porTramite.set(f.tramiteId, {
      tramiteId: f.tramiteId,
      facturaId: f.facturaId,
      corregida: f.tipo !== null,
      tipo: (f.tipo as SiigoCorreccionTipo | null) ?? null,
      documentoSiigo: f.documentoSiigo,
      fechaCorreccion: f.fechaCorreccion,
    });
  }

  return tramiteIds.map((id) => porTramite.get(id) ?? {
    tramiteId: id, facturaId: null, corregida: false,
    tipo: null, documentoSiigo: null, fechaCorreccion: null,
  });
}

/**
 * AC5 — la vía de corrección de la factura viva de un trámite, en una frase.
 *
 * La usa `reversar` para que la prohibición deje de ser un callejón sin salida. **No lanza nunca**:
 * quien la llama ya está construyendo un mensaje de error, y que la consulta falle no puede
 * convertir un rechazo de negocio explicado en un 500 sin explicación.
 */
export async function viaDeCorreccionDeTramite(tramiteId: string): Promise<string | null> {
  try {
    const [fila] = await db.select({ f: siigoFacturas })
      .from(siigoFacturaTramites)
      .innerJoin(siigoFacturas, eq(siigoFacturas.id, siigoFacturaTramites.facturaId))
      .where(and(
        eq(siigoFacturaTramites.tramiteId, tramiteId),
        eq(siigoFacturaTramites.activo, true),
      ))
      .limit(1);
    if (!fila?.f) return null;

    const previas = await correccionesDe(fila.f.id);
    return resumirVia(evaluarCorreccion(situacionDe(fila.f, previas.length > 0)));
  } catch {
    return null;
  }
}
