import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import FlitModal from '../components/flit/FlitModal';
import GradientButton from '../components/flit/GradientButton';
import { Vacio } from '../components/flit/Cargador';
import { Icono } from '../components/flit/kit/Icono';
import { FlitCard, FlitField, flitInp } from '../components/flit/flitPageKit';
import { toastOk } from '../components/flit/ToastFlito';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ROLE_LABELS } from '../lib/permissions';

// Mi perfil (HU #13256, spec `docs/ux/perfil.md`).
//
// Quien llega aquí viene a cambiar su propia contraseña y, de paso, a confirmar con qué cuenta está
// dentro. Rediseño 2026 (molde `#perfil`, Épica #14560): cabecera «Mi perfil» con la acción «Cambiar
// contraseña» (la única primaria), tarjeta «Su cuenta» (solo lectura) y el formulario en un FlitModal.
// El menú de usuario del shell navega a `/perfil?accion=contrasena`: el parámetro abre el modal y al
// cerrarlo se limpia con `replace` para que «atrás» no lo reabra. Sin compañía, tránsito, proveedor ni IDs.
//
// Los errores de un campo van BAJO el campo, no en toast (diferencia deliberada con
// `pages/users/PasswordForm.tsx`); el 5xx/red/429 va en un aviso del formulario; solo el éxito es
// toast. Nunca se muestra el texto crudo del API.

/**
 * Lo que `GET /auth/perfil` trae (HU #13428, guarda «Ver mis datos») y esta pantalla pinta. Desde la
 * HU #13431 no se lee `/auth/me`: los datos propios tienen su propio permiso. `role` no viene del
 * endpoint; es el código de la sesión, solo para la etiqueta de respaldo.
 */
interface Yo {
  username?: string | null;
  name?: string | null;
  email?: string | null;
  role?: string | null;
  rolNombre?: string | null;
}

type Carga = { estado: 'cargando' } | { estado: 'error' } | { estado: 'listo'; yo: Yo };

/**
 * La misma política que el servidor (`users.routes.ts`) y que `PASSWORD_PATTERN` de
 * `pages/users/UserFormShared.tsx`. Se repite aquí y no se importa para no arrastrar aquel módulo
 * (AC9). Si el servidor cambia el regex, cambian los tres.
 */
const POLITICA = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*]).{8,}$/;

const COPY = {
  ayuda: 'Mínimo 8 caracteres, con mayúscula, minúscula, número y un carácter especial (! @ # $ % ^ & *).',
  vacioActual: 'Escriba su contraseña actual.',
  vacioNueva: 'Escriba la contraseña nueva.',
  vacioConfirma: 'Confirme la contraseña nueva.',
  politica: 'La contraseña nueva no cumple los requisitos de abajo.',
  noCoincide: 'No coincide con la contraseña nueva.',
  actualIncorrecta: 'La contraseña actual no es correcta.',
  demasiados: 'Demasiados intentos. Espere unos minutos y vuelva a intentarlo.',
  general: 'No pudimos guardar la contraseña. Intente de nuevo en un momento.',
  exito: 'Su contraseña se actualizó.',
} as const;

const texto = (v: string | null | undefined): string => (typeof v === 'string' ? v.trim() : '');

/** `rolNombre ?? ROLE_LABELS[role] ?? role` (decisión humana de la HU #13256). */
function etiquetaRol(yo: Yo): string {
  const nombre = texto(yo.rolNombre);
  if (nombre) return nombre;
  const codigo = texto(yo.role);
  if (!codigo) return '';
  return (ROLE_LABELS as Record<string, string | undefined>)[codigo] ?? codigo;
}

