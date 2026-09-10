// HU #12085 — El cuadro del rol seleccionado (columna derecha de la disposición A, ficha §6).
//
// Cabecera del rol → barra de guardado (sticky, SOLO con cambios, antes de los módulos en el DOM
// para que sea la primera parada de tabulador tras la cabecera) → un `FlitAcordeon` por módulo,
// todos plegados al montar. El padre remonta este componente con `key={rol.codigo}` para que el
// estado de apertura no se arrastre de un rol a otro (ficha §6.1).
//
// La casilla (ficha §9): `<label>` envolvente con el nombre visible + `sr-only` «· rol {nombre}»,
// explicación por `aria-describedby`, código técnico SOLO en `data-codigo` (§3). Sin `aria-label`,
// sin `keydown` a mano, sin `role="grid"`.

import { useId, useState } from 'react';
import type { RolCatalogo } from '@operaciones/shared-types';
import type { GrupoDeFunciones } from '../../lib/api';
import FlitAcordeon from '../../components/flit/FlitAcordeon';
import GradientButton from '../../components/flit/GradientButton';
import StatusChip from '../../components/flit/StatusChip';
import { FlitCard, flitBtnSecondary, flitBtnSecondarySm, flitBtnSecondaryStyle } from '../../components/flit/flitPageKit';
import {
  ENLACE_EN_CABECERA, ETIQUETA_ACCESO, desmarcadas, etiquetaModulo, funcionesFueraDelCanal, marcadas,
} from './modulos';

export const COPY_VACIO_ROL_SIN_FUNCIONES =
  'Este rol no tiene ninguna función marcada: quien lo tenga no verá nada al entrar. Abre un módulo y marca lo que deba hacer, o usa «Marcar todas las funciones».';

export const COPY_EXTERNO_GENERAL =
  'Este rol es externo: sus usuarios entran solo al canal de cliente y ven únicamente lo de su compañía. Lo que se marque fuera del canal no lo van a poder ejercer.';

interface Props {
  rol: RolCatalogo;
  grupos: GrupoDeFunciones[];
  /** Nombre de negocio por código, para listar el aviso del servidor sin pintar códigos. */
  nombrePorCodigo: Map<string, string>;
  /** Conjunto guardado (línea base) y conjunto en edición. */
  base: ReadonlySet<string>;
  borrador: ReadonlySet<string>;
  /** Lo que el `PUT` devolvió en `aviso.funciones` para ESTE rol (vacío si no hubo aviso). */
  avisoFueraDelCanal: string[];
  guardando: boolean;
  errorGuardado: string | null;
  onToggle: (codigo: string, marcado: boolean) => void;
  onMarcarConjunto: (codigos: string[], marcar: boolean) => void;
  onGuardar: () => void;
  onDescartar: () => void;
  onEditar: () => void;
  onBorrar: () => void;
}

const STICKY = 'lg:sticky lg:top-[calc(var(--flit-topbar-height)_+_var(--flit-navbar-height)_+_1rem)] z-10';

