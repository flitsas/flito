// FLITO — formulario de ALTA de usuario. Extraído de `pages/Users.tsx` sin cambios.
// HU #12175 / Feature #12072. HU #12087: `funciones`; cambiar de rol vacía excepciones (sin modal).
// HU #12088: ámbito por `tipoEnlace`; body sin `transitoCodigo`; organismos vía `organismosCodigos`.

import { useCallback, useMemo, useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import type { FuncionDeUsuario } from '@operaciones/shared-types';
import { api } from '../../lib/api';
import FlitModal from '../../components/flit/FlitModal';
import { tipoEnlaceDe, type RolOpcion } from './types';
import { Field, Footer, formatErrors, inputCls, PASSWORD_PATTERN, PASSWORD_TITLE } from './UserFormShared';
import { COMPANIA_REQUERIDA, type CatalogoCompanias } from './CompaniaField';
import { AmbitoCampos } from './Ambito';
import PermissionsPicker, { type CatalogoFuncionesEstado } from './PermissionsPicker';
import { ORGANISMOS_REQUERIDO, PROVEEDOR_REQUERIDO, type CatalogoOrganismos, type CatalogoProveedores } from './AtaduraFields';

export default function CreateForm({ companias, proveedores, organismos, catalogo, rolesCatalogo, onClose, onCreated }: {
  companias: CatalogoCompanias;
  proveedores: CatalogoProveedores;
  organismos: CatalogoOrganismos;
  catalogo: CatalogoFuncionesEstado;
  /** Catálogo completo (mapa tipoEnlace); el select solo lista activos. */
  rolesCatalogo: RolOpcion[] | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const rolesActivos = useMemo(
    () => (rolesCatalogo ?? []).filter((r) => r.activo),
    [rolesCatalogo],
  );
  const rolInicial = rolesActivos.find((r) => r.value === 'proveedor')?.value
    ?? rolesActivos[0]?.value
    ?? 'proveedor';

  const [f, setF] = useState<{
    username: string;
    name: string;
    email: string;
    password: string;
    role: string;
    excepciones: FuncionDeUsuario[];
    companiaId: string;
    flitoProveedorSoatId: string;
    organismosCodigos: string[];
  }>({
    username: '', name: '', email: '', password: '',
    role: rolInicial,
    excepciones: [],
    companiaId: '',
    flitoProveedorSoatId: '',
    organismosCodigos: [],
  });
  const [submitting, setSubmitting] = useState(false);
  const [funcionesOk, setFuncionesOk] = useState(false);
  const [errorCompania, setErrorCompania] = useState<string | null>(null);
  const [errorProveedor, setErrorProveedor] = useState<string | null>(null);
  const [errorOrganismos, setErrorOrganismos] = useState<string | null>(null);

  const enlace = tipoEnlaceDe(f.role, rolesCatalogo);
  const onDisponible = useCallback((ok: boolean) => setFuncionesOk(ok), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (enlace === 'compania' && !f.companiaId) { setErrorCompania(COMPANIA_REQUERIDA); return; }
    if (enlace === 'proveedor_soat' && !f.flitoProveedorSoatId) { setErrorProveedor(PROVEEDOR_REQUERIDO); return; }
    if (enlace === 'organismos_transito' && f.organismosCodigos.length === 0) { setErrorOrganismos(ORGANISMOS_REQUERIDO); return; }
    setErrorCompania(null); setErrorProveedor(null); setErrorOrganismos(null);
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = { username: f.username.trim(), name: f.name.trim(), password: f.password, role: f.role };
      if (f.email.trim()) body.email = f.email.trim();
      if (funcionesOk && f.excepciones.length > 0) body.funciones = f.excepciones;
      if (enlace === 'compania') body.companiaId = Number(f.companiaId);
      if (enlace === 'proveedor_soat') body.flitoProveedorSoatId = f.flitoProveedorSoatId;
      if (enlace === 'organismos_transito') body.organismosCodigos = f.organismosCodigos;
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
          {/* En el alta, cambiar de rol vacía las excepciones: no hay nada guardado que arrastrar. */}
          <select
            value={f.role}
            disabled={!rolesCatalogo}
            onChange={(e) => {
              setF({
                ...f,
                role: e.target.value,
                excepciones: [],
                companiaId: '',
                flitoProveedorSoatId: '',
                organismosCodigos: [],
              });
              setErrorCompania(null); setErrorProveedor(null); setErrorOrganismos(null);
            }}
            className={inputCls}
          >
            {!rolesCatalogo && <option value={f.role}>Cargando roles…</option>}
            {rolesActivos.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <p className="mt-1 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>Define los permisos por defecto. Puede ampliar o quitar funciones abajo.</p>
        </Field>
        <AmbitoCampos
          tipoEnlace={enlace}
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
        <PermissionsPicker
          role={f.role}
          catalogo={catalogo}
          excepciones={f.excepciones}
          onChange={(exc) => setF({ ...f, excepciones: exc })}
          onDisponibleChange={onDisponible}
        />
        <Footer onClose={onClose} submitting={submitting} label="Crear usuario" />
      </form>
    </FlitModal>
  );
}
