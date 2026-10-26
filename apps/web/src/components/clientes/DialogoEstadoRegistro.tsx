// Diálogo de desactivar / activar un registro (HU #13949). Diseño:
// `docs/ux/clientes-menu-estado-13949-slim.md`. Sirve a Clientes y, tal cual, a Proveedores
// (#13961/#13962): el sustantivo, la línea de consecuencia y las llamadas al API las pone la pestaña.
//
// Lo que vive AQUÍ es la clasificación del error de confirmar, porque decide dónde se dice:
//   2xx  → la pestaña cierra, avisa con toast y recarga en silencio (`onHecho`).
//   409  → el estado ya cambió: toast y recarga (`onDesactualizado('cambiado')`).
//   404  → el registro ya no existe: toast y recarga (`onDesactualizado('no-existe')`).
//   red / 5xx → alerta en el diálogo y el botón pasa a «Reintentar».
//   403  → alerta en el diálogo y solo queda «Cancelar».
// Nunca el texto crudo del API.
//
// Sin cambio optimista: la fila solo cambia cuando el PATCH responde 2xx.

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { ApiError } from '../../lib/api';
import FlitModal from '../flit/FlitModal';
import {
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle, flitBtnSecondarySm,
} from '../flit/flitPageKit';

export interface ProcesosAbiertos { soat: number; impuestos: number; tramites: number; liquidaciones: number }

export interface ImpactoEstado { procesosAbiertos: ProcesosAbiertos; usuariosAfectados: number }

export type Sustantivo = 'cliente' | 'proveedor';

const UNIDADES: { clave: keyof ProcesosAbiertos; uno: string; varios: string }[] = [
  { clave: 'soat', uno: 'SOAT', varios: 'SOAT' },
  { clave: 'impuestos', uno: 'impuesto', varios: 'impuestos' },
  { clave: 'tramites', uno: 'trámite', varios: 'trámites' },
  { clave: 'liquidaciones', uno: 'liquidación', varios: 'liquidaciones' },
];

/**
 * «Este cliente tiene 3 SOAT, 2 trámites en curso.» / «No tiene procesos en curso.» — solo los
 * tipos con n > 0, en orden SOAT · impuestos · trámites · liquidaciones, unidos con «, » (AC1/AC2).
 */
export function fraseProcesos(p: ProcesosAbiertos, sustantivo: Sustantivo = 'cliente'): string {
  const partes = UNIDADES
    .filter((u) => (p[u.clave] ?? 0) > 0)
    .map((u) => `${p[u.clave]} ${p[u.clave] === 1 ? u.uno : u.varios}`);
  if (partes.length === 0) return 'No tiene procesos en curso.';
  return `Este ${sustantivo} tiene ${partes.join(', ')} en curso.`;
}

/** «Se cerrará la sesión de su usuario.» / «… de sus N usuarios.»; con 0, nada. */
export function fraseUsuarios(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? 'Se cerrará la sesión de su usuario.' : `Se cerrará la sesión de sus ${n} usuarios.`;
}

const SIN_PERMISO = 'No tiene permiso para esta acción.';
const SIN_RED = 'No pudimos conectar con FLITO. Revise su conexión e inténtelo de nuevo.';

type ErrorConfirmar = { texto: string; reintentable: boolean };

type EstadoImpacto =
  | { fase: 'cargando' }
  | { fase: 'error'; sinPermiso: boolean }
  | { fase: 'listo'; impacto: ImpactoEstado };

interface Props {
  accion: 'desactivar' | 'activar';
  nombre: string;
  sustantivo: Sustantivo;
  /** Solo desactivar. Sin él, el diálogo no pinta frase de procesos. */
  cargarImpacto?: () => Promise<ImpactoEstado>;
  /** «Mientras esté inactivo…» / «Vuelve a recibir…»: difiere entre Clientes y Proveedores. */
  consecuencia: string;
  /** El PATCH con `{ activo, activoEsperado }`. */
  confirmar: () => Promise<void>;
  onHecho: () => void;
  onDesactualizado: (motivo: 'cambiado' | 'no-existe') => void;
  onCerrar: () => void;
  restoreFocusRef: RefObject<HTMLElement | null>;
}

