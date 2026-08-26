// Facturación electrónica — pestaña «Terceros»: revisar y sincronizar (HU #11299, Feature #11241).
//
// Cuatro bloques, y **el orden es el orden en que se trabaja**: se corrige el dato (A y B) → se
// confirma la ciudad (C) → se sincroniza (D). No es decorativo. Sincronizar primero produce
// fallidos evitables que gastan cuota de la ventana que se comparte con la emisión de facturas.
//
// Reutiliza ruta, slug (`siigo_parametrizacion`) y guarda de la pantalla que la aloja: sin ítem de
// menú nuevo, sin `PageSlug` nuevo y sin migración de otorgamientos.
//
// ── Datos personales (AGENTS.md §14, Ley 1581) ────────────────────────────────────────────────
//   1. **Nada de PII en la URL del SPA.** Lo único que llega a la query es `?seccion=terceros`. El
//      filtro por motivo, la página, la selección de clientes y el resultado de la sincronización
//      viven en estado de React. `?motivo=` existe, pero solo en la petición al API, y es un código
//      de catálogo.
//   2. **Ninguna búsqueda por nombre ni por documento contra el servidor**: sería un parámetro con
//      PII en un query string que acaba en los logs del proxy.
//   3. **Nombre y documento se muestran** —son la identidad operativa del tercero y los dos roles ya
//      los leen en Clientes— **pero no se registran**: ni un `console.log` con la fila, el veredicto
//      o la respuesta. Los errores se pintan con `errorMessage(e)` y nada más.
//
// ── Permisos (AC1) ────────────────────────────────────────────────────────────────────────────
// **Dos capacidades, no una.** Sincronizar terceros lo hacen administración y financiera; confirmar
// una equivalencia de ciudad, solo administración. Cada bloque recibe la suya y ninguna se deriva
// de la otra: mientras las dos colgaron de un único `esAdmin`, la pantalla le negó a financiera una
// escritura que el servidor le concedía desde el primer día. Ver `BotonAccion.tsx`: ahí está
// escrito por qué esto es una guía de interfaz y NO un control de seguridad.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  puedeEjecutar,
  type MotivoNoFacturable, type ResumenValidacionClientes,
} from '@operaciones/shared-types';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import FichaFiscal from '../clientes/FichaFiscal';
import EquivalenciasCiudad from './terceros/EquivalenciasCiudad';
import ListaNoFacturables from './terceros/ListaNoFacturables';
import ResumenFacturabilidad from './terceros/ResumenFacturabilidad';
import SincronizacionTerceros from './terceros/SincronizacionTerceros';

const ID_EXPLICACION_SINCRONIZAR = 'permiso-sincronizacion';

/** Lo que el SERVIDOR tiene configurado, sin el selector de ambiente de la cabecera. */
interface CompuertaServidor {
  ambiente: string;
  modo: string;
}

