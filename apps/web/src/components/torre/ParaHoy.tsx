// Torre de Control (Épica #14590, B6) — «Para hoy» y «Lo que cambió en el periodo» del Resumen 360° (spec UX molde §7,
// B6.1–B6.3, maqueta `docs/ux/mockups/torre-360-para-hoy.html`). «Para hoy» reemplaza a «Los 5 riesgos de hoy»: fila =
// gravedad con texto · cifra · frase · enlace de texto (la fila no se pulsa entera). Máx. 8 visibles; el resto tras un
// disclosure con `aria-expanded`. Los frentes llegan ya ordenados, con cifra > 0 y filtrados por permisos.
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import type { FrenteTorre, HallazgoTorre } from '@operaciones/shared-types';
import { useAuth } from '../../lib/auth';
import { hasPage, type PageSlug } from '../../lib/permissions';
import { rutaDestino } from '../../lib/torreDetalle';
import StatusChip from '../flit/StatusChip';
import { BloqueTorre } from './PaginaTorre';
import { usePuedeVerDetalle } from './KpiExplicable';
import { ENLACE_KPI } from './ComoSeCalcula';
import { conteo } from './formatoTorre';

const VISIBLES = 8;
/** Conjuntos cuyo sustantivo es femenino («Ver las N»): gestiones, bolsas, solicitudes, actas, facturas, boletas. */
const FEMENINOS = new Set([
  'soat_sin_gestion', 'impuesto_sin_gestion', 'bolsas_cobertura', 'bolsas_agotadas', 'soat_incompletas_abiertas',
  'actas_pendientes_entrega', 'facturas_rechazadas_dian', 'facturas_con_error', 'boletas_con_diferencia',
]);
/** «Revisar» de un frente de bloque: el área y el bloque al que lleva el foco (`#id` del `BloqueTorre`). */
const BLOQUE_REVISAR: Record<string, { to: string; slug: PageSlug }> = {
  fuga: { to: '/flito/torre/comercial#bloque-caidas', slug: 'torre_comercial' },
};
const ENLACE = `${ENLACE_KPI} text-[color:var(--color-action)]`;

function AccionFrente({ f }: { f: FrenteTorre }) {
  const { user } = useAuth();
  const puedeVer = usePuedeVerDetalle();
  if (f.accion === 'revisar' && f.destino.tipo === 'bloque') {
    const b = BLOQUE_REVISAR[f.destino.bloque];
    if (!b || !hasPage(user, b.slug)) return null;
    return <Link to={b.to} className={ENLACE} aria-label={`Revisar: ${conteo(f.cifra)} ${f.frase}`} data-torre="frente-revisar">Revisar <span aria-hidden="true">→</span></Link>;
  }
  const ruta = puedeVer ? rutaDestino(f.destino, { volver: '360', ...(f.rango?.preset === 'mes' ? { periodoFijo: 'mes' as const } : {}) }) : null;
  if (!ruta) return null;
  const texto = `Ver ${f.conjunto && FEMENINOS.has(f.conjunto) ? 'las' : 'los'} ${conteo(f.cifra)}`;
  return <Link to={ruta} className={ENLACE} aria-label={`${texto}: ${f.frase}`} data-torre="frente-ver">{texto} <span aria-hidden="true">→</span></Link>;
}

function FilaFrente({ f }: { f: FrenteTorre }) {
  return (
    <li className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 rounded-[9px] border border-[color:var(--color-border)] px-4 py-3 lg:grid-cols-[7.5rem_3.5rem_1fr_auto]"
      data-torre="frente" data-clave={f.clave}>
      <span><StatusChip tone={f.severidad === 'critico' ? 'danger' : 'warning'}>{f.severidad === 'critico' ? 'Crítico' : 'Atención'}</StatusChip></span>
      <strong className="text-xl tabular-nums lg:text-right">{conteo(f.cifra)}</strong>
      <span className="col-span-2 min-w-0 lg:col-span-1">{f.frase}</span>
      <span className="col-span-2 lg:col-span-1 lg:justify-self-end"><AccionFrente f={f} /></span>
    </li>
  );
}

