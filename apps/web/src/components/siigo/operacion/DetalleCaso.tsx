// El detalle de un caso: **un modal, no una ruta propia. Y lo decide la Ley 1581.**
//
// Como ningún filtro puede vivir en la URL (AGENTS.md §14 y `BarraFiltrosBandeja`), navegar a
// `/siigo/operacion/:id` y volver perdería el filtro del operador en CADA caso que abre. En la
// conciliación de boletas la ruta propia sí se justificó —«un modal no es enlazable»— porque allí el
// filtro sí viaja en la query; aquí el mismo argumento se invierte. Lo enlazable se resuelve con
// `?caso=<uuid>`, que es un id opaco y es exactamente lo que §14 admite en path y query.
//
// **Ninguna dirección de correo, NIT o placa sale de aquí.** Se muestra el nombre del cliente y nada
// más. `guia.texto` —el crudo de Siigo— es la única cadena que nadie ha revisado, así que se pinta
// SOLO aquí y rotulada como lo que es.

import { useState, type RefObject } from 'react';
import { SIIGO_BANDEJA_FUENTE_ACCION, SIIGO_BANDEJA_FUENTE_ETIQUETA } from '@operaciones/shared-types';
import type { SiigoBandejaItem, SiigoBandejaRespuestaReactivacion } from '@operaciones/shared-types';
import { api, errorMessage } from '../../../lib/api';
import FlitModal from '../../flit/FlitModal';
import StatusChip from '../../flit/StatusChip';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import EstadoNativoChip from './EstadoNativoChip';
import GuiaCaso, { MarcaNoCatalogado } from './GuiaCaso';
import LineaTiempo from './LineaTiempo';
import { ID_FRENO } from './BannerFreno';
import { admiteLote } from './previsualizarLote';
import { etiquetaCaso, tramiteDe } from './tipos';
import { fecha } from '../estilos';

export interface PermisosCaso {
  reintentar: boolean;
  reenviarCorreo: boolean;
  marcarFallido: boolean;
  reactivar: boolean;
  corregir: boolean;
}

interface Props {
  caso: SiigoBandejaItem;
  permisos: PermisosCaso;
  frenada: boolean;
  onCerrar: () => void;
  onReintentar: () => void;
  onDescartar: () => void;
  onCorregir: () => void;
  onReactivado: (r: SiigoBandejaRespuestaReactivacion) => void;
  restoreFocusRef: RefObject<HTMLElement | null>;
}

