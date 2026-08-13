// Siigo — sondeo del estado ante la DIAN (HU #11332, Feature #11243).
//
// La DIAN no responde en el instante en que se emite. Entre el «enviado» y el «aceptada» pasan
// minutos u horas, así que enterarse de un rechazo exige volver a mirar. Sin este ciclo, alguien
// tendría que acordarse de preguntar — y «se revisó lo que alguien se acordó de revisar» no es un
// seguimiento.
//
// CUATRO DECISIONES QUE SOSTIENEN ESTE ARCHIVO
//
//   1. **Este archivo NO escribe en el historial.** Traduce lo que contesta Siigo y se lo entrega a
//      `aplicarEstadoDian`, que es la única puerta de ingesta (AC1). Esa función tiene el bloqueo de
//      fila que impide que un webhook y este sondeo, llegando a la vez, dejen dos filas idénticas.
//      Un `INSERT` directo desde aquí saltaría esa protección justo en el caso concurrente.
//   2. **La cuota se comparte, y compartirla es lo correcto** (AC2). El límite de 100 peticiones por
//      minuto es de la EMPRESA, no del endpoint, así que este ciclo usa la MISMA clave de limitador
//      que la emisión. Darle una clave propia no crearía cuota nueva: crearía la ilusión de tenerla,
//      y el que se quedaría sin turnos sería el que factura. Lo que sí es propio es el cortacircuitos.
//   3. **El presupuesto por ciclo es el freno de verdad.** Aunque el limitador reparta turnos, un
//      ciclo sin tope consultaría cientos de facturas y `esperarTurno` no rechaza cuando la ventana
//      está llena: DUERME. Un sondeo sin presupuesto no se nota como error, se nota como una emisión
//      que va lenta y nadie sabe por qué.
//   4. **Que Siigo falle no significa que la DIAN rechace** (AC6). Un timeout es una respuesta que no
//      llegó, no una respuesta negativa. Ante cualquier fallo el estado se queda como estaba, el
//      motivo va a la bitácora y la factura vuelve a salir en un ciclo posterior.

