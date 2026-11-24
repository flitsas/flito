// FLITO — Gestión Trámites: sección «Soportes» del detalle en modal (ADR-0046).
//
// Lista los documentos de `GET /flito/tramites/:id/soportes` (función `tramites.tramite.ver_soportes`)
// y los abre en el visor de siempre (`VisorSoportes`). La descarga en ZIP de ESTE trámite usa el
// mismo endpoint que la barra de la tabla (`POST /flito/tramites/soportes/zip`, ids en el CUERPO,
// nunca en la URL) con `ids: [id]`, y solo existe para quien tiene `tramites.soportes.descargar`
// (decisión del humano 2026-11-18). El servidor nombra el archivo `<ID del trámite>-DOCS.zip`.
//
// La selección es por TIPO de documento (granularidad aceptada por el humano): un tipo entra en el
// ZIP si el trámite tiene al menos un documento de ese tipo. Los tipos sin documento (pendientes) y
// los que no se pudieron comprobar (lista con error) van deshabilitados.

import { useEffect, useRef, useState } from 'react';
import { CABECERAS_ZIP_SOPORTES, TipoSoporteZip } from '@operaciones/shared-types';
import { api, errorMessage } from '../../../../lib/api';
import VisorSoportes, { type Soporte } from '../../../flit/VisorSoportes';
import { claseBoton } from '../../../flit/GradientButton';
import { FlitEmpty } from '../../../flit/flitPageKit';
import { ZIP_TRAMITES, avisoDeZip, fraseOmitidos } from '../../DescargarSoportesZip';
import { AvisoVisible, type AvisoExport } from '../../ExportarCola';
import { Cargando, ErrorSeccion, Seccion } from './SeccionesDetalle';
import { fecha } from '../tiposTramites';

const ORIGEN: Record<string, string> = {
  soat: 'SOAT', impuesto: 'Impuesto', derecho: 'Derecho de tránsito', logistica: 'Logística', comprobante: 'Comprobante',
};
/** Mismo tope que la descarga de la barra (`ZIP_TIMEOUT_MS`): el servidor une los PDF antes de responder. */
const ZIP_TIMEOUT_MS = 600_000;

export const nombreZipTramite = (idFlit: string) => `${idFlit}-DOCS.zip`;

export interface PropsSeccionSoportes {
  id: string;
  tramiteId: string;
  idFlit: string;
  /** Del detalle: la factura de venta de FLIT puede no estar en la lista de soportes. */
  tieneFacturaVenta: boolean;
  puedeVer: boolean;
  puedeDescargar: boolean;
  /** Cuántos documentos hay (para el índice); null mientras no se sabe. */
  onConteo: (n: number | null) => void;
}

