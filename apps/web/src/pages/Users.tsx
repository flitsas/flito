// FLITO — Gestión de usuarios. La PÁGINA: carga la lista, monta los catálogos que se piden una vez
// por pantalla y decide qué modal está abierto. Nada más.
//
// La tabla, los tres formularios, el selector de permisos y el ámbito viven en `pages/users/`
// (HU #12175 / Feature #12072). Se partió porque el archivo llegó a 680 líneas efectivas contra el
// techo `max-lines: 800` de `eslint.config.mjs`, con cuatro historias en cola escribiendo encima.

import { useEffect, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import { useOrganismosParametrizados, useProveedoresSoat } from './users/AtaduraFields';
import { useCompanias } from './users/CompaniaField';
import { formatErrors } from './users/UserFormShared';
import type { User } from './users/types';
import UsersTable from './users/UsersTable';
import CreateForm from './users/CreateUserForm';
import EditForm from './users/EditUserForm';
import PasswordForm from './users/PasswordForm';

export default function Users() {
  const { user: me } = useAuth();
  const companias = useCompanias();
  const proveedores = useProveedoresSoat();
  const organismos = useOrganismosParametrizados();
  const nombreCompania = (id: number) => companias.data?.find((c) => c.id === id)?.nombre ?? null;
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [pwdTarget, setPwdTarget] = useState<User | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.get<User[]>('/users');
      setUsers(rows);
    } catch (e) { toast.error(formatErrors(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleToggle = async (u: User) => {
    if (u.id === me?.id) { toast.error('No puede desactivarse a sí mismo'); return; }
    if (!confirm(`${u.active ? 'Desactivar' : 'Activar'} a ${u.name}?`)) return;
    try {
      await api.patch(`/users/${u.id}/toggle`);
      toast.success('Estado actualizado');
      load();
    } catch (e) { toast.error(formatErrors(e)); }
  };

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Gestión de usuarios"
        subtitle="Equipo y accesos del sistema"
        actions={
          <GradientButton type="button" onClick={() => setShowCreate(true)}>
            Nuevo usuario
          </GradientButton>
        }
      />

      <UsersTable
        users={users}
        loading={loading}
        meId={me?.id}
        nombreCompania={nombreCompania}
        proveedores={proveedores}
        organismos={organismos}
        onEditar={setEditing}
        onContrasena={setPwdTarget}
        onAlternar={handleToggle}
      />

      {showCreate && <CreateForm companias={companias} proveedores={proveedores} organismos={organismos} onClose={() => setShowCreate(false)} onCreated={load} />}
      {editing && <EditForm user={editing} companias={companias} proveedores={proveedores} organismos={organismos} onClose={() => setEditing(null)} onSaved={load} />}
      {pwdTarget && <PasswordForm user={pwdTarget} isSelf={pwdTarget.id === me?.id} onClose={() => setPwdTarget(null)} onSaved={load} />}
    </div>
  );
}
