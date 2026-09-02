// FLITO — Impuestos (Fase 6). Porta packages/client/src/paginas/impuestos/* al kit flit/ + api.
// Cola con las 2 fronteras (resueltas en el backend: autogestión CA-05, organismo del gestor CA-10).
// Factura de venta como precondición del envío, envío atómico al gestor, carga masiva de recibos
// (→ Pagado) y rechazo/reactivación/reversa. Operaciones ve todo; el gestor solo su organismo y
// nunca los Pendiente; Auditoría es solo lectura.

import { puedeOperar } from '../lib/permissions';
import { useEffect, useState, type ReactNode } from 'react';
import {
  ESTADO_IMPUESTO_LABEL, ESTADOS_IMPUESTO_CERTIFICABLES, EstadoImpuesto, ResultadoCertificacion,
  TOPE_LOTE_CERTIFICACION,
} from '@operaciones/shared-types';
import { ApiError, api, errorMessage } from '../lib/api';
import { mensajeErrorCargaMasiva, textoContadorCargaMasiva, validarCargaMasiva } from '../lib/carga-masiva';
import {
  AccionCertificacion, ModalResultadoCertificacion, ModalResultadoLote,
  type CertificacionCola, type ResultadoIntento, type ResultadoLote,
} from '../components/flit/CertificacionRunt';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import FlitModal from '../components/flit/FlitModal';
import HistorialEstados from '../components/flit/HistorialEstados';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import AntiguedadPill from '../components/flit/AntiguedadPill';
import ThFiltroMulti from '../components/flit/ThFiltroMulti';
import ChipSinGestion from '../components/flit/ChipSinGestion';
import RangoFechas from '../components/flit/RangoFechas';
import FiltrosInteligentes, { type Preset } from '../components/flit/FiltrosInteligentes';
import {
  AvisoExportCola, BotonExportarCola, COLA_IMPUESTOS, useExportCola, type FiltrosExportCola,
} from '../components/flito/ExportarCola';
import {
  AvisoSoportesZip, DescargarSoportesZip, ZIP_IMPUESTOS, useDescargaZip,
} from '../components/flito/DescargarSoportesZip';
import { CeldaTramite, CeldaVehiculo, CeldaFechas, ENCABEZADOS_COMUNES, documentoConTipo } from '../components/flit/columnasComunes';
import Paginacion from '../components/flit/Paginacion';
import VisorSoportes from '../components/flit/VisorSoportes';
import ModalFacturaVenta, { esNombrePlacaOrganismo, nombreFacturaVenta } from '../components/flit/ModalFacturaVenta';
import useDebounce from '../lib/useDebounce';
import {
  FlitCard, FlitTable, FlitTh, FlitTr, FlitField, FlitEmpty, FlitPillGroup, FlitPillButton,
  flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';

interface ImpuestoItem {
  id: string; tramiteId: string; idFlit: string; placa: string | null; vin: string;
  marca: string | null; linea: string | null;
  tipoTramite: string | null; fechaAprobacion: string | null; fechaCreacion: string | null;
  estado: EstadoImpuesto; compradorNombre: string | null; compradorDocumento: string | null;
  /**
   * CÓDIGO de tipo de documento ya resuelto por el API (`'CC' | 'NIT' | 'PP' | 'CE'`) o null. NO es
   * el `tipo` crudo de FLIT: la tabla de mapeo es del backend y el front no la duplica (HU #11947).
   */
  compradorTipoDocumento: string | null;
  companiaNombre: string; organismoCodigo: string; organismoNombre: string | null;
  valorLiquidado: number | null; valorPagado: number | null; marcadoPorDiferencia: boolean;
  tieneFacturaVenta: boolean; enviadoPorNombre: string | null; enviadoEn: string | null; pagadoEn: string | null;
  estancado: boolean; motivoRechazo: string | null; creadoEn: string;
  /** true = lo gestiona Operaciones por contingencia, en vez del gestor del organismo. El impuesto
   *  se sigue pagando ante el mismo organismo: lo que cambia es quién lo tramita. */
  gestionOperaciones: boolean;
  /** Certificación vigente contra el RUNT, o null si el registro no está certificado (HU #11168). */
  certificacion: CertificacionCola | null;
}
interface ColaImpuestos { items: ImpuestoItem[]; total: number; page: number; pageSize: number }
interface FacetasImpuestos {
  companias: { id: number; nombre: string }[];
  organismos: { codigo: string; nombre: string | null }[];
}

const TONO: Record<EstadoImpuesto, ChipTone> = {
  pendiente: 'draft', solicitado: 'active', con_novedad: 'danger', pagado: 'success',
};
const pesos = (v: number | null) => v === null ? '—'
  : new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(v);
const fecha = (iso: string | null) => iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : '—';

const ESTADOS_OPERACIONES: EstadoImpuesto[] = [
  EstadoImpuesto.PENDIENTE, EstadoImpuesto.SOLICITADO, EstadoImpuesto.CON_NOVEDAD, EstadoImpuesto.PAGADO,
];
const ESTADOS_GESTOR: EstadoImpuesto[] = [EstadoImpuesto.SOLICITADO, EstadoImpuesto.PAGADO];

/**
 * Traduce el fallo de un intento de certificación al desenlace que se le muestra al gestor.
 *
 * Se lee el `code` del cuerpo, NO el texto del mensaje ni el código HTTP a secas: tres de los cinco
 * desenlaces comparten el 409, y distinguirlos por el texto ataría la interfaz a unas cadenas que
 * cambian sin avisar. Si el `code` no viene —un 500 inesperado, un proxy que se interpone— se cae a
 * `error_servicio`, que es el desenlace cuya recomendación (reintentar más tarde) no hace daño en
 * ningún caso.
 */
function aResultadoIntento(e: unknown): ResultadoIntento {
  const cuerpo = e instanceof ApiError ? (e.rawDetails as Record<string, unknown> | null) : null;
  const code = typeof cuerpo?.code === 'string' ? cuerpo.code as ResultadoCertificacion : null;
  return {
    code: code ?? ResultadoCertificacion.ERROR_SERVICIO,
    mensaje: errorMessage(e),
    campos: Array.isArray(cuerpo?.campos) ? cuerpo.campos as ResultadoIntento['campos'] : undefined,
  };
}

export default function FlitoImpuestos() {
  const { user } = useAuth();
  const esOperaciones = puedeOperar(user?.role);
  const esGestor = user?.role === 'gestor_impuestos';
  const soloLectura = user?.role === 'auditor';

  const estadosDisponibles = esGestor ? ESTADOS_GESTOR : ESTADOS_OPERACIONES;
  const [estado, setEstado] = useState<EstadoImpuesto | 'todos'>(esGestor ? EstadoImpuesto.SOLICITADO : 'todos');
  const [texto, setTexto] = useState('');
  // Antes se consultaba en cada tecla; con la cola paginada eso es una consulta con COUNT por
  // pulsación. Se espera a que el usuario deje de escribir.
  const buscar = useDebounce(texto, 300);
  const [data, setData] = useState<ColaImpuestos | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [detalleId, setDetalleId] = useState<string | null>(null);
  const [cargaRecibos, setCargaRecibos] = useState(false);
  const [recarga, setRecarga] = useState(0);

  const [facetas, setFacetas] = useState<FacetasImpuestos | null>(null);
  const [companiasSel, setCompaniasSel] = useState<string[]>([]);
  const [organismosSel, setOrganismosSel] = useState<string[]>([]);
  const [solicitadoDesde, setSolicitadoDesde] = useState('');
  const [solicitadoHasta, setSolicitadoHasta] = useState('');
  const [pagadoDesde, setPagadoDesde] = useState('');
  const [pagadoHasta, setPagadoHasta] = useState('');
  // «Creado en FLITO» — la fecha de REGISTRO en FLITO (`created_at`), que NO es la que pinta la
  // columna «Creado» de la tabla: aquella es la del trámite en FLIT (`fechaCreacion`). Son dos
  // fechas distintas y por eso el filtro lleva otro rótulo; la columna es de `columnasComunes.tsx`,
  // la comparten cuatro pantallas y esta HU no la toca.
  const [creadoDesde, setCreadoDesde] = useState('');
  const [creadoHasta, setCreadoHasta] = useState('');
  const [soloEstancado, setSoloEstancado] = useState(false);
  const [gestionSel, setGestionSel] = useState<'' | 'operaciones' | 'organismo'>('');
  const [preset, setPreset] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const compKey = companiasSel.join(','); const orgKey = organismosSel.join(',');

  // El filtro nuevo entra aquí, y no es un detalle: `hayFiltros` es lo que decide si el vacío dice
  // «Ningún impuesto coincide con los filtros» o el texto sin filtros, y también si aparece
  // «Limpiar filtros», que es la única salida de ese vacío.
  const hayFiltros = companiasSel.length > 0 || organismosSel.length > 0
    || !!solicitadoDesde || !!solicitadoHasta || !!pagadoDesde || !!pagadoHasta
    || !!creadoDesde || !!creadoHasta || soloEstancado || !!gestionSel;

  const limpiarFiltros = () => {
    setCompaniasSel([]); setOrganismosSel([]);
    setSolicitadoDesde(''); setSolicitadoHasta(''); setPagadoDesde(''); setPagadoHasta('');
    setCreadoDesde(''); setCreadoHasta('');
    setSoloEstancado(false); setGestionSel(''); setTexto(''); setPreset(null);
    setEstado(esGestor ? EstadoImpuesto.SOLICITADO : 'todos');
  };

  /**
   * Las dos vistas de la cola. Igual que en SOAT: el gestor no ve «listos para enviar» porque los
   * Pendiente quedan fuera de su frontera (CA-10) y le devolvería siempre una lista vacía.
   *
   * «Listos para enviar» filtra por estado; la precondición de la factura de venta se ve en la
   * propia fila, que ya la marca. Filtrarla en servidor exigiría un campo que la cola no expone
   * como filtro, y prometer más precisión de la que hay es peor que no filtrar.
   */
  const PRESETS: Array<Preset<{ estado: EstadoImpuesto | 'todos'; estancado: boolean }>> = [
    ...(esGestor ? [] : [{
      nombre: 'Listos para enviar',
      descripcion: 'Pendientes; la fila marca si les falta la factura de venta.',
      filtros: { estado: EstadoImpuesto.PENDIENTE as EstadoImpuesto | 'todos', estancado: false },
    }]),
    {
      nombre: 'Sin gestión',
      descripcion: 'Solicitados que superaron el ANS de su organismo.',
      filtros: { estado: EstadoImpuesto.SOLICITADO, estancado: true },
    },
  ];

  const aplicarPreset = (p: Preset<{ estado: EstadoImpuesto | 'todos'; estancado: boolean }>) => {
    limpiarFiltros();
    setEstado(p.filtros.estado);
    setSoloEstancado(p.filtros.estancado);
    setPreset(p.nombre);
  };

  // Cualquier cambio de filtro vuelve a la página 1: si no, se queda en una página que ya no existe.
  useEffect(() => { setPage(1); }, [estado, buscar, compKey, orgKey, solicitadoDesde, solicitadoHasta, pagadoDesde, pagadoHasta, creadoDesde, creadoHasta, soloEstancado, gestionSel]);

  useEffect(() => {
    setError(null); setSeleccion(new Set());
    const q = new URLSearchParams();
    if (estado !== 'todos') q.set('estado', estado);
    if (buscar.trim()) q.set('buscar', buscar.trim());
    if (companiasSel.length) q.set('companias', companiasSel.join(','));
    if (organismosSel.length) q.set('organismos', organismosSel.join(','));
    if (solicitadoDesde) q.set('solicitadoDesde', solicitadoDesde);
    if (solicitadoHasta) q.set('solicitadoHasta', solicitadoHasta);
    if (pagadoDesde) q.set('pagadoDesde', pagadoDesde);
    if (pagadoHasta) q.set('pagadoHasta', pagadoHasta);
    if (creadoDesde) q.set('creadoDesde', creadoDesde);
    if (creadoHasta) q.set('creadoHasta', creadoHasta);
    if (soloEstancado) q.set('estancado', 'si');
    if (gestionSel) q.set('gestion', gestionSel);
    q.set('page', String(page));
    api.get<ColaImpuestos>(`/flito/impuestos?${q}`).then(setData).catch((e) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estado, buscar, compKey, orgKey, solicitadoDesde, solicitadoHasta, pagadoDesde, pagadoHasta, creadoDesde, creadoHasta, soloEstancado, gestionSel, page, recarga]);

  useEffect(() => {
    api.get<FacetasImpuestos>('/flito/impuestos/facetas').then(setFacetas).catch(() => setFacetas(null));
  }, []);

  /**
   * Si una recarga deja fuera el impuesto que se estaba viendo —un traspaso que lo saca de la vista
   * filtrada, un cambio de filtros—, el detalle se cierra de verdad. Sin esto `detalleId` sobrevive
   * apuntando a una fila ausente, y el modal resucita solo en cuanto esa fila vuelve a entrar en la
   * vista, mucho después de que el usuario lo diera por cerrado.
   */
  useEffect(() => {
    if (!data || detalleId === null) return;
    if (!data.items.some((i) => i.id === detalleId)) setDetalleId(null);
  }, [data, detalleId]);

  /**
   * Lo que el export tiene que entregar: **los mismos filtros que la consulta de arriba, sin la
   * página**. Se arma del mismo estado, así que no hay forma de que la tabla y el archivo se
   * separen; lo único que aquí no aparece —y no puede aparecer— es `page`.
   *
   * Todo va en el CUERPO del POST, incluido `buscar`: el placeholder de esta cola ofrece buscar por
   * comprador, así que ese campo lleva nombre y documento de una persona (AGENTS.md §14). En la
   * query acabaría en el historial del navegador, en el `Referer` y en el access log del proxy.
   *
   * Sin `proveedores`: esta cola se reparte por organismo, no por proveedor.
   */
  /**
   * `companias` va como NÚMEROS y no como el texto del multiselect, y no es cosmética: el esquema
   * del endpoint es `z.array(z.number())` y además `.strict()`, así que `["1"]` es un 400 —no un
   * filtro ignorado—. El control guarda `String(c.id)` porque un `<input>` no tiene enteros; la
   * conversión se hace aquí, en el único sitio donde se sabe qué espera el otro lado. En la QUERY de
   * la cola no hace falta: allí todo es texto.
   */
  const filtrosExport: FiltrosExportCola = {
    ...(estado !== 'todos' ? { estados: [estado] } : {}),
    ...(buscar.trim() ? { buscar: buscar.trim() } : {}),
    ...(companiasSel.length ? { companias: companiasSel.map(Number) } : {}),
    ...(organismosSel.length ? { organismos: organismosSel } : {}),
    ...(gestionSel ? { gestion: gestionSel } : {}),
    ...(solicitadoDesde ? { solicitadoDesde } : {}),
    ...(solicitadoHasta ? { solicitadoHasta } : {}),
    ...(pagadoDesde ? { pagadoDesde } : {}),
    ...(pagadoHasta ? { pagadoHasta } : {}),
    ...(creadoDesde ? { creadoDesde } : {}),
    ...(creadoHasta ? { creadoHasta } : {}),
    ...(soloEstancado ? { estancado: true } : {}),
  };
  // El hook se llama SIEMPRE (regla de los hooks); quien decide si la acción existe es el render.
  const exportacion = useExportCola(COLA_IMPUESTOS, filtrosExport);
  // Quién puede exportar: la MISMA guarda de la carga masiva de recibos, sin predicado nuevo. Deja
  // fuera al auditor (AC6), que sí conserva todos los filtros: filtrar es leer.
  const puedeExportar = esOperaciones || esGestor;

  const filas = data?.items ?? [];
  const totalPaginas = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  // Quién puede DESCARGAR depende solo del rol; qué filas ofrecen CERTIFICAR depende además del
  // estado. No es lo mismo: un impuesto ya pagado no se certifica, pero su certificado sigue siendo
  // la evidencia que hay que poder enseñar.
  const puedeDescargarCert = esOperaciones || esGestor;
  const puedeCertificarFila = (f: ImpuestoItem) =>
    puedeDescargarCert && ESTADOS_IMPUESTO_CERTIFICABLES.includes(f.estado);

  /**
   * Qué filas puede marcar ESTE usuario, para cualquiera de las dos acciones masivas.
   *
   * Antes eran solo los Pendientes de Operaciones. Certificar aplica a los Solicitados y también al
   * gestor del organismo, así que la casilla tiene que aparecer en las dos clases de fila (HU
   * #11169). Qué acción se ofrece lo decide después la barra, mirando lo seleccionado.
   */
  const puedeEnviarFila = (f: ImpuestoItem) => esOperaciones && f.estado === EstadoImpuesto.PENDIENTE;
  /**
   * Quién puede DESCARGAR SOPORTES y, con ello, quién ve la columna de casillas (HU #11910, AC7).
   *
   * Hasta esta HU la columna colgaba de `seleccionables.length > 0`, un cálculo que para el auditor
   * daba vacío **por casualidad** —porque ninguna de sus filas admite enviar ni certificar—. Con la
   * casilla abierta a cualquier fila (AC1) esa casualidad se acaba, así que pasa a colgar del
   * permiso, que es la afirmación que se quiere sostener.
   */
  const puedeDescargarSoportes = esOperaciones || esGestor;
  // El hook se llama SIEMPRE (regla de los hooks); quien decide si la acción existe es el render.
  const descargaZip = useDescargaZip(ZIP_IMPUESTOS);
  const detalle = filas.find((f) => f.id === detalleId) ?? null;
  const refrescar = () => setRecarga((n) => n + 1);

  const toggle = (id: string) => setSeleccion((s) => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n;
  });

  /**
   * Certificación contra el RUNT (HU #11168).
   *
   * `certificandoId` bloquea SOLO la fila en curso y no la tabla entera: la consulta puede tardar
   * decenas de segundos (90 s de timeout en backend) y dejar la pantalla inservible todo ese rato
   * sería peor que el problema que resuelve. Como el botón de esa fila queda deshabilitado, la misma
   * certificación no se puede lanzar dos veces (AC7).
   */
  const [certificandoId, setCertificandoId] = useState<string | null>(null);
  const [resultadoCert, setResultadoCert] = useState<{ resultado: ResultadoIntento; placa: string | null } | null>(null);

  const certificar = async (f: ImpuestoItem) => {
    setCertificandoId(f.id);
    try {
      const r = await api.post<{ code: string; certificacion: CertificacionCola }>(`/flito/impuestos/${f.id}/certificar`);
      // Se parchea la fila con lo que devolvió el backend en vez de recargar la cola: AC2 pide que el
      // estado se vea sin recargar, y una recarga completa reordenaría o repaginaría la tabla bajo el
      // cursor de alguien que lleva un minuto esperando.
      setData((d) => d && ({
        ...d,
        items: d.items.map((i) => i.id === f.id ? { ...i, certificacion: r.certificacion } : i),
      }));
    } catch (e) {
      setResultadoCert({ resultado: aResultadoIntento(e), placa: f.placa });
    } finally {
      setCertificandoId(null);
    }
  };

  const descargarCertificado = async (f: ImpuestoItem) => {
    try {
      await api.download(`/flito/impuestos/${f.id}/certificado`, `certificado-runt-${f.placa ?? f.idFlit}.pdf`);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="space-y-4">
      <PageHeaderCard
        title="Impuestos"
        subtitle="Gestión del impuesto vehicular por organismo. La factura de venta es precondición del envío; el pago deriva del recibo validado."
        actions={(
          <>
            {(esOperaciones || esGestor) && (
              <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={() => setCargaRecibos(true)}>
                Cargar recibos (masivo)
              </button>
            )}
            {/* Secundario y después del primario: la acción del día de esta cola es cargar recibos,
                no descargar. La guarda va aparte de la del primario —aunque hoy sean la misma— para
                que quitarle a alguien la carga masiva no le quite de paso la descarga. Al auditor NO
                se le pinta deshabilitado: no se pinta. */}
            {puedeExportar && (
              <BotonExportarCola ocupado={exportacion.ocupado} onExportar={exportacion.exportar} />
            )}
          </>
        )}
      />

      {/* La banda se monta solo donde se monta el botón: un `role="alert"` colgado en la pantalla
          del auditor no puede dispararse, pero sí sale en el árbol de accesibilidad. */}
      {puedeExportar && (
        <AvisoExportCola
          cola={COLA_IMPUESTOS}
          ocupado={exportacion.ocupado}
          aviso={exportacion.aviso}
          onReintentar={exportacion.exportar}
          onDescartar={exportacion.descartar}
        />
      )}

      <FlitCard>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <FlitPillGroup>
            {!esGestor && (
              <FlitPillButton active={estado === 'todos'} onClick={() => setEstado('todos')}>Todos</FlitPillButton>
            )}
            {estadosDisponibles.map((e) => (
              <FlitPillButton key={e} active={estado === e} onClick={() => setEstado(e)}>{ESTADO_IMPUESTO_LABEL[e]}</FlitPillButton>
            ))}
          </FlitPillGroup>
          <input className={`${flitInp} max-w-xs`} placeholder="Buscar placa, VIN, trámite, comprador…"
            value={texto} onChange={(e) => setTexto(e.target.value)} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-3">
          <ThFiltroMulti seleccion={companiasSel} onCambio={setCompaniasSel} placeholder="Compañía"
            vacio="Sin compañías en la cola"
            opciones={(facetas?.companias ?? []).map((c) => ({ value: String(c.id), label: c.nombre }))} />
          {/* Al gestor no se le ofrece: ya está atado a su organismo y elegir otro solo vaciaría la cola. */}
          {!esGestor && (
            <ThFiltroMulti seleccion={organismosSel} onCambio={setOrganismosSel} placeholder="Organismo"
              vacio="Sin organismos en la cola"
              opciones={(facetas?.organismos ?? []).map((o) => ({ value: o.codigo, label: o.nombre ?? o.codigo }))} />
          )}

          {/* Al gestor tampoco: dentro de su frontera todo lo gestiona él, así que solo tendría
              una opción con resultados y otra siempre vacía. */}
          {!esGestor && (
            <label className="flex items-center gap-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
              Gestiona
              <select className={`${flitInp} max-w-[11rem]`} value={gestionSel}
                onChange={(e) => setGestionSel(e.target.value as '' | 'operaciones' | 'organismo')}>
                <option value="">Cualquiera</option>
                <option value="operaciones">Operaciones</option>
                <option value="organismo">El organismo</option>
              </select>
            </label>
          )}

          <FiltrosInteligentes presets={PRESETS} activo={preset}
            onAplicar={aplicarPreset} onQuitar={limpiarFiltros} />

          {/* Antes de «Solicitado» y «Pagado»: es el orden del ciclo (creado → solicitado → pagado).
              El rótulo es además su `aria-label`, así que los tres rangos de la pantalla tienen
              nombres accesibles distintos. */}
          <RangoFechas etiqueta="Creado en FLITO" valor={{ desde: creadoDesde, hasta: creadoHasta }}
            onCambio={(r) => { setCreadoDesde(r.desde); setCreadoHasta(r.hasta); }} />
          <RangoFechas etiqueta="Solicitado" valor={{ desde: solicitadoDesde, hasta: solicitadoHasta }}
            onCambio={(r) => { setSolicitadoDesde(r.desde); setSolicitadoHasta(r.hasta); }} />
          <RangoFechas etiqueta="Pagado" valor={{ desde: pagadoDesde, hasta: pagadoHasta }}
            onCambio={(r) => { setPagadoDesde(r.desde); setPagadoHasta(r.hasta); }} />

          <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
            <input type="checkbox" checked={soloEstancado} onChange={(e) => setSoloEstancado(e.target.checked)} />
            Solo sin gestión
          </label>

          {(hayFiltros || !!texto) && (
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={limpiarFiltros}>Limpiar filtros</button>
          )}
        </div>
      </FlitCard>

      {error && <FlitCard><p className="text-sm text-red-600">{error}</p></FlitCard>}

      {/* Ya no es exclusiva de Operaciones: el gestor certifica en bloque su organismo (HU #11169).
          Qué acción se ofrece lo decide la propia barra según lo seleccionado. */}
      {puedeDescargarSoportes && seleccion.size > 0 && (
        <BarraSeleccion
          filasSeleccionadas={filas.filter((f) => seleccion.has(f.id))}
          puedeEnviarFila={puedeEnviarFila}
          puedeCertificarFila={puedeCertificarFila}
          onListo={() => { setSeleccion(new Set()); refrescar(); }}
          onError={setError}
          descarga={(
            <DescargarSoportesZip
              superficie={ZIP_IMPUESTOS}
              ids={[...seleccion]}
              ocupado={descargaZip.ocupado}
              onDescargar={descargaZip.descargar}
            />
          )}
        />
      )}

      {/* Fuera de la barra a propósito: la descarga NO limpia la selección, pero si el usuario la
          limpia el aviso tiene que seguir en pantalla. Se monta donde se monta el botón. */}
      {puedeDescargarSoportes && (
        <AvisoSoportesZip
          ocupado={descargaZip.ocupado}
          marcadas={descargaZip.marcadas}
          aviso={descargaZip.aviso}
          onReintentar={descargaZip.reintentar}
          onDescartar={descargaZip.descartar}
        />
      )}

      {data && filas.length === 0 && (
        <FlitCard>
          <FlitEmpty>
            {hayFiltros || texto.trim()
              ? 'Ningún impuesto coincide con los filtros.'
              : 'No hay impuestos en esta vista. Sincroniza desde el Tablero para traer trámites nuevos.'}
          </FlitEmpty>
        </FlitCard>
      )}

      {filas.length > 0 && (
        <FlitCard>
          <div className="mb-3">
            <Paginacion total={data!.total} page={data!.page} totalPaginas={totalPaginas} sustantivo="impuestos"
              onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} />
          </div>
          <FlitTable>
            <thead>
              <FlitTr>
                {/* Cuelga del PERMISO, no de «hay filas accionables» (AC7). El nombre accesible
                    cambia con el sentido: ya no marca «los que admiten acción masiva». */}
                {puedeDescargarSoportes && (
                  <FlitTh>
                    <input type="checkbox" aria-label="Seleccionar las filas de esta página"
                      checked={seleccion.size > 0 && seleccion.size === filas.length}
                      onChange={(e) => setSeleccion(e.target.checked ? new Set(filas.map((f) => f.id)) : new Set())} />
                  </FlitTh>
                )}
                {ENCABEZADOS_COMUNES.map((h) => <FlitTh key={h}>{h}</FlitTh>)}
                <FlitTh>Compañía</FlitTh>
                <FlitTh>Organismo</FlitTh><FlitTh>Gestiona</FlitTh><FlitTh>Estado</FlitTh>
                <FlitTh>Solicitado</FlitTh><FlitTh>Fecha pago</FlitTh>
                <FlitTh>Liquidado</FlitTh><FlitTh>Pagado</FlitTh>
                <FlitTh />
              </FlitTr>
            </thead>
            <tbody>
              {filas.map((f) => (
                <FlitTr key={f.id}>
                  {puedeDescargarSoportes && (
                    <td className="px-3 py-2">
                      <input type="checkbox" aria-label={`Seleccionar ${f.placa}`}
                        checked={seleccion.has(f.id)} onChange={() => toggle(f.id)} />
                    </td>
                  )}
                  <CeldaTramite idFlit={f.idFlit} tipoTramite={f.tipoTramite}
                    accion={(
                      <AccionCertificacion
                        certificacion={f.certificacion}
                        puedeDescargar={puedeDescargarCert}
                        puedeCertificar={puedeCertificarFila(f)}
                        cargando={certificandoId === f.id}
                        onCertificar={() => certificar(f)}
                        onDescargar={() => descargarCertificado(f)}
                      />
                    )} />
                  <CeldaVehiculo placa={f.placa} vin={f.vin} marca={f.marca} linea={f.linea} />
                  <CeldaFechas creado={f.fechaCreacion} aprobado={f.fechaAprobacion} />
                  <td className="px-3 py-2 text-sm">{f.companiaNombre}</td>
                  <td className="px-3 py-2 text-sm">{f.organismoNombre ?? f.organismoCodigo}</td>
                  <CeldaGestion imp={f} />
                  <td className="px-3 py-2">
                    <div className="flex flex-col items-start gap-1">
                      <StatusChip tone={TONO[f.estado]}>{ESTADO_IMPUESTO_LABEL[f.estado]}</StatusChip>
                      {f.estancado && <ChipSinGestion desde={f.enviadoEn} />}
                      {f.marcadoPorDiferencia && <StatusChip tone="warning">Diferencia de valor</StatusChip>}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-sm">
                    <div className="tabular-nums">{f.enviadoEn ? fecha(f.enviadoEn) : '—'}</div>
                    {/* Ya pagado: los días desde la solicitud dejan de ser señal de riesgo y solo
                        ensucian. El chip de sin gestión ya desaparece al pagar. */}
                    {f.enviadoEn && f.estado !== EstadoImpuesto.PAGADO && (
                      <div className="mt-1"><AntiguedadPill desde={f.enviadoEn} /></div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-sm tabular-nums">{f.pagadoEn ? fecha(f.pagadoEn) : '—'}</td>
                  <td className="px-3 py-2 text-sm tabular-nums">{pesos(f.valorLiquidado)}</td>
                  <td className="px-3 py-2 text-sm tabular-nums">{pesos(f.valorPagado)}</td>
                  <td className="px-3 py-2">
                    <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setDetalleId(f.id)}>Ver</button>
                  </td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
          <div className="mt-3">
            <Paginacion total={data!.total} page={data!.page} totalPaginas={totalPaginas} sustantivo="impuestos"
              onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} />
          </div>
        </FlitCard>
      )}

      {resultadoCert && (
        <ModalResultadoCertificacion resultado={resultadoCert.resultado} placa={resultadoCert.placa}
          onClose={() => setResultadoCert(null)} />
      )}

      {detalle && (
        <DetalleImpuesto imp={detalle} esOperaciones={esOperaciones} esGestor={esGestor} soloLectura={soloLectura}
          onClose={() => setDetalleId(null)} onCambio={() => { setDetalleId(null); refrescar(); }}
          onTraspaso={refrescar} />
      )}

      {cargaRecibos && (
        <CargaRecibos onClose={() => setCargaRecibos(false)} onListo={() => { setCargaRecibos(false); refrescar(); }} />
      )}
    </div>
  );
}

/**
 * Acciones masivas sobre la selección (HU #11169).
 *
 * Una sola mecánica de selección para dos acciones que no aplican a los mismos registros: enviar
 * (Pendientes) y certificar (Solicitados). La barra decide cuál ofrecer mirando lo marcado. La
 * alternativa —apagar las casillas de otros estados en cuanto se marca la primera— habría hecho que
 * la interfaz se moviera sola bajo el cursor.
 *
 * **Una acción se ofrece si aplica a ALGUNA marcada, y el rótulo dice a cuántas** (HU #11910). Hasta
 * esta HU se exigía que aplicara a TODA la selección; con la casilla abierta a cualquier fila (AC1)
 * esa regla se vuelve un candado: marcar una sola Pagada para meter su comprobante en el ZIP haría
 * desaparecer «Enviar al gestor», que es la acción del día.
 *
 * El miedo que aquella regla tenía sigue siendo legítimo —«pulsaría creyendo que actúa sobre los 4
 * que marcó y actuaría sobre 2»— y por eso el desajuste va **dentro del nombre accesible**:
 * `Enviar al gestor (3 de 8)`, `Certificar (5 de 8)`. El rótulo es lo que se lee en el instante de
 * decidir; una línea auxiliar se pierde al envolver la barra en pantalla estrecha. Y **la petición
 * manda solo los ids aplicables**: marcar más filas no amplía nunca el alcance de `enviar` ni de
 * `certificar`.
 *
 * El envío conserva sus DOS destinos (HU #11158). A diferencia de SOAT aquí no hay selector: el
 * gestor lo determina el organismo del trámite, así que «al gestor» no admite elección y los dos
 * destinos van como botones explícitos que dicen a dónde va cada uno.
 */
function BarraSeleccion({ filasSeleccionadas, puedeEnviarFila, puedeCertificarFila, onListo, onError, descarga }: {
  filasSeleccionadas: ImpuestoItem[];
  puedeEnviarFila: (f: ImpuestoItem) => boolean;
  puedeCertificarFila: (f: ImpuestoItem) => boolean;
  onListo: () => void;
  onError: (m: string) => void;
  descarga: ReactNode;
}) {
  const [enviando, setEnviando] = useState<'gestor' | 'operaciones' | null>(null);
  const [certificando, setCertificando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoLote | null>(null);

  const marcadas = filasSeleccionadas.length;
  // Los DOS subconjuntos, cada uno con su propia lista de ids. Es lo que viaja en cada petición.
  const enviables = filasSeleccionadas.filter(puedeEnviarFila).map((f) => f.id);
  const certificables = filasSeleccionadas.filter(puedeCertificarFila).map((f) => f.id);
  const cuenta = (aplicables: number) =>
    aplicables < marcadas ? `${aplicables} de ${marcadas}` : `${aplicables}`;
  // El tope se lee de la constante que el backend usa para rechazar. Repetir el 10 aquí garantiza
  // que un día los dos números digan cosas distintas.
  //
  // **Mide los CERTIFICABLES, no la selección entera** (HU #11910): con 14 marcadas de las que 3 se
  // certifican, un tope de 10 no tiene nada que bloquear, y bloquearlo dejaba al usuario sin la
  // acción por filas que ni siquiera iban en la petición.
  const sobreElTope = certificables.length > TOPE_LOTE_CERTIFICACION;
  const ocupado = enviando !== null || certificando;

  const enviar = async (aOperaciones: boolean) => {
    setEnviando(aOperaciones ? 'operaciones' : 'gestor');
    try {
      await api.post('/flito/impuestos/enviar',
        aOperaciones ? { ids: enviables, gestionOperaciones: true } : { ids: enviables });
      onListo();
    }
    catch (e) { onError(errorMessage(e)); }
    finally { setEnviando(null); }
  };

  const certificarLote = async () => {
    setCertificando(true);
    try { setResultado(await api.post<ResultadoLote>('/flito/impuestos/certificar', { ids: certificables })); }
    catch (e) { onError(errorMessage(e)); }
    finally { setCertificando(false); }
  };

  const placaDe = (id: string) => filasSeleccionadas.find((f) => f.id === id)?.placa ?? null;

  return (
    <>
      <FlitCard>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold" style={{ color: 'var(--flit-blue-text)' }}>{marcadas} seleccionado(s)</span>

          {enviables.length > 0 && (
            <>
              <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={ocupado} onClick={() => enviar(false)}>
                {enviando === 'gestor' ? 'Enviando…' : `Enviar al gestor (${cuenta(enviables.length)})`}
              </button>
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={ocupado} onClick={() => enviar(true)}>
                {enviando === 'operaciones' ? 'Enviando…' : `Gestionar en Operaciones (${cuenta(enviables.length)})`}
              </button>
            </>
          )}

          {certificables.length > 0 && (
            <button className={flitBtnPrimary} style={flitBtnPrimaryStyle}
              disabled={ocupado || sobreElTope} onClick={certificarLote}
              // Con concurrencia 2 y 90 s de timeout por consulta, un lote lleno puede tardar
              // minutos. Sin este aviso la pantalla parece colgada (AC3).
              title={certificando ? 'Consultando el RUNT registro a registro. Puede tardar varios minutos.' : undefined}>
              {certificando
                ? `Certificando ${certificables.length}… consultando RUNT`
                : `Certificar (${cuenta(certificables.length)})`}
            </button>
          )}

          {descarga}

          {sobreElTope && (
            <span className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
              Máximo {TOPE_LOTE_CERTIFICACION} por lote. De las {marcadas} marcadas, {certificables.length} se certifican.
            </span>
          )}
        </div>

        {/* Solo cuando hay desajuste. Sustituye al «La selección mezcla estados con acciones
            distintas» de antes, que era la cara visible de la regla «toda la selección»: aquel
            mensaje aparecía **en vez** de las acciones; este aparece **junto a** ellas. */}
        {(enviables.length > 0 || certificables.length > 0)
          && (enviables.length < marcadas || certificables.length < marcadas) && (
          <p className="mt-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            De las {marcadas} filas marcadas
            {enviables.length > 0 && enviables.length < marcadas
              && `, ${enviables.length} están Pendientes y son las únicas que se envían`}
            {certificables.length > 0 && certificables.length < marcadas
              && `, ${certificables.length} admiten certificación y son las únicas que se certifican`}
            . Descargar soportes usa las {marcadas}.
          </p>
        )}
      </FlitCard>

      {resultado && (
        <ModalResultadoLote resultado={resultado} placaDe={placaDe}
          onClose={() => { setResultado(null); onListo(); }} />
      )}
    </>
  );
}

/**
 * Quién gestiona el impuesto. Va en columna propia y no sobre la de organismo: el organismo se
 * sigue viendo en los dos casos, porque el impuesto se paga ante él igual. El distintivo lleva
 * texto y no solo color.
 */
function CeldaGestion({ imp }: { imp: ImpuestoItem }) {
  return (
    <td className="px-3 py-2 text-sm">
      {imp.gestionOperaciones
        ? <StatusChip tone="warning">Operaciones</StatusChip>
        : <span style={{ color: 'var(--flit-text-secondary)' }}>Gestor del organismo</span>}
    </td>
  );
}

type Accion = 'idle' | 'rechazar' | 'reactivar' | 'reversar' | 'asumir' | 'devolver';

function DetalleImpuesto({ imp, esOperaciones, esGestor, soloLectura, onClose, onCambio, onTraspaso }: {
  imp: ImpuestoItem; esOperaciones: boolean; esGestor: boolean; soloLectura: boolean;
  onClose: () => void; onCambio: () => void; onTraspaso: () => void;
}) {
  const [accion, setAccion] = useState<Accion>('idle');
  const [motivo, setMotivo] = useState('');
  const [estadoDestino, setEstadoDestino] = useState<EstadoImpuesto>(EstadoImpuesto.PENDIENTE);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  // Visor de los recibos de ESTE impuesto, encima del detalle.
  const [verSoportes, setVerSoportes] = useState(false);
  // Visor de la factura de venta (modal): blob url + nombre para descargar.
  const [factura, setFactura] = useState<{ url: string; nombre: string } | null>(null);

  const enGestion = imp.estado === EstadoImpuesto.SOLICITADO;
  const rechazado = imp.estado === EstadoImpuesto.CON_NOVEDAD;
  // El traspaso de gestión solo tiene sentido mientras el impuesto está en gestión y sin pagar:
  // sobre uno Pagado no queda nada que gestionar, y uno Pendiente aún no se ha enviado a nadie.
  const traspasable = enGestion || rechazado;

  const ejecutar = async (fn: () => Promise<unknown>) => {
    setEnviando(true); setError(null);
    try { await fn(); onCambio(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setEnviando(false); }
  };

  /**
   * El traspaso de gestión no cierra el detalle: quien lo asume suele querer seguir en el mismo
   * impuesto, y ver ahí mismo que ya lo gestiona Operaciones es la confirmación de que funcionó.
   * Si el traspaso lo saca de la vista filtrada, la fila desaparece y el detalle se cierra solo.
   */
  const traspasar = async (ruta: string) => {
    setEnviando(true); setError(null);
    try {
      await api.post(`/flito/impuestos/${imp.id}/${ruta}`, { motivo });
      setAccion('idle'); setMotivo(''); onTraspaso();
    }
    catch (e) { setError(errorMessage(e)); }
    finally { setEnviando(false); }
  };

  /**
   * Factura de venta: viene de FLIT y la sirve la API. Integración FLIT (Fase 8).
   *
   * Antes se abría con `window.open(URL.createObjectURL(blob))`. Una URL `blob:` no lleva nombre,
   * así que el navegador guardaba el archivo con un identificador interno y SIN extensión: no abría
   * con doble clic y había que renombrarlo a mano. Ahora se muestra en el visor, que descarga con
   * un nombre de verdad y en `.pdf`.
   */
  // El nombre lo pone el SERVIDOR desde la HU #11910 (AC5): `PLACA-ORGANISMO.<ext>`, el mismo con el
  // que sale dentro del ZIP, para que las dos descargas se puedan emparejar en la misma carpeta. El
  // cliente valida la forma y cae al respaldo si no encaja.
  const verFactura = async () => {
    setError(null);
    try {
      const { blob, nombre } = await api.getBlobNamed(
        `/flito/impuestos/${imp.id}/factura-venta`,
        nombreFacturaVenta(imp.idFlit),
        esNombrePlacaOrganismo,
      );
      setFactura({ url: URL.createObjectURL(blob), nombre });
    } catch (e) { setError(errorMessage(e)); }
  };
  const cerrarFactura = () => { if (factura) URL.revokeObjectURL(factura.url); setFactura(null); };

  return (
    <FlitModal title={`Impuesto · ${imp.placa ?? imp.vin}`} onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={TONO[imp.estado]}>{ESTADO_IMPUESTO_LABEL[imp.estado]}</StatusChip>
          {imp.estancado && <ChipSinGestion desde={imp.enviadoEn} />}
          {imp.marcadoPorDiferencia && <StatusChip tone="warning">Diferencia de valor</StatusChip>}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          <Dato k="VIN" v={imp.vin} /><Dato k="Trámite FLIT" v={imp.idFlit} />
          <Dato k="Compañía" v={imp.companiaNombre} /><Dato k="Organismo" v={imp.organismoNombre ?? imp.organismoCodigo} />
          <Dato k="Gestiona" v={imp.gestionOperaciones ? 'Operaciones (contingencia)' : 'Gestor del organismo'} />
          <Dato k="Comprador" v={imp.compradorNombre ?? '—'} /><Dato k="Documento" v={documentoConTipo(imp.compradorTipoDocumento, imp.compradorDocumento)} />
          <Dato k="Valor liquidado" v={pesos(imp.valorLiquidado)} /><Dato k="Valor pagado" v={pesos(imp.valorPagado)} />
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Factura de venta</dt>
            <dd className="text-sm">
              {imp.tieneFacturaVenta
                ? <button className="font-semibold underline" style={{ color: 'var(--flit-blue-text)' }} onClick={verFactura}>En FLIT · Ver / descargar</button>
                : <span style={{ color: 'var(--flit-warning)' }}>Sin factura en FLIT</span>}
            </dd>
          </div>
          {/* El recibo del organismo se carga desde esta pantalla, pero para verlo había que irse
              al reporte de costos, en el que el gestor del organismo no entra. Es la evidencia del
              pago: se mira desde donde se gestiona. */}
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Soporte</dt>
            <dd className="text-sm">
              <button type="button" className="font-semibold underline" style={{ color: 'var(--flit-blue-text)' }}
                onClick={() => setVerSoportes(true)}>Ver soporte</button>
            </dd>
          </div>
          <Dato k="Enviado por" v={imp.enviadoPorNombre ?? '—'} /><Dato k="Enviado" v={fecha(imp.enviadoEn)} />
        </dl>

        {verSoportes && (
          <VisorSoportes ruta={`/flito/impuestos/${imp.id}/soportes`} titulo={`Impuesto ${imp.placa ?? imp.vin}`}
            vacio="Este impuesto no tiene ningún recibo cargado todavía."
            onClose={() => setVerSoportes(false)} />
        )}

        {factura && <ModalFacturaVenta url={factura.url} nombre={factura.nombre} onCerrar={cerrarFactura} />}

        <HistorialEstados concepto="impuesto" registroId={imp.id} />

        {imp.motivoRechazo && <p className="rounded-md bg-red-50 p-2 text-red-700">Motivo de rechazo: {imp.motivoRechazo}</p>}
        {soloLectura && <div className="rounded-md bg-blue-50 p-2 text-blue-800">Solo lectura · Auditoría observa, no ejecuta acciones.</div>}
        {error && <p className="text-sm text-red-600">{error}</p>}

        {!soloLectura && accion === 'idle' && (
          <div className="flex flex-wrap gap-2 pt-1">
            {enGestion && (esOperaciones || esGestor) && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('rechazar')}>Rechazar</button>
            )}
            {rechazado && esOperaciones && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('reactivar')}>Reactivar</button>
            )}
            {esOperaciones && traspasable && !imp.gestionOperaciones && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('asumir')}>Asumir en Operaciones</button>
            )}
            {esOperaciones && traspasable && imp.gestionOperaciones && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('devolver')}>Devolver al gestor</button>
            )}
            {esOperaciones && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('reversar')}>Reversar</button>
            )}
          </div>
        )}

        {/* Devolver no pide destinatario: el gestor sale del organismo del trámite, que no cambia. */}
        {(accion === 'asumir' || accion === 'devolver') && (
          <FormMotivo etiqueta={accion === 'asumir'
            ? 'Motivo para asumirlo en Operaciones (mín. 5 caracteres)'
            : 'Motivo de la devolución al gestor (mín. 5 caracteres)'}
            motivo={motivo} setMotivo={setMotivo} enviando={enviando} minLen={5}
            onCancelar={() => { setAccion('idle'); setMotivo(''); }}
            onConfirmar={() => traspasar(accion === 'asumir' ? 'asumir-operaciones' : 'devolver-gestor')} />
        )}

        {(accion === 'rechazar' || accion === 'reactivar') && (
          <FormMotivo etiqueta={accion === 'rechazar' ? 'Motivo del rechazo' : 'Motivo de la corrección'}
            motivo={motivo} setMotivo={setMotivo} enviando={enviando} onCancelar={() => { setAccion('idle'); setMotivo(''); }}
            onConfirmar={() => ejecutar(() => api.post(`/flito/impuestos/${imp.id}/${accion}`, { motivo }))} />
        )}

        {accion === 'reversar' && (
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
            <FlitField label="Estado destino">
              <select className={flitInp} value={estadoDestino} onChange={(e) => setEstadoDestino(e.target.value as EstadoImpuesto)}>
                {ESTADOS_OPERACIONES.map((e) => <option key={e} value={e}>{ESTADO_IMPUESTO_LABEL[e]}</option>)}
              </select>
            </FlitField>
            <FormMotivo etiqueta="Motivo de la reversa (mín. 5 caracteres)" motivo={motivo} setMotivo={setMotivo}
              enviando={enviando} minLen={5} onCancelar={() => { setAccion('idle'); setMotivo(''); }}
              onConfirmar={() => ejecutar(() => api.post(`/flito/impuestos/${imp.id}/reversar`, { estadoDestino, motivo }))} />
          </div>
        )}
      </div>
    </FlitModal>
  );
}

