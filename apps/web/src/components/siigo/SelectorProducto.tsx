// Siigo — elegir el producto de un concepto, de la lista real de Siigo (A5).
//
// Antes esto era un campo de texto libre. Quien parametrizaba tenía que ir a Siigo Nube, copiar el
// código y pegarlo aquí, y el servidor lo validaba después: un viaje de ida y vuelta para descubrir
// una errata. Peor todavía, la pantalla mostraba luego un código pelado —`SERV-NUBE`— donde quien
// factura espera leer «Servicio en la Nube», que es el nombre que va a salir en el documento.
//
// **El texto libre no se retira del todo, y es deliberado.** Un producto que existe en Siigo pero
// que el listado no alcanzó —o un catálogo caído— no puede dejar la pantalla sin salida: se ofrece
// escribir el código a mano, con el mismo formato que valida el servidor. Lo que cambia es que ya no
// es la única forma, ni la primera que se ve.

import { useCallback, useEffect, useRef, useState } from 'react';
import { CODIGO_PRODUCTO_SIIGO_RE } from '@operaciones/shared-types';
import { api, errorMessage } from '../../lib/api';
import { inputCls } from './estilos';

interface ProductoDeSiigo {
  codigo: string;
  nombre: string;
  activo: boolean;
  impuestos: Array<{ id: number; nombre: string | null; porcentaje: number | null }>;
}

interface Listado {
  items: ProductoDeSiigo[];
  /** Hay más productos en Siigo de los que se miraron. Se dice: un corte silencioso se lee como todo. */
  truncado: boolean;
  total: number | null;
}

interface Props {
  /** El código actualmente guardado, o `''` si el concepto no está mapeado. */
  valor: string;
  onCambio: (codigo: string) => void;
  /** Id del control, para que la etiqueta de fuera lo apunte. */
  id: string;
}

/** Espera antes de consultar. Cada consulta son hasta cinco viajes a Siigo; teclear no es buscar. */
const ESPERA_MS = 350;

export default function SelectorProducto({ valor, onCambio, id }: Props) {
  const [busqueda, setBusqueda] = useState('');
  const [listado, setListado] = useState<Listado | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<string | null>(null);
  const [aMano, setAMano] = useState(false);
  /** Descarta respuestas de consultas viejas: sin esto, la lenta pisa a la rápida. */
  const consulta = useRef(0);

  const cargar = useCallback(async (q: string) => {
    const mia = ++consulta.current;
    setCargando(true);
    setFallo(null);
    try {
      const r = await api.get<Listado>(`/siigo/productos${q ? `?q=${encodeURIComponent(q)}` : ''}`);
      if (mia !== consulta.current) return;
      setListado(r);
    } catch (e) {
      if (mia !== consulta.current) return;
      setFallo(errorMessage(e));
    } finally {
      if (mia === consulta.current) setCargando(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => { void cargar(busqueda); }, busqueda === '' ? 0 : ESPERA_MS);
    return () => clearTimeout(t);
  }, [busqueda, cargar]);

  const formatoValido = valor === '' || CODIGO_PRODUCTO_SIIGO_RE.test(valor);

  // El valor guardado puede no estar en la lista: el catálogo se truncó, el producto se retiró de
  // Siigo, o alguien lo escribió a mano. Se añade como opción para que abrir el modal y guardar sin
  // tocar nada NO lo borre en silencio.
  const enLista = (listado?.items ?? []).some((p) => p.codigo === valor);

  if (aMano) {
    return (
      <>
        <input
          id={id}
          className={inputCls}
          value={valor}
          onChange={(e) => onCambio(e.target.value)}
          placeholder="FLIT-LOGISTICA"
          aria-invalid={!formatoValido}
          aria-describedby={formatoValido ? undefined : `${id}-error`}
        />
        {!formatoValido && (
          <p id={`${id}-error`} className="mt-1 text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            Alfanumérico (admite punto, guion y guion bajo), sin espacios y máximo 30 caracteres.
          </p>
        )}
        <button type="button" className="mt-2 text-xs underline" style={{ color: 'var(--flit-text-secondary)' }}
          onClick={() => setAMano(false)}>
          Elegir de la lista de Siigo
        </button>
      </>
    );
  }

  return (
    <>
      <input
        type="search"
        className={`${inputCls} mb-2`}
        value={busqueda}
        onChange={(e) => setBusqueda(e.target.value)}
        placeholder="Buscar por nombre o código…"
        aria-label="Buscar producto en el catálogo de Siigo"
      />

      {/* Estado 1 — cargando. */}
      {cargando && (
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          Consultando el catálogo de Siigo…
        </p>
      )}

      {/* Estado 2 — error, con reintento. El mensaje es el que tradujo el servidor. */}
      {!cargando && fallo !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm" style={{ color: 'var(--flit-danger)' }}>
            No se pudo consultar el catálogo: {fallo}
          </span>
          <button type="button" className="text-xs underline" style={{ color: 'var(--flit-text-secondary)' }}
            onClick={() => void cargar(busqueda)}>
            Reintentar
          </button>
        </div>
      )}

      {/* Estado 3 — vacío. Se distingue «no hay nada» de «nada coincide»: llevan a acciones opuestas. */}
      {!cargando && fallo === null && (listado?.items.length ?? 0) === 0 && (
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          {busqueda === ''
            ? 'El catálogo de productos de Siigo está vacío en este ambiente.'
            : `Ningún producto de Siigo coincide con «${busqueda}».`}
        </p>
      )}

      {/* Estado 4 — lleno. */}
      {!cargando && fallo === null && (listado?.items.length ?? 0) > 0 && (
        <select
          id={id}
          className={inputCls}
          value={valor}
          onChange={(e) => onCambio(e.target.value)}
        >
          <option value="">Sin mapear</option>
          {valor !== '' && !enLista && (
            <option value={valor}>{valor} — guardado, fuera de esta búsqueda</option>
          )}
          {listado!.items.map((p) => (
            <option key={p.codigo} value={p.codigo}>
              {p.nombre} · {p.codigo}
              {p.activo ? '' : ' (inactivo en Siigo)'}
              {p.impuestos.length > 0
                ? ` · ${p.impuestos.map((i) => i.nombre ?? `impuesto ${i.id}`).join(', ')}`
                : ''}
            </option>
          ))}
        </select>
      )}

      {listado?.truncado === true && (
        // Sin este aviso, un catálogo cortado se lee como el catálogo entero, y quien no encuentre
        // su producto va a concluir que no está en Siigo.
        <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          Se están mostrando los primeros productos del catálogo
          {listado.total !== null ? ` de ${listado.total.toLocaleString('es-CO')}` : ''}. Si el que
          buscas no aparece, escribe parte de su nombre.
        </p>
      )}

      <button type="button" className="mt-2 text-xs underline" style={{ color: 'var(--flit-text-secondary)' }}
        onClick={() => setAMano(true)}>
        Escribir el código a mano
      </button>
    </>
  );
}
