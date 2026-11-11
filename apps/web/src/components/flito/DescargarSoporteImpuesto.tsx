// FLITO — descarga INDIVIDUAL de los soportes de un impuesto (Bug #14532).
//
// La masiva es `DescargarSoportesZip` (filas marcadas → un ZIP). Esta es su pareja de una sola fila,
// con el mismo patrón visual que la del comprobante del SOAT (`DescargarComprobanteSoat`, HU #12816):
// un icono compacto en la celda de acciones, `aria-label` con la placa, candado por id y toast solo
// cuando algo falla. Lo que cambia es que aquí hay TRES documentos posibles, así que el icono abre el
// MISMO diálogo de tipos de la masiva (`DialogoTipos`) con las casillas de Impuestos.
//
// **Cómo se baja.** `POST /flito/impuestos/:id/soportes/pdf` con `{ tipo }`, UNA llamada por tipo
// marcado y en serie: marcar Liquidación + Pagado son dos PDF. El nombre lo pone el servidor
// (`Content-Disposition`); si no viene o no encaja, `<PLACA>-<sufijo>.pdf`. El tipo va en el CUERPO y
// la placa solo en el nombre del archivo: nada de esto toca una URL (§14). `downloadPostNamed` es lo
// que impide que un error vestido de archivo acabe en la carpeta de descargas.
//
// **Notificaciones.** Sin toast de éxito: la descarga del navegador es el resultado. Un solo toast por
// acción, cerrable: nombra lo que el impuesto no tiene (404 `zip_sin_soportes`) y, si además se cortó
// la red o hubo 5xx/429, ofrece «Reintentar» con los tipos que quedaron sin bajar. Nunca el error crudo.
import { useCallback, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { CODIGO_ZIP_SIN_SOPORTES, TipoSoporteZip } from '@operaciones/shared-types';
import { ApiError, api } from '../../lib/api';
import { flitBtnSecondarySm, flitBtnSecondaryStyle } from '../flit/flitPageKit';
import { toastError } from '../flit/ToastFlito';
import { DialogoTipos, ZIP_IMPUESTOS, type OpcionTipoZip } from './DescargarSoportesZip';

/** Lo mínimo de la fila que necesita la descarga. */
export interface ImpuestoDescargable {
  id: string;
  placa: string | null;
}

/** Sufijo del nombre de respaldo, el mismo que pone el servidor. */
const SUFIJO: Record<string, string> = {
  [TipoSoporteZip.FACTURA_VENTA]: 'factura-venta',
  [TipoSoporteZip.LIQUIDACION_IMPUESTO]: 'liquidacion',
  [TipoSoporteZip.PAGO_IMPUESTO]: 'pagado',
};

const rotuloDe = (f: ImpuestoDescargable) => f.placa?.trim() || 'este registro';

/** Nombre de respaldo. Placa nula → `SIN-PLACA`, como en el comprobante del SOAT. */
export function nombreSoporte(placa: string | null, tipo: TipoSoporteZip): string {
  const base = (placa ?? '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '') || 'SIN-PLACA';
  return `${base}-${SUFIJO[tipo] ?? 'soporte'}.pdf`;
}

const opcionDe = (tipo: TipoSoporteZip): OpcionTipoZip | undefined =>
  ZIP_IMPUESTOS.tipos.find((t) => t.valor === tipo);
const enFrase = (tipo: TipoSoporteZip) => opcionDe(tipo)?.enFrase ?? 'documento';
/** Con artículo, para «Se descargó la liquidación y el soporte de pagado». */
const conArticulo = (tipo: TipoSoporteZip) =>
  `${tipo === TipoSoporteZip.PAGO_IMPUESTO ? 'el' : 'la'} ${enFrase(tipo)}`;

/** «a», «a y b», «a, b y c» (o con «ni» para la negación). */
function lista(partes: string[], conjuncion: 'y' | 'ni'): string {
  if (partes.length <= 1) return partes.join('');
  return `${partes.slice(0, -1).join(', ')} ${conjuncion} ${partes[partes.length - 1]}`;
}

function esSinSoporte(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.status !== 404) return false;
  const cuerpo = e.rawDetails as { codigo?: unknown } | null | undefined;
  return cuerpo?.codigo === CODIGO_ZIP_SIN_SOPORTES;
}

/** El corte (red, 5xx, 429, 403…): qué decir y si reintentar puede salir distinto. */
function avisoDeCorte(e: unknown, rotulo: string, tipo: TipoSoporteZip): { texto: string; reintentar: boolean } {
  const status = e instanceof ApiError ? e.status : 0;
  if (status === 403) return { texto: 'Su usuario no tiene permiso para descargar soportes.', reintentar: false };
  if (status === 404) return { texto: `Los soportes de ${rotulo} no están disponibles.`, reintentar: false };
  if (status === 429) {
    return { texto: 'Se hicieron demasiadas descargas seguidas. Espere un momento e intente de nuevo.', reintentar: true };
  }
  return { texto: `No se pudo descargar ${conArticulo(tipo)} de ${rotulo}. Intente de nuevo.`, reintentar: true };
}

/** Exportada para poder leerla: el texto del único toast de la acción, o `null` si todo bajó. */
export function textoDelResultado(
  rotulo: string, bajados: TipoSoporteZip[], faltantes: TipoSoporteZip[], corte: string | null,
): string | null {
  const frases: string[] = [];
  if (faltantes.length > 0) {
    const falta = lista(faltantes.map(enFrase), 'ni');
    frases.push(bajados.length > 0 && !corte
      ? `Se descargó ${lista(bajados.map(conArticulo), 'y')}; el impuesto de ${rotulo} no tiene ${falta}.`
      : `El impuesto de ${rotulo} no tiene ${falta}.`);
  }
  if (corte) frases.push(corte);
  return frases.length > 0 ? frases.join(' ') : null;
}

export interface EstadoDescargaSoporteImpuesto {
  /** La fila cuyo diálogo está abierto, o `null`. */
  abierta: ImpuestoDescargable | null;
  abrir: (f: ImpuestoDescargable) => void;
  cerrar: () => void;
  confirmar: (tipos: TipoSoporteZip[]) => void;
  ocupados: ReadonlySet<string>;
}

/** Candado por id en un `ref`: un doble clic no lanza dos tandas; las demás filas siguen operables. */
export function useDescargaSoporteImpuesto(): EstadoDescargaSoporteImpuesto {
  const candado = useRef(new Set<string>());
  const [ocupados, setOcupados] = useState<ReadonlySet<string>>(new Set());
  const [abierta, setAbierta] = useState<ImpuestoDescargable | null>(null);

  const descargar = useCallback(async function descargar(f: ImpuestoDescargable, tipos: TipoSoporteZip[]) {
    if (tipos.length === 0 || candado.current.has(f.id)) return;
    candado.current.add(f.id);
    setOcupados(new Set(candado.current));
    const idToast = `soporte-impuesto-${f.id}`;
    const rotulo = rotuloDe(f);
    const bajados: TipoSoporteZip[] = [];
    const faltantes: TipoSoporteZip[] = [];
    let corte: { texto: string; reintentar: boolean; pendientes: TipoSoporteZip[] } | null = null;
    try {
      for (const [i, tipo] of tipos.entries()) {
        try {
          await api.downloadPostNamed(
            `/flito/impuestos/${f.id}/soportes/pdf`, nombreSoporte(f.placa, tipo), { tipo },
            (n) => /\.pdf$/i.test(n),
          );
          bajados.push(tipo);
        } catch (e) {
          if (esSinSoporte(e)) { faltantes.push(tipo); continue; }
          corte = { ...avisoDeCorte(e, rotulo, tipo), pendientes: tipos.slice(i) };
          break;
        }
      }
    } finally {
      candado.current.delete(f.id);
      setOcupados(new Set(candado.current));
    }
    const fin = corte as { texto: string; reintentar: boolean; pendientes: TipoSoporteZip[] } | null;
    const texto = textoDelResultado(rotulo, bajados, faltantes, fin?.texto ?? null);
    toast(texto, fin?.reintentar ? () => { void descargar(f, fin.pendientes); } : undefined, idToast);
  }, []);

  return {
    abierta,
    abrir: (f) => { if (!candado.current.has(f.id)) setAbierta(f); },
    cerrar: () => setAbierta(null),
    confirmar: (tipos) => {
      const f = abierta;
      // Se cierra ANTES de lanzar, como la masiva: el foco vuelve al icono, que pasa a `aria-busy`.
      setAbierta(null);
      if (f) void descargar(f, tipos);
    },
    ocupados,
  };
}

function toast(texto: string | null, reintentar: (() => void) | undefined, id: string) {
  if (texto) toastError(texto, reintentar, { id });
}

/** Icono de la celda de acciones. Mismo control compacto que el del SOAT (`h-7 w-7`). */
export function BotonSoporteImpuestoFila(
  { fila, descarga }: { fila: ImpuestoDescargable; descarga: EstadoDescargaSoporteImpuesto },
) {
  const ocupado = descarga.ocupados.has(fila.id);
  const etiqueta = `Descargar soportes ${rotuloDe(fila)}`;
  return (
    <button
      type="button"
      aria-label={etiqueta}
      title={etiqueta}
      aria-busy={ocupado || undefined}
      // `aria-disabled` y no `disabled`: el foco vuelve aquí al cerrar el diálogo, y un botón
      // `disabled` lo perdería. El candado real es el `ref` del hook.
      aria-disabled={ocupado || undefined}
      onClick={() => { if (!ocupado) descarga.abrir(fila); }}
      className={`${flitBtnSecondarySm} w-7 justify-center !px-0 ${ocupado ? 'cursor-progress opacity-60' : ''}`}
      style={{ ...flitBtnSecondaryStyle, color: 'var(--flit-blue-text)' }}
    >
      <Download size={16} aria-hidden="true" className="shrink-0" />
    </button>
  );
}

/** El diálogo de tipos de la fila abierta. Se monta UNA vez en la página, fuera de la tabla. */
export function DialogoSoporteImpuesto({ descarga }: { descarga: EstadoDescargaSoporteImpuesto }) {
  const f = descarga.abierta;
  if (!f) return null;
  return (
    <DialogoTipos
      titulo="Descargar soportes"
      leyenda={`Qué documentos de ${rotuloDe(f)} se descargan`}
      tipos={ZIP_IMPUESTOS.tipos}
      nota="Se descarga un PDF por cada documento marcado, nombrado con la placa (por ejemplo, ABC123-pagado.pdf)."
      onCancelar={descarga.cerrar}
      onConfirmar={descarga.confirmar}
    />
  );
}
