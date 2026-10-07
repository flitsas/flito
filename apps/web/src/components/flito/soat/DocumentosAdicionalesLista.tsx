// FLITO — documentos adicionales de un SOAT en el detalle (HU #13363, AC6–AC8).
//
// Spec: docs/ux/flito-soat-documentos-adicionales.md §4. Lista corta, sin primaria: consultar no es
// operar. Copy **neutro** (el detalle lo abren el Cliente y la operación). 4 estados propios: el resto
// del modal no espera a esta sección ni se rompe si falla.
//
// El permiso lo decide quien la monta (`DocumentosAdicionalesSeccion`): sin
// `soat.documentos_adicionales.ver` la sección no existe y el endpoint no se pide (AC7).
//
// `accionesExtra` es el hueco por fila donde la HU #13365 pondrá «Eliminar» sin rediseñar la fila.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Download, Eye, RotateCw } from 'lucide-react';
import type { DocumentoAdicionalSoat } from '@operaciones/shared-types';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { toastError } from '../../flit/ToastFlito';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import { fechaHoraBogota, tamanoLegible, tieneVistaPrevia, tipoLegible } from './documentosAdicionales';

export const FUNCION_VER_ADICIONALES = 'soat.documentos_adicionales.ver';

type Estado =
  | { fase: 'cargando' }
  | { fase: 'error' }
  | { fase: 'lista'; documentos: DocumentoAdicionalSoat[] };

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

export default function DocumentosAdicionalesLista({ soatId, accionesExtra }: {
  soatId: string;
  accionesExtra?: (documento: DocumentoAdicionalSoat) => ReactNode;
}) {
  const [estado, setEstado] = useState<Estado>({ fase: 'cargando' });
  const descargando = useRef(new Set<string>());

  const cargar = useCallback(async (): Promise<DocumentoAdicionalSoat[] | null> => {
    setEstado({ fase: 'cargando' });
    try {
      const r = await api.get<{ documentos: DocumentoAdicionalSoat[] }>(
        `/flito/soat/${encodeURIComponent(soatId)}/documentos-adicionales`,
      );
      // Un cuerpo sin la lista (API por detrás del bundle) se pinta como vacío, no como fallo.
      const documentos = Array.isArray(r?.documentos) ? r.documentos : [];
      setEstado({ fase: 'lista', documentos });
      return documentos;
    } catch {
      setEstado({ fase: 'error' });
      return null;
    }
  }, [soatId]);

  useEffect(() => { void cargar(); }, [cargar]);

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
          Aquí aparecen los que se adjunten en la solicitud.
        </p>
      </div>
    );
  }

  return (
    <ul className="divide-y" style={{ borderColor: 'var(--flit-border-soft)' }}>
      {estado.documentos.map((d) => {
        const vista = tieneVistaPrevia(d.tipoContenido);
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
                className={BOTON_ICONO} style={{ color: 'var(--flit-text-secondary)', borderColor: 'var(--flit-border)' }}
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

/**
 * La sección del detalle (§4), con el rótulo del `Seccion` de `DetalleSoat`. Sin la función, `null`:
 * ni título en el DOM ni petición al endpoint (AC7).
 */
export function DocumentosAdicionalesSeccion({ soatId }: { soatId: string }) {
  const puedeVer = useAuth().hasFuncion(FUNCION_VER_ADICIONALES);
  const idTitulo = useId();
  if (!puedeVer) return null;
  return (
    <section aria-labelledby={idTitulo} className="space-y-2 border-t pt-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <h3 id={idTitulo} className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>
        Documentos adicionales
      </h3>
      <DocumentosAdicionalesLista soatId={soatId} />
    </section>
  );
}
