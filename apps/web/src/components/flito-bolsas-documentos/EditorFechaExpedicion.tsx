// Editor en línea de la fecha de expedición (HU #13892, AC5; spec «Digitar / Corregir fecha»).
// Sustituye la línea de detalle de la fila: sin modal sobre modal. `Esc` = Cancelar y NO cierra el
// detalle (stopPropagation antes del `useEscape` de `FlitModal`, que escucha en `window`).
import { useEffect, useId, useRef, useState } from 'react';
import type { DocumentoBolsaDto } from '@operaciones/shared-types';
import { bolsasDocumentosApi } from '../../lib/api';
import { errorBolsa, hoyColombia } from '../../lib/bolsas';
import { flitBtnSecondarySm, flitInp } from '../flit/flitPageKit';
import { toastOk } from '../flit/ToastFlito';

export default function EditorFechaExpedicion({ documento, onCancelar, onGuardado, onCarrera }: {
  documento: DocumentoBolsaDto;
  onCancelar: () => void;
  onGuardado: (dto: DocumentoBolsaDto) => void;
  /**
   * 409 = carrera (bolsa inactivada o versión reemplazada mientras se editaba). Se decide solo por el
   * status, nunca por el texto del API: con `activa=false` el editor ni existe, así que no hay más casos.
   */
  onCarrera: () => void;
}) {
  const id = useId();
  const [fecha, setFecha] = useState(documento.fechaExpedicion ?? '');
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const candado = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const hoy = hoyColombia();

  const form = useRef<HTMLFormElement>(null);

  // El botón que abrió el editor se desmonta: el foco va al campo SIN el scroll de `focus()` (Chromium
  // centra el elemento y el modal «salta», HU #13892 retrabajo DEV); solo se desplaza lo justo para
  // que el editor se vea entero.
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    form.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);

  async function guardar() {
    if (candado.current) return;
    if (!fecha) { setError('Escribe la fecha de expedición.'); return; }
    if (fecha > hoy) { setError('La fecha no puede ser posterior a hoy.'); return; }
    candado.current = true;
    setGuardando(true);
    setError(null);
    try {
      const dto = await bolsasDocumentosApi.fijarFecha(documento.id, fecha);
      toastOk('Fecha de expedición guardada.', { id: `bolsa-doc-fecha-${documento.tipo}` });
      onGuardado(dto);
    } catch (e) {
      const { status } = errorBolsa(e);
      if (status === 409) {
        toastOk('Algo cambió mientras guardabas: la bolsa o el documento se actualizaron. Revisa el expediente e intenta de nuevo.', { id: `bolsa-doc-fecha-${documento.tipo}`, duracionMs: 6_000 });
        onCarrera();
      } else if (status === 400 || status === 422) {
        setError('Revisa la fecha: no puede ser posterior a hoy.');
      } else if (status === 429) {
        setError('Hiciste muchos cambios seguidos. Espera unos minutos e intenta de nuevo.');
      } else if (status === 403) {
        setError('Ya no tienes permiso para cambiar fechas.');
      } else {
        setError('No pudimos guardar la fecha. Intenta de nuevo.');
      }
    } finally {
      candado.current = false;
      setGuardando(false);
    }
  }

  return (
    <form ref={form} noValidate className="rounded-lg border p-3 sm:col-span-2" style={{ borderColor: 'var(--flit-border-input)' }}
      onSubmit={(e) => { e.preventDefault(); void guardar(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); if (!guardando) onCancelar(); } }}>
      <label htmlFor={id} className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        Fecha de expedición
      </label>
      <input ref={input} id={id} type="date" className={`${flitInp} sm:max-w-56`} value={fecha} max={hoy}
        aria-describedby={`${id}-ayuda${error ? ` ${id}-error` : ''}`} aria-invalid={error ? true : undefined}
        onChange={(e) => { setFecha(e.target.value); setError(null); }} />
      <p id={`${id}-ayuda`} className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        Queda registrado que la digitaste tú. Vence 30 días después.
      </p>
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1 text-xs" style={{ color: 'var(--flit-danger-text)' }}>{error}</p>
      )}
      <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" className={`${flitBtnSecondarySm} w-full justify-center sm:w-auto`} disabled={guardando} onClick={onCancelar}>
          Cancelar
        </button>
        <button type="submit" className={`${flitBtnSecondarySm} w-full justify-center sm:w-auto`} disabled={guardando}
          aria-busy={guardando || undefined}>
          {guardando ? 'Guardando…' : 'Guardar fecha'}
        </button>
      </div>
    </form>
  );
}
