// La línea de tiempo del ciclo de facturación de un trámite (HU #11338, Feature #11244).
//
// **No hay tabla nueva, y es la decisión que define el archivo.** `siigo_operaciones` ya es una
// bitácora inalterable de verdad —disparadores que prohíben UPDATE y DELETE desde la migración
// `0126`—, ya guarda petición, respuesta, duración, resultado y código saneados, y ya está indexada
// por `(entidad_tipo, entidad_id, created_at)`. Lo que faltaba **no era dónde escribir: era qué
// leer**.
//
// Esto es esa lectura. Cruza tres fuentes que ya existen:
//
//   · `flito_liquidacion_eventos` — liquidar, reversar, facturar. El ciclo empieza antes de Siigo.
//   · `siigo_operaciones`         — todo lo que salió hacia Siigo, y también los hitos que no son
//                                   llamadas (AC3): encolar, marcar fallido, pedir un reenvío.
//   · `siigo_factura_estados_dian` — lo que dice la autoridad (HU #11330).
//
// Y las ordena en un solo relato. La pregunta que responde es «¿qué pasó con la factura de este
// trámite y cuándo?», que hoy exige mirar en tres sitios y reconstruirlo a mano.

import { desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  flitoLiquidacionEventos, siigoFacturaEstadosDian, siigoFacturaTramites, siigoFacturas,
} from '../../db/schema.js';
import { consultarBitacora, registrarOperacion } from './siigo.operaciones.repo.js';

/** De dónde salió el hito. Sirve para explicar por qué se sabe lo que se sabe. */
export type FuenteHito = 'liquidacion' | 'siigo' | 'dian';

export interface HitoLineaTiempo {
  fuente: FuenteHito;
  /** Qué pasó, en clave estable para la interfaz. */
  tipo: string;
  /** Texto para leer. Ya saneado: ver el comentario de `resumen`. */
  detalle: string | null;
  /** `ok` | `error` | `informativo`. La pantalla pinta con esto, no interpretando el texto. */
  resultado: 'ok' | 'error' | 'informativo';
  ocurridoEn: string;
  /** Quién lo provocó, cuando lo hubo. Un cron no tiene usuario, y eso es información. */
  usuarioId: number | null;
}

export interface LineaTiempoTramite {
  tramiteId: string;
  /** false = el trámite existe y nunca se le pidió factura electrónica (AC6). */
  facturacionIniciada: boolean;
  facturaId: string | null;
  hitos: HitoLineaTiempo[];
}

/**
 * Tope de hitos. Un trámite con un bucle de reintentos puede tener cientos de entradas en la
 * bitácora, y una pantalla que los pinte todos no se lee.
 */
const TOPE_HITOS = 200;

/**
 * Lo que se muestra de un cuerpo de petición o respuesta (AC5).
 *
 * **No se devuelve el cuerpo.** `siigo_operaciones` ya lo guarda saneado —sin credenciales, sin
 * token, sin volcados de SQL— pero saneado no es lo mismo que mínimo: ahí dentro va el payload de
 * la factura, con la identificación del cliente y sus datos. Para entender un hito basta con el
 * código y el mensaje; quien necesite el cuerpo entero tiene la bitácora, que ya exige su permiso.
 */
function resumen(op: {
  operacion: string; resultado: string; codigo: string | null; mensaje: string | null;
}): string | null {
  const partes = [op.codigo, op.mensaje].filter(Boolean);
  return partes.length > 0 ? partes.join(' — ').slice(0, 300) : null;
}

function resultadoDeOperacion(resultado: string): HitoLineaTiempo['resultado'] {
  if (resultado === 'ok') return 'ok';
  if (resultado === 'error_tecnico' || resultado === 'error_negocio') return 'error';
  return 'informativo';
}

/** Cómo se lee cada acción de la liquidación. El ciclo empieza aquí, antes de que Siigo exista. */
const ACCION_LIQUIDACION_TEXTO: Record<string, string> = {
  liquidar: 'Liquidación sellada',
  reversar: 'Liquidación reversada',
  facturar: 'Marcada como facturada en FLITO',
};

