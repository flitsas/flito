// Facturación electrónica — parametrización (HU #11287, Feature #11240).
//
// Queda una sola pregunta que parametrizar: **a qué producto de Siigo corresponde cada concepto de
// la liquidación**. Todo lo demás que vivía aquí desapareció el 2026-08-13, y conviene saber por qué
// al leer esta pantalla tan corta:
//
//   · La **configuración global de emisión** —comprobante, vendedor, forma de pago y centro de
//     costo— se quitó: se eligen en cada envío, por empresa. Una configuración global significaba
//     que cambiar el vendedor de una empresa lo cambiaba para todas.
//   · Los **catálogos y su botón de sincronizar** se quitaron con ella: los cuatro de emisión se
//     leen de Siigo en el momento de elegir, así que no hay copia que refrescar a mano.
//   · El **tratamiento tributario** se fue antes (A7): lo aplica Siigo desde el producto.
//
// Por eso ya no hay pestañas. Cuando solo queda una sección, una barra de pestañas es un adorno que
// sugiere que hay algo más en alguna parte.
//
// **La compuerta encabeza la pantalla** (AC6). Es la única pregunta que importa de verdad aquí: ¿se
// puede facturar en producción, y si no, qué falta? Enterrarla abajo obligaría a buscarla, y lo que
// no se ve no se corrige.

import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import MapeoConceptos from '../components/siigo/MapeoConceptos';
import { CARD, inputCls } from '../components/siigo/estilos';

type Ambiente = 'pruebas' | 'produccion';

interface MotivoCompuerta {
  tipo: string;
  detalle: string;
  conceptos?: string[];
  campos?: string[];
}

interface EstadoCompuerta {
  ambiente: string;
  modo: string;
  compuertaActiva: boolean;
  emisionRealHabilitada: boolean;
  motivos: MotivoCompuerta[];
}

export default function SiigoParametrizacion() {
  const { user } = useAuth();
  const puedeEditar = user?.role === 'admin';

  const [ambiente, setAmbiente] = useState<Ambiente>('pruebas');
  const [compuerta, setCompuerta] = useState<EstadoCompuerta | null>(null);
  const [errorCompuerta, setErrorCompuerta] = useState<string | null>(null);

  const cargarCompuerta = useCallback(async () => {
    setErrorCompuerta(null);
    try {
      setCompuerta(await api.get<EstadoCompuerta>(`/siigo/compuerta?ambiente=${ambiente}`));
    } catch (e) {
      // El fallo de la compuerta NO tumba la pantalla: sin ella se sigue pudiendo parametrizar.
      setCompuerta(null);
      setErrorCompuerta(errorMessage(e));
    }
  }, [ambiente]);

  useEffect(() => { void cargarCompuerta(); }, [cargarCompuerta]);

  return (
    <div className="space-y-5">
      <PageHeaderCard
        title="Facturación electrónica — Parametrización"
        subtitle="Catálogos, mapeo de conceptos y configuración de emisión de la integración con Siigo."
        actions={(
          <div className="flex items-center gap-3">
            <label htmlFor="ambiente-siigo" className="text-sm font-medium" style={{ color: 'var(--flit-text-muted)' }}>
              Ambiente
            </label>
            <select
              id="ambiente-siigo"
              className={`${inputCls} w-40`}
              value={ambiente}
              onChange={(e) => setAmbiente(e.target.value as Ambiente)}
            >
              <option value="pruebas">Pruebas</option>
              <option value="produccion">Producción</option>
            </select>
          </div>
        )}
      />

      {/* AC7 — el modo simulado se señaliza de forma permanente, no en un toast que se va. */}
      {compuerta?.modo === 'mock' && (
        <div
          role="status"
          className="flex items-start gap-3 bg-white px-5 py-4 text-sm"
          style={{ ...CARD, borderLeft: '4px solid var(--flit-warning)' }}
        >
          <span aria-hidden="true" className="text-lg leading-none">🧪</span>
          <div>
            <p className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
              Modo simulado: los datos vienen del simulador, no de Siigo.
            </p>
            <p style={{ color: 'var(--flit-text-muted)' }}>
              Nada de lo que se haga aquí llega a Siigo ni a la DIAN, y la compuerta que impide
              emitir sin confirmación de contabilidad <strong>no aplica</strong> en este modo.
            </p>
          </div>
        </div>
      )}

      {/* AC6 — el estado de la compuerta encabeza la pantalla. */}
      {compuerta && !compuerta.emisionRealHabilitada && (
        <section
          aria-labelledby="compuerta-titulo"
          className="bg-white px-5 py-4"
          style={{ ...CARD, borderLeft: '4px solid var(--flit-danger)' }}
        >
          <h2 id="compuerta-titulo" className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            <span aria-hidden="true" style={{ color: 'var(--flit-danger)' }}>⚠ </span>
            La emisión en producción está bloqueada
          </h2>
          <ul className="mt-2 space-y-1.5">
            {/* `?? []` y no `compuerta.motivos` a secas: una respuesta incompleta —un despliegue a
                medias, un proxy que recorta— no puede tumbar toda la pantalla de parametrización
                por un banner informativo. */}
            {/* Ya no hay «ir a corregirlo»: al quedar una sola sección, el sitio donde se corrige
                es lo que hay justo debajo de este aviso. */}
            {(compuerta.motivos ?? []).map((m) => (
              <li key={m.tipo} className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
                {m.detalle}
              </li>
            ))}
          </ul>
        </section>
      )}

      {compuerta?.emisionRealHabilitada && compuerta.compuertaActiva && (
        <p
          role="status"
          className="bg-white px-5 py-4 text-sm font-semibold"
          style={{ ...CARD, borderLeft: '4px solid var(--flit-success)', color: 'var(--flit-text-primary)' }}
        >
          La parametrización está completa: la emisión en producción está habilitada.
        </p>
      )}

      {errorCompuerta && (
        <p role="alert" className="bg-white px-5 py-4 text-sm" style={{ ...CARD, color: 'var(--flit-text-primary)' }}>
          <span aria-hidden="true" style={{ color: 'var(--flit-danger)' }}>⚠ </span>
          No se pudo consultar el estado de la emisión: {errorCompuerta}
        </p>
      )}

      <MapeoConceptos
        ambiente={ambiente}
        puedeEditar={puedeEditar}
        onCambio={() => { void cargarCompuerta(); }}
      />
    </div>
  );
}
