// FLITO — Impuestos: validación factura de venta ↔ RUNT en la cola (HU #12830, Épica #12809).
// Vive fuera de `FlitoImpuestos.tsx` porque la página está al borde de `max-lines`
// (docs/ux/impuestos-analisis-factura-runt.md, «Reparto de archivos»). La página solo monta lo de aquí.
//
// La HU #12830 trae la marca de la fila (`LineaValidacion`), el aviso tras el envío masivo
// (`AvisoAnalisis`) y el preset «Con alertas». La HU #12831 trae el modal comparativo
// (`ModalValidacion`, abierto desde el icono de la fila) y la sección del detalle
// (`SeccionValidacion`), que comparten `TablaFacturaRunt`. «Reintentar validación» es de la HU
// #12832: `ReintentarValidacion`, que la página engancha en el hueco `accionReintento`.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CircleCheck, CircleHelp, CircleX, LoaderCircle, RotateCw, TriangleAlert, X } from 'lucide-react';
import {
  ANALISIS_ESTADO_IMPUESTO_LABEL, CAMPO_COMPARACION_FACTURA_RUNT_LABEL, MOTIVO_SEMAFORO_ROJO_LABEL,
  SEMAFORO_IMPUESTO_LABEL,
  type AnalisisEstadoImpuesto, type ComparacionCampoFacturaRunt, type ComparacionFacturaRunt,
  type DireccionCompradorImpuesto, type MotivoSemaforoRojo, type SemaforoImpuesto,
} from '@operaciones/shared-types';
import { ApiError, api } from '../../lib/api';
import FlitModal from '../flit/FlitModal';
import StatusChip from '../flit/StatusChip';
import { toastOk } from '../flit/ToastFlito';
import {
  FlitTable, FlitTh, FlitTr, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondarySm, flitBtnSecondaryStyle,
} from '../flit/flitPageKit';

/** Lo que la fila de la cola trae del análisis post-envío. `undefined` se trata como `null`. */
export interface ValidacionFila {
  analisisEstado?: AnalisisEstadoImpuesto | null;
  semaforo?: SemaforoImpuesto | null;
  motivoSemaforo?: MotivoSemaforoRojo | null;
}

/**
 * Los colores que cuentan como alerta en el preset. `error_analisis` sin semáforo NO entra: el AC
 * dice «naranja o rojo», y el filtro es de servidor sobre la columna `semaforo`.
 */
export const SEMAFOROS_ALERTA: readonly SemaforoImpuesto[] = ['naranja', 'rojo'];

export const PRESET_CON_ALERTAS = {
  nombre: 'Con alertas',
  descripcion: 'Semáforo naranja o rojo: la factura no cuadra con el RUNT o no se pudo validar.',
};

export const VACIO_CON_ALERTAS =
  'Ningún impuesto tiene alertas con estos filtros. Quita el preset para ver toda la cola.';

type Marca = { texto: string; icono: ReactNode; color: string; clave: string };

/**
 * Una sola marca por fila, en el orden de la spec: `en_curso` manda sobre cualquier color viejo;
 * `error_analisis` se pinta como rojo porque para quien opera es lo mismo (no está validado).
 */
function marcaDe(v: ValidacionFila): Marca | 'analizando' | null {
  const estado = v.analisisEstado ?? null;
  if (estado === 'en_curso') return 'analizando';
  if (estado === 'error_analisis') {
    return {
      clave: 'error_analisis', color: 'var(--flit-danger-text)', icono: <CircleX size={18} aria-hidden="true" />,
      texto: 'Sin validar: la validación no terminó. Ver opciones',
    };
  }
  switch (v.semaforo ?? null) {
    case 'verde':
      return {
        clave: 'verde', color: 'var(--flit-success-text)', icono: <CircleCheck size={18} aria-hidden="true" />,
        texto: `${SEMAFORO_IMPUESTO_LABEL.verde}. Ver comparación`,
      };
    case 'naranja':
      return {
        clave: 'naranja', color: 'var(--flit-warning-text)', icono: <TriangleAlert size={18} aria-hidden="true" />,
        texto: 'Con diferencias frente al RUNT. Ver comparación',
      };
    case 'rojo':
      return {
        clave: 'rojo', color: 'var(--flit-danger-text)', icono: <CircleX size={18} aria-hidden="true" />,
        texto: v.motivoSemaforo ? `Sin validar: ${MOTIVO_SEMAFORO_ROJO_LABEL[v.motivoSemaforo]}` : 'Sin validar. Ver comparación',
      };
    default:
      return null;
  }
}

