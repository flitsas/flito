// HU #12085 → HU #13430 (Feature #13416) — El cuadro del rol seleccionado (columna derecha de la
// disposición A): cabecera del rol → barra «Sin guardar» → tarjeta con el árbol de tres niveles.
//
// Diseño: `docs/ux/hu-13430-delta-contrato-arbol.md` (manda) y `docs/ux/hu-13430-panel-tres-niveles.md`.
// Sustituye las secciones por origen (#12533) y la dependencia pantalla → acciones (#12717): ahora
// hay UNA regla en todo el árbol, la conservación (desmarcar un padre no borra a sus hijos).
//
// Barra «Sin guardar»: SOLO con cambios; sticky arriba en ≥ lg y abajo en < lg (para que la primaria
// no quede lejos en un árbol largo). El 409 anti-bloqueo y cualquier error de guardado viven en ella
// (`role="alert"`, nunca toast, nunca el texto del API).
//
// AC6: sin «asignar» (`permisos.cuadro.guardar`) el árbol es de solo lectura — casillas `disabled` con
// el nombre en tinta normal, sin «Marcar todo / Desmarcar todo» ni barra. Editar / borrar el rol, cada
// uno con su acción. AC7: `admin` no tiene trato especial aquí, salvo las funciones exclusivas del
// Administrador (HU #13951): fijas en `admin`, bloqueadas en los demás roles.
//
// Rediseño 2026 (Épica #14560, molde `vRbac()`): cabecera del rol como `card__cabeza`, «Borrar rol» en
// naranja (`alerta`) y el árbol bajo un encabezado de matriz (fondo `--kit-linea`).

import { useEffect, useMemo, useRef } from 'react';
import type { RolCatalogo } from '@operaciones/shared-types';
import GradientButton from '../../components/flit/GradientButton';
import StatusChip from '../../components/flit/StatusChip';
import { FlitCard, flitBtnSecondarySm, flitBtnSecondaryStyle } from '../../components/flit/flitPageKit';
import { ETIQUETA_ENLACE, desmarcadas, marcadas, notaCerradoPorEnlace } from './modulos';
import {
  cerradosPorEnlace, codigosDesmarcarTodo, codigosExclusivos, codigosMarcarTodo, tratoExclusivasDe, type Aviso409, type Indice, type Nodo,
} from './arbol';
import ArbolPermisos, { type FocoArbol } from './ArbolPermisos';
import { useFabOffset } from '../../components/drflit/useFabOffset';

export const COPY_SOLO_LECTURA =
  'Solo lectura: puedes consultar los permisos de cada rol, pero no cambiarlos. Para cambiarlos hace falta la acción «Asignar permisos» de Roles y permisos.';
export const COPY_VACIO_ROL =
  'Este rol no tiene nada marcado: quien lo tenga no verá ningún elemento del menú al entrar. Marca los elementos y lo que deba usar dentro de cada uno, o usa «Marcar todo».';
export const COPY_VACIO_ROL_LECTURA = 'Este rol no tiene nada marcado: quien lo tenga no verá ningún elemento del menú al entrar.';

const SECUNDARIO = { color: 'var(--color-text-secondary)' } as const;

export interface PermisosPantalla { guardar: boolean; editar: boolean; borrar: boolean }

interface Props {
  rol: RolCatalogo;
  arbol: readonly Nodo[];
  indice: Indice;
  base: ReadonlySet<string>;
  borrador: ReadonlySet<string>;
  guardando: boolean;
  errorGuardado: Aviso409 | null;
  permisos: PermisosPantalla;
  usarEfectivoServidor: boolean;
  foco: FocoArbol | null;
  /** Cambia tras un guardado OK: el foco vuelve al nombre del rol (la barra desaparece). */
  guardadoToken: number;
  onToggle: (codigo: string) => void;
  onConjunto: (codigos: string[], marcar: boolean) => void;
  onMostrarDonde: (codigo: string) => void;
  onGuardar: () => void;
  onDescartar: () => void;
  onEditar: () => void;
  onBorrar: () => void;
}

const BARRA = 'sticky bottom-0 z-10 lg:bottom-auto lg:top-[calc(var(--kit-alto-barra)_+_1rem)]';

