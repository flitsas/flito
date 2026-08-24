// FLITO Conciliación — cargar la boleta del portal (HU #11680, AC3).
//
// Tres datos y un archivo. Cargar **no mueve dinero** —lo dice el ADR §7.1 y lo repite el subtítulo
// de la bandeja—, así que este paso no pide confirmación: confirmar lo inofensivo es lo que entrena
// a la gente a confirmar sin leer, y el único diálogo de confirmación de la pantalla tiene que ser
// el que descuenta de las bolsas.
//
// Lo que sí hace este modal, y por eso existe en vez de un `<input type=file>` suelto:
//
//   · **No se cierra hasta que hay respuesta.** Cerrarlo a mitad de la subida dejaría una boleta
//     creada que el usuario cree que no existe, y su archivo con el hash ya reservado.
//   · **Enseña el MOTIVO del rechazo**, no «Rechazado — cargar otro». El componente de carga por sí
//     solo no sabe por qué; el motivo lo compone `rechazoDeCarga` a partir del código del cuerpo.
//   · **`boleta_duplicada` lleva a la boleta que ya existe.** El API devuelve el `boletaId` en el
//     409 expresamente para eso; sin usarlo, el servidor regaló un dato para nada y el usuario se
//     queda adivinando cuál era.

import { useState } from 'react';
import type { BoletaDetalleDto } from '@operaciones/shared-types';
import { CONCILIACION_MAX_FILAS } from '@operaciones/shared-types';
import { api } from '../../../lib/api';
import { hoyColombia } from '../../../lib/bolsas';
import { rechazoDeCarga, type Rechazo } from '../../../lib/conciliacion';
import FlitModal from '../../flit/FlitModal';
import FlitSelect from '../../flit/FlitSelect';
import FlitUploadBox from '../../flit/FlitUploadBox';
import {
  FlitField, flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../../flit/flitPageKit';

export interface ClienteOpcion { id: number; name: string }

interface Props {
  /**
   * El catálogo de clientes lo trae la BANDEJA y se pasa aquí ya cargado: el filtro de la lista
   * necesita el mismo, y pedirlo dos veces sería traer la misma tabla dos veces por abrir un modal.
   * `null` = todavía cargando.
   */
  clientes: ClienteOpcion[] | null;
  falloClientes: boolean;
  onReintentarClientes: () => void;
  onCerrar: () => void;
  /** La boleta recién creada, con su cuadre ya resuelto: el llamador navega a su detalle. */
  onCargada: (boleta: BoletaDetalleDto) => void;
  /** «Ver BOL-000123» del 409 `boleta_duplicada`. */
  onVerBoleta: (boletaId: string) => void;
}

export default function CargarBoletaModal(
  { clientes, falloClientes, onReintentarClientes, onCerrar, onCargada, onVerBoleta }: Props,
) {
  const [companiaId, setCompaniaId] = useState('');
  const [fechaPago, setFechaPago] = useState(hoyColombia);
  const [archivo, setArchivo] = useState<File | null>(null);
  const [cargando, setCargando] = useState(false);
  const [rechazo, setRechazo] = useState<Rechazo | null>(null);

  // Qué falta para poder cargar, en el orden en que se rellena el formulario. Es el nombre accesible
  // del botón cuando está bloqueado: «Cargar y cruzar» a secas no dice qué hay que hacer.
  const falta = !companiaId ? 'falta elegir el cliente'
    : !fechaPago ? 'falta poner la fecha del pago'
    : !archivo ? 'falta elegir el archivo'
    : null;

  async function cargar(): Promise<void> {
    if (falta || !archivo || cargando) return;
    setCargando(true);
    setRechazo(null);
    try {
      const boleta = await api.upload<BoletaDetalleDto>(
        '/flito/conciliacion/boletas', archivo, 'archivo', { companiaId, fechaPago },
      );
      onCargada(boleta);
    } catch (e) {
      setRechazo(rechazoDeCarga(e));
    } finally {
      setCargando(false);
    }
  }

  const estadoCaja = cargando ? 'uploading' : rechazo ? 'rejected' : archivo ? 'verified' : 'idle';

  return (
    // Mientras la petición está en vuelo, cerrar no hace nada: ni con Esc, ni con clic fuera, ni con
    // la X. La boleta puede estar ya creada al otro lado.
    <FlitModal title="Cargar boleta del portal" onClose={cargando ? () => undefined : onCerrar} wide>
      <div className="space-y-4">
        <FlitSelect
          label="Cliente *"
          value={companiaId}
          opciones={[
            { valor: '', etiqueta: clientes === null ? 'Cargando clientes…' : 'Elige un cliente' },
            ...(clientes ?? []).map((c) => ({ valor: String(c.id), etiqueta: c.name })),
          ]}
          onChange={setCompaniaId}
          disabled={cargando || clientes === null || falloClientes}
          ayuda={'Una boleta agrupa SOAT de un solo cliente. Si el Excel trae vehículos de otro, esas '
            + 'líneas saldrán marcadas y la boleta no se podrá conciliar.'}
          mensaje={falloClientes ? 'No se pudo cargar la lista de clientes.' : null}
          fallo={falloClientes}
          onReintentar={falloClientes ? onReintentarClientes : undefined}
          textoReintento="Reintentar los clientes"
        />

        <FlitField label="Fecha del pago en el portal *">
          <input
            type="date"
            className={flitInp}
            value={fechaPago}
            max={hoyColombia()}
            disabled={cargando}
            onChange={(e) => setFechaPago(e.target.value)}
          />
          <span className="mt-1 block text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            La del pago, no la de hoy: es la que decide a qué mes contable pertenece.
          </span>
        </FlitField>

        <FlitUploadBox
          label={archivo ? archivo.name : 'Excel de la boleta (.xlsx)'}
          required
          hint="El archivo tal como lo descargas del portal."
          accept=".xlsx"
          state={estadoCaja}
          count={1}
          onFile={(f) => { setArchivo(f); setRechazo(null); }}
        />

        {rechazo && (
          // El motivo va en una región viva: el componente de carga solo dice «Rechazado», que no es
          // un motivo, y quien usa lector de pantalla no tiene por qué ir a buscar el texto.
          <div role="alert" className="text-sm">
            <p className="font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>{rechazo.titulo}</p>
            <p style={{ color: 'var(--flit-text-secondary)' }}>{rechazo.detalle}</p>
            {rechazo.boletaId && (
              <button
                type="button"
                className={`${flitBtnSecondary} mt-2`}
                style={flitBtnSecondaryStyle}
                onClick={() => onVerBoleta(rechazo.boletaId as string)}
              >
                Ver {rechazo.referencia ?? 'la boleta'}
              </button>
            )}
          </div>
        )}

        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          Máximo {CONCILIACION_MAX_FILAS} líneas por boleta y 10 MB.
        </p>

        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className={flitBtnSecondary}
            style={flitBtnSecondaryStyle}
            disabled={cargando}
            onClick={onCerrar}
          >
            Cancelar
          </button>
          {/* `aria-disabled` y no `disabled`: así el botón conserva el foco y su nombre accesible
              —que dice QUÉ falta— se puede oír. Mismo criterio que el botón de conciliar. */}
          <button
            type="button"
            className={flitBtnPrimary}
            style={{ ...flitBtnPrimaryStyle, opacity: falta || cargando ? 0.5 : 1 }}
            aria-disabled={falta !== null || cargando}
            aria-label={falta ? `Cargar y cruzar — ${falta}` : undefined}
            onClick={cargar}
          >
            {cargando ? 'Cruzando las líneas…' : 'Cargar y cruzar'}
          </button>
        </div>
      </div>
    </FlitModal>
  );
}