export default function SeccionSoportes({
  id, tramiteId, idFlit, tieneFacturaVenta, puedeVer, puedeDescargar, onConteo,
}: PropsSeccionSoportes) {
  const [soportes, setSoportes] = useState<Soporte[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [visor, setVisor] = useState(false);
  const [marcados, setMarcados] = useState<Set<TipoSoporteZip>>(new Set());
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<AvisoExport | null>(null);
  const enVuelo = useRef(false);

  useEffect(() => {
    if (!puedeVer) { onConteo(null); return; }
    let vivo = true;
    setSoportes(null); setError(null); onConteo(null);
    api.get<Soporte[]>(`/flito/tramites/${tramiteId}/soportes`)
      .then((s) => { if (!vivo) return; const l = Array.isArray(s) ? s : []; setSoportes(l); onConteo(l.length); })
      .catch((e) => { if (vivo) setError(`No se pudieron cargar los soportes. ${errorMessage(e)}`); });
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tramiteId, puedeVer, nonce]);

  const disponible = (t: TipoSoporteZip) =>
    !!soportes && (soportes.some((s) => s.tipo === t) || (t === TipoSoporteZip.FACTURA_VENTA && tieneFacturaVenta));
  const tiposDisponibles = ZIP_TRAMITES.tipos.filter((t) => disponible(t.valor)).map((t) => t.valor);
  const seleccion = tiposDisponibles.filter((t) => marcados.has(t));
  const todos = tiposDisponibles.length > 0 && seleccion.length === tiposDisponibles.length;
  const nombre = nombreZipTramite(idFlit);

  const alternar = (t: TipoSoporteZip) => setMarcados((m) => {
    const x = new Set(m); if (x.has(t)) x.delete(t); else x.add(t); return x;
  });

  const descargar = async (tipos: TipoSoporteZip[]) => {
    if (enVuelo.current || tipos.length === 0) return;
    enVuelo.current = true; setOcupado(true); setAviso(null);
    let omitidos: number | null = null;
    try {
      const guardado = await api.downloadPostNamed(
        ZIP_TRAMITES.ruta, nombre, { ids: [tramiteId], tipos },
        (n) => n.endsWith('-DOCS.zip'),
        (leer) => { const n = Number(leer(CABECERAS_ZIP_SOPORTES.omitidos)); omitidos = Number.isInteger(n) && n > 0 ? n : null; },
        ZIP_TIMEOUT_MS,
      );
      setAviso({ tono: 'ok', reintentable: false, texto: `ZIP descargado: ${guardado}.${fraseOmitidos(omitidos)}` });
    } catch (e) {
      setAviso(avisoDeZip(e, 1, ZIP_TRAMITES, tipos));
    } finally {
      enVuelo.current = false; setOcupado(false);
    }
  };

  if (!puedeVer) {
    return <Seccion id={id} titulo="Soportes"><FlitEmpty>Tu usuario no tiene acceso a los soportes de los trámites.</FlitEmpty></Seccion>;
  }

  return (
    <Seccion id={id} titulo={soportes ? `Soportes (${soportes.length})` : 'Soportes'}>
      {error ? <ErrorSeccion texto={error} rotulo="Reintentar los soportes" onReintentar={() => setNonce((n) => n + 1)} />
        : soportes === null ? <Cargando que="los soportes" />
        : soportes.length === 0 && !tieneFacturaVenta ? <FlitEmpty>Este trámite no tiene ningún documento cargado todavía.</FlitEmpty>
        : (
          <div className="space-y-4">
            {soportes.length > 0 && (
              <>
                <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2">
                  {soportes.map((s) => (
                    <li key={s.id} className="min-w-0 rounded-[9px] border border-[color:var(--color-border)] px-3 py-2 text-xs">
                      <div className="font-semibold text-[color:var(--color-action)]">{ORIGEN[s.origen] ?? s.origen}</div>
                      <div className="break-all text-[color:var(--color-text-secondary)]">{s.nombreArchivo}</div>
                      <div className="text-[color:var(--color-text-tertiary)]">{fecha(s.subidoEn)}</div>
                    </li>
                  ))}
                </ul>
                <button type="button" className={claseBoton('secondary', 'sm')} onClick={() => setVisor(true)}>
                  Ver los documentos
                </button>
              </>
            )}

            {puedeDescargar && (
              <fieldset className="m-0 min-w-0 space-y-2 border-0 border-t border-[color:var(--color-border)] p-0 pt-3">
                <legend className="mb-1 text-sm font-semibold text-[color:var(--color-heading)]">Descargar en un ZIP</legend>
                <label className="flex items-center gap-2 text-sm font-semibold">
                  <input type="checkbox" className="size-4" checked={todos} disabled={tiposDisponibles.length === 0}
                    onChange={(e) => setMarcados(e.target.checked ? new Set(tiposDisponibles) : new Set())} />
                  Seleccionar todos
                </label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {ZIP_TRAMITES.tipos.map((t) => {
                    const ok = disponible(t.valor);
                    return (
                      <label key={t.valor} className={`flex items-start gap-2 text-sm ${ok ? '' : 'text-[color:var(--color-text-tertiary)]'}`}>
                        <input type="checkbox" className="mt-0.5 size-4" disabled={!ok}
                          checked={ok && marcados.has(t.valor)} onChange={() => alternar(t.valor)} />
                        <span>{t.rotulo}{!ok && ' (pendiente)'}</span>
                      </label>
                    );
                  })}
                </div>
                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <button type="button" className={claseBoton('primary', 'sm')} disabled={ocupado || seleccion.length === 0}
                    onClick={() => descargar(seleccion)}>
                    {ocupado ? 'Preparando el archivo…' : 'Descargar seleccionados (.zip)'}
                  </button>
                  <p className="m-0 text-xs text-[color:var(--color-text-secondary)]">
                    El archivo se descarga como <strong>{nombre}</strong>.
                  </p>
                </div>
                <div aria-live="polite">
                  {aviso && (
                    <AvisoVisible aviso={aviso} onReintentar={() => descargar(seleccion)} onDescartar={() => setAviso(null)} />
                  )}
                </div>
              </fieldset>
            )}
          </div>
        )}
      {visor && (
        <VisorSoportes ruta={`/flito/tramites/${tramiteId}/soportes`} titulo={idFlit} onClose={() => setVisor(false)} />
      )}
    </Seccion>
  );
}
