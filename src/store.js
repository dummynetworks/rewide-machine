import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export async function createPageStore(outputPath) {
  const absolutePath = resolve(outputPath);
  await mkdir(dirname(absolutePath), { recursive: true });

  return {
    path: absolutePath,

    async write(record) {
      await appendFile(
        absolutePath,
        `${JSON.stringify(record)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
    },
  };
}