/**
 * La marca de validación de la celda Trámite. Con `null` (nunca analizado) no pinta nada, igual que
 * `AccionCertificacion`. «Analizando» es un chip, no un botón: no bloquea la fila.
 */
export function LineaValidacion({ fila, onAbrir }: { fila: ValidacionFila; onAbrir?: () => void }) {
  const marca = marcaDe(fila);
  if (marca === null) return null;
  if (marca === 'analizando') {
    return (
      <span data-testid="validacion-analizando">
        <StatusChip tone="active"
          icono={<LoaderCircle size={12} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />}>
          {ANALISIS_ESTADO_IMPUESTO_LABEL.en_curso}
        </StatusChip>
      </span>
    );
  }
  return (
    <button type="button" aria-label={marca.texto} title={marca.texto} onClick={onAbrir}
      data-semaforo={marca.clave}
      className="grid h-7 w-7 shrink-0 place-items-center rounded flit-focus transition-colors hover:bg-[var(--flit-bg-hover)]"
      style={{ color: marca.color }}>
      {marca.icono}
    </button>
  );
}

/** La marca junto a la acción de certificación, envolviendo si la columna se estrecha. */
export function AccionesTramite({ fila, onAbrir, children }: { fila: ValidacionFila; onAbrir?: () => void; children: ReactNode }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <LineaValidacion fila={fila} onAbrir={onAbrir} />
      {children}
    </span>
  );
}

export interface EnvioAnalisis { n: number; aOperaciones: boolean }

/**
 * Aviso tras el envío masivo (AC3). Es estado que sigue siendo cierto mientras se mira la página:
 * va en la página (`role="status"`), no en toast. Cerrable; con 0 enviados no se pinta.
 */