function Dato({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[11px] uppercase" style={{ color: 'var(--flit-text-muted)' }}>{k}</dt>
      <dd className="font-medium">{v}</dd>
    </div>
  );
}

function FormMotivo({ etiqueta, motivo, setMotivo, enviando, minLen = 1, onConfirmar, onCancelar }: {
  etiqueta: string; motivo: string; setMotivo: (v: string) => void; enviando: boolean; minLen?: number;
  onConfirmar: () => void; onCancelar: () => void;
}) {
  return (
    <div className="mt-2 space-y-2">
      <FlitField label={etiqueta}>
        <textarea className={`${flitInp} min-h-[64px]`} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
      </FlitField>
      <div className="flex gap-2">
        <button className={flitBtnPrimary} style={flitBtnPrimaryStyle}
          disabled={enviando || motivo.trim().length < minLen} onClick={onConfirmar}>
          {enviando ? 'Enviando…' : 'Confirmar'}
        </button>
        <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onCancelar}>Cancelar</button>
      </div>
    </div>
  );
}

interface ResultadoRecibos {
  conciliados: { archivo: string; detalle: string }[]; enRevision: { archivo: string; detalle: string }[];
  complementos: { archivo: string; detalle: string }[]; duplicados: { archivo: string; detalle: string }[];
  noAsociados: { archivo: string; detalle: string }[];
}

