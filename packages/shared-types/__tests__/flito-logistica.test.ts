import { describe, expect, it } from 'vitest';
import {
  ESTADO_DOCUMENTO_LOGISTICA_LABEL,
  ESTADO_LOGISTICA_SIMPLE_LABEL,
  EstadoDocumentoLogistica,
  EstadoLogisticaSimple,
  ESTADOS_LOGISTICA_SIMPLE_ORDEN,
  simplificarEstadoLogistica,
} from '../src/flito-logistica';

// HU #14121 — «En FLIT» es vocabulario propio. No se colapsa en Registrada ni entra en la línea de 4 pasos.
describe('simplificarEstadoLogistica — En FLIT (HU #14121)', () => {
  it('conserva en_flit', () => {
    expect(simplificarEstadoLogistica('en_flit')).toBe('en_flit');
    expect(simplificarEstadoLogistica(EstadoDocumentoLogistica.EN_FLIT)).toBe(EstadoLogisticaSimple.EN_FLIT);
    expect(ESTADO_DOCUMENTO_LOGISTICA_LABEL.en_flit).toBe('En FLIT');
    expect(ESTADO_LOGISTICA_SIMPLE_LABEL.en_flit).toBe('En FLIT');
  });

  it('clasificado sigue en registrada', () => {
    expect(simplificarEstadoLogistica('clasificado')).toBe('registrada');
    expect(simplificarEstadoLogistica(EstadoDocumentoLogistica.CLASIFICADO)).toBe(EstadoLogisticaSimple.REGISTRADA);
  });

  it('En FLIT no es un paso de la línea universal', () => {
    expect(ESTADOS_LOGISTICA_SIMPLE_ORDEN).toEqual(['pendiente', 'registrada', 'despachada', 'entregada']);
    expect(ESTADOS_LOGISTICA_SIMPLE_ORDEN).not.toContain('en_flit');
  });
});
