// «Eliminar» del menú ⋮ de Proveedores (HU #13962). Gemelo de `useEliminarCliente` (#13956): mismo
// diseño (`docs/ux/clientes-menu-estado-13949-slim.md`, divisor + tono peligro) y mismos estados.
//
// El impacto se pide AL ABRIR el menú: el motivo debe verse ANTES de elegir la opción (AC1).
//   activo   → deshabilitada con «Primero debe desactivarlo.» SIN pedir impacto: el front ya lo sabe.
//   cargando → deshabilitada con «Comprobando…».
//   listo    → habilitada si `puedeEliminar`; si no, deshabilitada con `motivoNoEliminable` tal cual
//              (copy de producto del API: «Tiene 4 SOAT en curso.», «Es el proveedor de SOAT sin
//              trámite de 2 compañías (Alfa, Beta).»).
//   error    → habilitada como reintento: elegirla vuelve a comprobar sin cerrar el menú.
//   403      → deshabilitada con «No tiene permiso para esta acción.». Contrato (#13956): el impacto
//              exige `parametrizacion.proveedores.estado`, así que eliminar depende de estado.
// El DELETE vuelve a validar en el servidor: el impacto solo adelanta el motivo.

import { useRef, useState, type RefObject } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { toastError, toastOk } from '../flit/ToastFlito';
import type { OpcionMenuFila } from '../flit/MenuFila';
import { DialogoEliminarRegistro } from './DialogoEliminarRegistro';

/** Lo que este hook lee de `ImpactoProveedorSoat`. */
interface ImpactoEliminar { puedeEliminar: boolean; motivoNoEliminable: string | null }

export const MOTIVO_PROVEEDOR_ACTIVO = 'Primero debe desactivarlo.';

type EstadoComprobacion =
  | { fase: 'cargando' }
  | { fase: 'error'; sinPermiso: boolean }
  | { fase: 'listo'; puede: boolean; motivo: string | null };

interface ProveedorFila { id: string; nombre: string; activo: boolean }

interface Opciones<P extends ProveedorFila> {
  /** Tras el 2xx: la pestaña quita la fila y recarga en silencio. */
  onEliminado: (p: P) => void;
  /** 409 de concurrencia o 404: la pestaña recarga. */
  onDesactualizado: () => void;
  restoreFocusRef: RefObject<HTMLElement | null>;
}

export function useEliminarProveedor<P extends ProveedorFila>({ onEliminado, onDesactualizado, restoreFocusRef }: Opciones<P>) {
  const { hasFuncion } = useAuth();
  const habilitado = hasFuncion('parametrizacion.proveedores.eliminar');
  const [comprobaciones, setComprobaciones] = useState<Map<string, EstadoComprobacion>>(new Map());
  const [eliminarDe, setEliminarDe] = useState<P | null>(null);
  // Solo cuenta la última petición por proveedor: abrir y cerrar rápido no pinta un motivo viejo.
  const turno = useRef(new Map<string, number>());

  const fijar = (id: string, e: EstadoComprobacion) =>
    setComprobaciones((prev) => new Map(prev).set(id, e));

  const comprobar = (p: P) => {
    if (!habilitado || p.activo) return;
    const n = (turno.current.get(p.id) ?? 0) + 1;
    turno.current.set(p.id, n);
    fijar(p.id, { fase: 'cargando' });
    api.get<ImpactoEliminar>(`/flito/parametrizacion/proveedores-soat/${p.id}/impacto`)
      .then((r) => {
        if (turno.current.get(p.id) === n) fijar(p.id, { fase: 'listo', puede: r.puedeEliminar, motivo: r.motivoNoEliminable });
      })
      .catch((e) => {
        if (turno.current.get(p.id) === n) fijar(p.id, { fase: 'error', sinPermiso: e instanceof ApiError && e.status === 403 });
      });
  };

  const opciones = (p: P): OpcionMenuFila[] => {
    if (!habilitado) return [];
    const base = { id: 'eliminar', texto: 'Eliminar', tono: 'peligro' as const };
    if (p.activo) return [{ ...base, deshabilitada: true, motivo: MOTIVO_PROVEEDOR_ACTIVO, onElegir: () => {} }];
    const e = comprobaciones.get(p.id) ?? { fase: 'cargando' as const };
    if (e.fase === 'cargando') return [{ ...base, deshabilitada: true, motivo: 'Comprobando…', onElegir: () => {} }];
    if (e.fase === 'error') {
      return [e.sinPermiso
        ? { ...base, deshabilitada: true, motivo: 'No tiene permiso para esta acción.', onElegir: () => {} }
        : { ...base, motivo: 'No pudimos comprobar si se puede eliminar. Elíjala para reintentar.', cierra: false, onElegir: () => comprobar(p) }];
    }
    if (!e.puede) {
      return [{ ...base, deshabilitada: true, motivo: e.motivo ?? 'No se puede eliminar.', onElegir: () => {} }];
    }
    return [{ ...base, onElegir: () => setEliminarDe(p) }];
  };

  const dialogo = eliminarDe && (
    <DialogoEliminarRegistro
      nombre={eliminarDe.nombre}
      sustantivo="proveedor"
      confirmar={async () => { await api.delete(`/flito/parametrizacion/proveedores-soat/${eliminarDe.id}`); }}
      onHecho={() => {
        const p = eliminarDe;
        setEliminarDe(null);
        toastOk('Proveedor eliminado.', { id: `eliminar-prov-${p.id}` });
        onEliminado(p);
      }}
      onDesactualizado={(motivo) => {
        const id = eliminarDe.id;
        setEliminarDe(null);
        toastError(motivo === 'cambiado'
          ? 'Otro administrador ya cambió su estado.'
          : 'Este proveedor ya no existe. Se actualizó la lista.', undefined, { id: `eliminar-prov-${id}` });
        onDesactualizado();
      }}
      onCerrar={() => setEliminarDe(null)}
      restoreFocusRef={restoreFocusRef}
    />
  );

  return { opciones, comprobar, dialogo };
}
