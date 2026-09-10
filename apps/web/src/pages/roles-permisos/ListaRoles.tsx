// HU #12085 — La lista de roles (columna izquierda de la disposición A, ficha §5/§6.1).
//
// Es un `<ul>` de `<button>`s bajo un `<h2>`, con `aria-current="true"` en el seleccionado: no es
// `<nav>` (no cambia de ruta) ni `listbox` (son botones). La cuenta que enseña es la GUARDADA —no
// se mueve al marcar casillas hasta que se guarda (ficha decisión 6)—. Por debajo de `lg` la lista
// se pliega a un `FlitSelect` «Rol» (ficha §6.1, geometría).

import type { RolCatalogo } from '@operaciones/shared-types';
import FlitSelect from '../../components/flit/FlitSelect';
import StatusChip from '../../components/flit/StatusChip';
import { FlitCard } from '../../components/flit/flitPageKit';

interface Props {
  roles: RolCatalogo[];
  /** Cuántas funciones tiene GUARDADAS cada rol; `undefined` mientras no se conoce. */
  cuentaPorRol: Record<string, number | undefined>;
  total: number;
  seleccionado: string | null;
  onSeleccionar: (codigo: string) => void;
}

export default function ListaRoles({ roles, cuentaPorRol, total, seleccionado, onSeleccionar }: Props) {
  return (
    <>
      <div className="lg:hidden">
        <FlitSelect
          label="Rol"
          value={seleccionado ?? ''}
          opciones={roles.map((r) => ({
            valor: r.codigo,
            etiqueta: r.nombre,
            nota: [r.tipoPrincipal === 'externo' ? 'externo' : null, r.activo ? null : 'inactivo'].filter(Boolean).join(', ') || undefined,
          }))}
          onChange={onSeleccionar}
        />
      </div>
      <FlitCard className="hidden lg:block lg:sticky lg:top-[calc(var(--flit-topbar-height)_+_var(--flit-navbar-height)_+_1rem)] lg:self-start">
        <h2 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
          Roles
          <span className="ml-2 font-semibold tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>({roles.length})</span>
        </h2>
        <ul className="mt-3 flex flex-col gap-1">
          {roles.map((r) => {
            const activo = r.codigo === seleccionado;
            const cuenta = cuentaPorRol[r.codigo];
            return (
              <li key={r.codigo}>
                <button
                  type="button"
                  aria-current={activo ? 'true' : undefined}
                  onClick={() => onSeleccionar(r.codigo)}
                  className="flit-focus flex w-full items-center justify-between gap-2 rounded-[10px] px-3 py-2 text-left text-sm"
                  style={{
                    background: activo ? 'var(--flit-bg-app)' : 'transparent',
                    color: 'var(--flit-text-primary)',
                    fontWeight: activo ? 600 : 400,
                  }}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{r.nombre}</span>
                    {r.tipoPrincipal === 'externo' && <StatusChip tone="warning">Externo</StatusChip>}
                    {!r.activo && <StatusChip tone="draft">Inactivo</StatusChip>}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>
                    {cuenta === undefined ? '—' : `${cuenta}/${total}`}
                    <span className="sr-only"> funciones marcadas</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </FlitCard>
    </>
  );
}
