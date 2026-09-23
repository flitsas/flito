// HU #12085 — Alta y edición de un rol (ficha §8.1 y §8.5). Modal compacto de `FlitModal`.
//
// El código se DERIVA del nombre y se enseña como texto, solo al crear (ficha decisión 11): es lo
// único irreversible del formulario. El tipo de acceso va como grupo de radios y no como
// desplegable: las dos opciones tienen consecuencias opuestas y hay que leerlas a la vez (§8.1).
//
// Diferencia con la ficha, declarada: el API responde 409 si se cambia el ámbito de un rol que ya
// tiene usuarios (`{ error, usuarios }`), así que el aviso «al guardar siguen entrando» de §8.5 no
// se puede sostener; en su lugar se avisa de que el cambio no va a pasar mientras alguien lo tenga
// y, si aun así se envía, se pinta el 409 del servidor.

import { useRef, useState, type FormEvent } from 'react';
import { TIPOS_ENLACE, type CrearRolInput, type EditarRolInput, type RolCatalogo, type TipoEnlace, type TipoPrincipalRol } from '@operaciones/shared-types';
import { ApiError, errorMessage, permisosApi } from '../../lib/api';
import FlitModal from '../../components/flit/FlitModal';
import FlitSelect from '../../components/flit/FlitSelect';
import GradientButton from '../../components/flit/GradientButton';
import { flitBtnSecondary, flitBtnSecondaryStyle, flitInp } from '../../components/flit/flitPageKit';
import { AYUDA_ENLACE, ETIQUETA_ENLACE, LARGO_MAX_CODIGO, PATRON_CODIGO, derivarCodigo } from './modulos';

type Props = {
  onClose: () => void;
  restoreFocusRef: React.RefObject<HTMLElement | null>;
} & ({ modo: 'crear'; onListo: (rol: RolCatalogo) => void } | { modo: 'editar'; rol: RolCatalogo; onListo: (rol: RolCatalogo) => void });

const AYUDA_ACCESO: Record<TipoPrincipalRol, string> = {
  interno: 'Ve las pantallas internas que se le marquen en el cuadro de funciones.',
  externo: 'Entra únicamente al portal del cliente y ve solo lo de su compañía. Aunque se le marquen funciones internas, no las va a poder ejercer.',
};

const ETIQUETA_OPCION_ACCESO: Record<TipoPrincipalRol, string> = {
  interno: 'Interno — trabaja dentro de FLITO',
  externo: 'Externo — solo el canal de cliente',
};

const CLASE_AYUDA = 'mt-1 text-xs';
const ESTILO_AYUDA = { color: 'var(--flit-text-secondary)' } as const;

