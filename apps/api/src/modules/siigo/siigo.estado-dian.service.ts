// Siigo API — estado de la factura ante la DIAN y su historial (HU #11330, Feature #11243).
//
// ============================================================================
// LA ÚNICA PUERTA DE ENTRADA
// ============================================================================
//
// `aplicarEstadoDian()` es lo que esta historia existe para construir, y su valor está en lo que
// NO sabe: de dónde viene el dato. La respuesta de la emisión, el sondeo programado, una
// notificación de Siigo y el registro que hace una persona entran todos por aquí y se diferencian
// en un campo, `fuente`. Ningún origen escribe en el historial por su cuenta (AC2).
//
// Eso no es simetría por gusto. El grupo **Webhooks** de la API de Siigo figura **sin revisar** en
// `docs/integraciones/siigo-api.md`: hoy no sabemos si notifica el estado del documento. Si mañana
// resulta que sí, el sondeo pasa a ser el respaldo, se empieza a escribir `webhook` en `fuente` y
// ningún consumidor —ni la pantalla, ni los informes, ni la bandeja— se entera del cambio. Escrita
// acoplada al sondeo, esa migración sería un rediseño de las cinco HU que cuelgan de aquí.
//
// ============================================================================
// LAS DOS COSAS QUE ESTE ARCHIVO TIENE PROHIBIDAS
// ============================================================================
//
//   1. **No toca el `estado` de `siigoFacturas`** (`en_proceso | emitida | fallida`), que pertenece
//      a la Feature #11242. Son dos ejes: si `anulada` viviera en ese campo, una factura anulada
//      dejaría de constar como emitida — y el documento existe ante la DIAN y existirá siempre.
//      Anular no deshace: añade un hecho encima.
//   2. **No añade columnas a `siigoFacturas`.** La única escritura que hace sobre esa tabla es
//      rellenar `cufe` cuando está vacío, que es el campo que la Feature de emisión ya definió para
//      él y que el AC5 manda completar.
//
// ============================================================================
// RN-01 — UN ESTADO REPETIDO NO ENSUCIA EL HISTORIAL (AC4)
// ============================================================================
//
// Si lo que llega coincide con la última fila, no se agrega otra: se adelanta su `verificadoEn`.
// El historial guarda **hechos del documento**; que el sondeo confirme por decimoquinta vez que
// sigue aceptada es una observación nuestra. Con una fila por consulta, un mes de sondeos cada
// quince minutos dejaría ~2900 filas idénticas por factura y el historial dejaría de responder la
// única pregunta para la que existe: cuándo cambió y por qué.
//
// RN-02 — El CUFE nunca se borra por omisión. Una observación que no trae CUFE no significa «no
// tiene»: significa que esa respuesta no lo traía. Si se guardara el `null`, un sondeo con una
// respuesta más escueta que la anterior parecería una fila nueva y, peor, dejaría el historial
// diciendo que el documento perdió su identificación ante la DIAN.

import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  esEstadoDian,
  esFuenteEstadoDian,
  type SiigoEstadoDian,
  type SiigoEstadoDianRegistro,
  type SiigoFuenteEstadoDian,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { siigoFacturaEstadosDian, siigoFacturas } from '../../db/schema.js';
import { registrarOperacion, sanearCuerpo } from './siigo.operaciones.repo.js';

/**
 * Falla de negocio del seguimiento DIAN. El router que la exponga la traduce a un status HTTP.
 *
 * `facturaId` va aparte del mensaje para que quien la reciba pueda mostrarlo sin recortar texto.
 */
export class SiigoEstadoDianError extends Error {
  readonly codigo: 'factura_desconocida' | 'estado_invalido' | 'fuente_invalida';
  readonly facturaId: string | null;

  constructor(
    codigo: SiigoEstadoDianError['codigo'], message: string, facturaId: string | null = null,
  ) {
    super(message);
    this.name = 'SiigoEstadoDianError';
    this.codigo = codigo;
    this.facturaId = facturaId;
  }
}

/** Lo que aporta cualquier origen. Solo `facturaId`, `estado` y `fuente` son obligatorios. */
export interface EstadoDianEntrante {
  facturaId: string;
  estado: SiigoEstadoDian;
  /** Ausente no es «no tiene» (RN-02): se conserva el último conocido. */
  cufe?: string | null;
  motivo?: string | null;
  fuente: SiigoFuenteEstadoDian;
  /** Respuesta cruda. Se sanea antes de guardarla: la clave de facturación no se persiste. */
  payload?: unknown;
  /** Solo tiene sentido con `fuente: 'manual'`. */
  registradoPor?: number | null;
}

