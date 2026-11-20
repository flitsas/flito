// Una fila del expediente (HU #13892; spec «Estado por documento» y «Acciones y validaciones»).
// La carga es de la fila: solo esta queda ocupada y su error se pinta aquí, junto al archivo que hay
// que corregir (sin toast de error). El archivo fallido se guarda para «Reintentar» hasta elegir otro.
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Download, RotateCw, Upload } from 'lucide-react';
import type { DocumentoBolsaDto, DocumentoExpedienteDto } from '@operaciones/shared-types';
import { bolsasDocumentosApi } from '../../lib/api';
import { errorBolsa, fechaDia, fechaHora } from '../../lib/bolsas';
import {
  ACCEPT_DOCUMENTO_BOLSA, conVigencia, delDocumento, diaBogota, ESTADO_DOCUMENTO, errorArchivoLocal, nombreDocumento,
  participio, tituloDocumento,
} from '../../lib/bolsasDocumentos';
import StatusChip from '../flit/StatusChip';
import { flitBtnIconoSm, flitBtnSecondarySm, flitBtnSecondarySmToggle } from '../flit/flitPageKit';
import { toastOk } from '../flit/ToastFlito';
import EditorFechaExpedicion from './EditorFechaExpedicion';
import HistorialDocumento from './HistorialDocumento';
import ModalRetirarDocumento from './ModalRetirarDocumento';
import { useDescargaDocumentoBolsa } from './useDescargaDocumentoBolsa';

// El input de carga NO se deshabilita mientras sube: si tenía el foco, `disabled` lo tiraría a <body> y
// la trampa del modal lo llevaría al diálogo con scroll al inicio (HU #13892, retrabajo DEV). Se marca
// `aria-disabled` y el candado de `subir` impide la segunda carga.
// `relative`: el input `sr-only` es `position:absolute`; con el label estático su offsetParent era el
// overlay `.flit-modal` (scroll propio), el input quedaba fuera del contenedor interior y, al pulsar
// «Cargar», el navegador desplazaba el overlay para mostrarlo y el modal subía (HU #13892, DEV).
const ANILLO_LABEL =
  'relative cursor-pointer has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-[color:var(--flit-border-focus)] has-[input[aria-disabled=true]]:cursor-not-allowed has-[input[aria-disabled=true]]:opacity-50';

/** `archivo` = el que falló por red/429, para «Reintentar» con el mismo; `null` = sin reintento. */
type ErrorCarga = { texto: string; archivo: File | null };

export interface FilaDocumentoProps {
  companiaId: number;
  doc: DocumentoExpedienteDto;
  /** `.cargar` y la bolsa activa: Cargar, Reemplazar, Corregir y Digitar fecha. */
  puedeCargar: boolean;
  historialAbierto: boolean;
  onHistorial: (abrir: boolean) => void;
  editando: boolean;
  onEditar: (abrir: boolean) => void;
  /** Carga o fecha aceptadas: la fila toma el DTO sin releer. */
  onDocumento: (dto: DocumentoBolsaDto, origen: 'carga' | 'fecha') => void;
  /** Retiro aceptado (E7, HU #13964): la fila se reemplaza con la respuesta, sin releer. */
  onRetirado: (fila: DocumentoExpedienteDto) => void;
  /**
   * 409 (o 404 de la bolsa) en la carga o en la fecha = carrera: bolsa inactivada, carga concurrente o
   * versión reemplazada. Se decide por el status, nunca por el texto del API. Refresca el detalle y E1.
   */
  onCarrera: () => void;
}

