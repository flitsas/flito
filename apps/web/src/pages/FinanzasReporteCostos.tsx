// Finanzas — Reporte de costos. Cada fila muestra los valores SELLADOS si el trámite está
// liquidado, o un ESTIMADO en vivo si no. La distinción se pinta, porque un estimado puede cambiar
// mañana y un sellado no. Rol `financiera` (+ admin/auditor, este último en solo lectura).

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { hasPage } from '../lib/permissions';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import FlitModal from '../components/flit/FlitModal';
import StatusChip from '../components/flit/StatusChip';
import RangoFechas from '../components/flit/RangoFechas';
import { CeldaTramite, CeldaVehiculo, CeldaFechas, ENCABEZADOS_COMUNES } from '../components/flit/columnasComunes';
import VisorSoportes from '../components/flit/VisorSoportes';
import ContadoresFacturacion from '../components/finanzas/ContadoresFacturacion';
import CeldaFacturacion from '../components/finanzas/CeldaFacturacion';
import MarcaSoatConciliado from '../components/finanzas/MarcaSoatConciliado';
import FichaFacturacion from '../components/finanzas/FichaFacturacion';
import TarjetaEnvioFacturacion from '../components/finanzas/TarjetaEnvioFacturacion';
import AccionEnviarFactura from '../components/finanzas/AccionEnviarFactura';
import DialogoEnvioFacturacion, { type TramiteDelEnvio } from '../components/finanzas/DialogoEnvioFacturacion';
import { useElegibilidadFacturacion } from '../components/finanzas/useElegibilidadFacturacion';
import type { FacturacionTramite, ResumenFacturacion } from '../components/finanzas/tiposFacturacion';
import {
  puedeEjecutar,
  type MotivoElegibilidad, type SiigoEnvioTramite, type SiigoEstadoReporte, type SiigoResumenEnvio,
} from '@operaciones/shared-types';
import {
  FlitCard, FlitTable, FlitTh, FlitTr, FlitEmpty, flitInp, FlitPillGroup, flitPillBtn,
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';

interface Fila {
  tramiteId: string; idFlit: string; placa: string | null; estado: string | null; empresa: string | null;
  vin: string | null; marca: string | null; linea: string | null;
  tipoTramite: string | null; fechaAprobacion: string | null; fechaCreacion: string | null;
  soat: number | null; impuesto: number | null; derechoTramite: number | null;
  logistica: number | null; tramiteDigital: number | null; gmf: number | null; total: number | null;
  sellada: boolean;
  estadoLiquidacion: 'liquidado' | 'facturado' | null;
  noConfigurados: string[];
  /** Conceptos que esperan su documento pagado, no una tarifa. Hoy solo el derecho de tránsito. */
  sinRecibo: string[];
  /** Los que FLITO gestiona y aún no tienen valor pagado (SOAT, impuesto). Bloquean la liquidación. */
  pendientesPago: string[];
  /** Los que la compañía se gestiona sola: no se cobran ni se esperan. */
  autogestionados: string[];
  /** Los que no aplican por el organismo, no por la compañía. Hoy solo el impuesto. */
  noAplican: string[];
  /**
   * Facturación electrónica de la fila. **El servidor ya las mandaba** (`FilaReporte extends
   * FacturacionDeFila`) y esta interfaz no las declaraba, así que la columna «Factura DIAN» solo
   * podía apoyarse en el mapa de fichas —que por diseño únicamente devuelve trámites CON factura— y
   * un trámite recién encolado se seguía pintando «—» (HU #11329).
   */
  estadoFacturacion: SiigoEstadoReporte;
  facturaNumero: string | null;
  facturaRequiereRevision: boolean;
  /**
   * Conciliación del SOAT de la fila (HU #11679, Feature #11623). El servidor ya las manda en cada
   * fila; declararlas aquí es lo que permite marcarlo en pantalla.
   *
   * No hay un cuarto campo con el NOMBRE DEL ARCHIVO de la boleta y no es un olvido: es el
   * `originalname` de multer —texto libre— y una boleta agrupa SOAT de varios trámites, así que
   * podría arrastrar la placa de un tercero a un reporte que `auditor` lee sin registro de acceso.
   * La referencia identifica la boleta igual de bien y no es PII.
   */
  soatConciliado: boolean;
  boletaReferencia: string | null;
  soatConciliadoEn: string | null;
}
interface Totales {
  soat: number; impuesto: number; derechoTramite: number; logistica: number; tramiteDigital: number;
  gmf: number; total: number; filasIncompletas: number;
}
interface Resumen { listo: number; incompleto: number; porFacturar: number; facturado: number }
interface Reporte {
  items: Fila[]; total: number; page: number; pageSize: number; totales: Totales; resumen: Resumen;
}
interface Facetas { estados: string[]; empresas: { valor: string; nombre: string }[]; tipos: string[] }
const pesos = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });

/**
 * Estado con el que arranca el reporte. Cerrar el mes se hace sobre lo aprobado, así que ese es el
 * punto de partida útil; los demás estados siguen a un clic en las pastillas.
 */
const ESTADO_POR_DEFECTO = 'Aprobado';

/**
 * Etiquetas de los conceptos. Se usan para el encabezado Y para cruzar con `noConfigurados`,
 * `sinRecibo`, `pendientesPago` y `autogestionados`, para que el rótulo de la columna y el motivo
 * de la ausencia no puedan divergir.
 */
const CONCEPTO = {
  soat: 'SOAT', impuesto: 'Impuesto', derecho: 'Derecho de tránsito',
  digital: 'Trámite digital', logistica: 'Logística',
} as const;

/**
 * En qué punto del cobro está el trámite. Es EL filtro de esta pantalla, así que se pide con un
 * clic y no combinando dos desplegables: antes, «lo que ya se puede liquidar» —la pregunta con la
 * que se entra aquí— no se podía pedir de ninguna manera, y «liquidado» y «facturado» eran dos
 * selectores independientes que permitían pedir combinaciones imposibles.
 *
 * Las cuatro etapas son excluyentes y cubren todo: cada trámite está en una y solo una.
 */
