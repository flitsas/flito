import { createContext, useCallback, useContext, useMemo, useRef, useState, useEffect, ReactNode } from 'react';
import { api, permisosApi, setToken, clearToken, SESSION_ENDED_EVENT } from './api';
import { limpiarAvisos } from './conciliacionAviso';
import { hasFuncion as hasFuncionDe, type UserRole } from './permissions';

interface User {
  id: number;
  username: string;
  name: string;
  role: UserRole;
  allowedPages: string[];
  /**
   * HU #13425: códigos de las funciones EFECTIVAS del usuario (mismo resolutor que decide en el
   * servidor), ordenados. Opcional: un `/me` anterior no la trae. La web aún no la consume aquí.
   */
  funciones?: string[];
  transitoCodigo?: string | null;
  /** Correo del usuario (HU #13255). Lo pinta solo `/perfil`; nunca va a consola ni a la URL. */
  email?: string | null;
  /** Nombre de negocio del rol en `permisos_roles` (HU #13255): sirve también a roles del panel. */
  rolNombre?: string | null;
  /**
   * Capacidad de interfaz del canal Cliente (Feature #11912, HU #11914): ¿la compañía de este
   * usuario tiene encendido «SOAT sin trámite»?
   *
   * La calcula el servidor en `GET /auth/me` desde los permisos (HU #13425: función
   * `soat.solicitud.crear` + principal externo + compañía con SOAT sin trámite), nunca por el nombre
   * del rol; sin la función vale `false` sin JOIN. Viaja aquí y no en el sobre de la cola por dos motivos: `/me`
   * resuelve ANTES de que la cola termine —así el botón «Solicitar SOAT» no parpadea de «puedo» a
   * «no puedo»— y es una capacidad del usuario, no una propiedad de una página de resultados. El
   * precedente exacto es `transitoCodigo`, aquí arriba.
   *
   * **No es la frontera de seguridad y no debe tratarse como tal.** Los dos endpoints del canal
   * vuelven a comprobar el flag y responden `403`; esta bandera solo decide qué se pinta. El caso
   * del `/me` viejo —el flag se apaga mientras se llena el formulario— lo resuelve la pantalla
   * leyendo ese 403, no este booleano.
   *
   * `?` y no `| null`: un `/me` anterior a esta HU no la trae, y ausente significa «no».
   */
  puedeSolicitarSoat?: boolean;
  /**
   * HU #12872: frontera interno/externo de `/permisos/mios`, fusionada por el provider en el `user`
   * del contexto (no viene de `/auth/me`). La consume la Ayuda; no es el nombre del rol.
   */
  tipoPrincipal?: 'interno' | 'externo' | null;
}

