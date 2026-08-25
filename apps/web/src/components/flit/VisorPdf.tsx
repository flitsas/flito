// Visor de PDF que NO ejecuta el JavaScript del documento.
//
// Antes esto era un `<object type="application/pdf">`, que delega en el visor nativo del navegador.
// Ese visor sí ejecuta las acciones embebidas del PDF, y las facturas de SOAT las traen: los cuatro
// ficheros que revisamos llevan `/OpenAction`, `/JavaScript` y `/AA` con un `this.print()`. Resultado:
// abrir el soporte de un SOAT lanzaba el diálogo de impresión, cada vez. No es un fallo nuestro sino
// del PDF de la aseguradora, pero se puede desactivar sin pedirle nada a nadie.
//
// pdf.js rasteriza las páginas a canvas y no corre nada del documento, así que el `print()` queda
// muerto. Es la misma librería y el mismo patrón que ya usan ExpedienteVisor y DriveViewer: no añade
// dependencia.
//
// Se renderizan TODAS las páginas en scroll continuo, no una a una: un recibo de dos hojas se lee
// bajando, no buscando el botón de «siguiente».

import { useEffect, useRef, useState } from 'react';
import { PDF_WORKER_SRC } from '../../lib/pdfWorker';

/** Ancho al que se rasteriza cada página. Suficiente para leer sin que el canvas pese de más. */
const ANCHO_OBJETIVO = 1400;

export default function VisorPdf({ url, nombre }: { url: string; nombre?: string }) {
  const [paginas, setPaginas] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Evita pintar el resultado de una carga que ya no interesa cuando se cambia de documento rápido.
  const vigente = useRef(0);

  useEffect(() => {
    const token = ++vigente.current;
    setPaginas(null); setError(null);

    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`No se pudo descargar el documento (${res.status})`);
        const datos = new Uint8Array(await res.arrayBuffer());

        const pdfjs = await import('pdfjs-dist');
        // El worker lo emite el bundler desde `node_modules` (HU #11775): misma versión que la API
        // por construcción y con hash de contenido. Ver `src/lib/pdfWorker.ts`.
        pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
        // `isEvalSupported: false` mitiga CVE-2024-4367 (GHSA-wgrm-67xf-hhpq, CVSS 8.8): en pdfjs 3.x
        // la matriz de fuente de un PDF malicioso acaba concatenada en un `new Function(...)` al
        // compilar los glifos, y abrir el documento ejecuta JavaScript arbitrario. El fix upstream es
        // el major 3→6, hoy bloqueado por producto (subiría el suelo a Chrome 125 / Safari 18), así que
        // se aplica el workaround oficial del advisory. Este visor rasteriza a PNG y no usa capa de
        // texto, luego apagar el eval no cambia lo que se ve. Guardado por `npm run check:pdfjs-eval`.
        const doc = await pdfjs.getDocument({ data: datos, isEvalSupported: false }).promise;

        const salida: string[] = [];
        for (let n = 1; n <= doc.numPages; n += 1) {
          const pagina = await doc.getPage(n);
          const base = pagina.getViewport({ scale: 1 });
          const viewport = pagina.getViewport({ scale: ANCHO_OBJETIVO / base.width });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width; canvas.height = viewport.height;
          await pagina.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
          salida.push(canvas.toDataURL('image/png'));
        }
        if (token === vigente.current) setPaginas(salida);
      } catch (e) {
        if (token === vigente.current) setError(e instanceof Error ? e.message : 'No se pudo abrir el documento');
      }
    })();
  }, [url]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm">
        <p className="text-red-600">{error}</p>
        {/* Salida de emergencia: si pdf.js no puede con el fichero, que al menos se pueda descargar. */}
        <a href={url} target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--flit-blue-text)' }}>
          Abrir en una pestaña nueva
        </a>
      </div>
    );
  }

  if (!paginas) {
    return (
      <div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>
        Cargando {nombre ?? 'el documento'}…
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto rounded-md" style={{ background: 'var(--flit-border-soft)' }}>
      <div className="flex flex-col items-center gap-3 p-3">
        {paginas.map((src, i) => (
          <img
            key={i}
            src={src}
            alt={`${nombre ?? 'Documento'} — página ${i + 1} de ${paginas.length}`}
            className="w-full max-w-4xl rounded-sm bg-white shadow"
          />
        ))}
      </div>
    </div>
  );
}
