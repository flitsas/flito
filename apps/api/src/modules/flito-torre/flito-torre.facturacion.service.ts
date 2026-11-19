// Torre de Control Gerencial (Épica #14590, B4) — Financiera › Facturación: sin facturar, facturas con error,
// rechazadas por la DIAN, cola de Siigo detenida y lo facturado en el periodo.
//
// RN-TOR-FA1 (B4-AC2, invariante): cada KPI, desglose y fila es un conjunto de `CONJUNTOS_TORRE` contado sobre el MISMO
//   fragmento que lista el detalle. FA1 es `sin_facturar` (= la F2 del Resumen y la métrica del Explorador).
// RN-TOR-FA2: «Facturar» es la acción del glosario (lote en Siigo); la DIAN se nombra solo en FA3.
// RN-TOR-FA3: la tabla principal es `sin_facturar` por compañía, ordenada por valor ↓ con permiso de dinero (si no, por
//   trámites ↓). Sin `FUNCION_TORRE_DINERO`, los valores van `null` y las frases no los dicen.
// RN-TOR-FA4: solo conteos y sumas por compañía: sin `logPiiAccess` (regla 16). El error de Siigo nunca viaja aquí:
//   va en el detalle, legible (RN-TOR-LG4).
import type { SegmentoDetalle, TableroFacturacion } from '@operaciones/shared-types';
import { contarConjuntos, fragmentoConjunto, totalFragmento } from './flito-torre.conjuntos.js';
import { enTorre } from './flito-torre.metricas.service.js';
import { destino, kpi, tablaArea } from './flito-torre.productos.service.js';
import { conCacheTablero, rangoTablero, type ContextoTablero } from './flito-torre.tablero-comun.js';
import { valoresUmbrales } from './flito-torre.umbrales.service.js';

const COP = (n: number): string => `$${Math.round(n).toLocaleString('es-CO')}`;

/** `POST /tableros/financiera/facturacion` (B4-AC2). */
export async function tableroFacturacion(ctx: ContextoTablero): Promise<TableroFacturacion> {
  const rango = rangoTablero(ctx);
  const u = await valoresUmbrales();
  return conCacheTablero('financiera-facturacion', ctx, () => enTorre(async (q) => {
    const vencido: SegmentoDetalle[] = [{ dimension: 'nivel', valores: ['vencido'] }];
    const agotado: SegmentoDetalle[] = [{ dimension: 'nivel', valores: ['agotado'] }];
    const k = await contarConjuntos(q, ctx, u, [
      { clave: 'conError', conjunto: 'facturas_con_error' },
      { clave: 'rechazadas', conjunto: 'facturas_rechazadas_dian' },
      { clave: 'cola', conjunto: 'cola_facturacion_atascada' },
      { clave: 'colaVencido', conjunto: 'cola_facturacion_atascada', segmentos: vencido },
      { clave: 'colaAgotado', conjunto: 'cola_facturacion_atascada', segmentos: agotado },
    ]);
    const [sinFact, facturado] = await Promise.all([
      totalFragmento(q, fragmentoConjunto('sin_facturar', ctx, u)),
      totalFragmento(q, fragmentoConjunto('facturado_periodo', ctx, u)),
    ]);
    const tSinFacturar = await tablaArea(q, ctx, u, 'sin_facturar', 'compania', 'Sin facturar por compañía', true, { ordenValor: true });

    const valor = (v: number | null): number | null => (ctx.dinero ? v ?? 0 : null);
    const cifras: TableroFacturacion['cifras'] = {
      sinFacturar: sinFact.total, sinFacturarValor: valor(sinFact.valorTotal), conError: k.conError!, rechazadasDian: k.rechazadas!,
      colaAtascada: k.cola!, facturadasPeriodo: facturado.total, facturadoValor: valor(facturado.valorTotal),
    };
    const colaFrase = k.cola
      ? `${k.cola} ${k.cola === 1 ? 'trámite espera' : 'trámites esperan'} en la cola de facturación: ${k.colaVencido} con el reintento vencido y ${k.colaAgotado} con los intentos agotados.`
      : 'La cola de facturación avanza sin atascos.';
    return {
      cifras,
      explicaciones: {
        sinFacturar: kpi('sin_facturar', sinFact.total, u, {
          cola: ctx.dinero && sinFact.total ? `Valor estimado: ${COP(sinFact.valorTotal ?? 0)}.` : undefined,
        }),
        conError: kpi('facturas_con_error', k.conError!, u),
        rechazadasDian: kpi('facturas_rechazadas_dian', k.rechazadas!, u),
        colaAtascada: {
          ...kpi('cola_facturacion_atascada', k.cola!, u),
          frase: colaFrase,
          desglose: [
            { etiqueta: 'Reintento vencido', valor: k.colaVencido!, destino: destino(k.colaVencido!, 'cola_facturacion_atascada', vencido) },
            { etiqueta: 'Intentos agotados', valor: k.colaAgotado!, destino: destino(k.colaAgotado!, 'cola_facturacion_atascada', agotado) },
          ],
        },
        // Frase guía (no es KPI): con dinero, lo facturado; sin dinero, solo cuántas.
        facturadasPeriodo: {
          ...kpi('facturado_periodo', facturado.total, u),
          frase: facturado.total === 0 ? 'No se emitieron facturas en el periodo.'
            : ctx.dinero ? `En el periodo se facturaron ${COP(facturado.valorTotal ?? 0)} en ${facturado.total} ${facturado.total === 1 ? 'factura' : 'facturas'}.`
              : `En el periodo se ${facturado.total === 1 ? 'emitió 1 factura' : `emitieron ${facturado.total} facturas`}.`,
        },
      },
      tablas: [tSinFacturar],
      rango: { desde: rango.desde, hasta: rango.hasta },
      dineroVisible: ctx.dinero,
      generadoEn: new Date().toISOString(),
    };
  }));
}
