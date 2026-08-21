import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { api, setToken, clearToken, SESSION_ENDED_EVENT } from './api';
import { limpiarAvisos } from './conciliacionAviso';
import type { UserRole } from './permissions';

interface User {
  id: number;
  username: string;
  name: string;
  role: UserRole;
  allowedPages: string[];
  transitoCodigo?: string | null;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      setLoading(false);
      return;
    }
    api.get<User>('/auth/me')
      .then(setUser)
      .catch(() => clearToken())
      .finally(() => setLoading(false));
  }, []);

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
    };
    window.addEventListener(SESSION_ENDED_EVENT, onSessionEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onSessionEnded);
  }, []);

  const login = async (username: string, password: string) => {
    const res = await api.post<{ token: string; user: User }>('/auth/login', { username, password });
    setToken(res.token);
    setUser(res.user);
  };

  const logout = () => {
    clearToken();
    limpiarAvisos();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
