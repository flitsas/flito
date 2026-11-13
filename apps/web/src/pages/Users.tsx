// FLITO — Gestión de usuarios. La PÁGINA es un conmutador: decide, por quién entra, qué monta.
//
// - Quien puede gestionar (hoy `admin`) ve `pages/users/UsersGestion.tsx`: cabecera con «Nuevo
//   usuario», pestañas [Usuarios] [Historial], la lista, sus modales y el historial.
// - El auditor (HU #12171, Feature #12072) entra por `pagina.users` y ve SOLO el historial: sin
//   pestañas, sin primaria, sin listado. Y sin montar los hooks de la gestión: `useCompanias`,
//   `useProveedoresAsignables`, `useOrganismosParametrizados` y la carga de `/users` le responderían
//   403, y un 403 en un `useEffect` es un error que nadie ve. Por eso lo de admin bajó a un
//   componente aparte —los hooks no pueden ser condicionales— y esta página quedó en lo que se ve.
//
// La tabla, los tres formularios, el selector de permisos y el ámbito viven en `pages/users/`
// (HU #12175). El archivo llegó a 680 líneas efectivas contra el techo `max-lines: 800`.

import { useAuth } from '../lib/auth';
import { hasPage } from '../lib/permissions';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import UsersGestion from './users/UsersGestion';
import HistorialPermisos from './users/HistorialPermisos';
import PestanasAdministracion from './users/PestanasAdministracion';
import { MIGA_USUARIOS } from './users/types';

export default function Users() {
  const { hasFuncion, user } = useAuth();

  /**
   * Quién gestiona y quién exporta. Las condiciones están AQUÍ, con nombre y una sola definición,
   * en vez de incrustadas en el JSX: la HU #12170 las sustituye por la función de permiso
   * (`/api/permisos/mios`) y tiene que poder cambiar una línea. HU #12872: son ya las funciones de
   * las guardas (`POST /users` y `GET /users/export`), nunca el nombre del rol.
   */
  const puedeGestionar = hasFuncion('usuarios.usuario.crear');
  const puedeExportar = hasFuncion('usuarios.usuario.exportar');

  /** Rediseño 2026: la pestaña «Roles y permisos» solo si esa ruta le abriría (misma guarda que `App.tsx`). */
  const verRoles = Boolean(user && hasPage(user, 'roles_permisos'));

  if (puedeGestionar) return <UsersGestion puedeExportar={puedeExportar} verRoles={verRoles} />;

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Usuarios"
        subtitle="Historial de cambios en usuarios, roles y permisos"
        icono="flito-usuarios"
        miga={MIGA_USUARIOS}
      />
      <PestanasAdministracion verRoles={verRoles} />
      <HistorialPermisos />
    </div>
  );
}
