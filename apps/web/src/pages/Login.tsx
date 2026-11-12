import { useState, useEffect, useRef, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { consumeSessionEndReason, consumeRedirectPath, type SessionEndReason } from '../lib/api';
import toast from 'react-hot-toast';
import { FLIT_LEGAL_NAME, FLIT_PRODUCT_NAME } from '../lib/flitBrand';
import { GlifoSvg } from '../components/flit/kit/GlifoSvg';
import { GLIFOS_INGRESO as G } from '../components/flit/kit/iconos-ingreso.generated';

const SESSION_END_MESSAGE: Record<SessionEndReason, string> = {
  invalidated: 'Tu acceso fue actualizado por un administrador. Inicia sesión de nuevo para continuar.',
  expired: 'Tu sesión expiró por seguridad. Inicia sesión para continuar.',
};

// Ingreso del UI Kit 2026, versión «sobria» (bloque final de ui-kit-2026.css; Ingreso de flit develop):
// a la izquierda el panel de tinta (en los dos temas) con el avance real de una operación en un panel blanco;
// a la derecha la tarjeta del formulario. El panel de marca es un <div> (no <section>). Por debajo de `lg`
// el panel de tinta se compacta (sin panel de avance ni productos) para que el formulario quede a la vista.
// Este archivo vive en el chunk de entrada (/login): solo usa el subconjunto de glifos del ingreso.
export default function Login() {
  const [username, setUsername] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [showPass, setShowPass] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [sessionEndReason] = useState<SessionEndReason | null>(() => consumeSessionEndReason());
  const bannerRef = useRef<HTMLDivElement>(null);
  const { login } = useAuth();
  const navigate = useNavigate();

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
    <div className="flit-auth ingreso" data-kit="ingreso">
      <div className="ingreso__marca max-lg:!min-h-0 max-lg:!gap-4 max-lg:!py-8">
        <img className="ingreso__logo" src="/kit/logo-oscuro.svg" alt="FLIT" />
        <div className="ingreso__texto">
          <p className="ingreso__ante">{FLIT_PRODUCT_NAME} · Operación vehicular</p>
          <h1 className="ingreso__titular">Tu flota, bajo control.</h1>
          <p className="ingreso__lead max-lg:hidden">
            Gestión integral de trámites, SOAT, manifiestos RNDC y cumplimiento PESV en una sola plataforma.
          </p>
        </div>
        <div className="ingreso__panel max-lg:!hidden" aria-hidden="true">
          <div className="ingreso__panel-cab">
            <span className="ingreso__placa">KLM 482</span>
            <span><strong>Despacho de documentos</strong><small>Licencia y placas · Medellín</small></span>
            <span className="ingreso__panel-estado">En ruta</span>
          </div>
          <ol className="ingreso__pasos">
            <li className="hecho">Recepción</li><li className="hecho">Revisión</li><li className="actual">En ruta</li><li>Entrega</li>
          </ol>
          <ul className="ingreso__hechos">
            <li><span className="kico"><GlifoSvg glifo={G.pluma} /></span><span><strong>Acta de entrega firmada</strong><small>Hace 2 min</small></span></li>
            <li><span className="kico"><GlifoSvg glifo={G.escudo} /></span><span><strong>SOAT e impuestos al día</strong><small>Validado en fuentes oficiales</small></span></li>
            <li><span className="kico"><GlifoSvg glifo={G.radicacion} /></span><span><strong>Trámite radicado en el organismo</strong><small>Secretaría de Movilidad</small></span></li>
          </ul>
        </div>
        <ul className="ingreso__productos max-lg:!hidden" aria-label="Productos de FLIT">
          <li><span className="kico"><GlifoSvg glifo={G.tramites} /></span><span>Trámites</span></li>
          <li><span className="kico"><GlifoSvg glifo={G.comparendos} /></span><span>Comparendos</span></li>
          <li><span className="kico"><GlifoSvg glifo={G.ruta} /></span><span>{FLIT_PRODUCT_NAME}</span></li>
        </ul>
        <p className="ingreso__pie max-lg:hidden">ISO 27001 · Decreto 1079/2015 · © {year} {FLIT_LEGAL_NAME}</p>
      </div>

      <main className="ingreso__form">
        <div className="ingreso__tarjeta">
          <img className="ingreso__logo-form logo--claro" src="/kit/logo-claro.svg" alt="" aria-hidden="true" />
          <img className="ingreso__logo-form logo--oscuro" src="/kit/logo-oscuro.svg" alt="" aria-hidden="true" />
          <div>
            <h2>Iniciar sesión</h2>
            <p className="nota">Accede a {FLIT_PRODUCT_NAME}</p>
          </div>

          {/* Fin de sesión: aviso informativo (no es error), con el foco para que se anuncie. */}
          {sessionEndReason && (
            <div ref={bannerRef} tabIndex={-1} role="status" aria-live="polite" className="kit-alerta outline-none" data-tono="info">
              <img src="/kit/aviso-info.svg" alt="" aria-hidden="true" className="kit-alerta__icono" />
              <p className="m-0 text-sm">{SESSION_END_MESSAGE[sessionEndReason]}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="grid gap-[18px]" noValidate>
            <div className="campo">
              <label htmlFor="login-username">Usuario</label>
              <div className="control-icono">
                <GlifoSvg glifo={G.persona} size={18} className="i" />
                <input id="login-username" name="username" type="text" autoComplete="username" value={username}
                  onChange={(e) => setUsername(e.target.value)} required placeholder="nombre.usuario" className="control" />
              </div>
            </div>

            <div className="campo">
              <label htmlFor="login-password">Contraseña</label>
              <div className="clave control-icono relative">
                <GlifoSvg glifo={G.candado} size={18} className="i" />
                <input id="login-password" name="password" type={showPass ? 'text' : 'password'} autoComplete="current-password"
                  value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="••••••••" className="control pr-12" />
                <button type="button" onClick={() => setShowPass((v) => !v)}
                  aria-label={showPass ? 'Ocultar contraseña' : 'Mostrar contraseña'} aria-pressed={showPass}
                  className="grid place-items-center !text-[color:var(--kit-azul)] transition-colors">
                  <GlifoSvg glifo={showPass ? G['ojo-tachado'] : G.ojo} size={20} />
                </button>
              </div>
            </div>

            <button type="submit" disabled={loading || !username || !password} aria-busy={loading || undefined}
              className="btn ingreso__boton" data-variante="primario">
              {loading ? <span>Verificando…</span> : <span>Ingresar</span>}
            </button>
          </form>

          <p className="ingreso__ayuda">Conexión cifrada · {FLIT_LEGAL_NAME} · {year}</p>
        </div>
      </main>
    </div>
  );
}
