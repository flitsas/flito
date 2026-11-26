// FLITO — Gestión Trámites: secciones del detalle en modal (ADR-0046). Solo presentación: los datos
// llegan de `GET /flito/tramites/:id/detalle` (y el historial de su propio endpoint). Se muestra solo
// lo que viene; un campo nulo no se inventa, se dice «Sin dato».

import { useEffect, useState, type ReactNode } from 'react';
import {
  esFuenteTramite,
  type TramiteDetalle as DetalleTramite, type TramiteDetalleConceptoId,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../../../../lib/api';
import StatusChip, { type ChipTone } from '../../../flit/StatusChip';
import { claseBoton } from '../../../flit/GradientButton';
import { FlitEmpty, FlitTable, FlitTh, FlitTr } from '../../../flit/flitPageKit';
import { fecha, pesos, type HistorialItem } from '../tiposTramites';

const tenue = 'text-[color:var(--color-text-tertiary)]';
const secundario = 'text-[color:var(--color-text-secondary)]';

/** Contenedor de una sección: es el destino del índice lateral (`id`) y su región accesible. */
export function Seccion({ id, titulo, children }: { id: string; titulo: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-titulo`}
      className="scroll-mt-2 rounded-[9px] border border-[color:var(--color-border)] p-4">
      <h3 id={`${id}-titulo`} className="m-0 mb-3 text-base font-semibold text-[color:var(--color-heading)]">{titulo}</h3>
      {children}
    </section>
  );
}

export function Cargando({ que }: { que: string }) {
  return <p role="status" className={`m-0 text-sm ${tenue}`}>Cargando {que}…</p>;
}

/** Error de una sección con su reintento: no tumba el resto de la modal. */
export function ErrorSeccion({ texto, onReintentar, rotulo }: { texto: string; onReintentar: () => void; rotulo: string }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3">
      <p className="m-0 min-w-0 flex-1 text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{texto}</p>
      <button type="button" className={claseBoton('secondary', 'sm')} onClick={onReintentar}>{rotulo}</button>
    </div>
  );
}

function Dato({ etiqueta, children }: { etiqueta: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className={`text-xs font-semibold ${secundario}`}>{etiqueta}</dt>
      <dd className="m-0 break-words text-sm text-[color:var(--color-text-primary)]">{children}</dd>
    </div>
  );
}

const sinDato = <span className={`italic ${tenue}`}>Sin dato</span>;
const o = (v: string | null | undefined) => (v && v.trim() ? v : sinDato);
const grid = 'm-0 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-3';

/** En el detalle la fuente se nombra siempre con su número (decisión del humano): «FLIT 1» / «FLIT 2». */
const FUENTE_DETALLE: Record<string, string> = { flit: 'FLIT 1', flit2: 'FLIT 2' };
export function EtiquetaFuente({ fuente }: { fuente: unknown }) {
  return <StatusChip tone="neutral">{esFuenteTramite(fuente) ? FUENTE_DETALLE[fuente] ?? fuente : 'Fuente desconocida'}</StatusChip>;
}

const SEMAFORO: Record<DetalleTramite['resumen']['semaforo'], { texto: string; tono: ChipTone }> = {
  autogestionada: { texto: 'Autogestionada', tono: 'neutral' },
  rojo: { texto: 'Rojo', tono: 'danger' },
  amarillo: { texto: 'Amarillo', tono: 'warning' },
  verde: { texto: 'Verde', tono: 'success' },
};

export function ContenidoResumen({ d }: { d: DetalleTramite }) {
  const r = d.resumen;
  const s = SEMAFORO[r.semaforo] ?? { texto: r.semaforo, tono: 'neutral' as ChipTone };
  return (
    <dl className={grid}>
      <Dato etiqueta="Estado"><StatusChip tone={r.asignado ? 'active' : 'neutral'}>{r.estado}</StatusChip></Dato>
      <Dato etiqueta="Tipo de trámite">{o(r.tipoTramite)}</Dato>
      <Dato etiqueta="Fuente"><EtiquetaFuente fuente={r.fuente} /></Dato>
      <Dato etiqueta="Creado">{r.creado ? fecha(r.creado) : sinDato}</Dato>
      <Dato etiqueta="Aprobado">{r.aprobado ? fecha(r.aprobado) : sinDato}</Dato>
      <Dato etiqueta="Ciudad">{o(r.ciudad)}</Dato>
      <Dato etiqueta="Semáforo"><StatusChip tone={s.tono}>{s.texto}</StatusChip></Dato>
      <Dato etiqueta="Para entregar">
        {r.listoParaEntregar
          ? <StatusChip tone="success">Listo para entregar</StatusChip>
          : `Falta: ${r.pendientes.map((p) => (p === 'soat' ? 'SOAT' : 'Impuestos')).join(' y ') || 'sin dato'}`}
      </Dato>
      <Dato etiqueta="Logística (licencia)">{o(r.logisticaEstado)}</Dato>
      <Dato etiqueta="Sincronizado">{fecha(r.sincronizadoEn)}</Dato>
    </dl>
  );
}

export function ContenidoVehiculo({ d }: { d: DetalleTramite }) {
  const v = d.vehiculo;
  // Solo lo que viene (decisión del humano): un campo nulo no ocupa sitio.
  const campos = ([['Placa', v.placa], ['VIN', v.vin], ['Marca', v.marca], ['Línea', v.linea], ['Clase', v.clase]] as const)
    .filter(([, valor]) => valor && valor.trim());
  if (campos.length === 0) return <FlitEmpty>FLIT no trajo datos del vehículo de este trámite.</FlitEmpty>;
  return (
    <dl className={grid}>
      {campos.map(([etiqueta, valor]) => <Dato key={etiqueta} etiqueta={etiqueta}><span className="tabular-nums">{valor}</span></Dato>)}
    </dl>
  );
}

export function ContenidoPropietario({ d }: { d: DetalleTramite }) {
  const g = d.gestora;
  return (
    <div className="space-y-4">
      {d.propietarios.length === 0 ? (
        <FlitEmpty>FLIT no trajo propietarios para este trámite.</FlitEmpty>
      ) : d.propietarios.map((p, i) => (
        <div key={`${p.orden}-${i}`} className={i > 0 ? 'border-t border-[color:var(--color-border)] pt-3' : ''}>
          <p className={`m-0 mb-2 text-xs font-semibold ${secundario}`}>
            {i === 0 ? 'Propietario principal' : `Propietario ${i + 1}`}
            {p.porcentajeParticipacion !== null && ` · ${p.porcentajeParticipacion} %`}
          </p>
          <dl className={grid}>
            <Dato etiqueta="Nombre">{o(p.nombreCompleto)}</Dato>
            <Dato etiqueta="Documento">{p.numeroDocumento ? `${p.tipoDocumento ?? ''} ${p.numeroDocumento}`.trim() : sinDato}</Dato>
            <Dato etiqueta="Correo">{o(p.correo)}</Dato>
            <Dato etiqueta="Celular">{o(p.celular)}</Dato>
            <Dato etiqueta="Dirección">{o(p.direccion)}</Dato>
          </dl>
        </div>
      ))}
      <div className="border-t border-[color:var(--color-border)] pt-3">
        <p className={`m-0 mb-2 text-xs font-semibold ${secundario}`}>Empresa gestora</p>
        <dl className={grid}>
          <Dato etiqueta="Gestor">{o(g.nombrePersona)}</Dato>
          <Dato etiqueta="Correo del gestor">{o(g.correoPersona)}</Dato>
          <Dato etiqueta="Nombre">{o(g.nombre)}</Dato>
          <Dato etiqueta="NIT">{o(g.nit)}</Dato>
          <Dato etiqueta="En FLITO">
            {g.existe ? <StatusChip tone="success">Registrada</StatusChip> : <StatusChip tone="warning">Sin registrar en FLITO</StatusChip>}
          </Dato>
        </dl>
      </div>
    </div>
  );
}

const CONCEPTO: Record<TramiteDetalleConceptoId, string> = {
  soat: 'SOAT', impuesto: 'Impuesto vehicular', derecho_transito: 'Derecho de tránsito',
};

export function ContenidoCostos({ d }: { d: DetalleTramite }) {
  const c = d.costos;
  return (
    <div className="space-y-3">
      <FlitTable>
        <thead>
          <FlitTr><FlitTh>Concepto</FlitTh><FlitTh>Quién cobra</FlitTh><FlitTh>Estado</FlitTh><FlitTh>Valor</FlitTh></FlitTr>
        </thead>
        <tbody>
          {c.conceptos.map((k) => (
            <FlitTr key={k.concepto}>
              <td className="px-3 py-2 text-sm font-medium">{CONCEPTO[k.concepto] ?? k.concepto}</td>
              <td className="px-3 py-2 text-sm">{o(k.quienCobra)}</td>
              <td className="px-3 py-2 text-sm">
                {k.autogestionado ? <StatusChip tone="neutral">Autogestionado</StatusChip> : o(k.estado)}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-sm tabular-nums">
                {k.valor !== null ? pesos(k.valor) : <span className={`italic ${tenue}`}>Sin valor</span>}
                {k.valorLiquidado !== null && <div className={`text-xs ${tenue}`}>Liquidado: {pesos(k.valorLiquidado)}</div>}
              </td>
            </FlitTr>
          ))}
        </tbody>
      </FlitTable>
      <dl className="m-0 flex flex-wrap gap-x-8 gap-y-2">
        <Dato etiqueta="Factura de venta de FLIT">{c.tieneFacturaVenta ? 'Sí' : 'Todavía no'}</Dato>
        <Dato etiqueta="Total"><strong className="tabular-nums">{c.total !== null ? pesos(c.total) : 'Sin valores todavía'}</strong></Dato>
      </dl>
    </div>
  );
}

/** Historial del trámite: endpoint propio y estados propios (un fallo aquí no tumba la modal). */
export function SeccionHistorial({ id, tramiteId, puedeVer }: { id: string; tramiteId: string; puedeVer: boolean }) {
  const [items, setItems] = useState<HistorialItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!puedeVer) return;
    let vivo = true;
    setItems(null); setError(null);
    api.get<HistorialItem[]>(`/flito/tramites/${tramiteId}/historial`)
      .then((r) => { if (vivo) setItems(Array.isArray(r) ? r : []); })
      .catch((e) => { if (vivo) setError(`No se pudo cargar el historial. ${errorMessage(e)}`); });
    return () => { vivo = false; };
  }, [tramiteId, puedeVer, nonce]);
  const fh = (iso: string) => new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
  return (
    <Seccion id={id} titulo="Historial">
      {!puedeVer ? <FlitEmpty>Tu usuario no tiene acceso al historial de los trámites.</FlitEmpty>
        : error ? <ErrorSeccion texto={error} rotulo="Reintentar el historial" onReintentar={() => setNonce((n) => n + 1)} />
        : items === null ? <Cargando que="el historial" />
        : items.length === 0 ? <FlitEmpty>Sin cambios registrados todavía.</FlitEmpty>
        : (
          <FlitTable>
            <thead>
              <FlitTr><FlitTh>Fecha</FlitTh><FlitTh>Campo</FlitTh><FlitTh>Antes</FlitTh><FlitTh>Después</FlitTh><FlitTh>Origen</FlitTh><FlitTh>Usuario</FlitTh></FlitTr>
            </thead>
            <tbody>
              {items.map((h) => (
                <FlitTr key={h.id}>
                  <td className={`whitespace-nowrap px-3 py-2 text-xs ${tenue}`}>{fh(h.creadoEn)}</td>
                  <td className="px-3 py-2 text-sm font-medium">{h.campo}</td>
                  <td className={`px-3 py-2 text-xs ${tenue}`}>{h.valorAnterior ?? '—'}</td>
                  <td className="px-3 py-2 text-xs font-semibold">{h.valorNuevo ?? '—'}</td>
                  <td className="px-3 py-2"><StatusChip tone={h.origen === 'api' ? 'neutral' : 'active'}>{h.origen === 'api' ? 'FLIT' : 'usuario'}</StatusChip></td>
                  <td className="px-3 py-2 text-xs">{h.usuarioNombre ?? '—'}</td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
        )}
    </Seccion>
  );
}
