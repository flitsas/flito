// HU #12085 (Feature #12072) — Roles y permisos: el cuadro rol × función.
//
// Ficha UX (vinculante): `docs/ux/roles-y-permisos-panel.md`. Disposición A: lista de roles a la
// izquierda, cuadro del rol seleccionado a la derecha con sus módulos plegados. Una sola primaria
// («Guardar cambios») y solo cuando hay cambios; en reposo no hay ninguna (decisiones 3 y 4).
//
// Diferencias con la ficha §7, que se escribió antes del contrato real del API (#12084):
//   · No hay `GET /api/permisos/cuadro`. Al montar se piden `/funciones`, `/roles` y `/mios` en
//     paralelo y después el cuadro de CADA rol (`/roles/:codigo/funciones`, también en paralelo),
//     porque la lista de la izquierda tiene que enseñar cuántas funciones tiene cada uno (§3) y
//     eso no viaja en `/roles`. Todo queda cacheado por código en estado.
//   · El `PUT` no tiene 409 de «conflicto de versión» (§11-4): el último que guarda gana. Se declara
//     como límite en la ficha de ayuda de la pantalla.
//   · `canalExterno` por función no viaja: el aviso de rol externo es el general de §8.1 y, tras
//     guardar, se listan las funciones que el `PUT` devuelve en `aviso.funciones`.
//   · Tras guardar, el cuadro pinta EXACTAMENTE `funciones` de la respuesta del `PUT` (AC7), no lo
//     que se envió ni nada recalculado en el cliente.
//   · AC5 / RN-A4: tras guardar se vuelve a pedir `/mios` y se compara `version` con la del montaje
//     para saber si el propio conjunto cambió; no se recalcula nada localmente.
//
// Salidas con cambios pendientes (decisión 10/09): `beforeunload` + `window.confirm` al cambiar de
// rol o pulsar «Volver». Ni `useBlocker` ni router de datos; el menú lateral NO se intercepta (§11-3).
// Ningún identificador de rol viaja en la URL: la selección vive en estado (decisión 13).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import type { RolCatalogo } from '@operaciones/shared-types';
import { ApiError, errorMessage, permisosApi, type GrupoDeFunciones } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import { FlitCard, FlitEmpty, flitBtnSecondary, flitBtnSecondaryStyle } from '../components/flit/flitPageKit';
import ListaRoles from './roles-permisos/ListaRoles';
import CuadroRol from './roles-permisos/CuadroRol';
import RolFormModal from './roles-permisos/RolFormModal';
import BorrarRolModal from './roles-permisos/BorrarRolModal';
import { cambios as textoCambios, modulosVisibles } from './roles-permisos/modulos';

const COPY_ERROR_CARGA = 'No se pudo cargar el catálogo de roles y funciones.';
const COPY_VACIO_ROLES = 'Todavía no hay roles. Crea el primero para poder repartir funciones.';
const COPY_VACIO_FUNCIONES = 'El catálogo de funciones llegó vacío. No hay nada que marcar. Vuelve a cargar; si sigue vacío es un fallo del despliegue y hay que reportarlo.';
const COPY_GUARDADO = 'Permisos guardados. El cambio ya está aplicado: se aplica en la siguiente acción de cada usuario. No hay que reiniciar nada.';
const COPY_ERROR_GUARDADO = 'No se pudieron guardar los permisos. Los cambios siguen aquí; vuelve a intentarlo.';
const COPY_ANTI_BLOQUEO = 'No se puede guardar: FLITO se quedaría sin nadie que pueda administrar roles y permisos. Deja marcada «Administrar roles y permisos» en al menos un rol que tenga usuarios activos.';
const COPY_PROPIO_CAMBIO = 'Este guardado cambió tu propio conjunto de funciones. Ya está aplicado en esta sesión, sin volver a entrar.';

type Modal = { tipo: 'crear' } | { tipo: 'editar'; rol: RolCatalogo } | { tipo: 'borrar'; rol: RolCatalogo } | null;

const porNombre = (a: RolCatalogo, b: RolCatalogo) => a.nombre.localeCompare(b.nombre, 'es');

