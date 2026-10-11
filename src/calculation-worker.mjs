import loadHighs from 'highs';
import wasmURL from 'highs/runtime?url';
import { calculate } from './optimizer.mjs';
let engine;
self.onmessage = async event => {
  try {
    engine ??= loadHighs({ locateFile: () => new URL(wasmURL, self.location.origin).href });
    self.postMessage({ id: event.data.id, result: calculate(event.data.data, event.data.input, await engine) });
  } catch (error) { self.postMessage({ id: event.data.id, error: error.message }); }
};
