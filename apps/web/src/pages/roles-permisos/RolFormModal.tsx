// HU #12085 — Alta y edición de un rol (ficha §8.1 y §8.5). Modal compacto de `FlitModal`.
//
// El código se DERIVA del nombre y se enseña como texto, solo al crear (ficha decisión 11): es lo
// único irreversible del formulario. HU #12876: el enlace va como grupo de radios con las cuatro
// ayudas visibles a la vez (en un select solo se leería la de la opción elegida).
//
// Diferencia con la ficha, declarada: el API responde 409 si se cambia el enlace de un rol que ya
// tiene usuarios (`{ error, usuarios }`), así que el aviso «al guardar siguen entrando» de §8.5 no
// se puede sostener; en su lugar se avisa de que el cambio no va a pasar mientras alguien lo tenga
// y, si aun así se envía, se pinta el 409 del servidor.

import { useRef, useState, type FormEvent } from 'react';
import { type CrearRolInput, type EditarRolInput, type RolCatalogo, type TipoEnlace } from '@operaciones/shared-types';
import { ApiError, permisosApi } from '../../lib/api';
import FlitModal from '../../components/flit/FlitModal';
import GradientButton from '../../components/flit/GradientButton';
import { flitInp } from '../../components/flit/flitPageKit';
import { AYUDA_ENLACE, ETIQUETA_ENLACE, LARGO_MAX_CODIGO, ORDEN_ENLACE, PATRON_CODIGO, derivarCodigo } from './modulos';

type Props = {
  onClose: () => void;
  restoreFocusRef: React.RefObject<HTMLElement | null>;
} & ({ modo: 'crear'; onListo: (rol: RolCatalogo) => void } | { modo: 'editar'; rol: RolCatalogo; onListo: (rol: RolCatalogo) => void });

const CLASE_AYUDA = 'mt-1 text-xs';
const ESTILO_AYUDA = { color: 'var(--color-text-secondary)' } as const;
const ESTILO_ERROR = { color: 'var(--kit-rojo-texto)' } as const;
const CLASE_ROTULO = 'mb-1 block text-sm font-semibold';
const ESTILO_ROTULO = { color: 'var(--color-text-primary)' } as const;
/** HU #12876: copy pulido; el error crudo del API no se enseña. */
const ERROR_GUARDAR = 'No se pudo guardar el rol. Inténtalo de nuevo; si se repite, recarga la página.';