export default function PanelTerceros() {
  const { user } = useAuth();
  const esAdmin = user?.role === 'admin';
  /**
   * Una entrada por acción, y al lado la guarda del servidor que refleja. No es seguridad —el 403
   * lo da el servidor— pero tiene que decir LO MISMO que él: un solo booleano para acciones que el
   * servidor distingue termina, según hacia dónde se equivoque, negando lo que el endpoint acepta
   * (lo que pasaba con financiera y la sincronización) u ofreciendo lo que va a rechazar.
   *
   * Tres de las cuatro coinciden hoy en `esAdmin` y aun así se declaran aparte: cuando una cambie
   * —esta HU es el precedente— se moverá sola, sin arrastrar a las otras.
   */
  const permisos = {
    /** `POST /siigo/terceros/cliente/:id` → `exigirAccionSiigo('emitir')`. Se lee de la MISMA tabla
     *  que usa el servidor, así que cambiarla mueve las dos a la vez. */
    sincronizar: puedeEjecutar(user?.role, 'emitir'),
    /** `POST /siigo/clientes-ciudades/:id/confirmar` → `requireRole('admin')`, y con razón: fija el
     *  municipio que sale impreso en la factura ante la DIAN. */
    confirmarCiudad: esAdmin,
    /** `POST /siigo/clientes/validacion/recalcular-duplicados` → `requireRole('admin')`. Reescribe
     *  las marcas de identificación de las fichas; no es «parte de sincronizar». */
    recalcularDuplicados: esAdmin,
    /** `PATCH /clients/:id` → `requireRole('admin')`. Financiera abre la ficha en solo lectura. */
    editarFicha: esAdmin,
  };

  /** Sube cada vez que algo pudo mover la cartera: una ficha guardada, una ciudad, un tercero. */
  const [version, setVersion] = useState(0);
  const [motivo, setMotivo] = useState<MotivoNoFacturable | null>(null);
  const [resumen, setResumen] = useState<ResumenValidacionClientes | null>(null);
  const [ficha, setFicha] = useState<{ clienteId: number; nombre: string } | null>(null);
  const [servidor, setServidor] = useState<CompuertaServidor | null>(null);

  const tituloPendientes = useRef<HTMLHeadingElement>(null);
  const tituloSincronizacion = useRef<HTMLHeadingElement>(null);

  // SIN parámetro de ambiente: así devuelve el del servidor, que es el único contra el que se
  // sincronizan terceros (`asegurarTercero` lee `env.SIIGO_AMBIENTE` y no acepta otro).
  useEffect(() => {
    let vivo = true;
    void (async () => {
      try {
        const r = await api.get<CompuertaServidor>('/siigo/compuerta');
        if (vivo) setServidor(r);
      } catch {
        // Sin esto el bloque D pinta «—» como ambiente. Es peor callarlo que no saberlo, pero no
        // justifica tumbar la pestaña: los otros tres bloques no dependen de la compuerta.
        if (vivo) setServidor(null);
      }
    })();
    return () => { vivo = false; };
  }, []);

  const recargar = useCallback(() => setVersion((v) => v + 1), []);
  const abrirFicha = useCallback(
    (clienteId: number, nombre: string) => setFicha({ clienteId, nombre }), [],
  );

  const simulado = servidor?.modo === 'mock';
  const hayPendientes = resumen === null || resumen.noFacturables > 0;

  return (
    <div className="space-y-5">
      <ResumenFacturabilidad
        version={version}
        motivo={motivo}
        onMotivo={setMotivo}
        onResumen={setResumen}
        onIrAPendientes={() => tituloPendientes.current?.focus()}
        onIrASincronizar={() => tituloSincronizacion.current?.focus()}
      />

      {/* Con la cartera entera lista no hay lista que pintar: el resumen ya lo dice arriba. */}
      {hayPendientes && (
        <ListaNoFacturables
          version={version}
          motivo={motivo}
          onQuitarFiltro={() => setMotivo(null)}
          puedeSincronizar={permisos.sincronizar}
          puedeRecalcularDuplicados={permisos.recalcularDuplicados}
          simulado={simulado}
          onAbrirFicha={abrirFicha}
          onCambio={recargar}
          tituloRef={tituloPendientes}
        />
      )}

      <EquivalenciasCiudad
        version={version}
        puedeConfirmar={permisos.confirmarCiudad}
        onConfirmada={recargar}
      />

      <SincronizacionTerceros
        version={version}
        puedeSincronizar={permisos.sincronizar}
        explicacionPermisoId={ID_EXPLICACION_SINCRONIZAR}
        simulado={simulado}
        ambienteServidor={servidor?.ambiente ?? null}
        onAbrirFicha={abrirFicha}
        onCambio={recargar}
        tituloRef={tituloSincronizacion}
      />

      {/* «Llevar a su ficha en Clientes» se resuelve REUSANDO el modal, no navegando: `/clients` no
          tiene enlace profundo, y montarlo aquí es además la opción que no mete ningún
          identificador de cliente en la URL. Financiera lo abre en solo lectura. */}
      {ficha !== null && (
        <FichaFiscal
          clienteId={ficha.clienteId}
          clienteNombre={ficha.nombre}
          editable={permisos.editarFicha}
          onClose={() => setFicha(null)}
          onGuardado={recargar}
        />
      )}
    </div>
  );
}
