// TRAM-TRASPASO-F4 UX — mapa de progreso + CTA «siguiente paso» en paso 6.

import type { CSSProperties } from 'react';
import GradientButton from '../../components/flit/GradientButton';

export const PASO6_ANCHORS = {
  identidad: 'traspaso-identidad-biometrica',
  documentos: 'traspaso-paso6-documentos',
  checklist: 'traspaso-paso6-checklist',
  anexos: 'traspaso-paso6-anexos',
  firma: 'traspaso-paso6-firma',
  stt: 'traspaso-paso6-stt',
} as const;

type PasoEstado = 'done' | 'active' | 'pending' | 'blocked';

interface Props {
  biometriaOk: boolean;
  hayContrato: boolean;
  furOk: boolean;
  anexosCount: number;
  /** Dual-actor: ambas partes firmaron — habilita el envío a validación STT. */
  firmaOk?: boolean;
}

const ESTADO_STYLE: Record<PasoEstado, CSSProperties> = {
  done: { borderColor: 'var(--kit-verde)', color: 'var(--kit-verde-texto)', background: 'color-mix(in srgb, var(--kit-verde) 10%, transparent)' },
  active: { borderColor: 'var(--kit-azul)', color: 'var(--color-action)', background: 'var(--kit-hover)' },
  pending: { borderColor: 'var(--color-border-control)', color: 'var(--color-text-secondary)', background: 'var(--color-surface-elevated)' },
  blocked: { borderColor: 'var(--color-border-control)', color: 'var(--color-text-tertiary)', background: 'var(--color-surface)' },
};

function scrollToAnchor(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function siguienteAccion(p: Props): { titulo: string; detalle: string; anchor: string; cta: string } {
  if (!p.biometriaOk) {
    return {
      titulo: 'Esperando validación biométrica',
      detalle: 'Vendedor y comprador deben abrir el enlace del correo y completar selfie + cédula. Mientras tanto puedes generar contrato e improntas.',
      anchor: PASO6_ANCHORS.identidad,
      cta: 'Ir a validación identidad ↓',
    };
  }
  if (!p.hayContrato) {
    return {
      titulo: 'Genera el contrato de compraventa',
      detalle: 'Usa el valor comercial del paso 5. El PDF queda en el expediente.',
      anchor: PASO6_ANCHORS.documentos,
      cta: 'Generar contrato ↓',
    };
  }
  if (!p.furOk) {
    return {
      titulo: 'Genera el FUR',
      detalle: 'Biométrica aprobada — ya puedes generar el Formulario Único con sellos.',
      anchor: PASO6_ANCHORS.documentos,
      cta: 'Generar FUR ↓',
    };
  }
  if (p.anexosCount === 0) {
    return {
      titulo: 'Sube anexos al expediente',
      detalle: 'SOAT, paz y salvo impuesto, impronta escaneada o cédulas según checklist.',
      anchor: PASO6_ANCHORS.anexos,
      cta: 'Ir a anexos ↓',
    };
  }
  if (!p.firmaOk) {
    return {
      titulo: 'Solicita firma electrónica',
      detalle: 'Envía la firma del contrato al vendedor y al comprador.',
      anchor: PASO6_ANCHORS.firma,
      cta: 'Ir a firma ↓',
    };
  }
  return {
    titulo: 'Envía a validación STT',
    detalle: 'Checklist completo — cierra la gestión y envía el expediente al organismo de tránsito.',
    anchor: PASO6_ANCHORS.stt,
    cta: 'Ir a envío STT ↓',
  };
}

export default function TraspasoPaso6Guia({ biometriaOk, hayContrato, furOk, anexosCount, firmaOk }: Props) {
  const cierreListo = biometriaOk && hayContrato && furOk && Boolean(firmaOk);
  const pasos: { id: keyof typeof PASO6_ANCHORS; label: string; estado: PasoEstado }[] = [
    { id: 'identidad', label: 'Identidad', estado: biometriaOk ? 'done' : 'active' },
    { id: 'documentos', label: 'Legales', estado: hayContrato && furOk ? 'done' : hayContrato || biometriaOk ? 'active' : 'blocked' },
    { id: 'checklist', label: 'Checklist', estado: 'pending' },
    { id: 'anexos', label: 'Anexos', estado: anexosCount > 0 ? 'done' : 'pending' },
    { id: 'firma', label: 'Firma', estado: firmaOk ? 'done' : hayContrato ? 'active' : 'blocked' },
    { id: 'stt', label: 'STT', estado: cierreListo ? 'active' : 'pending' },
  ];

  const next = siguienteAccion({ biometriaOk, hayContrato, furOk, anexosCount, firmaOk });

  return (
    <div className="sticky top-0 z-10 flex flex-col gap-2 pb-1" style={{ background: 'var(--color-surface-elevated)' }}>
      <nav aria-label="Progreso paso 6" className="flex flex-wrap gap-1.5">
        {pasos.map(({ id, label, estado }) => (
          <button
            key={id}
            type="button"
            onClick={() => scrollToAnchor(PASO6_ANCHORS[id])}
            className="flit-focus rounded-[999px] border px-3 py-1 text-xs font-semibold transition-colors hover:border-[color:var(--kit-azul)] hover:bg-[var(--kit-hover)]"
            style={ESTADO_STYLE[estado]}
          >
            {estado === 'done' ? '✓ ' : ''}{label}
          </button>
        ))}
      </nav>

      <div
        className="flex flex-col gap-2 rounded-[9px] border px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
        style={{ borderColor: 'var(--kit-azul)', background: 'var(--kit-hover)' }}
        role="status"
        aria-live="polite"
      >
        <div className="min-w-0">
          <p className="m-0 text-xs font-bold" style={{ color: 'var(--color-action)' }}>Siguiente: {next.titulo}</p>
          <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>{next.detalle}</p>
        </div>
        <GradientButton type="button" size="sm" className="shrink-0" onClick={() => scrollToAnchor(next.anchor)}>
          {next.cta}
        </GradientButton>
      </div>
    </div>
  );
}
