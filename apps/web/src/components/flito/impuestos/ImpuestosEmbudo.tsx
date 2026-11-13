// Embudo de la cola de Impuestos por FASE (UI Kit 2026, molde `#tramites`, decisión D2).
// Es la misma pieza `.embudo` del kit (`Embudo` de Bloques) SIN la cifra: la cola no expone conteos
// por estado y pintarlos exigiría otra consulta (fuera de un rediseño solo visual). Cuando el
// `Embudo` del kit acepte `cuenta` opcional, este archivo se reemplaza por él.
import { ESTADO_IMPUESTO_LABEL, type EstadoImpuesto } from '@operaciones/shared-types';
import { Icono } from '../../flit/kit/Icono';
import { estadoKit, registrarEstados } from '../../flit/kit/tonos';

// Un glifo por estado (regla del kit). Claves con prefijo del módulo para no pisar las del kit.
registrarEstados({
  'impuesto-todos': { tono: 'neutro', glifo: 'todos' },
  'impuesto-pendiente': { tono: 'neutro', glifo: 'pausa' },
  'impuesto-solicitado': { tono: 'info', glifo: 'reloj' },
  'impuesto-con_novedad': { tono: 'danger', glifo: 'alerta' },
  'impuesto-pagado': { tono: 'ok', glifo: 'doble-check' },
});

const DISCO: Record<string, string> = { ok: 'ok', warn: 'warn', danger: 'danger', info: 'info' };

export default function ImpuestosEmbudo({ estados, conTodos, activo, onElegir }: {
  estados: EstadoImpuesto[];
  conTodos: boolean;
  activo: EstadoImpuesto | 'todos';
  onElegir: (e: EstadoImpuesto | 'todos') => void;
}) {
  const chips: Array<{ id: EstadoImpuesto | 'todos'; etiqueta: string }> = [
    ...(conTodos ? [{ id: 'todos' as const, etiqueta: 'Todos' }] : []),
    ...estados.map((e) => ({ id: e, etiqueta: ESTADO_IMPUESTO_LABEL[e] })),
  ];
  return (
    <div className="embudo !mb-0" role="group" aria-label="Fases del impuesto" data-kit="embudo">
      {chips.map((c) => {
        const e = estadoKit(`impuesto-${c.id}`);
        return (
          <button key={c.id} type="button" className="chip" aria-pressed={c.id === activo} onClick={() => onElegir(c.id)}>
            <span className={`kico estado-ico estado-ico--${DISCO[e.tono] ?? 'neutro'}`} aria-hidden="true">
              <Icono nombre={e.glifo ?? 'punto'} />
            </span>
            <span>{c.etiqueta}</span>
          </button>
        );
      })}
    </div>
  );
}
