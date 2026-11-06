// Feature #13978, HU #13987 (ADR-0034 D3, D4) — motor de la rotación de `PII_ENC_KEY`.
//
// RN-RO8  No hay «origen» ni «destino»: todo lo que no esté en la versión vigente se recifra a la vigente.
//         `--target-version` es una afirmación del operador; si no coincide con la vigente, aborta. Por eso
//         la misma herramienta sirve de rollback y las filas mezcladas no son un caso aparte.
// RN-RO9  Antes de leer una sola fila, las llaves se comparan con el registro: cada versión configurada debe
//         descifrar su canario. Una versión sin fila aborta. El Job nunca registra (RN-LL2).
// RN-RO10 Canario de columna: si ninguna celda de la muestra descifra, normalmente es un descriptor mal
//         hecho. Esa columna no se escribe y la corrida sigue con las demás, con salida 2.
// RN-RO11 La salida lleva conteos e ids de fila. Nunca valores, causas, llaves, claves de objeto ni `numero`.

import { env } from '../../../config/env.js';
import { versionVigentePii } from '../../../shared/utils/crypto.js';
import { COLUMNAS_CIFRADAS_PII, type ColumnaCifrada } from '../../../shared/utils/pii-columnas.js';
import { pasadaPii } from '../../../shared/utils/pii-keyring.js';
import { comprobarLlavesSoloLectura, type EstadoLlaveRegistro } from './comprobar-llaves.js';
import { DESCRIPTORES } from './descriptores.js';
import { contarObjetosPrevios, limpiarObjetosPrevios, type ResultadoLimpieza } from './objetos-bolsas.js';
import type { Descriptor, FilaCifrada, IdFila } from './tipos.js';

export const MUESTRA_CANARIO_COLUMNA = 5;
/** Tope de ids por columna en la salida: `fallo` sigue contando el total. */
export const MAX_IDS_POR_COLUMNA = 200;

export type ModoRotacion = 'dry-run' | 'commit' | 'verificar' | 'solo-llaves' | 'limpiar-objetos';

export type MotivoAborto =
  | 'version_objetivo_no_vigente'
  | 'version_objetivo_sin_llave'
  | 'llave_no_coincide'
  | 'llave_sin_registro';

export interface ConteoColumnaRotacion {
  /** `no_verificado` en `--verificar`: ahí se descifra todo y no hace falta muestra. */
  canario: 'ok' | 'fallo' | 'sin_pendientes' | 'no_verificado';
  /** Celdas leídas por esta corrida. */
  recorridas: number;
  /** Celdas que se recifrarían o se recifraron, verificadas de vuelta. */
  recifrable: number;
  /** Escrituras efectivas. Siempre 0 salvo `--commit`. */
  escrito: number;
  omitido_concurrente: number;
  /** No descifró, no pasó la verificación de vuelta o no se pudo escribir. */
  fallo: number;
  /** Solo `--verificar`: celdas legibles en otra versión. */
  otra_version: number;
  /** Solo biometría: `viejo`, `data_uri` y `base64_plano`. Bloquean `--verificar`. */
  formato_legado: number;
  /** Solo biometría: no se sabe qué es. Se informa y no bloquea. */
  formato_desconocido: number;
  idsFallidos: IdFila[];
}

export interface ResultadoRotacion {
  modo: ModoRotacion;
  versionObjetivo: number | null;
  versionVigente: number;
  abortado: boolean;
  motivoAborto: MotivoAborto | null;
  llaves: { version: number; estado: EstadoLlaveRegistro }[];
  columnas: Partial<Record<ColumnaCifrada, ConteoColumnaRotacion>>;
  /** Objetos anteriores que siguen en MinIO y dependen de la llave que se va a retirar. */
  objetosPrevios: number;
  limpieza: ResultadoLimpieza | null;
  /** Lo que impide dar la corrida por terminada. Con más de 0, la salida es 2. */
  pendientes: number;
}

function conteoVacio(canario: ConteoColumnaRotacion['canario']): ConteoColumnaRotacion {
  return {
    canario, recorridas: 0, recifrable: 0, escrito: 0, omitido_concurrente: 0, fallo: 0, otra_version: 0,
    formato_legado: 0, formato_desconocido: 0, idsFallidos: [],
  };
}

function anotarFallo(c: ConteoColumnaRotacion, id: IdFila): void {
  c.fallo += 1;
  if (c.idsFallidos.length < MAX_IDS_POR_COLUMNA) c.idsFallidos.push(id);
}

async function descifra<C>(d: Descriptor<C>, fila: FilaCifrada<C>): Promise<boolean> {
  try {
    await d.descifrar(fila);
    return true;
  } catch {
    return false;
  }
}

/** Segunda barrera sobre lo que devolvió la consulta. Un formato ilegible cuenta como pendiente. */
function fueraDeVersion<C>(d: Descriptor<C>, fila: FilaCifrada<C>, version: number): boolean {
  try {
    return d.version(fila) !== version;
  } catch {
    return true;
  }
}

/** Cifrado comprobado de vuelta. Lanza si algo no cuadra; el texto en claro no sale de aquí. */
async function recifrar<C>(d: Descriptor<C>, fila: FilaCifrada<C>): Promise<C> {
  const plano = await d.descifrar(fila);
  const valor = d.cifrar(plano, fila);
  if (!(await d.descifrar({ ...fila, celda: valor })).equals(plano)) throw new Error('verificación fallida');
  return valor;
}

