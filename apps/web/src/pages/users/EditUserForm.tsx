// FLITO — formulario de EDICIÓN de usuario. Extraído de `pages/Users.tsx` sin cambios.
// HU #12175 / Feature #12072. HU #12087: `funciones` + modal de cambio de rol.
// HU #12088: ámbito por `tipoEnlace`; body sin `transitoCodigo`; organismos vía `organismosCodigos`.

import { useCallback, useMemo, useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import type { FuncionDeUsuario } from '@operaciones/shared-types';
import { api } from '../../lib/api';
import FlitModal from '../../components/flit/FlitModal';
import { tipoEnlaceDe, type RolOpcion, type User } from './types';
import { Field, Footer, formatErrors, inputCls } from './UserFormShared';
import { COMPANIA_REQUERIDA, COMPANIA_RELOGIN, type CatalogoCompanias } from './CompaniaField';
import { AmbitoCampos } from './Ambito';
import PermissionsPicker, { type CatalogoFuncionesEstado } from './PermissionsPicker';
import CambioRolExcepciones from './CambioRolExcepciones';
import {
  ORGANISMOS_RELOGIN, ORGANISMOS_REQUERIDO, PROVEEDOR_RELOGIN, PROVEEDOR_REQUERIDO,
  type CatalogoOrganismos, type CatalogoProveedores,
} from './AtaduraFields';

export const FUNCIONES_RELOGIN = 'El usuario debe volver a iniciar sesión para aplicar los nuevos permisos.';

/** Predicado espejo del servidor: retirar un `conceder` o añadir un `revocar` invalida sesión. */
export function retiraAcceso(antes: FuncionDeUsuario[], despues: FuncionDeUsuario[]): boolean {
  const prev = new Map(antes.map((f) => [f.codigo, f.efecto]));
  const next = new Map(despues.map((f) => [f.codigo, f.efecto]));
  for (const [codigo, efecto] of next) {
    if (efecto === 'revocar' && prev.get(codigo) !== 'revocar') return true;
  }
  for (const [codigo, efecto] of prev) {
    if (efecto === 'conceder' && next.get(codigo) !== 'conceder') return true;
  }
  return false;
}

function claveFunciones(lista: FuncionDeUsuario[]): string {
  return [...lista].map((f) => `${f.efecto}:${f.codigo}`).sort().join('|');
}

export default function EditForm({ user, companias, proveedores, organismos, catalogo, rolesCatalogo, onClose, onSaved }: {
  user: User;
  companias: CatalogoCompanias;
  proveedores: CatalogoProveedores;
  organismos: CatalogoOrganismos;
  catalogo: CatalogoFuncionesEstado;
  rolesCatalogo: RolOpcion[] | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState({
    name: user.name,
    email: user.email ?? '',
    role: user.role,
    excepciones: user.funciones ?? [],
    companiaId: user.companiaId ? String(user.companiaId) : '',
    flitoProveedorSoatId: user.flitoProveedorSoatId ?? '',
    organismosCodigos: user.organismosCodigos,
  });
  const [submitting, setSubmitting] = useState(false);
  const [funcionesOk, setFuncionesOk] = useState(false);
  const [pendienteRol, setPendienteRol] = useState(false);
  const [errorCompania, setErrorCompania] = useState<string | null>(null);
  const [errorProveedor, setErrorProveedor] = useState<string | null>(null);
  const [errorOrganismos, setErrorOrganismos] = useState<string | null>(null);

  const enlace = tipoEnlaceDe(f.role, rolesCatalogo);
  const enlaceUsuario = tipoEnlaceDe(user.role, rolesCatalogo);

  /** Activos + el rol actual si quedó inactivo (no perderlo al abrir el select). */
  const opcionesRol = useMemo(() => {
    const activos = (rolesCatalogo ?? []).filter((r) => r.activo);
    if (!rolesCatalogo) return [];
    const actual = rolesCatalogo.find((r) => r.value === user.role);
    if (actual && !actual.activo && !activos.some((r) => r.value === actual.value)) {
      return [...activos, { ...actual, label: `${actual.label} (inactivo)` }];
    }
    return activos;
  }, [rolesCatalogo, user.role]);

  const nombres = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of catalogo.grupos ?? []) {
      for (const fn of g.funciones) m.set(fn.codigo, fn.nombreNegocio);
    }
    return m;
  }, [catalogo.grupos]);

  const onDisponible = useCallback((ok: boolean) => setFuncionesOk(ok), []);

  const enviar = async (funcionesDestino: FuncionDeUsuario[] | null) => {
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {};
      if (f.name.trim() !== user.name) body.name = f.name.trim();
      if ((f.email.trim() || null) !== user.email) body.email = f.email.trim() || null;
      if (f.role !== user.role) body.role = f.role;

      const prevFunc = user.funciones ?? [];
      const nextFunc = funcionesDestino ?? f.excepciones;
      if (funcionesOk) {
        // Con `role` en el body, `funciones` viaja siempre (§4-3).
        if (body.role !== undefined || claveFunciones(prevFunc) !== claveFunciones(nextFunc)) {
          body.funciones = nextFunc;
        }
      }

      const companiaPrevia = user.companiaId ? String(user.companiaId) : '';
      const companiaChanged = enlace === 'compania' && f.companiaId !== companiaPrevia;
      if (companiaChanged) body.companiaId = Number(f.companiaId);
      if (enlace !== 'compania' && user.companiaId) body.companiaId = null;

      const proveedorPrevio = user.flitoProveedorSoatId ?? '';
      const proveedorChanged = enlace === 'proveedor_soat' && f.flitoProveedorSoatId !== proveedorPrevio;
      if (proveedorChanged) body.flitoProveedorSoatId = f.flitoProveedorSoatId;
      if (enlace !== 'proveedor_soat' && user.flitoProveedorSoatId) body.flitoProveedorSoatId = null;

      const organismosChanged = enlace === 'organismos_transito' && !mismoConjunto(f.organismosCodigos, user.organismosCodigos);
      if (organismosChanged) body.organismosCodigos = f.organismosCodigos;
      if (enlace !== 'organismos_transito' && (user.organismosCodigos.length > 0 || enlaceUsuario === 'organismos_transito')) {
        body.organismosCodigos = [];
      }

      if (Object.keys(body).length === 0) { toast('Sin cambios'); setSubmitting(false); return; }
      await api.patch(`/users/${user.id}`, body);
      toast.success('Usuario actualizado');
      if (companiaChanged) toast(COMPANIA_RELOGIN, { duration: 6000 });
      if (proveedorChanged) toast(PROVEEDOR_RELOGIN, { duration: 6000 });
      if (organismosChanged) toast(ORGANISMOS_RELOGIN, { duration: 6000 });
      if (Array.isArray(body.funciones) && retiraAcceso(prevFunc, body.funciones as FuncionDeUsuario[])) {
        toast(FUNCIONES_RELOGIN, { duration: 6000 });
      }
      onSaved();
      onClose();
    } catch (err) { toast.error(formatErrors(err)); }
    finally { setSubmitting(false); setPendienteRol(false); }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (enlace === 'compania' && !f.companiaId) { setErrorCompania(COMPANIA_REQUERIDA); return; }
    if (enlace === 'proveedor_soat' && !f.flitoProveedorSoatId) { setErrorProveedor(PROVEEDOR_REQUERIDO); return; }
    if (enlace === 'organismos_transito' && f.organismosCodigos.length === 0) { setErrorOrganismos(ORGANISMOS_REQUERIDO); return; }
    setErrorCompania(null); setErrorProveedor(null); setErrorOrganismos(null);

    // Modal solo al Guardar si cambió el rol Y hay excepciones en edición (§4-3).
    if (f.role !== user.role && f.excepciones.length > 0 && funcionesOk) {
      setPendienteRol(true);
      return;
    }
    await enviar(null);
  };

  return (
    <>
      <FlitModal title={`Editar ${user.username}`} onClose={onClose}>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Nombre completo">
            <input required minLength={1} maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={inputCls} />
          </Field>
          <Field label="Email">
            <input type="email" maxLength={150} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} className={inputCls} />
          </Field>
          <Field label="Rol base">
            <select
              value={f.role}
              disabled={!rolesCatalogo}
              onChange={(e) => {
                const nuevo = e.target.value;
                const nuevoEnlace = tipoEnlaceDe(nuevo, rolesCatalogo);
                setF({
                  ...f,
                  role: nuevo,
                  // Limpiar ataduras que ya no aplican; conservar las del mismo tipo de enlace.
                  companiaId: nuevoEnlace === 'compania' ? f.companiaId : '',
                  flitoProveedorSoatId: nuevoEnlace === 'proveedor_soat' ? f.flitoProveedorSoatId : '',
                  organismosCodigos: nuevoEnlace === 'organismos_transito'
                    ? (enlaceUsuario === 'organismos_transito' ? user.organismosCodigos : [])
                    : [],
                });
                setErrorCompania(null); setErrorProveedor(null); setErrorOrganismos(null);
              }}
              className={inputCls}
            >
              {!rolesCatalogo && <option value={f.role}>Cargando roles…</option>}
              {opcionesRol.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </Field>
          <AmbitoCampos
            tipoEnlace={enlace}
            editando
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
          <Footer onClose={onClose} submitting={submitting} label="Guardar cambios" />
        </form>
      </FlitModal>
      {pendienteRol && (
        <CambioRolExcepciones
          excepciones={f.excepciones}
          rolNuevo={f.role}
          nombres={nombres}
          onCancelar={() => setPendienteRol(false)}
          onConfirmar={(conservadas) => {
            setF((prev) => ({ ...prev, excepciones: conservadas }));
            void enviar(conservadas);
          }}
        />
      )}
    </>
  );
}

/** Igualdad de conjuntos: el ORDEN de los códigos no es un cambio de ámbito. */
function mismoConjunto(a: string[], b: string[]) {
  return a.length === b.length && a.every((c) => b.includes(c));
}
