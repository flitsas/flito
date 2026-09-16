// FLITO — Finanzas · Comprobantes (HU #12612, Feature #12605, Épica #12245). La puerta única por la
// que entra cualquier comprobante o soporte de un trámite, y la cola de lo que FLITO leyó.
//
// La página ES la cola (UX §2, disposición A): pills de estado, dos selects, tabla agrupada por
// carga, y dos modales: «Cargar comprobantes» (`CargaComprobantes`) y el detalle en solo lectura
// (`DetalleComprobante`). En este Feature nadie asocia ni aplica: la acción de fila es «Ver» y las
// pills Aplicados / Descartados devuelven vacío filtrado. Guardas por `hasFuncion`, nunca por rol.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CONCEPTO_COSTO_LABEL, CONCEPTOS_COSTO, MOTIVO_PENDIENTE_COMPROBANTE_LABEL, MOTIVOS_PENDIENTE_COMPROBANTE,
  TIPO_DOCUMENTO_COMPROBANTE_LABEL, type ComprobanteListaDto, type ConceptoCosto, type EstadoComprobante,
  type ListaComprobantesDto, type MotivoPendienteComprobante,
} from '@operaciones/shared-types';
import { ApiError, api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  RUTA_COMPROBANTES, agruparPorCarga, etiquetaChipCarga, fechaCarga, llaveLeida, pesosComprobante,
  textoCarga, textoEsPago, textoPaginas, type GrupoCarga,
} from '../lib/comprobantes';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import PageContentSkeleton from '../components/flit/PageContentSkeleton';
import Paginacion from '../components/flit/Paginacion';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import { CeldaTramite } from '../components/flit/columnasComunes';
import CargaComprobantes from '../components/flito/CargaComprobantes';
import DetalleComprobante from '../components/flito/DetalleComprobante';
import {
  FlitCard, FlitEmpty, FlitPillButton, FlitPillGroup, FlitTable, FlitTh, FlitTr,
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondarySm, flitBtnSecondaryStyle, flitInp,
} from '../components/flit/flitPageKit';

type Pill = EstadoComprobante | 'todos';
const PILLS: { valor: Pill; rotulo: string }[] = [
  { valor: 'pendiente', rotulo: 'Pendientes' }, { valor: 'aplicado', rotulo: 'Aplicados' },
  { valor: 'descartado', rotulo: 'Descartados' }, { valor: 'todos', rotulo: 'Todos' },
];
const PAGE_SIZE = 50;
const COLUMNAS = 7;

const COPY_SIN_FUNCION = 'Tu usuario no tiene la función “Ver la cola de comprobantes”. Pídesela a un administrador.';
const COPY_ERROR_COLA = 'No se pudo cargar la cola de comprobantes.';
const COPY_VACIO = 'No hay comprobantes por asociar.';
const COPY_VACIO_FILTRADO = 'Ningún comprobante coincide con los filtros.';

const TONO_ESTADO: Record<EstadoComprobante, ChipTone> = { pendiente: 'warning', aplicado: 'success', descartado: 'neutral' };
const ROTULO_ESTADO: Record<EstadoComprobante, string> = { pendiente: 'Pendiente', aplicado: 'Aplicado', descartado: 'Descartado' };

type ChipCarga = { loteId: string; etiqueta: string };

