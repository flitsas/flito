// FLITO — SOAT: la barra de la selección de la cola (HU #11910).
//
// Sale de `pages/FlitoSoat.tsx` en esta HU por dos motivos, y el segundo es el que manda: la página
// se pasó del techo de 800 líneas que el gate de lint impone, y esta barra es la pieza con frontera
// más limpia —recibe ids y proveedores, devuelve dos avisos— de todo el archivo. No cambia de
// comportamiento al mudarse: lo que cambia es de quién recibe los ids (ver abajo).

import { useId, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import {
  FlitCard, flitInp, flitBtnPrimary, flitBtnPrimaryStyle,
} from '../flit/flitPageKit';
import {
  DescargarSoportesZip, ZIP_SOAT, type EstadoDescargaZip,
} from './DescargarSoportesZip';

/** Lo único que la barra necesita saber de un proveedor de SOAT. */
export interface ProveedorSoat { id: string; nombre: string; activo: boolean }

/**
 * Valor centinela del selector de destino. La contingencia entra como una opción MÁS de la misma
 * lista, y no como una casilla aparte, porque así un solo control decide el destino: es imposible
 * pedir proveedor y Operaciones a la vez, que es justo lo que el servidor rechaza con un 400. El
 * usuario nunca llega a ver ese error porque la interfaz no le deja construirlo.
 */
const DESTINO_OPERACIONES = '__operaciones__';

/**
 * Mínimo de filas marcadas para el ZIP (HU #12815, AC6). Con una sola, el ZIP es un sobre alrededor
 * de un PDF: para eso está la descarga del comprobante en su propia fila (HU #12816).
 */
export const MIN_MARCADAS_ZIP_SOAT = 2;

/**
 * Por qué el ZIP no trae todas las marcadas, o por qué está apagado; `null` si no hay nada que
 * explicar. La pantalla SÍ sabe qué filas tienen comprobante —solo se llega a Pagado con factura
 * (RN-03)—, así que el desajuste se dice ANTES del clic, como el «(3 de 8)» del envío, y no después
 * con un «parcial». Copy neutro: esta barra también la lee el Cliente (usted).
 */
export function motivoZipSoat(marcadas: number, pagadas: number): string | null {
  if (marcadas < MIN_MARCADAS_ZIP_SOAT) {
    return 'Marque al menos 2 filas. Para un solo SOAT, use el botón de descarga de su fila.';
  }
  if (pagadas === 0) {
    return 'Ninguna de las filas marcadas está pagada. Solo los SOAT pagados tienen comprobante.';
  }
  if (pagadas < marcadas) {
    return `Solo los SOAT pagados tienen comprobante: el ZIP trae ${pagadas} de las ${marcadas} filas marcadas.`;
  }
  return null;
}

/**
 * La casilla de una fila (o de la cabecera) de la cola. El hover va en la CELDA y no en el `<input>`,
 * para que se note el área de clic; el foco es el del kit. Sale de la página por el techo de líneas.
 */
export function CasillaSoat({ etiqueta, marcada, onCambio, cabecera = false }: {
  etiqueta: string; marcada: boolean; onCambio: (marcada: boolean) => void; cabecera?: boolean;
}) {
  const input = (
    <input type="checkbox" className="flit-focus cursor-pointer" aria-label={etiqueta}
      checked={marcada} onChange={(e) => onCambio(e.target.checked)} />
  );
  return cabecera
    ? input
    : <td className="px-3 py-2 transition-colors hover:bg-[var(--flit-bg-hover)]">{input}</td>;
}

/**
 * La barra de la selección: enviar al gestor y —desde la HU #11910— descargar los soportes.
 *
 * **Recibe `enviables` y no `ids`**, y esa es la corrección de esta HU. Con la casilla abierta a
 * cualquier fila (AC1), pasarle lo marcado entero haría que el usuario marcase 40, pulsara «Enviar
 * al gestor» y el servidor devolviera 6 enviados sin explicar los 34 restantes: descarte silencioso
 * disfrazado de éxito. El servidor ya filtra por `estadoOrigen` dentro del `SELECT … FOR UPDATE`, así
 * que no había agujero de autorización; lo que había era una mentira en pantalla.
 *
 * El envío se OFRECE si aplica a alguna marcada —no a todas— y el desajuste va dentro del **nombre
 * accesible** del botón: `Enviar al gestor (3 de 8)`. Es lo que se lee en el instante de decidir; una
 * línea auxiliar se pierde al envolver la barra en pantalla estrecha.
 */
/**
 * **Desde la HU #12815 el ZIP también recibe solo lo que aplica**: `descargables` son las marcadas
 * PAGADAS, y el botón existe solo con `puedeDescargar` (función `soat.soportes.descargar`; sin ella,
 * ausente del DOM, no apagado). Es la primaria cuando «Enviar» no se ofrece —Cliente, gestor, o
 * ninguna Pendiente marcada—; las dos no compiten en la práctica, porque una Pendiente nunca está
 * pagada.
 */
export default function BarraEnvioSoat({
  marcadas, enviables, descargables, puedeEnviar, puedeDescargar, proveedores, zip, onEnviado, onError,
}: {
  marcadas: number; enviables: string[]; descargables: string[]; puedeEnviar: boolean;
  puedeDescargar: boolean; proveedores: ProveedorSoat[];
  zip: Pick<EstadoDescargaZip, 'ocupado' | 'descargar'>;
  onEnviado: () => void; onError: (m: string) => void;
}) {
  const [destino, setDestino] = useState('');
  const [enviando, setEnviando] = useState(false);
  const idMotivoZip = useId();
  const aOperaciones = destino === DESTINO_OPERACIONES;
  const seOfreceEnviar = puedeEnviar && enviables.length > 0;
  const desajuste = seOfreceEnviar && enviables.length < marcadas;
  const motivoZip = puedeDescargar ? motivoZipSoat(marcadas, descargables.length) : null;
  // `(8)` cuando no hay desajuste —como hasta ahora, con el número que ya llevaba «Certificar»— y
  // `(3 de 8)` cuando lo hay. Nunca «(8)» sobre una petición de 3.
  const cuenta = desajuste ? `${enviables.length} de ${marcadas}` : `${enviables.length}`;
  const enviar = async () => {
    setEnviando(true);
    try {
      await api.post('/flito/soat/enviar',
        aOperaciones
          ? { ids: enviables, gestionOperaciones: true }
          : { ids: enviables, proveedorSoatId: destino });
      onEnviado();
    } catch (e) { onError(errorMessage(e)); }
    finally { setEnviando(false); }
  };
  return (
    <FlitCard>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold" style={{ color: 'var(--flit-blue-text)' }}>{marcadas} seleccionado(s)</span>
        {seOfreceEnviar && (
          <>
            <label className="flex w-full items-center gap-2 text-sm sm:w-auto">
              <span className="whitespace-nowrap">Enviar a</span>
              {/* `h-10`: la altura única de la barra, la de los dos botones del kit. */}
              <select className={`${flitInp} h-10 min-w-0 flex-1 sm:max-w-xs`} value={destino} onChange={(e) => setDestino(e.target.value)}>
                <option value="">Elige destino…</option>
                <option value={DESTINO_OPERACIONES}>Gestionado por Operaciones</option>
                <optgroup label="Proveedores">
                  {proveedores.filter((p) => p.activo).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                </optgroup>
              </select>
            </label>
            {/* Sin destino el SOAT quedaría en la cola de nadie y sin ANS con el que medirlo. */}
            <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
              disabled={enviando || !destino} onClick={enviar}>
              {enviando ? 'Enviando…' : `${aOperaciones ? 'Enviar a Operaciones' : 'Enviar al gestor'} (${cuenta})`}
            </button>
          </>
        )}
        {puedeDescargar && (
          <DescargarSoportesZip
            superficie={ZIP_SOAT}
            ids={descargables}
            marcadas={marcadas}
            minMarcadas={MIN_MARCADAS_ZIP_SOAT}
            primaria={!seOfreceEnviar}
            describedBy={motivoZip ? idMotivoZip : undefined}
            llenaEnMovil
            ocupado={zip.ocupado}
            onDescargar={zip.descargar}
          />
        )}
      </div>
      {/* Un solo párrafo de desajuste para las dos acciones; la frase del ZIP lleva su propio id
          para que el botón la anuncie (`aria-describedby`) sin arrastrar la del envío. */}
      {(desajuste || motivoZip) && (
        <p className="mt-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          {desajuste && (
            <>De las {marcadas} filas marcadas, {enviables.length} están Pendientes y son las únicas que se envían. </>
          )}
          {motivoZip && <span id={idMotivoZip}>{motivoZip}</span>}
        </p>
      )}
    </FlitCard>
  );
}
