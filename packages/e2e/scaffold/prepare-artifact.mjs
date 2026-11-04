import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Develop a tiny app-owned feature in the disposable scaffold before building.
// The release validator should reject untouched starter instructions.
const appPath = resolve(process.argv[2], 'web/src/App.tsx');
let source = await readFile(appPath, 'utf8');
if (!source.includes('<Home />') || !source.includes('Edit web/src/App.tsx to start building.')) {
  throw new Error('Scaffold Home changed; update the artifact feature fixture');
}
source = source
  .replaceAll('Edit web/src/App.tsx to start building.', 'Artifact feature fixture.')
  .replaceAll('<Home />', '<><ArtifactCounter /><Home /></>');
source += `
function ArtifactCounter() {
  const [count, setCount] = useState(0)
  return <section aria-label="Task counter">
    <button type="button" onClick={() => setCount(count + 1)}>Add task</button>
    <output aria-label="Task count">{count}</output>
  </section>
}
`;
await writeFile(appPath, source);