export default function FilaDocumento(p: FilaDocumentoProps) {
  const { doc, puedeCargar } = p;
  const { tipo, estado, vigente } = doc;
  const nombre = nombreDocumento(tipo);
  const idHistorial = `historial-${tipo}`;
  const [subiendo, setSubiendo] = useState(false);
  const [errorCarga, setErrorCarga] = useState<ErrorCarga | null>(null);
  const candado = useRef(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [focoFecha, setFocoFecha] = useState(false);
  const fechaRef = useRef<HTMLButtonElement>(null);
  const filaRef = useRef<HTMLLIElement>(null);
  const cargaRef = useRef<HTMLInputElement>(null);
  const [retirando, setRetirando] = useState(false);
  const { descargar, enCurso } = useDescargaDocumentoBolsa();

  // Al cerrar el editor (guardar o cancelar), el foco vuelve a «Corregir» / «Digitar fecha».
  useEffect(() => {
    if (focoFecha && !p.editando) { fechaRef.current?.focus({ preventScroll: true }); setFocoFecha(false); }
  }, [focoFecha, p.editando]);

  const cerrarEditor = () => { p.onEditar(false); setFocoFecha(true); };

  async function subir(archivo: File) {
    if (candado.current) return;
    const local = errorArchivoLocal(archivo);
    if (local) { setErrorCarga({ texto: local, archivo: null }); return; }
    candado.current = true;
    // Si la carga arrancó desde esta fila (input o «Reintentar»), el foco se queda en ella al terminar.
    const focoEnFila = filaRef.current?.contains(document.activeElement) ?? false;
    setSubiendo(true);
    setErrorCarga(null);
    const reemplazo = vigente !== null;
    try {
      const dto = await bolsasDocumentosApi.cargar(p.companiaId, tipo, archivo);
      const hecho = participio(tipo, reemplazo ? 'reemplazad' : 'cargad');
      const texto = conVigencia(tipo)
        ? (reemplazo
          ? `${nombre} ${hecho}. La versión anterior queda en el historial; estamos leyendo la fecha de expedición.`
          : `${nombre} ${hecho}. Estamos leyendo la fecha de expedición.`)
        : (reemplazo ? `${nombre} ${hecho}. La versión anterior queda en el historial.` : `${nombre} ${hecho}.`);
      toastOk(texto, { id: `bolsa-doc-carga-${tipo}`, duracionMs: reemplazo ? 6_000 : 4_000 });
      p.onDocumento(dto, 'carga');
    } catch (e) {
      const { status } = errorBolsa(e);
      if (status === 409 || status === 404) {
        toastOk('Algo cambió mientras guardabas: la bolsa o el documento se actualizaron. Revisa el expediente e intenta de nuevo.', { id: `bolsa-doc-carga-${tipo}`, duracionMs: 6_000 });
        p.onCarrera();
      } else if (status === 400 || status === 413 || status === 415) {
        setErrorCarga({ texto: 'El archivo no es un PDF, JPG o PNG válido, o pesa más de 15 MB.', archivo: null });
      } else if (status === 429) {
        setErrorCarga({ texto: 'Hiciste muchas cargas seguidas. Espera unos minutos e intenta de nuevo.', archivo });
      } else if (status === 403) {
        setErrorCarga({ texto: 'Ya no tienes permiso para cargar documentos.', archivo: null });
      } else {
        setErrorCarga({ texto: 'No pudimos cargar el archivo. Intenta de nuevo.', archivo });
      }
    } finally {
      candado.current = false;
      setSubiendo(false);
      // «Reintentar» se desmonta al reintentar y la fila puede re-renderizar con el DTO nuevo: si el foco
      // salió de la fila, vuelve al control de carga (estable: solo cambia su texto), sin mover el scroll.
      if (focoEnFila) {
        requestAnimationFrame(() => {
          if (!filaRef.current?.contains(document.activeElement)) cargaRef.current?.focus({ preventScroll: true });
        });
      }
    }
  }

  const puedeFecha = puedeCargar && conVigencia(tipo) && vigente !== null && estado !== 'validando' && estado !== 'pendiente';
  const botonFecha = puedeFecha ? (
    <button ref={fechaRef} type="button" className={`${flitBtnSecondarySm} ml-1 align-middle`}
      aria-label={estado === 'no_validado' ? `Digitar la fecha de expedición de ${nombre}` : `Corregir la fecha de expedición de ${nombre}`}
      onClick={() => { if (p.historialAbierto) p.onHistorial(false); p.onEditar(true); }}>
      {estado === 'no_validado' ? 'Digitar fecha' : 'Corregir'}
    </button>
  ) : null;

  const ocupadoDescarga = vigente ? enCurso.has(vigente.id) : false;
  // También en «Validando…» (ADR-0028 adenda A.1); nunca en una fila pendiente.
  const puedeQuitar = puedeCargar && vigente !== null && estado !== 'pendiente';

  return (
    <li ref={filaRef} className="grid grid-cols-1 gap-x-4 gap-y-2 py-3 sm:grid-cols-[1fr_auto]" style={{ borderColor: 'var(--flit-border-soft)' }}
      data-testid={`doc-${tipo}`}>
      <div className="min-w-0 break-words">
        <div className="flex flex-col items-start gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
          <h4 className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{tituloDocumento(tipo)}</h4>
          <StatusChip tone={ESTADO_DOCUMENTO[estado].tono}>{ESTADO_DOCUMENTO[estado].texto}</StatusChip>
        </div>
        {!p.editando && (
          <LineaDetalle doc={doc} puedeCargar={puedeCargar} accion={botonFecha} />
        )}
        {errorCarga && (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <p role="alert" className="min-w-0 text-xs" style={{ color: 'var(--flit-danger-text)' }}>{errorCarga.texto}</p>
            {errorCarga.archivo && (
              <button type="button" className={flitBtnSecondarySm} disabled={subiendo}
                aria-label={`Reintentar la carga de ${nombre}`}
                onClick={() => { if (errorCarga.archivo) void subir(errorCarga.archivo); }}>
                <RotateCw size={14} aria-hidden="true" className="shrink-0" />
                Reintentar
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-start gap-2 sm:justify-end">
        {puedeCargar && (
          <label className={`${flitBtnSecondarySm} ${ANILLO_LABEL}`} aria-busy={subiendo || undefined}>
            <Upload size={14} aria-hidden="true" className="shrink-0" />
            {subiendo ? 'Cargando…' : (vigente ? 'Reemplazar' : 'Cargar')}
            <input ref={cargaRef} type="file" className="sr-only" accept={ACCEPT_DOCUMENTO_BOLSA}
              aria-disabled={subiendo || undefined}
              aria-label={`${vigente ? 'Reemplazar' : 'Cargar'} ${nombre}`}
              onClick={(e) => { if (subiendo) e.preventDefault(); }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) { setErrorCarga(null); void subir(f); }
              }} />
          </label>
        )}
        {vigente && (
          <button type="button" className={flitBtnIconoSm}
            aria-label={`Descargar ${nombre} (versión ${vigente.version})`} title={`Descargar ${nombre} (versión ${vigente.version})`}
            disabled={ocupadoDescarga} aria-busy={ocupadoDescarga || undefined}
            onClick={() => { void descargar(vigente); }}>
            <Download size={14} aria-hidden="true" />
          </button>
        )}
        {doc.tieneHistorial && (
          <button ref={toggleRef} type="button" className={flitBtnSecondarySmToggle}
            aria-expanded={p.historialAbierto} aria-controls={p.historialAbierto ? idHistorial : undefined}
            aria-label={`Ver el historial de ${nombre}`}
            onClick={() => { if (!p.historialAbierto) p.onEditar(false); p.onHistorial(!p.historialAbierto); }}>
            Historial
            {p.historialAbierto ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
          </button>
        )}
        {/* Al final de la barra y sin tono de peligro: el peso de peligro va en la confirmación (HU #13964). */}
        {puedeQuitar && (
          <button type="button" className={flitBtnSecondarySm} disabled={subiendo}
            aria-label={`Quitar la versión vigente ${delDocumento(tipo)}`}
            onClick={() => setRetirando(true)}>
            Quitar
          </button>
        )}
      </div>

      {p.editando && vigente && (
        <EditorFechaExpedicion documento={vigente} onCancelar={cerrarEditor}
          onGuardado={(dto) => { p.onDocumento(dto, 'fecha'); cerrarEditor(); }}
          onCarrera={() => { cerrarEditor(); p.onCarrera(); }} />
      )}

      {p.historialAbierto && doc.tieneHistorial && (
        // La clave cambia con la vigente: tras quitarla (o cargar otra) el historial abierto se relee.
        <HistorialDocumento key={vigente?.id ?? 'sin-vigente'} id={idHistorial} companiaId={p.companiaId} tipo={tipo}
          onCerrar={() => { p.onHistorial(false); toggleRef.current?.focus(); }} />
      )}

      {retirando && vigente && (
        <ModalRetirarDocumento doc={doc} vigente={vigente} focoRespaldoRef={cargaRef}
          onCerrar={() => setRetirando(false)}
          onRetirado={p.onRetirado}
          onCarrera={p.onCarrera} />
      )}
    </li>
  );
}

function LineaDetalle({ doc, puedeCargar, accion }: {
  doc: DocumentoExpedienteDto; puedeCargar: boolean; accion: React.ReactNode;
}) {
  const { tipo, estado, vigente } = doc;
  const tinta = { color: 'var(--flit-text-secondary)' };
  if (!vigente || estado === 'pendiente') return <p className="mt-1 text-xs" style={tinta}>Sin cargar.</p>;

  const cargado = `${participio(tipo, 'Cargad')}${vigente.cargadoPor ? ` por ${vigente.cargadoPor}` : ''} el ${fechaHora(vigente.cargadoEn)}`;
  const expedido = `${participio(tipo, 'Expedid')} el ${fechaDia(vigente.fechaExpedicion)}`;
  const manual = vigente.fechaOrigen === 'manual' && vigente.fechaManual ? (
    <p className="text-xs" style={tinta}>
      Fecha digitada{vigente.fechaManual.por ? ` por ${vigente.fechaManual.por}` : ''} el {fechaDia(diaBogota(vigente.fechaManual.en))}.
    </p>
  ) : null;

  let texto: string;
  if (estado === 'validando') texto = `${cargado} · leyendo la fecha de expedición.`;
  else if (estado === 'no_validado') {
    texto = puedeCargar
      ? 'No pudimos leer la fecha de expedición. Digítala o carga un archivo más legible.'
      : 'No pudimos leer la fecha de expedición.';
  } else if (estado === 'vencido') {
    texto = `${expedido} · venció el ${fechaDia(vigente.venceEl)}.${puedeCargar ? ' Carga uno expedido hace menos de 30 días.' : ''}`;
  } else if (conVigencia(tipo)) texto = `${expedido} · vigente hasta el ${fechaDia(vigente.venceEl)}`;
  else texto = cargado;

  return (
    <div className="mt-1">
      <p className="text-xs" style={tinta}>{texto}{accion}</p>
      {manual}
    </div>
  );
}
