// Diálogo de eliminar un registro (HU #13956). Hermano de `DialogoEstadoRegistro` (#13949): mismo
// patrón —foco inicial en Cancelar, primaria de peligro con tinta y borde, sin cambio optimista— y
// la misma clasificación del error de confirmar, que decide dónde se dice:
//   2xx  → la pestaña cierra, avisa con toast y quita la fila (`onHecho`).
//   409 «Otro administrador ya cambió su estado» → toast y recarga (`onDesactualizado('cambiado')`).
//   409 con el motivo de no-eliminable (RN-CLI-10 / RN-PROV-6) → ese motivo en el diálogo: es copy de producto.
//   409 otro (seguro anti-bloqueo de administración) → frase fija en el diálogo.
//   404  → el registro ya no existe: toast y recarga (`onDesactualizado('no-existe')`).
//   red / 5xx → alerta en el diálogo y el botón pasa a «Reintentar».
//   403  → alerta en el diálogo y solo queda «Cancelar».
// Nunca el texto crudo del API salvo el motivo de no-eliminable, que se reconoce por su forma.

import { useEffect, useRef, useState, type RefObject } from 'react';
import { ApiError } from '../../lib/api';
import FlitModal from '../flit/FlitModal';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../flit/flitPageKit';
import type { Sustantivo } from './DialogoEstadoRegistro';

export const CONSECUENCIA_ELIMINAR = 'Dejará de aparecer en FLITO. Su historial se conserva. No se puede deshacer.';

const SIN_PERMISO = 'No tiene permiso para esta acción.';
const SIN_RED = 'No pudimos conectar con FLITO. Revise su conexión e inténtelo de nuevo.';
const CONCURRENCIA = 'Otro administrador ya cambió su estado';

/**
 * Los motivos tal como los redacta `motivoNoEliminable` del API: RN-CLI-10 (clientes, #13956) y
 * RN-PROV-6 (proveedores SOAT, #13962: «Tiene 4 SOAT en curso.», «Es el proveedor de SOAT sin
 * trámite de 2 compañías (Alfa, Beta).»).
 */
const MOTIVO_NO_ELIMINABLE = new RegExp('^(' + [
  'Primero debe desactivarlo\\.',
  'Tiene \\d+ procesos? abiertos? \\(.*\\)\\.',
  'Su bolsa tiene saldo de -?\\$[\\d.]+; debe quedar en cero\\.',
  'Tiene \\d+ SOAT en curso\\.',
  'Es el proveedor de SOAT sin trámite de \\d+ compañías? \\(.*\\)\\.',
].join('|') + ')$');

type ErrorConfirmar = { texto: string; reintentable: boolean };

interface Props {
  nombre: string;
  sustantivo: Sustantivo;
  /** El DELETE. */
  confirmar: () => Promise<void>;
  onHecho: () => void;
  onDesactualizado: (motivo: 'cambiado' | 'no-existe') => void;
  onCerrar: () => void;
  restoreFocusRef: RefObject<HTMLElement | null>;
}

export function DialogoEliminarRegistro({
  nombre, sustantivo, confirmar, onHecho, onDesactualizado, onCerrar, restoreFocusRef,
}: Props) {
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<ErrorConfirmar | null>(null);
  const refCancelar = useRef<HTMLButtonElement>(null);
  const vivo = useRef(true);
  useEffect(() => { vivo.current = true; return () => { vivo.current = false; }; }, []);
  // Foco inicial en Cancelar: la acción no se puede deshacer y Intro por inercia no debe ejecutarla.
  useEffect(() => { refCancelar.current?.focus(); }, []);

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
      const mensaje = e instanceof ApiError ? e.message.trim() : '';
      if (status === 409 && mensaje.replace(/\.$/, '') === CONCURRENCIA) { onDesactualizado('cambiado'); return; }
      if (status === 404) { onDesactualizado('no-existe'); return; }
      if (status === 409 && MOTIVO_NO_ELIMINABLE.test(mensaje)) setError({ texto: mensaje, reintentable: false });
      else if (status === 409) {
        setError({ texto: `No se puede eliminar: dejaría a FLITO sin un usuario que administre alguna de sus funciones.`, reintentable: false });
      } else if (status === 403) setError({ texto: SIN_PERMISO, reintentable: false });
      else if (status === 0) setError({ texto: SIN_RED, reintentable: true });
      else setError({ texto: `No pudimos eliminar el ${sustantivo}. Inténtelo de nuevo.`, reintentable: true });
    } finally {
      if (vivo.current) setEnviando(false);
    }
  };

  const ocultarConfirmar = error !== null && !error.reintentable;
  const textoBoton = enviando ? 'Eliminando…' : error?.reintentable ? 'Reintentar' : 'Eliminar';

  return (
    <FlitModal title={`Eliminar «${nombre}»`} onClose={onCerrar} restoreFocusRef={restoreFocusRef} cierreBloqueado={enviando}>
      <div className="flex flex-col gap-3 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
        <p>{CONSECUENCIA_ELIMINAR}</p>

        {error && (
          <p role="alert" className="font-semibold" style={{ color: 'var(--flit-danger-text)' }}>
            <span aria-hidden="true">⚠ </span>{error.texto}
          </p>
        )}

        <div className="mt-1 flex flex-wrap justify-end gap-2">
          <button type="button" ref={refCancelar} onClick={onCerrar} disabled={enviando}
            className={flitBtnSecondary} style={flitBtnSecondaryStyle}>
            Cancelar
          </button>
          {!ocultarConfirmar && (
            // Peligro con tinta y borde (`--flit-danger-text`, contraste corregido en #13949), no con rojo sólido.
            <button
              type="button"
              onClick={() => { void ejecutar(); }}
              disabled={enviando}
              className="flit-focus inline-flex h-10 items-center rounded-[999px] border bg-flit-card px-5 text-sm font-semibold transition-colors hover:bg-[var(--flit-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              style={{ borderColor: 'var(--flit-danger)', color: 'var(--flit-danger-text)' }}
            >
              {textoBoton}
            </button>
          )}
        </div>
      </div>
    </FlitModal>
  );
}

export default DialogoEliminarRegistro;
