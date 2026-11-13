// FLITO Derechos de tránsito (HU #10951). Carga de recibos, listado de lo registrado y bandeja de
// los que aún no cruzan con ningún trámite.
//
// El resultado de una carga NO es un "ok" o un "error": cada archivo cae en una de seis canastas
// (registrado, en revisión, duplicado, pendiente, omitido, fallido) y el usuario necesita ver
// cuál y por qué. Por eso el panel de resultados es lo primero que aparece tras cargar, con el
// detalle textual que devuelve el backend en cada fila.
//
// La resolución de ambigüedades (una placa con varios trámites) NO vive aquí: se hace en la cola
// de revisión que ya existe, para que Operaciones tenga una sola bandeja que atender.

import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import { FlitCard, FlitTable, FlitTh, FlitTr, flitInp } from '../components/flit/flitPageKit';
import GradientButton from '../components/flit/GradientButton';
import Pestanas from '../components/flit/Pestanas';
import PanelFiltros, { type FiltroAplicado } from '../components/flit/PanelFiltros';
import FlitUploadBox from '../components/flit/FlitUploadBox';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import Paginacion from '../components/flit/Paginacion';
import InlineAlert from '../components/flit/InlineAlert';
import { EstadoVista } from '../components/flit/Cargador';
import { EtiquetaEstado } from '../components/flit/Bloques';
import { registrarEstados, type EstadoKit } from '../components/flit/kit/tonos';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import ThFiltroMulti from '../components/flit/ThFiltroMulti';
import RangoFechas from '../components/flit/RangoFechas';
import FiltrosInteligentes, { type Preset } from '../components/flit/FiltrosInteligentes';
import { CeldaTramite, CeldaVehiculo, CeldaFechas, ENCABEZADOS_COMUNES } from '../components/flit/columnasComunes';
import VisorSoportes from '../components/flit/VisorSoportes';

const PAGE_SIZE = 50;

interface ItemDerecho {
  archivo: string; placa: string | null; idFlit: string | null;
  registroId: string | null; valor: string | null; detalle: string;
}
interface ResultadoCarga {
  registrados: ItemDerecho[]; enRevision: ItemDerecho[]; duplicados: ItemDerecho[];
  pendientes: ItemDerecho[]; omitidas: ItemDerecho[]; fallidos: ItemDerecho[];
}
interface DerechoRow {
  id: string; tramiteId: string; idFlit: string; placa: string | null;
  organismoCodigo: string | null; empresa: string | null; valor: string | null;
  fechaPago: string | null; numeroRadicado: string | null; tipoTramiteRecibo: string | null;
  origen: string; advertencias: string[] | null; soporteId: string | null; createdAt: string;
  /** De qué documento salió. Null en los derechos anteriores a que esto se registrara. */
  archivoOrigen: string | null; paginas: number[] | null;
  procesamientoId: number | null; procesamientoArchivo: string | null;
  /** Vehículo y datos del trámite, homologados con las demás tablas. */
  vin: string | null; marca: string | null; linea: string | null;
  tipoTramite: string | null; fechaAprobacion: string | null; fechaCreacion: string | null;
}
/** De dónde salió el recibo. En la tabla se veía el valor crudo de la columna. */
const ETIQUETA_ORIGEN: Record<string, string> = { manual: 'Carga manual', drive: 'Drive de la secretaría' };

/**
 * El documento del que salió el recibo, bajo el canal.
 *
 * «Drive» o «Carga manual» dicen por dónde entró, no de qué papel. Con los consolidados —un PDF de
 * trece páginas por día— eso no basta para volver al documento cuando alguien reclama: hace falta el
 * archivo, y la página dentro de él.
 *
 * El nombre se toma del registro del barrido cuando existe, no de la columna del derecho: si alguien
 * renombra el fichero en el Drive, el registro sigue guardando el nombre que tenía al procesarse.
 */
