// FLITO — Impuestos: número, fecha y avalúo de la factura en el detalle (HU #14664, Feature #14662).
// Vive fuera de `DetalleImpuesto.tsx` por el mismo reparto que `DireccionComprador.tsx`
// (docs/ux/impuestos-correccion-datos-factura.md): sección propia, entre «Validación factura ↔ RUNT»
// y «Dirección del comprador», sin vocabulario de semáforo y sin negarse con un impuesto certificado
// (a diferencia de «Reintentar validación»).
//
// Estos tres datos no afectan el semáforo ni la certificación: son de solo exhibición + corrección
// manual. El chip es de CONFIABILIDAD del OCR (mismo lenguaje que `FlitoRevisiones.tsx` para
// `CampoExtraido`), nunca de semáforo RUNT.

import { useState, type FormEvent } from 'react';
import type {
  CampoExtraido, CorregirDocumentoFacturaBody, DatosDocumentoFacturaImpuesto, ReintentarDocumentoFacturaBody,
  UltimoCambioDocumentoFactura,
} from '@operaciones/shared-types';
import { ApiError, api } from '../../lib/api';
import { Girador } from '../flit/Cargador';
import GradientButton from '../flit/GradientButton';
import { Icono } from '../flit/kit/Icono';
import StatusChip from '../flit/StatusChip';
import { toastOk } from '../flit/ToastFlito';
import { FlitField, flitInp } from '../flit/flitPageKit';
import { fecha } from './ImpuestoCola';

type Forma = 'corregir' | 'reintentar';

const SECUNDARIO = 'text-[color:var(--color-text-secondary)]';
const PELIGRO = 'text-sm text-[color:var(--kit-rojo-texto)]';

/** Texto del error de GUARDAR una corrección. Nunca el mensaje crudo del API: se decide por el status. */
function falloCorregir(e: unknown): string {
  if (e instanceof ApiError && e.status === 403) return 'No tienes permiso para corregir estos datos.';
  if (e instanceof ApiError && e.status === 404) return 'Este impuesto ya no está en la cola. Actualízala.';
  if (e instanceof ApiError && e.status === 400) {
    return 'Escribe el motivo de la corrección (mínimo 5 caracteres) y revisa los valores.';
  }
  return 'No se pudo guardar la corrección. Revisa tu conexión e inténtalo de nuevo.';
}

/** Texto del error de REINTENTAR la lectura. 409 `FACTURA_NO_DISPONIBLE` muestra el texto del API, nunca otro. */
function falloReintentar(e: unknown): string {
  if (e instanceof ApiError && e.status === 409) {
    const cuerpo = e.rawDetails as Record<string, unknown> | null;
    if (cuerpo?.code === 'FACTURA_NO_DISPONIBLE' && typeof cuerpo.error === 'string') return cuerpo.error;
  }
  if (e instanceof ApiError && e.status === 403) return 'No tienes permiso para reintentar esta lectura.';
  if (e instanceof ApiError && e.status === 404) return 'Este impuesto ya no está en la cola. Actualízala.';
  if (e instanceof ApiError && e.status === 400) return 'Escribe el motivo del reintento (mínimo 5 caracteres).';
  return 'No se pudo reintentar la lectura. Revisa tu conexión e inténtalo de nuevo.';
}

function textoAuditoria(u: UltimoCambioDocumentoFactura): string {
  const accion = u.tipo === 'correccion' ? 'corregido' : 'reintentado';
  return `Último cambio: ${accion} por ${u.usuarioNombre} el ${fecha(u.en)} — "${u.motivo}"`;
}

function ChipConfiabilidad({ campo }: { campo: CampoExtraido | null | undefined }) {
  if (!campo || campo.valor === null) return <StatusChip tone="neutral">Sin dato en la factura</StatusChip>;
  const pct = Math.round(campo.confianza * 100);
  return campo.confiable
    ? <StatusChip tone="success">{pct}% · confiable</StatusChip>
    : <StatusChip tone="warning">{pct}% · no confiable</StatusChip>;
}

function Fila({ etiqueta, campo }: { etiqueta: string; campo: CampoExtraido | null | undefined }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <dt className="text-[11px] uppercase" style={{ color: 'var(--flit-text-muted)' }}>{etiqueta}</dt>
        <dd className="text-sm font-medium text-[color:var(--color-text-primary)]">
          {campo?.valor ?? <span className={SECUNDARIO}>Sin dato en la factura</span>}
        </dd>
      </div>
      <ChipConfiabilidad campo={campo} />
    </div>
  );
}

