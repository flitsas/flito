// FLITO — Indicador «Comprobante en FLIT 2» del detalle del impuesto (HU #13270, Feature #13267).
// Spec: docs/ux/flito-impuestos-envio-flit2-y-reemplazo.md. Solo lectura: sin reintentar el envío
// (AC2), sin enlace, sin hover. Lee el detalle que el componente ya pide una vez; no hace petición.

import type { EnvioComprobanteFlit2, ReprogramacionEnvioFlit2 } from '@operaciones/shared-types';
import StatusChip, { type ChipTone } from '../flit/StatusChip';
import { fecha } from './ImpuestoCola';
import type { Carga } from './ValidacionRunt';

const ROTULO = 'Comprobante en FLIT 2';

const CHIP: Record<string, { texto: string; tono: ChipTone }> = {
  pendiente: { texto: 'Pendiente', tono: 'active' },
  en_espera: { texto: 'En espera de FLIT 2', tono: 'neutral' },
  enviado: { texto: 'Enviado a FLIT 2', tono: 'success' },
  ya_cargado_gestor: { texto: 'Ya lo cargó el gestor', tono: 'success' },
  error: { texto: 'Error de envío', tono: 'danger' },
  sin_comprobante: { texto: 'Sin comprobante', tono: 'warning' },
};
const DESCONOCIDO = { texto: 'Estado desconocido', tono: 'neutral' as ChipTone };

function ayuda(envio: EnvioComprobanteFlit2, hayCargarComprobante: boolean): string | null {
  if (envio.estado === 'en_espera') return 'El trámite aún no admite el comprobante en FLIT 2. FLITO lo enviará solo.';
  if (envio.estado === 'error') {
    return envio.intentos > 0
      ? `FLITO no pudo enviarlo tras ${envio.intentos} intentos. El motivo quedó registrado; si el archivo estaba mal, reemplázalo.`
      : 'FLITO no pudo enviarlo. El motivo quedó registrado; si el archivo estaba mal, reemplázalo.';
  }
  if (envio.estado === 'sin_comprobante') {
    return hayCargarComprobante
      ? 'Se enviará cuando cargues el comprobante de pago con «Cargar comprobante».'
      : 'Se enviará cuando se cargue el comprobante de pago.';
  }
  return null;
}

function lineaFecha(envio: EnvioComprobanteFlit2): string | null {
  if (envio.estado === 'sin_comprobante' || !envio.ultimoIntentoEn) return null;
  return envio.estado === 'enviado' ? `Enviado el ${fecha(envio.ultimoIntentoEn)}` : `Último intento: ${fecha(envio.ultimoIntentoEn)}`;
}

const secundario = { color: 'var(--flit-text-secondary)' };

/** Celda del `<dl>`; con `envioFlit2 === null` no existe (AC2). */
export function CeldaEnvioFlit2({ carga, recargar, hayCargarComprobante }: {
  carga: Carga; recargar: () => void; hayCargarComprobante: boolean;
}) {
  const envio = carga.fase === 'listo' ? (carga.datos.envioFlit2 ?? null) : undefined;
  if (envio === null) return null;
  const dt = (
    <dt className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>{ROTULO}</dt>
  );
  if (carga.fase === 'cargando') {
    return (
      <div className="col-span-2 sm:col-span-1" data-testid="envio-flit2">
        {dt}
        <dd aria-busy="true" className="text-sm">
          <span className="block h-5 w-32 animate-pulse rounded-full" style={{ background: 'var(--flit-bg-hover)' }} />
        </dd>
      </div>
    );
  }
  if (carga.fase === 'error' || !envio) {
    return (
      <div className="col-span-2 sm:col-span-1" data-testid="envio-flit2">
        {dt}
        <dd className="text-xs" style={secundario}>
          No se pudo consultar el envío a FLIT 2.{' '}
          <button type="button" onClick={recargar}
            className="flit-focus rounded px-1 font-semibold underline transition-colors hover:bg-[var(--flit-bg-hover)]"
            style={{ color: 'var(--flit-blue-text)' }}>
            Reintentar
          </button>
        </dd>
      </div>
    );
  }
  const chip = CHIP[envio.estado] ?? DESCONOCIDO;
  const f = lineaFecha(envio);
  const a = CHIP[envio.estado] ? ayuda(envio, hayCargarComprobante) : null;
  return (
    <div className="col-span-2 sm:col-span-1" data-testid="envio-flit2">
      {dt}
      <dd className="space-y-0.5 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={chip.tono}>{chip.texto}</StatusChip>
        </div>
        {f && <p className="text-xs" style={secundario}>{f}</p>}
        {a && <p className="text-xs" style={secundario}>{a}</p>}
      </dd>
    </div>
  );
}

/** Copy del toast de éxito del reemplazo por `envioFlit2` (spec: 4 variantes + respaldo). */
export function textoToastReemplazo(envio: ReprogramacionEnvioFlit2 | undefined): { texto: string; largo: boolean } {
  if (envio?.reenviado === true) return { texto: 'Comprobante reemplazado. FLITO enviará el nuevo a FLIT 2.', largo: false };
  if (envio?.reenviado === false) {
    if (envio.motivo === 'ya_cargado_gestor') {
      return { texto: 'Comprobante reemplazado en FLITO. No se envía a FLIT 2: el gestor ya cargó el suyo allá.', largo: true };
    }
    if (envio.motivo === 'no_flit2') {
      return { texto: 'Comprobante reemplazado. Este trámite no es de FLIT 2, así que no hay nada que enviar.', largo: true };
    }
    if (envio.motivo === 'sin_envio_previo') {
      return { texto: 'Comprobante reemplazado en FLITO. No se envía a FLIT 2 porque el impuesto se pagó antes del envío automático.', largo: true };
    }
  }
  return { texto: 'Comprobante reemplazado.', largo: false };
}