function ArchivoOrigen({ d }: { d: DerechoRow }) {
  const nombre = d.procesamientoArchivo ?? d.archivoOrigen;
  // Los derechos cargados antes de este cambio no lo tienen, y no es recuperable: en cualquier
  // ventana de diez minutos hubo tres barridos, así que atribuirlos por fecha sería inventárselo.
  if (!nombre) return <div className="mt-0.5 text-[color:var(--color-text-tertiary)]">Archivo no registrado</div>;
  const paginas = d.paginas?.length
    ? ` · pág. ${d.paginas.length > 1 ? `${d.paginas[0]}–${d.paginas[d.paginas.length - 1]}` : d.paginas[0]}`
    : '';
  return (
    <div className="mt-0.5 break-all text-[color:var(--color-text-secondary)]" title={nombre}>
      {nombre}{paginas}
    </div>
  );
}

interface ArchivoDrive {
  fileId: string; nombre: string; tamanoBytes: number | null;
  modificadoEn: string | null; modificadoPor: string | null;
  procesadoEn: string | null; omitidoEn: string | null;
}
interface ResultadoProcesoDrive extends ResultadoCarga {
  archivo: string; totalPaginas: number; cuentasDetectadas: number; placasUnicas: number;
}

/** Una pasada del procesador. Sobrevive al archivo: por eso hay `sigueEnDrive`. */
interface RegistroRow {
  id: number; fileId: string | null; nombreArchivo: string | null; estado: string;
  modificadoPor: string | null; modificadoEn: string | null;
  totalPaginas: number | null; cuentasDetectadas: number | null; placasUnicas: number | null;
  valorTotal: string | null; error: string | null; procesadoEn: string; sigueEnDrive: boolean;
}
const TONO_ESTADO_PROC: Record<string, ChipTone> = {
  completado: 'success', error: 'danger', omitido: 'neutral', procesando: 'active',
};
const ETIQUETA_ESTADO_PROC: Record<string, string> = {
  completado: 'Procesado', error: 'Con error', omitido: 'Dado por visto', procesando: 'En curso',
};


// Cada canasta con su tono: lo que exige intervención humana no puede verse igual que lo resuelto.
// Tono y glifo del UI Kit 2026 (decisión de diseño D7): el duplicado por hash se descarta (papelera,
// amarillo «revocado»); turquesa no, porque en el kit es un resultado positivo.
const CANASTAS = [
  { clave: 'registrados', titulo: 'Registrados', tono: 'ok', glifo: 'doble-check' },
  { clave: 'enRevision', titulo: 'En revisión', tono: 'warn', glifo: 'espera' },
  { clave: 'pendientes', titulo: 'Sin trámite asociado', tono: 'info', glifo: 'tramites' },
  { clave: 'duplicados', titulo: 'Duplicados', tono: 'revocado', glifo: 'papelera' },
  { clave: 'omitidas', titulo: 'Páginas omitidas', tono: 'neutro', glifo: 'menos' },
  { clave: 'fallidos', titulo: 'Fallidos', tono: 'danger', glifo: 'alerta' },
] as const satisfies ReadonlyArray<{ clave: keyof ResultadoCarga; titulo: string } & EstadoKit>;

registrarEstados(Object.fromEntries(CANASTAS.map((c) => [`derecho-${c.clave}`, { tono: c.tono, glifo: c.glifo }])));

const pesos = (v: string | null): string =>
  v === null ? '—' : `$ ${Number(v).toLocaleString('es-CO', { maximumFractionDigits: 0 })}`;
/**
 * `fechaPago` es una fecha SIN hora (columna `date`): formatearla con `new Date(...)` la interpreta
 * como medianoche UTC y, al renderizarla en hora de Colombia (UTC−5), retrocede un día — el recibo
 * decía 23 y la tabla mostraba 22. Se formatea a mano desde el string para que el día no se mueva.
 */
