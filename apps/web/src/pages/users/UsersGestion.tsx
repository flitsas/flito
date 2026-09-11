// FLITO — Gestión de usuarios para quien PUEDE gestionar: cabecera con «Nuevo usuario», la fila de
// pestañas [Usuarios] [Historial], la lista con su barra y sus modales, y el historial de cambios.
//
// Era el cuerpo de `pages/Users.tsx`. Bajó aquí en la HU #12171 (Feature #12072) porque el auditor
// entra a la misma página y solo ve el historial: los hooks de catálogos (`useCompanias`,
// `useProveedoresSoat`, `useOrganismosParametrizados`) y la carga de la lista no pueden ser
// condicionales dentro de un componente, así que lo de admin vive en ESTE componente y `Users.tsx`
// queda como conmutador. Si el auditor montara esto, cada hook le respondería 403 en silencio.
//
// HU #12088: carga `permisosApi.roles()` → mapa tipoEnlace + lista activa para el select de rol.
//
// **Esto NO es kit.** Un único consumidor: la página de usuarios.

import { useEffect, useState, useCallback, useRef, type KeyboardEvent } from 'react';
import toast from 'react-hot-toast';
import type { RolCatalogo } from '@operaciones/shared-types';
import { api, errorMessage, permisosApi, type GrupoDeFunciones } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import PageHeaderCard from '../../components/flit/PageHeaderCard';
import GradientButton from '../../components/flit/GradientButton';
import { FlitPillGroup, flitPillBtn, flitPillBtnClase } from '../../components/flit/flitPageKit';
import { useOrganismosParametrizados, useProveedoresSoat } from './AtaduraFields';
import { useCompanias } from './CompaniaField';
import { formatErrors } from './UserFormShared';
import type { ResumenUsuarios, RolOpcion, User } from './types';
import type { CatalogoFuncionesEstado } from './PermissionsPicker';
import UsersTable from './UsersTable';
import UsersToolbar from './UsersToolbar';
import CreateForm from './CreateUserForm';
import EditForm from './EditUserForm';
import PasswordForm from './PasswordForm';
import HistorialPermisos from './HistorialPermisos';

type Seccion = 'usuarios' | 'historial';

const SECCIONES: { valor: Seccion; etiqueta: string; tituloPanel: string }[] = [
  { valor: 'usuarios', etiqueta: 'Usuarios', tituloPanel: 'Lista de usuarios' },
  { valor: 'historial', etiqueta: 'Historial', tituloPanel: 'Historial de cambios' },
];

