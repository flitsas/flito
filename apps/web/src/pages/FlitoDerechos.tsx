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
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import {
  FlitCard, FlitEmpty, FlitPillGroup, FlitPillButton, FlitTable, FlitTh, FlitTr,
  flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import ThFiltroMulti from '../components/flit/ThFiltroMulti';
import RangoFechas from '../components/flit/RangoFechas';
import VisorSoportesTramite from '../components/flit/VisorSoportesTramite';

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
  if (!nombre) return <div className="mt-0.5" style={{ color: 'var(--flit-text-muted)' }}>Archivo no registrado</div>;
  const paginas = d.paginas?.length
    ? ` · pág. ${d.paginas.length > 1 ? `${d.paginas[0]}–${d.paginas[d.paginas.length - 1]}` : d.paginas[0]}`
    : '';
  return (
    <div className="mt-0.5 break-all" style={{ color: 'var(--flit-text-secondary)' }} title={nombre}>
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
const CANASTAS = [
  { clave: 'registrados', titulo: 'Registrados', tono: 'success' as ChipTone },
  { clave: 'enRevision', titulo: 'En revisión', tono: 'warning' as ChipTone },
  { clave: 'pendientes', titulo: 'Sin trámite asociado', tono: 'active' as ChipTone },
  { clave: 'duplicados', titulo: 'Duplicados', tono: 'draft' as ChipTone },
  { clave: 'omitidas', titulo: 'Páginas omitidas', tono: 'neutral' as ChipTone },
  { clave: 'fallidos', titulo: 'Fallidos', tono: 'danger' as ChipTone },
] as const;

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

  return (
    <>
      <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        Consolidados que publica la secretaría en su Drive. Elige el día y procésalo: se lee cada
        cuenta, se asocia a su trámite por placa y el resultado aparece en las pestañas de al lado.
        Las demás secretarías se cargan a mano desde arriba.
      </p>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span style={{ color: 'var(--flit-text-secondary)' }}>
          Barrido automático diario a las 9:00. El botón queda para procesar cualquier día a demanda.
        </span>
        <button type="button" className="underline" style={{ color: 'var(--flit-blue-text)' }}
          onClick={() => setVerRegistro((v) => !v)}>
          {verRegistro ? 'Ocultar el registro' : `Ver el registro${registro ? ` (${registro.length})` : ''}`}
        </button>
      </div>

      {verRegistro && (
        <FlitCard>
          <h3 className="mb-1 text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
            Registro de procesamientos
          </h3>
          <p className="mb-3 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            Queda constancia de cada pasada, incluidas las de archivos que ya <strong>no están</strong> en
            el Drive: la carpeta la manejan personas del organismo y un consolidado puede desaparecer.
          </p>
          {!registro && <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando…</p>}
          {registro && registro.length === 0 && <FlitEmpty>Todavía no se ha procesado ningún archivo.</FlitEmpty>}
          {registro && registro.length > 0 && (
            <div className="overflow-x-auto">
              <FlitTable>
                <thead>
                  <FlitTr>
                    <FlitTh>Archivo</FlitTh><FlitTh>Estado</FlitTh><FlitTh>Subido por</FlitTh>
                    <FlitTh>Extraído</FlitTh><FlitTh>Valor</FlitTh><FlitTh>Procesado</FlitTh>
                  </FlitTr>
                </thead>
                <tbody>
                  {registro.map((r) => (
                    <FlitTr key={r.id}>
                      <td className="px-4 py-2 text-sm">
                        <div className="font-medium">{r.nombreArchivo ?? '—'}</div>
                        {!r.sigueEnDrive && (
                          <div className="text-[11px]" style={{ color: 'var(--flit-warning)' }}>
                            Ya no está en el Drive
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <StatusChip tone={TONO_ESTADO_PROC[r.estado] ?? 'neutral'}>
                          {ETIQUETA_ESTADO_PROC[r.estado] ?? r.estado}
                        </StatusChip>
                        {r.estado === 'error' && r.error && (
                          <div className="mt-1 text-[11px]" style={{ color: 'var(--flit-danger)' }}>{r.error}</div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs">{r.modificadoPor ?? '—'}</td>
                      <td className="px-4 py-2 text-xs tabular-nums">
                        {r.cuentasDetectadas !== null
                          ? `${r.cuentasDetectadas} cuenta(s) · ${r.placasUnicas ?? 0} placa(s)`
                          : '—'}
                      </td>
                      <td className="px-4 py-2 text-xs tabular-nums">{pesos(r.valorTotal)}</td>
                      <td className="px-4 py-2 text-xs">{fechaHora(r.procesadoEn)}</td>
                    </FlitTr>
                  ))}
                </tbody>
              </FlitTable>
            </div>
          )}
        </FlitCard>
      )}

      {error && <FlitCard><p className="text-sm text-red-600">{error}</p></FlitCard>}

      {!archivos && !error && (
        <FlitCard><p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Consultando el Drive…</p></FlitCard>
      )}

      {archivos && archivos.length === 0 && !error && (
        <FlitCard><FlitEmpty>No hay PDF en la carpeta del Drive.</FlitEmpty></FlitCard>
      )}

      {archivos && archivos.length > 0 && (
        <FlitCard>
          <FlitTable>
            <thead>
              <tr>
                <FlitTh>Archivo</FlitTh>
                <FlitTh>Modificado</FlitTh>
                <FlitTh>Tamaño</FlitTh>
                <FlitTh>Procesado</FlitTh>
                <FlitTh center>Acción</FlitTh>
              </tr>
            </thead>
            <tbody>
              {archivos.map((a) => (
                <FlitTr key={a.fileId}>
                  <td className="px-4 py-2.5 text-sm font-medium">{a.nombre}</td>
                  {/* La fecha sola no era accionable: en una carpeta compartida lo que hace falta
                      es saber a quién preguntar. */}
                  <td className="px-4 py-2.5 text-xs">
                    <div>{a.modificadoEn ? fechaHora(a.modificadoEn) : '—'}</div>
                    {a.modificadoPor && (
                      <div style={{ color: 'var(--flit-text-muted)' }}>por {a.modificadoPor}</div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs tabular-nums">{tamano(a.tamanoBytes)}</td>
                  <td className="px-4 py-2.5 text-xs">
                    {/* Informativo, no una prohibición: si el organismo reemplazó el archivo del día
                        hay que poder releerlo. Lo que impide duplicar es el hash de cada recibo. */}
                    {a.procesadoEn
                      ? <StatusChip tone="success">{fechaHora(a.procesadoEn)}</StatusChip>
                      : a.omitidoEn
                        // Ya estaba en la carpeta cuando se encendió el barrido: se dio por visto
                        // sin gastar OCR en histórico que nadie pidió. Se puede procesar a mano.
                        ? (
                          <span title="Ya estaba en la carpeta al encender el barrido automático. Se puede procesar a mano.">
                            <StatusChip tone="neutral">Dado por visto</StatusChip>
                          </span>
                        )
                        : <span style={{ color: 'var(--flit-text-muted)' }}>Nunca</span>}
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    <button
                      type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                      disabled={procesando !== null}
                      onClick={() => procesar(a)}
                    >
                      {procesando === a.fileId ? 'Procesando…' : a.procesadoEn ? 'Reprocesar' : 'Procesar'}
                    </button>
                  </td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
          {procesando && (
            <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
              Se lee cada página con OCR, así que un consolidado grande tarda. No cierres la pestaña.
            </p>
          )}
        </FlitCard>
      )}
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

  const recargar = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const t = setTimeout(() => {
      const q = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (buscar.trim()) q.set('buscar', buscar.trim());
      if (organismosSel.length) q.set('organismos', organismosSel.join(','));
      if (origenesSel.length) q.set('origenes', origenesSel.join(','));
      if (pagado.desde) q.set('pagadoDesde', pagado.desde);
      if (pagado.hasta) q.set('pagadoHasta', pagado.hasta);
      api.get<{ items: DerechoRow[]; total: number }>(`/flito/derechos?${q}`)
        .then((r) => { setDerechos(r.items); setTotal(r.total); })
        .catch(() => { setDerechos([]); setTotal(0); });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buscar, page, nonce, organismosSel.join(','), origenesSel.join(','), pagado.desde, pagado.hasta]);

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


  return (
    <div className="flex flex-col gap-5">
      <PageHeaderCard
        title="Derechos de tránsito"
        subtitle="Carga los recibos que emite el organismo de tránsito. El sistema lee la placa, la fecha y el valor, y los asocia al trámite."
      />

      <FlitCard>
        <h2 className="mb-3 text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>Cargar recibos</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block flex-1 min-w-[260px]">
            <span className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
              Archivos — PDF, imagen, ZIP, o un PDF con varios recibos
            </span>
            <input
              type="file"
              multiple
              accept=".pdf,.png,.jpg,.jpeg,.zip"
              className={flitInp}
              disabled={cargando}
              onChange={(e) => setArchivos(Array.from(e.target.files ?? []))}
            />
          </label>
          <label className="block w-[200px]">
            <span className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
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
          <button
            type="button"
            className={flitBtnPrimary}
            style={flitBtnPrimaryStyle}
            disabled={cargando || archivos.length === 0}
            onClick={cargar}
          >
            {cargando ? 'Procesando…' : `Cargar${archivos.length > 0 ? ` (${archivos.length})` : ''}`}
          </button>
        </div>
        <p className="mt-2 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
          El organismo solo ajusta el umbral de lectura y las pistas del OCR; el trámite se determina por la placa del recibo.
        </p>
      </FlitCard>


      <FlitPillGroup>
        <FlitPillButton active={pestana === 'registrados'} onClick={() => setPestana('registrados')}>
          Registrados ({total})
        </FlitPillButton>
        <FlitPillButton active={pestana === 'drive'} onClick={() => setPestana('drive')}>
          Drive · Medellín
        </FlitPillButton>
      </FlitPillGroup>

      {resultado && (
        <FlitCard>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
              Resultado de la carga — {totalResultado} documento(s)
            </h2>
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setResultado(null)}>
              Cerrar
            </button>
          </div>
          <div className="flex flex-col gap-4">
            {CANASTAS.filter((c) => resultado[c.clave].length > 0).map((c) => (
              <div key={c.clave}>
                <div className="mb-1.5 flex items-center gap-2">
                  <StatusChip tone={c.tono}>{c.titulo}</StatusChip>
                  <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
                    {resultado[c.clave].length}
                  </span>
                </div>
                <FlitTable>
                  <thead>
                    <tr>
                      <FlitTh>Archivo</FlitTh>
                      <FlitTh>Placa</FlitTh>
                      <FlitTh>Trámite</FlitTh>
                      <FlitTh>Valor</FlitTh>
                      <FlitTh>Detalle</FlitTh>
                    </tr>
                  </thead>
                  <tbody>
                    {resultado[c.clave].map((it, i) => (
                      <FlitTr key={`${c.clave}-${i}`}>
                        <td className="px-4 py-2 text-xs">{it.archivo}</td>
                        <td className="px-4 py-2 text-xs font-semibold">{it.placa ?? '—'}</td>
                        <td className="px-4 py-2 text-xs">{it.idFlit ?? '—'}</td>
                        <td className="px-4 py-2 text-xs">{pesos(it.valor)}</td>
                        <td className="px-4 py-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{it.detalle}</td>
                      </FlitTr>
                    ))}
                  </tbody>
                </FlitTable>
              </div>
            ))}
          </div>
        </FlitCard>
      )}

      {pestana === 'registrados' ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="search"
              className={`${flitInp} max-w-[280px]`}
              placeholder="Buscar por placa o trámite"
              value={buscar}
              onChange={(e) => { setBuscar(e.target.value); setPage(1); }}
            />
            <ThFiltroMulti seleccion={organismosSel} onCambio={(v) => { setOrganismosSel(v); setPage(1); }}
              placeholder="Secretaría" vacio="Sin secretarías registradas"
              opciones={facetas.organismos.map((c) => ({ value: c, label: c }))} />
            <ThFiltroMulti seleccion={origenesSel} onCambio={(v) => { setOrigenesSel(v); setPage(1); }}
              placeholder="Origen" vacio="Sin orígenes"
              opciones={facetas.origenes.map((o) => ({ value: o, label: ETIQUETA_ORIGEN[o] ?? o }))} />
            <RangoFechas etiqueta="Pagado" valor={pagado} onCambio={(r) => { setPagado(r); setPage(1); }} />
          </div>

          {derechos.length === 0 ? (
            <FlitEmpty>Todavía no hay derechos de tránsito registrados.</FlitEmpty>
          ) : (
            <>
              <FlitTable>
                <thead>
                  <tr>
                    <FlitTh>Placa</FlitTh>
                    <FlitTh>Trámite</FlitTh>
                    <FlitTh>Empresa</FlitTh>
                    <FlitTh>Organismo</FlitTh>
                    <FlitTh>Concepto</FlitTh>
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
                      <td className="px-4 py-2.5 text-sm font-semibold">{d.placa ?? '—'}</td>
                      <td className="px-4 py-2.5 text-sm">{d.idFlit}</td>
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
                          <button
                            type="button"
                            className="text-xs font-semibold underline"
                            style={{ color: 'var(--flit-blue)' }}
                            onClick={() => abrirSoporte(d.soporteId!)}
                          >
                            Ver PDF
                          </button>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        {/* Los tres conceptos del trámite, no solo el derecho: quien revisa un
                            derecho quiere comprobar si el SOAT y el impuesto están cargados, y
                            hasta ahora tenía que irse al reporte de costos para averiguarlo. */}
                        <button type="button" className="text-xs font-semibold underline"
                          style={{ color: 'var(--flit-blue)' }}
                          onClick={() => setSoportesDe({ tramiteId: d.tramiteId, idFlit: d.idFlit })}>
                          Ver todos
                        </button>
                      </td>
                    </FlitTr>
                  ))}
                </tbody>
              </FlitTable>

              <div className="flex items-center justify-between text-xs" style={{ color: 'var(--flit-text-muted)' }}>
                <span>{total} registro(s)</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                    disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
                  >
                    Anterior
                  </button>
                  <span>Página {page} de {totalPaginas}</span>
                  <button
                    type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                    disabled={page >= totalPaginas} onClick={() => setPage((p) => p + 1)}
                  >
                    Siguiente
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      ) : (
        <TabDrive onProcesado={(r) => { setResultado(r); recargar(); }} />
      )}

      {soportesDe && (
        <VisorSoportesTramite tramiteId={soportesDe.tramiteId} titulo={soportesDe.idFlit}
          onClose={() => setSoportesDe(null)} />
      )}
    </div>
  );
}