const fecha = (v: string | null): string => {
  if (!v) return '—';
  const [y, m, d] = v.slice(0, 10).split('-');
  return `${Number(d)}/${Number(m)}/${y}`;
};
const tamano = (b: number | null): string =>
  b === null ? '—' : b > 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
const fechaHora = (v: string): string =>
  new Date(v).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });

/** Abre el soporte en una pestaña nueva. La URL viene firmada y caduca. */
async function abrirSoporte(soporteId: string): Promise<void> {
  try {
    const { url } = await api.get<{ url: string }>(`/flito/derechos/soporte/${soporteId}`);
    window.open(url, '_blank', 'noopener');
  } catch (e) {
    toast.error(errorMessage(e));
  }
}

/**
 * Pestaña del Drive de la secretaría (HU #11010).
 *
 * Antes esto solo se podía hacer desde Administración → Google Drive, un explorador de archivos
 * genérico donde la acción quedaba escondida. Aquí está donde se ve el resultado: se procesa y se
 * cambia a la pestaña de al lado.
 *
 * Es bajo demanda: se elige el día. Nada se sube desde la máquina de quien opera.
 */
function TabDrive({ onProcesado }: { onProcesado: (r: ResultadoCarga) => void }) {
  const [archivos, setArchivos] = useState<ArchivoDrive[] | null>(null);
  const [registro, setRegistro] = useState<RegistroRow[] | null>(null);
  const [verRegistro, setVerRegistro] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [procesando, setProcesando] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    api.get<RegistroRow[]>('/flito/derechos/drive/registro')
      .then(setRegistro)
      .catch(() => setRegistro([]));
  }, [nonce]);

  useEffect(() => {
    setArchivos(null); setError(null);
    api.get<ArchivoDrive[]>('/flito/derechos/drive/archivos')
      .then(setArchivos)
      .catch((e) => { setError(errorMessage(e)); setArchivos([]); });
  }, [nonce]);

  async function procesar(a: ArchivoDrive) {
    setProcesando(a.fileId); setError(null);
    try {
      const r = await api.post<ResultadoProcesoDrive>('/flito/derechos/drive/procesar', { fileId: a.fileId });
      toast.success(
        r.registrados.length > 0
          ? `${r.registrados.length} derecho(s) registrado(s) de ${a.nombre}`
          : `${a.nombre} procesado — revisa el detalle`,
      );
      onProcesado(r);
      setNonce((n) => n + 1);
    } catch (e) {
      toast.error(errorMessage(e));
      setError(errorMessage(e));
    } finally {
      setProcesando(null);
    }
  }

  const colsRegistro: ColumnaTabla<RegistroRow>[] = [
    {
      key: 'archivo', header: 'Archivo', render: (r) => (
        <>
          <div className="font-medium">{r.nombreArchivo ?? '—'}</div>
          {!r.sigueEnDrive && (
            <div className="text-xs text-[color:var(--kit-naranja-texto)]">
              Ya no está en el Drive
            </div>
          )}
        </>
      ),
    },
    {
      key: 'estado', header: 'Estado', render: (r) => (
        <>
          <StatusChip tone={TONO_ESTADO_PROC[r.estado] ?? 'neutral'}>
            {ETIQUETA_ESTADO_PROC[r.estado] ?? r.estado}
          </StatusChip>
          {r.estado === 'error' && r.error && (
            <div className="mt-1 text-xs text-[color:var(--kit-rojo-texto)]">{r.error}</div>
          )}
        </>
      ),
    },
    { key: 'por', header: 'Subido por', className: 'text-xs', render: (r) => r.modificadoPor ?? '—' },
    {
      key: 'extraido', header: 'Extraído', className: 'text-xs tabular-nums', render: (r) => (
        r.cuentasDetectadas !== null
          ? `${r.cuentasDetectadas} cuenta(s) · ${r.placasUnicas ?? 0} placa(s)`
          : '—'
      ),
    },
    { key: 'valor', header: 'Valor', className: 'text-xs tabular-nums', render: (r) => pesos(r.valorTotal) },
    { key: 'procesado', header: 'Procesado', className: 'text-xs', render: (r) => fechaHora(r.procesadoEn) },
  ];

  const colsArchivos: ColumnaTabla<ArchivoDrive>[] = [
    { key: 'archivo', header: 'Archivo', className: 'font-medium', render: (a) => a.nombre },
    {
      // La fecha sola no era accionable: en una carpeta compartida lo que hace falta es saber a quién preguntar.
      key: 'modificado', header: 'Modificado', className: 'text-xs', render: (a) => (
        <>
          <div>{a.modificadoEn ? fechaHora(a.modificadoEn) : '—'}</div>
          {a.modificadoPor && (
            <div className="text-[color:var(--color-text-tertiary)]">por {a.modificadoPor}</div>
          )}
        </>
      ),
    },
    { key: 'tamano', header: 'Tamaño', className: 'text-xs tabular-nums', render: (a) => tamano(a.tamanoBytes) },
    {
      // Informativo, no una prohibición: si el organismo reemplazó el archivo del día hay que poder
      // releerlo. Lo que impide duplicar es el hash de cada recibo.
      key: 'procesado', header: 'Procesado', className: 'text-xs', render: (a) => (
        a.procesadoEn
          ? <StatusChip tone="success">{fechaHora(a.procesadoEn)}</StatusChip>
          : a.omitidoEn
            // Ya estaba en la carpeta cuando se encendió el barrido: se dio por visto
            // sin gastar OCR en histórico que nadie pidió. Se puede procesar a mano.
            ? (
              <span title="Ya estaba en la carpeta al encender el barrido automático. Se puede procesar a mano.">
                <StatusChip tone="neutral">Dado por visto</StatusChip>
              </span>
            )
            : <span className="text-[color:var(--color-text-tertiary)]">Nunca</span>
      ),
    },
    {
      key: 'accion', header: 'Acción', align: 'center', acciones: true, render: (a) => (
        <GradientButton
          variant="secondary" size="sm"
          disabled={procesando !== null}
          onClick={() => procesar(a)}
        >
          {procesando === a.fileId ? 'Procesando…' : a.procesadoEn ? 'Reprocesar' : 'Procesar'}
        </GradientButton>
      ),
    },
  ];

  // Los 4 estados del listado del Drive. Un fallo al PROCESAR deja la lista a la vista y se avisa encima.
  const estadoArchivos = !archivos && !error ? 'loading'
    : error && (archivos ?? []).length === 0 ? 'error'
      : (archivos ?? []).length === 0 ? 'empty' : 'ready';

  return (
    <>
      <p className="text-sm text-[color:var(--color-text-secondary)]">
        Consolidados que publica la secretaría en su Drive. Elige el día y procésalo: se lee cada
        cuenta, se asocia a su trámite por placa y el resultado aparece en las pestañas de al lado.
        Las demás secretarías se cargan a mano desde arriba.
      </p>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-[color:var(--color-text-secondary)]">
          Barrido automático diario a las 9:00. El botón queda para procesar cualquier día a demanda.
        </span>
        <GradientButton variant="ghost" size="sm" onClick={() => setVerRegistro((v) => !v)}>
          {verRegistro ? 'Ocultar el registro' : `Ver el registro${registro ? ` (${registro.length})` : ''}`}
        </GradientButton>
      </div>

      {verRegistro && (
        <FlitCard>
          <h3 className="mb-1 text-base font-bold text-[color:var(--color-action)]">
            Registro de procesamientos
          </h3>
          <p className="mb-3 text-sm text-[color:var(--color-text-tertiary)]">
            Queda constancia de cada pasada, incluidas las de archivos que ya <strong>no están</strong> en
            el Drive: la carpeta la manejan personas del organismo y un consolidado puede desaparecer.
          </p>
          <DataTable
            ariaLabel="Registro de procesamientos"
            columnas={colsRegistro}
            filas={registro ?? []}
            getKey={(r) => String(r.id)}
            status={registro ? 'ready' : 'loading'}
            emptyMessage="Todavía no se ha procesado ningún archivo."
          />
        </FlitCard>
      )}

      {error && (archivos ?? []).length > 0 && <InlineAlert tono="danger">{error}</InlineAlert>}

      <FlitCard>
        <EstadoVista
          status={estadoArchivos}
          cargando="Consultando el Drive…"
          errorMessage={error ?? undefined}
          onRetry={() => setNonce((n) => n + 1)}
          emptyMessage="No hay PDF en la carpeta del Drive."
        >
          <DataTable ariaLabel="Consolidados del Drive" columnas={colsArchivos} filas={archivos ?? []} getKey={(a) => a.fileId} />
        </EstadoVista>
        {procesando && (
          <p className="mt-2 text-sm text-[color:var(--color-text-tertiary)]">
            Se lee cada página con OCR, así que un consolidado grande tarda. No cierres la pestaña.
          </p>
        )}
      </FlitCard>
    </>
  );
}

