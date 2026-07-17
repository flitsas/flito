import { useState, useEffect, useRef, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { consumeSessionEndReason, consumeRedirectPath, type SessionEndReason } from '../lib/api';
import toast from 'react-hot-toast';
import { FLIT_LEGAL_NAME, FLIT_PRODUCT_NAME } from '../lib/flitBrand';

const SESSION_END_MESSAGE: Record<SessionEndReason, string> = {
  invalidated: 'Tu acceso fue actualizado por un administrador. Inicia sesión de nuevo para continuar.',
  expired: 'Tu sesión expiró por seguridad. Inicia sesión para continuar.',
};

// =============================================================
//   LOGIN — Patrón FLIT (prototipo PDF p.1)
//   Pantalla partida: panel visual izquierdo con gradiente de marca
//   (turquesa→azul) + tarjeta blanca de formulario a la derecha.
//   Inputs con icono lineal a la izquierda, CTA pastilla con
//   gradiente. Tokens scoped en styles/flit-tokens.css (.flit-auth).
//   Lógica de auth conservada: useAuth, banner sesión, toast error,
//   navigate(consumeRedirectPath()).
// =============================================================

// ---------- Iconografía lineal (stroke 1.6, currentColor) ----------
const IconUser = ({ className = '' }: { className?: string }) => (
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
    strokeLinecap="round" strokeLinejoin="round" className={className}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-3.6 3.6-6 8-6s8 2.4 8 6" />
  </svg>
);

const IconLock = ({ className = '' }: { className?: string }) => (
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
    strokeLinecap="round" strokeLinejoin="round" className={className}>
    <rect x="4" y="11" width="16" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);

const IconEye = ({ className = '' }: { className?: string }) => (
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
    strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const IconEyeOff = ({ className = '' }: { className?: string }) => (
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
    strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
    <path d="M10.73 5.08A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a13 13 0 0 1-1.67 2.68" />
    <path d="M6.61 6.61A13 13 0 0 0 2 12s3.5 7 10 7a10.4 10.4 0 0 0 5.39-1.61" />
    <path d="m2 2 20 20" />
  </svg>
);

const IconShield = ({ className = '' }: { className?: string }) => (
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
    strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);

const IconSpinner = ({ className = '' }: { className?: string }) => (
  <svg aria-hidden="true" className={`animate-spin motion-reduce:animate-none ${className}`}
    xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4Z" />
  </svg>
);

export default function Login() {
  const [username, setUsername] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [showPass, setShowPass] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  // Motivo de fin de sesión (consumido una sola vez al montar) → banner informativo.
  const [sessionEndReason] = useState<SessionEndReason | null>(() => consumeSessionEndReason());
  const bannerRef = useRef<HTMLDivElement>(null);
  const { login } = useAuth();
  const navigate = useNavigate();

  // Mueve el foco al banner cuando la sesión terminó, para que lectores de pantalla
  // anuncien el motivo y el usuario teclado lo perciba antes del formulario.
  useEffect(() => {
    if (sessionEndReason) bannerRef.current?.focus();
  }, [sessionEndReason]);

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setLoading(true);
    try {
      await login(username, password);
      navigate(consumeRedirectPath());
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error al iniciar sesión';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const year = new Date().getFullYear();

  return (
    <div className="flit-auth grid min-h-screen w-full lg:grid-cols-[55fr_45fr]">
      {/* ===== PANEL IZQUIERDO — gradiente de marca FLIT (turquesa→azul). ===== */}
      <aside
        className="relative hidden lg:flex flex-col justify-between p-12 xl:p-16 text-white overflow-hidden"
        style={{ background: 'var(--flit-gradient-sidebar)' }}
      >
        {/* Marca */}
        <header className="flex items-center gap-3">
          <span className="grid place-items-center w-10 h-10 rounded-xl bg-white/15 backdrop-blur-sm">
            <IconShield className="w-5 h-5" />
          </span>
          <span className="text-lg font-semibold tracking-tight">{FLIT_PRODUCT_NAME}</span>
        </header>

        {/* Claim operacional */}
        <div className="flex flex-col gap-5 max-w-[34ch]">
          <h1 className="text-4xl xl:text-5xl font-bold leading-[1.1]">
            Tu flota, bajo control.
          </h1>
          <p className="text-base xl:text-lg text-white/85 leading-relaxed">
            Gestión integral de trámites, SOAT, manifiestos RNDC y cumplimiento PESV
            en una sola plataforma.
          </p>
        </div>

        {/* Footer legal */}
        <footer className="flex items-center gap-3 text-xs text-white/75">
          <IconShield className="w-4 h-4 shrink-0" />
          <span>ISO 27001 · Decreto 1079/2015 · © {year} {FLIT_LEGAL_NAME}</span>
        </footer>
      </aside>

      {/* ===== PANEL DERECHO — tarjeta blanca de formulario. ===== */}
      <main className="relative flex items-center justify-center px-5 py-10 sm:px-8">
        <div className="w-full max-w-[420px] flex flex-col gap-6">
          {/* Header de marca SOLO mobile (el panel izq está oculto en mobile). */}
          <header className="lg:hidden flex items-center justify-center gap-3"
            style={{ color: 'var(--flit-blue-text)' }}>
            <span className="grid place-items-center w-9 h-9 rounded-xl text-white"
              style={{ background: 'var(--flit-gradient-sidebar)' }}>
              <IconShield className="w-5 h-5" />
            </span>
            <span className="text-base font-semibold tracking-tight">{FLIT_PRODUCT_NAME}</span>
          </header>

          {/* Tarjeta del formulario */}
          <section
            className="bg-white p-7 sm:p-9"
            style={{
              borderRadius: 'var(--flit-radius-card)',
              boxShadow: 'var(--flit-shadow-card)',
              border: '1px solid var(--flit-border-soft)',
            }}
          >
            {/* Título */}
            <header className="flex flex-col gap-1.5 mb-7">
              <h2 className="text-2xl font-bold tracking-tight" style={{ color: 'var(--flit-blue-text)' }}>
                Iniciar sesión
              </h2>
              <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
                Accede a {FLIT_PRODUCT_NAME}
              </p>
            </header>

            {/* Banner informativo de fin de sesión — no es error: tono calmado. */}
            {sessionEndReason && (
              <div
                ref={bannerRef}
                tabIndex={-1}
                role="status"
                aria-live="polite"
                className="mb-6 flex items-start gap-3 px-4 py-3 outline-none flit-focus"
                style={{
                  borderRadius: 'var(--flit-radius-input)',
                  border: '1px solid var(--flit-info)',
                  background: 'rgba(79, 116, 201, 0.08)',
                }}
              >
                <svg className="mt-0.5 h-4 w-4 shrink-0" style={{ color: 'var(--flit-info)' }}
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8h.01M11 12h1v4h1" />
                </svg>
                <p className="text-sm leading-relaxed" style={{ color: 'var(--flit-text-secondary)' }}>
                  {SESSION_END_MESSAGE[sessionEndReason]}
                </p>
              </div>
            )}

            <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate>
              {/* Usuario */}
              <div className="flex flex-col gap-1.5">
                <label htmlFor="login-username" className="text-sm font-semibold"
                  style={{ color: 'var(--flit-text-primary)' }}>
                  Usuario
                </label>
                <div className="relative">
                  <span aria-hidden="true"
                    className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2"
                    style={{ color: 'var(--flit-text-muted)' }}>
                    <IconUser className="w-[18px] h-[18px]" />
                  </span>
                  <input
                    id="login-username"
                    name="username"
                    type="text"
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    placeholder="nombre.usuario"
                    className="flit-focus w-full bg-white pl-11 pr-4 text-base outline-none transition-shadow"
                    style={{
                      height: 'var(--flit-input-height)',
                      borderRadius: 'var(--flit-radius-input)',
                      border: '1px solid var(--flit-border-input)',
                      color: 'var(--flit-text-primary)',
                    }}
                  />
                </div>
              </div>

              {/* Contraseña */}
              <div className="flex flex-col gap-1.5">
                <label htmlFor="login-password" className="text-sm font-semibold"
                  style={{ color: 'var(--flit-text-primary)' }}>
                  Contraseña
                </label>
                <div className="relative">
                  <span aria-hidden="true"
                    className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2"
                    style={{ color: 'var(--flit-text-muted)' }}>
                    <IconLock className="w-[18px] h-[18px]" />
                  </span>
                  <input
                    id="login-password"
                    name="password"
                    type={showPass ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    placeholder="••••••••"
                    className="flit-focus w-full bg-white pl-11 pr-12 text-base outline-none transition-shadow"
                    style={{
                      height: 'var(--flit-input-height)',
                      borderRadius: 'var(--flit-radius-input)',
                      border: '1px solid var(--flit-border-input)',
                      color: 'var(--flit-text-primary)',
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass((v) => !v)}
                    aria-label={showPass ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                    aria-pressed={showPass}
                    className="flit-focus absolute right-2 top-1/2 -translate-y-1/2 grid place-items-center
                               w-9 h-9 rounded-lg transition-colors hover:bg-black/5"
                    style={{ color: 'var(--flit-text-muted)' }}
                  >
                    {showPass ? <IconEyeOff className="w-[18px] h-[18px]" /> : <IconEye className="w-[18px] h-[18px]" />}
                  </button>
                </div>
              </div>

              {/* CTA — pastilla con gradiente FLIT. */}
              <button
                type="submit"
                disabled={loading || !username || !password}
                className="flit-focus mt-1 inline-flex items-center justify-center gap-2.5 w-full
                           text-base font-semibold text-white
                           disabled:opacity-55 disabled:cursor-not-allowed
                           transition-transform motion-safe:active:scale-[0.99]"
                style={{
                  height: 'var(--flit-button-height)',
                  borderRadius: 'var(--flit-radius-pill)',
                  background: 'var(--flit-gradient-primary)',
                  boxShadow: 'var(--flit-shadow-button)',
                }}
              >
                {loading ? (
                  <>
                    <IconSpinner className="w-5 h-5" />
                    <span>Verificando…</span>
                  </>
                ) : (
                  <span>Ingresar</span>
                )}
              </button>
            </form>
          </section>

          {/* Pie — conexión cifrada. */}
          <footer className="flex items-center justify-center gap-2 text-xs"
            style={{ color: 'var(--flit-text-muted)' }}>
            <IconLock className="w-3.5 h-3.5" />
            <span>Conexión cifrada · {FLIT_LEGAL_NAME} · {year}</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
