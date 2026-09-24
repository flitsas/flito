// FLITO — descarga INDIVIDUAL del comprobante de un SOAT (HU #12816, Feature #12814).
//
// La masiva es `DescargarSoportesZip` (selección de ≥2 filas → ZIP). Esta es su pareja de una sola
// fila: un icono en la celda de «Ver» y un botón con texto al final de las acciones del detalle. Las
// dos superficies comparten un único hook, `useDescargaComprobante`, para que el candado y el toast
// sean los mismos se pulse donde se pulse.
//
// **Cómo se baja.** No hay endpoint propio de descarga: se reutiliza `GET /flito/soat/:id/soportes`
// (el mismo que alimenta «Ver soporte») y se toma el comprobante (`factura_soat`; cada SOAT carga uno
// solo). Su `url` firmada es `/api/files?…`, del mismo origen, y responde `inline` y SIN nombre. Por
// eso no basta un `<a download href>`: el `download` sí forzaría el nombre, pero un 404/403 del
// archivo acabaría en la carpeta de descargas como un «ABC123.pdf» con un JSON dentro, sin que la
// pantalla se enterara. Se baja el blob con `api.download()`, que pasa por `request()` —token,
// timeout, 401 → fin de sesión, error vestido de archivo— y lo entrega con `entregarArchivo()` y el
// nombre `<placa>.<ext>`. La placa viaja en el NOMBRE del archivo, nunca en una URL (§14).
//
// **Notificaciones.** Sin toast de éxito: la descarga del navegador es el resultado. El error es un
// toast cerrable, una frase, con «Reintentar» cuando reintentar sirve (red, 5xx, 429). Nunca el
// mensaje crudo del API.
import { useCallback, useId, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Download } from 'lucide-react';
import { EstadoSoat } from '@operaciones/shared-types';
import { api, ApiError } from '../../lib/api';
import type { Soporte } from '../flit/VisorSoportes';
import { flitBtnSecondary, flitBtnSecondarySm, flitBtnSecondaryStyle } from '../flit/flitPageKit';
import { toastError } from '../flit/ToastFlito';

/** Lo mínimo de la fila que necesita la descarga. */
export interface SoatDescargable {
  id: string;
  placa: string | null;
  vin: string;
  estado: EstadoSoat | string;
}

export const MOTIVO_NO_PAGADO = 'Disponible cuando el SOAT esté pagado.';

/** Lo que el usuario reconoce del SOAT: la placa y, si aún no tiene, el VIN. */
const rotuloDe = (s: SoatDescargable) => s.placa?.trim() || s.vin;

/**
 * Nombre del archivo guardado. La placa nula no se sustituye por el VIN —es cuasi-PII y no lo pide
 * ningún AC—: se usa el centinela `SIN-PLACA`. La extensión sale del archivo cargado (el SOAT acepta
 * PDF, PNG y JPG); si no se puede leer, `pdf`.
 */
