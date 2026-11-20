// Torre de Control (Épica #14590, spec UX §4.1, maqueta `torre-kpi-explicable.html`) — KPI que se explica.
// COMPONE `components/flit/KpiCard` (sin tocarlo ni clonarlo): rótulo, cifra y chip «Foto de hoy» son los del kit; la
// frase, «¿Cómo se calcula?» y «Ver los N» van en su hueco de `children`. Es un `<article>` con dos controles reales (un
// `button` y un `Link`), nunca un control dentro de otro: por eso la tarjeta no lleva `to`.
// Sin «Ver» si la cifra es 0, si el destino no es un conjunto o si falta `torre.detalle.ver` (no se explica por qué).
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { conjuntoTorre, type CifraExplicada, type DestinoCifra } from '@operaciones/shared-types';
import { useAuth } from '../../lib/auth';
import { hasPage } from '../../lib/permissions';
import { rutaDestino, type OrigenPantallaTorre } from '../../lib/torreDetalle';
import KpiCard from '../flit/KpiCard';
import { claseBoton } from '../flit/GradientButton';
import { BotonComoSeCalcula, DefinicionCalculo, ENLACE_KPI, useComoSeCalcula } from './ComoSeCalcula';
import { conteo } from './formatoTorre';

export const FUNCION_TORRE_DETALLE_VER = 'torre.detalle.ver';

/** Bloque ya visible al que lleva un destino `bloque` (ADR-0047 D3) → `id` de su `BloqueTorre`. */
const ANCLA_BLOQUE: Record<string, string> = { fuga: 'bloque-caidas', radar: 'bloque-radar', bolsas: 'bloque-bolsas' };

/** ¿El usuario puede abrir el Detalle? (página y función: sin una de las dos no hay enlace). */
export function usePuedeVerDetalle(): boolean {
  const { user, hasFuncion } = useAuth();
  return hasPage(user, 'torre_detalle') && hasFuncion(FUNCION_TORRE_DETALLE_VER);
}

function irABloque(bloque: string) {
  const el = document.getElementById(ANCLA_BLOQUE[bloque] ?? '');
  if (!el) return;
  el.scrollIntoView({ block: 'start' });
  el.focus({ preventScroll: true });
}

export default function KpiExplicable({
  label, value, explicacion, cantidad, verEtiqueta, nombreLista, volver, vista, pendiente, hintSinExplicacion, children, pie,
}: {
  label: string;
  value: ReactNode;
  explicacion: CifraExplicada | undefined;
  /** Registros del destino («Ver los 12»). Sin él, «Ver cuáles». 0 = sin enlace. */
  cantidad?: number | null;
  /** Texto visible del enlace, sin flecha («Ver los 12 borradores»). */
  verEtiqueta?: string;
  /** Para el `aria-label` del enlace cuando el texto es corto: «borradores abandonados». */
  nombreLista?: string;
  volver: OrigenPantallaTorre;
  /** Subvista del origen a la que vuelve el detalle (`?vista=`). */
  vista?: string;
  pendiente?: boolean;
  /** Si el API aún no trae la explicación de esta cifra: la pista de antes. */
  hintSinExplicacion?: string;
  children?: ReactNode;
  /** Bajo la frase: el desglose con sus propios enlaces (`DesgloseCifra`). */
  pie?: ReactNode;
}) {
  const puedeVer = usePuedeVerDetalle();
  const disc = useComoSeCalcula();
  const destino = explicacion?.destino;
  const foto = destino?.tipo === 'conjunto' && destino.origen.tipo === 'conjunto' && conjuntoTorre(destino.origen.conjunto).fechaBase === null;
  const ruta = puedeVer && cantidad !== 0 ? rutaDestino(destino, { volver, vista }) : null;
  const textoVer = verEtiqueta ?? (cantidad != null ? `Ver los ${conteo(cantidad)}` : 'Ver cuáles');
  const etiquetaAccesible = `${textoVer}: ${nombreLista ?? label.toLowerCase()}`;

  return (
    <article className="grid min-w-0" aria-label={label} onKeyDown={disc.onKeyDown} data-torre="kpi-explicable">
      <KpiCard label={label} value={value} pendiente={pendiente} hint={explicacion ? undefined : hintSinExplicacion}
        chip={foto ? { tone: 'neutral', label: 'Foto de hoy' } : undefined}>
        {children}
        {explicacion && (
          <div className="flex flex-1 flex-col gap-1">
            <p className="m-0 text-xs leading-snug text-[color:var(--color-text-secondary)]" data-torre="frase">{explicacion.frase}</p>
            {pie}
            <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-2" data-torre="kpi-acciones">
              <BotonComoSeCalcula {...disc} />
              {ruta && (
                <Link to={ruta} className={`${ENLACE_KPI} text-[color:var(--color-action)]`} data-torre="ver-registros"
                  aria-label={verEtiqueta ? undefined : etiquetaAccesible}>
                  {textoVer} <span aria-hidden="true">→</span>
                </Link>
              )}
              {!ruta && destino?.tipo === 'bloque' && (
                <button type="button" className={`${ENLACE_KPI} text-[color:var(--color-action)]`} data-torre="ver-bloque"
                  onClick={() => irABloque(destino.bloque)} aria-label={`Ver cuáles en el bloque: ${nombreLista ?? label.toLowerCase()}`}>
                  Ver cuáles <span aria-hidden="true">↓</span>
                </button>
              )}
            </div>
            <DefinicionCalculo id={disc.id} abierto={disc.abierto} definicion={explicacion.definicion} />
          </div>
        )}
      </KpiCard>
    </article>
  );
}

/**
 * «Ver los N» de una fila de bloque (radar, caídas, sin facturar, organismos, niveles de soportes): enlace al conjunto
 * con el segmento de la fila y los filtros actuales (spec §4.2, AC13). No se pone sobre la fila entera. Sin enlace con
 * 0 registros, sin destino de conjunto o sin `torre.detalle.ver`.
 */
export function EnlaceDestino({ destino, cantidad, nombre, volver, vista, texto }: {
  destino: DestinoCifra | undefined;
  cantidad: number;
  /** Para el `aria-label`: «borradores abandonados», «Rentacar Sur». */
  nombre: string;
  volver: OrigenPantallaTorre;
  /** Subvista del origen a la que vuelve el detalle (`?vista=`). */
  vista?: string;
  /** Texto visible; por defecto «Ver los N». */
  texto?: string;
}) {
  const puedeVer = usePuedeVerDetalle();
  const ruta = puedeVer && cantidad > 0 ? rutaDestino(destino, { volver, vista }) : null;
  if (!ruta) return null;
  const visible = texto ?? `Ver los ${conteo(cantidad)}`;
  return (
    <Link to={ruta} className={claseBoton('ghost', 'sm')} aria-label={`${visible}: ${nombre}`} data-torre="ver-registros">
      {visible} <span aria-hidden="true">→</span>
    </Link>
  );
}
