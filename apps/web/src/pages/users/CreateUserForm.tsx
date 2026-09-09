// FLITO — formulario de ALTA de usuario. Extraído de `pages/Users.tsx` sin cambios.
// HU #12175 / Feature #12072.
//
// **Esto NO es kit.** Props tipadas, sin estado global, un único consumidor: la página de usuarios.

import { useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { api } from '../../lib/api';
import FlitModal from '../../components/flit/FlitModal';
import type { PageSlug } from '../../lib/permissions';
import { ROLES, type User } from './types';
import { Field, Footer, formatErrors, inputCls, PASSWORD_PATTERN, PASSWORD_TITLE } from './UserFormShared';
import { COMPANIA_REQUERIDA, type CatalogoCompanias } from './CompaniaField';
import { AmbitoCampos } from './Ambito';
import PermissionsPicker from './PermissionsPicker';
import { ORGANISMOS_REQUERIDO, PROVEEDOR_REQUERIDO, type CatalogoOrganismos, type CatalogoProveedores } from './AtaduraFields';

export default function CreateForm({ companias, proveedores, organismos, onClose, onCreated }: {
  companias: CatalogoCompanias;
  proveedores: CatalogoProveedores;
  organismos: CatalogoOrganismos;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [f, setF] = useState<{
    username: string;
    name: string;
    email: string;
    password: string;
    role: User['role'];
    extraPages: PageSlug[];
    transitoCodigo: string;
    companiaId: string;
    flitoProveedorSoatId: string;
    organismosCodigos: string[];
  }>({
    username: '', name: '', email: '', password: '',
    role: 'proveedor',
    extraPages: [],
    transitoCodigo: '',
    companiaId: '',
    flitoProveedorSoatId: '',
    organismosCodigos: [],
  });
  const [submitting, setSubmitting] = useState(false);
  const [errorCompania, setErrorCompania] = useState<string | null>(null);
  const [errorProveedor, setErrorProveedor] = useState<string | null>(null);
  const [errorOrganismos, setErrorOrganismos] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    // AC2 en el cliente, y no solo en el servidor. Dos motivos medidos: el 400 del backend llega
    // como «companiaId: Compañía requerida para el rol Cliente» —`ApiError.toUserMessage()`
    // antepone el campo, igual que con `transitoCodigo`, y arreglarlo tocaría el formateador de
    // errores de todo el producto—, y sobre todo que aquí NO se manda la petición: un usuario a
    // medio crear no llega a existir.
    if (f.role === 'cliente' && !f.companiaId) { setErrorCompania(COMPANIA_REQUERIDA); return; }
    // AC3, con el mismo mecanismo y por los mismos dos motivos: el 400 del servidor llega como
    // «flitoProveedorSoatId: Proveedor SOAT requerido…» —`ApiError.toUserMessage()` antepone el
    // nombre del campo—, y aquí NO se manda la petición.
    if (f.role === 'proveedor' && !f.flitoProveedorSoatId) { setErrorProveedor(PROVEEDOR_REQUERIDO); return; }
    if (f.role === 'gestor_impuestos' && f.organismosCodigos.length === 0) { setErrorOrganismos(ORGANISMOS_REQUERIDO); return; }
    setErrorCompania(null); setErrorProveedor(null); setErrorOrganismos(null);
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = { username: f.username.trim(), name: f.name.trim(), password: f.password, role: f.role };
      if (f.email.trim()) body.email = f.email.trim();
      if (f.extraPages.length > 0) body.allowedPages = f.extraPages;
      if (f.role === 'transito') body.transitoCodigo = f.transitoCodigo;
      // Solo el rol Cliente la manda: el backend rechaza una compañía en cualquier otro rol.
      if (f.role === 'cliente') body.companiaId = Number(f.companiaId);
      // Cada ámbito lo manda SOLO su rol: el backend rechaza el campo en cualquier otro.
      if (f.role === 'proveedor') body.flitoProveedorSoatId = f.flitoProveedorSoatId;
      if (f.role === 'gestor_impuestos') body.organismosCodigos = f.organismosCodigos;
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
          {/* Cambiar de rol limpia los CUATRO ámbitos, y limpia también sus mensajes de rechazo.
              Sin esto, pasar de Cliente a Proveedor y guardar mandaría una compañía que el backend
              rechaza con un mensaje que no explica nada; y el error de un campo que ya no se pinta
              volvería a robar el foco al reaparecer. En el ALTA no se conservan borradores por rol:
              nada se ha guardado todavía, y un borrador invisible no lo pidió nadie. */}
          <select
            value={f.role}
            onChange={(e) => {
              setF({ ...f, role: e.target.value as User['role'], transitoCodigo: '', companiaId: '', flitoProveedorSoatId: '', organismosCodigos: [] });
              setErrorProveedor(null); setErrorOrganismos(null);
            }}
            className={inputCls}
          >
            {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <p className="mt-1 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>Define los permisos por defecto. Puede ampliar páginas adicionales abajo.</p>
        </Field>
        <AmbitoCampos
          role={f.role}
          companias={companias}
          proveedores={proveedores}
          organismos={organismos}
          valores={f}
          onValores={(p) => setF({ ...f, ...p })}
          errorCompania={errorCompania}
          setErrorCompania={setErrorCompania}
          errorProveedor={errorProveedor}
          setErrorProveedor={setErrorProveedor}
          errorOrganismos={errorOrganismos}
          setErrorOrganismos={setErrorOrganismos}
        />
        <PermissionsPicker role={f.role} extraPages={f.extraPages} onChange={(pages) => setF({ ...f, extraPages: pages })} />
        <Footer onClose={onClose} submitting={submitting} label="Crear usuario" />
      </form>
    </FlitModal>
  );
}
