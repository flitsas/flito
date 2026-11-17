// Torre de Control (Épica #14590) — Ficha de placa en un `Drawer` (spec UX §6). La placa viaja SOLO en el cuerpo
// de `POST /flito/torre/placa/buscar` y vive en el estado de este componente: nunca en la URL, el historial ni el
// almacenamiento. La ficha no muestra valores pagados ni datos del comprador. 404 = «no encontrada» (la API no
// distingue «fuera de su alcance», para no filtrar que el trámite existe).
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { FichaPlacaTorre, ResultadoBusquedaPlaca } from '@operaciones/shared-types';
import { api, ApiError } from '../../lib/api';
import Drawer from '../flit/Drawer';
import Placa from '../flit/Placa';
import InlineAlert from '../flit/InlineAlert';
import { ErrorVista, Vacio } from '../flit/Cargador';
import { ActividadLinea, EtiquetaEstado, Fichas, LineaAvance, ListaFila } from '../flit/Bloques';
import GradientButton from '../flit/GradientButton';
import { fechaCorta, humanizar } from './formatoTorre';

type Vista =
  | { tipo: 'cargando' }
  | { tipo: 'error' }
  | { tipo: 'noencontrada' }
  | { tipo: 'varios'; tramites: FichaPlacaTorre[] }
  | { tipo: 'ficha'; ficha: FichaPlacaTorre; desdeLista: FichaPlacaTorre[] | null };

const dias = (horas: number) => Math.max(0, Math.round(horas / 24));
const plural = (n: number) => `${n} ${n === 1 ? 'día' : 'días'}`;
const diasEntre = (a: string, b: string) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000));

/** Abre la ficha; el foco vuelve al buscador (el input dentro de `buscadorRef`) al cerrar. */
export function useFichaPlaca(buscadorRef: RefObject<HTMLDivElement>) {
  const [placa, setPlaca] = useState<string | null>(null);
  const [consulta, setConsulta] = useState(0);
  const volverA = useRef<HTMLElement | null>(null);
  const abrir = useCallback((p: string) => {
    volverA.current = buscadorRef.current?.querySelector('input') ?? (document.activeElement as HTMLElement | null);
    setPlaca(p);
    setConsulta((n) => n + 1);
  }, [buscadorRef]);
  const drawer = placa
    ? <FichaPlacaDrawer key={consulta} placa={placa} onCerrar={() => setPlaca(null)} restoreFocusRef={volverA} />
    : null;
  return { abrir, drawer };
}

export default function FichaPlacaDrawer({ placa, onCerrar, restoreFocusRef }: {
  placa: string; onCerrar: () => void; restoreFocusRef: RefObject<HTMLElement | null>;
}) {
  const [vista, setVista] = useState<Vista>({ tipo: 'cargando' });
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    let vivo = true;
    setVista({ tipo: 'cargando' });
    api.post<ResultadoBusquedaPlaca>('/flito/torre/placa/buscar', { placa })
      .then((r) => {
        if (!vivo) return;
        const t = r?.tramites ?? [];
        if (t.length === 0) setVista({ tipo: 'noencontrada' });
        else if (t.length === 1) setVista({ tipo: 'ficha', ficha: t[0], desdeLista: null });
        else setVista({ tipo: 'varios', tramites: t });
      })
      .catch((e) => {
        if (!vivo) return;
        setVista(e instanceof ApiError && e.status === 404 ? { tipo: 'noencontrada' } : { tipo: 'error' });
      });
    return () => { vivo = false; };
  }, [placa, intento]);

  return (
    <Drawer title="Ficha de la placa" antetitulo="Torre de Control" onClose={onCerrar} restoreFocusRef={restoreFocusRef}>
      <div className="flex flex-col gap-4" data-torre="ficha-placa" data-vista={vista.tipo} aria-live="polite">
        {vista.tipo === 'cargando' && (
          <div role="status" aria-busy="true" className="flex flex-col gap-3">
            <span className="sr-only">Buscando la placa</span>
            <div className="kit-esqueleto h-14 w-40" aria-hidden="true" />
            <div className="kit-esqueleto h-24" aria-hidden="true" />
            <div className="kit-esqueleto h-12" aria-hidden="true" />
            <div className="kit-esqueleto h-32" aria-hidden="true" />
          </div>
        )}
        {vista.tipo === 'error' && (
          <ErrorVista texto="No pudimos buscar la placa. Intente de nuevo." onReintentar={() => setIntento((n) => n + 1)} />
        )}
        {vista.tipo === 'noencontrada' && (
          <Vacio icono="buscar" texto={`No encontramos la placa ${placa} en FLITO.`}
            detalle="Revise que esté bien escrita. La Torre solo ve trámites registrados en FLITO." />
        )}
        {vista.tipo === 'varios' && (
          <>
            <p className="text-sm">La placa {placa} tiene {vista.tramites.length} trámites en FLITO. Elija cuál ver.</p>
            <ListaFila filas={vista.tramites.map((t) => ({
              id: t.tramiteUuid,
              titulo: humanizar(t.tipoTramite ?? 'Trámite'),
              detalle: `${t.compania.nombre ?? 'Sin compañía'} · creado ${fechaCorta(t.fechaCreacion)}`,
              extra: t.flitEstado ? <EtiquetaEstado estado={t.flitEstado}>{humanizar(t.flitEstado)}</EtiquetaEstado> : undefined,
              accion: (
                <GradientButton variant="ghost" size="sm" onClick={() => setVista({ tipo: 'ficha', ficha: t, desdeLista: vista.tramites })}>
                  Ver ficha
                </GradientButton>
              ),
            }))} />
          </>
        )}
        {vista.tipo === 'ficha' && (
          <Ficha ficha={vista.ficha} onVolver={vista.desdeLista
            ? () => setVista({ tipo: 'varios', tramites: vista.desdeLista! }) : undefined} />
        )}
      </div>
    </Drawer>
  );
}

