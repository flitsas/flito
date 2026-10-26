// Dr. Flit — consultas de gestión sin IA (Feature #13834, HU #13836 G1).
// Diseño: docs/diseno/feature-13834-dr-flit-consultas-gestion.md §Web · UX: docs/ux/flito-dr-flit-f6.md.
//
// PURO: sin React ni `lib/api.ts`, para que `node --experimental-strip-types --test` lo cargue tal
// cual. Su único import de valor son los patrones de shared-types (HU #13855: fuente única con la
// máscara de la IA), por ruta relativa al `.ts` —no por `@operaciones/shared-types`— porque Node y el
// runner de Playwright resolverían el paquete a `dist/`, que el job E2E de CI no construye. Las llamadas al API viven en
// `drFlitGestionConsulta.ts` (punto de entrada para F4: `consultarGestion` + `modulosAConsultar`).
// Nada de esto sale a IA (AC10): el detector corre en el navegador y el valor solo viaja en el body
// de `POST /api/flito/<modulo>/buscar`.

import type { ModuloGestion } from '@operaciones/shared-types';
import {
  esVin, ID_FLIT, PLACA_CARRO, PLACA_CON_GUION, PLACA_MOTO,
} from '../../../../packages/shared-types/src/flito-dr-flit-mascara.ts';

export type TipoValorGestion = 'placa' | 'vin' | 'idFlit';

export interface ValorDetectado {
  tipo: TipoValorGestion;
  /** Normalizado a mayúsculas. */
  valor: string;
}

// Patrones (placa de carro/moto, VIN, id FLIT `FLIT-…`/`FT2-…`): `flito-dr-flit-mascara.ts`.
// HU #13855: F6 también ofrece la placa con guion (`ABC-123` → `ABC123`, igual que la máscara). NO
// aplica NFKC ni une `ABC 123` con espacio: lo demás de lo que ofrece F6 no cambia (AC8).

function tipoDeToken(token: string): TipoValorGestion | null {
  if (ID_FLIT.test(token)) return 'idFlit';
  if (PLACA_CARRO.test(token) || PLACA_MOTO.test(token)) return 'placa';
  if (esVin(token)) return 'vin';
  return null;
}

/**
 * Primer valor de gestión del mensaje, en orden de lectura (AC1); `null` si no hay ninguno (AC2:
 * un número suelto, una cédula o un nombre no disparan nada). Los tokens se comparan en mayúsculas.
 */
export function detectarValorGestion(texto: string): ValorDetectado | null {
  for (const crudo of texto.split(/[^A-Za-z0-9-]+/)) {
    // Un guion al borde («ABC123-») no forma parte del valor; dentro sí (id FLIT).
    const conGuion = crudo.replace(/^-+|-+$/g, '').toUpperCase();
    const token = PLACA_CON_GUION.test(conGuion) ? conGuion.replace('-', '') : conGuion;
    if (!token) continue;
    const tipo = tipoDeToken(token);
    if (tipo) return { tipo, valor: token };
  }
  return null;
}

/** Entrada del registro de módulos de gestión. G2 (SOAT) y G3 (impuestos, derechos) añaden la suya. */
export interface ModuloGestionWeb {
  modulo: ModuloGestion;
  /** `PageSlug` del módulo (`hasPage`). */
  page: string;
  /** Función que exige el `POST …/buscar` (y que la cola ya exige). */
  funcion: string;
  /** Tipos de valor que el módulo acepta (tabla del despachador, UX F6.3). */
  acepta: readonly TipoValorGestion[];
  /** Nombre del grupo, el del menú. */
  etiqueta: string;
  /** Pantalla del módulo, SIN query (UX F6.7, regla 14). */
  ruta: string;
}

