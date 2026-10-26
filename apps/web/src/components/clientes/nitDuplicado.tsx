/**
 * HU #13955 — NIT duplicado en el formulario de cliente (alta y edición).
 *
 * El API responde `409 { error: 'Ya existe un cliente con el NIT … y sucursal ….', campo: 'document' }`
 * (RN-CLI-7, `clients.routes.ts` → `responderDuplicado`). Ese mensaje es el ÚNICO texto del API que se
 * muestra tal cual, y bajo el campo NIT (AC1): lo pide el AC y lo redacta el servidor para el usuario.
 * Cualquier otro fallo al guardar va a un toast cerrable con copy propio (AC4), nunca el texto crudo.
 */
import { ApiError } from '../../lib/api';
import { toastError } from '../flit/ToastFlito';

/** AC4 — copy literal (decisión humana: «Intenta», tuteo, aunque el resto de Clientes use usted). */
export const TOAST_ERROR_GUARDAR_CLIENTE = 'No pudimos guardar el cliente. Intenta de nuevo.';

/** Mensaje del 409 de NIT+sucursal duplicados, o `null` si el error es cualquier otra cosa. */
export function mensajeNitDuplicado(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const cuerpo = e.rawDetails as { campo?: unknown; error?: unknown } | null | undefined;
  if (cuerpo?.campo !== 'document' || typeof cuerpo.error !== 'string' || !cuerpo.error) return null;
  return cuerpo.error;
}

/**
 * Traduce el fallo de guardar un cliente: si es el 409 de NIT lo devuelve (para pintarlo en el campo);
 * si no, lanza el toast pulido y devuelve `null`. Un solo id de toast para que reintentar no apile.
 */
export function manejarErrorGuardarCliente(e: unknown): string | null {
  const nit = mensajeNitDuplicado(e);
  if (nit) return nit;
  toastError(TOAST_ERROR_GUARDAR_CLIENTE, undefined, { id: 'guardar-cliente' });
  return null;
}

/** Mensaje de error bajo el campo NIT. `id` es el destino del `aria-describedby` del input (AC2). */
export function ErrorNit({ id, children }: { id: string; children: string }) {
  return (
    <p id={id} role="alert" className="mt-1 text-xs font-semibold" style={{ color: 'var(--flit-danger-text)' }}>
      {children}
    </p>
  );
}
