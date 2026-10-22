// FLITO — documentos adicionales de un SOAT en el detalle (HU #13363, AC6–AC8).
//
// Spec: docs/ux/flito-soat-documentos-adicionales.md §4. Lista corta, sin primaria: consultar no es
// operar. Copy **neutro** (el detalle lo abren el Cliente y la operación). 4 estados propios: el resto
// del modal no espera a esta sección ni se rompe si falla.
//
// El permiso lo decide quien la monta (`DocumentosAdicionalesSeccion`): sin
// `soat.documentos_adicionales.ver` la sección no existe y el endpoint no se pide (AC7).
//
// HU #13365 (spec docs/ux/flito-soat-documentos-adicionales-detalle-cargar-eliminar.md): la sección
// suma «Cargar documentos» (`.cargar`) con su panel en línea y la papelera por fila (`.eliminar`) en
// `accionesExtra`, con la confirmación que reemplaza la fila. Cada función por `hasFuncion`, por
// separado. El estado de la lista vive en `useDocumentosAdicionales` para refrescar sin esqueleto.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Download, Eye, RotateCw, TriangleAlert, Upload, X } from 'lucide-react';
import type { DocumentoAdicionalSoat, ResultadoDocumentosAdicionales } from '@operaciones/shared-types';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { toastError, toastOk } from '../../flit/ToastFlito';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import CargarDocumentosAdicionales from './CargarDocumentosAdicionales';
import ConfirmarEliminarAdicional, { BotonEliminarAdicional } from './ConfirmarEliminarAdicional';
import {
  fechaHoraBogota, motivoEnFrase, tamanoLegible, textoCargados, textoResumenDescartes, tieneVistaPrevia, tipoLegible,
} from './documentosAdicionales';
import { useDocumentosAdicionales, type ListaAdicionales } from './useDocumentosAdicionales';

export const FUNCION_VER_ADICIONALES = 'soat.documentos_adicionales.ver';
/** HU #13365: botón «Cargar documentos» y su panel (0223: admin y proveedor). */
export const FUNCION_CARGAR_ADICIONALES = 'soat.documentos_adicionales.cargar';
/** HU #13365: papelera por fila (0223: admin y proveedor). */
export const FUNCION_ELIMINAR_ADICIONALES = 'soat.documentos_adicionales.eliminar';

const EXTENSION_POR_MIME: Record<string, string> = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heif',
};

/** La `url` es `/api/files?…` (token firmado); el cliente HTTP ya antepone `/api`. */
const rutaDeApi = (url: string) => url.replace(/^\/api(?=\/)/, '');

function nombreDescarga(d: DocumentoAdicionalSoat): string {
  const ext = EXTENSION_POR_MIME[d.tipoContenido.toLowerCase()];
  return ext && !d.etiqueta.toLowerCase().endsWith(`.${ext}`) ? `${d.etiqueta}.${ext}` : d.etiqueta;
}

const BOTON_ICONO =
  'flit-focus grid h-10 w-10 shrink-0 place-items-center rounded-[999px] border bg-flit-card transition-colors hover:bg-[var(--flit-bg-hover)]';

