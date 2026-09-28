// Detalle de una solicitud aparcada porque el RUNT no respondió (HU #12997, UX §5).
//
// Es un modal APARTE de `DetalleSoat` a propósito: el id de una incompleta no es un SOAT, y el
// detalle del SOAT dispara consultas por ese id (historial, soportes) que aquí serían un 404 o, peor,
// otra fila. La cabecera se pinta con la fila de la cola al instante (UX §4: «se pinta con la
// fila»); el propietario y la factura llegan con `GET /flito/soat/cliente/incompletas/:id`.
//
// Sin acciones: el reintento de la consulta al RUNT llega con la HU #12998. Mientras tanto la frase
// final dice qué va a pasar («FLITO volverá a consultar el RUNT.»), que es lo que la spec pide cuando
// el botón no se pinta.

import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { CircleSlash, RotateCw, ShieldQuestion } from 'lucide-react';
import type {
  MotivoDescarteSoat, SolicitudIncompletaDetalle, SolicitudIncompletaFila,
} from '@operaciones/shared-types';
import { api } from '../../../lib/api';
import FlitModal from '../../flit/FlitModal';
import { documentoConTipo } from '../../flit/columnasComunes';
import { flitBtnSecondary } from '../../flit/flitPageKit';
import { ChipIncompletaSoat } from './ChipEstadoSoat';
import { fecha, fechaLarga } from './tipos';

/** El motivo del descarte, legible. El `soat_vigente` no trae la fecha de la póliza en el contrato. */
export const MOTIVO_DESCARTE_TEXTO: Record<MotivoDescarteSoat, string> = {
  soat_vigente: 'El vehículo ya tenía SOAT activo.',
  runt_sin_registro: 'El RUNT no tiene registrado ese VIN.',
  runt_no_cuadra: 'El VIN no coincide con el que el RUNT tiene registrado.',
  runt_sin_vin: 'El RUNT no devolvió el VIN del vehículo.',
  solicitud_existente: 'Ese VIN ya tenía una solicitud en la cola de FLITO.',
};

const CAJA = { background: 'var(--flit-bg-app)', borderColor: 'var(--flit-border-soft)' } as const;

function Insignia({ tono, children }: { tono: 'warning' | 'draft'; children: ReactNode }) {
  const estilo = tono === 'warning'
    ? { background: 'var(--flit-chip-warning-bg)', color: 'var(--flit-warning-ink)' }
    : { background: 'var(--flit-chip-draft-bg)', color: 'var(--flit-chip-draft-ink)' };
  return (
    <span aria-hidden="true" className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style={estilo}>
      {children}
    </span>
  );
}

function Dato({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-[11px] uppercase" style={{ color: 'var(--flit-text-muted)' }}>{k}</dt>
      <dd className="break-words font-medium">{v}</dd>
    </div>
  );
}

const kb = (b: number) => b >= 1024 * 1024 ? `${(b / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

export default function DetalleIncompletaSoat({ fila, restoreFocusRef, onClose }: {
  fila: SolicitudIncompletaFila; restoreFocusRef?: RefObject<HTMLElement | null>; onClose: () => void;
}) {
  const [det, setDet] = useState<SolicitudIncompletaDetalle | null>(null);
  const [error, setError] = useState(false);
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    let vigente = true;
    setError(false);
    api.get<SolicitudIncompletaDetalle>(`/flito/soat/cliente/incompletas/${fila.id}`)
      .then((d) => { if (vigente) setDet(d); })
      .catch(() => { if (vigente) setError(true); });
    return () => { vigente = false; };
  }, [fila.id, intento]);

  const d = det ?? fila;
  const p = det?.propietario ?? null;
  const nombreProp = p ? (p.razonSocial || [p.nombres, p.apellidos].filter(Boolean).join(' ') || '—') : '—';

  return (
    <FlitModal title={`Solicitud · ${fila.vin}`} onClose={onClose} wide restoreFocusRef={restoreFocusRef}>
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2"><ChipIncompletaSoat estado={d.estado} /></div>

        {d.estado === 'incompleta' && (
          <section className="space-y-2 rounded-lg border p-3" style={CAJA} aria-labelledby="incompleta-pendiente">
            <h3 id="incompleta-pendiente" className="flex items-center gap-2 font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
              <Insignia tono="warning"><ShieldQuestion size={16} /></Insignia>
              Pendiente de validar con el RUNT
            </h3>
            <p style={{ color: 'var(--flit-text-secondary)' }}>
              La placa, la marca, la línea y la ficha técnica las trae el RUNT. Aparecerán aquí cuando la consulta responda.
            </p>
            <p className="tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>
              Último intento: {fechaLarga(d.ultimoIntentoRuntEn)}
            </p>
            <p style={{ color: 'var(--flit-text-secondary)' }}>FLITO volverá a consultar el RUNT.</p>
          </section>
        )}

        {d.estado === 'descartada' && d.descarte && (
          <section className="space-y-2 rounded-lg border p-3" style={CAJA} aria-labelledby="incompleta-descartada">
            <h3 id="incompleta-descartada" className="flex items-center gap-2 font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
              <Insignia tono="draft"><CircleSlash size={16} /></Insignia>
              Solicitud descartada
            </h3>
            <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[auto_1fr]">
              <dt style={{ color: 'var(--flit-text-muted)' }}>Motivo</dt>
              <dd style={{ color: 'var(--flit-text-primary)' }}>{MOTIVO_DESCARTE_TEXTO[d.descarte.motivo] ?? '—'}</dd>
              <dt style={{ color: 'var(--flit-text-muted)' }}>Cuándo</dt>
              <dd className="tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>{fechaLarga(d.descarte.en)}</dd>
              <dt style={{ color: 'var(--flit-text-muted)' }}>Quién</dt>
              <dd style={{ color: 'var(--flit-text-primary)' }}>{d.descarte.porNombre}</dd>
            </dl>
            <p style={{ color: 'var(--flit-text-secondary)' }}>La solicitud no se borra: queda aquí como constancia.</p>
          </section>
        )}

        {/* Lo digitado: es la prueba de que no se perdió nada (UX §5). */}
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 border-t pt-4 sm:grid-cols-2" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <Dato k="VIN" v={d.vin} />
          <Dato k="Compañía" v={d.companiaNombre ?? '—'} />
          <Dato k="Solicitado por" v={d.solicitadoPorNombre} />
          <Dato k="Solicitado" v={fecha(d.solicitadoEn)} />
          {det && <Dato k="Propietario" v={p ? `${nombreProp} · ${documentoConTipo(p.tipoDocumento, p.numeroDocumento)}` : '—'} />}
          {det && <Dato k="Factura" v={`${det.factura.nombreArchivo} · ${kb(det.factura.tamanoBytes)}`} />}
        </dl>

        {!det && !error && (
          <p role="status" aria-busy="true" className="animate-pulse motion-reduce:animate-none" style={{ color: 'var(--flit-text-muted)' }}>
            Cargando el propietario y la factura…
          </p>
        )}
        {error && (
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" style={{ color: 'var(--flit-danger-text)' }}>No pudimos cargar el propietario y la factura.</p>
            <button type="button" className={flitBtnSecondary} onClick={() => setIntento((n) => n + 1)}>
              <RotateCw size={16} aria-hidden="true" className="shrink-0" />
              Reintentar
            </button>
          </div>
        )}
      </div>
    </FlitModal>
  );
}