const ESTADO_DIAN_TEXTO: Record<string, string> = {
  en_validacion: 'En validación por la DIAN',
  aceptada: 'Aceptada por la DIAN',
  rechazada: 'Rechazada por la DIAN',
  anulada: 'Anulada',
};

/**
 * Reconstruye el relato de un trámite (AC1, AC6).
 *
 * **Un trámite sin factura tiene relato igual.** Devolver una lista vacía obligaría a quien mira a
 * adivinar si es que no pasó nada o que la consulta falló; `facturacionIniciada` lo dice.
 */
export async function lineaTiempoDeTramite(tramiteId: string): Promise<LineaTiempoTramite> {
  const hitos: HitoLineaTiempo[] = [];

  // 1. La liquidación. Existe aunque nunca se haya pedido factura electrónica.
  const eventos = await db
    .select()
    .from(flitoLiquidacionEventos)
    .where(eq(flitoLiquidacionEventos.tramiteId, tramiteId))
    .orderBy(desc(flitoLiquidacionEventos.createdAt))
    .limit(TOPE_HITOS);

  for (const e of eventos) {
    hitos.push({
      fuente: 'liquidacion',
      tipo: e.accion,
      detalle: ACCION_LIQUIDACION_TEXTO[e.accion] ?? e.accion,
      resultado: e.accion === 'reversar' ? 'informativo' : 'ok',
      ocurridoEn: e.createdAt.toISOString(),
      usuarioId: e.usuarioId,
    });
  }

  // 2. ¿Hay factura? Es lo que decide si hay algo más que contar.
  const [vinculo] = await db
    .select({ facturaId: siigoFacturaTramites.facturaId })
    .from(siigoFacturaTramites)
    .where(eq(siigoFacturaTramites.tramiteId, tramiteId))
    .orderBy(desc(siigoFacturaTramites.createdAt))
    .limit(1);

  if (!vinculo) {
    return {
      tramiteId,
      facturacionIniciada: false,
      facturaId: null,
      hitos: ordenar(hitos),
    };
  }

  // 3. Todo lo que pasó con esa factura frente a Siigo, incluidos los hitos sin llamada HTTP.
  const operaciones = await consultarBitacora({
    entidadTipo: 'factura',
    entidadId: vinculo.facturaId,
    limite: TOPE_HITOS,
  });

  for (const op of operaciones) {
    hitos.push({
      fuente: 'siigo',
      tipo: op.operacion,
      detalle: resumen(op),
      resultado: resultadoDeOperacion(op.resultado),
      ocurridoEn: op.createdAt.toISOString(),
      usuarioId: op.createdBy ?? null,
    });
  }

  // 4. Lo que dice la autoridad. Eje aparte del estado de emisión (HU #11330).
  const estados = await db
    .select()
    .from(siigoFacturaEstadosDian)
    .where(eq(siigoFacturaEstadosDian.facturaId, vinculo.facturaId))
    .orderBy(desc(siigoFacturaEstadosDian.secuencia))
    .limit(TOPE_HITOS);

  for (const e of estados) {
    hitos.push({
      fuente: 'dian',
      tipo: e.estado,
      detalle: [ESTADO_DIAN_TEXTO[e.estado] ?? e.estado, e.motivo].filter(Boolean).join(' — ') || null,
      resultado: e.estado === 'rechazada' ? 'error' : e.estado === 'aceptada' ? 'ok' : 'informativo',
      ocurridoEn: e.createdAt.toISOString(),
      usuarioId: null,
    });
  }

  return {
    tramiteId,
    facturacionIniciada: true,
    facturaId: vinculo.facturaId,
    hitos: ordenar(hitos),
  };
}

/** Cronológico ascendente: un relato se lee desde el principio. */
function ordenar(hitos: HitoLineaTiempo[]): HitoLineaTiempo[] {
  return hitos
    .sort((a, b) => a.ocurridoEn.localeCompare(b.ocurridoEn))
    .slice(0, TOPE_HITOS);
}

// ── Hitos que no son llamadas a Siigo (AC3) ─────────────────────────────────