export default function DocumentosAdicionalesLista({ lista, accionesExtra, reemplazoDeFila, pistaVacio, conEliminar = false }: {
  lista: ListaAdicionales;
  accionesExtra?: (documento: DocumentoAdicionalSoat) => ReactNode;
  /** HU #13365: la confirmación de eliminar reemplaza la fila en línea (`null` = fila normal). */
  reemplazoDeFila?: (documento: DocumentoAdicionalSoat) => ReactNode | null;
  /** Segunda línea del vacío (con `.cargar` invita a cargar, spec #13365 §6). */
  pistaVacio?: string;
  /** El esqueleto suma la caja de la papelera (spec #13365 §6). */
  conEliminar?: boolean;
}) {
  const { estado, cargar } = lista;
  const descargando = useRef(new Set<string>());

  const descargar = async (doc: DocumentoAdicionalSoat) => {
    // Candado por id contra el doble clic, como en `useDescargaComprobante`.
    if (descargando.current.has(doc.id)) return;
    descargando.current.add(doc.id);
    try {
      await api.download(rutaDeApi(doc.url), nombreDescarga(doc));
    } catch {
      // Sin toast de éxito: la descarga del navegador es el resultado. El reintento vuelve a pedir la
      // lista, porque la `url` firmada pudo caducar (§4.1).
      toastError(`No se pudo descargar «${doc.etiqueta}». Intente de nuevo.`, () => {
        void cargar().then((docs) => {
          const fresco = docs?.find((d) => d.id === doc.id);
          if (fresco) void descargar(fresco);
        });
      }, { id: `adic-descarga-${doc.id}` });
    } finally {
      descargando.current.delete(doc.id);
    }
  };

  if (estado.fase === 'cargando') {
    return (
      <div role="status" aria-busy="true" aria-label="Cargando documentos adicionales" className="space-y-3">
        {[0, 1].map((i) => (
          <div key={i} className="flex animate-pulse items-center gap-3 motion-reduce:animate-none">
            <div className="flex-1 space-y-2">
              <div className="h-3 w-3/4 rounded" style={{ background: 'var(--flit-bg-hover)' }} />
              <div className="h-3 w-1/2 rounded" style={{ background: 'var(--flit-bg-hover)' }} />
            </div>
            <div className="h-10 w-16 rounded-[999px]" style={{ background: 'var(--flit-bg-hover)' }} />
            <div className="h-10 w-10 rounded-[999px]" style={{ background: 'var(--flit-bg-hover)' }} />
            {conEliminar && <div className="h-10 w-10 rounded-[999px]" style={{ background: 'var(--flit-bg-hover)' }} />}
          </div>
        ))}
      </div>
    );
  }

  if (estado.fase === 'error') {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-sm" style={{ color: 'var(--flit-danger-text)' }}>
          No se pudieron cargar los documentos adicionales.
        </p>
        <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => { void cargar(); }}>
          <RotateCw size={16} aria-hidden="true" className="shrink-0" />
          Reintentar
        </button>
      </div>
    );
  }

  if (estado.documentos.length === 0) {
    return (
      <div>
        <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>Sin documentos adicionales.</p>
        <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          {pistaVacio ?? 'Aquí aparecen los que se adjunten en la solicitud.'}
        </p>
      </div>
    );
  }

  return (
    <ul className="divide-y" style={{ borderColor: 'var(--flit-border-soft)' }}>
      {estado.documentos.map((d) => {
        const vista = tieneVistaPrevia(d.tipoContenido);
        const reemplazo = reemplazoDeFila?.(d);
        if (reemplazo) return <li key={d.id} className="py-2" style={{ borderColor: 'var(--flit-border-soft)' }}>{reemplazo}</li>;
        return (
          <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2" style={{ borderColor: 'var(--flit-border-soft)' }}>
            <div className="min-w-0 flex-1 basis-48">
              <p title={d.etiqueta} className="truncate text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>{d.etiqueta}</p>
              <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                {[tipoLegible(d.tipoContenido, d.etiqueta), tamanoLegible(d.tamanoBytes), fechaHoraBogota(d.subidoEn),
                  d.subidoPorNombre, ...(vista ? [] : ['Sin vista previa'])].filter(Boolean).join(' · ')}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {vista && (
                <a href={d.url} target="_blank" rel="noopener noreferrer" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                  aria-label={`Ver ${d.etiqueta}`}>
                  <Eye size={16} aria-hidden="true" className="shrink-0" />
                  Ver
                </a>
              )}
              <button type="button" aria-label={`Descargar ${d.etiqueta}`} title={`Descargar ${d.etiqueta}`}
                className={BOTON_ICONO} style={{ color: 'var(--flit-text-secondary)', borderColor: 'var(--flit-border-input)' }}
                onClick={() => { void descargar(d); }}>
                <Download size={16} aria-hidden="true" />
              </button>
              {accionesExtra?.(d)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

type Aviso = {
  /** `null` = la carga no tuvo descartes (solo falló el refresco). */
  descartes: { aceptados: number; total: number; lista: ResultadoDocumentosAdicionales['descartados'] } | null;
  refrescoFallido: boolean;
};

const BOTON_CERRAR =
  'flit-focus grid h-8 w-8 shrink-0 place-items-center rounded transition-colors hover:bg-[var(--flit-bg-hover)]';

/** Aviso de resultado de la carga (§3.4–§3.5): persistente en la sección, no toast. */
function AvisoCarga({ aviso, onCerrar, onReintentar }: { aviso: Aviso; onCerrar: () => void; onReintentar: () => void }) {
  const { descartes } = aviso;
  return (
    <div role="status" className="flex items-start gap-2 rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-input)' }}>
      <TriangleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0" style={{ color: 'var(--flit-warning-text)' }} />
      <div className="min-w-0 flex-1 space-y-1 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
        {descartes && (
          <>
            <p className="font-semibold">{textoResumenDescartes(descartes.aceptados, descartes.total)}</p>
            <p>{descartes.lista.length === 1 ? 'No se cargó:' : 'No se cargaron:'}</p>
            <ul className="space-y-0.5">
              {descartes.lista.map((d, i) => (
                <li key={`${d.nombreArchivo}-${i}`} className="break-all">— {d.nombreArchivo}: {motivoEnFrase(d.codigo)}</li>
              ))}
            </ul>
          </>
        )}
        {aviso.refrescoFallido && (
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 basis-48">Los documentos se guardaron, pero la lista no se pudo actualizar.</p>
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onReintentar}>
              <RotateCw size={16} aria-hidden="true" className="shrink-0" />
              Reintentar
            </button>
          </div>
        )}
      </div>
      <button type="button" aria-label="Cerrar aviso" title="Cerrar aviso" className={BOTON_CERRAR}
        style={{ color: 'var(--flit-text-secondary)' }} onClick={onCerrar}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * La sección del detalle (§4 de la spec #13363 + spec #13365). Sin `.ver`, `null`: ni título en el
 * DOM ni petición al endpoint (AC7 de #13363), aunque se tenga `.cargar` o `.eliminar`.
 */
export function DocumentosAdicionalesSeccion({ soatId }: { soatId: string }) {
  const { hasFuncion } = useAuth();
  if (!hasFuncion(FUNCION_VER_ADICIONALES)) return null;
  return (
    <SeccionConLista soatId={soatId}
      puedeCargar={hasFuncion(FUNCION_CARGAR_ADICIONALES)} puedeEliminar={hasFuncion(FUNCION_ELIMINAR_ADICIONALES)} />
  );
}

function SeccionConLista({ soatId, puedeCargar, puedeEliminar }: { soatId: string; puedeCargar: boolean; puedeEliminar: boolean }) {
  const lista = useDocumentosAdicionales(soatId);
  const idTitulo = useId();
  const raiz = useRef<HTMLElement>(null);
  const [panelAbierto, setPanelAbierto] = useState(false);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const [confirmando, setConfirmando] = useState<string | null>(null);

  // Foco pendiente tras un cambio (cerrar panel, cancelar, eliminar): se aplica en un efecto, cuando
  // React ya pintó el DOM nuevo. `selector` dentro de la sección; si no existe (o no se da), el botón
  // «Cargar documentos» o, sin esa función, el rótulo (`tabIndex=-1`).
  const [foco, setFoco] = useState<{ selector?: string } | null>(null);
  useEffect(() => {
    if (!foco) return;
    const r = raiz.current;
    const destino = (foco.selector ? r?.querySelector<HTMLElement>(foco.selector) : null)
      ?? r?.querySelector<HTMLElement>('[data-abrir-carga]')
      ?? r?.querySelector<HTMLElement>('h3');
    destino?.focus();
    setFoco(null);
  }, [foco]);
  const enfocar = (selector?: string) => setFoco({ selector });

  const abrirPanel = () => { setAviso(null); setPanelAbierto(true); };
  const cerrarPanel = () => { setPanelAbierto(false); enfocar(); };

  const cargado = async (r: ResultadoDocumentosAdicionales) => {
    cerrarPanel();
    const aceptados = r.aceptados.length;
    const total = aceptados + r.descartados.length;
    const refrescoFallido = aceptados > 0 ? !(await lista.refrescar()) : false;
    const descartes = r.descartados.length > 0 ? { aceptados, total, lista: r.descartados } : null;
    // Una notificación por acción (§3.4): limpio → toast; descartes o refresco fallido → aviso.
    if (descartes || refrescoFallido) setAviso({ descartes, refrescoFallido });
    else toastOk(textoCargados(aceptados), { id: `adic-carga-${soatId}` });
  };

  const reintentarRefresco = async () => {
    if (await lista.refrescar()) setAviso((a) => (a?.descartes ? { ...a, refrescoFallido: false } : null));
  };

  const eliminado = (doc: DocumentoAdicionalSoat, yaNoEstaba: boolean) => {
    const docs = lista.estado.fase === 'lista' ? lista.estado.documentos : [];
    const i = docs.findIndex((d) => d.id === doc.id);
    const vecino = docs[i + 1] ?? docs[i - 1];
    setConfirmando(null);
    lista.quitar(doc.id);
    toastOk(yaNoEstaba ? 'Ese documento ya no estaba en la solicitud.' : `Se eliminó «${doc.etiqueta}».`, { id: `adic-elim-${doc.id}` });
    enfocar(vecino ? `[data-eliminar="${vecino.id}"]` : undefined);
  };

  const cancelarEliminar = (doc: DocumentoAdicionalSoat) => { setConfirmando(null); enfocar(`[data-eliminar="${doc.id}"]`); };

  return (
    <section ref={raiz} aria-labelledby={idTitulo} className="space-y-2 border-t pt-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={idTitulo} tabIndex={-1} className="text-[11px] font-semibold uppercase tracking-wide outline-none" style={{ color: 'var(--flit-text-muted)' }}>
          Documentos adicionales
        </h3>
        {puedeCargar && !panelAbierto && (
          <button type="button" data-abrir-carga className={flitBtnSecondary} style={flitBtnSecondaryStyle}
            aria-expanded={false} onClick={abrirPanel}>
            <Upload size={16} aria-hidden="true" className="shrink-0" />
            Cargar documentos
          </button>
        )}
      </div>
      {aviso && <AvisoCarga aviso={aviso} onCerrar={() => setAviso(null)} onReintentar={() => { void reintentarRefresco(); }} />}
      {puedeCargar && panelAbierto && (
        <CargarDocumentosAdicionales soatId={soatId} onCancelar={cerrarPanel} onCargado={(r) => { void cargado(r); }} />
      )}
      <DocumentosAdicionalesLista
        lista={lista}
        conEliminar={puedeEliminar}
        pistaVacio={puedeCargar ? 'Para agregar soportes del caso, use «Cargar documentos».' : undefined}
        accionesExtra={puedeEliminar ? (d) => <BotonEliminarAdicional documento={d} onAbrir={() => setConfirmando(d.id)} /> : undefined}
        reemplazoDeFila={puedeEliminar ? (d) => (confirmando === d.id ? (
          <ConfirmarEliminarAdicional soatId={soatId} documento={d}
            onCancelar={() => cancelarEliminar(d)} onEliminado={(ya) => eliminado(d, ya)} />
        ) : null) : undefined}
      />
    </section>
  );
}
