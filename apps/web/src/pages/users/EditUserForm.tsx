// FLITO — formulario de EDICIÓN de usuario. Extraído de `pages/Users.tsx` sin cambios.
// HU #12175 / Feature #12072.
//
// **Esto NO es kit.** Props tipadas, sin estado global, un único consumidor: la página de usuarios.

import { useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { api } from '../../lib/api';
import FlitModal from '../../components/flit/FlitModal';
import { isValidPage } from '../../lib/permissions';
import { ROLES, type User } from './types';
import { Field, Footer, formatErrors, inputCls } from './UserFormShared';
import { COMPANIA_REQUERIDA, COMPANIA_RELOGIN, type CatalogoCompanias } from './CompaniaField';
import { AmbitoCampos } from './Ambito';
import PermissionsPicker from './PermissionsPicker';
import {
  ORGANISMOS_RELOGIN, ORGANISMOS_REQUERIDO, PROVEEDOR_RELOGIN, PROVEEDOR_REQUERIDO,
  type CatalogoOrganismos, type CatalogoProveedores,
} from './AtaduraFields';

export default function EditForm({ user, companias, proveedores, organismos, onClose, onSaved }: {
  user: User;
  companias: CatalogoCompanias;
  proveedores: CatalogoProveedores;
  organismos: CatalogoOrganismos;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState({
    name: user.name,
    email: user.email ?? '',
    role: user.role,
    extraPages: (user.allowedPages ?? []).filter(isValidPage),
    transitoCodigo: user.transitoCodigo ?? '',
    companiaId: user.companiaId ? String(user.companiaId) : '',
    flitoProveedorSoatId: user.flitoProveedorSoatId ?? '',
    organismosCodigos: user.organismosCodigos,
  });
  const [submitting, setSubmitting] = useState(false);
  const [errorCompania, setErrorCompania] = useState<string | null>(null);
  const [errorProveedor, setErrorProveedor] = useState<string | null>(null);
  const [errorOrganismos, setErrorOrganismos] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    // Mismo AC2 que en el alta, y aquí cubre además el ascenso a Cliente de quien no traía compañía.
    if (f.role === 'cliente' && !f.companiaId) { setErrorCompania(COMPANIA_REQUERIDA); return; }
    // El AC3 también sobre las filas que YA existen: ascender a Proveedor / Gestor a quien no traía
    // atadura, y editarle cualquier campo a uno heredado que se quedó sin ella. Es la mitad del AC3
    // que más se olvida, y la única que ven los usuarios que ya están en la base.
    if (f.role === 'proveedor' && !f.flitoProveedorSoatId) { setErrorProveedor(PROVEEDOR_REQUERIDO); return; }
    if (f.role === 'gestor_impuestos' && f.organismosCodigos.length === 0) { setErrorOrganismos(ORGANISMOS_REQUERIDO); return; }
    setErrorCompania(null); setErrorProveedor(null); setErrorOrganismos(null);
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
      // `user.role === 'transito'` es la guarda que faltaba, y no es cosmética: hasta esta HU el
      // ámbito del gestor de impuestos vivía en esta misma columna, así que editarle el nombre a un
      // gestor le mandaba `transitoCodigo: null` y lo dejaba con la cola vacía, en silencio. La
      // 0173 se lleva ese inquilino, pero la regla se escribe igual: un guardado incidental no
      // borra una atadura que el admin no tocó. Solo se limpia al SALIR del rol que la posee.
      if (f.role !== 'transito' && user.role === 'transito' && user.transitoCodigo) body.transitoCodigo = null;
      const companiaPrevia = user.companiaId ? String(user.companiaId) : '';
      const companiaChanged = f.role === 'cliente' && f.companiaId !== companiaPrevia;
      if (companiaChanged) body.companiaId = Number(f.companiaId);
      // Un ex-Cliente no se queda atado a una compañía: el ámbito colgado no lo mira nadie y el
      // CHECK de la base tampoco lo impide (solo exige compañía CUANDO el rol es cliente).
      if (f.role !== 'cliente' && user.companiaId) body.companiaId = null;
      const proveedorPrevio = user.flitoProveedorSoatId ?? '';
      const proveedorChanged = f.role === 'proveedor' && f.flitoProveedorSoatId !== proveedorPrevio;
      if (proveedorChanged) body.flitoProveedorSoatId = f.flitoProveedorSoatId;
      // Degradar desde el rol limpia la atadura, igual que con la compañía: un ex-Proveedor no se
      // queda atado a una aseguradora que ya nadie vuelve a mirar.
      if (f.role !== 'proveedor' && user.flitoProveedorSoatId) body.flitoProveedorSoatId = null;
      // Conjuntos y no arrays: reordenar las marcas no es un cambio, y mandar un PATCH por eso
      // tiraría la sesión del gestor sin que nada de su ámbito hubiera cambiado.
      const organismosChanged = f.role === 'gestor_impuestos' && !mismoConjunto(f.organismosCodigos, user.organismosCodigos);
      if (organismosChanged) body.organismosCodigos = f.organismosCodigos;
      if (f.role !== 'gestor_impuestos' && user.organismosCodigos.length > 0) body.organismosCodigos = [];
      if (Object.keys(body).length === 0) { toast('Sin cambios'); setSubmitting(false); return; }
      const organismoChanged = f.role === 'transito' && f.transitoCodigo !== (user.transitoCodigo ?? '');
      await api.patch(`/users/${user.id}`, body);
      toast.success('Usuario actualizado');
      if (organismoChanged) {
        toast('El usuario debe volver a iniciar sesión para aplicar el nuevo organismo.', { duration: 6000 });
      }
      // La compañía es el ÁMBITO de datos del Cliente: si cambia, su sesión cae en el servidor
      // (`debeInvalidar`) y el admin tiene que saber por qué al usuario se le cerró la sesión.
      if (companiaChanged) toast(COMPANIA_RELOGIN, { duration: 6000 });
      // Los dos ámbitos nuevos entran en `debeInvalidar` del servidor, así que el admin tiene que
      // saber por qué a ese usuario se le acaba de cerrar la sesión. Solo si CAMBIÓ de verdad.
      if (proveedorChanged) toast(PROVEEDOR_RELOGIN, { duration: 6000 });
      if (organismosChanged) toast(ORGANISMOS_RELOGIN, { duration: 6000 });
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
          {/* Los campos de UN valor se vacían al salir del rol y se vuelven a elegir: es un clic, y
              tratar al proveedor distinto que a tránsito y a compañía rompería la coherencia del
              formulario. El MULTIVALOR no: al volver a Gestor reaparecen las marcas GUARDADAS
              —`user.organismosCodigos`, no las que hubiera marcado sin guardar—, porque rehacer
              seis casillas por un clic mal dado en el rol no es «un clic». La regla es explícita y
              acotada al único campo de cardinalidad N. */}
          <select
            value={f.role}
            onChange={(e) => {
              setF({
                ...f,
                role: e.target.value as User['role'],
                transitoCodigo: e.target.value === 'transito' ? f.transitoCodigo : '',
                companiaId: e.target.value === 'cliente' ? f.companiaId : '',
                flitoProveedorSoatId: e.target.value === 'proveedor' ? f.flitoProveedorSoatId : '',
                organismosCodigos: e.target.value === 'gestor_impuestos' ? user.organismosCodigos : [],
              });
              setErrorProveedor(null); setErrorOrganismos(null);
            }}
            className={inputCls}
          >
            {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </Field>
        <AmbitoCampos
          role={f.role}
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
        <PermissionsPicker role={f.role} extraPages={f.extraPages} onChange={(pages) => setF({ ...f, extraPages: pages })} />
        <Footer onClose={onClose} submitting={submitting} label="Guardar cambios" />
      </form>
    </FlitModal>
  );
}

/** Igualdad de conjuntos: el ORDEN de los códigos no es un cambio de ámbito. */
function mismoConjunto(a: string[], b: string[]) {
  return a.length === b.length && a.every((c) => b.includes(c));
}
