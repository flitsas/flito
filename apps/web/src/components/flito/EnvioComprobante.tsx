// FLITO — Indicador «Comprobante en FLIT 1 / FLIT 2» del detalle del impuesto y copy del toast del
// reemplazo. Nace en la HU #13270 (solo FLIT 2, `EnvioFlit2.tsx`) y se generaliza en la HU #13312
// (Feature #13309): un solo JSX, un mapa de textos completos por destino (sin plantilla «a {destino}»:
// FLIT 2 queda idéntico carácter por carácter, AC4). Specs: docs/ux/flito-impuestos-envio-flit2-y-reemplazo.md
// y docs/ux/flito-impuestos-envio-comprobante-flit1.md. Solo lectura: sin reintentar el envío, sin
// enlace, sin hover en el chip. Lee el detalle que el componente ya pide una vez; no hace petición.

import { useState } from 'react';
import type {
  DestinoEnvioComprobante, EnvioComprobante, ReprogramacionEnvioComprobante,
} from '@operaciones/shared-types';
import StatusChip, { type ChipTone } from '../flit/StatusChip';
import { fecha } from './ImpuestoCola';
import type { Carga } from './ValidacionRunt';

type Chip = { texto: string; tono: ChipTone };

interface CopyDestino {
  rotulo: string;
  chips: Record<string, Chip>;
  ayuda: (envio: EnvioComprobante, hayCargarComprobante: boolean) => string | null;
  errorConsulta: string;
  /** FLIT 2 (#13270) pinta la fecha también con estado desconocido; FLIT 1 no (spec #13312). */
  fechaEnDesconocido: boolean;
}

const COPY_POR_DESTINO: Record<DestinoEnvioComprobante, CopyDestino> = {
  flit2: {
    rotulo: 'Comprobante en FLIT 2',
    chips: {
      pendiente: { texto: 'Pendiente', tono: 'active' },
      en_espera: { texto: 'En espera de FLIT 2', tono: 'neutral' },
      enviado: { texto: 'Enviado a FLIT 2', tono: 'success' },
      ya_cargado_gestor: { texto: 'Ya lo cargó el gestor', tono: 'success' },
      error: { texto: 'Error de envío', tono: 'danger' },
      sin_comprobante: { texto: 'Sin comprobante', tono: 'warning' },
    },
    ayuda: (envio, hayCargarComprobante) => {
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
    },
    errorConsulta: 'No se pudo consultar el envío a FLIT 2.',
    fechaEnDesconocido: true,
  },
  flit1: {
    rotulo: 'Comprobante en FLIT 1',
    // `en_espera` y `ya_cargado_gestor` no existen en FLIT 1 (CHECK de la base): caen al chip neutro.
    chips: {
      pendiente: { texto: 'Pendiente', tono: 'active' },
      enviado: { texto: 'Enviado a FLIT 1', tono: 'success' },
      error: { texto: 'Error de envío', tono: 'danger' },
      sin_comprobante: { texto: 'Sin comprobante', tono: 'warning' },
    },
    ayuda: (envio, hayCargarComprobante) => {
      if (envio.estado === 'pendiente') return 'FLITO lo enviará solo a FLIT 1; no tienes que hacer nada.';
      if (envio.estado === 'error') {
        return envio.intentos > 0
          ? `FLITO no pudo enviarlo a FLIT 1 tras ${envio.intentos} intentos. El motivo quedó registrado; si el archivo estaba mal, reemplázalo.`
          : 'FLITO no pudo enviarlo a FLIT 1. El motivo quedó registrado; si el archivo estaba mal, reemplázalo.';
      }
      if (envio.estado === 'sin_comprobante') {
        return hayCargarComprobante
          ? 'Se enviará a FLIT 1 cuando cargues el comprobante de pago con «Cargar comprobante».'
          : 'Se enviará a FLIT 1 cuando se cargue el comprobante de pago.';
      }
      return null;
    },
    errorConsulta: 'No se pudo consultar el envío a FLIT 1.',
    fechaEnDesconocido: false,
  },
};

/** Destino aún no conocido (primera carga sin dato previo): no se adivina ni se nombra FLIT 2. */
const NEUTRO = { rotulo: 'Envío del comprobante', errorConsulta: 'No se pudo consultar el envío del comprobante.' };
const DESCONOCIDO: Chip = { texto: 'Estado desconocido', tono: 'neutral' };

const copyDe = (destino: string | null | undefined): CopyDestino | undefined =>
  destino === 'flit1' || destino === 'flit2' ? COPY_POR_DESTINO[destino] : undefined;

function lineaFecha(envio: EnvioComprobante): string | null {
  if (envio.estado === 'sin_comprobante' || !envio.ultimoIntentoEn) return null;
  return envio.estado === 'enviado' ? `Enviado el ${fecha(envio.ultimoIntentoEn)}` : `Último intento: ${fecha(envio.ultimoIntentoEn)}`;
}