export function AvisoAnalisis({ envio, onActualizar, onCerrar }: {
  envio: EnvioAnalisis | null; onActualizar: () => void; onCerrar: () => void;
}) {
  if (!envio || envio.n <= 0) return null;
  const { n, aOperaciones } = envio;
  const uno = n === 1;
  const destino = aOperaciones ? 'a Operaciones' : 'al gestor';
  const texto = `${n} ${uno ? 'impuesto enviado' : 'impuestos enviados'} ${destino}. `
    + `${n} ${uno ? 'queda' : 'quedan'} en análisis contra el RUNT; el semáforo aparece en cada fila al terminar.`;
  return (
    <div role="status" data-testid="aviso-analisis"
      className="flex flex-wrap items-center justify-between gap-3 bg-flit-card px-6 py-4"
      style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}>
      <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{texto}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={flitBtnSecondarySm} style={flitBtnSecondaryStyle} onClick={onActualizar}>
          Actualizar la cola
        </button>
        <button type="button" aria-label="Cerrar aviso" title="Cerrar aviso" onClick={onCerrar}
          className="grid h-7 w-7 place-items-center rounded flit-focus transition-colors hover:bg-[var(--flit-bg-hover)]"
          style={{ color: 'var(--flit-text-secondary)' }}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

// ─────────────────── HU #12831: modal comparativo y sección del detalle ───────────────────

/** Lo que el modal y la sección leen de `GET /flito/impuestos/:id`. */
interface DetalleValidacion extends ValidacionFila {
  comparacion: ComparacionFacturaRunt | null;
  direccionComprador: DireccionCompradorImpuesto | null;
}

type Carga =
  | { fase: 'cargando' }
  | { fase: 'error' }
  | { fase: 'listo'; datos: DetalleValidacion };

/**
 * Pide el detalle al abrirse. El error nunca muestra el mensaje del API: la vista pinta su propio
 * copy con un botón para volver a pedirlo.
 */
function useDetalleValidacion(id: string, activo: boolean) {
  const [carga, setCarga] = useState<Carga>({ fase: 'cargando' });
  const [intento, setIntento] = useState(0);
  useEffect(() => {
    if (!activo) return;
    let vivo = true;
    setCarga({ fase: 'cargando' });
    api.get<DetalleValidacion>(`/flito/impuestos/${id}`)
      .then((datos) => { if (vivo) setCarga({ fase: 'listo', datos }); })
      .catch(() => { if (vivo) setCarga({ fase: 'error' }); });
    return () => { vivo = false; };
  }, [id, activo, intento]);
  const recargar = useCallback(() => setIntento((n) => n + 1), []);
  return { carga, recargar };
}

/**
 * Copy del rojo por motivo (AC3): [lo que pasó, lo que sigue]. `error_analisis` no tiene motivo: es la
 * validación que no terminó. Sin el permiso de reintentar, «lo que sigue» es `CIERRE_SIN_PERMISO` (spec UX).
 */
const TEXTO_SIN_VALIDAR: Record<MotivoSemaforoRojo | 'error_analisis', [string, string]> = {
  runt_sin_respuesta: [`${MOTIVO_SEMAFORO_ROJO_LABEL.runt_sin_respuesta}. Puede ser una caída momentánea o un traspaso `
    + 'que aún sincroniza.', 'Reintenta la validación en unos minutos.'],
  error_lectura_factura: [`${MOTIVO_SEMAFORO_ROJO_LABEL.error_lectura_factura}.`,
    'Revisa que la factura de venta en FLIT sea legible y reintenta la validación.'],
  error_analisis: ['La validación no terminó por un error técnico.', 'Reintenta en unos minutos.'],
};
const CIERRE_SIN_PERMISO = 'Pide a quien certifica en tu equipo que reintente la validación.';

const lista = (cs: ComparacionCampoFacturaRunt[]) => cs.map((c) => CAMPO_COMPARACION_FACTURA_RUNT_LABEL[c.campo]).join(', ');

/**
 * Resumen en lenguaje claro. Cuenta sobre los campos, no sobre `resumen`, porque tiene que nombrarlos.
 * La dirección no entra: no se compara. `no_verificable` no es diferencia, pero tampoco coincide.
 */
export function resumenComparacion(campos: ComparacionCampoFacturaRunt[]): string {
  const difieren = campos.filter((c) => c.resultado === 'difiere');
  const sinVerificar = campos.filter((c) => c.resultado === 'no_verificable');
  if (difieren.length === 0 && sinVerificar.length === 0) return `Los ${campos.length} datos coinciden con el RUNT.`;
  const partes: string[] = [];
  if (difieren.length > 0) {
    partes.push(difieren.length === 1
      ? `1 dato no coincide: ${lista(difieren)}.`
      : `${difieren.length} datos no coinciden: ${lista(difieren)}.`);
  }
  if (sinVerificar.length > 0) {
    partes.push(sinVerificar.length === 1
      ? `1 dato no se pudo verificar: ${lista(sinVerificar)}.`
      : `${sinVerificar.length} datos no se pudieron verificar: ${lista(sinVerificar)}.`);
  }
  return partes.join(' ');
}

const RESULTADO: Record<ComparacionCampoFacturaRunt['resultado'], { texto: string; color: string; icono: ReactNode }> = {
  coincide: { texto: 'Coincide', color: 'var(--flit-success-text)', icono: <CircleCheck size={18} aria-hidden="true" /> },
  difiere: { texto: 'No coincide', color: 'var(--flit-warning-text)', icono: <TriangleAlert size={18} aria-hidden="true" /> },
  // Neutro, no naranja: falta el dato de un lado; no es una diferencia (shared-types, `no_verificable`).
  no_verificable: { texto: 'No se pudo verificar', color: 'var(--flit-text-secondary)', icono: <CircleHelp size={18} aria-hidden="true" /> },
};

const td = 'px-4 py-2 align-top text-sm';
const SIN_DATO = <span style={{ color: 'var(--flit-text-secondary)' }}>Sin dato</span>;

function textoDireccion(d: DireccionCompradorImpuesto | null): string | null {
  if (!d?.direccion) return null;
  const lugar = [d.municipio, d.departamento].filter(Boolean).join(', ');
  return lugar ? `${d.direccion}, ${lugar}` : d.direccion;
}

/** La tabla de dos columnas del AC1. La comparten el modal y la sección del detalle (no es copia). */
export function TablaFacturaRunt({ campos, direccion }: {
  campos: ComparacionCampoFacturaRunt[]; direccion: DireccionCompradorImpuesto | null;
}) {
  const dir = textoDireccion(direccion);
  return (
    <FlitTable label="Comparación de la factura de venta con el RUNT">
      <thead>
        <tr>
          <FlitTh>Dato</FlitTh><FlitTh>En factura</FlitTh><FlitTh>En RUNT</FlitTh>
          <FlitTh center estrecha><span className="sr-only">Resultado</span></FlitTh>
        </tr>
      </thead>
      <tbody>
        {campos.map((c) => {
          const r = RESULTADO[c.resultado];
          return (
            <FlitTr key={c.campo}>
              <th scope="row" className={`${td} text-left font-medium`}>{CAMPO_COMPARACION_FACTURA_RUNT_LABEL[c.campo]}</th>
              <td className={td}>
                {c.valorFactura ?? SIN_DATO}
                {c.nota === 'electrico' && (
                  <span className="block text-xs" style={{ color: 'var(--flit-text-secondary)' }}>Vehículo eléctrico</span>
                )}
              </td>
              <td className={td}>{c.valorRunt ?? SIN_DATO}</td>
              <td className={`${td} text-center`} data-resultado={c.resultado}>
                <span className="inline-grid place-items-center" style={{ color: r.color }} title={r.texto}>
                  {r.icono}<span className="sr-only">{r.texto}</span>
                </span>
              </td>
            </FlitTr>
          );
        })}
        <FlitTr>
          <th scope="row" className={`${td} text-left font-medium`}>Dirección del comprador</th>
          <td className={td}>
            {dir ?? SIN_DATO}
            {direccion?.pendienteRevision && (
              <span className="mt-1 block"><StatusChip tone="warning">Sin confirmar</StatusChip></span>
            )}
          </td>
          <td className={td} style={{ color: 'var(--flit-text-secondary)' }}>No aplica</td>
          <td className={`${td} text-center`} style={{ color: 'var(--flit-text-secondary)' }}>
            <span aria-label="No se compara" role="img">—</span>
          </td>
        </FlitTr>
      </tbody>
    </FlitTable>
  );
}

const texto = (color = 'var(--flit-text-primary)') => ({ color });

/**
 * El cuerpo común de la validación según el estado. Lo pintan el modal y la sección; los 4 estados
 * de la petición se resuelven antes, en quien pide el detalle.
 */
function CuerpoValidacion({ datos, accionReintento, sinPermiso }: {
  datos: DetalleValidacion; accionReintento?: ReactNode; sinPermiso?: boolean;
}) {
  const estado = datos.analisisEstado ?? null;
  const cmp = datos.comparacion;
  if (estado === null) {
    return <p style={texto('var(--flit-text-secondary)')}>Este impuesto aún no se ha validado contra el RUNT. Se valida al enviarlo al gestor.</p>;
  }
  if (estado === 'en_curso') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <LineaValidacion fila={{ analisisEstado: 'en_curso' }} />
        <p style={texto('var(--flit-text-secondary)')}>La validación está en curso. Cierra y actualiza la cola en unos minutos.</p>
      </div>
    );
  }
  const motivo = estado === 'error_analisis' ? 'error_analisis' : (cmp?.motivo ?? (datos.semaforo === 'rojo' ? datos.motivoSemaforo : null) ?? null);
  if (motivo) {
    return (
      <div className="space-y-3" data-testid="validacion-sin-validar">
        <StatusChip tone="danger" icono={<CircleX size={12} aria-hidden="true" />}>{SEMAFORO_IMPUESTO_LABEL.rojo}</StatusChip>
        <p style={texto()}>{TEXTO_SIN_VALIDAR[motivo][0]} {sinPermiso ? CIERRE_SIN_PERMISO : TEXTO_SIN_VALIDAR[motivo][1]}</p>
        {cmp && cmp.campos.length > 0 && <TablaFacturaRunt campos={cmp.campos} direccion={datos.direccionComprador} />}
        {accionReintento && <div className="flex flex-wrap items-center gap-2">{accionReintento}</div>}
      </div>
    );
  }
  if (!cmp || cmp.campos.length === 0) {
    return <p style={texto('var(--flit-text-secondary)')}>No hay comparación guardada para este impuesto. Actualiza la cola para ver el último resultado.</p>;
  }
  const conDiferencias = cmp.campos.some((c) => c.resultado !== 'coincide');
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {conDiferencias
          ? <StatusChip tone="warning" icono={<TriangleAlert size={12} aria-hidden="true" />}>{SEMAFORO_IMPUESTO_LABEL.naranja}</StatusChip>
          : <StatusChip tone="success" icono={<CircleCheck size={12} aria-hidden="true" />}>{SEMAFORO_IMPUESTO_LABEL.verde}</StatusChip>}
        <p className="font-semibold" data-testid="validacion-resumen" style={texto()}>{resumenComparacion(cmp.campos)}</p>
      </div>
      <TablaFacturaRunt campos={cmp.campos} direccion={datos.direccionComprador} />
    </div>
  );
}

