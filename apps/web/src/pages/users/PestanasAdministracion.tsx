// FLITO — pestañas de enlace del módulo Administración (rediseño UI Kit 2026, Épica #14560, S6).
// En la propuesta `#usuarios` son dos pestañas de un mismo módulo; en FLITO son dos rutas
// (`/users`, `/roles-permisos`), así que aquí son enlaces. La de Roles solo se pinta si la ruta le
// abriría a quien entra (`hasPage(user, 'roles_permisos')`, la guarda de `App.tsx`).
import Pestanas from '../../components/flit/Pestanas';

export default function PestanasAdministracion({ verRoles }: { verRoles: boolean }) {
  const pestanas = [
    { id: 'usuarios', etiqueta: 'Usuarios', to: '/users' },
    ...(verRoles ? [{ id: 'roles', etiqueta: 'Roles y permisos', to: '/roles-permisos' }] : []),
  ];
  return <Pestanas etiqueta="Administración" activa="usuarios" pestanas={pestanas} />;
}