function Ficha({ ficha, onVolver }: { ficha: FichaPlacaTorre; onVolver?: () => void }) {
  const aprobado = Boolean(ficha.fechaAprobacion);
  const horas = ficha.duracionHoras
    ?? (ficha.fechaCreacion ? (Date.now() - Date.parse(ficha.fechaCreacion)) / 3_600_000 : null);
  const pasos = [
    { etiqueta: 'Creado', fecha: ficha.pasos.creado },
    { etiqueta: 'Radicado', fecha: ficha.pasos.radicado },
    { etiqueta: 'Aprobado', fecha: ficha.pasos.aprobado },
    { etiqueta: 'Facturado', fecha: ficha.pasos.facturado },
  ];
  // Manda el paso más avanzado con fecha: todo lo anterior se da por superado aunque no tenga fecha («sin fecha»)
  // y el actual es el siguiente. Un aprobado sin radicado no puede quedarse en «Radicado».
  let ultimoConFecha = -1;
  pasos.forEach((p, i) => { if (p.fecha) ultimoConFecha = i; });
  const actual = ultimoConFecha + 1;
  const historial = ficha.lineaTiempo.map((e, i) => {
    const previo = i > 0 ? ficha.lineaTiempo[i - 1] : null;
    const estuvo = previo ? ` · estuvo ${plural(diasEntre(previo.desde, e.desde))} en ${humanizar(e.anterior ?? previo.estado)}` : '';
    return { id: `${e.desde}-${i}`, cuando: fechaCorta(e.desde), fechaIso: e.desde, texto: `Pasó a ${humanizar(e.estado)}${estuvo}` };
  }).reverse();
  const bloque = (b: FichaPlacaTorre['soat']) => `${humanizar(b.estado)}${b.fecha ? ` · ${fechaCorta(b.fecha)}` : ''}`;

  return (
    <>
      <div className="flex flex-wrap items-start gap-3">
        <Placa placa={ficha.placa} />
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-base font-semibold">{humanizar(ficha.tipoTramite ?? 'Trámite')}</h3>
          <p className="m-0 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            {ficha.compania.nombre ?? 'Sin compañía'} · {ficha.organismo.nombre ?? 'Sin organismo'}
          </p>
          {ficha.flitEstado && <div className="mt-1"><EtiquetaEstado estado={ficha.flitEstado}>{humanizar(ficha.flitEstado)}</EtiquetaEstado></div>}
        </div>
      </div>

      {horas !== null && (
        <div className="grid gap-0.5 rounded-[9px] p-4" style={{ background: 'var(--kit-hover)' }} data-torre="duracion">
          <strong className="text-3xl font-bold tabular-nums" style={{ color: 'var(--kit-azul)' }}>
            {aprobado ? plural(dias(horas)) : `Lleva ${plural(dias(horas))}`}
          </strong>
          <small style={{ color: 'var(--color-text-secondary)' }}>
            {aprobado
              ? `de la creación a la aprobación · ${fechaCorta(ficha.fechaCreacion)} → ${fechaCorta(ficha.fechaAprobacion)}`
              : 'desde la creación; aún no se aprueba'}
          </small>
        </div>
      )}

      <LineaAvance pasos={pasos.map((p, i) => ({
        etiqueta: p.etiqueta, detalle: p.fecha ? fechaCorta(p.fecha) : i < actual ? 'sin fecha' : undefined,
      }))} actual={actual} />

      <Fichas items={[
        { etiqueta: 'SOAT', valor: bloque(ficha.soat) },
        { etiqueta: 'Impuesto', valor: bloque(ficha.impuesto) },
        { etiqueta: 'Derecho de tránsito', valor: bloque(ficha.derecho) },
        { etiqueta: 'Logística', valor: bloque(ficha.logistica) },
      ]} />

      {ficha.baseFecha.conFallback && (
        <InlineAlert tono="info">
          Este trámite es anterior a julio de 2026: el tiempo se cuenta desde la fecha en que FLITO lo sincronizó, que puede ser posterior a la creación real.
        </InlineAlert>
      )}

      {historial.length > 0 && (
        <section aria-labelledby="torre-ficha-historial">
          <h3 id="torre-ficha-historial" className="mb-2 text-sm font-semibold">Historial de estados</h3>
          <ActividadLinea eventos={historial} />
        </section>
      )}

      {onVolver && (
        <div className="flex flex-wrap justify-end gap-2">
          <GradientButton variant="secondary" onClick={onVolver}>Ver los otros trámites</GradientButton>
        </div>
      )}
    </>
  );
}
