// Glob lazy de las fichas. Vite resuelve las claves en build; el contenido se pide al abrir
// la ficha o, en el índice, los cuerpos de los capítulos **visibles** (HU #11901).
// `_plantilla.md` no es ficha: se toca solo para detectar un bundle roto (error ≠ pendiente).

const LOADERS = import.meta.glob<string>('./*.md', { query: '?raw', import: 'default' });

export function existeFichaMd(slug: string): boolean {
  return `./${slug}.md` in LOADERS;
}

/** Falla si el bundle de ayuda no se puede leer. Ausencia de una ficha NO pasa por aquí. */
export async function verificarBundleAyuda(): Promise<void> {
  const plantilla = LOADERS['./_plantilla.md'];
  if (!plantilla) {
    throw new Error('No se encontró la plantilla de fichas de ayuda.');
  }
  await plantilla();
}

/** `null` = el archivo no existe (ficha pendiente). Un throw = error de lectura. */
export async function leerFichaMd(slug: string): Promise<string | null> {
  const loader = LOADERS[`./${slug}.md`];
  if (!loader) return null;
  return loader();
}

/**
 * Cuerpos de las claves pedidas. El índice solo pasa capítulos **visibles**.
 * `null` = pendiente (sin archivo). Un throw de cualquier lectura = error (no lista a medias).
 */
export async function leerFichasMd(slugs: readonly string[]): Promise<Map<string, string | null>> {
  const pares = await Promise.all(
    slugs.map(async (slug) => {
      const cuerpo = await leerFichaMd(slug);
      return [slug, cuerpo] as const;
    }),
  );
  return new Map(pares);
}
