import { defineConfig } from 'vite';
export default defineConfig({ base: '/SynchroCalculator/', worker: { format: 'es' }, build: { target: 'es2022' } });