export default function CuadroRol({
  rol, grupos, nombrePorCodigo, base, borrador, avisoFueraDelCanal, guardando, errorGuardado,
  onToggle, onMarcarConjunto, onGuardar, onDescartar, onEditar, onBorrar,
}: Props) {
  const [abiertos, setAbiertos] = useState<Set<string>>(() => new Set());
  const idMotivo = useId();
  const todas = grupos.flatMap((g) => g.funciones.map((f) => f.codigo));
  const nuevas = [...borrador].filter((c) => !base.has(c)).length;
  const quitadas = [...base].filter((c) => !borrador.has(c)).length;
  const hayCambios = nuevas + quitadas > 0;
  const externo = rol.tipoPrincipal === 'externo';
  const fueraDelCanal = externo ? avisoFueraDelCanal.filter((c) => borrador.has(c)) : [];

  const alternar = (modulo: string) => setAbiertos((prev) => {
    const s = new Set(prev);
    if (s.has(modulo)) s.delete(modulo); else s.add(modulo);
    return s;
  });

  const resumenCambios = [nuevas > 0 ? marcadas(nuevas) : null, quitadas > 0 ? desmarcadas(quitadas) : null]
    .filter(Boolean).join(', ');

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <FlitCard>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-bold" style={{ color: 'var(--flit-blue-text)' }}>{rol.nombre}</h2>
          {externo && <StatusChip tone="warning">Externo</StatusChip>}
          {!rol.activo && <StatusChip tone="draft">Inactivo</StatusChip>}
        </div>
        <p className="mt-1 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          {ETIQUETA_ACCESO[rol.tipoPrincipal]} · {ENLACE_EN_CABECERA[rol.tipoEnlace]} · {rol.usuarios === 1 ? '1 usuario' : `${rol.usuarios} usuarios`}
        </p>
        <p className="mt-2 text-sm" style={{ color: rol.descripcion ? 'var(--flit-text-primary)' : 'var(--flit-text-muted)' }}>
          {rol.descripcion || 'Sin descripción'}
        </p>

        {externo && (
          <p className="mt-3 text-sm font-medium" style={{ color: 'var(--flit-warning-ink)' }}>
            {fueraDelCanal.length > 0
              ? `Este rol es externo: sus usuarios entran solo al canal de cliente y ven únicamente lo de su compañía. Tiene ${funcionesFueraDelCanal(fueraDelCanal.length)} que no va a poder ejercer. Desmárcalas o cambia el tipo de acceso en «Editar rol».`
              : COPY_EXTERNO_GENERAL}
            {fueraDelCanal.length > 0 && (
              <span className="mt-1 block font-normal">
                {fueraDelCanal.map((c) => nombrePorCodigo.get(c) ?? c).join(' · ')}
              </span>
            )}
          </p>
        )}

        {!rol.borrable && rol.motivoNoBorrable && (
          <p id={idMotivo} className="mt-3 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            {rol.motivoNoBorrable}
            {rol.esSistema && ' Si hace falta cambiar su nombre o su descripción, usa «Editar rol».'}
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onEditar}>Editar rol</button>
          <button
            type="button"
            className={flitBtnSecondary}
            style={flitBtnSecondaryStyle}
            disabled={!rol.borrable}
            aria-describedby={!rol.borrable && rol.motivoNoBorrable ? idMotivo : undefined}
            onClick={onBorrar}
          >
            Borrar rol
          </button>
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => onMarcarConjunto(todas, true)}>
            Marcar todas las funciones
          </button>
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => onMarcarConjunto(todas, false)}>
            Desmarcar todas
          </button>
        </div>
      </FlitCard>

      {hayCambios && (
        <div className={STICKY}>
          <FlitCard>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
                Sin guardar: {resumenCambios}
              </p>
              <div className="flex items-center gap-2">
                <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={guardando} onClick={onDescartar}>
                  Descartar
                </button>
                <GradientButton type="button" disabled={guardando} onClick={onGuardar}>
                  {guardando ? 'Guardando…' : 'Guardar cambios'}
                </GradientButton>
              </div>
            </div>
            {errorGuardado && (
              <p role="alert" tabIndex={-1} className="mt-3 text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
                {errorGuardado}
              </p>
            )}
          </FlitCard>
        </div>
      )}

      {borrador.size === 0 && (
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{COPY_VACIO_ROL_SIN_FUNCIONES}</p>
      )}

      {grupos.map((g) => {
        const codigos = g.funciones.map((f) => f.codigo);
        const k = codigos.filter((c) => borrador.has(c)).length;
        const etiqueta = etiquetaModulo(g.modulo);
        return (
          <FlitAcordeon
            key={g.modulo}
            titulo={etiqueta}
            cantidad={g.funciones.length}
            descripcion={`${k} de ${g.funciones.length} marcadas`}
            abierto={abiertos.has(g.modulo)}
            onToggle={() => alternar(g.modulo)}
            // Solo con el módulo abierto: plegado, cada módulo es UNA parada de tabulador (ficha §9).
            accion={abiertos.has(g.modulo) ? (
              <div className="flex shrink-0 gap-2">
                <button type="button" className={flitBtnSecondarySm} style={flitBtnSecondaryStyle} onClick={() => onMarcarConjunto(codigos, true)}>
                  Marcar todas<span className="sr-only"> las funciones de {etiqueta}</span>
                </button>
                <button type="button" className={flitBtnSecondarySm} style={flitBtnSecondaryStyle} onClick={() => onMarcarConjunto(codigos, false)}>
                  Desmarcar todas<span className="sr-only"> las funciones de {etiqueta}</span>
                </button>
              </div>
            ) : undefined}
          >
            <fieldset className="flex flex-col gap-3">
              <legend className="sr-only">Funciones de {etiqueta} para el rol {rol.nombre}</legend>
              {g.funciones.map((f) => (
                <Casilla
                  key={f.codigo}
                  codigo={f.codigo}
                  nombre={f.nombreNegocio}
                  descripcion={f.descripcion}
                  rol={rol.nombre}
                  marcada={borrador.has(f.codigo)}
                  noAplica={externo && borrador.has(f.codigo) && avisoFueraDelCanal.includes(f.codigo)}
                  onToggle={onToggle}
                />
              ))}
            </fieldset>
          </FlitAcordeon>
        );
      })}
    </div>
  );
}

function Casilla({ codigo, nombre, descripcion, rol, marcada, noAplica, onToggle }: {
  codigo: string; nombre: string; descripcion: string | null; rol: string; marcada: boolean; noAplica: boolean;
  onToggle: (codigo: string, marcado: boolean) => void;
}) {
  const idDescripcion = useId();
  return (
    <div>
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          className="flit-focus mt-0.5 h-4 w-4 shrink-0"
          data-codigo={codigo}
          checked={marcada}
          aria-describedby={descripcion ? idDescripcion : undefined}
          onChange={(e) => onToggle(codigo, e.target.checked)}
        />
        <span className="text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>
          {nombre}
          <span className="sr-only"> · rol {rol}</span>
        </span>
        {noAplica && (
          <span className="ml-auto shrink-0 text-[11px] font-semibold uppercase" style={{ color: 'var(--flit-warning-ink)' }}>
            No aplica a roles externos
          </span>
        )}
      </label>
      {descripcion && (
        <p id={idDescripcion} className="ml-7 mt-0.5 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{descripcion}</p>
      )}
    </div>
  );
}
