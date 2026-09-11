// FLITO — la tabla de usuarios: cabeceras, filas, botones de acción y los CUATRO estados de la
// lista (cargando, error, vacío, lleno). Extraído de `pages/Users.tsx` en la HU #12175; el estado de
// error se añadió en la #12172, que es la primera que vuelve a abrir el archivo. Feature #12072.
// HU #12088: celda Ámbito por `tipoEnlace` del catálogo de roles.
//
// La celda «Ámbito» NO está aquí: vive en `Ambito.tsx`, con el bloque de campos del formulario que
// ramifica por el mismo criterio. Aquí queda la rejilla, que es lo que la HU #12172 amplía.
//
// **Esto NO es kit.** Props tipadas, sin estado global, un único consumidor: la página de usuarios.

import StatusChip from '../../components/flit/StatusChip';
import { etiquetaRol, ROLE_TONE, tipoEnlaceDe, type RolOpcion, type User } from './types';
import { AmbitoCelda } from './Ambito';
import type { CatalogoOrganismos, CatalogoProveedores } from './AtaduraFields';

export default function UsersTable({ users, loading, error, onReintentar, vacioMensaje, meId, rolesCatalogo, nombreCompania, proveedores, organismos, onEditar, onContrasena, onAlternar, onDarDeBaja, onReactivar }: {
  users: User[];
  loading: boolean;
  /** Mensaje del fallo de carga, o `null`. Es el CUARTO estado (HU #12172): ver `EstadoError`. */
  error: string | null;
  onReintentar: () => void;
  /** Texto del vacío (HU #12089: distinto si el filtro es «Dados de baja»). */
  vacioMensaje?: string;
  meId: number | undefined;
  rolesCatalogo: RolOpcion[] | null;
  nombreCompania: (id: number) => string | null;
  proveedores: CatalogoProveedores;
  organismos: CatalogoOrganismos;
  onEditar: (u: User) => void;
  onContrasena: (u: User) => void;
  /** Toggle `active` (suspensión). No es baja lógica. */
  onAlternar: (u: User) => void;
  onDarDeBaja: (u: User) => void;
  onReactivar: (u: User) => void;
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
            {/* El ERROR va ANTES del vacío y lo excluye: una carga fallida deja `users` en `[]`, así
                que sin esta rama el fallo se leería como «Sin usuarios» —un dato falso— y el usuario
                se quedaría sin nada que pulsar. Antes de la HU #12172 ese caso solo salía por
                `toast.error`, que se va solo a los pocos segundos. */}
            {!loading && error && (
              <tr><td colSpan={7} className="px-4 py-10 text-center">
                <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>No se pudo cargar la lista de usuarios</p>
                <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{error}</p>
                <button
                  type="button"
                  onClick={onReintentar}
                  className="flit-focus mt-3 rounded-[10px] border px-4 py-2 text-sm font-semibold transition-opacity hover:opacity-80"
                  style={{ borderColor: 'var(--flit-border-soft)', color: 'var(--flit-text-secondary)' }}
                >
                  Reintentar
                </button>
              </td></tr>
            )}
            {!loading && !error && users.length === 0 && (
              <tr>
                <td colSpan={7} className="py-10 text-center" style={{ color: 'var(--flit-text-muted)' }}>
                  {vacioMensaje ?? 'Sin usuarios'}
                </td>
              </tr>
            )}
            {!loading && !error && users.map((u) => {
              const roleLabel = etiquetaRol(u.role, rolesCatalogo);
              const isMe = u.id === meId;
              const dadoDeBaja = u.deletedAt != null;
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
                  <AmbitoCelda
                    user={u}
                    tipoEnlace={tipoEnlaceDe(u.role, rolesCatalogo)}
                    nombreCompania={nombreCompania}
                    proveedores={proveedores}
                    organismos={organismos}
                  />
                  <td className="px-4 py-3">
                    {dadoDeBaja
                      ? <StatusChip tone="danger">Dado de baja</StatusChip>
                      : <StatusChip tone={u.active ? 'success' : 'danger'}>{u.active ? 'Activo' : 'Inactivo'}</StatusChip>}
                  </td>
                  <td className="space-x-1 px-4 py-3 text-right">
                    {dadoDeBaja ? (
                      <RowButton onClick={() => onReactivar(u)} tone="success">Reactivar</RowButton>
                    ) : (
                      <>
                        <RowButton onClick={() => onEditar(u)} tone="active">Editar</RowButton>
                        <RowButton onClick={() => onContrasena(u)} tone="neutral">Contraseña</RowButton>
                        <RowButton onClick={() => onAlternar(u)} disabled={isMe} tone={u.active ? 'danger' : 'success'}>
                          {u.active ? 'Desactivar' : 'Activar'}
                        </RowButton>
                        <RowButton onClick={() => onDarDeBaja(u)} disabled={isMe} tone="danger">
                          Dar de baja
                        </RowButton>
                      </>
                    )}
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
    <th className="px-4 py-3 text-left text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--flit-text-muted)' }}>
      {children}
    </th>
  );
}

function ThRight({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-3 text-right text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--flit-text-muted)' }}>
      {children}
    </th>
  );
}

function RowButton({ children, onClick, disabled, tone }: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone: 'active' | 'neutral' | 'danger' | 'success';
}) {
  const color =
    tone === 'danger' ? 'var(--flit-danger)'
      : tone === 'success' ? 'var(--flit-success)'
        : tone === 'active' ? 'var(--flit-blue)'
          : 'var(--flit-text-secondary)';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flit-focus rounded px-2 py-1 text-xs font-semibold transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
      style={{ color }}
    >
      {children}
    </button>
  );
}