export default function RolFormModal(props: Props) {
  const { onClose, restoreFocusRef } = props;
  const original = props.modo === 'editar' ? props.rol : null;
  const [nombre, setNombre] = useState(original?.nombre ?? '');
  const [descripcion, setDescripcion] = useState(original?.descripcion ?? '');
  const [tipoEnlace, setTipoEnlace] = useState<TipoEnlace>(original?.tipoEnlace ?? 'ninguno');
  const [tipoPrincipal, setTipoPrincipal] = useState<TipoPrincipalRol>(original?.tipoPrincipal ?? 'interno');
  const [activo, setActivo] = useState(original?.activo ?? true);
  const [errorNombre, setErrorNombre] = useState<string | null>(null);
  const [errorDescripcion, setErrorDescripcion] = useState<string | null>(null);
  const [errorServidor, setErrorServidor] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const refNombre = useRef<HTMLInputElement>(null);
  const refDescripcion = useRef<HTMLTextAreaElement>(null);

  const codigo = derivarCodigo(nombre);
  const usuarios = original?.usuarios ?? 0;
  const cambiaAcceso = original !== null && original.tipoPrincipal !== tipoPrincipal && usuarios > 0;
  const cambiaAmbito = original !== null && original.tipoEnlace !== tipoEnlace && usuarios > 0;

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
          codigo, nombre: nombre.trim(), descripcion: descripcion.trim(), tipoEnlace, tipoPrincipal,
        };
        const { rol } = await permisosApi.crearRol(input);
        props.onListo(rol);
      } else {
        const cambios: EditarRolInput = {};
        if (nombre.trim() !== original.nombre) cambios.nombre = nombre.trim();
        if ((descripcion.trim() || null) !== original.descripcion) cambios.descripcion = descripcion.trim() || null;
        if (tipoEnlace !== original.tipoEnlace) cambios.tipoEnlace = tipoEnlace;
        if (tipoPrincipal !== original.tipoPrincipal) cambios.tipoPrincipal = tipoPrincipal;
        if (activo !== original.activo) cambios.activo = activo;
        if (Object.keys(cambios).length === 0) { onClose(); return; }
        const { rol } = await permisosApi.editarRol(original.codigo, cambios);
        props.onListo(rol);
      }
    } catch (err) {
      if (!original && err instanceof ApiError && err.status === 409) {
        setErrorServidor(`Ya existe un rol con el código «${codigo}». Cambia el nombre.`);
      } else {
        setErrorServidor(errorMessage(err));
      }
    } finally {
      setEnviando(false);
    }
  };

  return (
    <FlitModal title={original ? `Editar el rol ${original.nombre}` : 'Nuevo rol'} onClose={onClose} restoreFocusRef={restoreFocusRef}>
      <form onSubmit={enviar} noValidate className="flex flex-col gap-4">
        <div>
          <label htmlFor="rol-nombre" className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Nombre del rol</label>
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
                Código: <code style={{ color: 'var(--flit-text-primary)' }}>{codigo || '—'}</code>. Se genera del nombre y no se puede cambiar después.
              </span>
            )}
          </p>
          {errorNombre && <p id="rol-nombre-error" role="alert" className={CLASE_AYUDA} style={{ color: 'var(--flit-danger-ink)' }}>{errorNombre}</p>}
        </div>

        <div>
          <label htmlFor="rol-descripcion" className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Descripción</label>
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
          {errorDescripcion && <p id="rol-descripcion-error" role="alert" className={CLASE_AYUDA} style={{ color: 'var(--flit-danger-ink)' }}>{errorDescripcion}</p>}
        </div>

        <FlitSelect
          label="Ámbito de sus usuarios"
          value={tipoEnlace}
          opciones={TIPOS_ENLACE.map((v) => ({ valor: v, etiqueta: ETIQUETA_ENLACE[v] }))}
          onChange={(v) => setTipoEnlace(v as TipoEnlace)}
          ayuda={(
            <>
              Define qué habrá que elegirle a cada usuario de este rol. {AYUDA_ENLACE[tipoEnlace]}
              {cambiaAmbito && (
                <span className="mt-1 block" style={{ color: 'var(--flit-warning-ink)' }}>
                  {usuarios === 1 ? '1 usuario ya tiene este rol' : `${usuarios} usuarios ya tienen este rol`}: FLITO no deja cambiar el ámbito mientras alguien lo tenga. Cámbiales el rol en Usuarios y vuelve aquí.
                </span>
              )}
            </>
          )}
        />

        <fieldset>
          <legend className="mb-1 text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Tipo de acceso</legend>
          <div className="flex flex-col gap-2">
            {(['interno', 'externo'] as const).map((v) => (
              <label key={v} className="flex items-start gap-2">
                <input
                  type="radio"
                  name="rol-tipo-acceso"
                  className="flit-focus mt-1"
                  value={v}
                  checked={tipoPrincipal === v}
                  aria-describedby={`rol-acceso-${v}-ayuda`}
                  onChange={() => setTipoPrincipal(v)}
                />
                <span className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
                  {ETIQUETA_OPCION_ACCESO[v]}
                  <span id={`rol-acceso-${v}-ayuda`} className="block text-xs" style={ESTILO_AYUDA}>{AYUDA_ACCESO[v]}</span>
                </span>
              </label>
            ))}
          </div>
          <p className={CLASE_AYUDA} style={ESTILO_AYUDA}>
            El tipo de acceso no se deduce del nombre del rol: lo decide esta elección, y es la que más consecuencias tiene de todo el formulario.
          </p>
          {cambiaAcceso && (
            <p className={CLASE_AYUDA} style={{ color: 'var(--flit-warning-ink)' }}>
              {usuarios === 1 ? '1 usuario tiene este rol.' : `${usuarios} usuarios tienen este rol.`}{' '}
              {tipoPrincipal === 'externo'
                ? 'Al guardar, dejan de entrar a las pantallas internas de FLITO.'
                : 'Al guardar, salen del canal de cliente y pasan a ver lo que este cuadro tenga marcado.'}
            </p>
          )}
        </fieldset>

        {original && (
          <div>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="flit-focus mt-1" checked={activo} aria-describedby="rol-activo-ayuda" onChange={(e) => setActivo(e.target.checked)} />
              <span className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>Se puede asignar a usuarios nuevos</span>
            </label>
            <p id="rol-activo-ayuda" className={CLASE_AYUDA} style={ESTILO_AYUDA}>
              Si lo desmarcas, este rol deja de ofrecerse al crear o editar usuarios. Quien ya lo tiene sigue entrando y trabajando igual.
            </p>
          </div>
        )}

        {errorServidor && <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{errorServidor}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose} disabled={enviando}>Cancelar</button>
          <GradientButton type="submit" disabled={enviando}>{original ? 'Guardar cambios' : 'Crear rol'}</GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}
