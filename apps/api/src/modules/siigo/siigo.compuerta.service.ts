// Siigo API — compuerta de emisión real (HU #11285, Feature #11240).
//
// Impide que salga ante la DIAN una factura con un tratamiento tributario que nadie validó.
//
// Esta HU entrega el SERVICIO y el ENDPOINT de estado. El enganche en el flujo de emisión lo hará la
// Feature de emisión, porque ese código todavía no existe: aquí se deja `exigirCompuertaAbierta`
// lista para que la llame, y la forma de la excepción ya decidida.
//
// Decisiones que sostienen el archivo:
//
//   1. **La compuerta se evalúa AL PREGUNTAR, nunca se cachea.** Sus dos insumos —mapeo y
//      configuración— cambian por debajo: alguien confirma un concepto, alguien inactiva un vendedor
//      en Siigo Nube. Un veredicto guardado sería un permiso para emitir con parametrización vieja.
//   2. **`null` y `0` no son lo mismo** (AC2). En `flito_liquidaciones`, `null` significa que el
//      concepto no aplica a ese trámite y `0` que aplica y vale cero. La distinción ya la sostiene
//      esa tabla y aquí no se reinterpreta: se compara contra `null`, nunca por veracidad.
//   3. **Todo es por ambiente** (AC7). No hay estado compartido entre `pruebas` y `produccion`, así
//      que cambiar de ambiente reevalúa por construcción y no hereda confirmaciones del otro.

import {
  CONCEPTOS_FACTURABLES,
  CONCEPTO_FACTURABLE_COLUMNA_LIQUIDACION,
  type ConceptoFacturable,
  type EstadoCompuerta,
  type MotivoCompuerta,
  type ValoresLiquidacion,
} from '@operaciones/shared-types';
import { listarMapeo, type MapeoConcepto } from './mapeo-conceptos.service.js';
import { modoSiigo } from './siigo.mock.js';
import type { SiigoAmbiente } from './credenciales.service.js';

/**
 * La emisión real está bloqueada. La lanza `exigirCompuertaAbierta` para que el flujo de emisión no
 * tenga que inspeccionar un booleano y decidir por su cuenta qué hacer.
 *
 * Lleva los motivos para que el mensaje al operador enumere QUÉ falta (AC1), no un «no se puede».
 */
export class SiigoCompuertaCerradaError extends Error {
  readonly motivos: MotivoCompuerta[];
  readonly ambiente: string;

  constructor(ambiente: string, motivos: MotivoCompuerta[]) {
    super(`La emisión real está bloqueada en el ambiente ${ambiente}: ${resumirMotivos(motivos)}`);
    this.name = 'SiigoCompuertaCerradaError';
    this.motivos = motivos;
    this.ambiente = ambiente;
  }
}

function resumirMotivos(motivos: MotivoCompuerta[]): string {
  return motivos.map((m) => m.detalle).join(' · ');
}

/**
 * AC2 — Qué conceptos aplican a un trámite, según su liquidación sellada.
 *
 * `null` = no aplica. Cualquier otro valor —incluido `'0.00'`— aplica.
 *
 * La comparación es contra `null` y no por veracidad a propósito. `numeric` llega como cadena, así
 * que hoy `'0.00'` es truthy y un `if (valor)` funcionaría por accidente; el día que alguien
 * convierta la columna a número, ese mismo `if` excluiría en silencio los conceptos que valen cero
 * —y una línea de factura que falta no se nota hasta que cuadran la contabilidad—.
 */
export function conceptosAplicables(liquidacion: ValoresLiquidacion): ConceptoFacturable[] {
  return CONCEPTOS_FACTURABLES.filter((concepto) => {
    // Sin `as keyof`: el mapa ya está tipado contra `ValoresLiquidacion`, así que renombrar una
    // columna sin actualizarlo es un error de compilación y no una lectura silenciosa de
    // `undefined` que haría pasar el concepto por «no aplica».
    const valor = liquidacion[CONCEPTO_FACTURABLE_COLUMNA_LIQUIDACION[concepto]];
    return valor !== null && valor !== undefined;
  });
}

/** Filas activas del mapeo que gobiernan un concepto: la genérica y todas sus específicas. */
function filasDelConcepto(filas: MapeoConcepto[], concepto: ConceptoFacturable): MapeoConcepto[] {
  return filas.filter((f) => f.concepto === concepto);
}

/**
 * Evalúa la compuerta sobre un conjunto de conceptos.
 *
 * Distingue «sin confirmar» de «confirmado pero no listo» porque son dos personas distintas: lo
 * primero lo resuelve contabilidad firmando; lo segundo, quien parametriza completando el producto
 * o su clasificación. Un mensaje único mandaría a la mitad de los casos a la persona equivocada.
 */