export default function Perfil() {
  const { user, hasFuncion } = useAuth();
  const [carga, setCarga] = useState<Carga>({ estado: 'cargando' });
  const [intento, setIntento] = useState(0);
  const rolSesion = user?.role ?? null;

  useEffect(() => {
    let vivo = true;
    setCarga({ estado: 'cargando' });
    api.get<Yo>('/auth/perfil')
      .then((yo) => { if (vivo) setCarga(yo && typeof yo === 'object' ? { estado: 'listo', yo: { ...yo, role: rolSesion } } : { estado: 'error' }); })
      .catch(() => { if (vivo) setCarga({ estado: 'error' }); });
    return () => { vivo = false; };
  }, [intento, rolSesion]);

  // HU #13431: el formulario solo con «Cambiar mi contraseña»; el id es el de la sesión (el endpoint
  // de perfil no lo devuelve y el cambio es siempre sobre la cuenta propia).
  const puedeCambiar = hasFuncion('perfil.contrasena.cambiar') && typeof user?.id === 'number';

  // Contrato con el menú de usuario: `?accion=contrasena` abre el modal (sin PII en la URL).
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [abierto, setAbierto] = useState(false);
  const pedidoPorUrl = params.get('accion') === 'contrasena';
  const conFormulario = carga.estado === 'listo' && puedeCambiar;
  const cerrarModal = (): void => {
    setAbierto(false);
    if (pedidoPorUrl) navigate('/perfil', { replace: true });
  };

  const resumen = carga.estado === 'listo'
    ? [texto(carga.yo.name), etiquetaRol(carga.yo)].filter(Boolean).join(' · ')
    : '';

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Mi perfil"
        icono="flito-perfil"
        miga={[]}
        subtitle={resumen || 'Consulte los datos de su cuenta y cambie su contraseña.'}
        actions={conFormulario ? (
          <GradientButton type="button" onClick={() => setAbierto(true)}>
            <Icono nombre="ojo" size={16} />
            Cambiar contraseña
          </GradientButton>
        ) : undefined}
      />
      <div className="flex max-w-2xl flex-col gap-5 lg:gap-6">
        {carga.estado === 'cargando' && <Cargando />}
        {carga.estado === 'error' && <ErrorCarga onReintentar={() => setIntento((n) => n + 1)} />}
        {carga.estado === 'listo' && <SuCuenta yo={carga.yo} />}
      </div>
      {conFormulario && (abierto || pedidoPorUrl) && (
        <FlitModal title="Cambiar contraseña" icono="candado" onClose={cerrarModal}>
          <FormContrasena userId={user!.id} onExito={cerrarModal} />
        </FlitModal>
      )}
    </div>
  );
}

function TituloTarjeta({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h2 id={id} className="mb-4 text-2xl font-medium text-[color:var(--color-text-primary)]">
      {children}
    </h2>
  );
}

function Barra({ ancho, alto = 'h-3' }: { ancho: string; alto?: string }) {
  return <div className={`kit-esqueleto ${alto}`} style={{ width: ancho }} />;
}

function Cargando() {
  return (
    <div aria-busy="true" role="status" className="flex flex-col gap-5 lg:gap-6">
      <span className="sr-only">Cargando sus datos…</span>
      <FlitCard>
        <TituloTarjeta>Su cuenta</TituloTarjeta>
        <div aria-hidden="true" className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          {['6rem', '9rem', '5rem', '12rem'].map((w, i) => (
            <div key={i} className="flex flex-col gap-2"><Barra ancho="4rem" /><Barra ancho={w} alto="h-4" /></div>
          ))}
        </div>
      </FlitCard>
    </div>
  );
}

function ErrorCarga({ onReintentar }: { onReintentar: () => void }) {
  return (
    <FlitCard className="kit-vacio">
      <span className="kit-disco h-[72px] w-[72px] !text-[color:var(--kit-naranja)]" aria-hidden="true">
        <Icono nombre="nube-alerta" size={36} />
      </span>
      <div role="alert" data-kit="error">
        <p className="text-base font-semibold text-[color:var(--color-text-primary)]">No pudimos cargar sus datos.</p>
        <p className="mt-1 text-sm font-normal text-[color:var(--color-text-tertiary)]">Revise su conexión e intente de nuevo.</p>
      </div>
      <GradientButton type="button" variant="secondary" onClick={onReintentar} className="w-full justify-center sm:w-auto">
        <Icono nombre="reintento" size={16} />
        Reintentar
      </GradientButton>
    </FlitCard>
  );
}

function Dato({ rotulo, valor, ausente }: { rotulo: string; valor: string; ausente: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-light text-[color:var(--color-text-tertiary)]">{rotulo}</dt>
      <dd className={`mt-0.5 break-words text-base ${valor ? 'text-[color:var(--color-text-primary)]' : 'text-[color:var(--color-text-tertiary)]'}`}>
        {valor || ausente}
      </dd>
    </div>
  );
}

function SuCuenta({ yo }: { yo: Yo }) {
  const usuario = texto(yo.username);
  const nombre = texto(yo.name);
  const correo = texto(yo.email);
  const vacio = !usuario && !nombre && !correo;
  return (
    <FlitCard>
      <section aria-labelledby="perfil-su-cuenta">
        <TituloTarjeta id="perfil-su-cuenta">Su cuenta</TituloTarjeta>
        {vacio ? (
          <Vacio
            icono="persona"
            texto="Su cuenta no tiene datos de identidad registrados. Pida a su administrador de FLITO que los complete."
          />
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
            <Dato rotulo="Usuario" valor={usuario} ausente="Sin usuario registrado" />
            <Dato rotulo="Nombre" valor={nombre} ausente="Sin nombre registrado" />
            <Dato rotulo="Correo" valor={correo} ausente="Sin correo registrado" />
            <Dato rotulo="Rol" valor={etiquetaRol(yo)} ausente="Sin rol asignado" />
          </dl>
        )}
      </section>
    </FlitCard>
  );
}

