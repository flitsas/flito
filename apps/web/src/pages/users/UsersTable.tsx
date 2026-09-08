// FLITO — la tabla de usuarios: cabeceras, filas, botones de acción y los tres estados de la lista
// (cargando, vacío, lleno). Extraído de `pages/Users.tsx` sin cambios. HU #12175 / Feature #12072.
//
// La celda «Ámbito» NO está aquí: vive en `Ambito.tsx`, con el bloque de campos del formulario que
// ramifica por el mismo criterio. Aquí queda la rejilla, que es lo que la HU #12172 amplía.
//
// **Esto NO es kit.** Props tipadas, sin estado global, un único consumidor: la página de usuarios.

import StatusChip from '../../components/flit/StatusChip';
import { ROLES, ROLE_TONE, type User } from './types';
import { AmbitoCelda } from './Ambito';
import type { CatalogoOrganismos, CatalogoProveedores } from './AtaduraFields';

export default function UsersTable({ users, loading, meId, nombreCompania, proveedores, organismos, onEditar, onContrasena, onAlternar }: {
  users: User[];
  loading: boolean;
  meId: number | undefined;
  nombreCompania: (id: number) => string | null;
  proveedores: CatalogoProveedores;
  organismos: CatalogoOrganismos;
  onEditar: (u: User) => void;
  onContrasena: (u: User) => void;
  onAlternar: (u: User) => void;
}) {
  return (
    <div
      className="overflow-hidden bg-white"
      style={{ borderRadius: 'var(--flit-radius-card)', boxShadow: 'var(--flit-shadow-card)', border: '1px solid var(--flit-border-soft)' }}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <Th>Usuario</Th>
              <Th>Nombre</Th>
              <Th>Email</Th>
              <Th>Rol</Th>
              {/* Se RENOMBRA en vez de añadir columnas: la celda ya ramificaba por rol para
                  decir «a qué ámbito está atado este usuario», y las tres columnas de la
                  disposición B nacerían vacías para 9 de los 12 roles. Siguen siendo SIETE.
                  «Ámbito» se lee en pareja con «Rol», que tiene justo a la izquierda: el rol dice
                  de qué tipo es el ámbito y esta celda dice cuál. */}
              <Th>Ámbito</Th>
              <Th>Estado</Th>
              <ThRight>Acciones</ThRight>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="py-10 text-center" style={{ color: 'var(--flit-text-muted)' }}>Cargando...</td></tr>}
            {!loading && users.length === 0 && <tr><td colSpan={7} className="py-10 text-center" style={{ color: 'var(--flit-text-muted)' }}>Sin usuarios</td></tr>}
            {!loading && users.map((u) => {
              const roleLabel = ROLES.find((r) => r.value === u.role)?.label ?? u.role;
              const isMe = u.id === meId;
              return (
                <tr key={u.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-4 py-3 font-mono text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
                    {u.username}
                    {isMe && <span className="ml-1.5 text-[9px] font-bold" style={{ color: 'var(--flit-blue)' }}>(tú)</span>}
                  </td>
                  <td className="px-4 py-3" style={{ color: 'var(--flit-text-primary)' }}>{u.name}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{u.email || '—'}</td>
                  <td className="px-4 py-3">
                    <StatusChip tone={ROLE_TONE[u.role] ?? 'neutral'}>{roleLabel}</StatusChip>
                  </td>
                  <AmbitoCelda user={u} nombreCompania={nombreCompania} proveedores={proveedores} organismos={organismos} />
                  <td className="px-4 py-3">
                    <StatusChip tone={u.active ? 'success' : 'danger'}>{u.active ? 'Activo' : 'Inactivo'}</StatusChip>
                  </td>
                  <td className="space-x-1 px-4 py-3 text-right">
                    <RowButton onClick={() => onEditar(u)} tone="active">Editar</RowButton>
                    <RowButton onClick={() => onContrasena(u)} tone="neutral">Contraseña</RowButton>
                    <RowButton onClick={() => onAlternar(u)} disabled={isMe} tone={u.active ? 'danger' : 'success'}>
                      {u.active ? 'Desactivar' : 'Activar'}
                    </RowButton>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide"
      style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>
      {children}
    </th>
  );
}
function ThRight({ children }: { children: React.ReactNode }) {
  return (
    <th scope="col" className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide"
      style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>
      {children}
    </th>
  );
}

// Botón de acción de fila (texto exacto preservado para E2E: «Editar», etc.).
type RowTone = 'active' | 'neutral' | 'success' | 'danger';
const ROW_TONE: Record<RowTone, { fg: string; bg: string }> = {
  active: { fg: 'var(--flit-blue)', bg: 'rgba(79, 116, 201, 0.12)' },
  neutral: { fg: 'var(--flit-text-secondary)', bg: 'rgba(125, 135, 152, 0.12)' },
  success: { fg: 'var(--flit-success)', bg: 'rgba(112, 207, 58, 0.14)' },
  danger: { fg: 'var(--flit-danger)', bg: 'rgba(228, 61, 48, 0.12)' },
};
function RowButton({ onClick, disabled, tone, children }: { onClick: () => void; disabled?: boolean; tone: RowTone; children: React.ReactNode }) {
  const c = ROW_TONE[tone];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flit-focus rounded-[999px] px-2.5 py-1 text-xs font-semibold transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-30"
      style={{ color: c.fg, background: c.bg }}
    >
      {children}
    </button>
  );
}
