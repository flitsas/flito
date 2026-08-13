// Envío a facturación — paso 2: con qué se emite, una fila por empresa (A4, sobre A2).
//
// **Por empresa y no por trámite, ni una sola vez para toda la selección.** El vendedor y la forma
// de pago son atributos del cliente: cincuenta trámites de la misma empresa comparten los cuatro
// valores, así que preguntarlos cincuenta veces sería el camino más lento y el que más se equivoca;
// y unos valores únicos para toda la selección se rompen en cuanto hay dos empresas, que es
// justamente el caso masivo que esta pantalla existe para resolver.
//
// **Nadie parametriza nada, y ya no hay «por defecto».** Cada fila llega precargada con lo último
// que se usó con esa empresa (`GET /siigo/facturacion/emision`), pero si es la primera vez hay que
// elegir: la configuración global que hacía de semilla se quitó el 2026-08-13. Un valor por defecto
// invisible es cómo salía una factura con un vendedor que quien la envió nunca vio.
//
// **Las listas se leen de Siigo AHORA** (`/catalogos-vivo/:tipo`), no de una copia local. Por eso no
// hay ningún botón de sincronizar en ninguna parte: si acaban de crear el vendedor en Siigo —que es
// justo cuando se abre esto—, aparece.

import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { inputCls } from '../siigo/estilos';

export interface EmisionEmpresa {
  clienteId: number;
  documentoTipoCodigo: string | null;
  vendedorCodigo: string | null;
  formaPagoCodigo: string | null;
  centroCostoCodigo: string | null;
}

export interface EmpresaDelEnvio {
  clienteId: number;
  nombre: string;
  tramites: number;
}

export interface Elemento {
  codigo: string;
  nombre: string;
  activo: boolean;
  /** Lo que el catálogo dice del elemento. De aquí salen `manejaVencimiento` y demás. */
  atributos: Record<string, unknown> | null;
}

/**
 * Los cuatro catálogos que alimentan la fila.
 *
 * Los tres primeros son obligatorios porque `InvoiceIn` los exige. El centro de costo lo es «según
 * la configuración del comprobante», así que no se puede declarar aquí: se decide al elegir el
 * comprobante, leyendo `centroCostoObligatorio` de ese elemento.
 */
const CATALOGOS = [
  { tipo: 'document_type', campo: 'documentoTipoCodigo', etiqueta: 'Comprobante' },
  { tipo: 'user', campo: 'vendedorCodigo', etiqueta: 'Vendedor' },
  { tipo: 'payment_type', campo: 'formaPagoCodigo', etiqueta: 'Forma de pago' },
  { tipo: 'cost_center', campo: 'centroCostoCodigo', etiqueta: 'Centro de costo' },
] as const;

type Campo = typeof CATALOGOS[number]['campo'];

/** Un atributo booleano del elemento, sin confiar en que venga. */
function marca(e: Elemento | undefined, clave: string): boolean {
  return (e?.atributos as Record<string, unknown> | null)?.[clave] === true;
}

/**
 * ¿El comprobante elegido exige centro de costo? Sale del catálogo, no de una suposición.
 *
 * Sin comprobante elegido todavía no se sabe, y «no se sabe» es `false`: no se puede exigir un campo
 * cuya obligatoriedad depende de otro que aún está vacío.
 */
function exigeCentroCosto(v: EmisionEmpresa | undefined, comprobantes: Elemento[]): boolean {
  const elegido = comprobantes.find((c) => c.codigo === v?.documentoTipoCodigo);
  return marca(elegido, 'centroCostoObligatorio');
}

/**
 * Qué le falta a una empresa para poder enviarse.
 *
 * Exportada porque el diálogo la necesita para decidir si habilita el botón: la regla de «está
 * completo» tiene que ser UNA, y vivir donde están los catálogos que la sostienen.
 */
export function faltantesDe(
  v: EmisionEmpresa | undefined, comprobantes: Elemento[],
): Campo[] {
  const faltan: Campo[] = [];
  if (!v?.documentoTipoCodigo) faltan.push('documentoTipoCodigo');
  if (!v?.vendedorCodigo) faltan.push('vendedorCodigo');
  if (!v?.formaPagoCodigo) faltan.push('formaPagoCodigo');
  if (exigeCentroCosto(v, comprobantes) && !v?.centroCostoCodigo) faltan.push('centroCostoCodigo');
  return faltan;
}

interface Props {
  empresas: EmpresaDelEnvio[];
  valores: EmisionEmpresa[];
  onCambio: (valores: EmisionEmpresa[]) => void;
  /** Se avisa hacia arriba de qué hay cargado, para que el diálogo pueda validar con lo mismo. */
  onCatalogos?: (comprobantes: Elemento[]) => void;
}

