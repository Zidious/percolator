import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isDirectRun } from '../util/entry.ts';
import { UserConfigSchema } from './schema.ts';

export async function writeJsonSchema(outFile: string): Promise<void> {
  const schema = z.toJSONSchema(UserConfigSchema, { io: 'input' });
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
}

// `pnpm schema [out]`; the default is the committed schema/percolator.schema.json
if (isDirectRun(process.argv[1], import.meta.url)) {
  await writeJsonSchema(process.argv[2] ?? path.resolve(import.meta.dirname, '..', '..', 'schema', 'percolator.schema.json'));
}
