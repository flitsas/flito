// HU #12085 — La lista de roles (columna izquierda de la disposición A, ficha §5/§6.1).
//
// Es un `<ul>` de `<button>`s bajo un `<h2>`, con `aria-current="true"` en el seleccionado: no es
// `<nav>` (no cambia de ruta) ni `listbox` (son botones). La cuenta que enseña es la GUARDADA —no
// se mueve al marcar casillas hasta que se guarda (ficha decisión 6)—. Por debajo de `lg` la lista
// se pliega a un `FlitSelect` «Rol» (ficha §6.1, geometría).
//
// Rediseño 2026 (Épica #14560, molde `vRbac()`): tarjeta «Roles» con la lista `.roles`/`.rol` del kit
// (nombre en `strong`, cuenta en `small`) y «Nuevo rol» secundario a todo el ancho al pie. El activo
// sigue marcado con `aria-current` (no `aria-pressed`): el estilo del kit se replica sobre ese atributo.

import type { RolCatalogo } from '@operaciones/shared-types';
import FlitSelect from '../../components/flit/FlitSelect';
import GradientButton from '../../components/flit/GradientButton';
import StatusChip from '../../components/flit/StatusChip';
import { FlitCard } from '../../components/flit/flitPageKit';

interface Props {
  roles: RolCatalogo[];
  /** Cuántas funciones tiene GUARDADAS cada rol; `undefined` mientras no se conoce. */
  cuentaPorRol: Record<string, number | undefined>;
  total: number;
  seleccionado: string | null;
  onSeleccionar: (codigo: string) => void;
  /** «Nuevo rol» al pie de la tarjeta; sin él (no hay permiso de crear) no se pinta. */
  onNuevo?: () => void;
}

/** Estilo del `.rol[aria-pressed="true"]` del kit, sobre `aria-current` (el contrato de la lista). */
const ROL = 'rol flit-focus transition-colors hover:bg-[var(--color-accent-soft)] aria-[current=true]:border-[var(--color-action)] aria-[current=true]:bg-[var(--color-accent-soft)]';

export default function ListaRoles({ roles, cuentaPorRol, total, seleccionado, onSeleccionar, onNuevo }: Props) {
  return (
    <FlitCard className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-[calc(var(--kit-alto-barra)_+_1rem)] lg:self-start">
      <h2 className="text-base font-semibold" style={{ color: 'var(--color-text-primary)' }}>
        Roles
        <span className="ml-2 font-normal tabular-nums" style={{ color: 'var(--color-text-tertiary)' }}>({roles.length})</span>
      </h2>
      <div className="lg:hidden">
        <FlitSelect
          label="Rol"
          value={seleccionado ?? ''}
          opciones={roles.map((r) => ({
            valor: r.codigo,
            etiqueta: r.nombre,
            nota: r.activo ? undefined : 'inactivo',
          }))}
          onChange={onSeleccionar}
        />
      </div>
      <ul className="roles !mt-0 hidden lg:grid">
        {roles.map((r) => {
          const activo = r.codigo === seleccionado;
          const cuenta = cuentaPorRol[r.codigo];
          return (
            <li key={r.codigo}>
              <button
                type="button"
                aria-current={activo ? 'true' : undefined}
                onClick={() => onSeleccionar(r.codigo)}
                className={ROL}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <strong
                    className="truncate text-sm font-semibold"
                    style={{ color: activo ? 'var(--color-action)' : 'var(--color-text-primary)' }}
                  >
                    {r.nombre}
                  </strong>
                  {!r.activo && <StatusChip tone="draft">Inactivo</StatusChip>}
                </span>
                <small className="tabular-nums">
                  {cuenta === undefined ? '—' : `${cuenta}/${total}`}
                  <span className="sr-only"> funciones marcadas</span>
                </small>
              </button>
            </li>
          );
        })}
      </ul>
      {onNuevo && (
        <GradientButton type="button" variant="secondary" className="w-full justify-center" onClick={onNuevo}>Nuevo rol</GradientButton>
      )}
    </FlitCard>
  );
}
