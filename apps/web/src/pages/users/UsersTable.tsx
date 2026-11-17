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
import DataTable, { type ColumnaTabla } from '../../components/flit/DataTable';
import GradientButton from '../../components/flit/GradientButton';
import { EstadoVista } from '../../components/flit/Cargador';
import { Icono } from '../../components/flit/kit/Icono';
import { etiquetaRol, ROLE_TONE, tipoEnlaceDe, type RolOpcion, type User } from './types';
import { AmbitoCelda } from './Ambito';
import type { CatalogoOrganismos } from './AtaduraFields';

export default function UsersTable({ users, loading, error, onReintentar, vacioMensaje, meId, rolesCatalogo, nombreCompania, organismos, onEditar, onContrasena, onAlternar, onDarDeBaja, onReactivar }: {
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
  organismos: CatalogoOrganismos;
  onEditar: (u: User) => void;
  onContrasena: (u: User) => void;
  /** Toggle `active` (suspensión). No es baja lógica. */
  onAlternar: (u: User) => void;
  onDarDeBaja: (u: User) => void;
  onReactivar: (u: User) => void;
}) {
  // Rediseño 2026 (molde `#usuarios`): `DataTable` del kit — tarjetas ≤900 px, cabecera del kit, hover de fila.
  // El ERROR va ANTES del vacío y lo excluye: una carga fallida deja `users` en `[]`, así que sin esta
  // rama el fallo se leería como «Sin usuarios» —un dato falso— y el usuario se quedaría sin nada que
  // pulsar. Antes de la HU #12172 ese caso solo salía por `toast.error`, que se va solo. Se pinta
  // aparte (no con el `errorMessage` de `DataTable`) porque lleva título Y el detalle del servidor.
  if (!loading && error) {
    return (
      <div className="tabla-wrap" data-kit="tabla" data-testid="ui-error">
        <div className="kit-vacio" role="alert" data-kit="error">
          <span className="kit-disco h-[72px] w-[72px] !text-[color:var(--kit-naranja)]"><Icono nombre="nube-alerta" size={36} /></span>
          <p className="!text-[color:var(--color-text-primary)]">No se pudo cargar la lista de usuarios</p>
          <small>{error}</small>
          <GradientButton type="button" variant="secondary" size="sm" onClick={onReintentar}>
            <Icono nombre="reintento" size={16} />
            Reintentar
          </GradientButton>
        </div>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="tabla-wrap" data-kit="tabla">
        <EstadoVista status="loading" cargando="Cargando..." />
      </div>
    );
  }

  const columnas: ColumnaTabla<User>[] = [
    {
      key: 'usuario', header: 'Usuario',
      render: (u) => (
        <span className="text-xs font-semibold" style={{ color: 'var(--color-text-primary)' }}>
          {u.username}
          {u.id === meId && <span className="ml-1.5 text-[11px] font-bold text-[color:var(--color-action)]">(tú)</span>}
        </span>
      ),
    },
    { key: 'nombre', header: 'Nombre', render: (u) => <span style={{ color: 'var(--color-text-primary)' }}>{u.name}</span> },
    { key: 'email', header: 'Email', render: (u) => <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>{u.email || '—'}</span> },
    {
      key: 'rol', header: 'Rol',
      render: (u) => <StatusChip tone={ROLE_TONE[u.role] ?? 'neutral'}>{etiquetaRol(u.role, rolesCatalogo)}</StatusChip>,
    },
    // Se RENOMBRA en vez de añadir columnas: la celda ya ramificaba por rol para decir «a qué ámbito
    // está atado este usuario», y las tres columnas de la disposición B nacerían vacías para 9 de los
    // 12 roles. Siguen siendo SIETE. «Ámbito» se lee en pareja con «Rol», que tiene justo a la
    // izquierda: el rol dice de qué tipo es el ámbito y esta celda dice cuál.
    {
      key: 'ambito', header: 'Ámbito',
      render: (u) => (
        <AmbitoCelda
          user={u}
          tipoEnlace={tipoEnlaceDe(u.role, rolesCatalogo)}
          nombreCompania={nombreCompania}
          organismos={organismos}
        />
      ),
    },
    {
      key: 'estado', header: 'Estado',
      render: (u) => (u.deletedAt != null
        ? <StatusChip tone="danger">Dado de baja</StatusChip>
        : <StatusChip tone={u.active ? 'success' : 'danger'}>{u.active ? 'Activo' : 'Inactivo'}</StatusChip>),
    },
    {
      key: 'acciones', header: 'Acciones', align: 'right', acciones: true,
      render: (u) => {
        const isMe = u.id === meId;
        // Por función (kit): editar/contraseña navegan (ghost), activar/reactivar confirman (verde),
        // desactivar y dar de baja son destructivos (naranja).
        return (
          <div className="flex flex-wrap justify-end gap-1.5 lg:min-w-[18rem]">
            {u.deletedAt != null ? (
              <GradientButton type="button" size="sm" variant="success" onClick={() => onReactivar(u)}>Reactivar</GradientButton>
            ) : (
              <>
                <GradientButton type="button" size="sm" variant="ghost" onClick={() => onEditar(u)}>Editar</GradientButton>
                <GradientButton type="button" size="sm" variant="ghost" onClick={() => onContrasena(u)}>Contraseña</GradientButton>
                <GradientButton type="button" size="sm" variant={u.active ? 'alerta' : 'success'} onClick={() => onAlternar(u)} disabled={isMe}>
                  {u.active ? 'Desactivar' : 'Activar'}
                </GradientButton>
                <GradientButton type="button" size="sm" variant="alerta" onClick={() => onDarDeBaja(u)} disabled={isMe}>
                  Dar de baja
                </GradientButton>
              </>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <DataTable
      ariaLabel="Lista de usuarios"
      columnas={columnas}
      filas={users}
      getKey={(u) => String(u.id)}
      emptyMessage={vacioMensaje ?? 'Sin usuarios'}
    />
  );
}
