// Bloque A — ¿a cuántos clientes se les puede facturar? (HU #11299, AC2 y AC3).
//
// FLIT factura UNA sola línea por factura (el trámite digital), así que la pregunta de esta pestaña
// no es «cómo va el alistamiento de seis conceptos» sino **cuántos clientes pueden recibir esa
// factura y qué falta para que los demás también**. Por eso el bloque encabeza con un número y no
// con una tabla: la tabla es la herramienta de ejecución, el número es la de decisión.
//
// El orden de los estados no es casual: **el error va ANTES que el vacío**. Si la consulta falló no
// se sabe si hay algo, y decir «no hay clientes pendientes» sería afirmar lo que nadie comprobó.
//
// ── La tercera cifra ─────────────────────────────────────────────────────────────────────────────
//
// El AC3 nombra tres cifras en la misma frase, y la tercera —cuántos clientes tienen tercero
// vinculado en Siigo— sale de otra ruta y de otra tabla: `GET /siigo/terceros/resumen` mira
// `siigo_terceros`, no `clients`. Por eso se pide **en paralelo y con estado propio**, no dentro
// del `try` de la otra: que se caiga el conteo de terceros no es motivo para dejar de decir a
// cuántos se les puede facturar, ni al revés. `totalClientes` es el mismo universo que
// `resumen.total` —criterio compartido en el servidor—, así que la tarjeta nunca pinta dos totales.
//
// **Esa cifra no tiene listado propio, y es deliberado.** Decir QUIÉN está vinculado costaría una
// petición por cliente, que es justo el descarte nº 6 del diseño de UX
// (`docs/ux/siigo-terceros-revision-sincronizacion.md`, también §R3-b). Así que «cada cifra lleva
// al listado que la compone» se cumple llevando al bloque D de sincronización, que es el único
// sitio donde ese número se mueve: allí se crean y se vinculan los terceros. El botón lo dice con
// esas palabras —«Ir a sincronizar terceros», no «ver los vinculados»— para no prometer una lista
// que no existe.