import { sql } from 'drizzle-orm';
import {
  esEstadoDianFinal,
  traducirEstadoStamp,
  type SiigoEstadoDian,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { loggerFor } from '../../shared/logger.js';
import { siigoRequestOrThrow } from './siigo.client.js';
import { claveResiliencia } from './siigo.catalogos.service.js';
import { aplicarEstadoDian } from './siigo.estado-dian.service.js';
import { resolverMotivoDeRechazo } from './siigo.motivo-rechazo.service.js';
import { modoSiigo } from './siigo.mock.js';
import { registrarOperacion } from './siigo.operaciones.repo.js';
import { motivoLegible } from './siigo.productos.service.js';
import { detalleTecnico } from './siigo.redaccion.js';
import { ejecutarConResiliencia } from './siigo.resiliencia.js';
import type { SiigoAmbiente } from './credenciales.service.js';

const log = loggerFor('siigo.sondeo-dian');

/** Consultar el estado es una petición pequeña. Muy por debajo de los 120 s de una emisión. */
export const TIMEOUT_SONDEO_MS = 15_000;

/**
 * Cuántas facturas mira un ciclo, por defecto.
 *
 * Configurable por entorno (AC2) porque el número correcto depende del volumen de cada instalación,
 * y el valor que sirve en desarrollo asfixiaría una empresa que emite cien facturas al día. Veinte
 * es conservador: a un ciclo cada cinco minutos son 240 consultas por hora, holgadamente dentro de
 * la cuota incluso compartiéndola con la emisión.
 */
export const PRESUPUESTO_POR_CICLO = 20;

/** Circuito propio. Que la consulta de estado esté caída no puede impedir emitir. */
export function claveCortacircuitosSondeo(ambiente: string): string {
  return `siigo:sondeo-dian:${ambiente}`;
}

/**
 * Cada cuánto se vuelve a preguntar por una factura, según lo que lleva emitida (AC4).
 *
 * **La edad hace de contador de intentos, y es mejor que un contador.** Con un ciclo periódico, el
 * número de veces que se ha consultado una factura es proporcional a su antigüedad, así que la edad
 * dice lo mismo — pero es un dato que no hay que mantener, no se puede desincronizar, no necesita
 * columna y no hay que acordarse de reponerlo cuando una factura cambia de estado. Un contador
 * persistido tendría que actualizarse en cada intento, incluidos los que fallan, y un contador que
 * se olvida de subir convierte el sondeo en un bucle.
 *
 * La curva sale de cómo se comporta la DIAN: lo normal es que resuelva en minutos. Una factura de
 * hace dos días que sigue sin resolverse casi seguro necesita que la mire una persona, no que se le
 * pregunte otra vez cada cinco minutos gastando la cuota de las que sí están saliendo.
 */
export function intervaloDeSondeoMs(edadMs: number): number {
  const MINUTO = 60_000;
  if (edadMs < 60 * MINUTO) return 5 * MINUTO;
  if (edadMs < 6 * 60 * MINUTO) return 30 * MINUTO;
  if (edadMs < 24 * 60 * MINUTO) return 2 * 60 * MINUTO;
  // Tope. Sin él, una factura atascada acabaría consultándose una vez al año.
  return 6 * 60 * MINUTO;
}

/** Una factura que toca sondear, con lo mínimo para hacerlo. */
export interface FacturaPorSondear {
  id: string;
  ambiente: string;
  siigoInvoiceId: string;
  numero: string | null;
  estadoDian: SiigoEstadoDian | null;
}

/**
 * A quién le toca (AC3, AC4).
 *
 * La consulta pregunta por facturas emitidas cuyo estado ante la DIAN **no es definitivo**: o no
 * tienen ninguno todavía, o el vigente es `en_validacion`. Las aceptadas, rechazadas y anuladas
 * quedan fuera del `WHERE` — no es que se salten dentro del bucle: no se traen, así que no gastan
 * presupuesto ni una sola comparación (AC3).
 *
 * El orden es por fecha de emisión descendente: **las recién emitidas primero**. Es lo que pide el
 * AC4 y también lo que quiere quien opera — la que acaba de salir es la que alguien está mirando.
 * Una antigua atascada esperará al siguiente ciclo, que es exactamente lo que merece.
 */
export async function facturasPorSondear(presupuesto: number): Promise<FacturaPorSondear[]> {
  const ahora = Date.now();

  // SQL crudo, como el cron de RNDC hace para su selección de lote. Un `DISTINCT ON` con join es
  // más claro escrito que compuesto, y aquí importa poder leer de un vistazo QUIÉN entra: es la
  // mitad del AC3 y toda la prioridad del AC4.
  //
  // `secuencia` y no fecha para elegir la fila vigente: dos filas de la misma transacción comparten
  // el `now()` de PostgreSQL, así que el desempate por fecha sería un empate.
  //
  // Se piden más filas de las que caben en el presupuesto porque el filtro de CADENCIA se aplica
  // abajo, en TypeScript. Reproducir la curva de `intervaloDeSondeoMs` dentro del SQL crearía dos
  // definiciones de la misma regla que alguien tendría que mantener iguales; el tope acotado evita
  // que «más» signifique «todas».
  const holgura = Math.max(presupuesto * 5, presupuesto);
  const filas = await db.execute<{
    id: string; ambiente: string; siigo_invoice_id: string; numero: string | null;
    estado_dian: string | null; verificado_en: string | null; created_at: string;
  }>(sql`
    WITH vigente AS (
      SELECT DISTINCT ON (factura_id) factura_id, estado, verificado_en
        FROM siigo_factura_estados_dian
       ORDER BY factura_id, secuencia DESC
    ),
    -- Último INTENTO, salga bien o mal. La columna verificado_en solo avanza cuando la consulta
    -- tuvo éxito, así que usarla sola dejaría fuera de la cadencia justo a las que fallan — y esas
    -- son las únicas que nunca se resuelven. Se reconsultarían cada ciclo para siempre, gastando la
    -- cuota que comparte con la emisión: el consumo que el AC2 quiere evitar, entrando por detrás.
    ultimo_intento AS (
      SELECT entidad_id, max(created_at) AS intentado_en
        FROM siigo_operaciones
       WHERE operacion = 'dian_sondeo_estado'
         AND entidad_tipo = 'siigo_factura'
       GROUP BY entidad_id
    )
    SELECT f.id,
           f.ambiente,
           f.siigo_invoice_id,
           f.numero,
           v.estado AS estado_dian,
           -- El ancla es lo MÁS RECIENTE de las dos: da igual si el último contacto acabó en éxito
           -- o en fallo, lo que importa es cuándo se molestó a Siigo por última vez.
           GREATEST(v.verificado_en, i.intentado_en) AS verificado_en,
           f.created_at
      FROM siigo_facturas f
      LEFT JOIN vigente v ON v.factura_id = f.id
      LEFT JOIN ultimo_intento i ON i.entidad_id = f.id::text
     WHERE f.estado = 'emitida'
       -- Solo producción timbra (ver efectosExternosPermitidos en siigo.config.ts), así que solo
       -- producción tiene un estado ante la DIAN que consultar. Sin esta condición, cada factura de
       -- pruebas o QA cumpliría el predicado de abajo PARA SIEMPRE —nunca va a tener estado, porque
       -- nunca se envió— y entraría en todos los ciclos. Y no sería gratis: el presupuesto por
       -- ciclo se comparte con la emisión, y el ORDER BY de más abajo prioriza justamente lo que
       -- nunca se ha consultado. Las de QA desplazarían a las de producción de su propio sondeo.
       AND f.ambiente = 'produccion'
       AND f.siigo_invoice_id IS NOT NULL
       AND btrim(f.siigo_invoice_id) <> ''
       -- AC3: solo lo que no está resuelto. Las aceptadas, rechazadas y anuladas no se traen, así
       -- que no gastan presupuesto ni una sola comparación. El IS NULL es la factura que aún no
       -- tiene historial, que es justamente la recién emitida.
       AND (v.estado IS NULL OR v.estado = 'en_validacion')
     -- AC4, y sin inanición. Las que nunca se han consultado van primero, y ahí entran por
     -- definición las recién emitidas — que es la prioridad que pide el AC4. Después, la que lleva
     -- más tiempo sin mirarse. Ordenar solo por fecha de emisión descendente parecía cumplir el AC,
     -- pero con más facturas sin resolver que holgura tiene la ventana, las antiguas no entrarían
     -- NUNCA: se quedarían sin sondear para siempre por estar detrás de otras en enfriamiento.
     ORDER BY GREATEST(v.verificado_en, i.intentado_en) ASC NULLS FIRST, f.created_at DESC
     LIMIT ${holgura}
  `);

  const enMs = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const t = v instanceof Date ? v.getTime() : new Date(String(v)).getTime();
    return Number.isNaN(t) ? null : t;
  };

  const toca: FacturaPorSondear[] = [];
  for (const f of filas as unknown as Array<Record<string, unknown>>) {
    if (toca.length >= presupuesto) break;

    const ultimaVerificacion = enMs(f.verificado_en ?? f.verificadoEn);
    // Sin verificación previa toca siempre: es la primera vez que se pregunta por ella.
    if (ultimaVerificacion !== null) {
      const emitidaEn = enMs(f.created_at ?? f.createdAt) ?? ahora;
      if (ahora - ultimaVerificacion < intervaloDeSondeoMs(ahora - emitidaEn)) continue;
    }

    toca.push({
      id: String(f.id),
      ambiente: String(f.ambiente),
      siigoInvoiceId: String(f.siigo_invoice_id ?? f.siigoInvoiceId),
      numero: (f.numero as string | null) ?? null,
      estadoDian: ((f.estado_dian ?? f.estadoDian) as SiigoEstadoDian | null) ?? null,
    });
  }
  return toca;
}