export default function CuadroRol({
  rol, arbol, indice, base, borrador, guardando, errorGuardado, permisos, usarEfectivoServidor, foco,
  guardadoToken, onToggle, onConjunto, onMostrarDonde, onGuardar, onDescartar, onEditar, onBorrar,
}: Props) {
  const tituloRef = useRef<HTMLHeadingElement>(null);
  const avisoRef = useRef<HTMLParagraphElement>(null);
  // HU #13764: barra pegada al pie en <lg → el botón de Dr. Flit sube por encima de ella.
  const barraRef = useRef<HTMLDivElement>(null);
  const editable = permisos.guardar;
  const nuevas = [...borrador].filter((c) => !base.has(c)).length;
  const quitadas = [...base].filter((c) => !borrador.has(c)).length;
  const hayCambios = editable && nuevas + quitadas > 0;
  useFabOffset(barraRef, hayCambios);
  const resumenCambios = [nuevas > 0 ? marcadas(nuevas) : null, quitadas > 0 ? desmarcadas(quitadas) : null].filter(Boolean).join(', ');
  const modo = useMemo(() => ({ tipo: 'rol' as const, rolNombre: rol.nombre }), [rol.nombre]);

  useEffect(() => { if (guardadoToken > 0) tituloRef.current?.focus(); }, [guardadoToken]);
  useEffect(() => { if (errorGuardado) avisoRef.current?.focus(); }, [errorGuardado]);

  const conElemento = arbol.some((n) => !n.derivado && borrador.has(n.codigo));
  const vacio = conElemento ? null : editable ? COPY_VACIO_ROL : COPY_VACIO_ROL_LECTURA;
  const todos = arbol;
  // HU #13452: lo que el enlace del rol cierra se pinta deshabilitado y «Marcar todo» no lo marca.
  const cerrados = useMemo(() => cerradosPorEnlace(arbol, rol.tipoEnlace), [arbol, rol.tipoEnlace]);
  const idMotivo = `motivo-rol-${rol.codigo}`;
  // HU #13951: «Marcar todo» se salta las exclusivas en otro rol; «Desmarcar todo», en el Administrador.
  const trato = tratoExclusivasDe(rol.codigo);
  const exclusivas = useMemo(() => codigosExclusivos(indice), [indice]);
  const marcarTodo = () => onConjunto(codigosMarcarTodo(todos).filter((c) => !cerrados.has(c) && !(trato === 'fuera' && exclusivas.has(c))), true);
  const desmarcarTodo = () => onConjunto(codigosDesmarcarTodo(todos).filter((c) => !(trato === 'fija' && exclusivas.has(c))), false);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <FlitCard>
        <div className="flex flex-wrap items-center gap-2">
          <h2 ref={tituloRef} tabIndex={-1} className="flit-focus rounded text-xl font-semibold" style={{ color: 'var(--color-text-primary)' }}>{rol.nombre}</h2>
          {!rol.activo && <StatusChip tone="draft">Inactivo</StatusChip>}
        </div>
        <p className="mt-1 text-sm" style={{ color: 'var(--color-text-tertiary)' }}>
          Enlace: {ETIQUETA_ENLACE[rol.tipoEnlace]} · {rol.usuarios === 1 ? '1 usuario' : `${rol.usuarios} usuarios`}
        </p>
        <p className="mt-2 text-sm" style={{ color: rol.descripcion ? 'var(--color-text-primary)' : 'var(--color-text-secondary)' }}>
          {rol.descripcion || 'Sin descripción'}
        </p>
        {permisos.borrar && !rol.borrable && rol.motivoNoBorrable && (
          <p id={idMotivo} className="mt-3 text-sm" style={SECUNDARIO}>
            {rol.motivoNoBorrable}
            {rol.esSistema && permisos.editar && ' Si hace falta cambiar su nombre o su descripción, usa «Editar rol».'}
          </p>
        )}
        {(permisos.editar || permisos.borrar) && (
          <div className="mt-4 flex flex-wrap gap-2">
            {permisos.editar && <GradientButton type="button" variant="secondary" onClick={onEditar}>Editar rol</GradientButton>}
            {permisos.borrar && (
              <GradientButton
                type="button"
                variant="alerta"
                disabled={!rol.borrable}
                aria-describedby={!rol.borrable && rol.motivoNoBorrable ? idMotivo : undefined}
                onClick={onBorrar}
              >
                Borrar rol
              </GradientButton>
            )}
          </div>
        )}
      </FlitCard>

      {hayCambios && (
        <div ref={barraRef} className={BARRA}>
          <FlitCard className="!border-[var(--color-action)]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>Sin guardar: {resumenCambios}</p>
              <div className="flex flex-wrap items-center gap-2">
                <GradientButton type="button" variant="secondary" disabled={guardando} onClick={onDescartar}>Descartar</GradientButton>
                <GradientButton type="button" disabled={guardando} onClick={onGuardar}>{guardando ? 'Guardando…' : 'Guardar cambios'}</GradientButton>
              </div>
            </div>
            {errorGuardado && (
              <div className="mt-3 flex flex-wrap items-start gap-3">
                <p ref={avisoRef} role="alert" tabIndex={-1} className="flit-focus min-w-0 flex-[1_1_16rem] rounded text-sm" style={{ color: 'var(--kit-rojo-texto)' }}>
                  {errorGuardado.texto}
                </p>
                {errorGuardado.nodo && (
                  <button type="button" className={flitBtnSecondarySm} style={flitBtnSecondaryStyle} onClick={() => onMostrarDonde(errorGuardado.nodo as string)}>
                    Mostrar dónde está
                  </button>
                )}
              </div>
            )}
          </FlitCard>
        </div>
      )}

      <FlitCard className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-[9px] px-3 py-2" style={{ background: 'var(--kit-linea)' }}>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>Permisos del rol</h3>
          {editable && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={flitBtnSecondarySm} style={flitBtnSecondaryStyle} onClick={marcarTodo}>
                Marcar todo<span className="sr-only"> en el rol {rol.nombre}</span>
              </button>
              <button type="button" className={flitBtnSecondarySm} style={flitBtnSecondaryStyle} onClick={desmarcarTodo}>
                Desmarcar todo<span className="sr-only"> en el rol {rol.nombre}</span>
              </button>
            </div>
          )}
        </div>
        {!editable && <p role="status" className="mb-3 text-sm" style={SECUNDARIO}>{COPY_SOLO_LECTURA}</p>}
        {vacio && <p className="mb-3 text-sm" style={SECUNDARIO} data-aviso="rol-vacio">{vacio}</p>}
        <ArbolPermisos
          arbol={arbol}
          indice={indice}
          marcados={borrador}
          modo={modo}
          editable={editable}
          onToggle={onToggle}
          onConjunto={onConjunto}
          foco={foco}
          usarEfectivoServidor={usarEfectivoServidor}
          cerrados={cerrados}
          notaCerrado={cerrados.size > 0 ? notaCerradoPorEnlace(rol.tipoEnlace) : undefined}
          exclusivas={trato}
        />
      </FlitCard>
    </div>
  );
}
