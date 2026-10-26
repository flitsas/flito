// Historial de versiones de un documento del expediente, en línea bajo la fila (HU #13892; spec
// «Wireframe: historial desplegado»). Lee E2 cada vez que se abre, sin caché. `Esc` cierra solo esto.
import { useCallback, useEffect, useState } from 'react';
import { Download, RotateCw } from 'lucide-react';
import type { DocumentoBolsaVersionDto, TipoDocumentoBolsa } from '@operaciones/shared-types';
import { bolsasDocumentosApi } from '../../lib/api';
import { fechaDia, fechaHora } from '../../lib/bolsas';
import { delDocumento, diaBogota, nombreDocumento, participio } from '../../lib/bolsasDocumentos';
import { flitBtnIconoSm, flitBtnSecondarySm } from '../flit/flitPageKit';
import { useDescargaDocumentoBolsa } from './useDescargaDocumentoBolsa';

type Estado = { fase: 'cargando' } | { fase: 'error' } | { fase: 'lista'; versiones: DocumentoBolsaVersionDto[] };

export default function HistorialDocumento({ id, companiaId, tipo, onCerrar }: {
  id: string;
  companiaId: number;
  tipo: TipoDocumentoBolsa;
  /** `Esc` dentro del historial: lo cierra y devuelve el foco al toggle. */
  onCerrar: () => void;
}) {
  const [estado, setEstado] = useState<Estado>({ fase: 'cargando' });
  const { descargar, enCurso } = useDescargaDocumentoBolsa();
  const nombre = nombreDocumento(tipo);
  const idTitulo = `${id}-titulo`;

  const leer = useCallback(async (vigente: { v: boolean }) => {
    setEstado({ fase: 'cargando' });
    try {
      const r = await bolsasDocumentosApi.historial(companiaId, tipo);
      if (vigente.v) setEstado({ fase: 'lista', versiones: Array.isArray(r?.versiones) ? r.versiones : [] });
    } catch {
      if (vigente.v) setEstado({ fase: 'error' });
    }
  }, [companiaId, tipo]);

  useEffect(() => {
    const vigente = { v: true };
    void leer(vigente);
    return () => { vigente.v = false; };
  }, [leer]);

  return (
    <div id={id} role="region" aria-labelledby={idTitulo}
      className="rounded-lg border p-3 sm:col-span-2" style={{ borderColor: 'var(--flit-border-input)' }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onCerrar(); } }}>
      <p id={idTitulo} className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        Historial {delDocumento(tipo)}
      </p>

      {estado.fase === 'cargando' && (
        <div role="status" aria-label="Cargando versiones" className="mt-2 space-y-2">
          <div className="h-3 w-3/4 rounded" style={{ background: 'var(--flit-bg-app)' }} />
          <div className="h-3 w-1/2 rounded" style={{ background: 'var(--flit-bg-app)' }} />
        </div>
      )}

      {estado.fase === 'error' && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p role="alert" className="min-w-0 flex-1 basis-48 text-xs" style={{ color: 'var(--flit-danger-text)' }}>
            No pudimos cargar el historial. Intenta de nuevo.
          </p>
          <button type="button" className={flitBtnSecondarySm} onClick={() => { void leer({ v: true }); }}>
            <RotateCw size={14} aria-hidden="true" className="shrink-0" />
            Reintentar
          </button>
        </div>
      )}

      {estado.fase === 'lista' && estado.versiones.length === 0 && (
        <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>Este documento todavía no tiene versiones.</p>
      )}

      {estado.fase === 'lista' && estado.versiones.length > 0 && (
        <ul className="mt-2 divide-y" style={{ borderColor: 'var(--flit-border-soft)' }}>
          {estado.versiones.map((v) => {
            const ocupado = enCurso.has(v.id);
            return (
              <li key={v.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2" style={{ borderColor: 'var(--flit-border-soft)' }}>
                <div className="min-w-0 flex-1 basis-56 break-words">
                  <p className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
                    Versión {v.version} · {cabecera(v)}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                    Cargada{v.cargadoPor ? ` por ${v.cargadoPor}` : ''} el {fechaHora(v.cargadoEn)}
                    {v.fechaExpedicion ? ` · ${participio(tipo, 'expedid')} el ${fechaDia(v.fechaExpedicion)}` : ''}
                    {!v.archivoDisponible ? ' · archivo eliminado por retención' : ''}
                  </p>
                  {v.retiro && (
                    // Texto plano (HU #13964): el motivo es libre y nunca se interpreta como HTML.
                    <>
                      <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                        Retirada por {v.retiro.por.nombre ?? '—'} el {fechaHora(v.retiro.en)}
                      </p>
                      {v.retiro.motivo && (
                        <p className="text-xs break-words" style={{ color: 'var(--flit-text-secondary)' }}>
                          Motivo: «{v.retiro.motivo}»
                        </p>
                      )}
                    </>
                  )}
                  {v.fechaOrigen === 'manual' && v.fechaManual && (
                    <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                      (fecha digitada{v.fechaManual.por ? ` por ${v.fechaManual.por}` : ''} el {fechaDia(diaBogota(v.fechaManual.en))})
                    </p>
                  )}
                </div>
                {v.archivoDisponible && (
                  <button type="button" className={flitBtnIconoSm}
                    aria-label={`Descargar ${nombre} (versión ${v.version})`} title={`Descargar ${nombre} (versión ${v.version})`}
                    disabled={ocupado} aria-busy={ocupado || undefined} onClick={() => { void descargar(v); }}>
                    <Download size={14} aria-hidden="true" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Vigente, retirada (la señal es `retiro`, nunca las fechas) o reemplazada por una carga. */
function cabecera(v: DocumentoBolsaVersionDto): string {
  if (v.vigente) return 'vigente';
  if (v.retiro) return `retirada el ${fechaDia(diaBogota(v.retiro.en))}`;
  return `reemplazada el ${fechaDia(diaBogota(v.reemplazadoEn))}`;
}