type Etapa = '' | 'listo' | 'incompleto' | 'por_facturar' | 'facturado';

const ETAPAS: Array<{ v: Etapa; label: string; ayuda: string; cuenta?: (r: Resumen) => number }> = [
  { v: '', label: 'Todos', ayuda: 'Todos los trámites del filtro, en cualquier etapa.' },
  {
    v: 'listo', label: 'Listos para liquidar', cuenta: (r) => r.listo,
    ayuda: 'Sin liquidar y con SOAT, impuesto, derecho de tránsito, logística y trámite digital resueltos —saltando los que la compañía autogestiona—. Se pueden sellar ya.',
  },
  {
    v: 'incompleto', label: 'Incompletos', cuenta: (r) => r.incompleto,
    ayuda: 'Sin liquidar porque falta una tarifa, un recibo o un pago. Cada fila dice qué.',
  },
  {
    v: 'por_facturar', label: 'Por facturar', cuenta: (r) => r.porFacturar,
    ayuda: 'Liquidados con valores ya sellados, todavía sin facturar.',
  },
  { v: 'facturado', label: 'Facturados', cuenta: (r) => r.facturado, ayuda: 'Ya facturados.' },
];

/**
 * Un concepto sin valor no siempre significa lo mismo, y decir lo que no es hace daño. Cinco casos:
 *
 *   falta = 'tarifa' → no hay tarifa negociada con la compañía. Se arregla en Clientes y
 *                      proveedores. Solo aplica a logística y trámite digital, que son honorarios
 *                      de FLITO y se pactan cliente a cliente.
 *   falta = 'recibo' → falta el DOCUMENTO pagado. Es el caso del derecho de tránsito, que no se
 *                      configura en ninguna pantalla: se lee del recibo, igual que el SOAT y el
 *                      impuesto. Decirle «no configurado» mandaba a buscar una parametrización
 *                      inexistente.
 *   falta = 'pago'   → FLITO lo gestiona para esta compañía y aún no tiene valor pagado (SOAT,
 *                      impuesto). No hay nada que configurar: hay que empujar o esperar el pago.
 *   falta = 'auto'   → la compañía se lo gestiona por su cuenta. No es una ausencia: FLITO no lo
 *                      cobra. Se dice, porque un guion se leía como «falta algo».
 *   falta = 'nada'   → no aplica porque el ORGANISMO no entrega ese concepto en gestión. Se
 *                      distingue de 'auto' porque no es una decisión del cliente.
 *   sin falta        → no aplica a este trámite. Un guion, porque no hay nada que hacer.
 *
 * En ningún caso se pinta «$ 0»: un cero se suma en la cabeza de quien lee.
 */
type Falta = 'tarifa' | 'recibo' | 'pago' | 'auto' | 'nada';
const TEXTO_FALTA: Record<Falta, string> = {
  tarifa: 'No configurado', recibo: 'Sin recibo', pago: 'Sin pagar',
  auto: 'Autogestiona', nada: 'No aplica',
};

/**
 * Alto común de los controles del filtro. Va en estilo y no en clase porque `flitInp` ya trae su
 * relleno vertical: dos utilidades peleando por la misma propiedad se resuelven por el orden de la
 * hoja, no por el del atributo, y la fila quedaba desalineada a capricho del build.
 */
const ALTO_CONTROL = { height: 40, paddingTop: 0, paddingBottom: 0 } as const;

/**
 * Todo lo que le impide liquidarse, en una sola lista. A quien mira la fila le da igual si lo que
 * falta es una tarifa, un recibo o un pago: lo que necesita saber es qué tiene que resolver.
 */
const faltantes = (f: Fila): string[] => [...f.noConfigurados, ...f.sinRecibo, ...f.pendientesPago];

/** Por qué está vacía la celda de este concepto, si es que lo está. El backend ya lo decidió. */
function faltaDe(f: Fila, concepto: string): Falta | undefined {
  if (f.noConfigurados.includes(concepto)) return 'tarifa';
  if (f.sinRecibo.includes(concepto)) return 'recibo';
  if (f.pendientesPago.includes(concepto)) return 'pago';
  if (f.autogestionados.includes(concepto)) return 'auto';
  if (f.noAplican.includes(concepto)) return 'nada';
  return undefined;
}

function Monto({ v, falta, negrita }: { v: number | null; falta?: Falta; negrita?: boolean }) {
  if (v === null) {
    return (
      <span className="text-xs italic" style={{ color: 'var(--flit-text-muted)' }}>
        {falta ? TEXTO_FALTA[falta] : '—'}
      </span>
    );
  }
  return <span className={negrita ? 'font-semibold' : undefined}>{pesos(v)}</span>;
}

