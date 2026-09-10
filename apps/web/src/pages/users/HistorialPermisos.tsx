// FLITO — Historial de cambios en usuarios, roles y permisos (HU #12171, Feature #12072, ADR-0014).
//
// Lector de `GET /api/users/auditoria`: una fila por cambio de un campo, la más reciente arriba, con
// cuándo · quién · qué · antes → después. Lo consumen dos públicos por la misma puerta —el admin en
// la pestaña «Historial» y el auditor como única vista— y por eso NO recibe nada de la lista de
// usuarios: su filtro «Usuario» se alimenta de `/users/auditoria/titulares`, que es lo que el auditor
// puede leer (ficha UX §5-2).
//
// Tres reglas que no son cosmética:
//   - **Nada en la URL** (AC3): pestaña, filtros y página viven en `useState`. El `userId` del
//     titular viaja SOLO como query del API.
//   - **Del titular se pinta `username` y nada más** (AC4). El DTO no trae correo ni nombre, y esta
//     pantalla no los pediría a otro sitio. Ningún `aria-label` ni `title` lleva datos.
//   - **El diff de un conjunto se lee con palabras** —«Añadidas (n)», «Quitadas (n)», «Quedan n»—;
//     el color es refuerzo, no portador (AGENTS.md §12). Nunca dos JSON.
//
// Copy, estados y columnas: `docs/ux/usuarios-historial.md`. **Esto NO es kit**: un consumidor.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CAMPO_LABELS, PAGES, ROLE_LABELS,
  type EntidadAuditable, type ItemAuditoriaPermisos, type RespuestaAuditoriaPermisos,
  type TitularAuditoria, type ValorAuditable,
} from '@operaciones/shared-types';
import { api } from '../../lib/api';
import {
  FlitCard, FlitTable, FlitTh, FlitTr, FlitEmpty, FlitPillGroup, FlitPillButton,
  flitBtnSecondary, flitBtnSecondaryStyle,
} from '../../components/flit/flitPageKit';
import FlitSelect from '../../components/flit/FlitSelect';
import Paginacion from '../../components/flit/Paginacion';
import StatusChip from '../../components/flit/StatusChip';
import { formatErrors } from './UserFormShared';

const LIMITE = 50;

/** Vocabulario de la ficha de roles (§Decisión 19): el mismo que verá quien administre el cuadro. */
const RECURSOS: { valor: EntidadAuditable | ''; etiqueta: string }[] = [
  { valor: '', etiqueta: 'Todos' },
  { valor: 'usuario', etiqueta: 'Usuarios' },
  { valor: 'rol', etiqueta: 'Roles' },
  { valor: 'rol_funcion', etiqueta: 'Cuadro rol × función' },
  { valor: 'usuario_funcion', etiqueta: 'Funciones por usuario' },
];

interface Filtros {
  titularUserId: string;
  entidad: EntidadAuditable | '';
  desde: string;
  hasta: string;
}

const SIN_FILTROS: Filtros = { titularUserId: '', entidad: '', desde: '', hasta: '' };

/**
 * `hasta` inclusivo para quien filtra. El API recibe un rango medio abierto `[desde, hasta)`; quien
 * pone «hasta el 10» espera ver el 10, así que se manda el 11. Se calcula en UTC sobre el literal
 * `YYYY-MM-DD` para que el huso local no mueva el día (en -05 un `new Date('2026-09-10')` ya es el 9).
 */
function diaSiguiente(fecha: string): string {
  const [a, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + 1)).toISOString().slice(0, 10);
}

function armarQuery(f: Filtros, offset: number): string {
  const q = new URLSearchParams();
  if (f.titularUserId) q.set('titularUserId', f.titularUserId);
  if (f.entidad) q.set('entidad', f.entidad);
  if (f.desde) q.set('desde', f.desde);
  if (f.hasta) q.set('hasta', diaSiguiente(f.hasta));
  q.set('limite', String(LIMITE));
  q.set('offset', String(offset));
  return q.toString();
}

/**
 * «9 de sept de 2026, 14:32». La ficha pedía `dateStyle: 'medium'`, pero en Chromium `es-CO` lo resuelve a
 * «9/09/2026, 2:32 p. m.» —numérico y con año ambiguo al ojo—, que es justo lo que la ficha descartaba
 * de la Bitácora. Se piden las partes a mano para obtener lo que la ficha dibuja.
 */