/**
 * Hitos del ciclo que ocurren sin que salga una petición: encolar, marcar como fallido definitivo,
 * pedir un reenvío.
 *
 * **Se escriben en la bitácora que ya existe**, no en una tabla nueva. `siigo_operaciones.operacion`
 * es `varchar(40)` **sin enumeración a propósito** —el comentario del esquema dice que el catálogo
 * crecería con estas Features—, así que un hito sin HTTP se guarda con `metodo` y `ruta` vacíos.
 *
 * Que compartan tabla con las llamadas es justamente lo que hace posible un relato ordenado: si
 * vivieran aparte, reconstruir el orden exigiría mezclar dos fuentes con relojes distintos.
 */
export const HITOS_SIN_LLAMADA = [
  'encolada',
  'marcada_fallido_definitivo',
  'reenvio_solicitado',
  'correccion_registrada',
] as const;

export type HitoSinLlamada = (typeof HITOS_SIN_LLAMADA)[number];

/**
 * Sobre qué se apunta el hito. Por omisión, la factura.
 *
 * La bandeja de fallidos (HU #11340) necesita apuntar sobre la FILA DE COLA —«esta fila de trabajo se
 * dio por perdida»— y sobre el ACTA DE ENVÍO —«este correo se abandona»—, que son entidades distintas
 * de la factura y con ciclos distintos: una factura puede tener varias actas de envío, y darlas por
 * perdidas de una en una es justo lo que hace falta. Apuntar los tres sobre la factura los volvería
 * indistinguibles, y «¿esta fila está descartada?» dejaría de tener respuesta.
 *
 * Los tipos son texto y no un enum porque `siigo_operaciones.entidad_tipo` es `varchar(20)` sin
 * enumeración a propósito (ver el esquema): el catálogo crece con cada Feature.
 */
export type EntidadHito = 'factura' | 'siigo_cola' | 'factura_envio';

export async function registrarHito(datos: {
  hito: HitoSinLlamada;
  facturaId: string;
  ambiente: string;
  usuarioId?: number | null;
  detalle?: string;
  /** Sobre qué se apunta. Por omisión la factura, que es lo que lee la línea de tiempo. */
  entidadTipo?: EntidadHito;
  /** El id de esa entidad. Por omisión el de la factura. */
  entidadId?: string;
  /** Código estable para la interfaz: el motivo del descarte, sin la nota. */
  codigo?: string | null;
}): Promise<void> {
  await registrarOperacion({
    operacion: datos.hito,
    entidadTipo: datos.entidadTipo ?? 'factura',
    entidadId: datos.entidadId ?? datos.facturaId,
    ambiente: datos.ambiente,
    resultado: 'ok',
    codigo: datos.codigo ?? null,
    // Sin método ni ruta: no hubo petición. Dejarlos vacíos es la diferencia visible entre un hito
    // nuestro y una llamada a Siigo.
    mensaje: datos.detalle ?? null,
    createdBy: datos.usuarioId ?? null,
  });
}

// ── Lectura en lote, para la bandeja ────────────────────────────────────────

/**
 * Última actividad de varios trámites de una vez.
 *
 * La bandeja de fallidos (HU #11340) y el reporte de costos necesitan «¿qué fue lo último que pasó?»
 * de muchas filas. Sin esto harían una consulta por trámite.
 */
export async function ultimaActividad(tramiteIds: string[]): Promise<Map<string, string>> {
  if (tramiteIds.length === 0) return new Map();

  const vinculos = await db
    .select({ tramiteId: siigoFacturaTramites.tramiteId, facturaId: siigoFacturaTramites.facturaId })
    .from(siigoFacturaTramites)
    .where(inArray(siigoFacturaTramites.tramiteId, tramiteIds));

  if (vinculos.length === 0) return new Map();

  const facturas = await db
    .select({ id: siigoFacturas.id, updatedAt: siigoFacturas.updatedAt })
    .from(siigoFacturas)
    .where(inArray(siigoFacturas.id, vinculos.map((v) => v.facturaId)));

  const porFactura = new Map(facturas.map((f) => [f.id, f.updatedAt.toISOString()]));
  return new Map(
    vinculos
      .map((v) => [v.tramiteId, porFactura.get(v.facturaId)] as const)
      .filter((x): x is readonly [string, string] => x[1] !== undefined),
  );
}