export function nombreComprobante(placa: string | null, nombreArchivo?: string | null): string {
  const base = (placa ?? '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '') || 'SIN-PLACA';
  const ext = /\.(pdf|png|jpe?g)$/i.exec(nombreArchivo ?? '')?.[1].toLowerCase() ?? 'pdf';
  return `${base}.${ext}`;
}

/** `/api/files?…` → `/files?…`, que es lo que espera `api` (su `BASE` ya es `/api`). */
function rutaDeApi(url: string): string | null {
  try {
    const u = new URL(url, window.location.origin);
    if (u.origin !== window.location.origin || !u.pathname.startsWith('/api/')) return null;
    return `${u.pathname.slice(4)}${u.search}`;
  } catch {
    return null;
  }
}

class SinComprobante extends Error {}

/** Copy por caso. `reintentar` solo donde otro intento puede salir distinto. */
function avisoDeError(e: unknown, rotulo: string): { texto: string; reintentar: boolean } {
  const status = e instanceof ApiError ? e.status : e instanceof SinComprobante ? 404 : 0;
  if (status === 404) {
    return {
      texto: `El comprobante de ${rotulo} no está disponible. Si el SOAT figura como pagado, avise a FLITO.`,
      reintentar: false,
    };
  }
  if (status === 403) return { texto: 'Su usuario no tiene permiso para descargar comprobantes.', reintentar: false };
  if (status === 429) {
    return { texto: 'Se hicieron demasiadas descargas seguidas. Espere un momento e intente de nuevo.', reintentar: true };
  }
  return { texto: `No se pudo descargar el comprobante de ${rotulo}. Intente de nuevo.`, reintentar: true };
}

export interface EstadoDescargaComprobante {
  descargar: (soat: SoatDescargable) => void;
  ocupados: ReadonlySet<string>;
}

/**
 * Candado por id en un `ref`: dos clics síncronos ven el mismo `Set` antes de que React repinte, así
 * que el segundo sale sin pedir nada. Las demás filas siguen operables.
 */
export function useDescargaComprobante(): EstadoDescargaComprobante {
  const candado = useRef(new Set<string>());
  const [ocupados, setOcupados] = useState<ReadonlySet<string>>(new Set());

  const descargar = useCallback(async function descargar(soat: SoatDescargable) {
    if (soat.estado !== EstadoSoat.PAGADO || candado.current.has(soat.id)) return;
    candado.current.add(soat.id);
    setOcupados(new Set(candado.current));
    const idToast = `comprobante-soat-${soat.id}`;
    toast.dismiss(idToast);
    try {
      const soportes = await api.get<Soporte[]>(`/flito/soat/${soat.id}/soportes`);
      const comprobante = soportes.find((s) => s.tipo === 'factura_soat');
      if (!comprobante?.url) throw new SinComprobante();
      const ruta = rutaDeApi(comprobante.url);
      if (!ruta) throw new SinComprobante();
      await api.download(ruta, nombreComprobante(soat.placa, comprobante.nombreArchivo));
    } catch (e) {
      const { texto, reintentar } = avisoDeError(e, rotuloDe(soat));
      // El toast del kit (HU #12819): el mismo copy, «Reintentar» y «Cerrar aviso» de siempre.
      toastError(texto, reintentar ? () => { void descargar(soat); } : undefined, { id: idToast });
    } finally {
      candado.current.delete(soat.id);
      setOcupados(new Set(candado.current));
    }
  }, []);

  return { descargar: (s) => { void descargar(s); }, ocupados };
}

/** Estilo y atributos comunes a la fila y al detalle, según el estado. */
function useEstadoBoton(soat: SoatDescargable, descarga: EstadoDescargaComprobante, compacto = false) {
  const pagado = soat.estado === EstadoSoat.PAGADO;
  const ocupado = descarga.ocupados.has(soat.id);
  const idMotivo = useId();
  const base = compacto ? flitBtnSecondarySm : flitBtnSecondary;
  const clase = pagado
    ? `${base} ${ocupado ? 'cursor-progress opacity-60' : ''}`
    : `${base} cursor-not-allowed`;
  const style = pagado
    ? { ...flitBtnSecondaryStyle, color: 'var(--flit-blue-text)' }
    : { ...flitBtnSecondaryStyle, color: 'var(--flit-text-muted)', borderColor: 'var(--flit-border-soft)' };
  const props = {
    type: 'button' as const,
    'aria-label': `Descargar comprobante ${rotuloDe(soat)}`,
    'aria-disabled': pagado ? undefined : true,
    'aria-busy': ocupado || undefined,
    'aria-describedby': pagado ? undefined : idMotivo,
    onClick: () => { if (pagado && !ocupado) descarga.descargar(soat); },
  };
  return { pagado, idMotivo, clase, style, props };
}

/** Icono de la celda de «Ver». Enfocable también en gris (`aria-disabled`) para leer el motivo. */
export function BotonComprobanteFila({ soat, descarga }: { soat: SoatDescargable; descarga: EstadoDescargaComprobante }) {
  // Compacto (`h-7 w-7`) desde la HU #12819: la fila no crece por su botón.
  const { pagado, idMotivo, clase, style, props } = useEstadoBoton(soat, descarga, true);
  return (
    <>
      <button {...props} className={`${clase} w-7 justify-center !px-0`} style={style}
        title={pagado ? props['aria-label'] : MOTIVO_NO_PAGADO}>
        <Download size={16} aria-hidden="true" className="shrink-0" />
      </button>
      {!pagado && <span id={idMotivo} className="sr-only">{MOTIVO_NO_PAGADO}</span>}
    </>
  );
}

/** Secundaria del detalle, con rótulo. En no pagado el motivo SE VE bajo el botón. */
export function BotonComprobanteDetalle({ soat, descarga }: { soat: SoatDescargable; descarga: EstadoDescargaComprobante }) {
  const { pagado, idMotivo, clase, style, props } = useEstadoBoton(soat, descarga);
  const ocupado = descarga.ocupados.has(soat.id);
  return (
    <div className="flex flex-col items-start gap-1">
      <button {...props} aria-label={undefined} className={`${clase} gap-2`} style={style}
        title={pagado ? undefined : MOTIVO_NO_PAGADO}>
        <Download size={16} aria-hidden="true" className="shrink-0" />{ocupado ? 'Descargando…' : 'Descargar comprobante'}
      </button>
      {!pagado && <p id={idMotivo} className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{MOTIVO_NO_PAGADO}</p>}
    </div>
  );
}
