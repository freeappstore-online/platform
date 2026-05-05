import { Box, Text, useApp } from 'ink';
import { useEffect, useState } from 'react';
import { Doctor } from './screens/Doctor.js';
import { Menu, type MenuChoice } from './screens/Menu.js';
import { Welcome } from './screens/Welcome.js';
import { readConfig } from '../lib/config.js';

type Screen = 'welcome' | 'menu' | 'doctor';

interface SessionState {
  loaded: boolean;
  login: string | null;
}

export function App(): React.ReactElement {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>('welcome');
  const [session, setSession] = useState<SessionState>({ loaded: false, login: null });

  useEffect(() => {
    let active = true;
    void (async () => {
      let login: string | null = null;
      try {
        const config = await readConfig();
        login = config.github?.login ?? null;
      } catch {
        // Corrupt or unreadable config — degrade to "not signed in" rather
        // than getting stuck on the loading spinner forever.
      }
      if (!active) return;
      setSession({ loaded: true, login });
      setScreen(login ? 'menu' : 'welcome');
    })();
    return () => {
      active = false;
    };
  }, []);

  // No global 'q'-to-quit handler at the App level — child screens with
  // text inputs (NewApp wizard) need to receive 'q' as input. Each screen
  // owns its own keyboard shortcuts. Ctrl-C still exits via ink's default.

  if (!session.loaded) {
    return (
      <Box>
        <Text>Loading…</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Header login={session.login} />
      <Box marginY={1}>
        {screen === 'welcome' && <Welcome onContinue={() => setScreen('menu')} />}
        {screen === 'menu' && (
          <Menu login={session.login} onSelect={(choice) => handleMenu(choice, setScreen, exit)} />
        )}
        {screen === 'doctor' && <Doctor onBack={() => setScreen('menu')} />}
      </Box>
      <Footer screen={screen} />
    </Box>
  );
}

function handleMenu(
  choice: MenuChoice,
  setScreen: (s: Screen) => void,
  exit: () => void,
): void {
  switch (choice) {
    case 'doctor':
      setScreen('doctor');
      break;
    case 'quit':
      exit();
      break;
  }
}

function Header({ login }: { login: string | null }): React.ReactElement {
  return (
    <Box>
      <Text bold color="cyan">
        fas
      </Text>
      <Text color="gray">  ·  FreeAppStore CLI</Text>
      {login && (
        <>
          <Text color="gray">  ·  </Text>
          <Text color="green">@{login}</Text>
        </>
      )}
    </Box>
  );
}

function Footer({ screen }: { screen: Screen }): React.ReactElement {
  const hint =
    screen === 'menu'
      ? '↑↓ to navigate · Enter to select · q to quit'
      : screen === 'doctor'
        ? 'Esc/b to back · q to quit'
        : 'Enter to continue · q to quit';
  return (
    <Box>
      <Text color="gray" dimColor>
        {hint}
      </Text>
    </Box>
  );
}
