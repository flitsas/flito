// Visor de la factura de venta que viene de FLIT: la muestra y permite descargarla.
//
// ── Por qué existe y no se abre y ya ────────────────────────────────────────
//
// La factura vive en el S3 de FLIT y la API la sirve (GET /flito/impuestos/:id/factura-venta).
// Impuestos la abría con `window.open(URL.createObjectURL(blob))`: una URL `blob:` no tiene nombre,
// así que al guardar el archivo el navegador lo llamaba como el identificador interno y SIN
// extensión. Un fichero sin `.pdf` no abre con doble clic y hay que renombrarlo a mano cada vez.
//
// Aquí la descarga pasa por un `<a download="…​.pdf">`, que sí impone el nombre. La otra mitad del
// arreglo está en la API, que ahora entrega `application/pdf` en vez del `octet-stream` que
// devuelve S3 — sin eso el visor tampoco podría pintarla.
//
// Se comparte entre Gestión de trámites e Impuestos porque es exactamente el mismo documento visto
// desde dos pantallas: duplicarlo era garantizar que una de las dos volviera a perder el nombre.

import FlitModal from './FlitModal';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from './flitPageKit';

/** Nombre de descarga a partir de la referencia visible del trámite. Siempre con extensión. */
export function nombreFacturaVenta(referencia: string): string {
  return `factura-venta-${referencia}.pdf`;
}

export default function ModalFacturaVenta({ url, nombre, onCerrar }: {
  /** URL del blob ya descargado. Quien la crea es responsable de revocarla al cerrar. */
  url: string;
  /** Nombre del archivo al descargarlo, extensión incluida. */
  nombre: string;
  onCerrar: () => void;
}) {
  return (
    <FlitModal title="Factura de venta" onClose={onCerrar}>
      <div className="space-y-3">
        <iframe src={url} title="Factura de venta" className="h-[70vh] w-full rounded border" style={{ borderColor: 'var(--flit-border)' }} />
        <div className="flex gap-2">
          <a className={flitBtnPrimary} style={flitBtnPrimaryStyle} href={url} download={nombre}>Descargar</a>
          <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onCerrar}>Cerrar</button>
        </div>
      </div>
    </FlitModal>
  );
}
