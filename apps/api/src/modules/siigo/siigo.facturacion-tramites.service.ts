// Siigo — la ficha de facturación de un trámite, tal como la pinta el reporte (HU #11337).
//
// Cruza las tres piezas que las historias anteriores dejaron por separado y con razón: la emisión
// (Feature #11242), el estado ante la DIAN con su motivo (#11330, #11332, #11333) y el envío por
// correo (#11334). Ninguna de ellas debía conocer a las otras; la pantalla sí, y este es el único
// sitio donde se juntan.
//
// **Ni una petición a Siigo.** Todo sale de tablas locales. La pantalla se abre constantemente y la
// cuota de 100 peticiones por minuto la comparte con la emisión: si mirar el reporte gastara cuota,
// mirar frenaría facturar.

import { sql } from 'drizzle-orm';
import {
  esMotivoPendiente,
  type SiigoEstadoDian,
  type SiigoEstadoReporte,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { efectosExternosPermitidos } from './siigo.config.js';
import type { SiigoAmbiente } from './credenciales.service.js';

/** Tope de trámites por consulta. El reporte pinta 200 por página; el doble sobra y acota el abuso. */
export const TOPE_TRAMITES_CONSULTA = 400;

/** Lo que la pantalla necesita saber de la factura de un trámite. */
export interface FacturacionDeTramite {
  tramiteId: string;
  facturaId: string;
  numero: string | null;
  /** Estado de la EMISIÓN: si salió de FLITO. Eje distinto del de la DIAN. */
  estadoEmision: string;
  /** Estado combinado, el mismo que cuentan los contadores del reporte (HU #11336). */
  estado: SiigoEstadoReporte;
  /** Lo que dijo la DIAN. `null` = todavía no se ha pronunciado. */
  estadoDian: SiigoEstadoDian | null;
  /**
   * Si esta factura se envió a la DIAN (A6). Fuera de producción se crea en Siigo y ahí se queda.
   *
   * **Viaja resuelto y no como el ambiente en crudo** para que la pantalla no tenga que repetir la
   * regla de `efectosExternosPermitidos`. Una segunda copia de esa condición en el frontend es una
   * copia que algún día dice lo contrario que el servidor, y el síntoma sería la pantalla afirmando
   * que una factura está en validación cuando nunca se envió.
   *
   * Con `false`, `estadoDian` es `null` PARA SIEMPRE: el sondeo ni siquiera la mira.
   */
  timbrada: boolean;
  /** Por qué la rechazó, en lenguaje operativo. `null` = no aplica o nadie ha preguntado. */
  motivo: string | null;
  /** `true` cuando se preguntó por el motivo y no se pudo obtener: la pantalla lo dice (AC4). */
  motivoPendiente: boolean;
  /** Cuándo se comprobó por última vez ante la DIAN. Es la mitad del AC3. */
  verificadoEn: string | null;
  cufe: string | null;
  /** Cuántos documentos hay archivados de los dos que debería haber (AC6). */
  documentos: { pdf: boolean; xml: boolean };
  /** Resumen del envío por correo (AC5). */
  correo: { veces: number; ultimoEnviadoEn: string | null };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * La ficha de cada trámite pedido, en UNA consulta.
 *
 * Una consulta y no cinco porque la alternativa —traer facturas, luego estados, luego soportes,
 * luego envíos— son cuatro viajes a la base por cada carga de pantalla, y la pantalla se abre
 * constantemente. Los `LATERAL` mantienen una fila por trámite: sin ellos, un trámite con dos
 * soportes y tres envíos saldría seis veces.
 *
 * El estado combinado se calcula aquí con la misma escalera que la HU #11336 usa en el reporte. No
 * se importa su expresión porque aquella está correlacionada contra la tabla de trámites del
 * reporte y esta parte de la tabla puente; lo que sí se comparte —y es lo que importa— es el
 * catálogo de estados y el orden de las ramas.
 */
export async function facturacionDeTramites(tramiteIds: string[]): Promise<FacturacionDeTramite[]> {
  const ids = [...new Set(tramiteIds.filter((i) => UUID_RE.test(i)))];
  if (ids.length === 0) return [];

  const filas = await db.execute<Record<string, unknown>>(sql`
    SELECT sft.tramite_id,
           sf.id            AS factura_id,
           sf.numero,
           sf.estado        AS estado_emision,
           sf.ambiente,
           sf.cufe,
           dian.estado      AS estado_dian,
           dian.motivo      AS motivo,
           dian.verificado_en,
           COALESCE(doc.pdf, false) AS pdf,
           COALESCE(doc.xml, false) AS xml,
           COALESCE(env.veces, 0)   AS envios,
           env.ultimo_enviado_en
      FROM siigo_factura_tramites sft
      JOIN siigo_facturas sf ON sf.id = sft.factura_id
      -- Último pronunciamiento de la DIAN. Por secuencia y no por fecha: dos filas de la misma
      -- transacción comparten el now() de PostgreSQL y el desempate por fecha sería un empate.
      LEFT JOIN LATERAL (
        SELECT estado, motivo, verificado_en
          FROM siigo_factura_estados_dian d
         WHERE d.factura_id = sf.id
         ORDER BY d.secuencia DESC
         LIMIT 1
      ) dian ON true
      -- Qué documentos están archivados. Un booleano por tipo, no el soporte entero: la pantalla
      -- solo decide si ofrece la descarga o dice que todavía no está (AC6).
      --
      -- El filtro de descartado hace DOS cosas y las dos hacen falta. La primera es de dato: un
      -- soporte descartado en revisión contaría como archivado, y la pantalla afirmaría que el PDF
      -- está cuando no está — el AC6 mentiría justo en el caso en que alguien va a descargarlo. La
      -- segunda es de plan: el índice único de la tabla es PARCIAL sobre esa misma condición, así
      -- que sin ella PostgreSQL no puede usarlo y recorre entera la tabla de TODOS los documentos
      -- del sistema, hasta cuatrocientas veces por petición.
      LEFT JOIN LATERAL (
        SELECT bool_or(s.tipo = 'factura_electronica_pdf') AS pdf,
               bool_or(s.tipo = 'factura_electronica_xml') AS xml
          FROM flito_soportes s
         WHERE s.siigo_factura_id = sf.id
           AND s.descartado = false
      ) doc ON true
      -- Envíos por correo. Cuántos y cuándo fue el último que SÍ salió: si el último intento falló,
      -- la pregunta útil sigue siendo cuándo recibió algo el cliente (AC5).
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS veces,
               max(created_at) FILTER (WHERE resultado = 'enviado') AS ultimo_enviado_en
          FROM siigo_factura_envios e
         WHERE e.factura_id = sf.id
      ) env ON true
     -- sql.param y no la interpolación directa del array: drizzle expande un array suelto en
     -- ($1, $2), que es un CONSTRUCTOR DE FILA, y PostgreSQL lo rechaza con «cannot cast type
     -- record to uuid[]». Compila en TypeScript y revienta en ejecución, que es el peor sitio
     -- donde descubrirlo. Así se enlaza como un único parámetro de tipo array.
     WHERE sft.tramite_id = ANY(${sql.param(ids)}::uuid[])
       -- Igual que en el reporte: una fallida libera su enlace, así que activo sola la escondería
       -- y el trámite parecería no haberse intentado nunca.
       AND (sft.activo OR sf.estado = 'fallida')
     ORDER BY sft.tramite_id, sft.activo DESC, sf.created_at DESC
  `);

  // Una fila por trámite: la primera que llega, que por el ORDER BY es la que manda.
  const vistos = new Set<string>();
  const salida: FacturacionDeTramite[] = [];

  for (const f of filas as unknown as Array<Record<string, unknown>>) {
    const tramiteId = String(f.tramite_id);
    if (vistos.has(tramiteId)) continue;
    vistos.add(tramiteId);

    const estadoEmision = String(f.estado_emision);
    const estadoDian = (f.estado_dian as SiigoEstadoDian | null) ?? null;
    const motivo = (f.motivo as string | null) ?? null;

    salida.push({
      tramiteId,
      facturaId: String(f.factura_id),
      numero: (f.numero as string | null) ?? null,
      estadoEmision,
      estado: estadoCombinado(estadoEmision, estadoDian),
      estadoDian,
      timbrada: efectosExternosPermitidos(String(f.ambiente) as SiigoAmbiente),
      // Un motivo que solo dice «pendiente de consultar» no es una explicación: la pantalla lo
      // trata aparte para poder decirlo en vez de enseñar una frase que no explica nada (AC4).
      motivo: esMotivoPendiente(motivo) ? null : motivo,
      motivoPendiente: esMotivoPendiente(motivo),
      verificadoEn: aIso(f.verificado_en),
      cufe: (f.cufe as string | null) ?? null,
      documentos: { pdf: f.pdf === true, xml: f.xml === true },
      correo: { veces: Number(f.envios) || 0, ultimoEnviadoEn: aIso(f.ultimo_enviado_en) },
    });
  }

  return salida;
}

/**
 * Los dos ejes, combinados en la frase que lee quien opera.
 *
 * Mismo orden de preguntas que la expresión SQL del reporte (HU #11336), y por la misma razón: un
 * fallo de emisión manda sobre cualquier cosa que diga la DIAN, porque si no salió, la DIAN no
 * tiene nada que decir sobre ella.
 */
export function estadoCombinado(
  estadoEmision: string,
  estadoDian: SiigoEstadoDian | null,
): SiigoEstadoReporte {
  if (estadoEmision === 'fallida') return 'fallido';
  if (estadoEmision === 'en_proceso') return 'en_proceso';
  if (estadoDian === 'aceptada') return 'aceptado';
  if (estadoDian === 'rechazada') return 'rechazado';
  if (estadoDian === 'anulada') return 'anulado';
  return 'emitido';
}

function aIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
