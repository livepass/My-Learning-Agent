import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
it('refuses the full startup flag before opening a server', async () => {
 const child = spawn(process.execPath, ['--import', 'tsx', resolve('apps/learning-agent/src/server.ts'), '--profile', 'full'], { stdio: 'ignore' });
 const code = await new Promise<number | null>((yes, no) => { child.once('error', no); child.once('exit', yes); });
 expect(code).not.toBe(0);
}, 30000);