export interface ResultadoEstadoDian {
  /** `false` = era el mismo estado y solo se refrescó la verificación (AC4). */
  cambio: boolean;
  /** `true` si esta llamada rellenó el `cufe` de la factura, que estaba vacío (AC5). */
  cufeCompletado: boolean;
  /**
   * `true` si el CUFE observado NO es el que ya tenía la factura. No se corrige ni se sobrescribe:
   * dos CUFE distintos para una misma factura es una contradicción que tiene que mirar una persona,
   * y el campo pertenece a la Feature de emisión.
   */
  cufeDiscrepante: boolean;
  /** La fila vigente tras aplicar el estado: la nueva, o la anterior si no hubo cambio. */
  registro: SiigoEstadoDianRegistro;
}

/** Formato de un uuid. Sin esto, un id malformado sale como error de sintaxis de PostgreSQL. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tope de filas del historial. Ninguna factura real se acerca; una degenerada no tumba la memoria. */
const LIMITE_HISTORIAL = 500;

type FilaEstado = typeof siigoFacturaEstadosDian.$inferSelect;

function textoONulo(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function aRegistro(f: {
  id: string; facturaId: string; secuencia: number | string; estado: string;
  cufe: string | null; motivo: string | null; fuente: string;
  createdAt: Date | string; verificadoEn: Date | string;
}): SiigoEstadoDianRegistro {
  return {
    id: f.id,
    facturaId: f.facturaId,
    // `bigserial` vuelve como cadena cuando la fila llega por SQL crudo y como número por drizzle.
    secuencia: Number(f.secuencia),
    estado: f.estado as SiigoEstadoDian,
    cufe: f.cufe,
    motivo: f.motivo,
    fuente: f.fuente as SiigoFuenteEstadoDian,
    createdAt: f.createdAt instanceof Date ? f.createdAt.toISOString() : String(f.createdAt),
    verificadoEn: f.verificadoEn instanceof Date
      ? f.verificadoEn.toISOString()
      : String(f.verificadoEn),
  };
}

/**
 * Registra el estado de una factura ante la DIAN, venga de donde venga (AC1, AC2, AC3, AC4, AC5).
 *
 * Todo ocurre dentro de una transacción que empieza tomando la fila de la factura con `FOR NO KEY
 * UPDATE`. Ese bloqueo no es decorativo: sin él, un webhook y un sondeo que llegan a la vez leen
 * los dos la misma «última fila», los dos concluyen que hay cambio y el historial acaba con dos
 * filas idénticas — exactamente lo que el AC4 prohíbe. `NO KEY` y no `UPDATE` a secas para no
 * bloquear las claves foráneas que apuntan a la factura desde `siigo_factura_tramites`.
 */
export async function aplicarEstadoDian(e: EstadoDianEntrante): Promise<ResultadoEstadoDian> {
  // Los dos catálogos se comprueban aquí y no en el borde HTTP porque esta función tiene tres
  // llamadores que no son peticiones: la emisión, el cron de sondeo y el receptor de webhooks.
  if (!esEstadoDian(e.estado)) {
    throw new SiigoEstadoDianError(
      'estado_invalido', `Estado DIAN no reconocido: ${String(e.estado)}.`, e.facturaId ?? null,
    );
  }
  if (!esFuenteEstadoDian(e.fuente)) {
    throw new SiigoEstadoDianError(
      'fuente_invalida', `Origen de estado DIAN no reconocido: ${String(e.fuente)}.`,
      e.facturaId ?? null,
    );
  }
  if (typeof e.facturaId !== 'string' || !UUID_RE.test(e.facturaId)) {
    await registrarFallo(e, 'desconocido');
    throw new SiigoEstadoDianError(
      'factura_desconocida', `No existe la factura ${String(e.facturaId)}.`, e.facturaId ?? null,
    );
  }

  const cufeEntrante = textoONulo(e.cufe);
  const motivoEntrante = textoONulo(e.motivo);
  const payload = e.payload === undefined ? null : sanearCuerpo(e.payload);

  let ambiente = 'desconocido';
  try {
    const resultado = await db.transaction(async (tx) => {
      const facturas = await tx
        .select({
          id: siigoFacturas.id, ambiente: siigoFacturas.ambiente, cufe: siigoFacturas.cufe,
        })
        .from(siigoFacturas)
        .where(eq(siigoFacturas.id, e.facturaId))
        .limit(1)
        .for('no key update');
      const factura = facturas[0];
      // AC6 — sin factura no hay historial que escribir, y el error dice cuál es el id.
      if (!factura) {
        throw new SiigoEstadoDianError(
          'factura_desconocida', `No existe la factura ${e.facturaId}.`, e.facturaId,
        );
      }
      ambiente = factura.ambiente;

      const ultimas = await tx
        .select()
        .from(siigoFacturaEstadosDian)
        .where(eq(siigoFacturaEstadosDian.facturaId, e.facturaId))
        .orderBy(desc(siigoFacturaEstadosDian.secuencia))
        .limit(1);
      const ultima: FilaEstado | undefined = ultimas[0];

      // RN-02 — el CUFE solo suma. Se hereda el último conocido, mirando primero la factura porque
      // la emisión puede haberlo guardado allí antes de que existiera fila de historial.
      const cufeEfectivo = cufeEntrante ?? factura.cufe ?? ultima?.cufe ?? null;
      // El motivo se hereda SOLO dentro del mismo estado. Arrastrar el motivo de un rechazo a la
      // fila que dice `aceptada` sería escribir una explicación falsa en el historial.
      const motivoEfectivo = motivoEntrante
        ?? (ultima && ultima.estado === e.estado ? ultima.motivo : null);

      const cufeDiscrepante = cufeEntrante !== null
        && factura.cufe !== null
        && cufeEntrante !== factura.cufe;

      // AC5 — completar, nunca sobrescribir. El `isNull` es redundante teniendo el bloqueo, y se
      // deja porque documenta la intención allí donde se ejecuta.
      let cufeCompletado = false;
      if (cufeEfectivo !== null && factura.cufe === null) {
        await tx.update(siigoFacturas)
          .set({ cufe: cufeEfectivo, updatedAt: new Date() })
          .where(and(eq(siigoFacturas.id, e.facturaId), isNull(siigoFacturas.cufe)));
        cufeCompletado = true;
      }

      // RN-01 / AC4 — mismo hecho: no se agrega fila, se adelanta la verificación.
      if (ultima
        && ultima.estado === e.estado
        && ultima.cufe === cufeEfectivo
        && ultima.motivo === motivoEfectivo) {
        const verificadoEn = new Date();
        await tx.update(siigoFacturaEstadosDian)
          .set({ verificadoEn })
          .where(eq(siigoFacturaEstadosDian.id, ultima.id));
        const refrescada: FilaEstado = { ...ultima, verificadoEn };
        return { cambio: false, cufeCompletado, cufeDiscrepante, registro: aRegistro(refrescada) };
      }

      // AC3 — un hecho nuevo es una fila más. Ninguna anterior se toca.
      const insertadas = await tx.insert(siigoFacturaEstadosDian).values({
        id: randomUUID(),
        facturaId: e.facturaId,
        estado: e.estado,
        cufe: cufeEfectivo,
        motivo: motivoEfectivo,
        fuente: e.fuente,
        payload,
        registradoPor: e.registradoPor ?? null,
      }).returning();

      return {
        cambio: true,
        cufeCompletado,
        cufeDiscrepante,
        registro: aRegistro(insertadas[0]!),
      };
    });

    await registrarOperacion({
      operacion: 'estado_dian.aplicar',
      entidadTipo: 'siigo_factura',
      entidadId: e.facturaId,
      ambiente,
      resultado: 'ok',
      codigo: e.estado,
      // Se registra TAMBIÉN la repetición que no produjo fila: es la única forma de saber después
      // que el sondeo estuvo funcionando y no que se quedó callado.
      mensaje: resultado.cambio
        ? `Estado DIAN ${e.estado} registrado (origen ${e.fuente}).`
        : `Estado DIAN ${e.estado} confirmado sin cambio (origen ${e.fuente}).`,
      responseBody: payload,
      createdBy: e.registradoPor ?? null,
    });

    return resultado;
  } catch (err) {
    if (err instanceof SiigoEstadoDianError) await registrarFallo(e, ambiente);
    throw err;
  }
}

/**
 * Deja constancia del rechazo. Va aparte porque el AC6 se puede alcanzar antes de saber el
 * ambiente —cuando el id ni siquiera es un uuid— y la bitácora tiene que escribirse igual: un
 * webhook que apunta a una factura que no conocemos es justo lo que hay que poder investigar.
 */
async function registrarFallo(e: EstadoDianEntrante, ambiente: string): Promise<void> {
  await registrarOperacion({
    operacion: 'estado_dian.aplicar',
    entidadTipo: 'siigo_factura',
    entidadId: typeof e.facturaId === 'string' ? e.facturaId.slice(0, 60) : null,
    ambiente,
    resultado: 'error_negocio',
    codigo: 'factura_desconocida',
    mensaje: `Se intentó registrar el estado DIAN ${String(e.estado)} sobre una factura que no existe (origen ${String(e.fuente)}).`,
    createdBy: e.registradoPor ?? null,
  });
}

/**
 * El estado vigente: la última fila (AC1). `null` si la factura nunca se ha consultado.
 *
 * AC7 — sale de la base de datos. Ninguna lectura de este archivo llama a Siigo, y es deliberado:
 * la pantalla y los informes preguntan constantemente, y Siigo bloquea el usuario API si durante
 * siete días más del 80 % de las peticiones fallan o exceden las 100 por minuto.
 */
export async function estadoDianVigente(facturaId: string): Promise<SiigoEstadoDianRegistro | null> {
  if (!UUID_RE.test(facturaId)) return null;
  const filas = await db
    .select()
    .from(siigoFacturaEstadosDian)
    .where(eq(siigoFacturaEstadosDian.facturaId, facturaId))
    .orderBy(desc(siigoFacturaEstadosDian.secuencia))
    .limit(1);
  return filas[0] ? aRegistro(filas[0]) : null;
}

/**
 * El historial completo, del más antiguo al más reciente (AC1, AC7).
 *
 * Ascendente porque la pregunta que se le hace —«¿cuándo pasó a rechazada y por qué?»— se lee como
 * una historia, y una historia se lee empezando por el principio.
 */
export async function historialEstadoDian(
  facturaId: string, limite = LIMITE_HISTORIAL,
): Promise<SiigoEstadoDianRegistro[]> {
  if (!UUID_RE.test(facturaId)) return [];
  const filas = await db
    .select()
    .from(siigoFacturaEstadosDian)
    .where(eq(siigoFacturaEstadosDian.facturaId, facturaId))
    .orderBy(siigoFacturaEstadosDian.secuencia)
    .limit(Math.min(limite, LIMITE_HISTORIAL));
  return filas.map(aRegistro);
}

/** El SQL crudo devuelve las columnas tal cual: `snake_case` y `bigserial` como cadena. */
type FilaCruda = Record<string, unknown> & {
  id: string; factura_id: string; secuencia: string; estado: string;
  cufe: string | null; motivo: string | null; fuente: string;
  created_at: Date; verificado_en: Date;
};

/**
 * El estado vigente de VARIAS facturas de una vez (AC7).
 *
 * Existe para que la bandeja no haga una consulta por fila. `DISTINCT ON` va en SQL porque el
 * constructor de drizzle no lo tiene; la lista de ids entra por `inArray`, es decir, parametrizada:
 * aquí no se concatena un identificador dentro de la sentencia.
 */
export async function estadosDianVigentes(
  facturaIds: string[],
): Promise<Map<string, SiigoEstadoDianRegistro>> {
  const ids = [...new Set(facturaIds.filter((i) => UUID_RE.test(i)))];
  const salida = new Map<string, SiigoEstadoDianRegistro>();
  if (ids.length === 0) return salida;

  const filas = await db.execute<FilaCruda>(sql`
    SELECT DISTINCT ON (factura_id)
           id, factura_id, secuencia, estado, cufe, motivo, fuente, created_at, verificado_en
      FROM siigo_factura_estados_dian
     WHERE ${inArray(siigoFacturaEstadosDian.facturaId, ids)}
     ORDER BY factura_id, secuencia DESC
  `);

  for (const f of filas as unknown as FilaCruda[]) {
    salida.set(f.factura_id, aRegistro({
      id: f.id, facturaId: f.factura_id, secuencia: f.secuencia, estado: f.estado,
      cufe: f.cufe, motivo: f.motivo, fuente: f.fuente,
      createdAt: f.created_at, verificadoEn: f.verificado_en,
    }));
  }
  return salida;
}
