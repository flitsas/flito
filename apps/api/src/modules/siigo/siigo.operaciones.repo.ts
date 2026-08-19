// Siigo API — bitácora WORM de operaciones (HU #11251).
//
// Este módulo expone SOLO inserción y consulta. No hay `actualizar` ni `borrar`, y no por olvido:
// la tabla los prohíbe con disparadores, así que ofrecerlos aquí solo produciría una excepción de
// base de datos con peor mensaje. La capa de aplicación refuerza lo que la base ya garantiza.
//
// El saneamiento es lo que hace la bitácora publicable: se registra lo suficiente para reconstruir
// qué pasó, sin dejar por escrito la clave con la que se factura ante la DIAN. Va sobre los DOS
// cuerpos y también sobre `mensaje`: hasta la auditoría de la HU #11281, `mensaje` se insertaba tal
// cual, y un error de Postgres envuelto por drizzle ≥ 0.45 llega con la sentencia entera y sus
// parámetros dentro (`Failed query: … params: …`). En una tabla que prohíbe UPDATE y DELETE por
// disparador, un dato personal escrito por error ya no se puede rectificar ni suprimir (Ley 1581,
// art. 8), así que el filtro tiene que estar ANTES del INSERT y no depender de quién llame.

import { and, asc, count, desc, eq, gte, lte, notInArray, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { siigoOperaciones } from '../../db/schema.js';
import { detalleTecnico, sanearMensaje } from './siigo.redaccion.js';

export type ResultadoOperacion = 'ok' | 'error_negocio' | 'error_tecnico' | 'timeout';

/**
 * Claves que jamás se persisten. `access_key` es el secreto de la credencial; `Authorization` y
 * `token` son el portador. Se comparan en minúsculas para que `Access_Key` tampoco se cuele.
 */
const CLAVES_PROHIBIDAS = new Set([
  'access_key', 'accesskey', 'authorization', 'token', 'access_token', 'password', 'clave',
]);

const MARCA_REDACTADO = '[REDACTED]';

/**
 * Copia el cuerpo reemplazando por una marca el valor de toda clave sensible, a cualquier
 * profundidad. Devuelve una estructura nueva: no muta lo que le pasan.
 */
export function sanearCuerpo(valor: unknown, profundidad = 0): unknown {
  // Tope de profundidad: corta ciclos y estructuras absurdas sin necesitar un Set de visitados.
  if (profundidad > 8) return '[…]';
  if (Array.isArray(valor)) return valor.map((v) => sanearCuerpo(v, profundidad + 1));
  if (valor === null || typeof valor !== 'object') return valor;

  const salida: Record<string, unknown> = {};
  for (const [clave, v] of Object.entries(valor as Record<string, unknown>)) {
    salida[clave] = CLAVES_PROHIBIDAS.has(clave.toLowerCase())
      ? MARCA_REDACTADO
      : sanearCuerpo(v, profundidad + 1);
  }
  return salida;
}

export interface RegistroOperacion {
  operacion: string;
  metodo?: string | null;
  ruta?: string | null;
  entidadTipo?: string | null;
  entidadId?: string | null;
  intento?: number;
  ambiente: string;
  modo?: string;
  requestBody?: unknown;
  responseBody?: unknown;
  statusHttp?: number | null;
  resultado: ResultadoOperacion;
  codigo?: string | null;
  mensaje?: string | null;
  duracionMs?: number | null;
  createdBy?: number | null;
}

/**
 * Escribe una fila en la bitácora.
 *
 * NUNCA lanza. Es deliberado: cuando esto se llama, la operación contra Siigo ya ocurrió — la
 * factura ya se emitió o ya falló. Dejar que un problema de base de datos al registrar tumbe ese
 * resultado convertiría un fallo de bitácora en un fallo de negocio, que es mucho peor.
 */
export async function registrarOperacion(r: RegistroOperacion): Promise<void> {
  try {
    await db.insert(siigoOperaciones).values({
      operacion: r.operacion,
      metodo: r.metodo ?? null,
      ruta: r.ruta ?? null,
      entidadTipo: r.entidadTipo ?? null,
      entidadId: r.entidadId ?? null,
      intento: r.intento ?? 1,
      ambiente: r.ambiente,
      modo: r.modo ?? 'real',
      requestBody: r.requestBody === undefined ? null : sanearCuerpo(r.requestBody),
      responseBody: r.responseBody === undefined ? null : sanearCuerpo(r.responseBody),
      statusHttp: r.statusHttp ?? null,
      resultado: r.resultado,
      codigo: r.codigo ?? null,
      // Segunda línea de defensa: quien llama debería mandar ya un mensaje de dominio, pero si
      // alguna vez llega el `message` crudo de un error del motor, la sentencia se queda fuera.
      mensaje: r.mensaje === null || r.mensaje === undefined ? null : sanearMensaje(r.mensaje),
      duracionMs: r.duracionMs ?? null,
      createdBy: r.createdBy ?? null,
    });
  } catch (e) {
    // `detalleTecnico` y no `e.message`: si el INSERT falla, drizzle envuelve el error con la
    // sentencia y sus parámetros —que aquí son el propio contenido de la fila— y esto acabaría
    // volcando al log justo lo que la bitácora sanea.
    console.error('[siigo] no se pudo registrar la operación en la bitácora', {
      operacion: r.operacion, resultado: r.resultado, err: detalleTecnico(e),
    });
  }
}

export interface FiltroBitacora {
  entidadTipo?: string;
  entidadId?: string;
  resultado?: ResultadoOperacion;
  desde?: Date;
  hasta?: Date;
  limite?: number;
}

/** Tope duro: una consulta sin filtros no puede traerse la bitácora entera a memoria. */
const LIMITE_MAXIMO = 500;

export async function consultarBitacora(f: FiltroBitacora = {}) {
  const conds: SQL[] = [];
  if (f.entidadTipo) conds.push(eq(siigoOperaciones.entidadTipo, f.entidadTipo));
  if (f.entidadId) conds.push(eq(siigoOperaciones.entidadId, f.entidadId));
  if (f.resultado) conds.push(eq(siigoOperaciones.resultado, f.resultado));
  if (f.desde) conds.push(gte(siigoOperaciones.createdAt, f.desde));
  if (f.hasta) conds.push(lte(siigoOperaciones.createdAt, f.hasta));

  const limite = Math.min(f.limite ?? 100, LIMITE_MAXIMO);

  return db.select().from(siigoOperaciones)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(siigoOperaciones.createdAt))
    .limit(limite);
}

