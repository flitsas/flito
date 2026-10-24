// Una fila del expediente (HU #13892; spec «Estado por documento» y «Acciones y validaciones»).
// La carga es de la fila: solo esta queda ocupada y su error se pinta aquí, junto al archivo que hay
// que corregir (sin toast de error). El archivo fallido se guarda para «Reintentar» hasta elegir otro.
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Download, RotateCw, Upload } from 'lucide-react';
import type { DocumentoBolsaDto, DocumentoExpedienteDto } from '@operaciones/shared-types';
import { bolsasDocumentosApi } from '../../lib/api';
import { errorBolsa, fechaDia, fechaHora } from '../../lib/bolsas';
import {
  ACCEPT_DOCUMENTO_BOLSA, conVigencia, diaBogota, ESTADO_DOCUMENTO, errorArchivoLocal, nombreDocumento,
  participio, tituloDocumento,
} from '../../lib/bolsasDocumentos';
import StatusChip from '../flit/StatusChip';
import { flitBtnSecondarySm, flitBtnSecondarySmToggle } from '../flit/flitPageKit';
import { toastOk } from '../flit/ToastFlito';
import EditorFechaExpedicion from './EditorFechaExpedicion';
import HistorialDocumento from './HistorialDocumento';
import { BOTON_ICONO, useDescargaDocumentoBolsa } from './useDescargaDocumentoBolsa';

const ANILLO_LABEL =
  'cursor-pointer has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-[color:var(--flit-border-focus)] has-[input:disabled]:cursor-not-allowed has-[input:disabled]:opacity-50';

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
  const { descargar, enCurso } = useDescargaDocumentoBolsa();

  // Al cerrar el editor (guardar o cancelar), el foco vuelve a «Corregir» / «Digitar fecha».
  useEffect(() => {
    if (focoFecha && !p.editando) { fechaRef.current?.focus(); setFocoFecha(false); }
  }, [focoFecha, p.editando]);

  const cerrarEditor = () => { p.onEditar(false); setFocoFecha(true); };

  async function subir(archivo: File) {
    if (candado.current) return;
    const local = errorArchivoLocal(archivo);
    if (local) { setErrorCarga({ texto: local, archivo: null }); return; }
    candado.current = true;
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

  return (
    <li className="grid grid-cols-1 gap-x-4 gap-y-2 py-3 sm:grid-cols-[1fr_auto]" style={{ borderColor: 'var(--flit-border-soft)' }}
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
            <input type="file" className="sr-only" accept={ACCEPT_DOCUMENTO_BOLSA} disabled={subiendo}
              aria-label={`${vigente ? 'Reemplazar' : 'Cargar'} ${nombre}`}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) { setErrorCarga(null); void subir(f); }
              }} />
          </label>
        )}
        {vigente && (
          <button type="button" className={BOTON_ICONO}
            style={{ color: 'var(--flit-text-secondary)', borderColor: 'var(--flit-border-input)' }}
            aria-label={`Descargar ${nombre} (versión ${vigente.version})`} title={`Descargar ${nombre} (versión ${vigente.version})`}
            disabled={ocupadoDescarga} aria-busy={ocupadoDescarga || undefined}
            onClick={() => { void descargar(vigente); }}>
            <Download size={16} aria-hidden="true" />
          </button>
        )}
        {vigente && (
          <button ref={toggleRef} type="button" className={flitBtnSecondarySmToggle}
            aria-expanded={p.historialAbierto} aria-controls={p.historialAbierto ? idHistorial : undefined}
            aria-label={`Ver el historial de ${nombre}`}
            onClick={() => { if (!p.historialAbierto) p.onEditar(false); p.onHistorial(!p.historialAbierto); }}>
            Historial
            {p.historialAbierto ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
          </button>
        )}
      </div>

      {p.editando && vigente && (
        <EditorFechaExpedicion documento={vigente} onCancelar={cerrarEditor}
          onGuardado={(dto) => { p.onDocumento(dto, 'fecha'); cerrarEditor(); }}
          onCarrera={() => { cerrarEditor(); p.onCarrera(); }} />
      )}

      {p.historialAbierto && vigente && (
        <HistorialDocumento id={idHistorial} companiaId={p.companiaId} tipo={tipo}
          onCerrar={() => { p.onHistorial(false); toggleRef.current?.focus(); }} />
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