const secundario = { color: 'var(--flit-text-secondary)' };

/**
 * Celda del `<dl>`; con `envioComprobante === null` no existe (AC5). Recuerda el destino de la última
 * respuesta `listo` de ESTE impuesto para el rótulo de cargando y de error (AC6); se olvida al cambiar
 * de impuesto.
 */
export function CeldaEnvioComprobante({ impId, carga, recargar, hayCargarComprobante }: {
  impId: string; carga: Carga; recargar: () => void; hayCargarComprobante: boolean;
}) {
  const envio = carga.fase === 'listo' ? (carga.datos.envioComprobante ?? null) : undefined;
  const [ultimo, setUltimo] = useState<{ impId: string; destino: string } | null>(null);
  if (envio && (ultimo?.impId !== impId || ultimo.destino !== envio.destino)) {
    setUltimo({ impId, destino: envio.destino });
  }
  if (envio === null) return null;

  const destino = envio ? envio.destino : ultimo?.impId === impId ? ultimo.destino : undefined;
  const copy = copyDe(destino);
  const atributos = {
    className: 'col-span-2 sm:col-span-1',
    'data-testid': 'envio-comprobante',
    'data-destino': copy ? destino : undefined,
  };
  const dt = (
    <dt className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>
      {copy?.rotulo ?? NEUTRO.rotulo}
    </dt>
  );
  if (carga.fase === 'cargando') {
    return (
      <div {...atributos}>
        {dt}
        <dd aria-busy="true" className="text-sm">
          <span className="block h-5 w-32 animate-pulse rounded-full" style={{ background: 'var(--flit-bg-hover)' }} />
        </dd>
      </div>
    );
  }
  if (carga.fase === 'error' || !envio) {
    return (
      <div {...atributos}>
        {dt}
        <dd className="text-xs" style={secundario}>
          {copy?.errorConsulta ?? NEUTRO.errorConsulta}{' '}
          <button type="button" onClick={recargar}
            className="flit-focus rounded px-1 font-semibold underline transition-colors hover:bg-[var(--flit-bg-hover)]"
            style={{ color: 'var(--flit-blue-text)' }}>
            Reintentar
          </button>
        </dd>
      </div>
    );
  }
  const conocido = copy?.chips[envio.estado];
  const chip = conocido ?? DESCONOCIDO;
  const f = conocido || copy?.fechaEnDesconocido ? lineaFecha(envio) : null;
  const a = conocido && copy ? copy.ayuda(envio, hayCargarComprobante) : null;
  return (
    <div {...atributos}>
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

const TOAST_REENVIADO: Record<DestinoEnvioComprobante, string> = {
  flit1: 'Comprobante reemplazado. FLITO enviará el nuevo a FLIT 1.',
  flit2: 'Comprobante reemplazado. FLITO enviará el nuevo a FLIT 2.',
};
const TOAST_SIN_REENVIO: Record<DestinoEnvioComprobante, Record<'ya_cargado_gestor' | 'sin_envio_previo', string>> = {
  flit1: {
    sin_envio_previo: 'Comprobante reemplazado en FLITO. No se envía a FLIT 1 porque el impuesto se pagó antes del envío automático.',
    ya_cargado_gestor: 'Comprobante reemplazado en FLITO. No se envía a FLIT 1.',
  },
  flit2: {
    sin_envio_previo: 'Comprobante reemplazado en FLITO. No se envía a FLIT 2 porque el impuesto se pagó antes del envío automático.',
    ya_cargado_gestor: 'Comprobante reemplazado en FLITO. No se envía a FLIT 2: el gestor ya cargó el suyo allá.',
  },
};
const TOAST_NO_APLICA = 'Comprobante reemplazado. Este trámite no envía el comprobante a otro sistema: queda solo en FLITO.';
const TOAST_RESPALDO = { texto: 'Comprobante reemplazado.', largo: false };

/**
 * Copy del toast de éxito del reemplazo por `envio` (HU #13311): decide por destino + reenviado +
 * motivo, nunca por texto del servidor. `largo` = dos frases → 8 s.
 */
export function textoToastReemplazo(envio: ReprogramacionEnvioComprobante | undefined): { texto: string; largo: boolean } {
  if (!envio) return TOAST_RESPALDO;
  if (envio.destino === null) {
    return envio.reenviado === false && envio.motivo === 'no_aplica' ? { texto: TOAST_NO_APLICA, largo: true } : TOAST_RESPALDO;
  }
  if (envio.destino !== 'flit1' && envio.destino !== 'flit2') return TOAST_RESPALDO;
  if (envio.reenviado === true) return { texto: TOAST_REENVIADO[envio.destino], largo: false };
  if (envio.reenviado === false) {
    const texto = TOAST_SIN_REENVIO[envio.destino][envio.motivo] as string | undefined;
    if (texto) return { texto, largo: true };
  }
  return TOAST_RESPALDO;
}