async function recorrerPendientes<C>(
  d: Descriptor<C>, version: number, commit: boolean, c: ConteoColumnaRotacion,
): Promise<void> {
  let despuesDe: IdFila | null = null;
  for (;;) {
    const lote: FilaCifrada<C>[] = await d.pendientes(despuesDe, version);
    if (lote.length === 0) return;
    for (const fila of lote) {
      if (!fueraDeVersion(d, fila, version)) continue;
      c.recorridas += 1;
      try {
        const valor = await recifrar(d, fila);
        c.recifrable += 1;
        if (!commit) continue;
        if (await d.escribir(fila, valor)) c.escrito += 1;
        else c.omitido_concurrente += 1;
      } catch {
        // Sin la causa en el reporte: así nada del dato puede colarse.
        anotarFallo(c, fila.id);
      }
    }
    despuesDe = lote[lote.length - 1].id;
  }
}

async function columnaRecifrado<C>(d: Descriptor<C>, version: number, commit: boolean): Promise<ConteoColumnaRotacion> {
  const muestra = (await d.muestra(MUESTRA_CANARIO_COLUMNA, version)).filter((f) => fueraDeVersion(d, f, version));
  const c = conteoVacio('sin_pendientes');
  if (muestra.length > 0) {
    let alguna = false;
    for (const fila of muestra) {
      if (await descifra(d, fila)) {
        alguna = true;
        break;
      }
    }
    if (!alguna) {
      c.canario = 'fallo';
      c.recorridas = muestra.length;
      for (const fila of muestra) anotarFallo(c, fila.id);
      return c;
    }
    c.canario = 'ok';
    await recorrerPendientes(d, version, commit, c);
  }
  await anotarLegado(d, c);
  return c;
}

async function anotarLegado<C>(d: Descriptor<C>, c: ConteoColumnaRotacion): Promise<void> {
  if (!d.legado) return;
  const { bloquean, desconocido } = await d.legado();
  c.formato_legado = bloquean;
  c.formato_desconocido = desconocido;
}

async function columnaVerificacion<C>(d: Descriptor<C>, version: number): Promise<ConteoColumnaRotacion> {
  const c = conteoVacio('no_verificado');
  let despuesDe: IdFila | null = null;
  for (;;) {
    const lote: FilaCifrada<C>[] = await d.todas(despuesDe);
    if (lote.length === 0) break;
    for (const fila of lote) {
      c.recorridas += 1;
      if (!await descifra(d, fila)) {
        anotarFallo(c, fila.id);
      } else if (fueraDeVersion(d, fila, version)) {
        c.otra_version += 1;
        if (c.idsFallidos.length < MAX_IDS_POR_COLUMNA) c.idsFallidos.push(fila.id);
      }
    }
    despuesDe = lote[lote.length - 1].id;
  }
  await anotarLegado(d, c);
  return c;
}

function sumarPendientes(modo: ModoRotacion, c: ConteoColumnaRotacion): number {
  if (modo === 'verificar') return c.fallo + c.otra_version + c.formato_legado;
  return c.fallo + c.omitido_concurrente;
}

export interface OpcionesRotacion {
  modo: ModoRotacion;
  /** Obligatoria en `dry-run`, `commit` y `verificar`. */
  versionObjetivo?: number;
}

/** Corre una pasada. `descriptores` se inyecta solo en la prueba del canario de columna. */
export async function ejecutarRotacion(
  { modo, versionObjetivo }: OpcionesRotacion,
  descriptores: Record<ColumnaCifrada, Descriptor<unknown>> = DESCRIPTORES,
): Promise<ResultadoRotacion> {
  const versionVigente = versionVigentePii();
  const r: ResultadoRotacion = {
    modo, versionObjetivo: versionObjetivo ?? null, versionVigente, abortado: false, motivoAborto: null,
    llaves: [], columnas: {}, objetosPrevios: 0, limpieza: null, pendientes: 0,
  };
  const abortar = (motivo: MotivoAborto) => {
    r.abortado = true;
    r.motivoAborto = motivo;
    return r;
  };

  if (versionObjetivo !== undefined) {
    if (!pasadaPii(versionObjetivo, env.PII_ENC_KEY)) return abortar('version_objetivo_sin_llave');
    if (versionObjetivo !== versionVigente) return abortar('version_objetivo_no_vigente');
  }

  r.llaves = await comprobarLlavesSoloLectura();
  if (r.llaves.some((l) => l.estado === 'no_coincide')) return abortar('llave_no_coincide');
  if (r.llaves.some((l) => l.estado === 'sin_registro')) return abortar('llave_sin_registro');
  if (modo === 'solo-llaves') return r;

  if (modo === 'limpiar-objetos') {
    r.limpieza = await limpiarObjetosPrevios(versionVigente);
    r.pendientes = r.limpieza.fallo + r.limpieza.omitido_concurrente + r.limpieza.omitido_otra_version;
    r.objetosPrevios = await contarObjetosPrevios();
    return r;
  }

  const version = versionObjetivo ?? versionVigente;
  for (const { id } of COLUMNAS_CIFRADAS_PII) {
    const d = descriptores[id];
    const c = modo === 'verificar'
      ? await columnaVerificacion(d, version)
      : await columnaRecifrado(d, version, modo === 'commit');
    r.columnas[id] = c;
    r.pendientes += sumarPendientes(modo, c);
  }
  r.objetosPrevios = await contarObjetosPrevios();
  return r;
}

/**
 * 0 terminada · 2 quedan pendientes, se puede volver a correr · 1 abortó con cero escrituras.
 * Un dry-run con fallos sale 2 (D4): su propósito es avisar antes del `--commit`.
 */
export function codigoSalidaRotacion(r: ResultadoRotacion): number {
  if (r.abortado) return 1;
  return r.pendientes === 0 ? 0 : 2;
}
