import fastJson from 'fast-json-stringify';
export const stringify = fastJson({
  title: 'Coords Schema',
  type: 'object',
  properties: { x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' }, }
});