async function evaluar(
  ambiente: SiigoAmbiente, conceptos: readonly ConceptoFacturable[],
): Promise<MotivoCompuerta[]> {
  const motivos: MotivoCompuerta[] = [];

  // ── Mapeo de conceptos (AC1) ──────────────────────────────────────────────
  const filas = await listarMapeo(ambiente);
  const noListos: ConceptoFacturable[] = [];

  for (const concepto of conceptos) {
    const suyas = filasDelConcepto(filas, concepto);
    if (suyas.length === 0) {
      // Sin ninguna fila viva el concepto no se puede facturar, y no es un problema de firma.
      noListos.push(concepto);
      continue;
    }
    // A7 — ya no se pregunta por la firma de contabilidad. Lo que firmaba era el tratamiento
    // tributario que FLITO guardaba en copia, y esa copia dejó de existir: la factura no envía
    // `taxes` y los aplica Siigo desde el producto. Ver `esListoParaFacturar`.
    if (suyas.some((f) => !f.listoParaFacturar)) noListos.push(concepto);
  }

  if (noListos.length > 0) {
    motivos.push({
      tipo: 'concepto_no_listo',
      detalle: `Falta elegir el producto de Siigo en: ${noListos.join(', ')}.`,
      conceptos: noListos,
    });
  }

  // ── Ya no se evalúa ninguna configuración global de emisión ───────────────
  //
  // Aquí se comprobaba que el ambiente tuviera guardados un comprobante, un vendedor, una forma de
  // pago y un centro de costo válidos. Esa configuración desapareció: los cuatro se ELIGEN en cada
  // envío, por empresa, de los catálogos leídos de Siigo en el momento.
  //
  // Y no se sustituye por una comprobación equivalente, porque no hay nada que comprobar por
  // adelantado: lo que se elija todavía no existe cuando esta función corre. Lo que de verdad
  // protege —no emitir sin comprobante, sin vendedor o sin forma de pago— vive en los dos únicos
  // sitios que saben qué se eligió: el envío, que no deja continuar sin ellos, y `prepararEmision`,
  // que rechaza el lote al que le falten.
  //
  // La compuerta se queda con lo que sí es una precondición estable del ambiente: el mapeo de
  // conceptos.
  return motivos;
}

/**
 * AC5 — Estado de la compuerta para un ambiente, evaluado sobre los SEIS conceptos.
 *
 * Los seis y no los de un trámite concreto: esto lo consume la pantalla de parametrización, que
 * pregunta «¿está todo listo para facturar?», no «¿puedo emitir este trámite?».
 */
export async function estadoCompuerta(ambiente: SiigoAmbiente): Promise<EstadoCompuerta> {
  return evaluarCompuerta(ambiente, CONCEPTOS_FACTURABLES);
}

/**
 * Evalúa la compuerta sobre los conceptos indicados.
 *
 * En modo simulado devuelve `compuertaActiva: false` y **no bloquea** (AC3), pero sigue calculando
 * los motivos: son útiles para saber qué faltaría en real, y ocultarlos haría que el simulador
 * pareciera decir que todo está listo cuando no lo está.
 */
export async function evaluarCompuerta(
  ambiente: SiigoAmbiente, conceptos: readonly ConceptoFacturable[],
): Promise<EstadoCompuerta> {
  const modo = modoSiigo();
  const motivos = await evaluar(ambiente, conceptos);
  const activa = modo === 'real';

  return {
    ambiente,
    modo,
    compuertaActiva: activa,
    // En simulado se puede «emitir» siempre: no sale nada ante la DIAN.
    emisionRealHabilitada: activa ? motivos.length === 0 : true,
    motivos,
    conceptosEvaluados: [...conceptos],
  };
}

/**
 * AC1, AC4, AC6 — Lanza si la emisión real está bloqueada. Es lo que llamará el flujo de emisión.
 *
 * Se ejecuta ANTES de cualquier llamada a Siigo: el AC pide que la operación se rechace sin salir a
 * la red, y además una petición que se va a rechazar no debe gastar cuota de las 100 por minuto.
 *
 * Vive en el servidor y no depende de nada que decida el navegador (AC6): un cliente que llame al
 * endpoint de emisión directamente pasa exactamente por aquí.
 */
export async function exigirCompuertaAbierta(
  ambiente: SiigoAmbiente, liquidacion: ValoresLiquidacion,
): Promise<EstadoCompuerta> {
  const conceptos = conceptosAplicables(liquidacion);

  // CERO CONCEPTOS NO ES «TODO EN ORDEN». Sin esta guarda, una liquidación sin ningún valor deja el
  // bucle de evaluación sin ejecutarse, no produce ningún motivo de mapeo y —con la configuración
  // global completa— la compuerta abre habiendo comprobado exactamente nada. Es fallar en abierto en
  // el único control que impide que salga ante la DIAN una factura que nadie validó.
  //
  // La invariante que sostiene esta función: **cero conceptos evaluados nunca habilita emisión
  // real.** Se comprueba incluso en modo simulado, porque una liquidación vacía no es un problema de
  // parametrización sino de datos, y en simulado tampoco tiene sentido armar una factura sin líneas.
  if (conceptos.length === 0) {
    throw new SiigoCompuertaCerradaError(ambiente, [{
      tipo: 'sin_conceptos',
      detalle: 'La liquidación no trae ningún concepto facturable con valor. No hay nada que '
        + 'facturar, y emitir sin líneas no es una operación válida.',
    }]);
  }

  const estado = await evaluarCompuerta(ambiente, conceptos);
  if (!estado.emisionRealHabilitada) {
    throw new SiigoCompuertaCerradaError(ambiente, estado.motivos);
  }
  return estado;
}
