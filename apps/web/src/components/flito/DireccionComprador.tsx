// FLITO — Impuestos: dirección del comprador en el detalle (HU #12834, Épica #12809).
// Vive fuera de `DetalleImpuesto.tsx` por el reparto de la spec (docs/ux/impuestos-analisis-factura-runt.md,
// «Reparto de archivos»): el detalle solo monta `AvisoDireccion` arriba y `DireccionComprador` bajo la
// sección de validación.
//
// La dirección es PII: viaja solo en el body del PATCH, nunca en la URL, y no se loguea.

import { useState, type FormEvent, type RefObject } from 'react';
import { LoaderCircle, TriangleAlert } from 'lucide-react';
import type { CorregirDireccionImpuestoBody, DireccionCompradorImpuesto } from '@operaciones/shared-types';
import { ApiError, api } from '../../lib/api';
import { toastOk } from '../flit/ToastFlito';
import {
  FlitField, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondarySm, flitBtnSecondaryStyle, flitInp,
} from '../flit/flitPageKit';
import { fecha } from './ImpuestoCola';

type Campo = keyof CorregirDireccionImpuestoBody;

/** Los topes del PATCH (zod en la API, HU #12833). Se aplican aquí para que el 400 no llegue. */
const TOPE: Record<Campo, number> = { direccion: 200, municipio: 100, departamento: 100 };
const FALTA: Record<Campo, string> = {
  direccion: 'Escribe la dirección.',
  municipio: 'Escribe el municipio.',
  departamento: 'Escribe el departamento.',
};

const AVISO_CON_PERMISO = 'Dirección sin confirmar — revísala y guárdala.';
const AVISO_SIN_PERMISO = 'Dirección sin confirmar. Debe revisarla alguien con permiso para corregir direcciones.';
const BLOQUEADA = 'Termina o cancela la acción en curso para editar la dirección.';

/** Texto del error del guardado. Nunca el mensaje crudo del API: se decide por el status. */
export function falloGuardado(e: unknown): string {
  if (e instanceof ApiError && e.status === 403) return 'No tienes permiso para corregir la dirección.';
  if (e instanceof ApiError && e.status === 404) return 'Este impuesto ya no está en la cola. Actualízala.';
  if (e instanceof ApiError && e.status === 400) {
    return 'Revisa la dirección, el municipio y el departamento: los tres son obligatorios. Luego guarda de nuevo.';
  }
  return 'No se pudo guardar la dirección. Revisa tu conexión e inténtalo de nuevo.';
}

function textoDe(d: DireccionCompradorImpuesto | null): string | null {
  if (!d?.direccion) return null;
  const lugar = [d.municipio, d.departamento].filter(Boolean).join(', ');
  return lugar ? `${d.direccion}, ${lugar}` : d.direccion;
}

function origenDe(d: DireccionCompradorImpuesto): string {
  if (d.confirmadaPor) {
    return d.confirmadaEn ? `Confirmada por ${d.confirmadaPor} el ${fecha(d.confirmadaEn)}` : `Confirmada por ${d.confirmadaPor}`;
  }
  if (d.origen === 'factura') return 'Propuesta leída de la factura';
  if (d.origen === 'flit') return 'Tomada de FLIT';
  return 'Corregida a mano';
}

const tarjetaAviso = {
  borderRadius: 'var(--flit-radius-card)',
  border: '1px solid var(--flit-warning)',
  color: 'var(--flit-text-primary)',
};

/**
 * Aviso persistente arriba del detalle (AC1, AC3). Es estado de la página, no toast. Con el permiso
 * trae «Revisar dirección», que lleva el foco al campo; sin él cambia el copy y no ofrece nada.
 */
export function AvisoDireccion({ direccion, puedeCorregir, onRevisar }: {
  direccion: DireccionCompradorImpuesto | null; puedeCorregir: boolean; onRevisar: () => void;
}) {
  if (!direccion?.pendienteRevision) return null;
  return (
    <div role="status" data-testid="aviso-direccion"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-flit-card px-4 py-3" style={tarjetaAviso}>
      <p className="flex items-start gap-2 text-sm font-semibold">
        <TriangleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0" style={{ color: 'var(--flit-warning-text)' }} />
        <span>{puedeCorregir ? AVISO_CON_PERMISO : AVISO_SIN_PERMISO}</span>
      </p>
      {puedeCorregir && (
        <button type="button" onClick={onRevisar}
          className="rounded px-1 text-sm font-semibold underline flit-focus transition-colors hover:bg-[var(--flit-bg-hover)]"
          style={{ color: 'var(--flit-blue-text)' }}>
          Revisar dirección
        </button>
      )}
    </div>
  );
}

/**
 * El bloque «Dirección del comprador» del detalle. Editable solo con el permiso, con la dirección
 * pendiente de revisión y sin otra acción abierta (`bloqueada`): así «Guardar dirección» es la única
 * primaria a la vista. Tras guardar, `onGuardada` recibe el bloque que devolvió la API.
 */
