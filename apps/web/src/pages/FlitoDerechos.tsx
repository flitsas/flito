// FLITO Derechos de trámite (HU #10951). Carga de recibos, listado de lo registrado y bandeja de
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
import {
  FlitCard, FlitEmpty, FlitPillGroup, FlitPillButton, FlitTable, FlitTh, FlitTr,
  flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';

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
}
interface PendienteRow {
  id: string; placa: string; valor: string | null; fechaPago: string | null;
  tipoTramiteRecibo: string | null; organismoCodigo: string | null; origen: string;
  intentos: number; ultimoIntentoEn: string; soporteId: string; nombreArchivo: string;
  createdAt: string;
}

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

export default function FlitoDerechos() {
  const [pestana, setPestana] = useState<'registrados' | 'pendientes'>('registrados');
  const [archivos, setArchivos] = useState<File[]>([]);
  const [organismo, setOrganismo] = useState('');
  const [cargando, setCargando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoCarga | null>(null);

  const [buscar, setBuscar] = useState('');
  const [page, setPage] = useState(1);
  const [nonce, setNonce] = useState(0);
  const [derechos, setDerechos] = useState<DerechoRow[]>([]);
  const [total, setTotal] = useState(0);
  const [pendientes, setPendientes] = useState<PendienteRow[]>([]);
  const [reintentando, setReintentando] = useState(false);

  const recargar = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const t = setTimeout(() => {
      const q = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (buscar.trim()) q.set('buscar', buscar.trim());
      api.get<{ items: DerechoRow[]; total: number }>(`/flito/derechos?${q}`)
        .then((r) => { setDerechos(r.items); setTotal(r.total); })
        .catch(() => { setDerechos([]); setTotal(0); });
    }, 300);
    return () => clearTimeout(t);
  }, [buscar, page, nonce]);

  useEffect(() => {
    api.get<PendienteRow[]>('/flito/derechos/pendientes').then(setPendientes).catch(() => setPendientes([]));
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

  async function reintentarPendientes() {
    setReintentando(true);
    try {
      const r = await api.post<{ revisados: number; asociados: number }>('/flito/derechos/pendientes/reintentar');
      toast.success(`${r.asociados} de ${r.revisados} pendiente(s) asociado(s)`);
      recargar();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setReintentando(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeaderCard
        title="Derechos de trámite"
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

      <FlitPillGroup>
        <FlitPillButton active={pestana === 'registrados'} onClick={() => setPestana('registrados')}>
          Registrados ({total})
        </FlitPillButton>
        <FlitPillButton active={pestana === 'pendientes'} onClick={() => setPestana('pendientes')}>
          Sin trámite ({pendientes.length})
        </FlitPillButton>
      </FlitPillGroup>

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
          </div>

          {derechos.length === 0 ? (
            <FlitEmpty>Todavía no hay derechos de trámite registrados.</FlitEmpty>
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
                        <StatusChip tone={d.origen === 'drive' ? 'active' : 'neutral'}>{d.origen}</StatusChip>
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
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
              Recibos leídos cuya placa todavía no corresponde a ningún trámite. Se reintenta el cruce en cada sincronización con FLIT.
            </p>
            <button
              type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
              disabled={reintentando || pendientes.length === 0} onClick={reintentarPendientes}
            >
              {reintentando ? 'Reintentando…' : 'Reintentar ahora'}
            </button>
          </div>

          {pendientes.length === 0 ? (
            <FlitEmpty>No hay recibos esperando trámite.</FlitEmpty>
          ) : (
            <FlitTable>
              <thead>
                <tr>
                  <FlitTh>Placa</FlitTh>
                  <FlitTh>Archivo</FlitTh>
                  <FlitTh>Concepto</FlitTh>
                  <FlitTh>Valor</FlitTh>
                  <FlitTh>Fecha de pago</FlitTh>
                  <FlitTh center>Intentos</FlitTh>
                  <FlitTh>Último intento</FlitTh>
                  <FlitTh center>Soporte</FlitTh>
                </tr>
              </thead>
              <tbody>
                {pendientes.map((p) => (
                  <FlitTr key={p.id}>
                    <td className="px-4 py-2.5 text-sm font-semibold">{p.placa}</td>
                    <td className="px-4 py-2.5 text-xs">{p.nombreArchivo}</td>
                    <td className="px-4 py-2.5 text-xs">{p.tipoTramiteRecibo ?? '—'}</td>
                    <td className="px-4 py-2.5 text-sm">{pesos(p.valor)}</td>
                    <td className="px-4 py-2.5 text-sm">{fecha(p.fechaPago)}</td>
                    <td className="px-4 py-2.5 text-center text-sm">{p.intentos}</td>
                    <td className="px-4 py-2.5 text-xs">{fechaHora(p.ultimoIntentoEn)}</td>
                    <td className="px-4 py-2.5 text-center">
                      <button
                        type="button"
                        className="text-xs font-semibold underline"
                        style={{ color: 'var(--flit-blue)' }}
                        onClick={() => abrirSoporte(p.soporteId)}
                      >
                        Ver PDF
                      </button>
                    </td>
                  </FlitTr>
                ))}
              </tbody>
            </FlitTable>
          )}
        </>
      )}
    </div>
  );
}
