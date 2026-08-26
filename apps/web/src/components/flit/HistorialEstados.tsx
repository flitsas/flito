// Línea de tiempo de los cambios de estado de un SOAT o un impuesto.
//
// Los trámites tenían historial desde el principio; estos dos no tenían ninguno, y responder «¿por
// qué este impuesto sigue solicitado?» obligaba a bajar a `audit_logs` a leer texto libre.
//
// Se pliega por defecto. El detalle ya es largo y el historial es la segunda pregunta, no la
// primera: se abre cuando el estado actual no explica lo que se está viendo.

import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import StatusChip, { type ChipTone } from './StatusChip';

export interface ItemHistorial {
  id: number;
  estadoAnterior: string | null;
  estadoNuevo: string;
  motivo: string | null;
  usuario: string | null;
  origen: string;
  creadoEn: string;
}

const ETIQUETA: Record<string, string> = {
  pendiente: 'Pendiente', solicitado: 'Solicitado', con_novedad: 'Con novedad', pagado: 'Pagado',
};
const TONO: Record<string, ChipTone> = {
  pendiente: 'draft', solicitado: 'active', con_novedad: 'warning', pagado: 'success',
};

const fechaHora = (iso: string) =>
  new Date(iso).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Quién lo hizo, en una sola frase.
 *
 * `auditoria` marca las filas reconstruidas desde `audit_logs` al desplegar esto, y se distingue a
 * propósito: son ciertas pero no se registraron en el momento, y quien audita tiene derecho a saber
 * cuáles son de primera mano.
 */
function autor(i: ItemHistorial): string {
  if (i.origen === 'sistema') return 'Sistema';
  return i.usuario ?? 'Usuario desconocido';
}

export default function HistorialEstados({ concepto, registroId }: {
  concepto: 'soat' | 'impuesto';
  registroId: string;
}) {
  const [abierto, setAbierto] = useState(false);
  const [items, setItems] = useState<ItemHistorial[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ruta = concepto === 'soat' ? 'soat' : 'impuestos';

  useEffect(() => {
    // Solo se pide al abrir: la cola muestra hasta 50 registros y precargar el historial de todos
    // sería una consulta por fila para algo que casi nunca se mira.
    if (!abierto || items || error) return;
    api.get<ItemHistorial[]>(`/flito/${ruta}/${registroId}/historial`)
      .then((h) => setItems(Array.isArray(h) ? h : []))
      .catch((e) => setError(errorMessage(e)));
  }, [abierto, items, error, ruta, registroId]);

  return (
    <div>
      <button type="button" className="text-xs font-semibold underline"
        style={{ color: 'var(--flit-blue-text)' }}
        onClick={() => setAbierto((v) => !v)}>
        {abierto ? 'Ocultar el historial' : 'Ver el historial de estados'}
      </button>

      {abierto && (
        <div className="mt-2 rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
          {error && <p className="text-xs text-red-600">{error}</p>}
          {!items && !error && <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Cargando…</p>}
          {items && items.length === 0 && (
            <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
              Sin movimientos registrados.
            </p>
          )}
          {items && items.length > 0 && (
            <ol className="space-y-2">
              {items.map((i) => (
                <li key={i.id} className="flex flex-col gap-0.5 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {/* El alta no tiene estado de partida: se rotula, en vez de dejar un hueco. */}
                    {i.estadoAnterior
                      ? <StatusChip tone={TONO[i.estadoAnterior] ?? 'neutral'}>{ETIQUETA[i.estadoAnterior] ?? i.estadoAnterior}</StatusChip>
                      : <span style={{ color: 'var(--flit-text-muted)' }}>Alta</span>}
                    <span style={{ color: 'var(--flit-text-muted)' }}>→</span>
                    <StatusChip tone={TONO[i.estadoNuevo] ?? 'neutral'}>{ETIQUETA[i.estadoNuevo] ?? i.estadoNuevo}</StatusChip>
                  </div>
                  <div style={{ color: 'var(--flit-text-secondary)' }}>
                    {fechaHora(i.creadoEn)} · {autor(i)}
                    {i.origen === 'auditoria' && (
                      <span title="Reconstruido desde la auditoría al implantar el historial; no se registró en el momento."
                        style={{ color: 'var(--flit-text-muted)' }}> · reconstruido</span>
                    )}
                  </div>
                  {i.motivo && <div style={{ color: 'var(--flit-text-muted)' }}>{i.motivo}</div>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