// ── Agregados de la bitácora (HU #11341) ────────────────────────────────────
//
// Las dos consultas que siguen son de SOLO LECTURA y viven aquí, y no en quien las usa, porque este
// es el único módulo que toca `siigo_operaciones`: que el acceso a la tabla esté en un sitio es lo
// que permite razonar sobre qué se escribe y qué nunca se escribe. La invariante del módulo sigue
// intacta —no hay `actualizar` ni `borrar`, y no los habrá— y hay un test que la vigila.
//
// El freno se calcula sobre estas dos consultas y sobre nada más: NO hay tabla nueva ni contador
// paralelo (AC1). El índice `idx_siigo_op_resultado` sobre `(resultado, created_at)` es el que hace
// barato el agrupado.

export interface ConteoPorResultado {
  resultado: ResultadoOperacion;
  total: number;
}

export interface FiltroConteo {
  ambiente: string;
  /** `real` o `mock`. Obligatorio: mezclar los dos modos falsea cualquier medición (AC1). */
  modo: string;
  desde: Date;
  hasta?: Date;
  /**
   * Operaciones que NO deben contarse. Es lo que impide la realimentación del freno: el propio
   * rechazo se registra en la bitácora, y si contara como una operación más, un freno activo se
   * mantendría a sí mismo indefinidamente sin que Siigo tenga nada que ver.
   */
  excluir?: readonly string[];
}

/** Operaciones agrupadas por resultado dentro de una ventana. */
export async function contarPorResultado(f: FiltroConteo): Promise<ConteoPorResultado[]> {
  const conds: SQL[] = [
    eq(siigoOperaciones.ambiente, f.ambiente),
    eq(siigoOperaciones.modo, f.modo),
    gte(siigoOperaciones.createdAt, f.desde),
  ];
  if (f.hasta) conds.push(lte(siigoOperaciones.createdAt, f.hasta));
  if (f.excluir && f.excluir.length > 0) {
    conds.push(notInArray(siigoOperaciones.operacion, [...f.excluir]));
  }

  const filas = await db
    .select({ resultado: siigoOperaciones.resultado, total: count() })
    .from(siigoOperaciones)
    .where(and(...conds))
    .groupBy(siigoOperaciones.resultado);

  // `count()` llega como cadena por el driver de Postgres cuando el total desborda un int32.
  // `Number(...)` aquí y no en quien consume: una proporción calculada sobre cadenas da NaN.
  return filas.map((r) => ({
    resultado: r.resultado as ResultadoOperacion,
    total: Number(r.total),
  }));
}

/** Cuándo y por quién quedó registrada una operación concreta. */
export interface MarcaOperacion {
  createdAt: Date;
  createdBy: number | null;
}

/**
 * Primera o última vez que se registró una operación dada.
 *
 * Es lo que convierte la bitácora en el registro de quién reactivó la integración y cuándo (AC4),
 * sin necesidad de una tabla de estado: el hecho ya está escrito, y en una tabla que nadie puede
 * editar ni borrar.
 */
export async function marcaDeOperacion(f: {
  operacion: string;
  ambiente: string;
  modo: string;
  desde?: Date;
  orden: 'primera' | 'ultima';
}): Promise<MarcaOperacion | null> {
  const conds: SQL[] = [
    eq(siigoOperaciones.operacion, f.operacion),
    eq(siigoOperaciones.ambiente, f.ambiente),
    eq(siigoOperaciones.modo, f.modo),
  ];
  if (f.desde) conds.push(gte(siigoOperaciones.createdAt, f.desde));

  const filas = await db
    .select({ createdAt: siigoOperaciones.createdAt, createdBy: siigoOperaciones.createdBy })
    .from(siigoOperaciones)
    .where(and(...conds))
    .orderBy(f.orden === 'primera'
      ? asc(siigoOperaciones.createdAt)
      : desc(siigoOperaciones.createdAt))
    .limit(1);

  return filas[0] ?? null;
}
