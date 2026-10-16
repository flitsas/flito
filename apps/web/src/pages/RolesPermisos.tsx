// HU #12085 (Feature #12072) → HU #13430 (Feature #13416) — Roles y permisos: el árbol de tres niveles
// de cada rol.
//
// Fichas UX: `docs/ux/roles-y-permisos-panel.md` (lista de roles, modales, salida con cambios, sin
// identificadores en la URL) + `docs/ux/hu-13430-panel-tres-niveles.md` y su delta
// `docs/ux/hu-13430-delta-contrato-arbol.md`, que MANDA (contrato de la #13429).
//
// Datos:
//   · Al montar: `/roles`, `/mios` y el cuadro (`/roles/:codigo/funciones`) de CADA rol, porque la lista
//     de la izquierda enseña cuántas funciones tiene cada uno; después el árbol del primer rol.
//   · El árbol de un rol (`/roles/:codigo/arbol`) se pide al seleccionarlo y queda en caché. Su
//     estructura es la misma para todos; sus marcas se suman al cuadro (la línea base es la unión, para
//     que el `PUT` no tire ningún código que el cuadro traiga y el árbol no pinte).
//   · Guardar: `PUT /roles/:codigo/funciones` con TODO lo marcado, inactivos incluidos, nunca
//     `menu.ayuda`. La nueva base es lo que el servidor aplicó (AC7 de #12085).
//
// Salidas con cambios pendientes: `beforeunload` + `window.confirm` al cambiar de rol o pulsar
// «Volver» (decisión 10/09). Ningún identificador de rol viaja en la URL (decisión 13).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RolCatalogo } from '@operaciones/shared-types';
import { cuerpoAntiBloqueo, permisosApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import { toastOk } from '../components/flit/ToastFlito';
import { FlitCard, FlitEmpty, flitBtnSecondary, flitBtnSecondaryStyle } from '../components/flit/flitPageKit';
import ListaRoles from './roles-permisos/ListaRoles';
import CuadroRol, { type PermisosPantalla } from './roles-permisos/CuadroRol';
import RolFormModal from './roles-permisos/RolFormModal';
import BorrarRolModal from './roles-permisos/BorrarRolModal';
import { cambios as textoCambios } from './roles-permisos/modulos';
import {
  aviso409, funcionesParaGuardar, indexar, marcadosDelApi, normalizar, totalMarcables, type Aviso409, type Nodo,
} from './roles-permisos/arbol';
import type { FocoArbol } from './roles-permisos/ArbolPermisos';

export const COPY_ERROR_CARGA = 'No se pudo cargar el catálogo de roles y permisos. Revisa tu conexión y vuelve a intentarlo.';
const COPY_ERROR_ARBOL = 'No se pudieron cargar los permisos de este rol. Revisa tu conexión y vuelve a intentarlo.';
const COPY_VACIO_ROLES = 'Todavía no hay roles. Crea el primero para poder repartir permisos.';
const COPY_VACIO_ROLES_SIN_CREAR = 'Todavía no hay roles. Pide a quien administre FLITO que cree el primero.';
const COPY_VACIO_FUNCIONES = 'El catálogo de funciones llegó vacío. No hay nada que marcar. Vuelve a cargar; si sigue vacío es un fallo del despliegue y hay que reportarlo.';
export const COPY_ERROR_GUARDADO = 'No se pudieron guardar los permisos. Tus cambios siguen aquí; vuelve a intentarlo con «Guardar cambios».';
const COPY_PROPIO_CAMBIO = 'Este guardado cambió tu propio conjunto de funciones. Ya está aplicado en esta sesión, sin volver a entrar.';
export const copyGuardado = (rol: string) => `Permisos de ${rol} guardados: cada usuario los verá en su siguiente acción.`;

type Modal = { tipo: 'crear' } | { tipo: 'editar'; rol: RolCatalogo } | { tipo: 'borrar'; rol: RolCatalogo } | null;
interface ArbolRol { arbol: Nodo[]; marcados: string[] }

const porNombre = (a: RolCatalogo, b: RolCatalogo) => a.nombre.localeCompare(b.nombre, 'es');

async function pedirArbol(codigo: string): Promise<ArbolRol> {
  const r = await permisosApi.arbolDelRol(codigo);
  return {
    arbol: normalizar(r.arbol),
    marcados: marcadosDelApi(r.arbol),
  };
}

const union = (a: readonly string[] | undefined, b: readonly string[]) => [...new Set([...(a ?? []), ...b])];

export default function RolesPermisos() {
  const navigate = useNavigate();
  const { refrescarFunciones, hasFuncion } = useAuth();
  const tituloRef = useRef<HTMLHeadingElement>(null);
  const [carga, setCarga] = useState<'cargando' | 'error' | 'ok'>('cargando');
  const [roles, setRoles] = useState<RolCatalogo[]>([]);
  const [cuadros, setCuadros] = useState<Record<string, string[]>>({});
  const [arboles, setArboles] = useState<Record<string, ArbolRol>>({});
  const [cargaArbol, setCargaArbol] = useState<'cargando' | 'error' | 'ok'>('ok');
  const [versionMia, setVersionMia] = useState<number | null>(null);
  const [seleccionado, setSeleccionado] = useState<string | null>(null);
  const seleccionadoRef = useRef<string | null>(null);
  const [borrador, setBorrador] = useState<Set<string>>(() => new Set());
  const [guardando, setGuardando] = useState(false);
  const [errorGuardado, setErrorGuardado] = useState<Aviso409 | null>(null);
  const [avisoPropio, setAvisoPropio] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [guardados, setGuardados] = useState<Set<string>>(() => new Set());
  const [foco, setFoco] = useState<FocoArbol | null>(null);
  const [guardadoToken, setGuardadoToken] = useState(0);

  const permisos: PermisosPantalla = {
    guardar: hasFuncion('permisos.cuadro.guardar'),
    editar: hasFuncion('permisos.rol.editar'),
    borrar: hasFuncion('permisos.rol.borrar'),
  };
  const puedeCrear = hasFuncion('permisos.rol.crear');

  const elegir = (codigo: string | null, marcas: readonly string[]) => {
    seleccionadoRef.current = codigo;
    setSeleccionado(codigo);
    setBorrador(new Set(marcas));
    setErrorGuardado(null);
    setFoco(null);
  };

  const cargar = useCallback(async () => {
    setCarga('cargando');
    try {
      const [r, m] = await Promise.all([permisosApi.roles(), permisosApi.mios().catch(() => null)]);
      const ordenados = [...r.roles].sort(porNombre);
      const pares = await Promise.all(ordenados.map(async (rol) => [rol.codigo, (await permisosApi.cuadroDelRol(rol.codigo)).funciones] as const));
      const mapa: Record<string, string[]> = Object.fromEntries(pares);
      const primero = ordenados[0]?.codigo ?? null;
      const arbolPrimero = primero ? await pedirArbol(primero) : null;
      if (primero && arbolPrimero) mapa[primero] = union(mapa[primero], arbolPrimero.marcados);
      setRoles(ordenados);
      setCuadros(mapa);
      setArboles(primero && arbolPrimero ? { [primero]: arbolPrimero } : {});
      setCargaArbol('ok');
      setVersionMia(m?.version ?? null);
      elegir(primero, primero ? mapa[primero] : []);
      setCarga('ok');
    } catch {
      setCarga('error');
    }
  }, []);

  useEffect(() => { void cargar(); }, [cargar]);

  const cargarArbol = useCallback(async (codigo: string) => {
    setCargaArbol('cargando');
    try {
      const a = await pedirArbol(codigo);
      setArboles((prev) => ({ ...prev, [codigo]: a }));
      setCuadros((prev) => ({ ...prev, [codigo]: union(prev[codigo], a.marcados) }));
      if (seleccionadoRef.current === codigo) setBorrador((prev) => new Set([...prev, ...a.marcados]));
      setCargaArbol('ok');
    } catch {
      if (seleccionadoRef.current === codigo) setCargaArbol('error');
    }
  }, []);

  const rol = roles.find((r) => r.codigo === seleccionado) ?? null;
  const actual = seleccionado ? arboles[seleccionado] : undefined;
  // La estructura es la misma para todos los roles: la de cualquier árbol ya cargado sirve para contar.
  const estructura = actual ?? Object.values(arboles)[0];
  const indice = useMemo(() => indexar(actual?.arbol ?? []), [actual]);
  const total = useMemo(() => (estructura ? totalMarcables(estructura.arbol) : 0), [estructura]);
  const cuentaPorRol = useMemo(() => Object.fromEntries(roles.map((r) => [r.codigo, cuadros[r.codigo]?.length])), [roles, cuadros]);
  const base = useMemo(() => new Set(seleccionado ? cuadros[seleccionado] ?? [] : []), [cuadros, seleccionado]);
  const nCambios = useMemo(
    () => [...borrador].filter((c) => !base.has(c)).length + [...base].filter((c) => !borrador.has(c)).length,
    [borrador, base],
  );
  const hayCambios = permisos.guardar && nCambios > 0;

  useEffect(() => {
    if (!hayCambios) return undefined;
    const avisar = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', avisar);
    return () => window.removeEventListener('beforeunload', avisar);
  }, [hayCambios]);

  const confirmarSalida = () =>
    !hayCambios || window.confirm(`Tienes ${textoCambios(nCambios)} sin guardar en el rol ${rol?.nombre ?? ''}. ¿Salir y perderlos?`);

  const seleccionar = (codigo: string) => {
    if (codigo === seleccionado || !confirmarSalida()) return;
    elegir(codigo, cuadros[codigo] ?? []);
    if (arboles[codigo]) setCargaArbol('ok'); else void cargarArbol(codigo);
  };

  const alternar = useCallback((codigo: string) => setBorrador((prev) => {
    const s = new Set(prev);
    if (s.has(codigo)) s.delete(codigo); else s.add(codigo);
    return s;
  }), []);

  const marcarConjunto = useCallback((codigos: string[], marcar: boolean) => setBorrador((prev) => {
    const s = new Set(prev);
    for (const c of codigos) { if (marcar) s.add(c); else s.delete(c); }
    return s;
  }), []);

  const descartar = () => {
    if (!window.confirm(`Vas a perder ${textoCambios(nCambios)} sin guardar en el rol ${rol?.nombre ?? ''}. ¿Descartarlos?`)) return;
    setBorrador(new Set(base));
    setErrorGuardado(null);
  };

  const guardar = async () => {
    if (!seleccionado || !rol) return;
    setGuardando(true);
    setErrorGuardado(null);
    try {
      const respuesta = await permisosApi.guardarCuadro(seleccionado, funcionesParaGuardar(borrador, indice));
      setCuadros((prev) => ({ ...prev, [seleccionado]: respuesta.funciones }));
      setBorrador(new Set(respuesta.funciones));
      setGuardados((prev) => new Set(prev).add(seleccionado));
      setGuardadoToken((n) => n + 1);
      toastOk(copyGuardado(rol.nombre), { duracionMs: 6000 });
      try {
        const mios = await permisosApi.mios();
        if (versionMia !== null && mios.version !== versionMia) setAvisoPropio(COPY_PROPIO_CAMBIO);
        setVersionMia(mios.version);
        await refrescarFunciones();
      } catch { /* sin `/mios` no hay comparación que hacer; el guardado ya está aplicado */ }
    } catch (e) {
      const cuerpo = cuerpoAntiBloqueo(e);
      setErrorGuardado(cuerpo ? aviso409(cuerpo, indice, 'rol') : { texto: COPY_ERROR_GUARDADO, nodo: null });
    } finally {
      setGuardando(false);
    }
  };

  const volver = () => { if (confirmarSalida()) navigate(-1); };

  const alCrear = (nuevo: RolCatalogo) => {
    setRoles((prev) => [...prev, nuevo].sort(porNombre));
    setCuadros((prev) => ({ ...prev, [nuevo.codigo]: [] }));
    setModal(null);
    if (confirmarSalida()) { elegir(nuevo.codigo, []); void cargarArbol(nuevo.codigo); }
  };

  const alEditar = (editado: RolCatalogo) => {
    setRoles((prev) => prev.map((r) => (r.codigo === editado.codigo ? editado : r)).sort(porNombre));
    setModal(null);
  };

  const alBorrar = (codigo: string) => {
    const restantes = roles.filter((r) => r.codigo !== codigo);
    setRoles(restantes);
    setCuadros((prev) => { const { [codigo]: _fuera, ...resto } = prev; return resto; });
    setModal(null);
    if (seleccionado === codigo) {
      const primero = restantes[0]?.codigo ?? null;
      elegir(primero, primero ? cuadros[primero] ?? [] : []);
      if (primero && !arboles[primero]) void cargarArbol(primero);
    }
  };

  const sinRoles = carga === 'ok' && roles.length === 0;
  const sinFunciones = carga === 'ok' && !!estructura && estructura.arbol.length === 0;

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Roles y permisos"
        subtitle="Qué puede hacer cada rol dentro de FLITO"
        titleRef={tituloRef}
        actions={(
          <>
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={volver}>Volver</button>
            {carga === 'ok' && !sinRoles && !sinFunciones && puedeCrear && (
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setModal({ tipo: 'crear' })}>Nuevo rol</button>
            )}
          </>
        )}
      />

      {/* Única región viva de la pantalla: anuncia el rol al cambiarlo. */}
      <p className="sr-only" role="status">
        {carga === 'ok' && rol && cargaArbol === 'ok' ? `Permisos del rol ${rol.nombre}. ${base.size} de ${total} marcados.` : ''}
      </p>
      {avisoPropio && <p role="status" className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{avisoPropio}</p>}

      {carga === 'cargando' && <Esqueleto />}

      {carga === 'error' && (
        <FlitCard className="mx-auto w-full max-w-xl text-center">
          <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{COPY_ERROR_CARGA}</p>
          <button type="button" className={`${flitBtnSecondary} mt-4`} style={flitBtnSecondaryStyle} onClick={() => void cargar()}>Reintentar</button>
        </FlitCard>
      )}

      {sinFunciones && (
        <FlitEmpty>
          <p>{COPY_VACIO_FUNCIONES}</p>
          <button type="button" className={`${flitBtnSecondary} mt-4`} style={flitBtnSecondaryStyle} onClick={() => void cargar()}>Reintentar</button>
        </FlitEmpty>
      )}

      {sinRoles && (
        <FlitEmpty>
          <p>{puedeCrear ? COPY_VACIO_ROLES : COPY_VACIO_ROLES_SIN_CREAR}</p>
          {puedeCrear && (
            <div className="mt-4 flex justify-center">
              <GradientButton type="button" onClick={() => setModal({ tipo: 'crear' })}>Nuevo rol</GradientButton>
            </div>
          )}
        </FlitEmpty>
      )}

      {carga === 'ok' && !sinFunciones && !sinRoles && rol && (
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[280px_minmax(0,1fr)] lg:items-start lg:gap-6">
          <ListaRoles roles={roles} cuentaPorRol={cuentaPorRol} total={total} seleccionado={seleccionado} onSeleccionar={seleccionar} />
          {cargaArbol === 'cargando' && <EsqueletoArbol />}
          {cargaArbol === 'error' && (
            <FlitCard className="text-center">
              <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{COPY_ERROR_ARBOL}</p>
              <button type="button" className={`${flitBtnSecondary} mt-4`} style={flitBtnSecondaryStyle} onClick={() => void cargarArbol(rol.codigo)}>Reintentar</button>
            </FlitCard>
          )}
          {cargaArbol === 'ok' && actual && (
            <CuadroRol
              key={rol.codigo}
              rol={rol}
              arbol={actual.arbol}
              indice={indice}
              base={base}
              borrador={borrador}
              guardando={guardando}
              errorGuardado={errorGuardado}
              permisos={permisos}
              usarEfectivoServidor={nCambios === 0 && !guardados.has(rol.codigo)}
              foco={foco}
              guardadoToken={guardadoToken}
              onToggle={alternar}
              onConjunto={marcarConjunto}
              onMostrarDonde={(codigo) => setFoco({ codigo, token: Date.now() })}
              onGuardar={() => void guardar()}
              onDescartar={descartar}
              onEditar={() => setModal({ tipo: 'editar', rol })}
              onBorrar={() => setModal({ tipo: 'borrar', rol })}
            />
          )}
        </div>
      )}

      {modal?.tipo === 'crear' && <RolFormModal modo="crear" onClose={() => setModal(null)} onListo={alCrear} restoreFocusRef={tituloRef} />}
      {modal?.tipo === 'editar' && <RolFormModal modo="editar" rol={modal.rol} onClose={() => setModal(null)} onListo={alEditar} restoreFocusRef={tituloRef} />}
      {modal?.tipo === 'borrar' && <BorrarRolModal rol={modal.rol} onClose={() => setModal(null)} onBorrado={alBorrar} restoreFocusRef={tituloRef} />}
    </div>
  );
}