export default function FlitoComprobantes() {
  const { hasFuncion, funciones } = useAuth();
  const puedeVerCola = hasFuncion('comprobantes.cola.ver');
  const puedeCargar = hasFuncion('comprobantes.lote.cargar');
  const puedeVer = hasFuncion('comprobantes.comprobante.ver');

  const [pill, setPill] = useState<Pill>('pendiente');
  const [concepto, setConcepto] = useState<ConceptoCosto | ''>('');
  const [motivo, setMotivo] = useState<MotivoPendienteComprobante | ''>('');
  const [chipCarga, setChipCarga] = useState<ChipCarga | null>(null);
  const [page, setPage] = useState(1);
  const [nonce, setNonce] = useState(0);

  const [data, setData] = useState<ListaComprobantesDto | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<{ texto: string; sinFuncion: boolean } | null>(null);
  const [totalPendientes, setTotalPendientes] = useState<number | null>(null);
  const [anuncio, setAnuncio] = useState('');
  const anunciarAlRefrescar = useRef(false);

  const [modalCarga, setModalCarga] = useState(false);
  const [detalleId, setDetalleId] = useState<string | null>(null);
  const tituloRef = useRef<HTMLHeadingElement>(null);

  const hayFiltros = pill !== 'pendiente' || concepto !== '' || motivo !== '' || chipCarga !== null;

  // Cambiar un filtro vuelve a la página 1; la paginación es la única que mueve `page` por su cuenta.
  const cambiarPill = (p: Pill) => { setPill(p); if (p !== 'pendiente') setMotivo(''); setPage(1); };
  const cambiarConcepto = (c: ConceptoCosto | '') => { setConcepto(c); setPage(1); };
  const cambiarMotivo = (m: MotivoPendienteComprobante | '') => { setMotivo(m); setPage(1); };
  const ponerChipCarga = (loteId: string, iso: string) => { setChipCarga({ loteId, etiqueta: etiquetaChipCarga(iso) }); setPage(1); };
  const quitarChipCarga = () => { setChipCarga(null); setPage(1); };
  const limpiarFiltros = () => { setPill('pendiente'); setConcepto(''); setMotivo(''); setChipCarga(null); setPage(1); };
  const refrescar = useCallback(() => setNonce((n) => n + 1), []);
  const refrescarYAnunciar = useCallback(() => { anunciarAlRefrescar.current = true; setNonce((n) => n + 1); }, []);

  useEffect(() => {
    // `funciones` null = `/mios` aún no llegó: fail-closed, sin pedir nada todavía.
    if (funciones === null) return undefined;
    if (!puedeVerCola) { setCargando(false); setError({ texto: COPY_SIN_FUNCION, sinFuncion: true }); return undefined; }
    let vivo = true;
    setCargando(true); setError(null);
    const q = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (pill !== 'todos') q.set('estado', pill);
    if (concepto) q.set('concepto', concepto);
    if (pill === 'pendiente' && motivo) q.set('motivo', motivo);
    if (chipCarga) q.set('loteId', chipCarga.loteId);
    api.get<ListaComprobantesDto>(`${RUTA_COMPROBANTES}?${q.toString()}`)
      .then((d) => {
        if (!vivo) return;
        setData(d);
        // El contador de la pill es el total de `estado=pendiente` sin más filtros; con filtros se conserva el último.
        if (pill === 'pendiente' && !concepto && !motivo && !chipCarga) setTotalPendientes(d.total);
        if (anunciarAlRefrescar.current) {
          anunciarAlRefrescar.current = false;
          setAnuncio(`Cola actualizada: ${pill === 'pendiente' ? d.total : (totalPendientes ?? d.total)} pendientes`);
        }
      })
      .catch((e) => {
        if (!vivo) return;
        const sinFuncion = e instanceof ApiError && e.status === 403;
        setError({ texto: sinFuncion ? COPY_SIN_FUNCION : errorMessage(e), sinFuncion });
      })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  // `totalPendientes` solo se lee para el anuncio; no debe relanzar la consulta.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [funciones, puedeVerCola, pill, concepto, motivo, chipCarga, page, nonce]);

  const alListo = (loteId: string) => {
    setModalCarga(false);
    ponerChipCarga(loteId, new Date().toISOString());
    anunciarAlRefrescar.current = true;
    setNonce((n) => n + 1);
  };

  const totalPaginas = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const grupos = data ? agruparPorCarga(data.items) : [];

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Finanzas — Comprobantes"
        subtitle="Sube cualquier comprobante o soporte de un trámite; FLITO lo lee y te muestra qué es, a qué llave corresponde y qué valores trae."
        titleRef={tituloRef}
        actions={puedeCargar && (
          <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={() => setModalCarga(true)}>Cargar comprobantes</button>
        )}
      />
      <p className="sr-only" role="status" aria-live="polite">{anuncio}</p>

      <FlitCard className="flex flex-wrap items-center gap-3">
        <FlitPillGroup>
          {PILLS.map((p) => (
            <FlitPillButton key={p.valor} active={pill === p.valor} pressed={pill === p.valor} onClick={() => cambiarPill(p.valor)}>
              {p.rotulo}{p.valor === 'pendiente' && totalPendientes !== null && <span className="ml-1 font-normal">{totalPendientes}</span>}
            </FlitPillButton>
          ))}
        </FlitPillGroup>
        <label className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          <span className="sr-only">Concepto</span>
          <select className={`${flitInp} w-auto py-1.5`} value={concepto} onChange={(e) => cambiarConcepto(e.target.value as ConceptoCosto | '')}>
            <option value="">Todos los conceptos</option>
            {CONCEPTOS_COSTO.map((c) => <option key={c} value={c}>{CONCEPTO_COSTO_LABEL[c]}</option>)}
          </select>
        </label>
        {pill === 'pendiente' && (
          <label className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            <span className="sr-only">Motivo</span>
            <select className={`${flitInp} w-auto py-1.5`} value={motivo} onChange={(e) => cambiarMotivo(e.target.value as MotivoPendienteComprobante | '')}>
              <option value="">Todos los motivos</option>
              {MOTIVOS_PENDIENTE_COMPROBANTE.map((m) => <option key={m} value={m}>{MOTIVO_PENDIENTE_COMPROBANTE_LABEL[m]}</option>)}
            </select>
          </label>
        )}
        {chipCarga && (
          <span className="inline-flex items-center gap-1">
            <StatusChip tone="active">{chipCarga.etiqueta}{data && ` · ${data.total} documentos`}</StatusChip>
            <button type="button" className="flit-focus rounded px-1 text-sm" style={{ color: 'var(--flit-text-secondary)' }}
              aria-label="Quitar el filtro de carga" onClick={quitarChipCarga}>✕</button>
          </span>
        )}
        {hayFiltros && (
          <button className={`${flitBtnSecondary} ml-auto`} style={flitBtnSecondaryStyle} onClick={limpiarFiltros}>Limpiar filtros</button>
        )}
      </FlitCard>

      {error ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm" style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-card)' }}>
          <span className="text-red-600">{error.sinFuncion ? error.texto : `${COPY_ERROR_COLA} ${error.texto}`}</span>
          {!error.sinFuncion && <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={refrescar}>Reintentar</button>}
        </div>
      ) : cargando || !data ? (
        <div aria-busy="true"><PageContentSkeleton /></div>
      ) : data.items.length === 0 ? (
        <FlitEmpty>
          {hayFiltros ? (
            <p>{COPY_VACIO_FILTRADO}</p>
          ) : (
            <>
              <p className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{COPY_VACIO}</p>
              <p className="mt-1">Cuando cargues documentos, los que FLITO no pueda aplicar solo aparecen aquí. Empieza con Cargar comprobantes, arriba.</p>
            </>
          )}
        </FlitEmpty>
      ) : (
        <>
          <Paginacion total={data.total} page={data.page} totalPaginas={totalPaginas} sustantivo={pill === 'pendiente' ? 'pendientes' : 'comprobantes'}
            onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => Math.min(totalPaginas, p + 1))} />
          <FlitTable label="Cola de comprobantes">
            <thead>
              <tr>
                <FlitTh estrecha>Documento</FlitTh><FlitTh estrecha>Leído</FlitTh><FlitTh estrecha>Concepto</FlitTh>
                <FlitTh estrecha>Trámite</FlitTh><FlitTh estrecha>Valor</FlitTh><FlitTh estrecha>Estado</FlitTh><FlitTh estrecha><span className="sr-only">Acción</span></FlitTh>
              </tr>
            </thead>
            {grupos.map((g) => (
              <GrupoDeCarga key={`${g.loteId}-${g.cabecera.id}`} grupo={g} puedeVer={puedeVer}
                onSoloEstaCarga={() => ponerChipCarga(g.loteId, g.cabecera.createdAt)} onVer={setDetalleId} />
            ))}
          </FlitTable>
          <Paginacion total={data.total} page={data.page} totalPaginas={totalPaginas} sustantivo={pill === 'pendiente' ? 'pendientes' : 'comprobantes'}
            onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => Math.min(totalPaginas, p + 1))} />
        </>
      )}

      {modalCarga && (
        <CargaComprobantes onClose={() => setModalCarga(false)} onListo={alListo} onVerOriginal={setDetalleId} />
      )}
      {detalleId && (
        <DetalleComprobante id={detalleId} onClose={() => setDetalleId(null)} onColaActualizada={refrescarYAnunciar} restoreFocusRef={tituloRef} />
      )}
    </div>
  );
}

