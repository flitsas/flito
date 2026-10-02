import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import { FlitCard, FlitEmpty, FlitField, flitBtnPrimary, flitBtnPrimaryStyle, flitInp } from '../components/flit/flitPageKit';
import { toastOk } from '../components/flit/ToastFlito';
import { api, ApiError } from '../lib/api';
import { ROLE_LABELS } from '../lib/permissions';

// Mi perfil (HU #13256, spec `docs/ux/perfil.md`).
//
// Quien llega aquí viene a cambiar su propia contraseña y, de paso, a confirmar con qué cuenta está
// dentro. Dos tarjetas apiladas en una columna (`max-w-2xl`): «Su cuenta» (solo lectura) y «Cambiar
// contraseña» (la única primaria). Sin compañía, tránsito, proveedor SOAT ni IDs.
//
// Los errores de un campo van BAJO el campo, no en toast (diferencia deliberada con
// `pages/users/PasswordForm.tsx`); el 5xx/red/429 va en un aviso del formulario; solo el éxito es
// toast. Nunca se muestra el texto crudo del API.

/** Lo que `/auth/me` trae y esta pantalla pinta (contrato de la HU #13255). */
interface Yo {
  id: number;
  username?: string | null;
  name?: string | null;
  email?: string | null;
  role?: string | null;
  rolNombre?: string | null;
}

type Carga = { estado: 'cargando' } | { estado: 'error' } | { estado: 'listo'; yo: Yo };

/**
 * La misma política que el servidor (`users.routes.ts`) y que `PASSWORD_PATTERN` de
 * `pages/users/UserFormShared.tsx`. Se repite aquí y no se importa porque aquel módulo arrastra
 * `GradientButton`, que esta pantalla no usa (AC9). Si el servidor cambia el regex, cambian los tres.
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
  const [carga, setCarga] = useState<Carga>({ estado: 'cargando' });
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    let vivo = true;
    setCarga({ estado: 'cargando' });
    api.get<Yo>('/auth/me')
      .then((yo) => { if (vivo) setCarga(yo && typeof yo.id === 'number' ? { estado: 'listo', yo } : { estado: 'error' }); })
      .catch(() => { if (vivo) setCarga({ estado: 'error' }); });
    return () => { vivo = false; };
  }, [intento]);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard title="Mi perfil" subtitle="Consulte los datos de su cuenta y cambie su contraseña." />
      <div className="flex max-w-2xl flex-col gap-5 lg:gap-6">
        {carga.estado === 'cargando' && <Cargando />}
        {carga.estado === 'error' && <ErrorCarga onReintentar={() => setIntento((n) => n + 1)} />}
        {carga.estado === 'listo' && (
          <>
            <SuCuenta yo={carga.yo} />
            <FormContrasena userId={carga.yo.id} />
          </>
        )}
      </div>
    </div>
  );
}

function TituloTarjeta({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h2 id={id} className="mb-4 text-base font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
      {children}
    </h2>
  );
}

function Barra({ ancho, alto = 'h-3' }: { ancho: string; alto?: string }) {
  return <div className={`${alto} rounded-lg`} style={{ width: ancho, background: 'var(--flit-border-soft)' }} />;
}

function Cargando() {
  return (
    <div aria-busy="true" role="status" className="flex flex-col gap-5 lg:gap-6">
      <span className="sr-only">Cargando sus datos…</span>
      <FlitCard>
        <TituloTarjeta>Su cuenta</TituloTarjeta>
        <div aria-hidden="true" className="grid animate-pulse grid-cols-1 gap-x-6 gap-y-4 motion-reduce:animate-none sm:grid-cols-2">
          {['6rem', '9rem', '5rem', '12rem'].map((w, i) => (
            <div key={i} className="flex flex-col gap-2"><Barra ancho="4rem" /><Barra ancho={w} alto="h-4" /></div>
          ))}
        </div>
      </FlitCard>
      <FlitCard>
        <TituloTarjeta>Cambiar contraseña</TituloTarjeta>
        <div aria-hidden="true" className="flex animate-pulse flex-col gap-4 motion-reduce:animate-none">
          {[0, 1, 2].map((i) => <Barra key={i} ancho="100%" alto="h-10" />)}
        </div>
      </FlitCard>
    </div>
  );
}

function ErrorCarga({ onReintentar }: { onReintentar: () => void }) {
  return (
    <FlitCard>
      <div role="alert">
        <p className="text-sm font-semibold" style={{ color: 'var(--flit-danger-text)' }}>No pudimos cargar sus datos.</p>
        <p className="mt-1 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>Revise su conexión e intente de nuevo.</p>
      </div>
      <div className="mt-4 flex sm:justify-end">
        <button type="button" onClick={onReintentar} className={`${flitBtnPrimary} w-full justify-center sm:w-auto`} style={flitBtnPrimaryStyle}>
          Reintentar
        </button>
      </div>
    </FlitCard>
  );
}

function Dato({ rotulo, valor, ausente }: { rotulo: string; valor: string; ausente: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold" style={{ color: 'var(--flit-text-muted)' }}>{rotulo}</dt>
      <dd className="mt-0.5 break-words text-sm" style={{ color: valor ? 'var(--flit-text-primary)' : 'var(--flit-text-muted)' }}>
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
          <FlitEmpty>
            Su cuenta no tiene datos de identidad registrados. Pida a su administrador de FLITO que los complete.
          </FlitEmpty>
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

function FormContrasena({ userId }: { userId: number }) {
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
          style={errores[id] ? { borderColor: 'var(--flit-danger-text)' } : undefined}
        />
      </FlitField>
      {extra}
      {errores[id] && (
        <p id={`perfil-error-${id}`} role="alert" className="mt-1 text-xs font-medium" style={{ color: 'var(--flit-danger-text)' }}>
          {errores[id]}
        </p>
      )}
    </div>
  );

  return (
    <FlitCard>
      <form noValidate onSubmit={enviar} aria-labelledby="perfil-cambiar" className="flex flex-col gap-4">
        <h2 id="perfil-cambiar" className="text-base font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Cambiar contraseña</h2>
        {campo('actual', 'Contraseña actual', 'current-password')}
        {campo('nueva', 'Contraseña nueva', 'new-password', (
          <p id="perfil-ayuda" className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{COPY.ayuda}</p>
        ), 'perfil-ayuda')}
        {campo('confirma', 'Confirme la contraseña nueva', 'new-password')}
        {general && (
          <p role="alert" className="text-sm font-medium" style={{ color: 'var(--flit-danger-text)' }}>{general}</p>
        )}
        <div className="flex sm:justify-end">
          <button
            type="submit"
            disabled={enviando}
            aria-busy={enviando || undefined}
            className={`${flitBtnPrimary} w-full justify-center sm:w-auto`}
            style={flitBtnPrimaryStyle}
          >
            {enviando ? 'Guardando…' : 'Guardar contraseña'}
          </button>
        </div>
      </form>
    </FlitCard>
  );
}