export default function EmisionPorEmpresa({ empresas, valores, onCambio, onCatalogos }: Props) {
  const [catalogos, setCatalogos] = useState<Record<string, Elemento[]> | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<string | null>(null);

  const clienteIds = useMemo(() => empresas.map((e) => e.clienteId).join(','), [empresas]);

  useEffect(() => {
    let vivo = true;
    const cargar = async () => {
      setCargando(true);
      setFallo(null);
      try {
        // Los cuatro catálogos y la memoria en paralelo. Los catálogos SALEN A SIIGO, así que son
        // cuatro peticiones de la cuota compartida: encadenarlas solo haría esperar más a quien ya
        // pulsó «siguiente», y no gastaría menos.
        const [listas, recordado] = await Promise.all([
          Promise.all(CATALOGOS.map((c) =>
            api.get<{ elementos: Elemento[] }>(`/siigo/parametrizacion/catalogos-vivo/${c.tipo}`))),
          api.get<{ items: EmisionEmpresa[] }>(
            `/siigo/facturacion/emision?clienteIds=${encodeURIComponent(clienteIds)}`),
        ]);
        if (!vivo) return;

        const porTipo: Record<string, Elemento[]> = {};
        CATALOGOS.forEach((c, i) => { porTipo[c.tipo] = listas[i]?.elementos ?? []; });
        // Las formas de pago con vencimiento no se ofrecen. Siigo exige `due_date` cuando la forma
        // de pago lo maneja, FLITO no factura a crédito y no se va a inventar una fecha: una opción
        // que garantiza el rechazo no es una opción, es una trampa.
        porTipo.payment_type = (porTipo.payment_type ?? []).filter((p) => !marca(p, 'manejaVencimiento'));
        setCatalogos(porTipo);
        onCatalogos?.(porTipo.document_type ?? []);

        // Precarga: lo recordado de cada empresa, o los cuatro nulos. Un nulo ya no significa
        // «usa lo global» —no hay nada global—: significa «falta por elegir», y así se pinta.
        const memoria = new Map(recordado.items.map((r) => [r.clienteId, r]));
        onCambio(empresas.map((e) => memoria.get(e.clienteId) ?? {
          clienteId: e.clienteId,
          documentoTipoCodigo: null,
          vendedorCodigo: null,
          formaPagoCodigo: null,
          centroCostoCodigo: null,
        }));
      } catch (e) {
        if (vivo) setFallo(errorMessage(e));
      } finally {
        if (vivo) setCargando(false);
      }
    };
    void cargar();
    return () => { vivo = false; };
    // `onCambio` y `empresas` se omiten a propósito: la carga depende de QUÉ empresas hay, y
    // `clienteIds` ya es esa identidad en forma estable. Incluirlos reejecutaría en cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clienteIds]);

  const cambiar = (clienteId: number, campo: Campo, valor: string) => {
    onCambio(valores.map((v) => (
      v.clienteId === clienteId ? { ...v, [campo]: valor === '' ? null : valor } : v
    )));
  };

  if (cargando) {
    return <p style={{ color: 'var(--flit-text-secondary)' }}>Cargando las opciones de emisión…</p>;
  }

  if (fallo !== null) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span style={{ color: 'var(--flit-danger)' }}>No se pudieron cargar las opciones: {fallo}</span>
        <button type="button" className="text-xs underline" style={{ color: 'var(--flit-text-secondary)' }}
          onClick={() => setCatalogos(null)}>
          Reintentar
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
        Sale de los catálogos de Siigo, leídos ahora mismo. Lo que elijas se recordará para el
        próximo envío de esa empresa.
      </p>

      {empresas.map((empresa) => {
        const v = valores.find((x) => x.clienteId === empresa.clienteId);
        const comprobantes = catalogos?.document_type ?? [];
        const faltan = faltantesDe(v, comprobantes);
        const centroObligatorio = exigeCentroCosto(v, comprobantes);
        return (
          <fieldset key={empresa.clienteId} className="rounded-lg border p-3"
            style={{ borderColor: 'var(--flit-border-input)' }}>
            <legend className="px-1 text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
              {empresa.nombre}
              <span className="ml-2 text-xs font-normal" style={{ color: 'var(--flit-text-muted)' }}>
                {empresa.tramites} trámite(s)
              </span>
            </legend>

            <div className="grid gap-2 sm:grid-cols-2">
              {CATALOGOS.map((c) => {
                const id = `emision-${empresa.clienteId}-${c.campo}`;
                const elementos = catalogos?.[c.tipo] ?? [];
                const obligatorio = c.campo !== 'centroCostoCodigo' || centroObligatorio;
                const falta = faltan.includes(c.campo);
                return (
                  <div key={c.campo}>
                    <label htmlFor={id} className="mb-1 block text-xs font-semibold"
                      style={{ color: 'var(--flit-text-muted)' }}>
                      {c.etiqueta}{obligatorio ? '' : ' (opcional)'}
                    </label>
                    {elementos.length === 0 ? (
                      // Vacío no es un desplegable sin opciones: se dice qué pasó y dónde se
                      // arregla, que ahora es Siigo Nube y no una sincronización de FLITO.
                      <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                        Siigo no devolvió ninguna opción activa para este catálogo. Revísalo en Siigo Nube.
                      </p>
                    ) : (
                      <select
                        id={id}
                        className={inputCls}
                        value={(v?.[c.campo] ?? '') as string}
                        aria-invalid={falta}
                        aria-describedby={falta ? `${id}-falta` : undefined}
                        onChange={(e) => cambiar(empresa.clienteId, c.campo, e.target.value)}
                      >
                        {/* Sin «Por defecto»: no hay nada detrás a lo que caer. El texto dice que
                            falta una elección, no que haya una alternativa silenciosa. */}
                        <option value="">{obligatorio ? 'Elige una opción' : 'Sin centro de costo'}</option>
                        {elementos.map((e) => (
                          <option key={e.codigo} value={e.codigo}>{e.nombre}</option>
                        ))}
                      </select>
                    )}
                    {falta && elementos.length > 0 && (
                      <p id={`${id}-falta`} className="mt-1 text-xs font-semibold"
                        style={{ color: 'var(--flit-text-primary)' }}>
                        <span aria-hidden="true" style={{ color: 'var(--flit-danger)' }}>⚠ </span>
                        {c.campo === 'centroCostoCodigo'
                          ? 'El comprobante que elegiste exige centro de costo.'
                          : 'Falta elegirlo para poder enviar.'}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