/** Cargando, error con reintento de la petición, y lo lleno. El vacío lo resuelve `CuerpoValidacion`. */
function EstadosCarga({ carga, recargar, children }: { carga: Carga; recargar: () => void; children: (d: DetalleValidacion) => ReactNode }) {
  if (carga.fase === 'cargando') {
    return (
      <p role="status" className="flex items-center gap-2" style={texto('var(--flit-text-secondary)')}>
        <LoaderCircle size={16} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
        Cargando la validación…
      </p>
    );
  }
  if (carga.fase === 'error') {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3">
        <p style={texto('var(--flit-danger-text)')}>No se pudo cargar la validación. Inténtalo de nuevo.</p>
        <button type="button" className={flitBtnSecondarySm} style={flitBtnSecondaryStyle} onClick={recargar}>Volver a cargar</button>
      </div>
    );
  }
  return <>{children(carga.datos)}</>;
}

/** Lo mínimo de la fila que el modal necesita (sin importar `ImpuestoItem`, que importa de aquí). */
export interface FilaValidacion extends ValidacionFila { id: string; placa: string | null; vin: string }

/**
 * Modal del semáforo (AC1, AC3). Visita de consulta: en verde o naranja no hay primaria.
 * `accionReintento` es el hueco de la HU #12832 («Reintentar validación», la única primaria en rojo).
 */
