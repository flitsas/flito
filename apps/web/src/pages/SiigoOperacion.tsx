// Facturación electrónica — Operación (HU #11345, Feature #11244).
//
// **Quien mira el reporte de costos pregunta «¿mi factura salió?». Quien abre esta pantalla viene a
// arreglar algo.** El AC7 convierte esa frase en regla: aquí no hay ni una columna de costos, ni
// totales, ni el listado completo de trámites. Solo lo que quedó detenido y el detalle de un caso.
// En la cabecera va el enlace al reporte de costos, que es donde se busca *una* factura concreta.
//
// **La decisión de permiso se lee de una sola tabla y no se reimplementa**: siempre
// `puedeEjecutar(user?.role, '<accion>')` de `@operaciones/shared-types`, nunca
// `role === 'admin' || role === 'financiera'` escrito a mano. `auditor` tiene `consultar` y nada
// más, así que ve la lista, los filtros, el detalle y la línea de tiempo enteros — y **cero
// casillas, cero columna de acciones, cero botones**. Un botón inhabilitado *es* una acción presente
// que no se puede usar, y en una lista de cincuenta filas serían cientos; el aviso de la cabecera es
// lo que evita que «no hay botones» se lea como «la pantalla está rota».

import { useCallback, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { puedeEjecutar } from '@operaciones/shared-types';
import type {
  SiigoBandejaItem, SiigoBandejaRespuestaDescarte, SiigoBandejaRespuestaReactivacion,
} from '@operaciones/shared-types';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondarySm, flitBtnSecondaryStyle } from '../components/flit/flitPageKit';
import BannerFreno, { ID_FRENO } from '../components/siigo/operacion/BannerFreno';
import BarraFiltrosBandeja, { type ClienteConCasos } from '../components/siigo/operacion/BarraFiltrosBandeja';
import ResumenBandeja from '../components/siigo/operacion/ResumenBandeja';
import TablaCasos from '../components/siigo/operacion/TablaCasos';
import DetalleCaso from '../components/siigo/operacion/DetalleCaso';
import DialogoDescartar from '../components/siigo/operacion/DialogoDescartar';
import DialogoCorreccion from '../components/siigo/operacion/DialogoCorreccion';
import DialogoReintentoLote from '../components/siigo/operacion/DialogoReintentoLote';
import { useBandejaFallidos } from '../components/siigo/operacion/useBandejaFallidos';
import { useFrenoSiigo, useResumenBandeja } from '../components/siigo/operacion/useResumenBandeja';
import { admiteLote, type CasoLote } from '../components/siigo/operacion/previsualizarLote';
import {
  CRITERIOS_VACIOS, claveCaso, etiquetaCaso, hayFiltros, type CriteriosBandeja,
} from '../components/siigo/operacion/tipos';

/** El único parámetro que esta pantalla escribe en la dirección: un uuid opaco, sin PII. */
const PARAM_CASO = 'caso';

type Dialogo = 'lote' | 'descartar' | 'correccion' | null;

function aCasoLote(item: SiigoBandejaItem): CasoLote {
  return {
    clave: claveCaso(item),
    etiqueta: etiquetaCaso(item),
    fuente: item.fuente,
    facturaId: item.facturaId,
    ocurridoEn: item.ocurridoEn,
    sirveReintentar: item.guia.sirveReintentar,
    descartado: item.descarte !== null,
    descripcion: item.guia.descripcion,
    accion: item.guia.accion,
  };
}