export function DireccionComprador({ impId, direccion, puedeCorregir, bloqueada, campoRef, onGuardada }: {
  impId: string; direccion: DireccionCompradorImpuesto | null; puedeCorregir: boolean; bloqueada: boolean;
  campoRef: RefObject<HTMLInputElement>; onGuardada: (d: DireccionCompradorImpuesto) => void;
}) {
  const editable = puedeCorregir && !!direccion?.pendienteRevision;
  return (
    <section aria-labelledby={`direccion-${impId}`} className="space-y-2" data-testid="seccion-direccion">
      <h3 id={`direccion-${impId}`} tabIndex={-1} className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>
        Dirección del comprador
      </h3>
      {direccion && (
        <p className="text-xs" data-testid="direccion-origen" style={{ color: 'var(--flit-text-secondary)' }}>{origenDe(direccion)}</p>
      )}
      {editable && !bloqueada
        ? <FormDireccion impId={impId} direccion={direccion} campoRef={campoRef} onGuardada={onGuardada} />
        : (
          <>
            <p className="text-sm font-medium" data-testid="direccion-texto">
              {textoDe(direccion) ?? <span style={{ color: 'var(--flit-text-secondary)' }}>Sin dirección registrada</span>}
            </p>
            {editable && bloqueada && (
              <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{BLOQUEADA}</p>
            )}
          </>
        )}
    </section>
  );
}

function FormDireccion({ impId, direccion, campoRef, onGuardada }: {
  impId: string; direccion: DireccionCompradorImpuesto; campoRef: RefObject<HTMLInputElement>;
  onGuardada: (d: DireccionCompradorImpuesto) => void;
}) {
  // Prellenado: la propuesta leída de la factura y, si no hay, la dirección efectiva (contrato 12833).
  const base = direccion.propuesta;
  const [valores, setValores] = useState<CorregirDireccionImpuestoBody>({
    direccion: base?.direccion ?? direccion.direccion ?? '',
    municipio: base?.municipio ?? direccion.municipio ?? '',
    departamento: base?.departamento ?? direccion.departamento ?? '',
  });
  const [faltan, setFaltan] = useState<Partial<Record<Campo, string>>>({});
  const [guardando, setGuardando] = useState(false);
  const [fallo, setFallo] = useState<string | null>(null);

  const cambiar = (c: Campo, v: string) => {
    setValores((prev) => ({ ...prev, [c]: v }));
    if (faltan[c]) setFaltan((prev) => ({ ...prev, [c]: undefined }));
  };

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    const body: CorregirDireccionImpuestoBody = {
      direccion: valores.direccion.trim(), municipio: valores.municipio.trim(), departamento: valores.departamento.trim(),
    };
    const vacios = (Object.keys(FALTA) as Campo[]).filter((c) => body[c].length === 0);
    if (vacios.length > 0) {
      setFaltan(Object.fromEntries(vacios.map((c) => [c, FALTA[c]])));
      if (vacios[0] === 'direccion') campoRef.current?.focus();
      return;
    }
    setGuardando(true);
    setFallo(null);
    try {
      const nueva = await api.patch<DireccionCompradorImpuesto>(`/flito/impuestos/${impId}/direccion`, body);
      toastOk('Dirección guardada.', { id: `direccion-${impId}` });
      onGuardada(nueva);
    } catch (err) {
      setFallo(falloGuardado(err));
    } finally {
      setGuardando(false);
    }
  };

  const campo = (c: Campo, label: string, ancho = false) => (
    <div className={ancho ? 'sm:col-span-2' : undefined}>
      <FlitField label={label}>
        <input ref={c === 'direccion' ? campoRef : undefined} className={flitInp} value={valores[c]}
          maxLength={TOPE[c]} required aria-invalid={faltan[c] ? true : undefined}
          aria-describedby={faltan[c] ? `falta-${c}-${impId}` : undefined}
          onChange={(e) => cambiar(c, e.target.value)} autoComplete="off" />
      </FlitField>
      {faltan[c] && (
        <p id={`falta-${c}-${impId}`} className="mt-1 text-xs" style={{ color: 'var(--flit-danger-text)' }}>{faltan[c]}</p>
      )}
    </div>
  );

  return (
    <form onSubmit={guardar} noValidate className="space-y-3" data-testid="form-direccion">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {campo('direccion', 'Dirección', true)}
        {campo('municipio', 'Municipio')}
        {campo('departamento', 'Departamento')}
      </div>
      {fallo && (
        <p role="alert" data-testid="direccion-error" className="text-sm" style={{ color: 'var(--flit-danger-text)' }}>{fallo}</p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="submit" disabled={guardando} aria-busy={guardando} className={flitBtnPrimary} style={flitBtnPrimaryStyle}>
          {guardando && <LoaderCircle size={16} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />}
          {guardando ? 'Guardando…' : 'Guardar dirección'}
        </button>
      </div>
    </form>
  );
}

/** Cargando y error del detalle cuando la sección de validación no los pinta (análisis sin terminar). */
export function EstadoCargaDireccion({ fase, onRecargar }: { fase: 'cargando' | 'error'; onRecargar: () => void }) {
  if (fase === 'cargando') {
    return (
      <p role="status" className="flex items-center gap-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
        <LoaderCircle size={16} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
        Cargando la dirección del comprador…
      </p>
    );
  }
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
      <p style={{ color: 'var(--flit-danger-text)' }}>No se pudo cargar la dirección del comprador. Inténtalo de nuevo.</p>
      <button type="button" className={flitBtnSecondarySm} style={flitBtnSecondaryStyle} onClick={onRecargar}>Volver a cargar</button>
    </div>
  );
}