export function ModalValidacion({ imp, onClose, onVerDetalle, accionReintento, sinPermiso }: {
  imp: FilaValidacion; onClose: () => void; onVerDetalle: () => void; accionReintento?: ReactNode; sinPermiso?: boolean;
}) {
  const { carga, recargar } = useDetalleValidacion(imp.id, true);
  return (
    <FlitModal title={`Validación factura ↔ RUNT · ${imp.placa ?? imp.vin}`} onClose={onClose} wide>
      <div className="space-y-4 text-sm" data-testid="modal-validacion">
        <EstadosCarga carga={carga} recargar={recargar}>
          {(datos) => <CuerpoValidacion datos={{ ...imp, ...datos }} sinPermiso={sinPermiso} />}
        </EstadosCarga>
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onVerDetalle}>Ver detalle</button>
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>Cerrar</button>
          {accionReintento}
        </div>
      </div>
    </FlitModal>
  );
}

/**
 * Sección «Validación factura ↔ RUNT» del detalle (AC2). Con el análisis terminado pide el detalle;
 * nunca analizado o en curso no hay nada que pedir.
 */
export function SeccionValidacion({ imp, accionReintento, sinPermiso }: {
  imp: FilaValidacion; accionReintento?: ReactNode; sinPermiso?: boolean;
}) {
  const estado = imp.analisisEstado ?? null;
  const terminado = estado === 'completado' || estado === 'error_analisis';
  const { carga, recargar } = useDetalleValidacion(imp.id, terminado);
  return (
    <section aria-labelledby={`validacion-${imp.id}`} className="space-y-2" data-testid="seccion-validacion">
      <h3 id={`validacion-${imp.id}`} className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>
        Validación factura ↔ RUNT
      </h3>
      {terminado
        ? (
          <EstadosCarga carga={carga} recargar={recargar}>
            {(datos) => <CuerpoValidacion datos={{ ...imp, ...datos }} accionReintento={accionReintento} sinPermiso={sinPermiso} />}
          </EstadosCarga>
        )
        : <CuerpoValidacion datos={{ ...imp, comparacion: null, direccionComprador: null }} />}
    </section>
  );
}

// ─────────────────── HU #12832: «Reintentar validación» ───────────────────

/** Lo que el reintento mira de la fila: la validación y si ya hay certificación vigente. */
export interface FilaReintento extends ValidacionFila { id: string; certificacion?: unknown }

