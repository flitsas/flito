import { useEffect, useState, FormEvent, useCallback } from 'react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { getOrganismoByCodigo } from '@operaciones/shared-types';
import FlitOrganismoCombobox from '../components/flit/FlitOrganismoCombobox';
import { PAGES, PAGE_GROUPS, ROLE_DEFAULT_PAGES, ROLE_LABELS, USER_ROLES, isValidPage, PageSlug, UserRole } from '../lib/permissions';
import toast from 'react-hot-toast';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';

interface User {
  id: number;
  username: string;
  name: string;
  email: string | null;
  role: UserRole;
  active: boolean;
  allowedPages: string[];
  transitoCodigo?: string | null;
  createdAt: string;
}

// Lista de roles asignables: derivada de la fuente única (los 8 roles del sistema).
const ROLES: { value: UserRole; label: string }[] = USER_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }));

// Tono semántico FLIT por rol (sin cambiar la lógica de roles).
const ROLE_TONE: Record<UserRole, ChipTone> = {
  admin: 'active',
  compliance: 'warning',
  transito: 'active',
  proveedor: 'neutral',
  lider_pesv: 'success',
  supervisor_flota: 'success',
  conductor: 'neutral',
  auditor: 'warning',
  gestor_impuestos: 'neutral',
  mensajero: 'active',
};

const PASSWORD_PATTERN = '^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[!@#$%^&*]).{8,}$';
const PASSWORD_TITLE = 'Mín 8 caracteres con minúscula, mayúscula, número y un especial (!@#$%^&*)';
// Input FLIT: blanco, borde `--flit-border-input`, foco azul (.flit-focus bajo .flit-app).
const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';

const formatErrors = errorMessage;

export default function Users() {
  const { user: me } = useAuth();
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
                <Th>Organismo STT</Th>
                <Th>Estado</Th>
                <ThRight>Acciones</ThRight>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={7} className="py-10 text-center" style={{ color: 'var(--flit-text-muted)' }}>Cargando...</td></tr>}
              {!loading && users.length === 0 && <tr><td colSpan={7} className="py-10 text-center" style={{ color: 'var(--flit-text-muted)' }}>Sin usuarios</td></tr>}
              {!loading && users.map((u) => {
                const roleLabel = ROLES.find((r) => r.value === u.role)?.label ?? u.role;
                const isMe = u.id === me?.id;
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
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                      {u.role === 'transito' ? (
                        u.transitoCodigo ? (
                          (() => {
                            const org = getOrganismoByCodigo(u.transitoCodigo);
                            return org ? (
                              <span title={`${org.nombre} · ${org.codigo}`}>{org.ciudad}</span>
                            ) : (
                              <span className="font-mono">{u.transitoCodigo}</span>
                            );
                          })()
                        ) : (
                          <span style={{ color: 'var(--flit-warning)' }}>Sin asignar</span>
                        )
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <StatusChip tone={u.active ? 'success' : 'danger'}>{u.active ? 'Activo' : 'Inactivo'}</StatusChip>
                    </td>
                    <td className="space-x-1 px-4 py-3 text-right">
                      <RowButton onClick={() => setEditing(u)} tone="active">Editar</RowButton>
                      <RowButton onClick={() => setPwdTarget(u)} tone="neutral">Contraseña</RowButton>
                      <RowButton onClick={() => handleToggle(u)} disabled={isMe} tone={u.active ? 'danger' : 'success'}>
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

      {showCreate && <CreateForm onClose={() => setShowCreate(false)} onCreated={load} />}
      {editing && <EditForm user={editing} onClose={() => setEditing(null)} onSaved={load} />}
      {pwdTarget && <PasswordForm user={pwdTarget} isSelf={pwdTarget.id === me?.id} onClose={() => setPwdTarget(null)} onSaved={load} />}
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

function CreateForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [f, setF] = useState<{
    username: string;
    name: string;
    email: string;
    password: string;
    role: User['role'];
    extraPages: PageSlug[];
    transitoCodigo: string;
  }>({
    username: '', name: '', email: '', password: '',
    role: 'proveedor',
    extraPages: [],
    transitoCodigo: '',
  });
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = { username: f.username.trim(), name: f.name.trim(), password: f.password, role: f.role };
      if (f.email.trim()) body.email = f.email.trim();
      if (f.extraPages.length > 0) body.allowedPages = f.extraPages;
      if (f.role === 'transito') body.transitoCodigo = f.transitoCodigo;
      await api.post('/users', body);
      toast.success('Usuario creado');
      onCreated();
      onClose();
    } catch (err) { toast.error(formatErrors(err)); }
    finally { setSubmitting(false); }
  };

  return (
    <FlitModal title="Nuevo usuario" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Username (login)">
          <input required minLength={3} maxLength={50} pattern="[a-zA-Z0-9_]+" title="Solo letras, números y guion bajo"
            value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Nombre completo">
          <input required minLength={1} maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Email (opcional)">
          <input type="email" maxLength={150} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Contraseña">
          <input required type="password" minLength={8} pattern={PASSWORD_PATTERN} title={PASSWORD_TITLE}
            value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} className={inputCls} />
          <p className="mt-1 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>{PASSWORD_TITLE}</p>
        </Field>
        <Field label="Rol base">
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as User['role'], transitoCodigo: '' })} className={inputCls}>
            {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <p className="mt-1 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>Define los permisos por defecto. Puede ampliar páginas adicionales abajo.</p>
        </Field>
        {f.role === 'transito' && (
          <TransitoOrganismoField value={f.transitoCodigo} onChange={(v) => setF({ ...f, transitoCodigo: v })} required />
        )}
        <PermissionsPicker role={f.role} extraPages={f.extraPages} onChange={(pages) => setF({ ...f, extraPages: pages })} />
        <Footer onClose={onClose} submitting={submitting} label="Crear usuario" />
      </form>
    </FlitModal>
  );
}

