import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// CLAUDE.md rule 4 / GDD §29: the sim is independent of rendering.
describe('sim purity', () => {
  const dir = join(__dirname);
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  for (const f of files) {
    it(`${f} does not touch three, the DOM or Math.random`, () => {
      const src = readFileSync(join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(src).not.toMatch(/from ['"]three['"]/);
      expect(src).not.toMatch(/\b(window|document|navigator|localStorage)\./);
      expect(src).not.toMatch(/Math\.random\(/);
    });
  }
});