import { useCallback, useEffect, useState } from 'react';
import {
  MOTIVOS_NO_FACTURABLE,
  type MotivoNoFacturable,
  type ResumenTerceros,
  type ResumenValidacionClientes,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../../../lib/api';
import { FlitCard, FlitPillButton, FlitPillGroup, flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import { ETIQUETA_CORTA_MOTIVO } from './tipos';

interface Props {
  /** Cambia cuando algo de la pestaña pudo mover la cartera (una ficha guardada, una ciudad). */
  version: number;
  motivo: MotivoNoFacturable | null;
  onMotivo: (motivo: MotivoNoFacturable | null) => void;
  /** AC3 — «cada cifra lleva al listado que la compone». */
  onIrAPendientes: () => void;
  onIrASincronizar: () => void;
  /** Para que el bloque B sepa si tiene que pintarse: con 0 no facturables no hay lista. */
  onResumen: (resumen: ResumenValidacionClientes | null) => void;
}

export default function ResumenFacturabilidad({
  version, motivo, onMotivo, onIrAPendientes, onIrASincronizar, onResumen,
}: Props) {
  const [resumen, setResumen] = useState<ResumenValidacionClientes | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [terceros, setTerceros] = useState<ResumenTerceros | null>(null);
  const [cargandoTerceros, setCargandoTerceros] = useState(true);
  const [errorTerceros, setErrorTerceros] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const r = await api.get<ResumenValidacionClientes>('/siigo/clientes/validacion');
      setResumen(r);
      onResumen(r);
    } catch (e) {
      // El fallo se pinta, no se registra: la respuesta lleva conteos, pero el mensaje del servidor
      // puede llevar cualquier cosa y la consola del navegador no es sitio para datos de clientes.
      setError(errorMessage(e));
      setResumen(null);
      onResumen(null);
    } finally {
      setCargando(false);
    }
  }, [onResumen]);

  const cargarTerceros = useCallback(async () => {
    setCargandoTerceros(true);
    setErrorTerceros(null);
    try {
      const r = await api.get<ResumenTerceros>('/siigo/terceros/resumen');
      setTerceros(r);
    } catch (e) {
      // Mismo criterio que arriba: el fallo se pinta y no se registra.
      setErrorTerceros(errorMessage(e));
      setTerceros(null);
    } finally {
      setCargandoTerceros(false);
    }
  }, []);

  // Dos efectos, no uno encadenado: las dos peticiones salen juntas y ninguna espera a la otra.
  useEffect(() => { void cargar(); }, [cargar, version]);
  useEffect(() => { void cargarTerceros(); }, [cargarTerceros, version]);

  return (
    <FlitCard>
      <h3 className="text-base font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        ¿A cuántos se les puede facturar?
      </h3>

      {cargando && (
        // El bloque reserva alto para que la lista de abajo no salte cuando llegue el dato.
        <p role="status" className="mt-3 min-h-[4rem] text-sm" style={{ color: 'var(--flit-text-muted)' }}>
          Revisando la cartera…
        </p>
      )}

      {!cargando && error !== null && (
        <div className="mt-3">
          <p role="alert" className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
            <span aria-hidden="true" style={{ color: 'var(--flit-danger)' }}>⚠ </span>
            No se pudo revisar la cartera: {error}
          </p>
          <button
            type="button"
            onClick={() => { void cargar(); }}
            className={`${flitBtnSecondary} mt-3`}
            style={flitBtnSecondaryStyle}
          >
            Reintentar
          </button>
        </div>
      )}

      {!cargando && error === null && resumen !== null && resumen.total === 0 && (
        <p className="mt-3 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
          No hay clientes activos. Facturación electrónica no tiene a quién facturarle todavía.
        </p>
      )}

      {!cargando && error === null && resumen !== null && resumen.total > 0 && resumen.noFacturables === 0 && (
        <p role="status" className="mt-3 text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
          Los {resumen.total} clientes activos pueden recibir factura electrónica. No hay nada que
          corregir aquí.
        </p>
      )}

      {!cargando && error === null && resumen !== null && resumen.noFacturables > 0 && (
        <div className="mt-3 space-y-3">
          <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
            <strong>{resumen.total}</strong> clientes activos ·{' '}
            <strong>{resumen.facturables}</strong> pueden recibir factura electrónica
          </p>

          {/* Decorativa: el dato está en la frase de arriba, y una barra que hay que interpretar no
              es información para quien no la ve. */}
          <div aria-hidden="true" className="h-2 w-full overflow-hidden rounded-full" style={{ background: 'var(--flit-bg-app)' }}>
            <div
              className="h-full"
              style={{
                width: `${Math.round((resumen.facturables / resumen.total) * 100)}%`,
                background: 'var(--flit-gradient-primary)',
              }}
            />
          </div>

          <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
            {resumen.noFacturables} no pueden todavía, y de esos {resumen.pendientesClasificacion}{' '}
            esperan una decisión, no un dato.
          </p>

          {/* AC3 — cada cifra lleva a su listado. Sin identificadores en la URL: son saltos de foco
              dentro de la misma pantalla. */}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={onIrAPendientes} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>
              Ver los {resumen.noFacturables} que no pueden todavía
            </button>
            <button type="button" onClick={onIrASincronizar} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>
              Ver los {resumen.facturables} que se pueden sincronizar
            </button>
          </div>

          {resumen.porMotivo.length > 0 && (
            <div>
              <p id="por-donde-empezar" className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
                Por dónde empezar:
              </p>
              {/* El ORDEN es el del servidor (por cantidad, descendente, y solo los que tienen
                  clientes). La pantalla no reordena ni recalcula nada. */}
              <div className="mt-2">
                <FlitPillGroup>
                  {resumen.porMotivo.map((m) => (
                    <FlitPillButton
                      key={m.motivo}
                      active={motivo === m.motivo}
                      pressed={motivo === m.motivo}
                      onClick={() => onMotivo(motivo === m.motivo ? null : m.motivo)}
                    >
                      {/* El rótulo corto se ve; la frase completa se anuncia. */}
                      <span aria-hidden="true">{ETIQUETA_CORTA_MOTIVO[m.motivo]} {m.clientes}</span>
                      <span className="sr-only">
                        {MOTIVOS_NO_FACTURABLE[m.motivo]} {m.clientes} clientes
                      </span>
                    </FlitPillButton>
                  ))}
                </FlitPillGroup>
              </div>
              <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
                Un cliente puede aparecer en varias líneas: resolver una causa no siempre lo
                desbloquea.
              </p>
            </div>
          )}
        </div>
      )}

      {/* AC3 — la tercera cifra. Vive en la misma tarjeta que las otras dos porque responde la misma
          pregunta de negocio, pero en su propio bloque: su dato viene de otra ruta y puede faltar
          cuando las otras dos están. También aquí el error va antes que el vacío. */}
      <div className="mt-4 border-t pt-3" style={{ borderColor: 'var(--flit-border-input)' }}>
        {cargandoTerceros && (
          <p role="status" className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>
            Contando los terceros ya vinculados…
          </p>
        )}

        {!cargandoTerceros && errorTerceros !== null && (
          <div>
            <p role="alert" className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
              <span aria-hidden="true" style={{ color: 'var(--flit-danger)' }}>⚠ </span>
              No se pudo contar los terceros vinculados en Siigo: {errorTerceros}
            </p>
            {/* Nombre propio, y no otro «Reintentar» a secas: en esta tarjeta puede haber dos
                botones de reintento a la vez, uno por cifra caída. */}
            <button
              type="button"
              onClick={() => { void cargarTerceros(); }}
              className={`${flitBtnSecondary} mt-3`}
              style={flitBtnSecondaryStyle}
            >
              Reintentar el conteo de terceros
            </button>
          </div>
        )}

        {!cargandoTerceros && errorTerceros === null && terceros !== null && terceros.totalClientes === 0 && (
          <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
            Todavía no hay clientes activos a los que vincularles un tercero en Siigo.
          </p>
        )}

        {!cargandoTerceros && errorTerceros === null && terceros !== null && terceros.totalClientes > 0 && (
          <div className="space-y-3">
            {terceros.conTercero === 0 ? (
              // El cero no es «no hay dato»: es una cartera entera sin puente con Siigo, y lo que
              // falta por hacer se dice en la misma frase.
              <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
                Ninguno de los {terceros.totalClientes} clientes activos tiene todavía tercero
                vinculado en Siigo: el vínculo se crea al sincronizar.
              </p>
            ) : (
              <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
                <strong>{terceros.conTercero}</strong> de los {terceros.totalClientes} clientes
                activos ya tienen tercero vinculado en Siigo.
              </p>
            )}

            {/* Lleva al bloque D, no a un listado de vinculados: ver la cabecera del archivo. */}
            <button type="button" onClick={onIrASincronizar} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>
              Ir a sincronizar terceros
            </button>
          </div>
        )}
      </div>
    </FlitCard>
  );
}