export default function UsersGestion({ puedeExportar }: {
  /** Quién ve la descarga. Se decide en `Users.tsx`, junto a `puedeGestionar`, con una sola definición. */
  puedeExportar: boolean;
}) {
  const { user: me } = useAuth();
  const companias = useCompanias();
  const proveedores = useProveedoresSoat();
  const organismos = useOrganismosParametrizados();
  const catalogo = useCatalogoFunciones();
  const rolesCatalogo = useCatalogoRoles();
  const nombreCompania = (id: number) => companias.data?.find((c) => c.id === id)?.nombre ?? null;
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rol, setRol] = useState<string>('');
  const [total, setTotal] = useState<number | null>(null);
  const [resumen, setResumen] = useState<ResumenUsuarios | null>(null);
  const [descargando, setDescargando] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [pwdTarget, setPwdTarget] = useState<User | null>(null);

  /**
   * La pestaña activa vive en estado, NO en la URL (AC3 de la #12171): la dirección se queda en
   * `/users` haga lo que haga quien navega. El patrón de foco es el de `SiigoParametrizacion.tsx`,
   * que sí escribe el parámetro porque allí la sección es un sitio; aquí es una vista de lectura.
   */
  const [seccion, setSeccion] = useState<Seccion>('usuarios');
  const tituloPanel = useRef<HTMLHeadingElement>(null);
  const pestanaActiva = useRef<HTMLButtonElement>(null);
  /** A dónde va el foco tras cambiar de sección; `null` = a ningún sitio (carga inicial). */
  const [foco, setFoco] = useState<'panel' | 'pestana' | null>(null);

  const irA = useCallback((destino: Seccion, comoEnfocar: 'panel' | 'pestana') => {
    setFoco(comoEnfocar);
    setSeccion(destino);
  }, []);

  useEffect(() => {
    if (foco === 'panel') tituloPanel.current?.focus();
    else if (foco === 'pestana') pestanaActiva.current?.focus();
    setFoco(null);
  }, [foco, seccion]);

  const alTeclear = (e: KeyboardEvent<HTMLButtonElement>, indice: number) => {
    const salto = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const destino = salto !== 0
      ? (indice + salto + SECCIONES.length) % SECCIONES.length
      : e.key === 'Home' ? 0
        : e.key === 'End' ? SECCIONES.length - 1
          : -1;
    if (destino < 0) return;
    // Sin esto, ←/→ desplazarían la página además de cambiar de pestaña.
    e.preventDefault();
    irA(SECCIONES[destino].valor, 'pestana');
  };

  /**
   * La query se arma SOLO con lo que está puesto: sin filtro la ruta vuelve a ser `/users` a secas.
   * No es cosmética —un `?rol=` vacío es un parámetro que el backend tiene que decidir si ignora, y
   * es la diferencia entre pedir «todos» y pedir «los de rol vacío»—. La comparten el listado y el
   * export, que es lo que garantiza que el archivo y la tabla no puedan separarse.
   *
   * Aquí NO va `porPagina`: sin ese parámetro el backend no pone `LIMIT` y el listado se comporta
   * como siempre. Esta pantalla no pagina todavía, y pedir una página sin controles para cambiarla
   * sería esconder usuarios.
   */
  const query = rol ? `?rol=${encodeURIComponent(rol)}` : '';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // `/users` sigue devolviendo un ARRAY PLANO; el total de coincidencias viaja en la cabecera.
      const cabeceras: { total: string | null } = { total: null };
      const rows = await api.getConCabeceras<User[]>(`/users${query}`, (leer) => { cabeceras.total = leer('X-Total-Count'); });
      setUsers(rows);
      setTotal(totalDeCabecera(cabeceras.total, rows.length));
    } catch (e) {
      // Estado de error de la LISTA, no un toast: el toast se va solo y deja la tabla diciendo
      // «Sin usuarios», que es falso. `users` se vacía para que no queden filas de la carga previa
      // bajo un mensaje que dice que la carga falló.
      setError(formatErrors(e));
      setUsers([]);
      setTotal(null);
    }
    finally { setLoading(false); }
  }, [query]);

  /**
   * El resumen es información SECUNDARIA y falla en silencio: si no llega, no se pinta el conteo y
   * la pantalla sigue sirviendo. Robarle el estado de error a la lista por esto pondría un
   * «Reintentar» sobre una tabla que sí cargó.
   */
  const cargarResumen = useCallback(async () => {
    try {
      const crudo = await api.get<unknown>('/users/resumen');
      setResumen(esResumen(crudo) ? crudo : null);
    }
    catch { setResumen(null); }
  }, []);

  const recargar = useCallback(() => { load(); cargarResumen(); }, [load, cargarResumen]);

  useEffect(() => { recargar(); }, [recargar]);

  const descargar = async () => {
    setDescargando(true);
    try {
      // Binario por `api.download`, que ya resuelve el blob y la entrega al navegador con el object
      // URL liberado después de la descarga. Ni `fetch` suelto ni `window.open` con la URL a mano.
      await api.download(`/users/export${query}`, 'usuarios.xlsx');
    } catch (e) { toast.error(formatErrors(e)); }
    finally { setDescargando(false); }
  };

  const handleToggle = async (u: User) => {
    if (u.id === me?.id) { toast.error('No puede desactivarse a sí mismo'); return; }
    if (!confirm(`${u.active ? 'Desactivar' : 'Activar'} a ${u.name}?`)) return;
    try {
      await api.patch(`/users/${u.id}/toggle`);
      toast.success('Estado actualizado');
      // `recargar` y no `load`: activar o desactivar mueve el reparto activos/inactivos del resumen.
      recargar();
    } catch (e) { toast.error(formatErrors(e)); }
  };

  const activa = SECCIONES.find((s) => s.valor === seccion) ?? SECCIONES[0];

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      {/* La primaria viaja con la lista: en «Historial» nadie viene a crear a nadie, y un gradiente
          sin trabajo detrás sería una primaria falsa (ficha UX §2). */}
      <PageHeaderCard
        title="Gestión de usuarios"
        subtitle="Equipo y accesos del sistema"
        actions={seccion === 'usuarios' ? (
          <GradientButton type="button" onClick={() => setShowCreate(true)}>
            Nuevo usuario
          </GradientButton>
        ) : undefined}
      />

      {/* Patrón de pestañas de `SiigoParametrizacion.tsx`: `tablist` con nombre, `tab` con
          `aria-selected`, `tabIndex` itinerante, flechas ←/→ e Inicio/Fin, y `aria-controls` SOLO
          en la activa —el panel de la otra no existe en el DOM—. */}
      <FlitPillGroup role="tablist" label="Secciones de usuarios">
        {SECCIONES.map((s, indice) => {
          const esActiva = s.valor === seccion;
          return (
            <button
              key={s.valor}
              ref={esActiva ? pestanaActiva : undefined}
              type="button"
              role="tab"
              id={`tab-users-${s.valor}`}
              aria-selected={esActiva}
              aria-controls={esActiva ? `panel-users-${s.valor}` : undefined}
              tabIndex={esActiva ? 0 : -1}
              onClick={() => irA(s.valor, 'panel')}
              onKeyDown={(e) => alTeclear(e, indice)}
              className={flitPillBtnClase}
              style={flitPillBtn(esActiva)}
            >
              {s.etiqueta}
            </button>
          );
        })}
      </FlitPillGroup>

      <div
        role="tabpanel"
        id={`panel-users-${seccion}`}
        aria-labelledby={`tab-users-${seccion}`}
        className="flex flex-col gap-5 lg:gap-6"
      >
        {/* Destino del foco al cambiar de pestaña: dice DÓNDE se ha llegado. Invisible porque la
            cabecera ya nombra la pantalla, y visible al enfocarse porque un elemento enfocado que no
            se ve incumple «foco visible» para quien navega con teclado sin lector.
            NO es `sr-only focus:not-sr-only` como en `SiigoParametrizacion.tsx`: ese par saca el
            título del flujo y lo mete al enfocarse, y al perder el foco en el `mousedown` de la
            primera pulsación todo lo de abajo sube una línea y el `mouseup` cae en otro sitio: el
            primer clic tras cambiar de pestaña se perdía (medido con Playwright). Aquí el título
            siempre está en flujo, en el hueco entre las pestañas y el panel (`-my-5` sobre el
            `gap-5`), y solo cambia de opacidad. */}
        <h2
          ref={tituloPanel}
          tabIndex={-1}
          className="flit-focus -my-5 block h-5 w-fit rounded px-1 text-sm font-semibold leading-5 opacity-0 focus:opacity-100"
          style={{ color: 'var(--flit-text-primary)' }}
        >
          {activa.tituloPanel}
        </h2>

        {seccion === 'usuarios' && (
          <>
            <UsersToolbar
              rol={rol}
              onRol={setRol}
              rolesCatalogo={rolesCatalogo}
              resumen={resumen}
              total={total}
              puedeExportar={puedeExportar}
              descargando={descargando}
              onDescargar={descargar}
            />

            <UsersTable
              users={users}
              loading={loading}
              error={error}
              onReintentar={recargar}
              meId={me?.id}
              rolesCatalogo={rolesCatalogo}
              nombreCompania={nombreCompania}
              proveedores={proveedores}
              organismos={organismos}
              onEditar={setEditing}
              onContrasena={setPwdTarget}
              onAlternar={handleToggle}
            />
          </>
        )}

        {seccion === 'historial' && <HistorialPermisos />}
      </div>

      {showCreate && (
        <CreateForm
          companias={companias}
          proveedores={proveedores}
          organismos={organismos}
          catalogo={catalogo}
          rolesCatalogo={rolesCatalogo}
          onClose={() => setShowCreate(false)}
          onCreated={recargar}
        />
      )}
      {editing && (
        <EditForm
          user={editing}
          companias={companias}
          proveedores={proveedores}
          organismos={organismos}
          catalogo={catalogo}
          rolesCatalogo={rolesCatalogo}
          onClose={() => setEditing(null)}
          onSaved={recargar}
        />
      )}
      {/* La contraseña no cambia rol ni estado: recarga la lista y NO el resumen. */}
      {pwdTarget && <PasswordForm user={pwdTarget} isSelf={pwdTarget.id === me?.id} onClose={() => setPwdTarget(null)} onSaved={load} />}
    </div>
  );
}

