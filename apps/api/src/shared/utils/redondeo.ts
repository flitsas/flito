// Redondeo de valores monetarios a dos decimales, compartido entre `liquidacion` y `flito-liquidacion`
// (HU #14291, R9).
//
// No es un redondeo decimal exacto: multiplica en coma flotante, así que 1.005 da 1 y no 1.01, y un
// negativo redondea hacia cero en el empate (-0.005 da -0). Lo sellado y lo persistido dependen de estos
// resultados: cambiar la fórmula cambia valores de liquidaciones, no es un arreglo interno.

export const redondear = (n: number): number => Math.round(n * 100) / 100;
