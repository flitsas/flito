// Glob lazy de las fichas. Vite resuelve las claves en build; el contenido se pide al abrir.
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