export default function RolesPermisos() {
  const navigate = useNavigate();
  const { refrescarFunciones } = useAuth();
  const tituloRef = useRef<HTMLHeadingElement>(null);
  const [carga, setCarga] = useState<'cargando' | 'error' | 'ok'>('cargando');
  const [errorCarga, setErrorCarga] = useState('');
  const [grupos, setGrupos] = useState<GrupoDeFunciones[]>([]);
  const [roles, setRoles] = useState<RolCatalogo[]>([]);
  const [cuadros, setCuadros] = useState<Record<string, string[]>>({});
  const [versionMia, setVersionMia] = useState<number | null>(null);
  const [seleccionado, setSeleccionado] = useState<string | null>(null);
  const [borrador, setBorrador] = useState<Set<string>>(() => new Set());
  const [avisoFueraDelCanal, setAvisoFueraDelCanal] = useState<string[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [errorGuardado, setErrorGuardado] = useState<string | null>(null);
  const [avisoPropio, setAvisoPropio] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);

  const cargar = useCallback(async () => {
    setCarga('cargando');
    setErrorCarga('');
    try {
      const [f, r, m] = await Promise.all([
        permisosApi.funciones(),
        permisosApi.roles(),
        permisosApi.mios().catch(() => null),
      ]);
      const ordenados = [...r.roles].sort(porNombre);
      const pares = await Promise.all(ordenados.map(async (rol) => {
        const cuadro = await permisosApi.cuadroDelRol(rol.codigo);
        return [rol.codigo, cuadro.funciones] as const;
      }));
      const mapa = Object.fromEntries(pares);
      setGrupos(f.grupos);
      setRoles(ordenados);
      setCuadros(mapa);
      setVersionMia(m?.version ?? null);
      const primero = ordenados[0]?.codigo ?? null;
      setSeleccionado(primero);
      setBorrador(new Set(primero ? mapa[primero] : []));
      setAvisoFueraDelCanal([]);
      setErrorGuardado(null);
      setCarga('ok');
    } catch (e) {
      setErrorCarga(errorMessage(e));
      setCarga('error');
    }
  }, []);

  useEffect(() => { void cargar(); }, [cargar]);

  const gruposVisibles = useMemo(() => modulosVisibles(grupos), [grupos]);
  const total = useMemo(() => gruposVisibles.reduce((n, g) => n + g.funciones.length, 0), [gruposVisibles]);
  const nombrePorCodigo = useMemo(
    () => new Map(gruposVisibles.flatMap((g) => g.funciones.map((f) => [f.codigo, f.nombreNegocio] as const))),
    [gruposVisibles],
  );
  const cuentaPorRol = useMemo(
    () => Object.fromEntries(roles.map((r) => [r.codigo, cuadros[r.codigo]?.length])),
    [roles, cuadros],
  );
  const rol = roles.find((r) => r.codigo === seleccionado) ?? null;
  const base = useMemo(() => new Set(seleccionado ? cuadros[seleccionado] ?? [] : []), [cuadros, seleccionado]);
  const nCambios = useMemo(
    () => [...borrador].filter((c) => !base.has(c)).length + [...base].filter((c) => !borrador.has(c)).length,
    [borrador, base],
  );
  const hayCambios = nCambios > 0;

  // `beforeunload` mientras haya cambios: el texto lo pone el navegador (§11-3).
  useEffect(() => {
    if (!hayCambios) return undefined;
    const avisar = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', avisar);
    return () => window.removeEventListener('beforeunload', avisar);
  }, [hayCambios]);

  const confirmarSalida = () =>
    !hayCambios || window.confirm(`Tienes ${textoCambios(nCambios)} sin guardar en el rol ${rol?.nombre ?? ''}. ¿Salir y perderlos?`);

  const seleccionar = (codigo: string) => {
    if (codigo === seleccionado) return;
    if (!confirmarSalida()) return;
    setSeleccionado(codigo);
    setBorrador(new Set(cuadros[codigo] ?? []));
    setAvisoFueraDelCanal([]);
    setErrorGuardado(null);
  };

  const alternar = (codigo: string, marcado: boolean) => setBorrador((prev) => {
    const s = new Set(prev);
    if (marcado) s.add(codigo); else s.delete(codigo);
    return s;
  });

  const marcarConjunto = (codigos: string[], marcar: boolean) => setBorrador((prev) => {
    const s = new Set(prev);
    for (const c of codigos) { if (marcar) s.add(c); else s.delete(c); }
    return s;
  });

  const descartar = () => {
    if (!window.confirm(`Vas a perder ${textoCambios(nCambios)} sin guardar en el rol ${rol?.nombre ?? ''}. ¿Descartarlos?`)) return;
    setBorrador(new Set(base));
    setErrorGuardado(null);
  };

  const guardar = async () => {
    if (!seleccionado) return;
    setGuardando(true);
    setErrorGuardado(null);
    try {
      const respuesta = await permisosApi.guardarCuadro(seleccionado, [...borrador].sort());
      // AC7: la nueva línea base es lo que el servidor APLICÓ, no lo que se envió.
      setCuadros((prev) => ({ ...prev, [seleccionado]: respuesta.funciones }));
      setBorrador(new Set(respuesta.funciones));
      setAvisoFueraDelCanal(respuesta.aviso?.funciones ?? []);
      toast.success(COPY_GUARDADO, { duration: 6000 });
      try {
        const mios = await permisosApi.mios();
        if (versionMia !== null && mios.version !== versionMia) setAvisoPropio(COPY_PROPIO_CAMBIO);
        setVersionMia(mios.version);
        // HU #12170: la sesión obedece el mismo `/mios` que pinta botones.
        await refrescarFunciones();
      } catch { /* sin `/mios` no hay comparación que hacer; el guardado ya está aplicado */ }
    } catch (e) {
      const anti = e instanceof ApiError && e.status === 409;
      setErrorGuardado(anti ? `${COPY_ANTI_BLOQUEO} ${e.message}` : `${COPY_ERROR_GUARDADO} ${errorMessage(e)}`);
    } finally {
      setGuardando(false);
    }
  };

  const volver = () => { if (confirmarSalida()) navigate(-1); };

  const alCrear = (nuevo: RolCatalogo) => {
    setRoles((prev) => [...prev, nuevo].sort(porNombre));
    setCuadros((prev) => ({ ...prev, [nuevo.codigo]: [] }));
    setModal(null);
    if (confirmarSalida()) {
      setSeleccionado(nuevo.codigo);
      setBorrador(new Set());
      setAvisoFueraDelCanal([]);
      setErrorGuardado(null);
    }
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
      setSeleccionado(primero);
      setBorrador(new Set(primero ? cuadros[primero] ?? [] : []));
      setAvisoFueraDelCanal([]);
      setErrorGuardado(null);
    }
  };

  const sinRoles = carga === 'ok' && roles.length === 0;
  const sinFunciones = carga === 'ok' && gruposVisibles.length === 0;

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Roles y permisos"
        subtitle="Qué puede hacer cada rol dentro de FLITO"
        titleRef={tituloRef}
        actions={(
          <>
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={volver}>Volver</button>
            {carga === 'ok' && !sinRoles && !sinFunciones && (
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setModal({ tipo: 'crear' })}>Nuevo rol</button>
            )}
          </>
        )}
      />

      {/* Única región viva de la pantalla (ficha §9): anuncia el cuadro nuevo al cambiar de rol. */}
      <p className="sr-only" role="status">
        {carga === 'ok' && rol ? `Cuadro del rol ${rol.nombre}. ${base.size} de ${total} funciones marcadas.` : ''}
      </p>
      {avisoPropio && (
        <p role="status" className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{avisoPropio}</p>
      )}

      {carga === 'cargando' && <Esqueleto />}

      {carga === 'error' && (
        <FlitCard className="mx-auto w-full max-w-xl text-center">
          <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
            {COPY_ERROR_CARGA} {errorCarga}
          </p>
          <button type="button" className={`${flitBtnSecondary} mt-4`} style={flitBtnSecondaryStyle} onClick={() => void cargar()}>Reintentar</button>
        </FlitCard>
      )}

      {sinFunciones && (
        <FlitEmpty>
          <p>{COPY_VACIO_FUNCIONES}</p>
          <button type="button" className={`${flitBtnSecondary} mt-4`} style={flitBtnSecondaryStyle} onClick={() => void cargar()}>Reintentar</button>
        </FlitEmpty>
      )}

      {!sinFunciones && sinRoles && (
        <FlitEmpty>
          <p>{COPY_VACIO_ROLES}</p>
          <div className="mt-4 flex justify-center">
            <GradientButton type="button" onClick={() => setModal({ tipo: 'crear' })}>Nuevo rol</GradientButton>
          </div>
        </FlitEmpty>
      )}

      {carga === 'ok' && !sinFunciones && !sinRoles && rol && (
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[280px_minmax(0,1fr)] lg:items-start lg:gap-6">
          <ListaRoles roles={roles} cuentaPorRol={cuentaPorRol} total={total} seleccionado={seleccionado} onSeleccionar={seleccionar} />
          <CuadroRol
            key={rol.codigo}
            rol={rol}
            grupos={gruposVisibles}
            nombrePorCodigo={nombrePorCodigo}
            base={base}
            borrador={borrador}
            avisoFueraDelCanal={avisoFueraDelCanal}
            guardando={guardando}
            errorGuardado={errorGuardado}
            onToggle={alternar}
            onMarcarConjunto={marcarConjunto}
            onGuardar={() => void guardar()}
            onDescartar={descartar}
            onEditar={() => setModal({ tipo: 'editar', rol })}
            onBorrar={() => setModal({ tipo: 'borrar', rol })}
          />
        </div>
      )}

      {modal?.tipo === 'crear' && <RolFormModal modo="crear" onClose={() => setModal(null)} onListo={alCrear} restoreFocusRef={tituloRef} />}
      {modal?.tipo === 'editar' && <RolFormModal modo="editar" rol={modal.rol} onClose={() => setModal(null)} onListo={alEditar} restoreFocusRef={tituloRef} />}
      {modal?.tipo === 'borrar' && <BorrarRolModal rol={modal.rol} onClose={() => setModal(null)} onBorrado={alBorrar} restoreFocusRef={tituloRef} />}
    </div>
  );
}

/** Esqueleto de DOS columnas, propio: el genérico es de una y el contenido saltaría al llegar (decisión 14). */
function Esqueleto() {
  const barra = 'animate-pulse rounded-[10px]';
  const tono = { background: 'var(--flit-bg-app)' } as const;
  return (
    <div role="status" aria-busy="true" aria-label="Cargando roles y permisos" className="flex flex-col gap-4 lg:grid lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-6">
      <FlitCard>
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }, (_, i) => <div key={i} className={`${barra} h-8`} style={tono} />)}
        </div>
      </FlitCard>
      <div className="flex flex-col gap-4">
        <FlitCard><div className={`${barra} h-24`} style={tono} /></FlitCard>
        {Array.from({ length: 4 }, (_, i) => <FlitCard key={i}><div className={`${barra} h-6`} style={tono} /></FlitCard>)}
      </div>
    </div>
  );
}
