/**
 * Bloques pequeños del UI Kit 2026, con la forma exacta de la propuesta (las clases viven en styles/kit/*.css):
 * Accesos (#inicio), ListaFila y ActividadLinea (#tramite), BarraAccion y Embudo (#tramites), PildoraTramite y
 * LineaAvance (#traspaso / #tramite), AvanceBarra, Fichas (.detalle__fichas) y EtiquetaEstado (registro de estados).
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icono, IconoModulo } from './kit/Icono';
import { estadoKit, ICONO_ESTADO_KIT } from './kit/tonos';

export function EtiquetaEstado({ estado, children }: { estado: string; children: ReactNode }) {
  const e = estadoKit(estado);
  return (
    <span className={`kit-etiqueta${e.icono || e.glifo ? ' kit-etiqueta--icono' : ''}`} data-tono={e.tono} data-estado={estado}>
      {e.icono ? <img src={ICONO_ESTADO_KIT[e.icono]} alt="" aria-hidden="true" className="kit-etiqueta__icono" />
        : e.glifo ? <span className="kit-disco kit-etiqueta__icono !bg-[var(--c)] !text-[color:var(--kit-sobre-relleno)]"><Icono nombre={e.glifo} /></span>
          : <span className="kit-etiqueta__punto" aria-hidden="true" />}
      {children}
    </span>
  );
}

export interface Acceso { to: string; titulo: string; detalle?: string; icono: string }
export function Accesos({ items }: { items: Acceso[] }) {
  return (
    <div className="accesos" data-kit="accesos">
      {items.map((a) => (
        <Link key={a.to} to={a.to} className="acceso">
          <IconoModulo clave={a.icono} disco size={40} />
          <span className="min-w-0"><strong>{a.titulo}</strong>{a.detalle && <span>{a.detalle}</span>}</span>
        </Link>
      ))}
    </div>
  );
}

export interface FilaLista { id: string; titulo: ReactNode; detalle?: ReactNode; inicial?: string; accion?: ReactNode; extra?: ReactNode }
export function ListaFila({ filas }: { filas: FilaLista[] }) {
  return (
    <ul className="lista-fila" data-kit="lista-fila">
      {filas.map((f) => (
        <li key={f.id}>
          {f.inicial && <span className="persona__avatar" aria-hidden="true">{f.inicial}</span>}
          <span className="lista-fila__texto"><strong>{f.titulo}</strong>{f.detalle && <small>{f.detalle}</small>}</span>
          {f.extra}
          {f.accion}
        </li>
      ))}
    </ul>
  );
}

export interface EventoActividad { id: string; cuando: string; fechaIso?: string; texto: ReactNode }
/** Línea de tiempo (`.actividad-linea`): punto azul con aro y línea entre eventos. */
export function ActividadLinea({ eventos }: { eventos: EventoActividad[] }) {
  return (
    <ol className="actividad-linea" data-kit="actividad">
      {eventos.map((e) => <li key={e.id}><time dateTime={e.fechaIso}>{e.cuando}</time><span>{e.texto}</span></li>)}
    </ol>
  );
}

/** «N esperan… + botón» (`.barra-accion`): azul al 10 % con borde azul. */
export function BarraAccion({ children, accion }: { children: ReactNode; accion?: ReactNode }) {
  return <div className="barra-accion" role="status" data-kit="barra-accion"><p>{children}</p>{accion}</div>;
}

/** `cuenta` opcional: las colas que no exponen conteos por estado pintan el chip sin cifra. */
export interface ChipEmbudo { id: string; etiqueta: string; cuenta?: number; estado?: string }
/** Embudo de estados (`.embudo`): chips en columna con disco 32, nombre 12 y cifra 20; filtra al pulsar. */
export function Embudo({ chips, activo, onElegir, etiqueta, className }: {
  chips: ChipEmbudo[]; activo?: string; onElegir: (id: string) => void; etiqueta: string; className?: string;
}) {
  return (
    <div className={`embudo${className ? ` ${className}` : ''}`} role="group" aria-label={etiqueta} data-kit="embudo">
      {chips.map((c) => {
        const e = estadoKit(c.estado ?? c.id);
        return (
          <button key={c.id} type="button" className="chip" aria-pressed={c.id === activo} onClick={() => onElegir(c.id)}>
            {e.icono ? <img className="estado-ico" src={ICONO_ESTADO_KIT[e.icono]} alt="" aria-hidden="true" />
              : <span className={`kico estado-ico estado-ico--${e.tono === 'ok' ? 'ok' : e.tono === 'warn' ? 'warn' : e.tono === 'danger' ? 'danger' : e.tono === 'info' ? 'info' : 'neutro'}`} aria-hidden="true"><Icono nombre={e.glifo ?? 'punto'} /></span>}
            <span>{c.etiqueta}</span>
            {c.cuenta !== undefined && <strong className="tabular-nums">{c.cuenta.toLocaleString('es-CO')}</strong>}
          </button>
        );
      })}
    </div>
  );
}

/** Píldora azul de datos del trámite (`.pildora-tramite`) bajo los pasos. */
export function PildoraTramite({ datos, estado }: { datos: Array<{ etiqueta: string; valor: ReactNode }>; estado?: string }) {
  return (
    <div className="pildora-tramite" data-kit="pildora-tramite">
      {datos.map((d) => <span key={d.etiqueta}>{d.etiqueta} <strong>{d.valor}</strong></span>)}
      {estado && <span className="pildora-tramite__estado">{estado}</span>}
    </div>
  );
}

export interface PasoLinea { etiqueta: string; detalle?: string }
/** Línea de avance horizontal del detalle (`.linea`): hecho verde con check, actual blanco con borde azul. */
export function LineaAvance({ pasos, actual }: { pasos: PasoLinea[]; actual: number }) {
  return (
    <ol className="linea" style={{ gridTemplateColumns: `repeat(${pasos.length}, minmax(0, 1fr))` }} data-kit="linea-avance">
      {pasos.map((p, i) => (
        <li key={p.etiqueta} className={`linea__paso${i < actual ? ' linea__paso--hecho' : i === actual ? ' linea__paso--actual' : ''}`} aria-current={i === actual ? 'step' : undefined}>
          <span className="linea__punto" aria-hidden="true" />
          <strong>{p.etiqueta}</strong>
          {p.detalle && <small>{p.detalle}</small>}
        </li>
      ))}
    </ol>
  );
}

/** Barra de progreso (`.avance`): pista hover, relleno azul y porcentaje. */
export function AvanceBarra({ valor, etiqueta }: { valor: number; etiqueta: string }) {
  const v = Math.max(0, Math.min(100, Math.round(valor)));
  return (
    <div className="avance" role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100} aria-label={etiqueta} data-kit="avance">
      <span className="avance__barra"><span style={{ width: `${v}%` }} /></span>
      <small>{v} %</small>
    </div>
  );
}

/** Fichas de datos del detalle (`.detalle__fichas`): dt gris, dd tinta, fondo hover. */
export function Fichas({ items }: { items: Array<{ etiqueta: string; valor: ReactNode }> }) {
  return (
    <dl className="detalle__fichas dl" data-kit="fichas">
      {items.map((x) => <div key={x.etiqueta} className="rounded-[9px] p-3"><dt>{x.etiqueta}</dt><dd>{x.valor}</dd></div>)}
    </dl>
  );
}