export default function RolFormModal(props: Props) {
  const { onClose, restoreFocusRef } = props;
  const original = props.modo === 'editar' ? props.rol : null;
  const [nombre, setNombre] = useState(original?.nombre ?? '');
  const [descripcion, setDescripcion] = useState(original?.descripcion ?? '');
  const [tipoEnlace, setTipoEnlace] = useState<TipoEnlace>(original?.tipoEnlace ?? 'ninguno');
  const [activo, setActivo] = useState(original?.activo ?? true);
  const [errorNombre, setErrorNombre] = useState<string | null>(null);
  const [errorDescripcion, setErrorDescripcion] = useState<string | null>(null);
  const [errorServidor, setErrorServidor] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const refNombre = useRef<HTMLInputElement>(null);
  const refDescripcion = useRef<HTMLTextAreaElement>(null);

  const codigo = derivarCodigo(nombre);
  const usuarios = original?.usuarios ?? 0;
  const cambiaEnlace = original !== null && original.tipoEnlace !== tipoEnlace && usuarios > 0;

  const validar = (): boolean => {
    let ok = true;
    if (!nombre.trim()) {
      setErrorNombre('Escribe el nombre del rol.');
      ok = false;
    } else if (!original && (!PATRON_CODIGO.test(codigo) || codigo.length > LARGO_MAX_CODIGO)) {
      setErrorNombre('El nombre tiene que incluir al menos una letra o un número para poder generar el código.');
      ok = false;
    } else {
      setErrorNombre(null);
    }
    if (!original && !descripcion.trim()) {
      setErrorDescripcion('Escribe una frase que diga qué hace este rol.');
      ok = false;
    } else {
      setErrorDescripcion(null);
    }
    if (!ok) {
      if (!nombre.trim() || (!original && !PATRON_CODIGO.test(codigo))) refNombre.current?.focus();
      else refDescripcion.current?.focus();
    }
    return ok;
  };

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    setErrorServidor(null);
    if (!validar()) return;
    setEnviando(true);
    try {
      if (!original) {
        const input: CrearRolInput = {
          codigo, nombre: nombre.trim(), descripcion: descripcion.trim(), tipoEnlace,
        };
        const { rol } = await permisosApi.crearRol(input);
        props.onListo(rol);
      } else {
        const cambios: EditarRolInput = {};
        if (nombre.trim() !== original.nombre) cambios.nombre = nombre.trim();
        if ((descripcion.trim() || null) !== original.descripcion) cambios.descripcion = descripcion.trim() || null;
        if (tipoEnlace !== original.tipoEnlace) cambios.tipoEnlace = tipoEnlace;
        if (activo !== original.activo) cambios.activo = activo;
        if (Object.keys(cambios).length === 0) { onClose(); return; }
        const { rol } = await permisosApi.editarRol(original.codigo, cambios);
        props.onListo(rol);
      }
    } catch (err) {
      if (!original && err instanceof ApiError && err.status === 409) {
        setErrorServidor(`Ya existe un rol con el código «${codigo}». Cambia el nombre.`);
      } else if (original && err instanceof ApiError && err.status === 409) {
        setErrorServidor('No se pudo cambiar el enlace: hay usuarios con este rol. Cámbiales el rol en Usuarios y vuelve aquí.');
      } else {
        setErrorServidor(ERROR_GUARDAR);
      }
    } finally {
      setEnviando(false);
    }
  };

  return (
    <FlitModal title={original ? `Editar el rol ${original.nombre}` : 'Nuevo rol'} onClose={onClose} restoreFocusRef={restoreFocusRef} icono={original ? 'lapiz' : 'rol'}>
      <form onSubmit={enviar} noValidate className="flex flex-col gap-4">
        <div>
          <label htmlFor="rol-nombre" className={CLASE_ROTULO} style={ESTILO_ROTULO}>Nombre del rol</label>
          <input
            id="rol-nombre"
            ref={refNombre}
            className={flitInp}
            value={nombre}
            maxLength={80}
            aria-invalid={errorNombre ? 'true' : undefined}
            aria-describedby={`rol-nombre-ayuda${errorNombre ? ' rol-nombre-error' : ''}`}
            onChange={(e) => setNombre(e.target.value)}
          />
          <p id="rol-nombre-ayuda" className={CLASE_AYUDA} style={ESTILO_AYUDA}>
            Es lo que se lee en la lista de roles y en el formulario de usuario.
            {!original && (
              <span className="mt-1 block">
                Código: <code style={ESTILO_ROTULO}>{codigo || '—'}</code>. Se genera del nombre y no se puede cambiar después.
              </span>
            )}
          </p>
          {errorNombre && <p id="rol-nombre-error" role="alert" className={CLASE_AYUDA} style={ESTILO_ERROR}>{errorNombre}</p>}
        </div>

        <div>
          <label htmlFor="rol-descripcion" className={CLASE_ROTULO} style={ESTILO_ROTULO}>Descripción</label>
          <textarea
            id="rol-descripcion"
            ref={refDescripcion}
            className={flitInp}
            rows={2}
            maxLength={300}
            value={descripcion}
            aria-invalid={errorDescripcion ? 'true' : undefined}
            aria-describedby={`rol-descripcion-ayuda${errorDescripcion ? ' rol-descripcion-error' : ''}`}
            onChange={(e) => setDescripcion(e.target.value)}
          />
          <p id="rol-descripcion-ayuda" className={CLASE_AYUDA} style={ESTILO_AYUDA}>Una frase que diga qué hace este rol. Se lee en la cabecera del cuadro.</p>
          {errorDescripcion && <p id="rol-descripcion-error" role="alert" className={CLASE_AYUDA} style={ESTILO_ERROR}>{errorDescripcion}</p>}
        </div>

        <fieldset role="radiogroup" aria-labelledby="rol-enlace-legend" aria-describedby={`rol-enlace-ayuda${cambiaEnlace ? ' rol-enlace-bloqueo' : ''}`}>
          <legend id="rol-enlace-legend" className={CLASE_ROTULO} style={ESTILO_ROTULO}>Enlace</legend>
          <p id="rol-enlace-ayuda" className="mb-2 text-xs" style={ESTILO_AYUDA}>
            Decide qué datos ven las personas con este rol. La compañía, el proveedor o las secretarías de cada una se eligen en Usuarios.
          </p>
          <div className="flex flex-col gap-1">
            {ORDEN_ENLACE.map((v) => {
              const elegido = tipoEnlace === v;
              return (
                <label
                  key={v}
                  className="flex cursor-pointer items-start gap-2 rounded-[9px] px-2 py-1.5 transition-colors hover:bg-[var(--kit-hover)]"
                >
                  <input
                    type="radio"
                    name="rol-enlace"
                    value={v}
                    className="flit-focus mt-1 shrink-0 accent-[var(--color-action)]"
                    checked={elegido}
                    aria-labelledby={`rol-enlace-${v}-nombre`}
                    aria-describedby={`rol-enlace-${v}-ayuda`}
                    onChange={() => setTipoEnlace(v)}
                  />
                  <span className="min-w-0">
                    <span id={`rol-enlace-${v}-nombre`} className={`block text-sm${elegido ? ' font-semibold' : ''}`} style={ESTILO_ROTULO}>{ETIQUETA_ENLACE[v]}</span>
                    <span id={`rol-enlace-${v}-ayuda`} className="mt-0.5 block text-xs" style={ESTILO_AYUDA}>{AYUDA_ENLACE[v]}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {cambiaEnlace && (
            <p id="rol-enlace-bloqueo" className={CLASE_AYUDA} style={{ color: 'var(--kit-naranja-texto)' }}>
              {usuarios === 1 ? '1 usuario ya tiene' : `${usuarios} usuarios ya tienen`} este rol: FLITO no deja cambiar el enlace mientras alguien lo tenga. Cámbiales el rol en Usuarios y vuelve aquí.
            </p>
          )}
        </fieldset>

        {original && (
          <div>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="flit-focus mt-1 accent-[var(--color-action)]" checked={activo} aria-describedby="rol-activo-ayuda" onChange={(e) => setActivo(e.target.checked)} />
              <span className="text-sm" style={ESTILO_ROTULO}>Se puede asignar a usuarios nuevos</span>
            </label>
            <p id="rol-activo-ayuda" className={CLASE_AYUDA} style={ESTILO_AYUDA}>
              Si lo desmarcas, este rol deja de ofrecerse al crear o editar usuarios. Quien ya lo tiene sigue entrando y trabajando igual.
            </p>
          </div>
        )}

        {errorServidor && <p role="alert" className="text-sm" style={ESTILO_ERROR}>{errorServidor}</p>}

        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <GradientButton type="button" variant="secondary" onClick={onClose} disabled={enviando}>Cancelar</GradientButton>
          <GradientButton type="submit" disabled={enviando}>{original ? 'Guardar cambios' : 'Crear rol'}</GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}
