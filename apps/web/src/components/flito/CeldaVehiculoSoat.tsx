/**
 * El vehículo, en la versión de la cola SOAT: lo mismo que pinta `CeldaVehiculo` de
 * `components/flit/columnasComunes` MÁS «Múltiple propietario».
 *
 * Es una copia local a propósito (HU #11905). Ese aviso es un atributo del SOAT
 * (`esMultiplePropietario`), no del trámite: viajaba como `extra` de `CeldaTramite` solo porque esa
 * columna era la que tenía sitio, y al retirarla se habría perdido un dato que ningún AC pidió
 * quitar. La alternativa —añadir una prop a la celda compartida— dejaría el aislamiento de las otras
 * tres tablas (impuestos, derechos, reporte de costos) dependiendo de que nadie pase el argumento;
 * aquí depende de que no exista. El precio, ~10 líneas duplicadas del kit, se acepta y se declara.
 *
 * Si el kit cambia el vehículo, esta celda NO lo hereda: es justo lo que la HU #11905 pide, y el
 * eslabón 2 (HU #11906) añadió aquí cilindraje, carrocería y tipo de servicio sin tocar el kit.
 *
 * Extraída de `pages/FlitoSoat.tsx` para mantener esa página bajo el techo max-lines 800 (HU #12170).
 */

/** Un dato de texto de FLIT, tal cual llega. Ausente —`null` o vacío— se pinta «—» (HU #11906, AC2):
    un hueco en blanco se confunde con un fallo de carga, y esto no lo es. No transforma el valor. */
const dato = (v: string | null) => (v && v.trim() ? v : '—');

export default function CeldaVehiculoSoat({
  placa, vin, marca, linea, cilindraje, carroceria, tipoServicio, multiplePropietario,
}: {
  placa: string | null; vin: string | null; marca: string | null; linea: string | null;
  cilindraje: string | null; carroceria: string | null; tipoServicio: string | null;
  multiplePropietario: boolean;
}) {
  const vehiculo = [marca, linea].filter(Boolean).join(' ');
  return (
    <td className="px-4 py-2 align-top">
      <div className="text-sm font-semibold">{placa ?? '—'}</div>
      {/* El VIN en monoespaciado: son diecisiete caracteres que se comparan de un vistazo. */}
      <div className="font-mono text-[11px]" style={{ color: 'var(--flit-text-secondary)' }}>{vin ?? '—'}</div>
      {vehiculo && <div className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{vehiculo}</div>}
      {/* HU #11906 — cilindraje, carrocería y tipo de servicio en UNA línea dentro de esta celda, no
          en tres columnas nuevas: serían 13 columnas, más ancha que antes de la HU #11905, que vino
          justo a aligerarla. Las tres ranuras se pintan SIEMPRE y en orden fijo, con rótulo corto;
          la que falta dice «—» en su sitio y la línea no se colapsa, porque `— · — · —` con rótulos
          dice QUÉ falta y sin ellos no diría nada.
          Los valores se pintan tal como llegan: nada de `parseInt` ni separador de miles sobre el
          cilindraje (ver el comentario de `SoatItem` en FlitoSoat). */}
      <div className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
        Cil. {dato(cilindraje)} · Carr. {dato(carroceria)} · Serv. {dato(tipoServicio)}
      </div>
      {/* Mismo tratamiento tipográfico que tenía como `extra` del trámite: ni más ni menos énfasis. */}
      {multiplePropietario && (
        <div className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Múltiple propietario</div>
      )}
    </td>
  );
}
