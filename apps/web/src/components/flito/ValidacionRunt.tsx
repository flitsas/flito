// FLITO — Impuestos: validación factura de venta ↔ RUNT en la cola (HU #12830, Épica #12809).
// Vive fuera de `FlitoImpuestos.tsx` porque la página está al borde de `max-lines`
// (docs/ux/impuestos-analisis-factura-runt.md, «Reparto de archivos»). La página solo monta lo de aquí.
//
// Esta HU trae la marca de la fila (`LineaValidacion`), el aviso tras el envío masivo
// (`AvisoAnalisis`) y el preset «Con alertas». El modal comparativo es de la HU #12831: el icono ya
// es un botón con `onAbrir` opcional, que es el punto de enganche; sin él no abre nada.

import type { ReactNode } from 'react';
import { CircleCheck, CircleX, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import {
  ANALISIS_ESTADO_IMPUESTO_LABEL, MOTIVO_SEMAFORO_ROJO_LABEL, SEMAFORO_IMPUESTO_LABEL,
  type AnalisisEstadoImpuesto, type MotivoSemaforoRojo, type SemaforoImpuesto,
} from '@operaciones/shared-types';
import StatusChip from '../flit/StatusChip';
import { flitBtnSecondarySm, flitBtnSecondaryStyle } from '../flit/flitPageKit';

/** Lo que la fila de la cola trae del análisis post-envío. `undefined` se trata como `null`. */
export interface ValidacionFila {
  analisisEstado?: AnalisisEstadoImpuesto | null;
  semaforo?: SemaforoImpuesto | null;
  motivoSemaforo?: MotivoSemaforoRojo | null;
}

/**
 * Los colores que cuentan como alerta en el preset. `error_analisis` sin semáforo NO entra: el AC
 * dice «naranja o rojo», y el filtro es de servidor sobre la columna `semaforo`.
 */
export const SEMAFOROS_ALERTA: readonly SemaforoImpuesto[] = ['naranja', 'rojo'];

export const PRESET_CON_ALERTAS = {
  nombre: 'Con alertas',
  descripcion: 'Semáforo naranja o rojo: la factura no cuadra con el RUNT o no se pudo validar.',
};

export const VACIO_CON_ALERTAS =
  'Ningún impuesto tiene alertas con estos filtros. Quita el preset para ver toda la cola.';

type Marca = { texto: string; icono: ReactNode; color: string; clave: string };

/**
 * Una sola marca por fila, en el orden de la spec: `en_curso` manda sobre cualquier color viejo;
 * `error_analisis` se pinta como rojo porque para quien opera es lo mismo (no está validado).
 */
function marcaDe(v: ValidacionFila): Marca | 'analizando' | null {
  const estado = v.analisisEstado ?? null;
  if (estado === 'en_curso') return 'analizando';
  if (estado === 'error_analisis') {
    return {
      clave: 'error_analisis', color: 'var(--flit-danger-text)', icono: <CircleX size={18} aria-hidden="true" />,
      texto: 'Sin validar: la validación no terminó. Ver opciones',
    };
  }
  switch (v.semaforo ?? null) {
    case 'verde':
      return {
        clave: 'verde', color: 'var(--flit-success-text)', icono: <CircleCheck size={18} aria-hidden="true" />,
        texto: `${SEMAFORO_IMPUESTO_LABEL.verde}. Ver comparación`,
      };
    case 'naranja':
      return {
        clave: 'naranja', color: 'var(--flit-warning-text)', icono: <TriangleAlert size={18} aria-hidden="true" />,
        texto: 'Con diferencias frente al RUNT. Ver comparación',
      };
    case 'rojo':
      return {
        clave: 'rojo', color: 'var(--flit-danger-text)', icono: <CircleX size={18} aria-hidden="true" />,
        texto: v.motivoSemaforo ? `Sin validar: ${MOTIVO_SEMAFORO_ROJO_LABEL[v.motivoSemaforo]}` : 'Sin validar. Ver comparación',
      };
    default:
      return null;
  }
}

/**
 * La marca de validación de la celda Trámite. Con `null` (nunca analizado) no pinta nada, igual que
 * `AccionCertificacion`. «Analizando» es un chip, no un botón: no bloquea la fila.
 */
export function LineaValidacion({ fila, onAbrir }: { fila: ValidacionFila; onAbrir?: () => void }) {
  const marca = marcaDe(fila);
  if (marca === null) return null;
  if (marca === 'analizando') {
    return (
      <span data-testid="validacion-analizando">
        <StatusChip tone="active"
          icono={<LoaderCircle size={12} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />}>
          {ANALISIS_ESTADO_IMPUESTO_LABEL.en_curso}
        </StatusChip>
      </span>
    );
  }
  return (
    <button type="button" aria-label={marca.texto} title={marca.texto} onClick={onAbrir}
      data-semaforo={marca.clave}
      className="grid h-7 w-7 shrink-0 place-items-center rounded flit-focus transition-colors hover:bg-[var(--flit-bg-hover)]"
      style={{ color: marca.color }}>
      {marca.icono}
    </button>
  );
}

/** La marca junto a la acción de certificación, envolviendo si la columna se estrecha. */
export function AccionesTramite({ fila, onAbrir, children }: { fila: ValidacionFila; onAbrir?: () => void; children: ReactNode }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <LineaValidacion fila={fila} onAbrir={onAbrir} />
      {children}
    </span>
  );
}

export interface EnvioAnalisis { n: number; aOperaciones: boolean }

/**
 * Aviso tras el envío masivo (AC3). Es estado que sigue siendo cierto mientras se mira la página:
 * va en la página (`role="status"`), no en toast. Cerrable; con 0 enviados no se pinta.
 */
export function AvisoAnalisis({ envio, onActualizar, onCerrar }: {
  envio: EnvioAnalisis | null; onActualizar: () => void; onCerrar: () => void;
}) {
  if (!envio || envio.n <= 0) return null;
  const { n, aOperaciones } = envio;
  const uno = n === 1;
  const destino = aOperaciones ? 'a Operaciones' : 'al gestor';
  const texto = `${n} ${uno ? 'impuesto enviado' : 'impuestos enviados'} ${destino}. `
    + `${n} ${uno ? 'queda' : 'quedan'} en análisis contra el RUNT; el semáforo aparece en cada fila al terminar.`;
  return (
    <div role="status" data-testid="aviso-analisis"
      className="flex flex-wrap items-center justify-between gap-3 bg-flit-card px-6 py-4"
      style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}>
      <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{texto}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={flitBtnSecondarySm} style={flitBtnSecondaryStyle} onClick={onActualizar}>
          Actualizar la cola
        </button>
        <button type="button" aria-label="Cerrar aviso" title="Cerrar aviso" onClick={onCerrar}
          className="grid h-7 w-7 place-items-center rounded flit-focus transition-colors hover:bg-[var(--flit-bg-hover)]"
          style={{ color: 'var(--flit-text-secondary)' }}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