/**
 * Lo único de la respuesta que se guarda: lo que justifica la decisión.
 *
 * **Lista blanca, y tiene que serlo.** El `payload` acaba en `siigo_factura_estados_dian.payload` y
 * en `siigo_operaciones.response_body`, y las dos tablas son inmutables por disparador y no están
 * en el flujo de olvido. La respuesta completa de `GET /v1/invoices/{id}` incluye el bloque
 * `customer` —con la identificación del tercero, que es dato personal cuando el cliente es persona
 * natural— y una `public_url`, que es un enlace **sin autenticación** a la vista del documento.
 * Escribir eso ahí crearía datos personales que después nadie puede rectificar ni suprimir.
 *
 * El saneamiento que ya existe no basta y no es su culpa: `sanearCuerpo` es una lista NEGRA de
 * claves de credenciales (`access_key`, `authorization`, `token`…). Ninguna lista negra puede
 * anticipar los campos que un proveedor añada mañana a su respuesta. Una lista blanca sí: lo que no
 * se nombra aquí no se guarda, y añadir un campo exige decidirlo.
 *
 * Lo que queda es exactamente lo que hace falta para reconstruir por qué el estado cambió.
 */
export function soloLoQueJustificaLaDecision(datos: unknown): Record<string, unknown> {
  const d = (datos ?? {}) as Record<string, unknown>;
  const stamp = (d.stamp ?? null) as Record<string, unknown> | null;
  return {
    id: d.id ?? null,
    name: d.name ?? null,
    date: d.date ?? null,
    cufe: d.cufe ?? null,
    stamp: stamp ? { send: stamp.send ?? null, status: stamp.status ?? null } : null,
  };
}