export default function FlitoDerechos() {
  const [pestana, setPestana] = useState<'registrados' | 'drive'>('registrados');
  const [archivos, setArchivos] = useState<File[]>([]);
  const [organismo, setOrganismo] = useState('');
  const [cargando, setCargando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoCarga | null>(null);

  const [buscar, setBuscar] = useState('');
  const [page, setPage] = useState(1);
  const [nonce, setNonce] = useState(0);
  const [derechos, setDerechos] = useState<DerechoRow[]>([]);
  const [total, setTotal] = useState(0);
  // Filtros del listado de registrados (HU #11026). Antes solo había búsqueda por texto.
  const [organismosSel, setOrganismosSel] = useState<string[]>([]);
  const [origenesSel, setOrigenesSel] = useState<string[]>([]);
  const [pagado, setPagado] = useState({ desde: '', hasta: '' });
  const [facetas, setFacetas] = useState<{ organismos: string[]; origenes: string[] }>({ organismos: [], origenes: [] });
  /** Trámite cuyo visor de documentos está abierto. Null = cerrado. */
  const [soportesDe, setSoportesDe] = useState<{ tramiteId: string; idFlit: string } | null>(null);
  const [conAdvertencia, setConAdvertencia] = useState(false);
  const [preset, setPreset] = useState<string | null>(null);

  /**
   * La única vista con nombre que tiene sentido aquí. Un derecho «con advertencia» es uno cuyo
   * concepto no cuadra con el del trámite: se registró igual, pero alguien debería mirarlo antes
   * de que entre en una liquidación.
   */
  const PRESETS: Array<Preset<{ advertencia: boolean }>> = [{
    nombre: 'Con advertencia',
    descripcion: 'El concepto del recibo no coincide con el del trámite.',
    filtros: { advertencia: true },
  }];

  const recargar = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const t = setTimeout(() => {
      const q = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (buscar.trim()) q.set('buscar', buscar.trim());
      if (organismosSel.length) q.set('organismos', organismosSel.join(','));
      if (origenesSel.length) q.set('origenes', origenesSel.join(','));
      if (conAdvertencia) q.set('conAdvertencia', 'si');
      if (pagado.desde) q.set('pagadoDesde', pagado.desde);
      if (pagado.hasta) q.set('pagadoHasta', pagado.hasta);
      api.get<{ items: DerechoRow[]; total: number }>(`/flito/derechos?${q}`)
        .then((r) => { setDerechos(r.items); setTotal(r.total); })
        .catch(() => { setDerechos([]); setTotal(0); });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buscar, page, nonce, organismosSel.join(','), origenesSel.join(','), pagado.desde, pagado.hasta, conAdvertencia]);

  useEffect(() => {
    api.get<{ organismos: string[]; origenes: string[] }>('/flito/derechos/facetas')
      // Se normaliza lo que llegue: una respuesta inesperada no puede tumbar la pantalla entera
      // por un `.map` sobre undefined. Sin facetas, la búsqueda por texto sigue funcionando.
      .then((f) => setFacetas({ organismos: f?.organismos ?? [], origenes: f?.origenes ?? [] }))
      .catch(() => setFacetas({ organismos: [], origenes: [] }));
  }, [nonce]);

  const totalPaginas = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const totalResultado = useMemo(
    () => (resultado ? CANASTAS.reduce((s, c) => s + resultado[c.clave].length, 0) : 0),
    [resultado],
  );

  async function cargar() {
    if (archivos.length === 0) return;
    setCargando(true);
    try {
      const campos = organismo.trim() ? { organismoCodigo: organismo.trim() } : undefined;
      const r = await api.uploadMany<ResultadoCarga>('/flito/derechos/cargar', archivos, 'archivos', campos);
      setResultado(r);
      // La selección NO se limpia si falla: el usuario no debería volver a elegir los archivos.
      setArchivos([]);
      const n = r.registrados.length;
      toast.success(n > 0 ? `${n} derecho(s) registrado(s)` : 'Carga procesada — revisa el detalle');
      recargar();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setCargando(false);
    }
  }


  // Chips de filtros aplicados del panel del kit: cada X hace lo mismo que vaciar ese filtro a mano.
  const aplicados: FiltroAplicado[] = [
    ...(organismosSel.length ? [{ id: 'organismos', etiqueta: `Secretaría: ${organismosSel.join(', ')}` }] : []),
    ...(origenesSel.length
      ? [{ id: 'origenes', etiqueta: `Origen: ${origenesSel.map((o) => ETIQUETA_ORIGEN[o] ?? o).join(', ')}` }] : []),
    ...(pagado.desde || pagado.hasta
      ? [{ id: 'pagado', etiqueta: `Pagado: ${pagado.desde || '…'} – ${pagado.hasta || '…'}` }] : []),
    ...(preset ? [{ id: 'preset', etiqueta: preset }] : []),
  ];
  function quitarFiltro(id: string) {
    if (id === 'organismos') setOrganismosSel([]);
    if (id === 'origenes') setOrigenesSel([]);
    if (id === 'pagado') setPagado({ desde: '', hasta: '' });
    if (id === 'preset') { setConAdvertencia(false); setPreset(null); }
    setPage(1);
  }

  const colsCanasta: ColumnaTabla<ItemDerecho & { _k: string }>[] = [
    { key: 'archivo', header: 'Archivo', className: 'text-xs', render: (it) => it.archivo },
    { key: 'placa', header: 'Placa', className: 'text-xs font-semibold', render: (it) => it.placa ?? '—' },
    { key: 'tramite', header: 'Trámite', className: 'text-xs', render: (it) => it.idFlit ?? '—' },
    { key: 'valor', header: 'Valor', className: 'text-xs', render: (it) => pesos(it.valor) },
    {
      key: 'detalle', header: 'Detalle', className: 'text-xs text-[color:var(--color-text-secondary)]',
      render: (it) => it.detalle,
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeaderCard
        title="Derechos de tránsito"
        icono="flito-derechos"
        miga={[]}
        subtitle="Carga los recibos que emite el organismo de tránsito. El sistema lee la placa, la fecha y el valor, y los asocia al trámite."
      />

      <FlitCard>
        <h2 className="mb-3 text-base font-bold text-[color:var(--color-action)]">Cargar recibos</h2>
        <div className="grid grid-cols-1 items-end gap-4 md:grid-cols-[minmax(0,1fr)_220px_auto]">
          <FlitUploadBox
            label="Archivos — PDF, imagen, ZIP, o un PDF con varios recibos"
            accept=".pdf,.png,.jpg,.jpeg,.zip"
            multiple
            state={cargando ? 'uploading' : archivos.length > 0 ? 'verified' : 'idle'}
            count={archivos.length}
            onFiles={(lista) => setArchivos(lista)}
            onFile={(f) => setArchivos([f])}
          />
          <label className="campo block">
            <span className="mb-1 block text-xs font-semibold text-[color:var(--color-text-primary)]">
              Organismo (opcional)
            </span>
            <input
              type="text"
              className={flitInp}
              placeholder="Código, ej. 05001"
              value={organismo}
              disabled={cargando}
              onChange={(e) => setOrganismo(e.target.value)}
            />
          </label>
          <GradientButton
            disabled={cargando || archivos.length === 0}
            onClick={cargar}
          >
            {cargando ? 'Procesando…' : `Cargar${archivos.length > 0 ? ` (${archivos.length})` : ''}`}
          </GradientButton>
        </div>
        <p className="mt-2 text-xs text-[color:var(--color-text-tertiary)]">
          El organismo solo ajusta el umbral de lectura y las pistas del OCR; el trámite se determina por la placa del recibo.
        </p>
      </FlitCard>

      <Pestanas
        etiqueta="Derechos de tránsito"
        activa={pestana}
        onElegir={(id) => setPestana(id as 'registrados' | 'drive')}
        pestanas={[
          { id: 'registrados', etiqueta: `Registrados (${total})` },
          { id: 'drive', etiqueta: 'Drive · Medellín' },
        ]}
      />

      {resultado && (
        <FlitCard>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-bold text-[color:var(--color-action)]">
              Resultado de la carga — {totalResultado} documento(s)
            </h2>
            <GradientButton variant="secondary" size="sm" onClick={() => setResultado(null)}>
              Cerrar
            </GradientButton>
          </div>
          <div className="flex flex-col gap-4">
            {CANASTAS.filter((c) => resultado[c.clave].length > 0).map((c) => (
              <div key={c.clave}>
                <div className="mb-1.5 flex items-center gap-2">
                  <EtiquetaEstado estado={`derecho-${c.clave}`}>{c.titulo}</EtiquetaEstado>
                  <span className="text-sm text-[color:var(--color-text-tertiary)]">
                    {resultado[c.clave].length}
                  </span>
                </div>
                <DataTable
                  ariaLabel={c.titulo}
                  columnas={colsCanasta}
                  filas={resultado[c.clave].map((it, i) => ({ ...it, _k: `${c.clave}-${i}` }))}
                  getKey={(it) => it._k}
                />
              </div>
            ))}
          </div>
        </FlitCard>
      )}

      {pestana === 'registrados' ? (
        <>
          <PanelFiltros
            busqueda={buscar}
            onBusqueda={(v) => { setBuscar(v); setPage(1); }}
            placeholder="Buscar por placa o trámite"
            aplicados={aplicados}
            onQuitar={quitarFiltro}
            campos={(
              <>
                <ThFiltroMulti seleccion={organismosSel} onCambio={(v) => { setOrganismosSel(v); setPage(1); }}
                  placeholder="Secretaría" vacio="Sin secretarías registradas"
                  opciones={facetas.organismos.map((c) => ({ value: c, label: c }))} />
                <ThFiltroMulti seleccion={origenesSel} onCambio={(v) => { setOrigenesSel(v); setPage(1); }}
                  placeholder="Origen" vacio="Sin orígenes"
                  opciones={facetas.origenes.map((o) => ({ value: o, label: ETIQUETA_ORIGEN[o] ?? o }))} />
                <FiltrosInteligentes presets={PRESETS} activo={preset}
                  onAplicar={(p) => {
                    setOrganismosSel([]); setOrigenesSel([]); setPagado({ desde: '', hasta: '' }); setBuscar('');
                    setConAdvertencia(p.filtros.advertencia); setPreset(p.nombre); setPage(1);
                  }}
                  onQuitar={() => { setConAdvertencia(false); setPreset(null); setPage(1); }} />
                <RangoFechas etiqueta="Pagado" valor={pagado} onCambio={(r) => { setPagado(r); setPage(1); }} />
              </>
            )}
          />

          {/* Esta tabla sigue en FlitTable (scroll del kit): las celdas comunes de trámite, vehículo y
              fechas (columnasComunes) pintan su propio <td>, y DataTable las envolvería en otro. */}
          <EstadoVista status={derechos.length === 0 ? 'empty' : 'ready'} emptyMessage="Todavía no hay derechos de tránsito registrados.">
            <FlitTable>
              <thead>
                <tr>
                  {ENCABEZADOS_COMUNES.map((h) => <FlitTh key={h}>{h}</FlitTh>)}
                  <FlitTh>Empresa</FlitTh>
                  <FlitTh>Organismo</FlitTh>
                  <FlitTh>Concepto del recibo</FlitTh>
                  <FlitTh>Valor</FlitTh>
                  <FlitTh>Fecha de pago</FlitTh>
                  <FlitTh>Origen</FlitTh>
                  <FlitTh center>Soporte</FlitTh>
                  <FlitTh center>Documentos</FlitTh>
                </tr>
              </thead>
              <tbody>
                {derechos.map((d) => (
                  <FlitTr key={d.id}>
                    <CeldaTramite idFlit={d.idFlit} tipoTramite={d.tipoTramite} />
                    <CeldaVehiculo placa={d.placa} vin={d.vin} marca={d.marca} linea={d.linea} />
                    <CeldaFechas creado={d.fechaCreacion} aprobado={d.fechaAprobacion} />
                    <td className="px-4 py-2.5 text-sm">{d.empresa ?? '—'}</td>
                    <td className="px-4 py-2.5 text-sm">{d.organismoCodigo ?? '—'}</td>
                    <td className="px-4 py-2.5 text-xs">
                      {d.tipoTramiteRecibo ?? '—'}
                      {d.advertencias && d.advertencias.length > 0 && (
                        <span className="ml-2" title={d.advertencias.join(' ')}>
                          <StatusChip tone="warning">Con advertencia</StatusChip>
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-sm font-semibold">{pesos(d.valor)}</td>
                    <td className="px-4 py-2.5 text-sm">{fecha(d.fechaPago)}</td>
                    <td className="px-4 py-2.5 text-xs">
                      <StatusChip tone={d.origen === 'drive' ? 'active' : 'neutral'}>{ETIQUETA_ORIGEN[d.origen] ?? d.origen}</StatusChip>
                      <ArchivoOrigen d={d} />
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {d.soporteId ? (
                        <GradientButton variant="ghost" size="sm" onClick={() => abrirSoporte(d.soporteId!)}>
                          Ver PDF
                        </GradientButton>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {/* Los tres conceptos del trámite, no solo el derecho: quien revisa un
                          derecho quiere comprobar si el SOAT y el impuesto están cargados, y
                          hasta ahora tenía que irse al reporte de costos para averiguarlo. */}
                      <GradientButton variant="ghost" size="sm"
                        onClick={() => setSoportesDe({ tramiteId: d.tramiteId, idFlit: d.idFlit })}>
                        Ver todos
                      </GradientButton>
                    </td>
                  </FlitTr>
                ))}
              </tbody>
            </FlitTable>

            <Paginacion
              total={total} page={page} totalPaginas={totalPaginas} sustantivo="registro(s)"
              onPrev={() => setPage((p) => p - 1)} onNext={() => setPage((p) => p + 1)}
            />
          </EstadoVista>
        </>
      ) : (
        <TabDrive onProcesado={(r) => { setResultado(r); recargar(); }} />
      )}

      {soportesDe && (
        <VisorSoportes ruta={`/finanzas/tramites/${soportesDe.tramiteId}/soportes`} titulo={soportesDe.idFlit}
          onClose={() => setSoportesDe(null)} />
      )}
    </div>
  );
}
