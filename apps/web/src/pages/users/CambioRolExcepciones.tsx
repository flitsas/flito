// FLITO — confirmación al cambiar de rol con excepciones aún vigentes (HU #12087 §4-3).
// Se abre en Guardar, no al cambiar el `<select>`. Premarcado según la regla del 10/09 contra el
// cuadro del rol NUEVO.
//
// **Esto NO es kit.** Un único consumidor: `EditUserForm`.

import { useEffect, useState } from 'react';
import type { FuncionDeUsuario } from '@operaciones/shared-types';
import { errorMessage, permisosApi } from '../../lib/api';
import FlitModal from '../../components/flit/FlitModal';

const COPY_TITULO = 'Conservar excepciones con el rol nuevo';
const COPY_AYUDA =
  'Al cambiar de rol, decide qué excepciones conservar. Las que dejan de tener sentido quedan desmarcadas.';
const COPY_SIN_EFECTO = 'Sin efecto con el rol nuevo';

/** ¿Conservar por defecto? Regla 10/09: revocar X si el rol nuevo da X; conceder X si el rol nuevo NO da X. */
export function premarcarConservar(exc: FuncionDeUsuario, cuadroNuevo: Set<string>): boolean {
  if (exc.efecto === 'revocar') return cuadroNuevo.has(exc.codigo);
  if (exc.efecto === 'conceder') return !cuadroNuevo.has(exc.codigo);
  return false;
}

export default function CambioRolExcepciones({
  excepciones, rolNuevo, nombres, onConfirmar, onCancelar,
}: {
  excepciones: FuncionDeUsuario[];
  rolNuevo: string;
  /** codigo → nombre de negocio (del catálogo). */
  nombres: Map<string, string>;
  onConfirmar: (conservadas: FuncionDeUsuario[]) => void;
  onCancelar: () => void;
}) {
  const [cuadro, setCuadro] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [marcar, setMarcar] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let vivo = true;
    setCargando(true);
    setError(null);
    permisosApi.cuadroDelRol(rolNuevo)
      .then((r) => {
        if (!vivo) return;
        const set = new Set(r.funciones);
        setCuadro(set);
        const init: Record<string, boolean> = {};
        for (const e of excepciones) init[e.codigo] = premarcarConservar(e, set);
        setMarcar(init);
      })
      .catch((e) => { if (vivo) setError(errorMessage(e)); })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [rolNuevo, excepciones]);

  const confirmar = () => {
    onConfirmar(excepciones.filter((e) => marcar[e.codigo]));
  };

  return (
    <FlitModal title={COPY_TITULO} onClose={onCancelar}>
      <div className="space-y-3">
        <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{COPY_AYUDA}</p>
        {cargando && <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }} role="status">Cargando cuadro del rol nuevo…</p>}
        {error && (
          <p className="text-xs" role="alert" style={{ color: 'var(--flit-danger-ink)' }}>
            No se pudo cargar el cuadro del rol. Cierra e inténtalo de nuevo.
          </p>
        )}
        {cuadro && (
          <ul className="max-h-60 space-y-2 overflow-y-auto">
            {excepciones.map((e) => {
              const tieneSentido = premarcarConservar(e, cuadro);
              const nombre = nombres.get(e.codigo) ?? e.codigo;
              const efectoLabel = e.efecto === 'conceder' ? 'Añadido' : 'Quitado';
              return (
                <li key={e.codigo} className="flex items-start gap-2 text-sm">
                  <input
                    id={`conservar-${e.codigo}`}
                    type="checkbox"
                    className="flit-focus mt-0.5 h-4 w-4 shrink-0"
                    checked={!!marcar[e.codigo]}
                    onChange={(ev) => setMarcar((m) => ({ ...m, [e.codigo]: ev.target.checked }))}
                  />
                  <label htmlFor={`conservar-${e.codigo}`} className="flex-1 cursor-pointer">
                    <span className="font-medium" style={{ color: 'var(--flit-text-primary)' }}>
                      Conservar · {efectoLabel} · {nombre}
                    </span>
                    {!tieneSentido && (
                      <span className="mt-0.5 block text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
                        {COPY_SIN_EFECTO}
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onCancelar} className="rounded-lg px-3 py-1.5 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            Cancelar
          </button>
          <button
            type="button"
            onClick={confirmar}
            disabled={cargando || !!error}
            className="rounded-lg px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: 'var(--flit-blue)' }}
          >
            Confirmar
          </button>
        </div>
      </div>
    </FlitModal>
  );
}
