// FLITO — SOAT: la barra de la selección de la cola (HU #11910).
//
// Sale de `pages/FlitoSoat.tsx` en esta HU por dos motivos, y el segundo es el que manda: la página
// se pasó del techo de 800 líneas que el gate de lint impone, y esta barra es la pieza con frontera
// más limpia —recibe ids y proveedores, devuelve dos avisos— de todo el archivo. No cambia de
// comportamiento al mudarse: lo que cambia es de quién recibe los ids (ver abajo).

import { useState, type ReactNode } from 'react';
import { api, errorMessage } from '../../lib/api';
import {
  FlitCard, flitInp, flitBtnPrimary, flitBtnPrimaryStyle,
} from '../flit/flitPageKit';

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
export default function BarraEnvioSoat({ marcadas, enviables, puedeEnviar, proveedores, onEnviado, onError, descarga }: {
  marcadas: number; enviables: string[]; puedeEnviar: boolean; proveedores: ProveedorSoat[];
  onEnviado: () => void; onError: (m: string) => void; descarga: ReactNode;
}) {
  const [destino, setDestino] = useState('');
  const [enviando, setEnviando] = useState(false);
  const aOperaciones = destino === DESTINO_OPERACIONES;
  const seOfreceEnviar = puedeEnviar && enviables.length > 0;
  const desajuste = seOfreceEnviar && enviables.length < marcadas;
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
            <label className="flex items-center gap-2 text-sm">
              Enviar a
              <select className={`${flitInp} max-w-xs`} value={destino} onChange={(e) => setDestino(e.target.value)}>
                <option value="">Elige destino…</option>
                <option value={DESTINO_OPERACIONES}>Gestionado por Operaciones</option>
                <optgroup label="Proveedores">
                  {proveedores.filter((p) => p.activo).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                </optgroup>
              </select>
            </label>
            {/* Sin destino el SOAT quedaría en la cola de nadie y sin ANS con el que medirlo. */}
            <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={enviando || !destino} onClick={enviar}>
              {enviando ? 'Enviando…' : `${aOperaciones ? 'Enviar a Operaciones' : 'Enviar al gestor'} (${cuenta})`}
            </button>
          </>
        )}
        {descarga}
      </div>
      {desajuste && (
        <p className="mt-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          De las {marcadas} filas marcadas, {enviables.length} están Pendientes y son las únicas que
          se envían. Descargar soportes usa las {marcadas}.
        </p>
      )}
    </FlitCard>
  );
}
