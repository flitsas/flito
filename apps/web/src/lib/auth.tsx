import { createContext, useCallback, useContext, useState, useEffect, ReactNode } from 'react';
import { api, permisosApi, setToken, clearToken, SESSION_ENDED_EVENT } from './api';
import { limpiarAvisos } from './conciliacionAviso';
import { hasFuncion as hasFuncionDe, type UserRole } from './permissions';

interface User {
  id: number;
  username: string;
  name: string;
  role: UserRole;
  allowedPages: string[];
  transitoCodigo?: string | null;
  /**
   * Capacidad de interfaz del canal Cliente (Feature #11912, HU #11914): ¿la compañía de este
   * usuario tiene encendido «SOAT sin trámite»?
   *
   * La calcula el servidor en `GET /auth/me` (`auth.routes.ts:157`) y vale `false` para todo rol
   * que no sea `cliente`, sin JOIN. Viaja aquí y no en el sobre de la cola por dos motivos: `/me`
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
  /** Vuelve a pedir `/mios` (p. ej. tras editar el propio cuadro en Roles y permisos). */
  refrescarFunciones: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  // `null` hasta que `/mios` responda: los botones no se pintan permitidos (AC1).
  const [funciones, setFunciones] = useState<string[] | null>(null);

  const cargarMios = useCallback(async () => {
    try {
      const mios = await permisosApi.mios();
      setFunciones(mios.funciones);
    } catch {
      // Sin `/mios` no inventamos un conjunto: vacío = «llegó y no puede nada» (fail-closed).
      setFunciones([]);
    }
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
  };

  const hasFuncion = useCallback(
    (codigo: string) => hasFuncionDe(funciones, codigo),
    [funciones],
  );

  return (
    <AuthContext.Provider value={{
      user, loading, funciones, hasFuncion, refrescarFunciones: cargarMios, login, logout,
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
