// Qué le falta a un cliente para poder facturarse (HU #11296, Feature #11241).
//
// **Este archivo es la fuente única del veredicto.** Igual que la compuerta de la HU #11285 lo es
// para el mapeo de conceptos: cuando la Feature de emisión decida si bloquea una factura, tiene que
// llamar a `exigirClienteFacturable` y no reimplementar la comprobación. Dos copias de esta regla
// significan que el informe dice que un cliente está bien y la emisión lo rechaza, o al revés — y
// entonces el informe deja de servir para lo único que sirve, que es corregir antes de emitir.
//
// Tres decisiones que sostienen el archivo:
//
//   1. **Se evalúa al preguntar, nunca se cachea.** Los insumos cambian por debajo: alguien
//      completa una dirección, alguien clasifica un tipo de persona. Un veredicto guardado sería un
//      permiso para facturar con datos viejos.
//   2. **Se nombra el dato exacto que falta** (AC1). «Datos incompletos» no le dice a nadie qué
//      corregir y termina en alguien intentando emitir para ver qué pasa.
//   3. **No se llama a Siigo** (AC6). Todo sale de la copia local; el informe se consulta a menudo y
//      gastar cuota de la ventana que comparte con las facturas por un informe sería absurdo.

import { and, eq, isNotNull, sql } from 'drizzle-orm';
import {
  MOTIVOS_NO_FACTURABLE,
  MOTIVOS_NO_FACTURABLE_CODIGOS,
  MOTIVOS_PENDIENTE_CLASIFICACION,
  type FaltanteCliente,
  type MotivoNoFacturable,
  type ResumenValidacionClientes,
  type VeredictoCliente,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { clients } from '../../db/schema.js';
import { armarNombreSiigo } from './siigo.nombre.js';

/** Lo que hace falta de un cliente para poder juzgarlo. Sin PII que no se use. */
export interface ClienteEvaluable {
  id: number;
  name: string | null;
  document: string | null;
  personType: string | null;
  idType: string | null;
  fiscalResponsibilities: string[] | null;
  address: string | null;
  countryCode: string | null;
  stateCode: string | null;
  cityCode: string | null;
  phoneIndicative: string | null;
  phoneNumber: string | null;
  contactFirstName: string | null;
  contactLastName: string | null;
  facturacionBloqueos: string[] | null;
}

/**
 * El cliente no se puede facturar. La lanza `exigirClienteFacturable` para que el flujo de emisión
 * no tenga que inspeccionar un booleano y decidir por su cuenta qué hacer.
 *
 * Lleva los faltantes para que el mensaje al operador enumere QUÉ falta (AC4), no un «no se puede».
 */
export class ClienteNoFacturableError extends Error {
  readonly clienteId: number;
  readonly faltantes: FaltanteCliente[];

  constructor(clienteId: number, faltantes: FaltanteCliente[]) {
    super(
      `El cliente ${clienteId} no se puede facturar todavía: `
      + faltantes.map((f) => f.detalle).join(' '),
    );
    this.name = 'ClienteNoFacturableError';
    this.clienteId = clienteId;
    this.faltantes = faltantes;
  }
}

function faltante(motivo: MotivoNoFacturable, campo?: string): FaltanteCliente {
  return { motivo, detalle: MOTIVOS_NO_FACTURABLE[motivo], campo };
}

function vacio(v: string | null | undefined): boolean {
  return v === null || v === undefined || v.trim() === '';
}

/**
 * Evalúa UN cliente. Función pura sobre la fila: sin consultas, para poder juzgar la cartera entera
 * con una sola lectura y para poder probarla sin base de datos.
 */
export function evaluarCliente(c: ClienteEvaluable): VeredictoCliente {
  const faltantes: FaltanteCliente[] = [];

  // ── Identidad ante Siigo ──────────────────────────────────────────────────
  if (c.personType !== 'Person' && c.personType !== 'Company') {
    faltantes.push(faltante('tipo_persona_sin_clasificar', 'personType'));
  }
  if (vacio(c.idType)) faltantes.push(faltante('id_tipo_faltante', 'idType'));
  if (vacio(c.document)) faltantes.push(faltante('identificacion_faltante', 'document'));

  // La detectó la migración 0132 y no se puede recalcular aquí sin consultar a los demás clientes:
  // se arrastra el hallazgo en vez de repetir el trabajo.
  if ((c.facturacionBloqueos ?? []).includes('identificacion_duplicada')) {
    faltantes.push(faltante('identificacion_duplicada', 'document'));
  }

  // ── Nombre (AC2) ──────────────────────────────────────────────────────────
  //
  // Se reutiliza el armado de la HU #11295 en vez de repetir la lógica: si el nombre no se puede
  // armar, el motivo de allá ya distingue una compañía sin razón social de una persona cuyo nombre
  // queda vacío al sanearlo. Solo se evalúa cuando el tipo de persona ya está claro; si no lo está,
  // el fallo sería siempre el mismo y taparía el motivo real.
  if (c.personType === 'Person' || c.personType === 'Company') {
    const nombre = armarNombreSiigo({
      personType: c.personType,
      name: c.name,
      contactFirstName: c.contactFirstName,
      contactLastName: c.contactLastName,
    });
    if (!nombre.ok) {
      faltantes.push({ motivo: 'nombre_no_utilizable', detalle: nombre.detalle, campo: 'name' });
    } else if (nombre.valor.particionPropuesta) {
      // AC3 de la HU #11295: la partición se propone, no se impone. Va como pendiente de
      // clasificación y no como dato faltante, porque el dato está: falta que alguien lo confirme.
      faltantes.push(faltante('nombre_particion_sin_confirmar', 'contactFirstName'));
    }
  }

  // ── Datos fiscales y de ubicación ─────────────────────────────────────────
  if ((c.fiscalResponsibilities ?? []).length === 0) {
    faltantes.push(faltante('responsabilidad_fiscal_faltante', 'fiscalResponsibilities'));
  }
  if (vacio(c.address)) faltantes.push(faltante('direccion_faltante', 'address'));
  if (vacio(c.countryCode) || vacio(c.stateCode) || vacio(c.cityCode)) {
    faltantes.push(faltante('ubicacion_faltante', 'cityCode'));
  }

  // El teléfono de siempre es un `varchar(20)` de texto libre y Siigo exige indicativo y número
  // numéricos por separado: tener `phone` lleno NO cuenta, porque no se puede partir de forma
  // confiable («310 555 1234 ext 2» no tiene una lectura única).
  if (vacio(c.phoneIndicative) || vacio(c.phoneNumber)) {
    faltantes.push(faltante('telefono_faltante', 'phoneNumber'));
  }
  if (vacio(c.contactFirstName)) faltantes.push(faltante('contacto_faltante', 'contactFirstName'));

  const pendienteClasificacion = faltantes.some(
    (f) => MOTIVOS_PENDIENTE_CLASIFICACION.includes(f.motivo),
  );

  return {
    clienteId: c.id,
    nombre: c.name ?? '',
    documento: c.document,
    facturable: faltantes.length === 0,
    pendienteClasificacion,
    faltantes,
  };
}

/** Las columnas que necesita la evaluación. Proyección explícita: nada de `select()` a secas. */
/**
 * Proyección explícita de lo que `evaluarCliente` necesita, y NADA más.
 *
 * **Exportada desde la HU #11324**, que evalúa clientes dentro de una consulta más grande. La
 * alternativa que probé primero —`to_jsonb(clients)`— parecía equivalente y no lo era: `to_jsonb`
 * usa los nombres de COLUMNA (`person_type`, `id_type`…) y este evaluador espera los del modelo
 * (`personType`, `idType`…). Solo coincidían tres de quince, así que todo cliente salía «no
 * facturable» con seis motivos falsos. Compartir la proyección es lo que impide que vuelva a pasar.
 */
export const COLUMNAS_CLIENTE_EVALUABLE = {
  id: clients.id,
  name: clients.name,
  document: clients.document,
  personType: clients.personType,
  idType: clients.idType,
  fiscalResponsibilities: clients.fiscalResponsibilities,
  address: clients.address,
  countryCode: clients.countryCode,
  stateCode: clients.stateCode,
  cityCode: clients.cityCode,
  phoneIndicative: clients.phoneIndicative,
  phoneNumber: clients.phoneNumber,
  contactFirstName: clients.contactFirstName,
  contactLastName: clients.contactLastName,
  facturacionBloqueos: clients.facturacionBloqueos,
};

export interface OpcionesInforme {
  /** Solo los clientes que arrastran este motivo (AC5). */
  motivo?: MotivoNoFacturable;
  /** `false` (defecto) devuelve solo los no facturables: es para lo que se consulta el informe. */
  incluirFacturables?: boolean;
  limit?: number;
  offset?: number;
}

const LIMITE_DEFECTO = 100;
const LIMITE_MAXIMO = 500;

/**
 * Informe de la cartera (AC1, AC5).
 *
 * Solo clientes ACTIVOS: uno inactivo no se va a facturar, y meterlo en la lista de pendientes solo
 * consigue que la lista parezca más grande de lo que es y que nadie la termine.
 */
export async function informeClientes(opciones: OpcionesInforme = {}): Promise<{
  data: VeredictoCliente[];
  total: number;
}> {
  const limit = Math.min(opciones.limit ?? LIMITE_DEFECTO, LIMITE_MAXIMO);
  const offset = Math.max(0, opciones.offset ?? 0);

  const filas = await db.select(COLUMNAS_CLIENTE_EVALUABLE).from(clients)
    .where(eq(clients.active, true))
    .orderBy(clients.name);

  let veredictos = filas.map((f) => evaluarCliente(f as ClienteEvaluable));
  if (!opciones.incluirFacturables) veredictos = veredictos.filter((v) => !v.facturable);
  if (opciones.motivo) {
    veredictos = veredictos.filter((v) => v.faltantes.some((f) => f.motivo === opciones.motivo));
  }

  return { total: veredictos.length, data: veredictos.slice(offset, offset + limit) };
}

/**
 * Conteos por motivo (AC5).
 *
 * Un cliente cuenta en TODOS los motivos que arrastra, así que la suma de `porMotivo` excede el
 * total de no facturables. Es lo que hace falta para decidir por dónde empezar: si 400 clientes no
 * tienen contacto y 3 no tienen tipo de persona, el trabajo grande es capturar contactos.
 */
export async function resumenValidacionClientes(): Promise<ResumenValidacionClientes> {
  const filas = await db.select(COLUMNAS_CLIENTE_EVALUABLE).from(clients).where(eq(clients.active, true));
  const veredictos = filas.map((f) => evaluarCliente(f as ClienteEvaluable));

  const conteos = new Map<MotivoNoFacturable, number>();
  for (const v of veredictos) {
    // `Set` porque un mismo motivo no debe contarse dos veces para el mismo cliente.
    for (const motivo of new Set(v.faltantes.map((f) => f.motivo))) {
      conteos.set(motivo, (conteos.get(motivo) ?? 0) + 1);
    }
  }

  return {
    total: veredictos.length,
    facturables: veredictos.filter((v) => v.facturable).length,
    noFacturables: veredictos.filter((v) => !v.facturable).length,
    pendientesClasificacion: veredictos.filter((v) => v.pendienteClasificacion).length,
    porMotivo: MOTIVOS_NO_FACTURABLE_CODIGOS
      .map((motivo) => ({
        motivo,
        detalle: MOTIVOS_NO_FACTURABLE[motivo],
        clientes: conteos.get(motivo) ?? 0,
      }))
      .filter((m) => m.clientes > 0)
      .sort((a, b) => b.clientes - a.clientes),
  };
}

/** Veredicto de un cliente puntual (AC5). `null` si no existe. */
export async function veredictoCliente(clienteId: number): Promise<VeredictoCliente | null> {
  const [fila] = await db.select(COLUMNAS_CLIENTE_EVALUABLE).from(clients).where(eq(clients.id, clienteId)).limit(1);
  return fila ? evaluarCliente(fila as ClienteEvaluable) : null;
}

/**
 * La puerta que usará la emisión (AC4).
 *
 * Lanza en vez de devolver un booleano, por el mismo motivo que `exigirCompuertaAbierta` de la
 * HU #11285: quien va a emitir no debería poder olvidarse de mirar el resultado.
 */
export async function exigirClienteFacturable(clienteId: number): Promise<void> {
  const v = await veredictoCliente(clienteId);
  if (v === null) {
    throw new ClienteNoFacturableError(clienteId, [
      { motivo: 'identificacion_faltante', detalle: 'El cliente no existe.' },
    ]);
  }
  if (!v.facturable) throw new ClienteNoFacturableError(clienteId, v.faltantes);
}

/**
 * Marca en `clients.facturacion_bloqueos` los conflictos de identidad que aparezcan DESPUÉS de la
 * migración 0132.
 *
 * La 0132 marcó los duplicados que ya existían, pero nada volvía a mirarlos: un duplicado creado
 * más tarde —por una carrera entre dos peticiones, o por un flujo que esquive la unicidad— quedaría
 * con los bloqueos vacíos y por tanto *pareciendo* limpio. Esto lo vuelve a calcular sobre los datos
 * de hoy y es idempotente.
 */
export async function recalcularDuplicados(): Promise<{ marcados: number; desmarcados: number }> {
  const marcados = await db.update(clients)
    .set({
      facturacionBloqueos: sql`(
        SELECT array_agg(DISTINCT b)
          FROM unnest(${clients.facturacionBloqueos} || ARRAY['identificacion_duplicada']) AS b
      )`,
    })
    .where(and(
      isNotNull(clients.document),
      sql`trim(${clients.document}) <> ''`,
      sql`NOT ('identificacion_duplicada' = ANY(${clients.facturacionBloqueos}))`,
      sql`EXISTS (
        SELECT 1 FROM clients o
         WHERE o.id <> ${clients.id}
           AND o.document IS NOT NULL
           AND trim(upper(o.document)) = trim(upper(${clients.document}))
           AND o.branch_office = ${clients.branchOffice}
      )`,
    ))
    .returning({ id: clients.id });

  // Y al revés: si el conflicto se resolvió —alguien fusionó los clientes o cambió la sucursal— la
  // marca tiene que irse sola. Una marca que solo se pone y nunca se quita convierte el informe en
  // una lista de pendientes que nunca baja, y entonces nadie la mira.
  const desmarcados = await db.update(clients)
    .set({
      facturacionBloqueos: sql`array_remove(${clients.facturacionBloqueos}, 'identificacion_duplicada')`,
    })
    .where(and(
      sql`'identificacion_duplicada' = ANY(${clients.facturacionBloqueos})`,
      sql`NOT EXISTS (
        SELECT 1 FROM clients o
         WHERE o.id <> ${clients.id}
           AND o.document IS NOT NULL
           AND trim(upper(o.document)) = trim(upper(${clients.document}))
           AND o.branch_office = ${clients.branchOffice}
      )`,
    ))
    .returning({ id: clients.id });

  return { marcados: marcados.length, desmarcados: desmarcados.length };
}