export function DialogoEstadoRegistro({
  accion, nombre, sustantivo, cargarImpacto, consecuencia, confirmar, onHecho, onDesactualizado, onCerrar,
  restoreFocusRef,
}: Props) {
  const desactiva = accion === 'desactivar';
  const [impacto, setImpacto] = useState<EstadoImpacto | null>(cargarImpacto ? { fase: 'cargando' } : null);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<ErrorConfirmar | null>(null);
  const refCancelar = useRef<HTMLButtonElement>(null);
  const refConfirmar = useRef<HTMLButtonElement>(null);
  // Si el diálogo se cierra con el impacto en vuelo, su respuesta se descarta.
  const vivo = useRef(true);
  // `true` en el cuerpo y no solo en el valor inicial: StrictMode monta, desmonta y vuelve a montar.
  useEffect(() => { vivo.current = true; return () => { vivo.current = false; }; }, []);

  // Foco inicial: Cancelar al desactivar (consecuencia: Intro por inercia no la ejecuta); Activar
  // al activar (no es destructiva).
  useEffect(() => {
    (desactiva ? refCancelar : refConfirmar).current?.focus();
  }, [desactiva]);

  // En ref: la pestaña puede pasar una función nueva en cada render y eso no debe volver a pedir.
  const refCargar = useRef(cargarImpacto);
  refCargar.current = cargarImpacto;
  const pedirImpacto = useCallback(() => {
    const cargar = refCargar.current;
    if (!cargar) return;
    setImpacto({ fase: 'cargando' });
    cargar()
      .then((r) => { if (vivo.current) setImpacto({ fase: 'listo', impacto: r }); })
      .catch((e) => {
        if (vivo.current) setImpacto({ fase: 'error', sinPermiso: e instanceof ApiError && e.status === 403 });
      });
  }, []);

  useEffect(() => { pedirImpacto(); }, [pedirImpacto]);

  const ejecutar = async () => {
    if (enviando) return;
    setEnviando(true);
    setError(null);
    try {
      await confirmar();
      if (vivo.current) onHecho();
    } catch (e) {
      if (!vivo.current) return;
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 409) { onDesactualizado('cambiado'); return; }
      if (status === 404) { onDesactualizado('no-existe'); return; }
      if (status === 403) setError({ texto: SIN_PERMISO, reintentable: false });
      else if (status === 0) setError({ texto: SIN_RED, reintentable: true });
      else setError({ texto: `No pudimos cambiar el estado del ${sustantivo}. Inténtelo de nuevo.`, reintentable: true });
    } finally {
      if (vivo.current) setEnviando(false);
    }
  };

  const impactoListo = !cargarImpacto || impacto?.fase === 'listo';
  const ocultarConfirmar = error !== null && !error.reintentable;
  const textoBoton = enviando
    ? (desactiva ? 'Desactivando…' : 'Activando…')
    : error?.reintentable ? 'Reintentar' : (desactiva ? 'Desactivar' : 'Activar');

  return (
    <FlitModal
      title={`${desactiva ? 'Desactivar' : 'Activar'} «${nombre}»`}
      onClose={onCerrar}
      restoreFocusRef={restoreFocusRef}
      cierreBloqueado={enviando}
    >
      <div className="flex flex-col gap-3 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
        {impacto?.fase === 'cargando' && (
          <p role="status" style={{ color: 'var(--flit-text-muted)' }}>Revisando procesos en curso…</p>
        )}
        {impacto?.fase === 'error' && (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="font-semibold" style={{ color: 'var(--flit-danger-text)' }}>
              <span aria-hidden="true">⚠ </span>
              {impacto.sinPermiso ? SIN_PERMISO : `No pudimos revisar los procesos en curso de este ${sustantivo}.`}
            </p>
            {!impacto.sinPermiso && (
              <button type="button" className={flitBtnSecondarySm} style={flitBtnSecondaryStyle} onClick={pedirImpacto}>
                Reintentar
              </button>
            )}
          </div>
        )}
        {impacto?.fase === 'listo' && <p>{fraseProcesos(impacto.impacto.procesosAbiertos, sustantivo)}</p>}
        <p>{consecuencia}</p>
        {impacto?.fase === 'listo' && fraseUsuarios(impacto.impacto.usuariosAfectados) && (
          <p>{fraseUsuarios(impacto.impacto.usuariosAfectados)}</p>
        )}

        {error && (
          <p role="alert" className="font-semibold" style={{ color: 'var(--flit-danger-text)' }}>
            <span aria-hidden="true">⚠ </span>{error.texto}
          </p>
        )}

        <div className="mt-1 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            ref={refCancelar}
            onClick={onCerrar}
            disabled={enviando}
            className={flitBtnSecondary}
            style={flitBtnSecondaryStyle}
          >
            Cancelar
          </button>
          {!ocultarConfirmar && (desactiva ? (
            // Peso de peligro con tinta y borde, no con un rojo sólido (patrón de
            // `siigo/credenciales/DialogoDesactivar.tsx`, con fondo de tarjeta en vez de blanco).
            <button
              type="button"
              ref={refConfirmar}
              onClick={() => { void ejecutar(); }}
              disabled={enviando || !impactoListo}
              className="flit-focus inline-flex h-10 items-center rounded-[999px] border bg-flit-card px-5 text-sm font-semibold transition-colors hover:bg-[var(--flit-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              style={{ borderColor: 'var(--flit-danger)', color: 'var(--flit-danger-text)' }}
            >
              {textoBoton}
            </button>
          ) : (
            <button
              type="button"
              ref={refConfirmar}
              onClick={() => { void ejecutar(); }}
              disabled={enviando}
              className={flitBtnPrimary}
              style={flitBtnPrimaryStyle}
            >
              {textoBoton}
            </button>
          ))}
        </div>
      </div>
    </FlitModal>
  );
}

export default DialogoEstadoRegistro;