export default function SiigoOperacion() {
  const { user } = useAuth();
  const permisos = useMemo(() => ({
    reintentar: puedeEjecutar(user?.role, 'reintentar'),
    reenviarCorreo: puedeEjecutar(user?.role, 'reenviar_correo'),
    marcarFallido: puedeEjecutar(user?.role, 'marcar_fallido'),
    reactivar: puedeEjecutar(user?.role, 'reactivar'),
    corregir: puedeEjecutar(user?.role, 'corregir'),
  }), [user?.role]);
  const soloConsulta = !permisos.reintentar && !permisos.reenviarCorreo
    && !permisos.marcarFallido && !permisos.reactivar && !permisos.corregir;

  const [criterios, setCriterios] = useState<CriteriosBandeja>(CRITERIOS_VACIOS);
  const [pagina, setPagina] = useState(0);
  const [seleccion, setSeleccion] = useState<Set<string>>(() => new Set());
  const [dialogo, setDialogo] = useState<Dialogo>(null);
  const [casosDelLote, setCasosDelLote] = useState<CasoLote[]>([]);
  const [anuncio, setAnuncio] = useState('');
  const [recargaGlobal, setRecargaGlobal] = useState(0);
  const [params, setParams] = useSearchParams();

  const bandeja = useBandejaFallidos(criterios, pagina);
  const resumen = useResumenBandeja(recargaGlobal);
  const freno = useFrenoSiigo(recargaGlobal);
  const frenada = freno?.frenada === true;

  // Todos los modales de esta pantalla restauran el foco AQUÍ y no en la fila que los abrió: una
  // acción puede sacar esa fila del filtro puesto, y `.focus()` sobre un nodo desmontado deja el
  // foco en `<body>`.
  const encabezadoLista = useRef<HTMLHeadingElement>(null);

  const refIdAbierto = params.get(PARAM_CASO);
  const casoAbierto = bandeja.items.find((it) => it.refId === refIdAbierto) ?? null;

  const abrirCaso = useCallback((item: SiigoBandejaItem) => {
    setParams((previos) => {
      const siguientes = new URLSearchParams(previos);
      siguientes.set(PARAM_CASO, item.refId);
      return siguientes;
    }, { replace: true });
  }, [setParams]);

  const cerrarCaso = useCallback(() => {
    setParams((previos) => {
      const siguientes = new URLSearchParams(previos);
      siguientes.delete(PARAM_CASO);
      return siguientes;
    }, { replace: true });
  }, [setParams]);

  const cambiarCriterios = (c: CriteriosBandeja) => {
    setCriterios(c);
    // Un filtro nuevo empieza por la primera página: quedarse en la cuarta de otra consulta muestra
    // un vacío que no significa nada.
    setPagina(0);
    setSeleccion(new Set());
  };

  const alternar = (clave: string) => setSeleccion((previa) => {
    const siguiente = new Set(previa);
    if (siguiente.has(clave)) siguiente.delete(clave); else siguiente.add(clave);
    return siguiente;
  });

  const seleccionarPagina = (marcar: boolean) => setSeleccion((previa) => {
    const siguiente = new Set(previa);
    for (const item of bandeja.items) {
      if (!admiteLote(aCasoLote(item))) continue;
      if (marcar) siguiente.add(claveCaso(item)); else siguiente.delete(claveCaso(item));
    }
    return siguiente;
  });

  const clientes: ClienteConCasos[] = useMemo(() => {
    const porId = new Map<number, string>();
    for (const it of bandeja.items) {
      if (it.clienteId !== null && it.clienteNombre) porId.set(it.clienteId, it.clienteNombre);
    }
    return [...porId].map(([id, nombre]) => ({ id, nombre }));
  }, [bandeja.items]);

  const seleccionados = bandeja.items.filter((it) => seleccion.has(claveCaso(it)));

  const abrirLote = (casos: CasoLote[]) => { setCasosDelLote(casos); setDialogo('lote'); };

  /** AC5 — la fila se sustituye en sitio con lo que el servidor afirmó; nada se recarga. */
  const trasDescartar = (r: SiigoBandejaRespuestaDescarte) => {
    if (!casoAbierto) return;
    bandeja.parchear({
      ...casoAbierto,
      descarte: r.descarte,
      colaId: r.colaId,
      estado: { ...casoAbierto.estado, cola: r.estado ?? casoAbierto.estado.cola },
    });
    setAnuncio(`${etiquetaCaso(casoAbierto)} quedó dado por perdido: ${r.descarte.motivoEtiqueta}.`);
    setDialogo(null);
  };

  const trasReactivar = (r: SiigoBandejaRespuestaReactivacion) => {
    if (!casoAbierto) return;
    bandeja.parchear({
      ...casoAbierto,
      descarte: null,
      colaId: r.colaId,
      estado: { ...casoAbierto.estado, cola: r.estado ?? casoAbierto.estado.cola },
    });
    setAnuncio(`${etiquetaCaso(casoAbierto)} volvió a la cola.`);
  };

  const trasCorregir = () => {
    setAnuncio('La corrección quedó registrada.');
    setDialogo(null);
    // La corrección no vive en el ítem de la bandeja, así que no hay parche local honesto: se vuelve
    // a consultar en sitio (la tabla se repinta; la página no se remonta y el filtro se conserva).
    bandeja.recargar();
  };

  const cerrarLote = () => {
    setDialogo(null);
    setSeleccion(new Set());
    bandeja.recargar();
    setRecargaGlobal((n) => n + 1);
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeaderCard
        title="Facturación electrónica — Operación"
        subtitle="Lo que quedó detenido en el camino a la DIAN, con qué hacer en cada caso."
        actions={(
          <Link to="/finanzas/reporte-costos" className={flitBtnSecondarySm} style={flitBtnSecondaryStyle}>
            ¿Buscas una factura concreta? Ve al reporte de costos
          </Link>
        )}
      />

      {/* Sin esta frase, «no hay botones» se lee como «la pantalla está rota». */}
      {soloConsulta && (
        <p
          className="rounded-[10px] px-4 py-3 text-sm"
          style={{ background: 'var(--flit-bg-app)', color: 'var(--flit-text-primary)' }}
        >
          Tu rol es de consulta: ves todo y no hay acciones disponibles.
        </p>
      )}

      <BannerFreno
        freno={freno}
        esAdmin={user?.role === 'admin'}
        onReactivado={() => setRecargaGlobal((n) => n + 1)}
      />

      <ResumenBandeja
        resumen={resumen.resumen}
        cargando={resumen.cargando}
        error={resumen.error}
        onReintentar={resumen.recargar}
      />

      <BarraFiltrosBandeja
        criterios={criterios}
        onCambiar={cambiarCriterios}
        resumen={resumen.resumen}
        resumenError={resumen.error}
        onReintentarResumen={resumen.recargar}
        clientes={clientes}
      />

      {/* El desenlace de un diálogo se anuncia aunque se haya cerrado sin leerlo. */}
      <p aria-live="polite" className="sr-only">{anuncio}</p>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          ref={encabezadoLista}
          tabIndex={-1}
          className="text-base font-bold outline-none"
          style={{ color: 'var(--flit-blue-text)' }}
        >
          Casos detenidos
        </h2>
        {!soloConsulta && seleccionados.length > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
              {seleccionados.length} seleccionados
            </span>
            <button
              type="button"
              onClick={() => setSeleccion(new Set())}
              className={flitBtnSecondarySm}
              style={flitBtnSecondaryStyle}
            >
              Quitar la selección
            </button>
            {/* Con la integración frenada no se abre un diálogo cuyo único desenlace posible es un
                503: el botón se inhabilita y el motivo vive en el banner, que sí se puede leer. */}
            <button
              type="button"
              onClick={() => abrirLote(seleccionados.map(aCasoLote))}
              disabled={frenada}
              aria-describedby={frenada ? ID_FRENO : undefined}
              className={flitBtnPrimary}
              style={flitBtnPrimaryStyle}
            >
              Reintentar {seleccionados.length} casos
            </button>
          </div>
        )}
      </div>

      {refIdAbierto && !casoAbierto && !bandeja.cargando && (
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          El caso del enlace no está entre lo que se está viendo ahora. Quita los filtros o pasa de
          página para encontrarlo.
        </p>
      )}

      <TablaCasos
        items={bandeja.items}
        cargando={bandeja.cargando}
        error={bandeja.error}
        onReintentarConsulta={bandeja.recargar}
        tocados={bandeja.tocados}
        conFiltros={hayFiltros(criterios)}
        totalGlobal={resumen.resumen?.total ?? null}
        onLimpiarFiltros={() => cambiarCriterios(CRITERIOS_VACIOS)}
        seleccion={seleccion}
        onAlternar={alternar}
        onSeleccionarPagina={seleccionarPagina}
        puedeSeleccionar={permisos.reintentar || permisos.reenviarCorreo}
        onAbrir={abrirCaso}
        pagina={pagina}
        hayMas={bandeja.hayMas}
        onPagina={setPagina}
      />

      {casoAbierto && dialogo === null && (
        <DetalleCaso
          caso={casoAbierto}
          permisos={permisos}
          frenada={frenada}
          onCerrar={cerrarCaso}
          onReintentar={() => abrirLote([aCasoLote(casoAbierto)])}
          onDescartar={() => setDialogo('descartar')}
          onCorregir={() => setDialogo('correccion')}
          onReactivado={trasReactivar}
          restoreFocusRef={encabezadoLista}
        />
      )}

      {dialogo === 'lote' && (
        <DialogoReintentoLote
          seleccion={casosDelLote}
          onCerrar={cerrarLote}
          onTerminado={setAnuncio}
          restoreFocusRef={encabezadoLista}
        />
      )}

      {dialogo === 'descartar' && casoAbierto && (
        <DialogoDescartar
          caso={casoAbierto}
          onCerrar={() => setDialogo(null)}
          onHecho={trasDescartar}
          restoreFocusRef={encabezadoLista}
        />
      )}

      {dialogo === 'correccion' && casoAbierto && (
        <DialogoCorreccion
          caso={casoAbierto}
          onCerrar={() => setDialogo(null)}
          onHecho={trasCorregir}
          restoreFocusRef={encabezadoLista}
        />
      )}
    </div>
  );
}