/** Registro en el orden fijo de los grupos: Trámites, SOAT, Impuestos, Derechos (UX F6.3). */
export const MODULOS_GESTION_WEB: readonly ModuloGestionWeb[] = [
  {
    modulo: 'tramites',
    page: 'flito_tramites',
    funcion: 'tramites.cola.ver',
    acepta: ['placa', 'vin', 'idFlit'],
    etiqueta: 'Trámites',
    ruta: '/flito/tramites',
  },
  {
    // HU #13837 (G2): SOAT no tiene id FLIT (UX F6.3) → un id FLIT no lo consulta (AC8).
    modulo: 'soat',
    page: 'flito_soat',
    funcion: 'soat.cola.ver',
    acepta: ['placa', 'vin'],
    etiqueta: 'SOAT',
    ruta: '/flito/soat',
  },
  {
    // HU #13838 (G3): Impuestos acepta los tres tipos de valor (UX F6.3).
    modulo: 'impuestos',
    page: 'flito_impuestos',
    funcion: 'impuestos.cola.ver',
    acepta: ['placa', 'vin', 'idFlit'],
    etiqueta: 'Impuestos',
    ruta: '/flito/impuestos',
  },
  {
    // HU #13838 (G3): Derechos no tiene VIN (UX F6.3) → un VIN no lo consulta (AC3).
    modulo: 'derechos',
    page: 'flito_derechos',
    funcion: 'derechos.cola.ver',
    acepta: ['placa', 'idFlit'],
    etiqueta: 'Derechos',
    ruta: '/flito/derechos',
  },
];

export function moduloGestionWeb(
  modulo: ModuloGestion, registro: readonly ModuloGestionWeb[] = MODULOS_GESTION_WEB,
): ModuloGestionWeb | undefined {
  return registro.find((m) => m.modulo === modulo);
}

/**
 * Módulos a consultar para un tipo de valor (AC7): los que aceptan ese tipo **y** que el usuario
 * ve (`hasPage`) **y** cuya función tiene (`hasFuncion`). Lista vacía = no se ofrece la consulta.
 */
export function modulosAConsultar(
  tipo: TipoValorGestion,
  puede: (page: string, funcion: string) => boolean,
  registro: readonly ModuloGestionWeb[] = MODULOS_GESTION_WEB,
): ModuloGestion[] {
  return registro.filter((m) => m.acepta.includes(tipo) && puede(m.page, m.funcion)).map((m) => m.modulo);
}

// ── Mensajes de gestión en la conversación ───────────────────────────────────────────────────────
// Viven en memoria con el valor; al guardar en `sessionStorage` (AC8) el turno entero se cambia por
// un marcador sin valor (`sinValoresDeGestion`, que usa `serializar`).

type BaseGestion = { id: string; ts: number; de: 'drflit' };

/** `viva`: con sus dos botones · `consultada` / `manuales`: sin botones · `ignorada`: «No consulté …». */
export type EstadoOfertaGestion = 'viva' | 'consultada' | 'manuales' | 'ignorada';

export type MensajeOfertaGestion = BaseGestion & {
  tipo: 'ofertaGestion';
  /** Id del mensaje del usuario que contenía el valor. */
  respondeA: string;
  valor: string;
  tipoValor: TipoValorGestion;
  estado: EstadoOfertaGestion;
  /**
   * HU #13858 (IA-6 AC4): la IA pidió gestión sin `gestionRef` y el mensaje trae varios valores del
   * tipo. Hasta 3 (`valor` = el primero), un botón por valor; `consultados` son los ya pulsados (la
   * oferta sigue `viva` mientras quede alguno) y `mas` = el mensaje traía más de 3.
   */
  varios?: { valores: string[]; consultados: string[]; mas: boolean };
};

export type MensajeResultadoGestion = BaseGestion & {
  tipo: 'resultadoGestion';
  valor: string;
  tipoValor: TipoValorGestion;
  /** Módulos consultados, en el orden fijo. */
  modulos: ModuloGestion[];
};

/** Lo único que se guarda de un turno con valor. `consulta` = hubo consulta («Volver a consultar»). */
export type MensajeMarcadorGestion = BaseGestion & { tipo: 'marcadorGestion'; consulta: boolean };