/** Cómo acabó el sondeo de una factura. Nombres, no booleanos: la bitácora los distingue. */
export type DesenlaceSondeo = 'sin_cambio' | 'actualizado' | 'ilegible' | 'fallo';

/**
 * Sondea UNA factura y entrega el resultado por la puerta de ingesta (AC1, AC6, AC7).
 *
 * No lanza nunca: un ciclo que se cae en la factura número tres deja sin mirar las diecisiete
 * siguientes, y el motivo por el que falló esa tercera casi nunca aplica a las demás.
 */
export async function sondearFactura(f: FacturaPorSondear): Promise<DesenlaceSondeo> {
  try {
    return await sondearFacturaInterno(f);
  } catch (e) {
    // La promesa de la cabecera —«no lanza nunca»— tiene que valer para TODO, no solo para la
    // llamada HTTP. La ingesta puede reventar por un error de base, por una transacción abortada o
    // porque la factura desapareció entre la selección y la escritura; cualquiera de esas abortaría
    // el ciclo y dejaría sin mirar las facturas restantes del presupuesto.
    log.error({ err: detalleTecnico(e), facturaId: f.id }, 'sondeo de factura falló de forma inesperada');
    return 'fallo';
  }
}

async function sondearFacturaInterno(f: FacturaPorSondear): Promise<DesenlaceSondeo> {
  const bitacora = (resultado: 'ok' | 'error_negocio' | 'error_tecnico', mensaje: string) =>
    registrarOperacion({
      ambiente: f.ambiente,
      operacion: 'dian_sondeo_estado',
      resultado,
      mensaje,
      // AC7 — la bitácora distingue lo simulado de lo real. Sin esto, un ensayo en desarrollo y una
      // consulta de producción se leen igual en la misma tabla. La columna ya existe desde la 0126;
      // lo que faltaba era que este flujo la rellenara en vez de dejar el 'real' por defecto.
      modo: modoSiigo(),
      entidadTipo: 'siigo_factura',
      entidadId: f.id,
    });

  let datos: unknown;
  try {
    datos = await ejecutarConResiliencia(
      () => siigoRequestOrThrow<unknown>({
        metodo: 'GET',
        ruta: `/v1/invoices/${encodeURIComponent(f.siigoInvoiceId)}`,
        ambiente: f.ambiente as SiigoAmbiente,
        timeoutMs: TIMEOUT_SONDEO_MS,
      }),
      {
        // AC2 — la MISMA clave que la emisión: es la cuota real de la empresa.
        clave: claveResiliencia(f.ambiente),
        claveCortacircuitos: claveCortacircuitosSondeo(f.ambiente),
      },
    );
  } catch (e) {
    // AC6 — que Siigo falle no es que la DIAN rechace. El estado NO se toca.
    //
    // El resultado se clasifica en vez de aplanarlo todo a `error_tecnico`: una factura que Siigo ya
    // no reconoce es un problema de DATOS —de esa factura, y solo de esa—, no una caída del
    // servicio. Aplanarlas juntas haría que una sola factura fantasma pareciera una degradación
    // general, que es una lectura falsa para quien mire la bitácora buscando por qué algo va mal.
    const deDatos = (e as { requiereCorreccionDeDatos?: boolean } | null)?.requiereCorreccionDeDatos === true;
    log.warn({ err: detalleTecnico(e), facturaId: f.id, deDatos }, 'sondeo del estado DIAN falló');
    await bitacora(
      deDatos ? 'error_negocio' : 'error_tecnico',
      `No se pudo consultar el estado de la factura ${f.numero ?? f.id}: ${motivoLegible(e)}`,
    );
    return 'fallo';
  }

  const cuerpo = (datos ?? {}) as { stamp?: { status?: unknown }; cufe?: unknown };
  const estado = traducirEstadoStamp(cuerpo.stamp?.status);

  if (estado === null) {
    // Lo desconocido no se convierte en un estado. Ver `traducirEstadoStamp`: adivinar aquí
    // marcaría como rechazada una factura aceptada, y esa mentira se propaga a un reporte.
    await bitacora('error_negocio',
      `Siigo devolvió un estado de sello que FLITO no sabe interpretar para la factura ${f.numero ?? f.id}. `
      + 'El estado ante la DIAN se deja como estaba.');
    return 'ilegible';
  }

  const cufe = typeof cuerpo.cufe === 'string' && cuerpo.cufe.trim() !== '' ? cuerpo.cufe.trim() : null;

  // HU #11333 — un rechazo se explica en el mismo momento en que se detecta. Resolverlo aquí, y no
  // esperar al barrido, es lo que hace que la PRIMERA fila del historial que dice «rechazada» ya
  // diga también por qué: si no, quedaría un hueco visible en la pantalla entre que se detecta y se
  // explica, y ese hueco es justo cuando alguien va a mirar. El barrido sigue existiendo para las
  // que se queden pendientes.
  const motivo = estado === 'rechazada'
    ? (await resolverMotivoDeRechazo(f)).motivo
    : null;

  // AC1 — se entrega por la puerta de ingesta. Este archivo no escribe en el historial.
  const r = await aplicarEstadoDian({
    facturaId: f.id,
    estado,
    cufe,
    motivo,
    fuente: 'sondeo',
    payload: soloLoQueJustificaLaDecision(datos),
  });

  if (r.cufeDiscrepante) {
    await bitacora('error_negocio',
      `La factura ${f.numero ?? f.id} devolvió un CUFE distinto del que ya tenía. No se sobrescribe.`);
  }
  if (r.cambio) {
    await bitacora('ok', `La factura ${f.numero ?? f.id} pasó a «${estado}» ante la DIAN.`);
  }
  return r.cambio ? 'actualizado' : 'sin_cambio';
}