/** Un `tbody` por carga: cabecera de grupo (`th scope="rowgroup"`) + una fila por documento. */
function GrupoDeCarga({ grupo, puedeVer, onSoloEstaCarga, onVer }: {
  grupo: GrupoCarga; puedeVer: boolean; onSoloEstaCarga: () => void; onVer: (id: string) => void;
}) {
  const n = grupo.filas.length;
  return (
    <tbody>
      <tr style={{ background: 'var(--flit-bg-app)' }}>
        <th scope="rowgroup" colSpan={COLUMNAS} className="px-3 py-2 text-left text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span>{textoCarga(grupo.cabecera)} · {n} {n === 1 ? 'documento' : 'documentos'} en {grupo.archivos} {grupo.archivos === 1 ? 'archivo' : 'archivos'}</span>
            <button type="button" className="flit-focus rounded font-medium underline" style={{ color: 'var(--flit-blue-text)' }} onClick={onSoloEstaCarga}>
              Solo esta carga
            </button>
          </span>
        </th>
      </tr>
      {grupo.filas.map((c) => <FilaComprobante key={c.id} c={c} puedeVer={puedeVer} onVer={onVer} />)}
    </tbody>
  );
}

/** Copy exacto de la ficha UX §5.2. Sin `extraccion`, sin uuid y sin VIN completo en el DOM. */
function FilaComprobante({ c, puedeVer, onVer }: { c: ComprobanteListaDto; puedeVer: boolean; onVer: (id: string) => void }) {
  const td = 'px-3 py-2 align-top text-sm';
  const secundario = { color: 'var(--flit-text-secondary)' } as const;
  const tenue = { color: 'var(--flit-text-muted)' } as const;
  const paginas = textoPaginas(c.paginas);
  const llave = c.tramite ? null : llaveLeida(c);
  const nombreConPaginas = `${c.archivo.nombre}${paginas ? ` ${paginas}` : ''}`;
  return (
    <FlitTr>
      <td className={td} style={{ color: 'var(--flit-text-primary)' }}>
        <span className="block max-w-[14rem] truncate font-medium" title={c.archivo.nombre}>{c.archivo.nombre}</span>
        {paginas && <span className="block text-xs" style={tenue}>{paginas}</span>}
      </td>
      <td className={td} style={secundario}>
        {c.tipoDocumento ? <span>{TIPO_DOCUMENTO_COMPROBANTE_LABEL[c.tipoDocumento]}</span> : <span className="italic" style={tenue}>Sin identificar</span>}
        <span className="block text-xs" style={tenue}>{textoEsPago(c.esPago)}</span>
      </td>
      <td className={td} style={secundario}>{c.concepto ? CONCEPTO_COSTO_LABEL[c.concepto] : '—'}</td>
      <td className={td}>
        {c.tramite
          ? <CeldaTramite idFlit={c.tramite.idFlit} tipoTramite={null} extra={c.tramite.placa} />
          : llave
            ? <span className="italic" style={tenue}>leído: {llave}</span>
            : <span style={tenue}>—</span>}
      </td>
      <td className={`${td} whitespace-nowrap`} style={secundario}>{pesosComprobante(c.valor)}</td>
      <td className={td}>
        <StatusChip tone={TONO_ESTADO[c.estado]}>{ROTULO_ESTADO[c.estado]}</StatusChip>
        <span className="block max-w-[13rem] text-xs" style={tenue}>{textoEstado(c)}</span>
      </td>
      <td className={`${td} text-right`}>
        {puedeVer && (
          <button className={flitBtnSecondarySm} style={flitBtnSecondaryStyle} aria-label={`Ver ${nombreConPaginas}`} onClick={() => onVer(c.id)}>
            Ver
          </button>
        )}
      </td>
    </FlitTr>
  );
}

/** Segundo renglón de Estado (§5.2): motivo del pendiente, quién/cuándo aplicó, o cuándo se descartó. */
function textoEstado(c: ComprobanteListaDto): string {
  if (c.estado === 'pendiente') return c.detallePendiente ?? (c.motivoPendiente ? MOTIVO_PENDIENTE_COMPROBANTE_LABEL[c.motivoPendiente] : '');
  if (c.estado === 'aplicado') {
    const cuando = c.aplicadoEn ? fechaCarga(c.aplicadoEn) : '';
    return c.aplicadoAutomaticamente ? `automático · ${cuando}` : `por ${c.aplicadoPorNombre ?? '—'} · ${cuando}`;
  }
  return c.descartadoEn ? fechaCarga(c.descartadoEn) : '';
}