/** Catálogo de funciones UNA vez por página (HU #12087), igual que compañías / proveedores. */
function useCatalogoFunciones(): CatalogoFuncionesEstado {
  const [grupos, setGrupos] = useState<GrupoDeFunciones[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);
  useEffect(() => {
    let vivo = true;
    setGrupos(null); setError(null);
    permisosApi.funciones()
      .then((r) => { if (vivo) setGrupos(Array.isArray(r?.grupos) ? r.grupos : []); })
      .catch((e) => { if (vivo) setError(errorMessage(e)); });
    return () => { vivo = false; };
  }, [recarga]);
  return { grupos, error, recargar: () => setRecarga((n) => n + 1) };
}

/**
 * Catálogo de roles UNA vez por página (HU #12088): mapa `codigo → tipoEnlace` + lista para el
 * `<select>`. Incluye inactivos en el mapa (celda / edición con rol heredado).
 */
function useCatalogoRoles(): RolOpcion[] | null {
  const [roles, setRoles] = useState<RolOpcion[] | null>(null);
  useEffect(() => {
    let vivo = true;
    permisosApi.roles()
      .then((r) => {
        if (!vivo) return;
        const lista = Array.isArray(r?.roles) ? r.roles : [];
        setRoles(lista.map(rolAOpcion));
      })
      .catch(() => { if (vivo) setRoles([]); });
    return () => { vivo = false; };
  }, []);
  return roles;
}