type Campo = 'actual' | 'nueva' | 'confirma';
type Errores = Partial<Record<Campo, string>>;

function FormContrasena({ userId, onExito }: { userId: number; onExito: () => void }) {
  const [valores, setValores] = useState<Record<Campo, string>>({ actual: '', nueva: '', confirma: '' });
  const [errores, setErrores] = useState<Errores>({});
  const [general, setGeneral] = useState('');
  const [enviando, setEnviando] = useState(false);
  const refs: Record<Campo, RefObject<HTMLInputElement>> = {
    actual: useRef<HTMLInputElement>(null),
    nueva: useRef<HTMLInputElement>(null),
    confirma: useRef<HTMLInputElement>(null),
  };

  const fallo = (campo: Campo, mensaje: string): void => {
    setErrores({ [campo]: mensaje });
    refs[campo].current?.focus();
  };

  const cambiar = (campo: Campo, valor: string): void => {
    setValores((v) => ({ ...v, [campo]: valor }));
    if (errores[campo]) setErrores((e) => ({ ...e, [campo]: undefined }));
  };

  const enviar = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (enviando) return;
    setErrores({});
    setGeneral('');
    const { actual, nueva, confirma } = valores;
    if (!actual) return fallo('actual', COPY.vacioActual);
    if (!nueva) return fallo('nueva', COPY.vacioNueva);
    if (!confirma) return fallo('confirma', COPY.vacioConfirma);
    if (!POLITICA.test(nueva)) return fallo('nueva', COPY.politica);
    if (confirma !== nueva) return fallo('confirma', COPY.noCoincide);

    setEnviando(true);
    try {
      await api.patch<{ ok: boolean }>(`/users/${userId}/password`, { currentPassword: actual, newPassword: nueva });
      setValores({ actual: '', nueva: '', confirma: '' });
      toastOk(COPY.exito);
      refs.actual.current?.focus();
      onExito();
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      // Un 401 que NO es «contraseña actual» es la sesión que venció: `api.ts` ya la cerró.
      if (status === 401 && err instanceof ApiError && /actual/i.test(err.message)) fallo('actual', COPY.actualIncorrecta);
      else if (status === 400) fallo('nueva', COPY.politica);
      else if (status === 429) setGeneral(COPY.demasiados);
      else if (status !== 401) setGeneral(COPY.general);
    } finally {
      setEnviando(false);
    }
  };

  const describir = (campo: Campo, extra?: string): string | undefined =>
    [extra, errores[campo] ? `perfil-error-${campo}` : undefined].filter(Boolean).join(' ') || undefined;

  const campo = (id: Campo, label: string, autoComplete: string, extra?: ReactNode, ayudaId?: string) => (
    <div>
      <FlitField label={label}>
        <input
          ref={refs[id]}
          id={`perfil-${id}`}
          name={id}
          type="password"
          autoComplete={autoComplete}
          value={valores[id]}
          onChange={(ev) => cambiar(id, ev.target.value)}
          readOnly={enviando}
          aria-invalid={errores[id] ? true : undefined}
          aria-describedby={describir(id, ayudaId)}
          className={`${flitInp} h-10`}
        />
      </FlitField>
      {extra}
      {errores[id] && (
        <p id={`perfil-error-${id}`} role="alert" className="mt-1 text-xs font-medium text-[color:var(--kit-naranja-texto)]">
          {errores[id]}
        </p>
      )}
    </div>
  );

  return (
    <form noValidate onSubmit={enviar} aria-labelledby="perfil-cambiar" className="flex flex-col gap-4 text-left">
        {/* El título visible es el del FlitModal; este h2 conserva el nombre accesible del formulario. */}
        <h2 id="perfil-cambiar" className="sr-only">Cambiar contraseña</h2>
        {campo('actual', 'Contraseña actual', 'current-password')}
        {campo('nueva', 'Contraseña nueva', 'new-password', (
          <p id="perfil-ayuda" className="mt-1 text-xs text-[color:var(--color-text-tertiary)]">{COPY.ayuda}</p>
        ), 'perfil-ayuda')}
        {campo('confirma', 'Confirme la contraseña nueva', 'new-password')}
        {general && (
          <p role="alert" className="text-sm font-medium text-[color:var(--kit-naranja-texto)]">{general}</p>
        )}
        <div className="flex sm:justify-end">
          <GradientButton
            type="submit"
            ocupado={enviando}
            className="w-full justify-center sm:w-auto"
          >
            {enviando ? 'Guardando…' : 'Guardar contraseña'}
          </GradientButton>
        </div>
      </form>
  );
}