const BARRA_ESQ = 'animate-pulse rounded-[10px]';
const TONO_ESQ = { background: 'var(--flit-bg-app)' } as const;

/** Tarjeta del rol + tarjeta del árbol con 9 filas (8 elementos visibles; delta «Estados»). */
function EsqueletoArbol() {
  return (
    <div role="status" aria-busy="true" aria-label="Cargando los permisos del rol">
      <EsqueletoArbolVisual />
    </div>
  );
}

/** Esqueleto de DOS columnas, propio: el genérico es de una y el contenido saltaría al llegar. */
function Esqueleto() {
  return (
    <div role="status" aria-busy="true" aria-label="Cargando roles y permisos" className="flex flex-col gap-4 lg:grid lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-6">
      <FlitCard>
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }, (_, i) => <div key={i} className={`${BARRA_ESQ} h-8`} style={TONO_ESQ} />)}
        </div>
      </FlitCard>
      <div aria-hidden="true"><EsqueletoArbolVisual /></div>
    </div>
  );
}

function EsqueletoArbolVisual() {
  return (
    <div className="flex flex-col gap-4">
      <FlitCard><div className={`${BARRA_ESQ} h-24`} style={TONO_ESQ} /></FlitCard>
      <FlitCard>
        {Array.from({ length: 9 }, (_, i) => (
          <div key={i} className={i > 0 ? 'border-t py-3' : 'pb-3'} style={{ borderColor: 'var(--flit-border-soft)' }}>
            <div className={`${BARRA_ESQ} h-6`} style={TONO_ESQ} />
          </div>
        ))}
      </FlitCard>
    </div>
  );
}
