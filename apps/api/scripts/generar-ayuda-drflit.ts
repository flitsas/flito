// HU #13853 (Feature #13696, IA-1 · ADR-0027) — genera el catálogo de fichas de Ayuda para el API.
//
//   npm run ayuda:drflit -w apps/api
//
// Lee los `.md` de `apps/web/src/content/ayuda/` con `fs` (NO importa `cargarFichas.ts`: usa
// `import.meta.glob` de Vite) y reutiliza el código PURO del web — `CATALOGO_AYUDA`, `parsearFicha` y
// `seccionesDeFicha` (anclas de `parseMarkdown`) — para que las anclas sean idénticas a las del web.
// Escribe `src/modules/flito-dr-flit/ayuda/fichas-ayuda.generated.ts`, que se commitea y es
// AUTOSUFICIENTE: no importa nada del web en runtime (la imagen Docker del API no copia `apps/web`).
//
// Reglas:
//   · Entrada del catálogo sin `.md` (ficha pendiente) → no entra (AC2).
//   · Entrada sin `permiso` → no entra (el catálogo la trata como no listable: fail-closed).
//   · Ficha con encabezado inválido → el generador FALLA (la prueba de artefactos del web también).
//
// La prueba de deriva (`__tests__/services/flito-dr-flit/ayuda-generada.test.ts`) llama a
// `generarArtefacto()` en memoria y lo compara con el archivo commiteado (AC3).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOGO_AYUDA } from '../../web/src/content/ayuda/catalogo';
import { parsearFicha } from '../../web/src/lib/ayudaFicha';
import { seccionesDeFicha } from '../../web/src/lib/drFlitBusqueda';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
export const DIR_FICHAS = path.resolve(AQUI, '../../web/src/content/ayuda');
export const RUTA_ARTEFACTO = path.resolve(AQUI, '../src/modules/flito-dr-flit/ayuda/fichas-ayuda.generated.ts');

export const COMANDO_REGENERAR = 'npm run ayuda:drflit -w apps/api';

interface SeccionGenerada {
  ancla: string;
  titulo: string;
  texto: string;
}

interface FichaGenerada {
  clave: string;
  permiso: string;
  etiqueta: string;
  resumen: string;
  version: string;
  fecha: string;
  palabrasClave: string[];
  consultas: string[];
  secciones: SeccionGenerada[];
}

/** Fichas publicadas (con `.md` y `permiso`), en el orden del catálogo. */
export function fichasPublicadas(dir: string = DIR_FICHAS): FichaGenerada[] {
  const fichas: FichaGenerada[] = [];
  for (const entrada of CATALOGO_AYUDA) {
    const archivo = path.join(dir, `${entrada.clave}.md`);
    if (!entrada.permiso || !existsSync(archivo)) continue;
    const ficha = parsearFicha(readFileSync(archivo, 'utf8'));
    if (!ficha.encabezado || ficha.errores.length > 0) {
      throw new Error(`Ficha ${entrada.clave}.md con encabezado inválido: ${ficha.errores.join(' ')}`);
    }
    const { resumen, version, fecha, palabrasClave, consultas } = ficha.encabezado;
    fichas.push({
      clave: entrada.clave,
      permiso: entrada.permiso,
      etiqueta: entrada.etiqueta,
      resumen,
      version,
      fecha,
      palabrasClave: [...palabrasClave],
      consultas: [...consultas],
      secciones: seccionesDeFicha(entrada, ficha).map((s) => ({ ancla: s.ancla, titulo: s.tituloSeccion, texto: s.texto })),
    });
  }
  return fichas;
}

const CABECERA = `// ARCHIVO GENERADO — NO EDITAR A MANO (HU #13853, ADR-0027).
// Fuente: apps/web/src/content/ayuda/*.md + catalogo.ts. Regenerar con: ${COMANDO_REGENERAR}
// Si edita una ficha y no regenera, falla el test de deriva del API en CI.
// Autosuficiente: no importa nada del web (la imagen del API no copia apps/web).

export interface SeccionFichaAyuda {
  /** \`id\` del encabezado h1–h3 tal como lo emite \`parseMarkdown\` del web. */
  readonly ancla: string;
  readonly titulo: string;
  /** Texto plano de la sección (sin bloques de código). */
  readonly texto: string;
}

export interface FichaAyudaApi {
  readonly clave: string;
  /** PageSlug del catálogo: la ficha es visible con \`pagina.<permiso>\`. */
  readonly permiso: string;
  readonly etiqueta: string;
  readonly resumen: string;
  readonly version: string;
  readonly fecha: string;
  readonly palabrasClave: readonly string[];
  readonly consultas: readonly string[];
  readonly secciones: readonly SeccionFichaAyuda[];
}
`;

/** Contenido completo del artefacto. Determinista: mismo árbol de fichas → mismo texto. */
export function generarArtefacto(dir: string = DIR_FICHAS): string {
  const datos = JSON.stringify(fichasPublicadas(dir), null, 2);
  return `${CABECERA}
export const FICHAS_AYUDA: readonly FichaAyudaApi[] = Object.freeze(${datos} as FichaAyudaApi[]);
`;
}

function main(): void {
  const contenido = generarArtefacto();
  mkdirSync(path.dirname(RUTA_ARTEFACTO), { recursive: true });
  const previo = existsSync(RUTA_ARTEFACTO) ? readFileSync(RUTA_ARTEFACTO, 'utf8') : null;
  if (previo === contenido) {
    console.log(`Sin cambios: ${path.relative(process.cwd(), RUTA_ARTEFACTO)}`);
    return;
  }
  writeFileSync(RUTA_ARTEFACTO, contenido, 'utf8');
  console.log(`Escrito: ${path.relative(process.cwd(), RUTA_ARTEFACTO)} (${contenido.length} car)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
