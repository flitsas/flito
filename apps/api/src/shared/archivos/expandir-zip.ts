// Expansión de ZIP en la ingesta de archivos.
//
// Un ZIP es una caja: se abre y se procesa cada archivo que trae. Esta es la versión genérica,
// escrita para la carga de derechos de tránsito (HU #10950).
//
// Nota: `flito-impuestos/flito-recibos.service.ts` tiene su propia `expandir()` porque además deduce
// del nombre de la carpeta si la copia lleva marca de agua — semántica que solo aplica a los recibos
// de impuestos. Migrarla a esta utilidad es un refactor aparte; no se toca aquí para no arrastrar un
// flujo en producción dentro de una HU que no lo necesita.

import JSZip from 'jszip';

export interface ArchivoPlano {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
  /** Ruta dentro del ZIP, si vino de uno. Útil para trazar el origen en los reportes. */
  rutaEnZip?: string;
}

const esZip = (a: { mimetype: string; originalname: string }): boolean =>
  a.mimetype.includes('zip') || a.originalname.toLowerCase().endsWith('.zip');

/** MIME deducido de la extensión: dentro del ZIP no viaja el content-type original. */
function mimeDeExtension(nombre: string): string {
  const n = nombre.toLowerCase();
  if (n.endsWith('.pdf')) return 'application/pdf';
  if (/\.(jpg|jpeg)$/.test(n)) return 'image/jpeg';
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

/**
 * Devuelve la lista de archivos reales: los sueltos tal cual y el contenido de cada ZIP. Se ignoran
 * directorios, los metadatos `__MACOSX/` que añade macOS al comprimir y los ocultos.
 *
 * No es recursivo a propósito: un ZIP dentro de otro ZIP no es un caso real de esta operación y
 * abrirlo sin límite es la puerta de entrada de una zip bomb.
 */
export async function expandirZips(archivos: ArchivoPlano[]): Promise<ArchivoPlano[]> {
  const salida: ArchivoPlano[] = [];
  for (const archivo of archivos) {
    if (!esZip(archivo)) { salida.push(archivo); continue; }

    const zip = await JSZip.loadAsync(archivo.buffer);
    for (const entrada of Object.values(zip.files)) {
      if (entrada.dir) continue;
      if (entrada.name.startsWith('__MACOSX/')) continue;
      const base = entrada.name.split('/').pop() || entrada.name;
      if (base.startsWith('.')) continue;
      const buffer = Buffer.from(await entrada.async('nodebuffer'));
      salida.push({
        originalname: base,
        mimetype: mimeDeExtension(base),
        buffer,
        size: buffer.length,
        rutaEnZip: entrada.name,
      });
    }
  }
  return salida;
}
