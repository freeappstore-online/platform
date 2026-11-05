import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FORM_EXAMPLE } from '../../cli/dist/lib/developer-recipes.js';

// Develop a tiny app-owned feature in the disposable scaffold before building.
// The release validator should reject untouched starter instructions.
const appPath = resolve(process.argv[2], 'web/src/App.tsx');
let source = await readFile(appPath, 'utf8');
const starterDescriptions = [
  'description="Edit web/src/App.tsx to get started."',
  'description="Editable app-owned starter screen."',
];
const starterDescription = starterDescriptions.find((description) => source.includes(description));
const homeReturn = /function Home\(\)\s*\{\s*return ([\s\S]*?);\s*\}/;
if (!homeReturn.test(source) || !starterDescription) {
  throw new Error('Scaffold Home changed; update the artifact feature fixture');
}
source = source
  .replace(starterDescription, 'description="Artifact feature fixture."')
  .replace(
    homeReturn,
    (_match, home) =>
      `function Home() { return <><ArtifactCounter /><PwaWork /><FormExample />${home}</>; }`,
  );
source += `
import { EditItemButton } from './EditItemButton';
function FormExample() {
  const [item, setItem] = useState({ id: 'one', name: 'Example' });
  const [fail, setFail] = useState(false);
  const [pause, setPause] = useState(false);
  return <section aria-label="Editor example">
    <label><input type="checkbox" checked={fail} onChange={e => setFail(e.target.checked)} /> Simulate failed save</label>
    <label><input type="checkbox" checked={pause} onChange={e => setPause(e.target.checked)} /> Pause saves</label>
    <EditItemButton item={item} onSave={async next => {
      if (fail) throw new Error('Rejected write');
      if (pause) await new Promise<void>(resolve => window.addEventListener('resume-example-save', () => resolve(), { once: true }));
      setItem(next);
    }} />
    <output aria-label="Saved name">{item.name}</output>
  </section>
}
import { pwa } from './fas-capabilities/pwa';
let recording: MediaRecorder | undefined;
pwa.addBusyGuard(() => !!document.querySelector('[data-dirty="true"]'));
pwa.addBusyGuard(() => recording?.state === 'recording');
function PwaWork() {
  const [dirty, setDirty] = useState(false);
  const [active, setActive] = useState(false);
  return <section aria-label="Update protection" data-dirty={dirty}>
    <label style={{ display: 'block' }}>Unsaved note<input aria-label="Unsaved note" style={{ width: '100%', maxWidth: '18rem', boxSizing: 'border-box' }} onChange={() => setDirty(true)} /></label>
    <button onClick={() => setDirty(false)}>Save note</button>
    <button onClick={() => {
      if (recording?.state === 'recording') { recording.stop(); setActive(false); return; }
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator();
      oscillator.connect(destination); oscillator.start();
      recording = new MediaRecorder(destination.stream);
      recording.onstop = () => { oscillator.stop(); void context.close(); };
      recording.start(); setActive(true);
    }}>{active ? 'Stop recording' : 'Start recording'}</button>
  </section>
}
function ArtifactCounter() {
  const [count, setCount] = useState(0)
  return <section aria-label="Task counter">
    <button type="button" onClick={() => setCount(count + 1)}>Add task</button>
    <output aria-label="Task count">{count}</output>
  </section>
}
`;
await writeFile(appPath, source);
await writeFile(resolve(process.argv[2], 'web/src/EditItemButton.tsx'), FORM_EXAMPLE);