const fechaHora = (iso: string) => new Date(iso).toLocaleString('es-CO', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});
const fechaLarga = (iso: string) => new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' });

export default function HistorialPermisos() {
  const [filtros, setFiltros] = useState<Filtros>(SIN_FILTROS);
  const [offset, setOffset] = useState(0);
  /** Cuenta los «Reintentar»: cambiarla vuelve a pedir con la misma query. */
  const [intento, setIntento] = useState(0);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [datos, setDatos] = useState<RespuestaAuditoriaPermisos | null>(null);
  const [titulares, setTitulares] = useState<TitularAuditoria[]>([]);

  const query = useMemo(() => armarQuery(filtros, offset), [filtros, offset]);
  const hayFiltros = Object.values(filtros).some((v) => v !== '');
  /**
   * La petición en vuelo, por clave. Un mismo `query` + `intento` sale UNA vez aunque el efecto
   * corra dos veces (StrictMode en desarrollo monta, desmonta y vuelve a montar): la segunda pasada
   * se cuelga de la misma promesa. Al resolverse se suelta, para que volver a la misma página tras
   * cambiar de filtro pida de nuevo y no enseñe una respuesta vieja.
   */
  const enVuelo = useRef<{ clave: string; promesa: Promise<RespuestaAuditoriaPermisos> } | null>(null);

  useEffect(() => {
    let vigente = true;
    const clave = `${query}#${intento}`;
    setCargando(true);
    setError(null);
    if (enVuelo.current?.clave !== clave) {
      enVuelo.current = { clave, promesa: api.get<RespuestaAuditoriaPermisos>(`/users/auditoria?${query}`) };
    }
    enVuelo.current.promesa
      .then((r) => { if (vigente) setDatos(r); })
      .catch((e) => {
        // Un 403 o un 400 de Zod se pintan como error con el mensaje del servidor, no como vacío.
        // `datos` se vacía: la tabla no enseña filas viejas bajo un error (misma regla que la lista).
        if (!vigente) return;
        setError(formatErrors(e));
        setDatos(null);
      })
      .finally(() => {
        if (enVuelo.current?.clave === clave) enVuelo.current = null;
        if (vigente) setCargando(false);
      });
    return () => { vigente = false; };
  }, [query, intento]);

  /**
   * El catálogo del filtro es información SECUNDARIA: si falla, el select se queda con «Todos» y
   * el historial sigue sirviendo. No se esconde el control porque hoy esté vacío.
   */
  const titularesPedidos = useRef(false);
  useEffect(() => {
    if (titularesPedidos.current) return;
    titularesPedidos.current = true;
    api.get<TitularAuditoria[]>('/users/auditoria/titulares')
      .then((t) => setTitulares(Array.isArray(t) ? t : []))
      .catch(() => setTitulares([]));
  }, []);

  /** Cualquier cambio de filtro vuelve a la página 1: la página 3 de otro filtro no existe. */
  const cambiarFiltro = (parcial: Partial<Filtros>) => {
    setFiltros((f) => ({ ...f, ...parcial }));
    setOffset(0);
  };
  const quitarFiltros = () => { setFiltros(SIN_FILTROS); setOffset(0); };

  const items = datos?.items ?? [];
  const total = datos?.total ?? 0;
  const pagina = Math.floor(offset / LIMITE) + 1;
  const totalPaginas = Math.max(1, Math.ceil(total / LIMITE));
  const lleno = !cargando && !error && items.length > 0;
  const vacio = !cargando && !error && items.length === 0;
  const opcionesTitular = [
    { valor: '', etiqueta: 'Todos' },
    // El `<option>` lleva el `username`; el `userId` va SOLO en `value` (AC4).
    ...titulares.map((t) => ({ valor: String(t.userId), etiqueta: t.username ?? 'usuario eliminado' })),
  ];

  return (
    <FlitCard>
      {/* Suelo temporal: lo que hace que un historial corto no se lea como un fallo. No se pinta
          bajo el error ni durante la carga. */}
      {!cargando && !error && datos?.desdeCuando && (
        <p className="mb-3 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          El historial comienza el {fechaLarga(datos.desdeCuando)}. Los cambios anteriores a esa fecha no se registraron con este detalle.
        </p>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-48">
          <FlitSelect
            label="Usuario"
            value={filtros.titularUserId}
            opciones={opcionesTitular}
            onChange={(v) => cambiarFiltro({ titularUserId: v })}
          />
        </div>
        <div role="group" aria-label="Recurso" className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Recurso</span>
          <FlitPillGroup>
            {RECURSOS.map((r) => (
              <FlitPillButton
                key={r.valor}
                active={filtros.entidad === r.valor}
                pressed={filtros.entidad === r.valor}
                onClick={() => cambiarFiltro({ entidad: r.valor })}
              >
                {r.etiqueta}
              </FlitPillButton>
            ))}
          </FlitPillGroup>
        </div>
        <label className="flex flex-col gap-1 text-xs font-medium" style={{ color: 'var(--flit-text-secondary)' }}>
          Desde
          <input
            type="date"
            value={filtros.desde}
            max={filtros.hasta || undefined}
            onChange={(e) => cambiarFiltro({ desde: e.target.value })}
            className="flit-focus h-8 rounded-[10px] border px-2 text-xs"
            style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium" style={{ color: 'var(--flit-text-secondary)' }}>
          Hasta
          <input
            type="date"
            value={filtros.hasta}
            min={filtros.desde || undefined}
            onChange={(e) => cambiarFiltro({ hasta: e.target.value })}
            className="flit-focus h-8 rounded-[10px] border px-2 text-xs"
            style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
          />
        </label>
      </div>

      {vacio && !hayFiltros && (
        <FlitEmpty>
          {datos?.desdeCuando
            ? `Todavía no hay cambios registrados desde el ${fechaLarga(datos.desdeCuando)}. Cuando alguien cree o edite un usuario, un rol o sus funciones, aparecerá aquí.`
            : 'Todavía no hay cambios registrados. Aparecerán aquí a partir del primer cambio en un usuario, un rol o sus funciones.'}
        </FlitEmpty>
      )}

      {vacio && hayFiltros && (
        <FlitEmpty>
          <p>Ningún cambio coincide con estos filtros. Amplía el rango de fechas o quita el filtro de usuario o de recurso.</p>
          <button type="button" onClick={quitarFiltros} className={`${flitBtnSecondary} mt-4`} style={flitBtnSecondaryStyle}>
            Quitar filtros
          </button>
        </FlitEmpty>
      )}

      {!vacio && (
        <FlitTable label="Historial de cambios en usuarios, roles y permisos">
          <thead>
            <FlitTr>
              <FlitTh>Cuándo</FlitTh><FlitTh>Quién</FlitTh><FlitTh>Qué</FlitTh><FlitTh>Cambio</FlitTh>
            </FlitTr>
          </thead>
          <tbody>
            {cargando && (
              <tr><td colSpan={4} role="status" className="py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando el historial…</td></tr>
            )}
            {!cargando && error && (
              <tr><td colSpan={4} role="alert" className="px-4 py-10 text-center">
                <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>No se pudo cargar el historial.</p>
                <p className="mt-1 text-xs" style={{ color: 'var(--flit-danger-ink)' }}>{error}</p>
                <button
                  type="button"
                  onClick={() => setIntento((n) => n + 1)}
                  className="flit-focus mt-3 rounded-[10px] border px-4 py-2 text-sm font-semibold transition-opacity hover:opacity-80"
                  style={{ borderColor: 'var(--flit-border-soft)', color: 'var(--flit-text-secondary)' }}
                >
                  Reintentar
                </button>
              </td></tr>
            )}
            {lleno && items.map((i) => <Fila key={i.id} item={i} />)}
          </tbody>
        </FlitTable>
      )}

      {/* Única región viva del panel, montada SIEMPRE: es lo que le dice a quien filtra sin ver que
          la tabla cambió. Ni las filas ni el suelo temporal anuncian nada. */}
      <div role="status" className="mt-4">
        {lleno && (
          <Paginacion
            total={total}
            page={pagina}
            totalPaginas={totalPaginas}
            onPrev={() => setOffset((o) => Math.max(0, o - LIMITE))}
            onNext={() => setOffset((o) => o + LIMITE)}
            sustantivo="cambios"
          />
        )}
      </div>
    </FlitCard>
  );
}

// ───────────────────────────── Una fila = un cambio ─────────────────────────────

const etiquetaRol = (codigo: string) => (ROLE_LABELS as Record<string, string>)[codigo] ?? codigo;

const TIPO_ENLACE: Record<string, string> = {
  ninguno: 'No se atan a nada', compania: 'Una compañía', proveedor_soat: 'Un gestor SOAT', organismos_transito: 'Organismos de tránsito',
};
const TIPO_PRINCIPAL: Record<string, string> = { interno: 'Interno', externo: 'Externo' };

function Fila({ item }: { item: ItemAuditoriaPermisos }) {
  const esRol = item.entidad === 'rol' || item.entidad === 'rol_funcion';
  return (
    <FlitTr>
      <td className="whitespace-nowrap px-4 py-3 align-top text-xs" style={{ color: 'var(--flit-text-muted)' }}>{fechaHora(item.creadoEn)}</td>
      <td className="px-4 py-3 align-top text-sm" style={{ color: 'var(--flit-text-primary)' }}>
        {item.actor.userId === null ? <StatusChip tone="draft">Sistema</StatusChip> : (item.actor.email ?? '—')}
        {item.origen === 'auditoria' && (
          <>
            <span aria-hidden="true" title="Reconstruido desde la auditoría al implantar el historial; no se registró en el momento." style={{ color: 'var(--flit-text-muted)' }}> · reconstruido</span>
            <span className="sr-only"> · reconstruido desde la auditoría al implantar el historial; no se registró en el momento.</span>
          </>
        )}
      </td>
      <td className="px-4 py-3 align-top text-sm">
        <div className="flex items-center gap-2">
          <StatusChip tone="neutral">{esRol ? 'Rol' : 'Usuario'}</StatusChip>
          {esRol
            ? <span style={{ color: 'var(--flit-text-primary)' }}>{etiquetaRol(item.rolAfectado ?? '')}</span>
            : item.titular?.username
              ? <span className="font-mono text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{item.titular.username}</span>
              : <span style={{ color: 'var(--flit-text-muted)' }}>usuario eliminado</span>}
        </div>
        <div className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{lineaQue(item, esRol)}</div>
      </td>
      <td className="px-4 py-3 align-top text-sm" style={{ color: 'var(--flit-text-primary)' }}>
        <Cambio item={item} />
        {item.motivo && <div className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>Motivo: {item.motivo}</div>}
      </td>
    </FlitTr>
  );
}

/** Línea 2 de «Qué»: el campo con su etiqueta de negocio, o la acción cuando no hay campo. */
function lineaQue(item: ItemAuditoriaPermisos, esRol: boolean): string {
  const sujeto = esRol ? 'Rol' : 'Usuario';
  const campo = item.campo ? CAMPO_LABELS[item.campo] : null;
  switch (item.accion) {
    case 'crear': return campo ? `${sujeto} creado · ${campo}` : `${sujeto} creado`;
    case 'borrar': return `${sujeto} borrado`;
    case 'baja': return 'Baja';
    case 'reactivar': return 'Reactivación';
    case 'activar':
    case 'desactivar': return 'Estado';
    default: return campo ?? '—';
  }
}

const esConjunto = (v: ValorAuditable | null): v is { conjunto: string[]; concedidas?: string[]; revocadas?: string[] } =>
  typeof v === 'object' && v !== null && Array.isArray(v.conjunto);

function Cambio({ item }: { item: ItemAuditoriaPermisos }) {
  // El hecho sin valor: el CHECK de la 0182 obliga a que sus dos valores sean null. Que no haya
  // «→» es el diseño, no un hueco.
  if (item.campo === 'password') return <span>Contraseña restablecida</span>;
  if (item.accion === 'borrar') {
    return <span><span aria-hidden="true">—</span><span className="sr-only">Sin valor</span></span>;
  }
  if (esConjunto(item.valorDespues)) return <Conjunto antes={item.valorAntes} despues={item.valorDespues} campo={item.campo} />;
  return (
    <span>
      {escalar(item.campo, item.valorAntes)}
      <span style={{ color: 'var(--flit-text-muted)' }}> → </span>
      {escalar(item.campo, item.valorDespues)}
    </span>
  );
}

/** Nunca `true`/`false`/`null` a pantalla: cada campo tiene su literal de negocio. */
function escalar(campo: ItemAuditoriaPermisos['campo'], v: ValorAuditable | null): string {
  if (campo === 'deleted_at') return v === null ? 'En alta' : 'Dado de baja';
  if (v === null || v === undefined) return campo === 'descripcion' ? 'Sin descripción' : '—';
  if (esConjunto(v)) return `${v.conjunto.length} elementos`;
  switch (campo) {
    case 'role': return etiquetaRol(String(v));
    case 'active': return v ? 'Activo' : 'Inactivo';
    case 'activo': return v ? 'Sí' : 'No';
    case 'compania_id': return `Compañía #${v}`;
    case 'flito_proveedor_soat_id': return `Gestor SOAT ${v}`;
    case 'tipo_enlace': return TIPO_ENLACE[String(v)] ?? String(v);
    case 'tipo_principal': return TIPO_PRINCIPAL[String(v)] ?? String(v);
    default: return typeof v === 'boolean' ? (v ? 'Sí' : 'No') : String(v);
  }
}

const MAX_LISTADOS = 12;

/**
 * Diff legible de un conjunto: «Añadidas (n): …» / «Quitadas (n): …» / «Quedan n». La palabra hace
 * el trabajo entero. Un alta (sin antes) lista lo asignado, cortado a 12.
 *
 * Sin tinta de color en los rótulos: la ficha pedía `--flit-success` / `--flit-danger-ink` «si
 * llegan a 4,5:1 sobre la tarjeta en claro y oscuro, y si no, `--flit-text-primary`». Medido:
 * `--flit-success` (#70CF3A) da 1,97 sobre blanco; las tintas `-ink` pasan en claro (5,14 y 5,72)
 * pero no tienen variante oscura y sobre `#1E2F4C` dan 2,61 y 2,35. Se aplica la salida que la
 * ficha dejó escrita.
 */
function Conjunto({ antes, despues, campo }: {
  antes: ValorAuditable | null;
  despues: { conjunto: string[]; concedidas?: string[]; revocadas?: string[] };
  campo: ItemAuditoriaPermisos['campo'];
}) {
  const concedidas = despues.concedidas ?? [];
  const revocadas = despues.revocadas ?? [];
  const etiquetar = (codigos: string[]) => [...codigos].sort().map((c, i) => (
    <span key={c}>{i > 0 && ' · '}<Codigo codigo={c} campo={campo} /></span>
  ));

  if (concedidas.length === 0 && revocadas.length === 0) {
    if (antes !== null) return <span style={{ color: 'var(--flit-text-muted)' }}>Sin cambios en el conjunto</span>;
    const todos = [...despues.conjunto].sort();
    const resto = todos.length - MAX_LISTADOS;
    return (
      <span>
        <span className="font-semibold">Asignadas ({todos.length}):</span> {etiquetar(todos.slice(0, MAX_LISTADOS))}
        {resto > 0 && <span style={{ color: 'var(--flit-text-muted)' }}> … y {resto} más</span>}
      </span>
    );
  }

  return (
    <ul className="space-y-0.5">
      {concedidas.length > 0 && (
        <li><span className="font-semibold">Añadidas ({concedidas.length}):</span> {etiquetar(concedidas)}</li>
      )}
      {revocadas.length > 0 && (
        <li><span className="font-semibold">Quitadas ({revocadas.length}):</span> {etiquetar(revocadas)}</li>
      )}
      <li style={{ color: 'var(--flit-text-muted)' }}>Quedan {despues.conjunto.length}</li>
    </ul>
  );
}

/**
 * La etiqueta si se conoce y el código en monoespaciada si no (ficha UX §5-3). Las páginas se
 * resuelven con `PAGES`; las operaciones no tienen catálogo en el web y se leen como código: cierto,
 * feo, y no falso. Los organismos se pintan tal cual, que es lo que la lista de al lado ya enseña.
 */
function Codigo({ codigo, campo }: { codigo: string; campo: ItemAuditoriaPermisos['campo'] }) {
  if (campo === 'organismos_codigos') return <span>{codigo}</span>;
  const slug = codigo.startsWith('pagina.') ? codigo.slice('pagina.'.length) : codigo;
  const etiqueta = (PAGES as Record<string, string>)[slug];
  if (etiqueta && (campo === 'allowed_pages' || codigo.startsWith('pagina.'))) return <span>{etiqueta}</span>;
  return <code className="font-mono text-xs">{codigo}</code>;
}
