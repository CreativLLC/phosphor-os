import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// The OS screensaver page (web/src/saver.ts) as a folder that opens from file:// with no server:
// saver.html, one classic script, one stylesheet, the fonts. `npm run build` runs it after the app's own build.
// os/omarchy/desktop.sh copies web/dist/saver/ into the screensaver plugin.
const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Screensaver</title>
    <link rel="stylesheet" href="./saver.css" />
  </head>
  <body>
    <script src="./saver.js"></script>
  </body>
</html>
`;

export default defineConfig({
  root: 'web',
  base: './',
  publicDir: false,
  build: {
    outDir: 'dist/saver',
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: { entry: resolve(import.meta.dirname, 'web/src/saver.ts'), formats: ['iife'], name: 'PhosphorSaver', fileName: () => 'saver.js', cssFileName: 'saver' },
  },
  plugins: [
    {
      name: 'saver-html',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'saver.html', source: HTML });
      },
    },
  ],
});