export default function DetalleCaso(p: Props) {
  const { caso } = p;
  const etiqueta = etiquetaCaso(caso);
  const descartado = caso.descarte !== null;
  const [reactivando, setReactivando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);

  const reactivar = async () => {
    setReactivando(true);
    setError(null);
    try {
      const r = await api.post<SiigoBandejaRespuestaReactivacion>('/siigo/bandeja/reactivar', {
        fuente: caso.fuente, refId: caso.refId,
      });
      p.onReactivado(r);
    } catch (e) {
      setError(errorMessage(e));
      setReactivando(false);
    }
  };

  const copiarEnlace = async () => {
    // El uuid del caso y nada más. La URL no lleva ni el cliente, ni el filtro, ni el correo.
    const url = `${window.location.origin}${window.location.pathname}?caso=${caso.refId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiado(true);
    } catch {
      setError('No se pudo copiar el enlace al portapapeles.');
    }
  };

  // El reintento y el reenvío no se ofrecen sobre `dian` ni sobre lo dado por perdido, y tampoco
  // cuando la guía dice que no sirve: `admiteLote` es el mismo predicado que la casilla de la lista.
  const puedeIntentar = admiteLote({
    fuente: caso.fuente, descartado, sirveReintentar: caso.guia.sirveReintentar,
  }) && (caso.fuente === 'emision' ? p.permisos.reintentar : p.permisos.reenviarCorreo);

  // `/descartar` y `/reactivar` sobre `dian` responden 409 y no operan: la interfaz no ofrece lo que
  // el servidor va a rechazar. Un documento rechazado por la DIAN existe ante la autoridad.
  const admiteDescarte = caso.fuente !== 'dian';

  return (
    <FlitModal title={etiqueta} onClose={p.onCerrar} wide restoreFocusRef={p.restoreFocusRef}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone="neutral">{SIIGO_BANDEJA_FUENTE_ETIQUETA[caso.fuente]}</StatusChip>
          <EstadoNativoChip fuente={caso.fuente} estado={caso.estado} />
          <MarcaNoCatalogado guia={caso.guia} />
          {caso.fuente === 'emision' && caso.maxIntentos > 0 && (
            <span className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
              intento {caso.intentos} de {caso.maxIntentos}
            </span>
          )}
        </div>

        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          {caso.clienteNombre ?? 'Sin cliente registrado'} · detenido desde el {fecha(caso.ocurridoEn)}
          {' '}· {caso.antiguedadDias} {caso.antiguedadDias === 1 ? 'día' : 'días'}
        </p>

        <section className="rounded-[10px] p-3" style={{ background: 'var(--flit-bg-app)' }}>
          <h3 className="mb-2 text-sm font-bold" style={{ color: 'var(--flit-text-primary)' }}>
            Qué pasó y qué hacer
          </h3>
          <GuiaCaso guia={caso.guia} descarte={caso.descarte} />
          <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            {SIIGO_BANDEJA_FUENTE_ACCION[caso.fuente]}
          </p>
        </section>

        {/* La única cadena de la pantalla que nadie ha revisado. Va rotulada y solo aquí. */}
        {!caso.guia.conocido && caso.guia.texto && (
          <section>
            <h3 className="mb-1 text-sm font-bold" style={{ color: 'var(--flit-text-primary)' }}>
              Lo que respondió Siigo
            </h3>
            <pre
              className="overflow-x-auto whitespace-pre-wrap rounded-[10px] p-3 text-xs"
              style={{ background: 'var(--flit-bg-app)', color: 'var(--flit-text-primary)' }}
            >
              {caso.guia.texto}
            </pre>
          </section>
        )}

        {error && <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{error}</p>}

        <div className="flex flex-wrap gap-2">
          {puedeIntentar && (
            <button
              type="button"
              onClick={p.onReintentar}
              disabled={p.frenada}
              aria-describedby={p.frenada ? ID_FRENO : undefined}
              className={flitBtnSecondary}
              style={flitBtnSecondaryStyle}
            >
              {caso.fuente === 'emision' ? 'Reintentar la emisión' : 'Reenviar el correo'}
            </button>
          )}
          {admiteDescarte && !descartado && p.permisos.marcarFallido && (
            <button type="button" onClick={p.onDescartar} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>
              Dar por perdido
            </button>
          )}
          {/* «Volver a intentarlo» y NUNCA «reactivar»: ese rótulo es el del freno, que afecta a
              toda la facturación de la empresa. Es la confusión más cara de esta pantalla. */}
          {admiteDescarte && descartado && p.permisos.reactivar && (
            <button
              type="button"
              onClick={reactivar}
              disabled={reactivando}
              className={flitBtnSecondary}
              style={flitBtnSecondaryStyle}
            >
              {reactivando ? 'Devolviéndolo a la cola…' : 'Volver a intentarlo'}
            </button>
          )}
          {p.permisos.corregir && (
            <button type="button" onClick={p.onCorregir} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>
              Registrar una corrección
            </button>
          )}
          <button type="button" onClick={copiarEnlace} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>
            {copiado ? 'Enlace copiado' : 'Copiar enlace'}
          </button>
        </div>
        <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          El enlace abre este caso, no tu filtro.
        </p>

        <section>
          <h3 className="mb-2 text-sm font-bold" style={{ color: 'var(--flit-text-primary)' }}>
            Línea de tiempo
          </h3>
          <LineaTiempo tramiteId={tramiteDe(caso)} />
        </section>
      </div>
    </FlitModal>
  );
}