/** Vacío: ninguno de los 3 campos tiene lectura todavía (certificado anterior a la HU, o sin analizar). */
function sinLectura(datos: DatosDocumentoFacturaImpuesto | null): boolean {
  return !datos || (!datos.numeroFactura && !datos.fechaFactura && !datos.avaluoComercial);
}

/**
 * Sección «Número, fecha y avalúo de la factura» del detalle (HU #14664). Dos botones secundarios en
 * reposo (ninguna primaria): «Corregir» abre un formulario de 3 campos + motivo; «Reintentar lectura»
 * solo pide motivo. `abierta` y `bloqueada` vienen del `accion` compartido de `DetalleImpuesto.tsx`:
 * así esta sección nunca convive con otra acción del detalle (rechazar/asumir/reversar/etc.).
 */
export function DatosDocumentoFactura({
  impId, datos, puedeCorregir, abierta, bloqueada, onAbrir, onCerrar, onActualizado,
}: {
  impId: string; datos: DatosDocumentoFacturaImpuesto | null; puedeCorregir: boolean;
  abierta: Forma | null; bloqueada: boolean;
  onAbrir: (forma: Forma) => void; onCerrar: () => void;
  onActualizado: (d: DatosDocumentoFacturaImpuesto) => void;
}) {
  const vacio = sinLectura(datos);
  return (
    <section aria-labelledby={`factura-datos-${impId}`} className="space-y-2" data-testid="seccion-documento-factura">
      <h3 id={`factura-datos-${impId}`} className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-tertiary)]">
        Número, fecha y avalúo de la factura
      </h3>
      <p className={`text-xs ${SECUNDARIO}`}>Estos datos no afectan el semáforo ni la certificación.</p>

      {abierta === 'corregir' && (
        <FormCorregir impId={impId} datos={datos} onCancelar={onCerrar} onGuardado={onActualizado} />
      )}
      {abierta === 'reintentar' && (
        <FormReintentar impId={impId} onCancelar={onCerrar} onListo={onActualizado} />
      )}

      {!abierta && (
        <>
          {vacio
            ? <p className={`text-sm ${SECUNDARIO}`} data-testid="factura-datos-vacio">Esta factura no se ha leído para el número, la fecha y el avalúo.</p>
            : (
              <dl className="space-y-1.5" data-testid="factura-datos-lleno">
                <Fila etiqueta="Número de factura" campo={datos?.numeroFactura} />
                <Fila etiqueta="Fecha de la factura" campo={datos?.fechaFactura} />
                <Fila etiqueta="Avalúo comercial" campo={datos?.avaluoComercial} />
              </dl>
            )}

          {datos?.ultimoCambio && (
            <p className={`text-xs ${SECUNDARIO}`} data-testid="factura-datos-auditoria">{textoAuditoria(datos.ultimoCambio)}</p>
          )}

          {puedeCorregir && !bloqueada && (
            <div className="flex flex-wrap gap-2">
              {!vacio && (
                <GradientButton type="button" variant="secondary" onClick={() => onAbrir('corregir')}>
                  Corregir
                </GradientButton>
              )}
              <GradientButton type="button" variant="secondary" onClick={() => onAbrir('reintentar')}>
                <Icono nombre="reintento" size={16} className="shrink-0" />
                Reintentar lectura
              </GradientButton>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function FormCorregir({ impId, datos, onCancelar, onGuardado }: {
  impId: string; datos: DatosDocumentoFacturaImpuesto | null;
  onCancelar: () => void; onGuardado: (d: DatosDocumentoFacturaImpuesto) => void;
}) {
  const [numeroFactura, setNumeroFactura] = useState(datos?.numeroFactura?.valor ?? '');
  const [fechaFactura, setFechaFactura] = useState(datos?.fechaFactura?.valor ?? '');
  const [avaluoComercial, setAvaluoComercial] = useState(datos?.avaluoComercial?.valor ?? '');
  const [motivo, setMotivo] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [fallo, setFallo] = useState<string | null>(null);

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    if (motivo.trim().length < 5) return;
    const body: CorregirDocumentoFacturaBody = {
      numeroFactura: numeroFactura.trim(), fechaFactura: fechaFactura.trim(), avaluoComercial: avaluoComercial.trim(),
      motivo: motivo.trim(),
    };
    setGuardando(true);
    setFallo(null);
    try {
      const actualizado = await api.patch<DatosDocumentoFacturaImpuesto>(`/flito/impuestos/${impId}/documento-factura`, body);
      toastOk('Corrección guardada.', { id: `documento-factura-${impId}` });
      onGuardado(actualizado);
    } catch (err) {
      setFallo(falloCorregir(err));
    } finally {
      setGuardando(false);
    }
  };

  return (
    <form onSubmit={guardar} noValidate className="space-y-3" data-testid="form-corregir-documento-factura">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <FlitField label="Número de factura">
          <input className={flitInp} value={numeroFactura} onChange={(e) => setNumeroFactura(e.target.value)} autoComplete="off" />
        </FlitField>
        <FlitField label="Fecha de la factura">
          <input type="date" className={flitInp} value={fechaFactura} onChange={(e) => setFechaFactura(e.target.value)} />
        </FlitField>
        <FlitField label="Avalúo comercial">
          <input className={flitInp} value={avaluoComercial} onChange={(e) => setAvaluoComercial(e.target.value)} autoComplete="off" />
        </FlitField>
      </div>
      <FlitField label="Motivo de la corrección (mín. 5 caracteres)">
        <textarea className={`${flitInp} min-h-[64px]`} value={motivo} onChange={(e) => setMotivo(e.target.value)}
          aria-describedby={fallo ? `factura-corregir-error-${impId}` : undefined} />
      </FlitField>
      {fallo && (
        <p id={`factura-corregir-error-${impId}`} role="alert" data-testid="factura-corregir-error" className={PELIGRO}>{fallo}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <GradientButton type="submit" ocupado={guardando} disabled={motivo.trim().length < 5}>
          {guardando ? 'Guardando…' : 'Guardar corrección'}
        </GradientButton>
        <GradientButton type="button" variant="secondary" onClick={onCancelar}>Cancelar</GradientButton>
      </div>
    </form>
  );
}

function FormReintentar({ impId, onCancelar, onListo }: {
  impId: string; onCancelar: () => void; onListo: (d: DatosDocumentoFacturaImpuesto) => void;
}) {
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [fallo, setFallo] = useState<string | null>(null);

  const reintentar = async (e: FormEvent) => {
    e.preventDefault();
    if (motivo.trim().length < 5) return;
    const body: ReintentarDocumentoFacturaBody = { motivo: motivo.trim() };
    setEnviando(true);
    setFallo(null);
    try {
      const actualizado = await api.post<DatosDocumentoFacturaImpuesto>(`/flito/impuestos/${impId}/documento-factura/reintentar`, body);
      toastOk('Lectura actualizada.', { id: `documento-factura-reintentar-${impId}` });
      onListo(actualizado);
    } catch (err) {
      setFallo(falloReintentar(err));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <form onSubmit={reintentar} noValidate className="space-y-3" data-testid="form-reintentar-documento-factura">
      <p className={`text-sm ${SECUNDARIO}`}>
        Vuelve a leer la factura de venta solo para estos tres datos. No toca el semáforo, la certificación ni la comparación con el RUNT.
      </p>
      <FlitField label="Motivo del reintento (mín. 5 caracteres)">
        <textarea className={`${flitInp} min-h-[64px]`} value={motivo} onChange={(e) => setMotivo(e.target.value)}
          aria-describedby={fallo ? `factura-reintentar-error-${impId}` : undefined} />
      </FlitField>
      {fallo && (
        <p id={`factura-reintentar-error-${impId}`} role="alert" data-testid="factura-reintentar-error" className={PELIGRO}>{fallo}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <GradientButton type="submit" ocupado={enviando} disabled={motivo.trim().length < 5}>
          {enviando ? 'Reintentando…' : 'Reintentar lectura'}
        </GradientButton>
        <GradientButton type="button" variant="secondary" onClick={onCancelar}>Cancelar</GradientButton>
      </div>
    </form>
  );
}

/** Cargando y error de la petición del detalle, calco de `EstadoCargaDireccion` (mismo fetch compartido). */
export function EstadoCargaDocumentoFactura({ fase, onRecargar }: { fase: 'cargando' | 'error'; onRecargar: () => void }) {
  if (fase === 'cargando') {
    return (
      <p role="status" className={`flex items-center gap-2 text-sm ${SECUNDARIO}`}>
        <Girador />
        Cargando los datos de la factura…
      </p>
    );
  }
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
      <p className={PELIGRO}>No se pudo cargar los datos de la factura. Inténtalo de nuevo.</p>
      <GradientButton type="button" variant="secondary" size="sm" onClick={onRecargar}>Volver a cargar</GradientButton>
    </div>
  );
}