function CargaRecibos({ onClose, onListo }: { onClose: () => void; onListo: () => void }) {
  const [archivos, setArchivos] = useState<File[]>([]);
  const [sinMarca, setSinMarca] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoRecibos | null>(null);
  const errorValidacion = validarCargaMasiva(archivos);

  const subir = async () => {
    if (archivos.length === 0 || validarCargaMasiva(archivos)) return;
    setEnviando(true); setError(null);
    try {
      const form = new FormData();
      for (const f of archivos) form.append('archivos', f);
      form.append('sinMarcaDeAgua', String(sinMarca));
      const r = await api.post<ResultadoRecibos>('/flito/impuestos/recibos', form);
      setResultado(r);
    } catch (e) { setError(mensajeErrorCargaMasiva(e)); }
    finally { setEnviando(false); }
  };

  return (
    <FlitModal title="Carga masiva de recibos de impuesto" onClose={resultado ? onListo : onClose} wide>
      {!resultado ? (
        <div className="space-y-3">
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            Sube varios PDF/imágenes o un ZIP. El OCR cruza cada recibo con su impuesto en gestión por la placa; los que cuadran pasan a Pagado, el resto va a revisión.
          </p>
          <input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.zip" className={flitInp}
            onChange={(e) => { setArchivos(Array.from(e.target.files ?? [])); setError(null); }} />
          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            <input type="checkbox" checked={sinMarca} onChange={(e) => setSinMarca(e.target.checked)} />
            Archivos sueltos sin marca de agua (en ZIP se deduce por carpeta)
          </label>
          {archivos.length > 0 && (
            <p className={`text-xs${errorValidacion ? ' text-red-600' : ''}`}
              style={errorValidacion ? undefined : { color: 'var(--flit-text-muted)' }}>
              {textoContadorCargaMasiva(archivos)}
            </p>
          )}
          {(errorValidacion || error) && <p role="alert" className="text-sm text-red-600">{errorValidacion ?? error}</p>}
          <div className="flex gap-2">
            <button className={flitBtnPrimary} style={flitBtnPrimaryStyle}
              disabled={enviando || archivos.length === 0 || !!errorValidacion} onClick={subir}>
              {enviando ? 'Procesando…' : 'Subir y procesar'}
            </button>
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>Cancelar</button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <StatusChip tone="success">Conciliados {resultado.conciliados.length}</StatusChip>
            <StatusChip tone="warning">En revisión {resultado.enRevision.length}</StatusChip>
            <StatusChip tone="active">Complementos {resultado.complementos.length}</StatusChip>
            <StatusChip tone="neutral">Duplicados {resultado.duplicados.length}</StatusChip>
            <StatusChip tone="danger">Sin asociar {resultado.noAsociados.length}</StatusChip>
          </div>
          <TablaResultadoOcr resultado={resultado} />
          <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={onListo}>Listo</button>
        </div>
      )}
    </FlitModal>
  );
}

