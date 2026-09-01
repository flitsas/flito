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

/**
 * El nombre de RESPALDO, para cuando el servidor no declara ninguno o declara uno que no encaja.
 *
 * Dejó de ser el nombre bueno en la HU #11910: el AC5 pide `PLACA-ORGANISMO` **también en la
 * descarga individual**, y ese nombre lo escribe el servidor —es el único que conoce el alias del
 * organismo y la extensión real de los bytes—. Quien baja un ZIP y luego una factura suelta acabaría
 * con dos convenciones en la misma carpeta y sin forma de emparejarlas.
 *
 * Se queda porque un respaldo hace falta: si un día el API deja de mandar la cabecera, el archivo se
 * sigue descargando con un nombre peor en vez de con el id de S3 y sin extensión, que es de donde se
 * venía.
 */
export function nombreFacturaVenta(referencia: string): string {
  return `factura-venta-${referencia}.pdf`;
}

/**
 * ¿El nombre que declaró el servidor tiene la forma del AC5, `PLACA-ORGANISMO.<ext>`?
 *
 * El servidor lo normaliza a `[A-Z0-9]` por segmento (`nombrePlacaOrganismo`), así que **se exigen
 * al menos dos segmentos**: eso es lo que distingue un nombre de conciliación de un identificador
 * suelto —un uuid de S3, un número de documento— que también cabría en `[A-Z0-9]+`.
 *
 * La placa dentro del nombre es deliberada y es el AC5; lo que este guardia impide es propagar
 * cualquier otra cosa que el origen quiera poner en una cabecera HTTP. Si no encaja se cae al
 * respaldo: nunca se propaga un nombre que no se reconoce.
 */
export function esNombrePlacaOrganismo(nombre: string): boolean {
  return /^[A-Z0-9]+(?:-[A-Z0-9]+)+\.[a-z0-9]{1,8}$/.test(nombre);
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
