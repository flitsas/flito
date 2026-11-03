/**
 * Feature #14097 (HU #14098) — lleva las fotos de `tramites_validaciones` que siguen en BD al formato
 * `encryptPiiText` (`v1:…`, AAD `tabla|columna|id`).
 *
 *   Cifra:     viejo, data_uri, base64_plano.
 *   No toca:   nuevo (ya migrado), storage_key (vive en MinIO), desconocido (no se sabe qué es).
 *
 * Reanudable e idempotente por clase: lo ya escrito clasifica como `nuevo` y la siguiente corrida lo
 * salta. Lotes de 50 porque una sola fila puede traer tres fotos de varios MB.
 *
 * Nunca imprime valores, ni parciales: solo conteos por columna y clase, e ids de las filas fallidas.
 *
 * Uso (Job en QA/PDN: `docs/arquitectura/feature-14097-recifrado-biometria.md`):
 *   npm run tramites:recifrar-biometria -w apps/api -- --dry-run   # no escribe; sí intenta descifrar
 *   npm run tramites:recifrar-biometria -w apps/api -- --commit    # escribe
 *
 * Salida: 0 si no quedan pendientes o es dry-run; 2 si quedan (se puede volver a correr); 1 si aborta.
 */

import { and, asc, eq, gt, isNotNull, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tramitesValidaciones } from '../db/schema.js';
import { clasificarFoto, TABLA_FOTOS, type ClaseFoto, type ColumnaFoto } from '../modules/tramites/identidad.fotos.js';
import { decryptLegacyBiometric, decryptPiiText, encryptPiiText } from '../shared/utils/crypto.js';

export const LOTE = 50;

const COLUMNAS = [
  { columna: 'foto_rostro', prop: 'fotoRostro', col: tramitesValidaciones.fotoRostro },
  { columna: 'foto_cedula_frontal', prop: 'fotoCedulaFrontal', col: tramitesValidaciones.fotoCedulaFrontal },
  { columna: 'foto_cedula_reverso', prop: 'fotoCedulaReverso', col: tramitesValidaciones.fotoCedulaReverso },
] as const;

type ColumnaProp = (typeof COLUMNAS)[number]['prop'];
type FilaFotos = { id: number } & Record<ColumnaProp, string | null>;

export interface ConteoColumna extends Record<ClaseFoto, number> {
  /** Celdas que el script cifró (commit) o cifraría (dry-run), verificadas de vuelta. */
  recifrable: number;
  /** Escrituras efectivas. Siempre 0 en dry-run. */
  escrito: number;
  /** La fila cambió entre la lectura y la escritura (p. ej. el cron de retención la anonimizó). */
  omitido_concurrente: number;
  /** No se pudo descifrar o no pasó la verificación de vuelta: no se escribió. */
  viejo_indescifrable: number;
}

export interface Resultado {
  modo: 'dry-run' | 'commit';
  filas: number;
  columnas: Record<ColumnaFoto, ConteoColumna>;
  /** Ids de las filas con alguna celda fallida. */
  idsFallidos: number[];
  /** Celdas que una corrida real tendría que volver a intentar. */
  pendientes: number;
}

function conteoVacio(): ConteoColumna {
  return {
    vacio: 0, storage_key: 0, nuevo: 0, viejo: 0, data_uri: 0, base64_plano: 0, desconocido: 0,
    recifrable: 0, escrito: 0, omitido_concurrente: 0, viejo_indescifrable: 0,
  };
}

function leerLote(despuesDeId: number): Promise<FilaFotos[]> {
  return db.select({
    id: tramitesValidaciones.id,
    fotoRostro: tramitesValidaciones.fotoRostro,
    fotoCedulaFrontal: tramitesValidaciones.fotoCedulaFrontal,
    fotoCedulaReverso: tramitesValidaciones.fotoCedulaReverso,
  }).from(tramitesValidaciones)
    .where(and(
      gt(tramitesValidaciones.id, despuesDeId),
      or(
        isNotNull(tramitesValidaciones.fotoRostro),
        isNotNull(tramitesValidaciones.fotoCedulaFrontal),
        isNotNull(tramitesValidaciones.fotoCedulaReverso),
      ),
    ))
    .orderBy(asc(tramitesValidaciones.id))
    .limit(LOTE);
}