// Resultado del OCR masivo en TABLA: cada recibo analizado en su propia fila.
function TablaResultadoOcr({ resultado }: { resultado: ResultadoRecibos }) {
  const filas: { archivo: string; detalle: string; resultado: string; tono: ChipTone }[] = [
    ...resultado.conciliados.map((i) => ({ ...i, resultado: 'Conciliado', tono: 'success' as ChipTone })),
    ...resultado.enRevision.map((i) => ({ ...i, resultado: 'En revisión', tono: 'warning' as ChipTone })),
    ...resultado.complementos.map((i) => ({ ...i, resultado: 'Complemento', tono: 'active' as ChipTone })),
    ...resultado.duplicados.map((i) => ({ ...i, resultado: 'Duplicado', tono: 'neutral' as ChipTone })),
    ...resultado.noAsociados.map((i) => ({ ...i, resultado: 'Sin asociar', tono: 'danger' as ChipTone })),
  ];
  if (filas.length === 0) return <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>No se procesó ningún archivo.</p>;
  const th = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide';
  return (
    <div className="max-h-[55vh] overflow-auto rounded-lg border" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <table className="w-full text-sm">
        <thead>
          <tr style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>
            <th className={th}>Archivo</th><th className={th}>Resultado</th><th className={th}>Detalle del análisis OCR</th>
          </tr>
        </thead>
        <tbody>
          {filas.map((f, idx) => (
            <tr key={idx} className="border-t" style={{ borderColor: 'var(--flit-border-soft)' }}>
              <td className="px-3 py-2 font-medium align-top" style={{ color: 'var(--flit-text-primary)' }}>{f.archivo}</td>
              <td className="px-3 py-2 align-top"><StatusChip tone={f.tono}>{f.resultado}</StatusChip></td>
              <td className="px-3 py-2 align-top" style={{ color: 'var(--flit-text-secondary)' }}>{f.detalle}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
