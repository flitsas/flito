// «Eliminar» del menú ⋮ de Clientes (HU #13956). Diseño: extiende
// `docs/ux/clientes-menu-estado-13949-slim.md` (hueco previsto: divisor + tono peligro).
//
// Decisión: el impacto se pide AL ABRIR el menú, no al elegir. Los AC exigen ver la opción
// deshabilitada con su motivo ANTES de elegirla, y el motivo sale de `GET /clients/:id/impacto`.
//   cargando → «Eliminar» deshabilitada con «Comprobando…».
//   listo    → habilitada si `puedeEliminar`; si no, deshabilitada con `motivoNoEliminable` (copy de
//              producto del API: «Primero debe desactivarlo.», «Su bolsa tiene saldo de $150.000…»).
//   error    → habilitada como reintento: elegirla vuelve a comprobar sin cerrar el menú.
//   403      → deshabilitada con «No tiene permiso para esta acción.».
// El DELETE vuelve a validar en el servidor: el impacto solo adelanta el motivo.

import { useRef, useState, type RefObject } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { toastError, toastOk } from '../flit/ToastFlito';
import type { OpcionMenuFila } from '../flit/MenuFila';
import { DialogoEliminarRegistro } from './DialogoEliminarRegistro';

interface ImpactoEliminar { puedeEliminar: boolean; motivoNoEliminable: string | null }

type EstadoComprobacion =
  | { fase: 'cargando' }
  | { fase: 'error'; sinPermiso: boolean }
  | { fase: 'listo'; puede: boolean; motivo: string | null };

interface ClienteFila { id: number; name: string }

interface Opciones<C extends ClienteFila> {
  /** Tras el 2xx: la pestaña quita la fila y recarga en silencio. */
  onEliminado: (c: C) => void;
  /** 409 de concurrencia o 404: la pestaña recarga. */
  onDesactualizado: () => void;
  restoreFocusRef: RefObject<HTMLElement | null>;
}

export function useEliminarCliente<C extends ClienteFila>({ onEliminado, onDesactualizado, restoreFocusRef }: Opciones<C>) {
  const { hasFuncion } = useAuth();
  const habilitado = hasFuncion('clients.clientes.eliminar');
  const [comprobaciones, setComprobaciones] = useState<Map<number, EstadoComprobacion>>(new Map());
  const [eliminarDe, setEliminarDe] = useState<C | null>(null);
  // Solo cuenta la última petición por cliente: abrir y cerrar rápido no pinta un motivo viejo.
  const turno = useRef(new Map<number, number>());

  const fijar = (id: number, e: EstadoComprobacion) =>
    setComprobaciones((prev) => new Map(prev).set(id, e));

  const comprobar = (c: C) => {
    if (!habilitado) return;
    const n = (turno.current.get(c.id) ?? 0) + 1;
    turno.current.set(c.id, n);
    fijar(c.id, { fase: 'cargando' });
    api.get<ImpactoEliminar>(`/clients/${c.id}/impacto`)
      .then((r) => {
        if (turno.current.get(c.id) === n) fijar(c.id, { fase: 'listo', puede: r.puedeEliminar, motivo: r.motivoNoEliminable });
      })
      .catch((e) => {
        if (turno.current.get(c.id) === n) fijar(c.id, { fase: 'error', sinPermiso: e instanceof ApiError && e.status === 403 });
      });
  };

  const opciones = (c: C): OpcionMenuFila[] => {
    if (!habilitado) return [];
    const base = { id: 'eliminar', texto: 'Eliminar', tono: 'peligro' as const };
    const e = comprobaciones.get(c.id) ?? { fase: 'cargando' as const };
    if (e.fase === 'cargando') return [{ ...base, deshabilitada: true, motivo: 'Comprobando…', onElegir: () => {} }];
    if (e.fase === 'error') {
      return [e.sinPermiso
        ? { ...base, deshabilitada: true, motivo: 'No tiene permiso para esta acción.', onElegir: () => {} }
        : { ...base, motivo: 'No pudimos comprobar si se puede eliminar. Elíjala para reintentar.', cierra: false, onElegir: () => comprobar(c) }];
    }
    if (!e.puede) {
      return [{ ...base, deshabilitada: true, motivo: e.motivo ?? 'No se puede eliminar.', onElegir: () => {} }];
    }
    return [{ ...base, onElegir: () => setEliminarDe(c) }];
  };

  const dialogo = eliminarDe && (
    <DialogoEliminarRegistro
      nombre={eliminarDe.name}
      sustantivo="cliente"
      confirmar={async () => { await api.delete(`/clients/${eliminarDe.id}`); }}
      onHecho={() => {
        const c = eliminarDe;
        setEliminarDe(null);
        toastOk('Cliente eliminado.', { id: `eliminar-${c.id}` });
        onEliminado(c);
      }}
      onDesactualizado={(motivo) => {
        const id = eliminarDe.id;
        setEliminarDe(null);
        toastError(motivo === 'cambiado'
          ? 'Otro administrador ya cambió su estado.'
          : 'Este cliente ya no existe. Se actualizó la lista.', undefined, { id: `eliminar-${id}` });
        onDesactualizado();
      }}
      onCerrar={() => setEliminarDe(null)}
      restoreFocusRef={restoreFocusRef}
    />
  );

  return { opciones, comprobar, dialogo };
}