/** Cifrado comprobado de vuelta. Lanza si algo no cuadra; el texto en claro no sale de aquí. */
function recifrar(valor: string, clase: ClaseFoto, columna: ColumnaFoto, id: number): string {
  const ctx = { table: TABLA_FOTOS, column: columna, id };
  const plano = clase === 'viejo' ? decryptLegacyBiometric(valor, ctx) : valor;
  const cifrado = encryptPiiText(plano, ctx);
  if (decryptPiiText(cifrado, ctx) !== plano) throw new Error('verificación fallida');
  return cifrado;
}

/** La condición sobre el valor leído evita pisar lo que otro proceso haya cambiado mientras tanto. */
async function escribir(
  id: number,
  { prop, col }: (typeof COLUMNAS)[number],
  leido: string,
  cifrado: string,
): Promise<boolean> {
  const filas = await db.update(tramitesValidaciones)
    .set({ [prop]: cifrado })
    .where(and(eq(tramitesValidaciones.id, id), eq(col, leido)))
    .returning({ id: tramitesValidaciones.id });
  return filas.length > 0;
}

export async function run({ commit }: { commit: boolean }): Promise<Resultado> {
  const res: Resultado = {
    modo: commit ? 'commit' : 'dry-run',
    filas: 0,
    columnas: {
      foto_rostro: conteoVacio(),
      foto_cedula_frontal: conteoVacio(),
      foto_cedula_reverso: conteoVacio(),
    },
    idsFallidos: [],
    pendientes: 0,
  };
  const fallidos = new Set<number>();

  let ultimoId = 0;
  for (;;) {
    const lote = await leerLote(ultimoId);
    if (lote.length === 0) break;

    for (const fila of lote) {
      res.filas++;
      for (const def of COLUMNAS) {
        const valor = fila[def.prop];
        const clase = clasificarFoto(valor);
        const conteo = res.columnas[def.columna];
        conteo[clase]++;
        if (clase !== 'viejo' && clase !== 'data_uri' && clase !== 'base64_plano') continue;

        let cifrado: string;
        try {
          cifrado = recifrar(valor as string, clase, def.columna, fila.id);
        } catch {
          // Sin el error en el reporte: la causa no aporta y así nada del dato puede colarse.
          conteo.viejo_indescifrable++;
          fallidos.add(fila.id);
          res.pendientes++;
          continue;
        }
        conteo.recifrable++;
        if (!commit) continue;

        if (await escribir(fila.id, def, valor as string, cifrado)) {
          conteo.escrito++;
        } else {
          conteo.omitido_concurrente++;
          res.pendientes++;
        }
      }
    }
    ultimoId = lote[lote.length - 1].id;
  }

  res.idsFallidos = [...fallidos].sort((a, b) => a - b);
  return res;
}

/** Exige la bandera: un script que reescribe biometría no decide solo si corre en serio. */
export function modoDesdeArgs(args: string[]): { commit: boolean } | null {
  const dry = args.includes('--dry-run');
  const commit = args.includes('--commit');
  if (dry === commit) return null;
  return { commit };
}

export function codigoSalida(r: Resultado): number {
  return r.modo === 'dry-run' || r.pendientes === 0 ? 0 : 2;
}

const argv1 = process.argv[1] ?? '';
const isDirectRun = (
  process.env.VITEST !== 'true' &&
  process.env.NODE_ENV !== 'test' &&
  (argv1.endsWith('flito-recifrar-biometria.ts') || argv1.endsWith('flito-recifrar-biometria.js'))
);

if (isDirectRun) {
  const modo = modoDesdeArgs(process.argv.slice(2));
  if (!modo) {
    console.error('[abort] indica exactamente una bandera: --dry-run o --commit');
    process.exit(1);
  }
  run(modo).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(codigoSalida(r));
  }).catch((e) => {
    console.error('[error]', e instanceof Error ? e.name : 'fallo');
    process.exit(1);
  });
}