/** ¿Este usuario puede radicar una solicitud del canal Cliente? Por capacidad, nunca por rol. */
export function puedeSolicitarSoat(user: { puedeSolicitarSoat?: boolean } | null | undefined): boolean {
  return user?.puedeSolicitarSoat === true;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  /**
   * Funciones efectivas de `GET /api/permisos/mios` (HU #12170).
   * `null` = aún no llegaron → `hasFuncion` es fail-closed (AC1).
   */
  funciones: string[] | null;
  /** Atajo reactivo al helper de `permissions.ts`. */
  hasFuncion: (codigo: string) => boolean;
  /**
   * Frontera interno/externo del principal (`/permisos/mios`, HU #12872). No es el nombre del rol:
   * la usa la Ayuda para no ofrecer fichas internas a un usuario externo. `null` = aún no llegó.
   */
  tipoPrincipal: 'interno' | 'externo' | null;
  /**
   * `true` si la PRIMERA carga de `/permisos/mios` falló (red/5xx). «No saber no es no tener»: la
   * guarda de ruta muestra un aviso con reintento en vez de «sin acceso» (HU #12872, UX §1).
   */
  permisosError: boolean;
  /**
   * HU #12872 (AC7): vuelve a pedir `/auth/me` y `/permisos/mios` y actualiza la foto de sesión SOLO
   * si cambió algo. Un fallo transitorio CONSERVA la foto anterior (nunca vacía el menú). Una sola
   * petición en vuelo: las llamadas concurrentes reutilizan la misma promesa.
   */
  refrescarSesion: () => Promise<void>;
  /** Alias histórico de `refrescarSesion` (lo usa Roles y permisos tras editar el propio cuadro). */
  refrescarFunciones: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

/** Huella estable de lo que decide qué se pinta: si no cambia, el refresco no re-renderiza el árbol. */
function huellaUsuario(u: User): string {
  return JSON.stringify({ ...u, allowedPages: [...(u.allowedPages ?? [])].sort(), funciones: [...(u.funciones ?? [])].sort() });
}

function mismasFunciones(a: readonly string[] | null, b: readonly string[]): boolean {
  if (!a || a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((c, i) => c === sb[i]);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  // `null` hasta que `/mios` responda: los botones no se pintan permitidos (AC1).
  const [funciones, setFunciones] = useState<string[] | null>(null);
  const [tipoPrincipal, setTipoPrincipal] = useState<'interno' | 'externo' | null>(null);
  const [permisosError, setPermisosError] = useState(false);
  const enVuelo = useRef<Promise<void> | null>(null);

  const cargarMios = useCallback(async () => {
    try {
      const mios = await permisosApi.mios();
      setFunciones(mios.funciones);
      setTipoPrincipal(mios.tipoPrincipal ?? null);
      setPermisosError(false);
    } catch {
      // Sin `/mios` no inventamos un conjunto: vacío = «llegó y no puede nada» (fail-closed). Y se
      // marca el error para que la guarda diga «no pudimos comprobar», no «no tienes acceso».
      setFunciones([]);
      setPermisosError(true);
    }
  }, []);

  const refrescarSesion = useCallback((): Promise<void> => {
    if (enVuelo.current) return enVuelo.current;
    if (!localStorage.getItem('token')) return Promise.resolve();
    const p = (async () => {
      const [me, mios] = await Promise.allSettled([api.get<User>('/auth/me'), permisosApi.mios()]);
      // `prev == null` = la sesión se cerró mientras volaba la petición: no se resucita.
      if (me.status === 'fulfilled') {
        setUser((prev) => (prev == null || huellaUsuario(prev) === huellaUsuario(me.value) ? prev : me.value));
      }
      if (mios.status === 'fulfilled') {
        const nuevas = mios.value.funciones;
        setFunciones((prev) => (mismasFunciones(prev, nuevas) ? prev : nuevas));
        setTipoPrincipal(mios.value.tipoPrincipal ?? null);
        setPermisosError(false);
      }
      // Fallo de red/5xx: se CONSERVA la foto anterior. El 401 lo resuelve `SESSION_ENDED_EVENT`.
    })().finally(() => { enVuelo.current = null; });
    enVuelo.current = p;
    return p;
  }, []);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      // Cuarto camino, y el que no hace ninguna petición: la pestaña arranca ya sin token. Barre
      // igual, porque `localStorage` se comparte entre pestañas y `sessionStorage` no: cerrar sesión
      // en OTRA pestaña se lleva el token de esta —es el mismo— pero no sus avisos, y nadie escucha
      // el evento `storage`. Sin token no hay sesión cuyo aviso convenga preservar.
      limpiarAvisos();
      setFunciones(null);
      setTipoPrincipal(null);
      setLoading(false);
      return;
    }
    api.get<User>('/auth/me')
      .then(async (u) => {
        setUser(u);
        await cargarMios();
      })
      // El mismo barrido que hacen `logout` y `SESSION_ENDED`, y por el mismo motivo: aquí se
      // arranca con un token que ya no sirve, y la sesión anterior no llegó a cerrarse por ninguno de
      // esos dos caminos —el 401 emite el evento, pero un 502 del proxy o la API caída no—. Sin esto,
      // los avisos de conciliación (importes y saldos de bolsa) se quedan en la pestaña.
      .catch(() => { clearToken(); limpiarAvisos(); setFunciones(null); })
      .finally(() => setLoading(false));
  }, [cargarMios]);

  // F-2: fin de sesión emitido por api.ts (401) → logout SPA. Al poner user=null,
  // ProtectedRoute redirige a /login sin recargar la página. El motivo y la ruta
  // previa quedan en sessionStorage para que Login los muestre/restaure.
  //
  // Y por eso mismo hay que BARRER lo que dejó la sesión anterior: como no se recarga, el
  // `sessionStorage` de la pestaña sobrevive intacto al cambio de usuario. `limpiarAvisos()` quita
  // los avisos de conciliación —importes y saldos de bolsa— tanto aquí como en `logout`: una sesión
  // que expira sola deja exactamente el mismo rastro que una que se cierra a mano.
  useEffect(() => {
    const onSessionEnded = () => {
      clearToken();
      limpiarAvisos();
      setUser(null);
      setFunciones(null);
      setTipoPrincipal(null);
      setPermisosError(false);
    };
    window.addEventListener(SESSION_ENDED_EVENT, onSessionEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onSessionEnded);
  }, []);

  const login = async (username: string, password: string) => {
    const res = await api.post<{ token: string; user: User }>('/auth/login', { username, password });
    setToken(res.token);
    setUser(res.user);
    // Fail-closed hasta que llegue `/mios`: no reutilizar funciones de otra sesión.
    setFunciones(null);
    await cargarMios();
  };

  const logout = () => {
    clearToken();
    limpiarAvisos();
    setUser(null);
    setFunciones(null);
    setTipoPrincipal(null);
    setPermisosError(false);
  };

  const hasFuncion = useCallback(
    (codigo: string) => hasFuncionDe(funciones, codigo),
    [funciones],
  );

  // El `user` del contexto lleva `tipoPrincipal` (de `/mios`) para que Ayuda y menú no miren el rol.
  const userCtx = useMemo(() => (user ? { ...user, tipoPrincipal } : null), [user, tipoPrincipal]);

  return (
    <AuthContext.Provider value={{
      user: userCtx, loading, funciones, tipoPrincipal, permisosError, hasFuncion,
      refrescarSesion, refrescarFunciones: refrescarSesion, login, logout,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
