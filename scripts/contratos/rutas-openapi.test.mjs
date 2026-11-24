import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aRutaOpenApi, compararRutas, identificadorDe, operacionesDeYaml, parametrosDeRuta } from './rutas-openapi.mjs';

const YAML = `openapi: 3.1.0
info:
  title: Demo
paths:
  /api/a/{id}:
    get:
      operationId: get-a
    post:
      operationId: post-a
  "/api/b":
    delete:
      operationId: delete-b
components:
  schemas:
    /api/no-es-ruta:
      get:
        type: object
`;

test('traduce parámetros de Express, con patrón y opcionales', () => {
  assert.equal(aRutaOpenApi('/a/:id(\\d+)/b/:otro?'), '/a/{id}/b/{otro}');
  assert.deepEqual(parametrosDeRuta('/a/:id(\\d+)').map((p) => [p.name, p.schema.pattern]), [['id', '^\\d+$']]);
  assert.equal(identificadorDe('get', '/api/a/:id'), 'get-api-a-id');
});

test('lee solo las operaciones de la sección paths', () => {
  assert.deepEqual([...operacionesDeYaml(YAML)].sort(), ['delete /api/b', 'get /api/a/{id}', 'post /api/a/{id}']);
});

test('falla si una ruta de Express no está en el contrato', () => {
  const { faltan, sobran } = compararRutas([
    { metodo: 'get', ruta: '/api/a/:id' }, { metodo: 'post', ruta: '/api/a/:id' }, { metodo: 'delete', ruta: '/api/b' }, { metodo: 'put', ruta: '/api/nueva' },
  ], operacionesDeYaml(YAML));
  assert.deepEqual(faltan, ['put /api/nueva']);
  assert.deepEqual(sobran, []);
});

test('falla si el contrato declara una ruta que ya no existe', () => {
  const { faltan, sobran } = compararRutas([{ metodo: 'get', ruta: '/api/a/:id' }], operacionesDeYaml(YAML));
  assert.deepEqual(faltan, []);
  assert.deepEqual(sobran, ['delete /api/b', 'post /api/a/{id}']);
});