export interface ResumenCicloSondeo {
  consultadas: number;
  actualizadas: number;
  sinCambio: number;
  ilegibles: number;
  fallos: number;
  /** Las que estaban en la lista y se quedaron sin mirar por agotarse el plazo del ciclo. */
  abandonadas: number;
}

/**
 * Un ciclo completo (AC2, AC3).
 *
 * Secuencial y no en paralelo: el limitador reparte turnos de la cuota de la empresa, y lanzar
 * veinte consultas a la vez solo consigue que diecinueve se queden dormidas dentro de
 * `esperarTurno` reteniendo conexiones. En serie tardan lo mismo y no ocupan nada mientras esperan.
 */
export async function sondearEstadosDian(
  presupuesto = PRESUPUESTO_POR_CICLO,
  opciones: { plazoMs?: number; ahora?: () => number } = {},
): Promise<ResumenCicloSondeo> {
  const resumen: ResumenCicloSondeo = {
    consultadas: 0, actualizadas: 0, sinCambio: 0, ilegibles: 0, fallos: 0, abandonadas: 0,
  };
  const ahora = opciones.ahora ?? Date.now;
  const limite = opciones.plazoMs ? ahora() + opciones.plazoMs : null;

  const pendientes = await facturasPorSondear(presupuesto);
  for (const f of pendientes) {
    // El presupuesto acota CUÁNTAS; el plazo acota CUÁNTO TIEMPO. Hacen falta los dos: con el
    // limitador durmiendo, veinte facturas pueden tardar más que el cerrojo que protege el ciclo.
    // Lo que se deja sin mirar no se pierde — sale primero en el siguiente, por el orden de la
    // consulta. Se cuenta aparte para que un ciclo que se rinde no se lea como uno que terminó.
    if (limite !== null && ahora() >= limite) {
      resumen.abandonadas = pendientes.length - resumen.consultadas;
      break;
    }
    const d = await sondearFactura(f);
    resumen.consultadas += 1;
    if (d === 'actualizado') resumen.actualizadas += 1;
    else if (d === 'sin_cambio') resumen.sinCambio += 1;
    else if (d === 'ilegible') resumen.ilegibles += 1;
    else resumen.fallos += 1;
  }
  return resumen;
}

/** Reexportado para los tests: el estado final es el que hace que una factura deje de sondearse. */
export { esEstadoDianFinal };