export type MensajeGestion = MensajeOfertaGestion | MensajeResultadoGestion | MensajeMarcadorGestion;

const TIPOS_GESTION = new Set(['ofertaGestion', 'resultadoGestion', 'marcadorGestion']);

export function esMensajeGestion(m: { tipo: string }): m is MensajeGestion {
  return TIPOS_GESTION.has(m.tipo);
}

/**
 * Forma guardable de la conversación (AC8, UX F6.9): la oferta y el resultado no se guardan; el
 * mensaje del usuario en el que el detector encuentra un valor se cambia por un marcador sin valor
 * (con o sin consulta). Así el almacén no tiene placa, VIN, id FLIT ni campo de tarjeta alguno.
 */
export function sinValoresDeGestion<M extends { id: string; ts: number; tipo: string }>(
  mensajes: readonly (M | MensajeGestion)[],
): (M | MensajeMarcadorGestion)[] {
  const consultadas = new Set<string>();
  for (const m of mensajes) {
    const o = m as MensajeOfertaGestion;
    if (m.tipo === 'ofertaGestion' && (o.estado === 'consultada' || (o.varios?.consultados.length ?? 0) > 0)) {
      consultadas.add((m as MensajeOfertaGestion).respondeA);
    }
  }
  const salida: (M | MensajeMarcadorGestion)[] = [];
  for (const m of mensajes) {
    if (m.tipo === 'ofertaGestion' || m.tipo === 'resultadoGestion') continue;
    const texto = (m as { texto?: unknown }).texto;
    if (typeof texto === 'string' && detectarValorGestion(texto)) {
      salida.push({ id: m.id, ts: m.ts, de: 'drflit', tipo: 'marcadorGestion', consulta: consultadas.has(m.id) });
      continue;
    }
    salida.push(m as M | MensajeMarcadorGestion);
  }
  return salida;
}

// ── Resumen del bloque (UX F6.8 / F6.11) ─────────────────────────────────────────────────────────

/** Estado de un grupo. `oculto` = 0 resultados o 403 (el grupo no aparece, P9-A). */
export type GrupoGestion =
  | { estado: 'cargando' }
  | { estado: 'ok'; total: number; items: unknown[] }
  | { estado: 'error'; status: number }
  | { estado: 'oculto' };

export const COPY_429 = 'Hizo muchas consultas seguidas; intente en un momento.';

export type FaseBloque =
  | { fase: 'cargando' }
  | { fase: 'lleno'; coincidencias: number; modulos: number; conError: boolean }
  | { fase: 'mixto' }
  | { fase: 'error'; todos429: boolean }
  | { fase: 'vacio' };

/** Fase global del bloque a partir de sus grupos (sin grupos = vacío: nada que consultar). */
export function faseBloque(grupos: readonly GrupoGestion[]): FaseBloque {
  if (grupos.some((g) => g.estado === 'cargando')) return { fase: 'cargando' };
  const llenos = grupos.filter((g): g is Extract<GrupoGestion, { estado: 'ok' }> => g.estado === 'ok');
  const errores = grupos.filter((g): g is Extract<GrupoGestion, { estado: 'error' }> => g.estado === 'error');
  if (llenos.length > 0) {
    return {
      fase: 'lleno',
      coincidencias: llenos.reduce((s, g) => s + g.total, 0),
      modulos: llenos.length,
      conError: errores.length > 0,
    };
  }
  if (errores.length > 0 && errores.length === grupos.length) {
    return { fase: 'error', todos429: errores.every((g) => g.status === 429) };
  }
  if (errores.length > 0) return { fase: 'mixto' };
  return { fase: 'vacio' };
}

/** «Encontré N coincidencias en M módulos.» con singulares (UX F6.11). */
export function textoResumen(coincidencias: number, modulos: number): string {
  const c = coincidencias === 1 ? '1 coincidencia' : `${coincidencias} coincidencias`;
  const m = modulos === 1 ? '1 módulo' : `${modulos} módulos`;
  return `Encontré ${c} en ${m}.`;
}
