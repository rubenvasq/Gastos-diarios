// scripts/build-www.mjs — copia la PWA (sin build real) a /www para que
// Capacitor la empaquete dentro del WebView nativo. No hay bundler: solo se
// copian los archivos que ya sirve `npm start`, excluyendo lo que es solo
// para desarrollo (proxy/, tests/, node_modules, etc.).
import { cp, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const wwwDir = new URL('../www/', import.meta.url);

const ENTRIES = [
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  'theme.config.js',
  'icons',
  'src',
  'styles',
  'vendor',
  'views',
];

await rm(wwwDir, { recursive: true, force: true });
await mkdir(wwwDir, { recursive: true });

for (const entry of ENTRIES) {
  const src = new URL(entry, root);
  if (!existsSync(src)) {
    console.warn(`(omitido, no existe) ${entry}`);
    continue;
  }
  await cp(src, new URL(entry, wwwDir), { recursive: true });
}

console.log(`www/ listo (${ENTRIES.length} entradas copiadas).`);
