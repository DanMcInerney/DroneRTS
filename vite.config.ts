import { defineConfig } from 'vite';
import { rendererIdentity } from './server/renderer-identity';

export default defineConfig({
  define: { __FLEET_RENDERER_ID__: JSON.stringify(rendererIdentity(import.meta.dirname)) },
});