export function ParaHoy({ frentes }: { frentes: FrenteTorre[] }) {
  const [abierto, setAbierto] = useState(false);
  const idResto = useId();
  const n = frentes.length;
  const titulo = n === 0 ? 'Para hoy: nada por atender' : `Para hoy: hay ${conteo(n)} ${n === 1 ? 'frente' : 'frentes'} por atender`;
  const resto = frentes.slice(VISIBLES);
  return (
    <BloqueTorre idPrueba="bloque-para-hoy" titulo={titulo}
      subtitulo={n === 0 ? undefined : 'Ordenados por gravedad y luego por cuántos registros tocan.'}
      accion={<StatusChip tone="neutral">Foto de hoy</StatusChip>}>
      {n === 0
        ? <p className="m-0 text-[color:var(--color-text-secondary)]">Hoy ninguna cifra pasa su umbral. Las cifras de cada área siguen en sus pestañas.</p>
        : (
          <>
            <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Frentes por atender">
              {frentes.slice(0, VISIBLES).map((f) => <FilaFrente key={f.clave} f={f} />)}
            </ul>
            {resto.length > 0 && (
              <>
                {abierto && (
                  <ul id={idResto} className="m-0 mt-2 flex list-none flex-col gap-2 p-0" aria-label="Frentes restantes">
                    {resto.map((f) => <FilaFrente key={f.clave} f={f} />)}
                  </ul>
                )}
                <button type="button" className={`${ENLACE} mt-3`} aria-expanded={abierto} aria-controls={abierto ? idResto : undefined}
                  onClick={() => setAbierto((v) => !v)} data-torre="frentes-restantes">
                  {abierto ? 'Ver menos frentes' : `Ver los ${conteo(resto.length)} ${resto.length === 1 ? 'frente restante' : 'frentes restantes'}`}
                  <span aria-hidden="true"> {abierto ? '▴' : '▾'}</span>
                </button>
              </>
            )}
          </>
        )}
    </BloqueTorre>
  );
}

/** Esqueleto con la estructura de la fila (chip · cifra · frase · enlace), 4 filas. */
export function EsqueletoParaHoy() {
  return (
    <section className="card" aria-busy="true" data-torre="bloque-para-hoy" data-estado="cargando">
      <div className="kit-esqueleto mb-3 h-6 w-1/2" aria-hidden="true" />
      <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="grid grid-cols-[auto_1fr] items-center gap-3 rounded-[9px] border border-[color:var(--color-border)] px-4 py-3 lg:grid-cols-[7.5rem_3.5rem_1fr_auto]">
            <span className="kit-esqueleto h-6 w-24" />
            <span className="kit-esqueleto h-6 w-10" />
            <span className="kit-esqueleto col-span-2 h-5 lg:col-span-1" />
            <span className="kit-esqueleto col-span-2 h-5 w-20 lg:col-span-1" />
          </li>
        ))}
      </ul>
    </section>
  );
}

const AREA_HALLAZGO: Record<HallazgoTorre['area'], { etiqueta: string; slug: PageSlug; to: string }> = {
  comercial: { etiqueta: 'Comercial', slug: 'torre_comercial', to: '/flito/torre/comercial' },
  financiera: { etiqueta: 'Financiera', slug: 'torre_financiera', to: '/flito/torre/financiera' },
  logistica: { etiqueta: 'Logística', slug: 'torre_logistica', to: '/flito/torre/logistica' },
  productos: { etiqueta: 'Productos', slug: 'torre_productos', to: '/flito/torre/productos' },
};

/** «Lo que cambió en el periodo»: frases en texto normal, cada una con «Ver en <área> →». Sin hallazgos, no se pinta. */
export function Hallazgos({ hallazgos }: { hallazgos: HallazgoTorre[] }) {
  const { user } = useAuth();
  if (hallazgos.length === 0) return null;
  return (
    <BloqueTorre idPrueba="bloque-hallazgos" titulo="Lo que cambió en el periodo">
      <ul className="m-0 flex list-disc flex-col gap-2 pl-5">
        {hallazgos.map((h) => {
          const a = AREA_HALLAZGO[h.area];
          return (
            <li key={h.regla} data-torre="hallazgo" data-regla={h.regla}>
              {h.frase}{' '}
              {hasPage(user, a.slug) && (
                <Link to={h.vista ? `${a.to}?vista=${encodeURIComponent(h.vista)}` : a.to} className={ENLACE}>
                  Ver en {a.etiqueta} <span aria-hidden="true">→</span>
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </BloqueTorre>
  );
}