function EditForm({ user, onClose, onSaved }: { user: User; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: user.name,
    email: user.email ?? '',
    role: user.role,
    extraPages: (user.allowedPages ?? []).filter(isValidPage),
    transitoCodigo: user.transitoCodigo ?? '',
  });
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {};
      if (f.name.trim() !== user.name) body.name = f.name.trim();
      if ((f.email.trim() || null) !== user.email) body.email = f.email.trim() || null;
      if (f.role !== user.role) body.role = f.role;
      // Comparar solo slugs VÁLIDOS del catálogo único en ambos lados: así editar
      // (sin tocar permisos) nunca recorta páginas que el formulario sí conoce, y
      // un slug inválido/heredado no provoca un diff fantasma que lo borre.
      const currentExtra = (user.allowedPages ?? []).filter(isValidPage).slice().sort();
      const nextExtra = f.extraPages.slice().sort();
      if (JSON.stringify(currentExtra) !== JSON.stringify(nextExtra)) body.allowedPages = f.extraPages;
      if (f.role === 'transito' && f.transitoCodigo !== (user.transitoCodigo ?? '')) body.transitoCodigo = f.transitoCodigo;
      if (f.role !== 'transito' && user.transitoCodigo) body.transitoCodigo = null;
      if (Object.keys(body).length === 0) { toast('Sin cambios'); setSubmitting(false); return; }
      const organismoChanged = f.role === 'transito' && f.transitoCodigo !== (user.transitoCodigo ?? '');
      await api.patch(`/users/${user.id}`, body);
      toast.success('Usuario actualizado');
      if (organismoChanged) {
        toast('El usuario debe volver a iniciar sesión para aplicar el nuevo organismo.', { duration: 6000 });
      }
      onSaved();
      onClose();
    } catch (err) { toast.error(formatErrors(err)); }
    finally { setSubmitting(false); }
  };

  return (
    <FlitModal title={`Editar ${user.username}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Nombre completo">
          <input required minLength={1} maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Email">
          <input type="email" maxLength={150} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Rol base">
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as User['role'], transitoCodigo: e.target.value === 'transito' ? f.transitoCodigo : '' })} className={inputCls}>
            {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </Field>
        {f.role === 'transito' && (
          <TransitoOrganismoField value={f.transitoCodigo} onChange={(v) => setF({ ...f, transitoCodigo: v })} required />
        )}
        <PermissionsPicker role={f.role} extraPages={f.extraPages} onChange={(pages) => setF({ ...f, extraPages: pages })} />
        <Footer onClose={onClose} submitting={submitting} label="Guardar cambios" />
      </form>
    </FlitModal>
  );
}

function TransitoOrganismoField({ value, onChange, required }: { value: string; onChange: (v: string) => void; required?: boolean }) {
  return (
    <Field label="Organismo de tránsito">
      <FlitOrganismoCombobox value={value} onChange={onChange} required={required} />
      <p className="mt-1 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>
        Define qué bandeja verá este usuario (aislamiento Medellín ≠ Envigado).
      </p>
    </Field>
  );
}

function PermissionsPicker({ role, extraPages, onChange }: { role: User['role']; extraPages: PageSlug[]; onChange: (pages: PageSlug[]) => void }) {
  const rolePages = new Set<PageSlug>(ROLE_DEFAULT_PAGES[role] ?? []);
  const extraSet = new Set<PageSlug>(extraPages);

  if (role === 'admin') {
    return (
      <div className="rounded-xl p-3" style={{ border: '1px solid rgba(79,116,201,0.35)', background: 'rgba(79,116,201,0.10)' }}>
        <p className="text-xs font-semibold" style={{ color: 'var(--flit-blue)' }}>Acceso total</p>
        <p className="text-[10px]" style={{ color: 'var(--flit-blue)', opacity: 0.85 }}>El rol Administrador tiene acceso a todas las páginas. No requiere permisos individuales.</p>
      </div>
    );
  }

  const toggle = (slug: PageSlug) => {
    if (rolePages.has(slug)) return;
    const next = new Set(extraSet);
    if (next.has(slug)) next.delete(slug); else next.add(slug);
    onChange(Array.from(next));
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Permisos individuales</span>
        {extraPages.length > 0 && (
          <button type="button" onClick={() => onChange([])} className="text-[10px] hover:underline" style={{ color: 'var(--flit-blue)' }}>Quitar adicionales</button>
        )}
      </div>
      <div className="max-h-60 space-y-3 overflow-y-auto rounded-xl bg-white p-3" style={{ border: '1px solid var(--flit-border-soft)' }}>
        {PAGE_GROUPS.map((g) => (
          <div key={g.label}>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--flit-text-muted)' }}>{g.label}</p>
            <div className="grid grid-cols-2 gap-1">
              {g.pages.map((p) => {
                const fromRole = rolePages.has(p);
                const isChecked = fromRole || extraSet.has(p);
                const style = fromRole
                  ? { color: 'var(--flit-success)', background: 'rgba(112,207,58,0.14)', cursor: 'default' as const }
                  : isChecked
                    ? { color: 'var(--flit-blue)', background: 'rgba(79,116,201,0.12)' }
                    : { color: 'var(--flit-text-secondary)' };
                return (
                  <label key={p} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-xs hover:bg-[color:var(--flit-bg-app)]" style={style}>
                    <input type="checkbox" checked={isChecked} disabled={fromRole}
                      onChange={() => toggle(p)} className="rounded" style={{ accentColor: 'var(--flit-blue)' }} />
                    <span className="flex-1">{PAGES[p]}</span>
                    {fromRole && <span className="text-[9px] font-bold" style={{ color: 'var(--flit-success)' }}>ROL</span>}
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-1 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>
        Las páginas marcadas como "ROL" vienen incluidas con el rol base. Marca adicionales para ampliar el acceso.
      </p>
    </div>
  );
}

function PasswordForm({ user, isSelf, onClose, onSaved }: { user: User; isSelf: boolean; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (f.newPassword !== f.confirmPassword) { toast.error('Las contraseñas no coinciden'); return; }
    setSubmitting(true);
    try {
      const body: Record<string, string> = { newPassword: f.newPassword };
      if (isSelf) body.currentPassword = f.currentPassword;
      else body.currentPassword = 'admin-override';
      await api.patch(`/users/${user.id}/password`, body);
      toast.success('Contraseña actualizada');
      onSaved();
      onClose();
    } catch (err) { toast.error(formatErrors(err)); }
    finally { setSubmitting(false); }
  };

  return (
    <FlitModal title={`Contraseña — ${user.username}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {isSelf && (
          <Field label="Contraseña actual">
            <input required type="password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} className={inputCls} />
          </Field>
        )}
        {!isSelf && (
          <p className="rounded-xl p-3 text-xs" style={{ color: 'var(--flit-warning)', background: 'rgba(240,90,53,0.10)', border: '1px solid rgba(240,90,53,0.30)' }}>
            Como administrador, está restableciendo la contraseña de otro usuario. Quedará registrado en auditoría.
          </p>
        )}
        <Field label="Contraseña nueva">
          <input required type="password" minLength={8} pattern={PASSWORD_PATTERN} title={PASSWORD_TITLE}
            value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} className={inputCls} />
          <p className="mt-1 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>{PASSWORD_TITLE}</p>
        </Field>
        <Field label="Confirmar nueva">
          <input required type="password" minLength={8} value={f.confirmPassword} onChange={(e) => setF({ ...f, confirmPassword: e.target.value })} className={inputCls} />
        </Field>
        <Footer onClose={onClose} submitting={submitting} label="Cambiar contraseña" />
      </form>
    </FlitModal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{label}</span>
      {children}
    </label>
  );
}

function Footer({ onClose, submitting, label }: { onClose: () => void; submitting: boolean; label: string }) {
  return (
    <div className="mt-5 flex justify-end gap-2 border-t pt-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <button
        type="button"
        onClick={onClose}
        className="flit-focus inline-flex h-11 items-center rounded-[999px] border bg-white px-5 text-sm font-medium transition-colors"
        style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}
      >
        Cancelar
      </button>
      <GradientButton type="submit" disabled={submitting}>
        {submitting ? 'Guardando...' : label}
      </GradientButton>
    </div>
  );
}
