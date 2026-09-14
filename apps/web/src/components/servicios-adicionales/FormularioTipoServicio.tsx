// FLITO — Servicios adicionales: el formulario de tipo, UNA pieza para crear y editar (HU #12542).
// UX §6.1–§6.6 y §11.
//
// Dueño de la validación en línea (al enviar y al perder el foco, no en cada tecla), del diff del
// PATCH (`cambiosDe`: solo lo que cambió; nada cambiado → botón apagado y «No has cambiado nada.»,
// cero peticiones) y del mapeo de respuestas: 409 bajo Nombre con el formulario abierto, 400 bajo
// su campo, 403 y 500/red como alerta encima de los botones con lo escrito intacto, 404 al editar
// se lo devuelve a la página (cierra, avisa y recarga: el tipo ya no está activo).
//
// El valor se captura como TEXTO (`inputmode="decimal"`, no `type="number"`) y lo valida
// `validarValorTarifa` de `lib/tarifas.ts`, tal cual: no hay segunda validación del valor.

import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from 'react';
import { SERVICIO_ADICIONAL_DESCRIPCION_MAX, SERVICIO_ADICIONAL_NOMBRE_MAX } from '@operaciones/shared-types';
import { api, ApiError, errorMessage } from '../../lib/api';
import { validarValorTarifa } from '../../lib/tarifas';
import {
  RUTA_SERVICIOS_ADICIONALES, cambiosDe, campoDelError400, validarDescripcion, validarNombre,
  type CampoTipo, type ServicioAdicionalNombreDuplicado, type ServicioAdicionalTipo,
} from '../../lib/serviciosAdicionales';
import FlitModal from '../flit/FlitModal';
import {
  flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../flit/flitPageKit';

interface Props {
  /** `null` = crear. Con un tipo, edita ese. */
  tipo: ServicioAdicionalTipo | null;
  onClose: () => void;
  /** Dónde dejar el foco si el botón que abrió el modal no puede tomarlo (fila apagada o ida). */
  restoreFocusRef: RefObject<HTMLElement | null>;
  /** 201 o 200: la página repide la lista y lanza el toast con el modo que ya sabe. */
  onGuardado: () => void;
  /** 404 al editar: la página cierra, avisa y repide. */
  onNoDisponible: () => void;
}

type Errores = Partial<Record<CampoTipo, string>>;

const SIN_CAMBIOS = 'No has cambiado nada.';
const ERROR_403 = 'Tu usuario ya no tiene permiso para hacer esto. Vuelve a entrar para actualizar tus permisos.';
const ERROR_GUARDAR = 'No se pudo guardar. Los datos siguen aquí; vuelve a intentarlo.';
const DUPLICADO = 'Ya existe un tipo activo con ese nombre.';

const esDuplicado = (e: ApiError): e is ApiError & { rawDetails: ServicioAdicionalNombreDuplicado } =>
  e.status === 409 && typeof e.rawDetails === 'object' && e.rawDetails !== null
  && (e.rawDetails as { codigo?: unknown }).codigo === 'NOMBRE_DUPLICADO';

export default function FormularioTipoServicio({ tipo, onClose, onGuardado, onNoDisponible, restoreFocusRef }: Props) {
  const editar = tipo !== null;
  const [nombre, setNombre] = useState(tipo?.nombre ?? '');
  const [descripcion, setDescripcion] = useState(tipo?.descripcion ?? '');
  const [valor, setValor] = useState(tipo ? String(tipo.valor) : '');
  const [errores, setErrores] = useState<Errores>({});
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  /** Campo que debe recibir el foco cuando el formulario vuelva a estar habilitado (tras un 409/400). */
  const [enfocar, setEnfocar] = useState<CampoTipo | null>(null);

  const id = useId();
  const refs = {
    nombre: useRef<HTMLInputElement>(null),
    descripcion: useRef<HTMLTextAreaElement>(null),
    valor: useRef<HTMLInputElement>(null),
  };

  // El foco entra al campo Nombre (UX §11). Va en un frame posterior porque la trampa de foco de
  // `FlitModal` enfoca el diálogo en su propio efecto, que corre DESPUÉS de los del hijo.
  useEffect(() => {
    const raf = requestAnimationFrame(() => refs.nombre.current?.focus());
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo al montar
  }, []);

  // Mientras envía, los campos están `disabled` y no toman el foco: se enfoca cuando se habilitan.
  useEffect(() => {
    if (!enfocar || enviando) return;
    refs[enfocar].current?.focus();
    setEnfocar(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `refs` es estable por render
  }, [enfocar, enviando]);

  const validacionValor = validarValorTarifa(valor, null);
  const validar = (): Errores => {
    const e: Errores = {};
    const n = validarNombre(nombre); if (n) e.nombre = n;
    const d = validarDescripcion(descripcion); if (d) e.descripcion = d;
    if (!validacionValor.ok) e.valor = validacionValor.mensaje;
    return e;
  };
  const validarCampo = (campo: CampoTipo) => {
    const e = validar();
    setErrores((prev) => ({ ...prev, [campo]: e[campo] }));
  };

  // «Sin cambios» solo tiene sentido con los tres campos válidos: si el valor no parsea, lo que
  // hay es un error de validación, no una edición vacía.
  const cuerpoPatch = editar && validacionValor.ok
    ? cambiosDe(tipo, { nombre, descripcion, valor: validacionValor.valor })
    : undefined;
  const sinCambios = editar && validacionValor.ok && cuerpoPatch === null;

  const enviar = (ev: FormEvent) => {
    ev.preventDefault();
    if (enviando || sinCambios) return;
    const e = validar();
    setErrores(e);
    setErrorGeneral(null);
    const primero = (['nombre', 'descripcion', 'valor'] as const).find((c) => e[c]);
    if (primero) { refs[primero].current?.focus(); return; }
    if (!validacionValor.ok) return;

    const cuerpo = editar
      ? cuerpoPatch
      : { nombre: nombre.trim(), ...(descripcion.trim() ? { descripcion: descripcion.trim() } : {}), valor: validacionValor.valor };
    if (!cuerpo) return;

    setEnviando(true);
    const peticion = editar
      ? api.patch<ServicioAdicionalTipo>(`${RUTA_SERVICIOS_ADICIONALES}/${tipo.id}`, cuerpo)
      : api.post<ServicioAdicionalTipo>(RUTA_SERVICIOS_ADICIONALES, cuerpo);
    peticion
      .then(() => onGuardado())
      .catch((err: unknown) => {
        setEnviando(false);
        if (!(err instanceof ApiError)) { setErrorGeneral(`${ERROR_GUARDAR} ${errorMessage(err)}`); return; }
        if (esDuplicado(err)) {
          const choca = err.rawDetails.choca?.nombre;
          const registrado = choca && choca !== nombre.trim() ? ` Está registrado como «${choca}».` : '';
          setErrores({ nombre: `${DUPLICADO}${registrado}` });
          setEnfocar('nombre');
          return;
        }
        if (err.status === 404 && editar) { onNoDisponible(); return; }
        if (err.status === 403) { setErrorGeneral(ERROR_403); return; }
        if (err.status === 400) {
          const campo = campoDelError400(err.message);
          if (campo) { setErrores({ [campo]: err.message }); setEnfocar(campo); return; }
          setErrorGeneral(err.message);
          return;
        }
        setErrorGeneral(`${ERROR_GUARDAR} ${errorMessage(err)}`);
      });
  };

  const mensaje = (campo: CampoTipo) => (errores[campo]
    ? <p id={`${id}-${campo}-error`} role="alert" className="mt-1 text-xs" style={{ color: 'var(--flit-danger-ink)' }}>{errores[campo]}</p>
    : null);
  const describe = (campo: CampoTipo, extra?: string) =>
    [errores[campo] ? `${id}-${campo}-error` : null, extra].filter(Boolean).join(' ') || undefined;

  return (
    <FlitModal title={editar ? 'Editar tipo' : 'Nuevo tipo de servicio adicional'} onClose={onClose} restoreFocusRef={restoreFocusRef}>
      <form onSubmit={enviar} noValidate aria-busy={enviando || undefined} className="space-y-4">
        <div>
          <label htmlFor={`${id}-nombre`} className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Nombre</label>
          <input
            id={`${id}-nombre`} ref={refs.nombre} type="text" className={flitInp} value={nombre}
            maxLength={SERVICIO_ADICIONAL_NOMBRE_MAX} autoComplete="off" disabled={enviando}
            aria-invalid={errores.nombre ? true : undefined} aria-describedby={describe('nombre')}
            onChange={(e) => setNombre(e.target.value)} onBlur={() => validarCampo('nombre')}
          />
          {mensaje('nombre')}
        </div>
        <div>
          <label htmlFor={`${id}-descripcion`} className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Descripción (opcional)</label>
          <textarea
            id={`${id}-descripcion`} ref={refs.descripcion} rows={3} className={flitInp} value={descripcion}
            maxLength={SERVICIO_ADICIONAL_DESCRIPCION_MAX} disabled={enviando}
            aria-invalid={errores.descripcion ? true : undefined} aria-describedby={describe('descripcion')}
            onChange={(e) => setDescripcion(e.target.value)} onBlur={() => validarCampo('descripcion')}
          />
          {mensaje('descripcion')}
        </div>
        <div>
          <label htmlFor={`${id}-valor`} className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Valor</label>
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="text-sm font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>$</span>
            <input
              id={`${id}-valor`} ref={refs.valor} type="text" inputMode="decimal" autoComplete="off"
              className={`${flitInp} max-w-[12rem]`} value={valor} disabled={enviando} aria-label="Valor en pesos"
              aria-invalid={errores.valor ? true : undefined} aria-describedby={describe('valor', `${id}-valor-ayuda`)}
              onChange={(e) => setValor(e.target.value)} onBlur={() => validarCampo('valor')}
            />
          </div>
          <p id={`${id}-valor-ayuda`} className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            En pesos. Sin decimales, salvo que el valor los tenga (hasta dos).
          </p>
          {mensaje('valor')}
        </div>

        {errorGeneral && (
          <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{errorGeneral}</p>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={enviando} onClick={onClose}>Cancelar</button>
          <button
            type="submit" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
            disabled={enviando || sinCambios} aria-describedby={sinCambios ? `${id}-sin-cambios` : undefined}
          >
            {editar ? 'Guardar cambios' : 'Crear tipo'}
          </button>
        </div>
        {sinCambios && (
          <p id={`${id}-sin-cambios`} className="text-right text-xs" style={{ color: 'var(--flit-text-muted)' }}>{SIN_CAMBIOS}</p>
        )}
      </form>
    </FlitModal>
  );
}
