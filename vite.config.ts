import { defineConfig, type Plugin } from 'vite';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const MODELS_DIR = join(__dirname, 'public', 'models');

function listModels(dir = MODELS_DIR): { path: string; mtime: number }[] {
  let out: { path: string; mtime: number }[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out = out.concat(listModels(p));
    else if (name.endsWith('.glb')) out.push({ path: relative(MODELS_DIR, p).split('\\').join('/'), mtime: st.mtimeMs });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * /__models.json: public/models 아래 .glb 목록 (모델 뷰어가 쓴다). 개발 서버는 요청마다 만들고, 빌드는 같은 내용을 정적 파일로 내보낸다.
 */
function modelsIndex(): Plugin {
  return {
    name: 'sce-models-index',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '__models.json', source: JSON.stringify(listModels()) });
    },
    configureServer(server) {
      server.middlewares.use('/__models.json', (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify(listModels()));
      });
    },
  };
}

export default defineConfig({
  server: { host: '127.0.0.1' },
  plugins: [modelsIndex()],
  worker: { format: 'es' },
  build: {
    rollupOptions: {
      input: {
        main: join(__dirname, 'index.html'),
        basic: join(__dirname, 'examples', 'basic', 'index.html'),
        viewer: join(__dirname, 'viewer.html'),
      },
    },
  },
});