/** AC2: sin certificación vigente, en rojo (cualquier motivo) o `error_analisis`, y no en curso. */
export function ofreceReintento(f: FilaReintento): boolean {
  if (f.certificacion || f.analisisEstado === 'en_curso') return false;
  return f.semaforo === 'rojo' || f.analisisEstado === 'error_analisis';
}

/** Desenlace de un reintento fallido, con su copy (spec UX). Se decide por `code`, nunca por el texto. */
type FalloReintento = { texto: string; efecto?: 'en_curso' | 'certificado' };

const FALLO_409: Record<string, FalloReintento> = {
  ANALISIS_EN_CURSO: { texto: 'Esta validación ya está en curso. Actualiza la cola en unos minutos.', efecto: 'en_curso' },
  YA_CERTIFICADO: { texto: 'Este impuesto ya está certificado; no hace falta validarlo de nuevo.', efecto: 'certificado' },
  NO_SOLICITADO: { texto: 'Solo se valida un impuesto enviado al gestor.' },
  SIN_ANALISIS: { texto: 'Este impuesto no tiene una validación que reintentar.' },
};
const FALLO_GENERICO = 'No se pudo reintentar la validación. Inténtalo de nuevo en unos minutos.';

export function falloReintento(e: unknown): FalloReintento {
  if (!(e instanceof ApiError)) return { texto: FALLO_GENERICO };
  const cuerpo = e.rawDetails as Record<string, unknown> | null;
  const code = typeof cuerpo?.code === 'string' ? cuerpo.code : null;
  if (e.status === 409 && code && FALLO_409[code]) return FALLO_409[code];
  if (e.status === 404) return { texto: 'Este impuesto ya no está en la cola. Actualízala.' };
  if (e.status === 403) return { texto: 'No tienes permiso para reintentar la validación.' };
  if (e.status === 429) return { texto: 'Hiciste varios reintentos seguidos. Espera un minuto e inténtalo de nuevo.' };
  return { texto: FALLO_GENERICO };
}

export const TOAST_REINTENTO = 'Validación en cola. El semáforo nuevo aparece al actualizar la cola.';

/**
 * Botón «Reintentar validación» (AC2, AC3). Primario en el modal rojo (única acción de esa visita),
 * secundario en el detalle. El error va aquí dentro con `role="alert"`, nunca en toast; el éxito es
 * un toast cerrable y la fila la parchea quien lo monta (`onEncolado`). Tras un 409 que cambia el
 * estado (en curso, ya certificado) el aviso se queda y el botón se va: reintentar ya no tiene sentido.
 */
export function ReintentarValidacion({ fila, principal, onEncolado, onYaCertificado }: {
  fila: FilaReintento; principal?: boolean;
  /** `true` = 202 (el modal se cierra); `false` = ya estaba en curso (se queda con el aviso). */
  onEncolado: (encolado: boolean) => void; onYaCertificado: () => void;
}) {
  const [enviando, setEnviando] = useState(false);
  const [fallo, setFallo] = useState<FalloReintento | null>(null);
  if (!ofreceReintento(fila) && !fallo?.efecto) return null;

  const reintentar = async () => {
    setEnviando(true);
    setFallo(null);
    try {
      await api.post(`/flito/impuestos/${fila.id}/reanalizar`);
      toastOk(TOAST_REINTENTO, { id: `reanalizar-${fila.id}` });
      onEncolado(true);
    } catch (e) {
      const f = falloReintento(e);
      setFallo(f);
      if (f.efecto === 'en_curso') onEncolado(false);
      if (f.efecto === 'certificado') onYaCertificado();
    } finally {
      setEnviando(false);
    }
  };

  return (
    <>
      {fallo && (
        <p role="alert" data-testid="reintento-error" className="order-first basis-full text-sm" style={texto('var(--flit-danger-text)')}>
          {fallo.texto}
        </p>
      )}
      {!fallo?.efecto && (
        <button type="button" onClick={reintentar} disabled={enviando} aria-busy={enviando}
          className={principal ? flitBtnPrimary : flitBtnSecondary}
          style={principal ? flitBtnPrimaryStyle : flitBtnSecondaryStyle}>
          {enviando
            ? <LoaderCircle size={16} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />
            : <RotateCw size={16} aria-hidden="true" className="shrink-0" />}
          {enviando ? 'Reintentando…' : 'Reintentar validación'}
        </button>
      )}
    </>
  );
}
