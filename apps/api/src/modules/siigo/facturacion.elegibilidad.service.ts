// Siigo — ¿este trámite se puede enviar a facturación electrónica, y si no, por qué? (HU #11324).
//
// Es el embudo de la Feature: todo lo que emite pasa antes por aquí. Y el valor no está en el sí o
// el no —eso es fácil— sino en el NO CON MOTIVO, que es lo que permite corregir antes de intentar
// en vez de descubrirlo con un rechazo de la DIAN.
//
// CUATRO DECISIONES
//
//   1. **Una sola evaluación, y las comprobaciones que ya existen se LLAMAN.** El veredicto del
//      cliente lo da el validador de la HU #11296; el de la parametrización, la compuerta de la
//      #11285. Sus motivos se propagan tal cual, palabra por palabra. Reescribirlos aquí crearía una
//      segunda versión del mismo diagnóstico, y la copia sería siempre la que se quedara vieja.
//   2. **Se evalúa por LOTES, no fila a fila.** El reporte pinta doscientos trámites por página y
//      consulta la elegibilidad en cada carga. Una consulta por fila serían doscientas por pantalla,
//      y las funciones `exigir*` hacen una consulta cada una. Aquí se cargan los datos de una vez y
//      se usan las funciones PURAS de esos servicios, que son la misma regla sin el viaje.
//   3. **Ni una petición a Siigo** (AC7). Todo sale de tablas locales, incluido el vínculo del
//      tercero: preguntarle a Siigo si el cliente existe, en cada carga de pantalla, gastaría la
//      cuota que comparte con la emisión.
//   4. **El corte del histórico es un dato, no un supuesto** (AC4). Vive en `historico_desde` de la
//      configuración de emisión, y cambiar esa fecha cambia el veredicto sin tocar código. Es la
//      pregunta 13 aislada en una columna.

