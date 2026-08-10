// Siigo — compuerta de emisión real (HU #11285, Feature #11240).
//
// Lo que impide que salga ante la DIAN una factura con un tratamiento tributario que nadie validó.
//
// La compuerta responde UNA pregunta: ¿se puede emitir CONTRA EL AMBIENTE REAL ahora mismo? Y la
// responde con dos insumos, ambos por ambiente: el mapeo de conceptos (HU #11282/#11283) y la
// configuración global de emisión (HU #11284).
//
// Tres cosas que conviene no perder de vista:
//
//   1. **Solo pesan los conceptos que APLICAN** (AC2). Un trámite sin logística no tiene por qué
//      esperar a que alguien confirme la logística. Qué aplica lo dice la liquidación sellada, y
//      ahí `null` significa «no aplica» mientras que `0` significa «aplica y vale cero». Esa
//      distinción ya la sostiene `flito_liquidaciones` y **no se reinterpreta aquí**.
//   2. **En modo simulado la compuerta no aplica** (AC3), pero se dice. Una respuesta que no
//      distinga «emitido» de «simulado con la compuerta inactiva» es la forma de creer que se
//      facturó cuando no salió nada.
//   3. **Vive en el servidor** (AC6). No hay ninguna decisión delegada al navegador: quien llame al
//      endpoint de emisión directamente recibe el mismo rechazo.

import type { ConceptoFacturable } from './siigo-facturacion.js';
import type { CampoCatalogoEmision } from './siigo-emision.js';

/**
 * Por qué está cerrada la compuerta. Cada tipo lleva una acción distinta, y por eso son valores
 * separados en vez de un texto suelto:
 *
 *   · `concepto_sin_confirmar` → contabilidad tiene que firmar el concepto.
 *   · `concepto_no_listo`      → falta producto, clasificación, o el producto dejó de ser válido.
 *   · `config_incompleta`      → faltan valores en la configuración global de emisión.
 *   · `config_invalida`        → los hay, pero dejaron de existir o quedaron inactivos en Siigo.
 *   · `sin_configurar`         → nadie ha guardado todavía una configuración en este ambiente.
 *   · `sin_conceptos`          → la liquidación no trae ni un concepto facturable. NO es «todo en
 *     orden»: es que no hay nada que comprobar, y una compuerta que abre sin haber comprobado nada
 *     no es una compuerta.
 */
export const TIPOS_MOTIVO_COMPUERTA = [
  'concepto_sin_confirmar',
  'concepto_no_listo',
  'config_incompleta',
  'config_invalida',
  'sin_configurar',
  'sin_conceptos',
] as const;

export type TipoMotivoCompuerta = typeof TIPOS_MOTIVO_COMPUERTA[number];

/** Un motivo concreto por el que la emisión real está bloqueada. */
export interface MotivoCompuerta {
  tipo: TipoMotivoCompuerta;
  /** Texto accionable para quien parametriza. */
  detalle: string;
  /** Conceptos implicados, cuando el motivo es de mapeo. */
  conceptos?: ConceptoFacturable[];
  /** Campos implicados, cuando el motivo es de configuración global. */
  campos?: CampoCatalogoEmision[];
}

/** Veredicto de la compuerta para un ambiente. */
export interface EstadoCompuerta {
  ambiente: string;
  /** `mock` | `real`. En `mock` la compuerta no bloquea (AC3). */
  modo: string;
  /**
   * false en modo simulado. Se informa siempre, incluso cuando la emisión procede: una respuesta
   * que no distinga «emitido» de «simulado con la compuerta inactiva» hace creer que se facturó.
   */
  compuertaActiva: boolean;
  /** true = se puede emitir contra el ambiente real ahora mismo. */
  emisionRealHabilitada: boolean;
  /** Vacío cuando `emisionRealHabilitada` es true. */
  motivos: MotivoCompuerta[];
  /**
   * Conceptos que se evaluaron. Para el estado global son los seis; para un trámite concreto, solo
   * los que su liquidación sellada trae con valor.
   */
  conceptosEvaluados: ConceptoFacturable[];
}

// `ValoresLiquidacion` vive en `siigo-facturacion.ts`, junto al mapa concepto→columna con el que
// tiene que cuadrar campo a campo. Separarlos era lo que permitía que el mapa se tipara como
// `Record<…, string>` y que quien indexara necesitara un `as keyof`, desactivando la comprobación.