export default function FinanzasReporteCostos() {
  const { user } = useAuth();
  // Auditoría observa la conciliación; no la ejecuta.
  const puedeLiquidar = user?.role === 'admin' || user?.role === 'financiera';
  const puedeReversar = user?.role === 'admin';
  // LA MISMA tabla que usa el servidor para decidir el 403 (HU #11329), no `puedeLiquidar`: hoy
  // resuelven a la misma lista, pero son dos definiciones de cosas distintas, y el día que
  // `ROLES_POR_ACCION.emitir` cambie la pantalla ofrecería un botón que el servidor rechaza.
  const puedeEmitir = puedeEjecutar(user?.role, 'emitir');
  const puedeReactivar = puedeEjecutar(user?.role, 'reactivar');

  const [data, setData] = useState<Reporte | null>(null);
  const [facetas, setFacetas] = useState<Facetas | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);
  const [enProceso, setEnProceso] = useState(false);
  const [soportesDe, setSoportesDe] = useState<Fila | null>(null);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());

  // Facturación electrónica (HU #11337). Se carga aparte del reporte a propósito: si un fallo del
  // módulo de Siigo tumbara la carga del reporte, quien viene a conciliar costos se quedaría sin la
  // pantalla entera por algo que no necesitaba para conciliar.
  const [resumenFe, setResumenFe] = useState<ResumenFacturacion | null>(null);
  const [feCargando, setFeCargando] = useState(true);
  const [feError, setFeError] = useState<string | null>(null);
  const [fichasFe, setFichasFe] = useState<Map<string, FacturacionTramite>>(new Map());
  const [estadoFe, setEstadoFe] = useState<SiigoEstadoReporte | null>(null);
  const [fichaAbierta, setFichaAbierta] = useState<{ ficha: FacturacionTramite; idFlit: string } | null>(null);

  // Envío a facturación electrónica (HU #11329).
  const [envio, setEnvio] = useState<{
    tramites: TramiteDelEnvio[]; excluidos: (TramiteDelEnvio & { motivos: MotivoElegibilidad[] })[];
  } | null>(null);
  /**
   * El parche local del AC5: en cuanto llega el 202, las filas encoladas se pintan «En cola» sin
   * recargar. No es una regla inventada — es el mismo valor que `EXPR_ENCOLADO` devolverá en la
   * siguiente carga— y se vacía cuando llegan datos nuevos, que son los que mandan.
   */
  const [parcheFe, setParcheFe] = useState<Map<string, SiigoEstadoReporte>>(new Map());
  /** Lo que salva a quien cerró el diálogo sin leerlo. */
  const [anuncio, setAnuncio] = useState('');
  const tarjetaEnvioRef = useRef<HTMLHeadingElement>(null);

  const [buscar, setBuscar] = useState('');
  const [empresa, setEmpresa] = useState('');
  const [tipo, setTipo] = useState('');
  const [etapa, setEtapa] = useState<Etapa>('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [aprobadoDesde, setAprobadoDesde] = useState('');
  const [aprobadoHasta, setAprobadoHasta] = useState('');
  const [estados, setEstados] = useState<string[]>([ESTADO_POR_DEFECTO]);
  const [docCompleta, setDocCompleta] = useState(false);
  const [page, setPage] = useState(1);

  const estadosKey = estados.join(',');

  const params = () => {
    const p = new URLSearchParams();
    if (buscar.trim()) p.set('buscar', buscar.trim());
    if (empresa) p.set('empresas', empresa);
    if (tipo) p.set('tipos', tipo);
    if (etapa) p.set('etapa', etapa);
    if (desde) p.set('desde', desde);
    if (hasta) p.set('hasta', hasta);
    if (aprobadoDesde) p.set('aprobadoDesde', aprobadoDesde);
    if (aprobadoHasta) p.set('aprobadoHasta', aprobadoHasta);
    if (estados.length) p.set('estados', estados.join(','));
    if (docCompleta) p.set('documentacionCompleta', 'si');
    if (estadoFe) p.set('estadoFacturacion', estadoFe);
    return p;
  };

  const limpiarFiltros = () => {
    setBuscar(''); setEmpresa(''); setTipo(''); setEtapa('');
    setDesde(''); setHasta(''); setAprobadoDesde(''); setAprobadoHasta('');
    setDocCompleta(false);
    setEstadoFe(null);
    // Vuelve al punto de partida del reporte, no a «todos los estados»: quien limpia quiere el
    // estado inicial de la pantalla, y ese es Aprobado.
    setEstados([ESTADO_POR_DEFECTO]);
  };

  const hayFiltros = estadoFe !== null || buscar !== '' || empresa !== '' || tipo !== '' || etapa !== '' || docCompleta
    || desde !== '' || hasta !== '' || aprobadoDesde !== '' || aprobadoHasta !== ''
    || estadosKey !== ESTADO_POR_DEFECTO;

  useEffect(() => { setPage(1); setSeleccion(new Set()); }, [buscar, empresa, tipo, etapa, desde, hasta, aprobadoDesde, aprobadoHasta, estadosKey, docCompleta, estadoFe]);

  useEffect(() => {
    setError(null);
    const p = params();
    p.set('page', String(page));
    api.get<Reporte>(`/finanzas/reporte-costos?${p.toString()}`)
      // El parche local se descarta con los datos nuevos: mandan los del servidor. Si la recarga
      // falla, el parche sobrevive — el servidor ya había afirmado que quedó encolado.
      .then((r) => { setData(r); setParcheFe(new Map()); })
      .catch((e) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buscar, empresa, tipo, etapa, desde, hasta, aprobadoDesde, aprobadoHasta, estadosKey, docCompleta, estadoFe, page, recarga]);

  // Los contadores. Mismo filtro que la tabla salvo el propio estado, que lo excluye el servidor.
  useEffect(() => {
    setFeCargando(true);
    setFeError(null);
    api.get<ResumenFacturacion>(`/finanzas/reporte-costos/facturacion-electronica?${params().toString()}`)
      .then(setResumenFe)
      .catch((e) => { setResumenFe(null); setFeError(errorMessage(e)); })
      .finally(() => setFeCargando(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buscar, empresa, tipo, etapa, desde, hasta, aprobadoDesde, aprobadoHasta, estadosKey, docCompleta, estadoFe, recarga]);

  // La ficha de los trámites de ESTA página. Por lote y no una petición por fila: doscientas
  // peticiones para dibujar una tabla las encolaría el navegador de seis en seis.
  useEffect(() => {
    const ids = (data?.items ?? []).map((f) => f.tramiteId);
    if (ids.length === 0) { setFichasFe(new Map()); return; }
    // `URLSearchParams` y no interpolar: los identificadores vienen del servidor y hoy son UUID,
    // pero el día que ese campo cambie de forma, un `&` o un `#` sueltos partirían la consulta en
    // dos parámetros. Escapar aquí cuesta nada; descubrirlo después, una tarde.
    api.get<{ items: FacturacionTramite[] }>(
      `/siigo/facturacion/tramites?${new URLSearchParams({ ids: ids.join(',') }).toString()}`)
      .then((r) => setFichasFe(new Map(r.items.map((i) => [i.tramiteId, i]))))
      // Un fallo aquí NO rompe el reporte: las filas se pintan sin la columna de facturación, que
      // es información añadida y no el motivo por el que alguien abrió esta pantalla.
      .catch(() => setFichasFe(new Map()));
  }, [data]);

  useEffect(() => { api.get<Facetas>('/finanzas/reporte-costos/facetas').then(setFacetas).catch(() => setFacetas(null)); }, []);

  const filas = data?.items ?? [];
  const totalPaginas = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const refrescar = () => setRecarga((n) => n + 1);

  /** Solo se puede liquidar lo que no está liquidado y tiene todos sus conceptos resueltos. */
  // Ni sin tarifa, ni sin recibo, ni sin pagar: la primera congelaría un cobro inventado, la
  // segunda un total al que le falta un costo que existe, y la tercera un cobro que aún no ocurrió.
  // Es la misma condición que exige el backend al sellar: si aquí faltara una, el botón se ofrecería
  // activo para fallar al pulsarlo.
  const liquidable = (f: Fila) => !f.sellada && faltantes(f).length === 0;

  // ── Envío a facturación electrónica (HU #11329) ───────────────────────────

  const estadoFeDe = (f: Fila) => parcheFe.get(f.tramiteId) ?? f.estadoFacturacion;
  /**
   * Sobre quién tiene sentido PREGUNTAR. No decide elegibilidad —eso solo lo dice el servidor—:
   * decide el universo al que la acción aplica.
   *
   * `estadoLiquidacion === 'facturado'` es literalmente la misma columna que lee `motivosLocales()`
   * en el servidor, no una regla paralela que se le parezca. `encolado` se descuenta aparte y solo
   * él: es el único estado en el que hay trabajo en marcha y el servidor seguiría diciendo
   * «elegible», así que ofrecer el botón invitaría a pulsar sobre algo que ya está en curso — que es
   * justo lo que el AC6 evita. Los demás estados siguen pasando por el veredicto del servidor, que
   * los rechaza con su motivo (`ya_facturado`) cuando hay factura viva.
   */
  const esCandidato = (f: Fila) => f.estadoLiquidacion === 'facturado' && estadoFeDe(f) !== 'encolado';
  const candidatos = filas.filter(esCandidato);

  // La MISMA clave de invalidación que el reporte: cambiar de filtro, de página o recargar vacía
  // los veredictos guardados.
  const claveVista = [buscar, empresa, tipo, etapa, desde, hasta, aprobadoDesde, aprobadoHasta,
    estadosKey, docCompleta, estadoFe, page, recarga].join('|');
  const elegibilidad = useElegibilidadFacturacion(
    candidatos.map((f) => f.tramiteId), puedeEmitir, claveVista);

  const esElegible = (f: Fila) => elegibilidad.veredictos.get(f.tramiteId)?.elegible === true;
  /** Lo accionable de la página: lo liquidable y lo que puede irse a facturación. */
  const accionable = (f: Fila) => liquidable(f) || (puedeEmitir && esCandidato(f));
  const accionables = filas.filter(accionable);
  const seleccionados = filas.filter((f) => seleccion.has(f.tramiteId));
  /**
   * Los dos conjuntos son **disjuntos por construcción**: `liquidable` exige `!sellada` y ser
   * candidato exige `estadoLiquidacion === 'facturado'`, que implica `sellada`. Ninguna fila cuenta
   * en los dos números, y por eso una sola selección puede servir a dos acciones sin ambigüedad.
   */
  const liquidablesSel = seleccionados.filter(liquidable);
  const enviablesSel = seleccionados.filter((f) => esCandidato(f) && esElegible(f));
  const enviablesPagina = candidatos.filter(esElegible);
  const conSeleccion = puedeEmitir && enviablesSel.length > 0;

  // A4 — el diálogo agrupa por empresa para preguntar la emisión una vez por cliente, así que
  // necesita saber de quién es cada trámite. El id lo trae el veredicto de elegibilidad, que ya lo
  // resolvió; el nombre, la fila. Preguntarlo otra vez sería una consulta de más.
  const deEnvio = (f: Fila): TramiteDelEnvio => ({
    tramiteId: f.tramiteId,
    idFlit: f.idFlit,
    clienteId: elegibilidad.veredictos.get(f.tramiteId)?.companiaId ?? null,
    empresa: f.empresa,
  });

  /** Abre el diálogo con los elegibles del conjunto y, plegado, el porqué de los que se quedan. */
  const abrirEnvio = (conjunto: Fila[]) => setEnvio({
    tramites: conjunto.filter(esElegible).map(deEnvio),
    excluidos: conjunto.filter((f) => !esElegible(f)).map((f) => ({
      ...deEnvio(f), motivos: elegibilidad.veredictos.get(f.tramiteId)?.motivos ?? [],
    })),
  });

  const marcarEncolados = (items: SiigoEnvioTramite[]) => setParcheFe((m) => {
    const n = new Map(m);
    // `ya_en_cola` también: lo estaban ya, y la fila lo estaba pintando mal.
    for (const i of items) {
      if (i.resultado === 'encolado' || i.resultado === 'reactivado' || i.resultado === 'ya_en_cola') {
        n.set(i.tramiteId, 'encolado');
      }
    }
    return n;
  });

  const cerrarEnvio = (resumen: SiigoResumenEnvio | null) => {
    const enviados = envio?.tramites.map((t) => t.tramiteId) ?? [];
    setEnvio(null);
    if (resumen) {
      setAnuncio(`${resumen.encolados} trámite(s) quedaron en cola. ${resumen.rechazados} no se pudieron enviar.`);
      setSeleccion((s) => new Set([...s].filter((id) => !enviados.includes(id))));
      // «Sin recargar» es sin `window.location.reload`: la tabla se repinta con datos nuevos.
      refrescar();
    }
    // `useFocusTrap` devuelve el foco al disparador; si esa fila ya no existe —se fue a «En cola»
    // con el filtro «Por facturar» puesto—, `focus()` sobre un nodo desmontado deja el foco en
    // `<body>`. Se rescata al encabezado de la tarjeta de envío.
    setTimeout(() => {
      if (document.activeElement === document.body) tarjetaEnvioRef.current?.focus();
    }, 0);
  };

  const ejecutar = async (fn: () => Promise<string>) => {
    setEnProceso(true); setError(null); setAviso(null);
    try { setAviso(await fn()); refrescar(); setSeleccion(new Set()); }
    catch (e) { setError(errorMessage(e)); }
    finally { setEnProceso(false); }
  };

  const liquidarUno = (f: Fila) => ejecutar(async () => {
    await api.post(`/flito/liquidacion/${f.tramiteId}/liquidar`, {});
    return `${f.idFlit} liquidado.`;
  });

  // Solo los LIQUIDABLES de la selección, no `[...seleccion]` entero. Desde que la casilla también
  // se pinta en los trámites `facturado` (HU #11329), mandar la selección completa enviaría a
  // liquidar cosas ya selladas — que el backend rechaza, y con razón.
  const liquidarLote = () => ejecutar(async () => {
    const r = await api.post<{ liquidados: string[]; fallidos: { motivo: string }[] }>(
      '/flito/liquidacion/lote/liquidar', { tramiteIds: liquidablesSel.map((f) => f.tramiteId) });
    return `${r.liquidados.length} liquidados, ${r.fallidos.length} sin liquidar.`;
  });

  const facturarUno = (f: Fila) => ejecutar(async () => {
    await api.post(`/flito/liquidacion/${f.tramiteId}/facturar`, {});
    return `${f.idFlit} marcado como facturado.`;
  });

  const reversarUno = (f: Fila, motivo: string) => ejecutar(async () => {
    await api.post(`/flito/liquidacion/${f.tramiteId}/reversar`, { motivo });
    return `Liquidación de ${f.idFlit} reversada.`;
  });

  const exportar = () => {
    // La exportación cubre TODO el filtro, no la página: se abre en una pestaña para que el
    // navegador gestione la descarga con su propio indicador de progreso.
    window.open(`/api/finanzas/reporte-costos/export?${params().toString()}`, '_blank');
  };

  return (
    <div className="space-y-4">
      <PageHeaderCard title="Reporte de costos"
        subtitle="Costos reales por trámite. Las filas liquidadas muestran valores sellados; el resto, un estimado con las tarifas vigentes."
        actions={<button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={exportar}>Exportar CSV</button>} />

      {/* Dos líneas y se acabó: arriba EN QUÉ punto del cobro está el trámite —que es a lo que se
          entra— y abajo sobre QUÉ trámites, cada control del mismo alto y en su columna. Antes eran
          cuatro bandas sueltas, dos de ellas con desplegables que decían lo mismo de dos maneras. */}
      <FlitCard className="!p-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <FlitPillGroup>
            {ETAPAS.map((e) => (
              <button key={e.v} type="button" title={e.ayuda} onClick={() => setEtapa(e.v)}
                aria-pressed={etapa === e.v}
                className="flit-focus inline-flex items-center gap-2 rounded-[999px] px-4 py-2 text-xs font-semibold transition-colors"
                style={flitPillBtn(etapa === e.v)}>
                {e.label}
                {/* El número decide a dónde ir: sin él hay que entrar en cada pestaña para ver si
                    tiene trabajo dentro. Cuenta con los demás filtros puestos, no sobre todo. */}
                {data && e.cuenta && (
                  <span className="rounded-[999px] px-1.5 py-0.5 text-[10px] tabular-nums"
                    style={{ background: 'var(--flit-bg-app)', color: 'var(--flit-text-secondary)' }}>
                    {e.cuenta(data.resumen).toLocaleString('es-CO')}
                  </span>
                )}
              </button>
            ))}
          </FlitPillGroup>

          <label className="flex cursor-pointer items-center gap-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}
            title="Con soporte cargado de SOAT, impuesto, derecho y logística — saltando los que la compañía autogestiona.">
            <input type="checkbox" checked={docCompleta} onChange={(e) => setDocCompleta(e.target.checked)} />
            Solo con soportes completos
          </label>

          {/* Solo `ml-auto`: el tamaño se queda el del botón secundario de siempre. Recortarlo con
              clases sueltas (h-8, text-xs) es apostar a qué utilidad de Tailwind gana en la hoja. */}
          <button className={`${flitBtnSecondary} ml-auto`} style={flitBtnSecondaryStyle}
            disabled={!hayFiltros} onClick={limpiarFiltros}>Limpiar filtros</button>
        </div>

        {/* Cada filtro en su columna y del mismo alto. Los dos rangos son independientes y van
            rotulados: «desde/hasta» a secas, con dos fechas en juego, no dice sobre cuál filtra. */}
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <input className={flitInp} style={ALTO_CONTROL} placeholder="Placa, VIN o trámite FLIT…"
            aria-label="Buscar" value={buscar} onChange={(e) => setBuscar(e.target.value)} />
          <select className={flitInp} style={ALTO_CONTROL} aria-label="Empresa" value={empresa} onChange={(e) => setEmpresa(e.target.value)}>
            <option value="">Todas las empresas</option>
            {facetas?.empresas.map((e) => <option key={e.valor} value={e.valor}>{e.nombre}</option>)}
          </select>
          <select className={flitInp} style={ALTO_CONTROL} aria-label="Tipo de trámite" value={tipo} onChange={(e) => setTipo(e.target.value)}>
            <option value="">Todos los tipos</option>
            {facetas?.tipos.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <FiltroEstados opciones={facetas?.estados ?? []} seleccion={estados} onCambio={setEstados} />
          <RangoFechas etiqueta="Creación" valor={{ desde, hasta }}
            onCambio={(r) => { setDesde(r.desde); setHasta(r.hasta); }} />
          <RangoFechas etiqueta="Aprobación" valor={{ desde: aprobadoDesde, hasta: aprobadoHasta }}
            onCambio={(r) => { setAprobadoDesde(r.desde); setAprobadoHasta(r.hasta); }} />
        </div>
      </FlitCard>

      {/* HU #11337 — los contadores van DEBAJO de los filtros y ENCIMA de la tabla: cuentan sobre lo
          que los filtros dejan y describen lo que se ve abajo, así que su sitio es entre los dos. */}
      <ContadoresFacturacion
        resumen={resumenFe}
        cargando={feCargando}
        error={feError}
        seleccionado={estadoFe}
        onSeleccionar={setEstadoFe}
        onReintentar={() => setRecarga((n) => n + 1)}
      />

      {error && <FlitCard><p className="text-sm text-red-600">{error}</p></FlitCard>}
      {aviso && <FlitCard><p className="text-sm" style={{ color: 'var(--flit-blue-text)' }}>{aviso}</p></FlitCard>}

      {/* Un total al que le faltan conceptos no puede pasar por completo. Va en una línea y con la
          salida puesta: el aviso servía de poco si para ver esos trámites había que ir a armar el
          filtro a mano. */}
      {data && data.totales.filasIncompletas > 0 && (
        <FlitCard className="!p-3">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span>
              El total mostrado está incompleto:{' '}
              <strong>{data.totales.filasIncompletas.toLocaleString('es-CO')}</strong> de{' '}
              <strong>{data.total.toLocaleString('es-CO')}</strong> trámites tienen algún concepto
              sin resolver.
            </span>
            {etapa !== 'incompleto' && (
              <button type="button" className="text-sm font-semibold underline"
                style={{ color: 'var(--flit-blue-text)' }} onClick={() => setEtapa('incompleto')}>
                Ver cuáles
              </button>
            )}
          </p>
        </FlitCard>
      )}

      {/* La barra dice cuántos de los seleccionados sirven para cada acción ANTES de pulsar nada
          (AC3): con dos acciones sobre una misma selección, «14 seleccionados» a secas no dice
          cuántos van a moverse. */}
      {puedeLiquidar && seleccion.size > 0 && (
        <FlitCard>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-semibold">
              {seleccion.size} seleccionado(s) · {liquidablesSel.length} se pueden liquidar
              {puedeEmitir && ` · ${enviablesSel.length} se pueden enviar a facturación electrónica`}
            </span>
            <button className={flitBtnPrimary} style={flitBtnPrimaryStyle}
              disabled={enProceso || liquidablesSel.length === 0} onClick={liquidarLote}>
              {enProceso ? 'Liquidando…' : `Liquidar ${liquidablesSel.length}`}
            </button>
            {conSeleccion && (
              <button className={flitBtnPrimary} style={flitBtnPrimaryStyle}
                onClick={() => abrirEnvio(seleccionados.filter(esCandidato))}>
                Enviar {enviablesSel.length} a facturación electrónica
              </button>
            )}
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setSeleccion(new Set())}>Quitar selección</button>
          </div>
        </FlitCard>
      )}

      {/* La tarjeta de envío NO se monta para quien no puede emitir: al `auditor` el estado ya se lo
          dan los contadores, la columna y la ficha; esto es el envoltorio de la acción. */}
      {puedeEmitir && filas.length > 0 && (
        <TarjetaEnvioFacturacion
          cargando={elegibilidad.cargando}
          error={elegibilidad.error}
          onReintentar={elegibilidad.reintentar}
          filas={filas.length}
          candidatos={candidatos.length}
          resumen={elegibilidad.resumen}
          elegibles={conSeleccion ? enviablesSel.length : enviablesPagina.length}
          universo={conSeleccion ? seleccion.size : candidatos.length}
          deLaSeleccion={conSeleccion}
          onEnviar={() => abrirEnvio(conSeleccion ? seleccionados.filter(esCandidato) : candidatos)}
          onVerPorFacturar={() => setEtapa('por_facturar')}
          puedeVerConfiguracion={hasPage(user, 'siigo_parametrizacion')}
          tituloRef={tarjetaEnvioRef}
        />
      )}

      {/* Lo que salva a quien cerró el diálogo sin leerlo. */}
      <p className="sr-only" role="status" aria-live="polite">{anuncio}</p>

      {data && filas.length === 0 && <FlitCard><FlitEmpty>No hay trámites que coincidan con los filtros.</FlitEmpty></FlitCard>}

      {filas.length > 0 && (
        <FlitCard>
          <div className="mb-3"><Paginacion total={data!.total} page={data!.page} totalPaginas={totalPaginas} onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} /></div>
          <div className="overflow-x-auto">
            <FlitTable>
              <thead>
                <FlitTr>
                  {puedeLiquidar && (
                    <FlitTh>
                      {/* Selecciona TODO lo accionable de la página, no solo lo liquidable: desde
                          la HU #11329 hay dos acciones sobre la selección. */}
                      <input type="checkbox" aria-label="Seleccionar los trámites con acciones de esta página"
                        checked={accionables.length > 0 && accionables.every((f) => seleccion.has(f.tramiteId))}
                        onChange={(e) => setSeleccion(e.target.checked ? new Set(accionables.map((f) => f.tramiteId)) : new Set())} />
                    </FlitTh>
                  )}
                  {ENCABEZADOS_COMUNES.map((h) => <FlitTh key={h}>{h}</FlitTh>)}
                  <FlitTh>Liquidación</FlitTh>
                  <FlitTh center>{CONCEPTO.soat}</FlitTh>
                  <FlitTh center>{CONCEPTO.impuesto}</FlitTh>
                  <FlitTh center>{CONCEPTO.derecho}</FlitTh>
                  <FlitTh center>{CONCEPTO.logistica}</FlitTh>
                  <FlitTh center>{CONCEPTO.digital}</FlitTh>
                  <FlitTh center>GMF</FlitTh>
                  <FlitTh center>Total</FlitTh>
                  <FlitTh center>Factura DIAN</FlitTh>
                  <FlitTh />
                </FlitTr>
              </thead>
              <tbody>
                {filas.map((f) => (
                  <FlitTr key={f.tramiteId}>
                    {puedeLiquidar && (
                      <td className="px-3 py-2">
                        {/* Sin casilla en las filas sobre las que no hay ninguna acción. No es un
                            hueco: es que ahí no hay nada que marcar. */}
                        {accionable(f) && (
                          <input type="checkbox" aria-label={`Seleccionar ${f.idFlit}`}
                            checked={seleccion.has(f.tramiteId)}
                            onChange={() => setSeleccion((s) => {
                              const n = new Set(s);
                              if (n.has(f.tramiteId)) n.delete(f.tramiteId); else n.add(f.tramiteId);
                              return n;
                            })} />
                        )}
                      </td>
                    )}
                    <CeldaTramite idFlit={f.idFlit} tipoTramite={f.tipoTramite} extra={f.empresa} />
                    <CeldaVehiculo placa={f.placa} vin={f.vin} marca={f.marca} linea={f.linea} />
                    <CeldaFechas creado={f.fechaCreacion} aprobado={f.fechaAprobacion} />
                    <td className="px-4 py-2 whitespace-nowrap">
                      {f.estadoLiquidacion === 'facturado'
                        ? <StatusChip tone="success">Facturado</StatusChip>
                        : f.sellada
                          ? <StatusChip tone="active">Liquidado</StatusChip>
                          : <StatusChip tone="draft">Estimado</StatusChip>}
                    </td>
                    {/* SOAT e impuesto nunca entran en `noConfigurados`: no hay tarifa que
                        configurar. Su celda vacía puede ser un pago pendiente, una compañía que los
                        autogestiona o un trámite exento, y cada una se dice con su nombre. */}
                    <td className="px-4 py-2 text-right tabular-nums">
                      <Monto v={f.soat} falta={faltaDe(f, CONCEPTO.soat)} />
                      {/* Debajo del valor, y solo si está conciliado: el componente no pinta nada
                          —ni un hueco— cuando no lo está, así que la fila de siempre no cambia. */}
                      <MarcaSoatConciliado conciliado={f.soatConciliado} referencia={f.boletaReferencia}
                        conciliadoEn={f.soatConciliadoEn} />
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums"><Monto v={f.impuesto} falta={faltaDe(f, CONCEPTO.impuesto)} /></td>
                    <td className="px-4 py-2 text-right tabular-nums"><Monto v={f.derechoTramite} falta={faltaDe(f, CONCEPTO.derecho)} /></td>
                    <td className="px-4 py-2 text-right tabular-nums"><Monto v={f.logistica} falta={faltaDe(f, CONCEPTO.logistica)} /></td>
                    <td className="px-4 py-2 text-right tabular-nums"><Monto v={f.tramiteDigital} falta={faltaDe(f, CONCEPTO.digital)} /></td>
                    <td className="px-4 py-2 text-right tabular-nums"><Monto v={f.gmf} /></td>
                    <td className="px-4 py-2 text-right tabular-nums" style={{ color: 'var(--flit-blue-text)' }}><Monto v={f.total} negrita /></td>
                    <td className="px-3 py-2 text-center">
                      <CeldaFacturacion ficha={fichasFe.get(f.tramiteId)} estadoFila={estadoFeDe(f)}
                        onAbrir={(ficha) => setFichaAbierta({ ficha, idFlit: f.idFlit })} />
                    </td>
                    <td className="px-3 py-2">
                      <Acciones fila={f} puedeLiquidar={puedeLiquidar} puedeReversar={puedeReversar} enProceso={enProceso}
                        onLiquidar={() => liquidarUno(f)} onFacturar={() => facturarUno(f)}
                        onReversar={(m) => reversarUno(f, m)} onSoportes={() => setSoportesDe(f)}
                        // Va al final de la celda: el orden de foco es Soporte → Enviar → ¿Por qué
                        // no?, la acción antes que su explicación.
                        accionEnvio={puedeEmitir && esCandidato(f) && (
                          <AccionEnviarFactura tramiteId={f.tramiteId} idFlit={f.idFlit}
                            veredicto={elegibilidad.veredictos.get(f.tramiteId)}
                            cargando={elegibilidad.cargando} error={elegibilidad.error !== null}
                            onReintentar={elegibilidad.reintentar} onEnviar={() => abrirEnvio([f])} />
                        )} />
                    </td>
                  </FlitTr>
                ))}
              </tbody>
              {data && (
                <tfoot>
                  <FlitTr>
                    {puedeLiquidar && <td />}
                    <td className="px-4 py-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
                      Totales ({data.total.toLocaleString('es-CO')} trámites del filtro)
                    </td>
                    <td />
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{pesos(data.totales.soat)}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{pesos(data.totales.impuesto)}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{pesos(data.totales.derechoTramite)}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{pesos(data.totales.logistica)}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{pesos(data.totales.tramiteDigital)}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{pesos(data.totales.gmf)}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums" style={{ color: 'var(--flit-blue-text)' }}>{pesos(data.totales.total)}</td>
                    <td />
                  </FlitTr>
                </tfoot>
              )}
            </FlitTable>
          </div>

          <div className="mt-3"><Paginacion total={data!.total} page={data!.page} totalPaginas={totalPaginas} onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} /></div>
        </FlitCard>
      )}

      {fichaAbierta && (
        <FichaFacturacion
          ficha={fichaAbierta.ficha}
          idFlit={fichaAbierta.idFlit}
          // LA MISMA tabla que usa el servidor para decidir el 403, no una regla paralela. Cuando
          // la pantalla reimplementaba «admin o financiera», eran dos definiciones de lo mismo que
          // coincidían por costumbre: el día que una cambiara, la pantalla ofrecería un botón que
          // el servidor rechaza —o escondería uno que sí se puede pulsar— y ninguno de los dos
          // fallos aparece en los tests de la otra mitad.
          puedeOperar={puedeEjecutar(user?.role, 'reenviar_correo')}
          onClose={() => setFichaAbierta(null)}
          onCambio={() => setRecarga((n) => n + 1)}
        />
      )}

      {soportesDe && (
        <VisorSoportes ruta={`/finanzas/tramites/${soportesDe.tramiteId}/soportes`} titulo={soportesDe.idFlit}
          onClose={() => setSoportesDe(null)} />
      )}

      {envio && envio.tramites.length > 0 && (
        <DialogoEnvioFacturacion
          tramites={envio.tramites}
          excluidos={envio.excluidos}
          puedeReactivar={puedeReactivar}
          idFlitDe={(id) => filas.find((f) => f.tramiteId === id)?.idFlit ?? id}
          onEncolados={marcarEncolados}
          onCerrar={cerrarEnvio}
        />
      )}
    </div>
  );
}

/**
 * Estados del trámite, en un desplegable con casillas.
 *
 * Eran ocho pastillas siempre desplegadas, una banda entera del panel para un filtro que casi nunca
 * se toca —se entra por «Aprobado» y ahí se queda—. Plegado ocupa lo que un campo y sigue diciendo
 * qué hay puesto sin abrirlo, que es lo que de verdad hace falta ver.
 *
 * Es un `<details>`, el mismo patrón de `RangoFechas` y `ThFiltroMulti`: el navegador ya resuelve
 * abrir, cerrar y el foco por teclado.
 */
function FiltroEstados({ opciones, seleccion, onCambio }: {
  opciones: string[]; seleccion: string[]; onCambio: (v: string[]) => void;
}) {
  const alternar = (v: string) =>
    onCambio(seleccion.includes(v) ? seleccion.filter((x) => x !== v) : [...seleccion, v]);

  const resumen = seleccion.length === 0 ? 'Todos'
    : seleccion.length === 1 ? seleccion[0]
      : `${seleccion.length} seleccionados`;

  return (
    <details className="relative">
      <summary className="flit-focus flex cursor-pointer list-none items-center gap-2 rounded-[10px] border bg-white px-3 text-sm"
        style={{ ...ALTO_CONTROL, borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
        aria-label="Estado del trámite">
        <span className="text-xs font-semibold" style={{ color: 'var(--flit-text-muted)' }}>Estado</span>
        <span className="truncate">{resumen}</span>
      </summary>
      <div className="absolute z-30 mt-1 max-h-72 w-56 overflow-auto rounded-lg border bg-white p-2 shadow-lg"
        style={{ borderColor: 'var(--flit-border-input)' }}>
        {opciones.length === 0 && (
          <p className="px-1 py-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin estados que ofrecer</p>
        )}
        {opciones.map((o) => (
          <label key={o} className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-slate-50">
            <input type="checkbox" checked={seleccion.includes(o)} onChange={() => alternar(o)} />
            <span className="truncate">{o}</span>
          </label>
        ))}
        {seleccion.length > 0 && (
          <button type="button" className="mt-1 w-full text-xs underline" style={{ color: 'var(--flit-text-muted)' }}
            onClick={() => onCambio([])}>Cualquier estado</button>
        )}
      </div>
    </details>
  );
}

function Acciones({ fila, puedeLiquidar, puedeReversar, enProceso, onLiquidar, onFacturar, onReversar, onSoportes, accionEnvio }: {
  fila: Fila; puedeLiquidar: boolean; puedeReversar: boolean; enProceso: boolean;
  onLiquidar: () => void; onFacturar: () => void; onReversar: (motivo: string) => void; onSoportes: () => void;
  /** La acción de facturación electrónica, cuando aplica a esta fila (HU #11329). */
  accionEnvio?: ReactNode;
}) {
  const [reversando, setReversando] = useState(false);
  const [motivo, setMotivo] = useState('');
  // Las tres ausencias bloquean, y se nombran juntas: a quien lee le da igual si lo que falta es una
  // tarifa, un recibo o un pago, lo que necesita saber es qué le impide liquidar.
  const falta = faltantes(fila);
  const bloqueado = falta.length > 0;

  return (
    <div className="flex flex-wrap items-center gap-1">
      <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onSoportes}>Soporte</button>

      {puedeLiquidar && !fila.sellada && (
        <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={enProceso || bloqueado}
          title={bloqueado ? `Falta: ${falta.join(', ')}` : 'Sellar los valores de este trámite'}
          onClick={onLiquidar}>Liquidar</button>
      )}
      {/* Por qué NO se puede liquidar, sin obligar a pasar el ratón por encima del botón. */}
      {puedeLiquidar && !fila.sellada && bloqueado && (
        <span className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>Falta: {falta.join(', ')}</span>
      )}

      {puedeLiquidar && fila.estadoLiquidacion === 'liquidado' && (
        <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={enProceso} onClick={onFacturar}>Facturar</button>
      )}
      {/* Tras facturar ya no se ofrece reversar: los valores quedan congelados de verdad. */}
      {puedeReversar && fila.estadoLiquidacion === 'liquidado' && (
        reversando ? (
          <span className="flex items-center gap-1">
            <input className={`${flitInp} h-8 w-40 text-xs`} placeholder="Motivo del reverso" aria-label="Motivo del reverso"
              value={motivo} onChange={(e) => setMotivo(e.target.value)} />
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={motivo.trim().length < 5 || enProceso}
              onClick={() => { onReversar(motivo.trim()); setReversando(false); setMotivo(''); }}>Confirmar</button>
          </span>
        ) : (
          <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setReversando(true)}>Reversar</button>
        )
      )}

      {/* «Facturar» y «Enviar a facturación» NUNCA coinciden en la misma fila: el primero solo se
          pinta con `liquidado` y el segundo solo con `facturado`. */}
      {accionEnvio}
    </div>
  );
}

function Paginacion({ total, page, totalPaginas, onPrev, onNext }: {
  total: number; page: number; totalPaginas: number; onPrev: () => void; onNext: () => void;
}) {
  const btn = 'rounded-lg border px-3 py-1.5 text-sm font-semibold disabled:opacity-40';
  const btnStyle = { borderColor: 'var(--flit-border-input)', color: 'var(--flit-blue-text)' } as const;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
        <strong style={{ color: 'var(--flit-text-primary)' }}>{total.toLocaleString('es-CO')}</strong> trámites · página {page} de {totalPaginas}
      </span>
      <div className="flex gap-2">
        <button className={btn} style={btnStyle} disabled={page <= 1} onClick={onPrev}>← Anterior</button>
        <button className={btn} style={btnStyle} disabled={page >= totalPaginas} onClick={onNext}>Siguiente →</button>
      </div>
    </div>
  );
}