import { sql } from 'drizzle-orm';
import {
  MOTIVO_TRAMITE_NO_ELEGIBLE_TEXTO,
  resumenElegibilidadVacio,
  type ElegibilidadTramite,
  type MotivoElegibilidad,
  type MotivoTramiteNoElegible,
  type ResumenElegibilidad,
  type ConceptoFacturable,
  type ValoresLiquidacion,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { clients, flitoLiquidaciones, flitoTramites } from '../../db/schema.js';
import { EXPR_DOC_COMPLETA, conJoins } from '../finanzas/finanzas.service.js';
import { conceptosAplicables, evaluarCompuerta } from './siigo.compuerta.service.js';
import { evaluarCliente, type ClienteEvaluable } from './siigo.validador-cliente.service.js';
import { TZ_COLOMBIA } from '../../shared/utils/fecha-rango.js';
import type { SiigoAmbiente } from './credenciales.service.js';

/** Tope de trámites por evaluación. El reporte pinta 200; el doble acota el abuso sin estorbar. */
export const TOPE_TRAMITES_ELEGIBILIDAD = 400;

/** Todo lo que hace falta saber de un trámite para juzgarlo, en una sola fila. */
export interface FilaElegibilidad {
  tramiteId: string;
  companiaId: number | null;
  estadoLiquidacion: string | null;
  /** Cuándo se pulsó «Facturar». Es lo que se compara con el corte del histórico. */
  facturadoEn: string | null;
  documentacionCompleta: boolean;
  terceroVinculado: boolean;
  facturaViva: boolean;
  historicoDesde: string | null;
  /**
   * Valores de la liquidación. `numeric` llega como CADENA, y `null` significa «el concepto no
   * aplica» mientras que `'0.00'` significa «aplica y vale cero». No comparar por veracidad: esa
   * confusión hace desaparecer conceptos que sí hay que facturar.
   */
  valores: ValoresLiquidacion;
  /** La fila del cliente, en la forma EXACTA que el validador espera. Sin casts que tapen. */
  cliente: ClienteEvaluable | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function motivo(m: MotivoTramiteNoElegible, detalle?: string): MotivoElegibilidad {
  return { motivo: m, detalle: detalle ?? MOTIVO_TRAMITE_NO_ELEGIBLE_TEXTO[m] };
}

/**
 * Los motivos que no dependen de nada externo (AC3, AC4, AC5, AC6).
 *
 * **Pura**, y por eso se puede interrogar sin base de datos ni red: aquí vive la mayor parte de la
 * regla de negocio, que es justo lo que conviene poder probar barato y exhaustivamente.
 *
 * No corta en el primer motivo. Enumerar todo lo que falta de una vez es la diferencia entre una
 * corrección y cuatro viajes: quien arregla la documentación quiere enterarse EN ESE MOMENTO de que
 * además falta sincronizar el tercero.
 */
export function motivosLocales(f: FilaElegibilidad): MotivoElegibilidad[] {
  const motivos: MotivoElegibilidad[] = [];

  // AC3 — la emisión es un paso POSTERIOR al botón «Facturar». Una liquidación estimada o
  // simplemente liquidada todavía no ha sellado sus valores, y facturar valores que pueden cambiar
  // mañana produce una factura que habrá que corregir ante la DIAN.
  if (f.estadoLiquidacion !== 'facturado') {
    motivos.push(motivo('liquidacion_no_facturada'));
  }

  if (f.companiaId === null) motivos.push(motivo('sin_compania'));
  else if (!f.terceroVinculado) motivos.push(motivo('tercero_sin_vincular'));

  if (!f.documentacionCompleta) motivos.push(motivo('documentacion_incompleta'));

  // AC4 — el corte es un dato. Si no hay fecha configurada no se bloquea nada: la ausencia de
  // configuración no debe comportarse como una prohibición silenciosa, o alguien buscaría durante
  // horas por qué no se factura y no habría nada que encontrar.
  //
  // **Las fechas se comparan como CADENAS, y es seguro por construcción.** Las dos llegan en
  // `YYYY-MM-DD` —la de la liquidación por el `::date::text` de la consulta, la del corte por ser
  // una columna `date`—, y en ese formato el orden lexicográfico ES el cronológico. Y si alguna
  // llegara con otra forma, el error cae del lado seguro: la comparación bloquearía de más, nunca
  // dejaría pasar de menos. En la única puerta que hay antes de emitir ante la DIAN, un falso
  // «no elegible» se corrige mirando; un falso «elegible» se corrige ante la autoridad.
  //
  // `facturadoEn` nulo no deja pasar nada por su cuenta: un CHECK de la tabla garantiza que toda
  // liquidación `facturado` la tiene, así que un nulo significa que NO está facturada — y eso ya lo
  // bloqueó la comprobación de arriba.
  if (f.historicoDesde && f.facturadoEn && f.facturadoEn < f.historicoDesde) {
    motivos.push(motivo('anterior_al_corte'));
  }

  // Emitir dos veces el mismo trámite es duplicarlo ante la DIAN, y eso no se deshace.
  if (f.facturaViva) motivos.push(motivo('ya_facturado'));

  return motivos;
}

/** ¿Es anterior al corte? Se expone aparte porque el AC4 pide contarlos. */
export function esAnteriorAlCorte(f: Pick<FilaElegibilidad, 'facturadoEn' | 'historicoDesde'>): boolean {
  return Boolean(f.historicoDesde && f.facturadoEn && f.facturadoEn < f.historicoDesde);
}

/**
 * Trae de una vez todo lo que hace falta para juzgar un conjunto de trámites (AC7).
 *
 * Los `EXISTS` correlacionados responden sí/no por trámite sin multiplicar filas, que es lo que
 * pasaría con joins sobre soportes y facturas. La condición de documentación completa es **la misma**
 * que usa el reporte de costos: se replica su forma aquí porque aquella vive acoplada a los joins
 * del reporte, y el AC6 exige que sea la misma condición — no la misma línea de código, que sería
 * imposible sin arrastrar ocho joins ajenos.
 */
async function cargarFilas(tramiteIds: string[], ambiente: SiigoAmbiente): Promise<FilaElegibilidad[]> {
  const ids = [...new Set(tramiteIds.filter((i) => UUID_RE.test(i)))];
  if (ids.length === 0) return [];

  // Los MISMOS joins que el reporte, porque `EXPR_DOC_COMPLETA` resuelve sus referencias de columna
  // contra ellos. Reutilizar la expresión sin reutilizar los joins no compilaría… en SQL sí, y
  // devolvería otra cosa: ese es justo el fallo que no avisa.
  const filas = await conJoins(
    db.select({
      tramiteId: flitoTramites.id,
      companiaId: flitoTramites.companiaId,
      estadoLiquidacion: flitoLiquidaciones.estado,
      // Un CHECK de la tabla garantiza que toda liquidación `facturado` tiene esta fecha, así que
      // la comparación contra el corte nunca se queda sin dato en las filas que sí hay que comparar.
      // B2 — `facturado_en` es `timestamptz` y `::date` usa la zona de la SESIÓN, que es UTC. Toda
      // facturación entre las 19:00 y medianoche hora Bogotá se leía como del día siguiente, y en el
      // borde del corte eso DESACTIVA el bloqueo justo en la franja de más actividad de cierre. La
      // convención ya existe en el repo (`fecha-rango.ts`); lo que faltaba era aplicarla.
      facturadoEn: sql<string | null>`(${flitoLiquidaciones.facturadoEn} AT TIME ZONE ${TZ_COLOMBIA})::date::text`,
      valorSoat: flitoLiquidaciones.valorSoat,
      valorImpuesto: flitoLiquidaciones.valorImpuesto,
      valorDerecho: flitoLiquidaciones.valorDerecho,
      valorTramiteDigital: flitoLiquidaciones.valorTramiteDigital,
      valorLogistica: flitoLiquidaciones.valorLogistica,
      valorGmf: flitoLiquidaciones.valorGmf,
      documentacionCompleta: sql<boolean>`${EXPR_DOC_COMPLETA}`,
      // B1 — la configuración VIGENTE del ambiente. `ORDER BY id` sobre una PK uuid aleatoria es un
      // orden al azar, y además ignoraba `ambiente` y `vigente`: podía aplicar el corte de `pruebas`
      // o el de una configuración apagada hace meses, y dar veredictos distintos en dos peticiones
      // idénticas. Sobre el único control que impide facturar histórico no autorizado.
      historicoDesde: sql<string | null>`(
        SELECT historico_desde::text FROM siigo_config_emision
         WHERE ambiente = ${ambiente} AND vigente
         ORDER BY created_at DESC LIMIT 1)`,
      // AC5 y AC7 — el vínculo se consulta EN LOCAL. Preguntarle a Siigo si el cliente existe, en
      // cada carga de pantalla, gastaría la cuota que comparte con la emisión.
      terceroVinculado: sql<boolean>`EXISTS (SELECT 1 FROM siigo_terceros st WHERE st.client_id = ${flitoTramites.companiaId})`,
      facturaViva: sql<boolean>`EXISTS (
        SELECT 1 FROM siigo_factura_tramites sft WHERE sft.tramite_id = ${flitoTramites.id} AND sft.activo)`,
      // B3 — la proyección EXPLÍCITA que el validador espera, no `to_jsonb(clients)`. Parecían
      // equivalentes y no lo eran: `to_jsonb` usa los nombres de COLUMNA (`person_type`) y el
      // evaluador espera los del modelo (`personType`). Coincidían tres de quince, así que TODO
      // cliente salía «no facturable» con seis motivos falsos — y un cast mío impedía que el
      // compilador lo dijera. De paso deja de arrastrar las 36 columnas de `clients`, con su NIT y
      // sus correos, para usar quince.
      cliente: sql<unknown>`CASE WHEN ${clients.id} IS NULL THEN NULL ELSE jsonb_build_object(
        'id', ${clients.id},
        'name', ${clients.name},
        'document', ${clients.document},
        'personType', ${clients.personType},
        'idType', ${clients.idType},
        'fiscalResponsibilities', ${clients.fiscalResponsibilities},
        'address', ${clients.address},
        'countryCode', ${clients.countryCode},
        'stateCode', ${clients.stateCode},
        'cityCode', ${clients.cityCode},
        'phoneIndicative', ${clients.phoneIndicative},
        'phoneNumber', ${clients.phoneNumber},
        'contactFirstName', ${clients.contactFirstName},
        'contactLastName', ${clients.contactLastName},
        'facturacionBloqueos', ${clients.facturacionBloqueos}
      ) END`,
    }).from(flitoTramites).$dynamic(),
  ).where(sql`${flitoTramites.id} = ANY(${sql.param(ids)}::uuid[])`);

  return (filas as unknown as Record<string, unknown>[]).map((f) => ({
    tramiteId: String(f.tramiteId),
    companiaId: f.companiaId === null || f.companiaId === undefined ? null : Number(f.companiaId),
    estadoLiquidacion: (f.estadoLiquidacion as string | null) ?? null,
    facturadoEn: (f.facturadoEn as string | null) ?? null,
    documentacionCompleta: f.documentacionCompleta === true,
    terceroVinculado: f.terceroVinculado === true,
    facturaViva: f.facturaViva === true,
    historicoDesde: (f.historicoDesde as string | null) ?? null,
    valores: {
      valorSoat: (f.valorSoat as string | null) ?? null,
      valorImpuesto: (f.valorImpuesto as string | null) ?? null,
      valorDerecho: (f.valorDerecho as string | null) ?? null,
      valorTramiteDigital: (f.valorTramiteDigital as string | null) ?? null,
      valorLogistica: (f.valorLogistica as string | null) ?? null,
      valorGmf: (f.valorGmf as string | null) ?? null,
    },
    cliente: (f.cliente as ClienteEvaluable | null) ?? null,
  }));
}

/**
 * El veredicto de un conjunto de trámites (AC1, AC2, AC7).
 *
 * La compuerta se evalúa una vez por COMBINACIÓN DISTINTA de conceptos, no una por trámite. En una
 * cartera real esas combinaciones se cuentan con los dedos —casi todos los trámites facturan los
 * mismos conceptos—, así que una página de doscientos se resuelve con dos o tres evaluaciones. Sin
 * esta memoria, cada fila repetiría la misma consulta de mapeos para obtener la misma respuesta.
 */
export async function evaluarElegibilidad(
  tramiteIds: string[], ambiente: SiigoAmbiente,
): Promise<ElegibilidadTramite[]> {
  const filas = await cargarFilas(tramiteIds, ambiente);
  const compuertaPorClave = new Map<string, MotivoElegibilidad[]>();

  const salida: ElegibilidadTramite[] = [];
  for (const f of filas) {
    const motivos = motivosLocales(f);

    // AC2 — el veredicto del cliente lo da el validador, y sus motivos se propagan TAL CUAL.
    if (f.cliente) {
      const v = evaluarCliente(f.cliente);
      if (!v.facturable) {
        for (const falta of v.faltantes) {
          motivos.push({ motivo: 'cliente_no_facturable', detalle: falta.detalle });
        }
      }
    }

    // AC2 — y el de la parametrización lo da la compuerta, igual.
    const conceptos = conceptosAplicables(f.valores);
    const clave = conceptos.slice().sort().join('|');
    if (!compuertaPorClave.has(clave)) {
      compuertaPorClave.set(clave, await motivosDeCompuerta(ambiente, conceptos));
    }
    motivos.push(...(compuertaPorClave.get(clave) ?? []));

    salida.push({ tramiteId: f.tramiteId, elegible: motivos.length === 0, motivos });
  }

  // Un trámite pedido que no existe no se calla: sale como no elegible sin compañía, que es la
  // verdad. Omitirlo haría que la pantalla mostrara menos filas de las que preguntó, sin decir
  // cuáles ni por qué.
  const vistos = new Set(salida.map((s) => s.tramiteId));
  for (const id of new Set(tramiteIds.filter((i) => UUID_RE.test(i)))) {
    if (!vistos.has(id)) {
      salida.push({ tramiteId: id, elegible: false, motivos: [motivo('sin_compania')] });
    }
  }

  return salida;
}

/**
 * Los motivos de la compuerta para un conjunto de conceptos.
 *
 * **Cero conceptos NO es «todo en orden».** La compuerta lo trata como un motivo propio —una
 * liquidación sin ningún valor facturable no tiene nada que facturar— y aquí se respeta esa
 * decisión en vez de dejar pasar el trámite por no haber evaluado nada.
 */
async function motivosDeCompuerta(
  ambiente: SiigoAmbiente, conceptos: readonly ConceptoFacturable[],
): Promise<MotivoElegibilidad[]> {
  if (conceptos.length === 0) {
    return [{
      motivo: 'compuerta_cerrada',
      detalle: 'La liquidación no trae ningún concepto facturable con valor. No hay nada que facturar.',
    }];
  }
  const estado = await evaluarCompuerta(ambiente, conceptos);
  if (estado.emisionRealHabilitada) return [];
  return estado.motivos.map((m) => ({ motivo: 'compuerta_cerrada' as const, detalle: m.detalle }));
}

/** El veredicto de UN trámite. Atajo del anterior; misma regla, sin ninguna copia. */
export async function elegibilidadDeTramite(
  tramiteId: string, ambiente: SiigoAmbiente,
): Promise<ElegibilidadTramite | null> {
  const [r] = await evaluarElegibilidad([tramiteId], ambiente);
  return r ?? null;
}

/**
 * El resumen sobre un conjunto (AC4).
 *
 * Un trámite puede tener varios motivos y se cuenta en todos: la pregunta que responde este resumen
 * es «¿cuántos están frenados por cada causa?», no «¿en qué cajón cae cada uno?». Repartirlos por su
 * primer motivo escondería que arreglar la documentación no desbloquea a los que además tienen el
 * tercero sin vincular.
 */
export function resumirElegibilidad(
  veredictos: ElegibilidadTramite[], anterioresAlCorte = 0,
): ResumenElegibilidad {
  const r = resumenElegibilidadVacio();
  r.total = veredictos.length;
  for (const v of veredictos) {
    if (v.elegible) r.elegibles += 1;
    else r.noElegibles += 1;
    for (const m of new Set(v.motivos.map((x) => x.motivo))) r.porMotivo[m] += 1;
  }
  r.anterioresAlCorte = anterioresAlCorte;
  return r;
}