function rolAOpcion(r: RolCatalogo): RolOpcion {
  return { value: r.codigo, label: r.nombre, tipoEnlace: r.tipoEnlace, activo: r.activo };
}

/**
 * ¿Lo que llegó es un resumen? La comprobación NO sobra por tener el contrato escrito.
 *
 * `api.get<ResumenUsuarios>` es una promesa del programador, no del servidor: `request` devuelve lo
 * que parseó y el tipo solo dice cómo pensamos leerlo. Cuando lo que llega es otra cosa —un proxy
 * que responde `[]`, una ruta que aún no existe en el entorno, el catch-all de los E2E— leer
 * `.porRol` de eso lanza dentro del render y la pantalla ENTERA se queda en blanco: se perdería la
 * tabla de usuarios por un conteo decorativo. Con la guarda, el conteo no se pinta y el resto sigue.
 *
 * Se comprueba la forma que desreferencia el ÁRBOL DE COMPONENTES, no solo este archivo: aquí el
 * objeto se pasa entero a `UsersToolbar`, y su `ConteoPorRol` lee además `activos` e `inactivos`.
 * Por eso los tres campos son obligatorios. Un `{ porRol: { admin: 7 } }` pelado pasaba la guarda
 * vieja y pintaba «Administrador: 7 · activos · inactivos»: dos etiquetas sin número, sin error y
 * sin aviso, que es justo el estado silenciosamente incompleto que esta guarda existe para evitar.
 * Se exige `number` finito porque un `NaN` no rompería el render pero se leería como un dato.
 *
 * `porRol` trae hoy los doce roles y los vacíos en `0`, así que aquí no se rellena ningún hueco: el
 * resumen llega entero o no se pinta.
 */
const esConteo = (valor: unknown): valor is number => typeof valor === 'number' && Number.isFinite(valor);

function esResumen(valor: unknown): valor is ResumenUsuarios {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) return false;
  const { porRol, activos, inactivos } = valor as { porRol?: unknown; activos?: unknown; inactivos?: unknown };
  if (typeof porRol !== 'object' || porRol === null || Array.isArray(porRol)) return false;
  return esConteo(activos) && esConteo(inactivos);
}

/**
 * El total de coincidencias tal y como lo declara `X-Total-Count`, con las filas recibidas de
 * respaldo.
 *
 * La cabecera puede no venir —un proxy que no la exponga, un backend anterior a la HU #12172— y
 * puede venir con basura. Se acepta solo un entero no negativo; cualquier otra cosa cae al número de
 * filas, que es un dato cierto aunque sea el de la página. Lo que no puede pasar es que se pinte
 * «NaN coinciden con el filtro».
 */
function totalDeCabecera(valor: string | null, filas: number): number {
  const n = Number(valor);
  return valor !== null && valor.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : filas;
}
