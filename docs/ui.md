# UI Components

Drop-in React components from `@freeappstore/sdk/ui`. Components use CSS custom properties (`--ink`, `--accent`, etc.) to blend into your app's theme.

```tsx
import {
  // App shell
  FasShell, ProfileMenu, ProfilePage,
  // Auth & identity
  Avatar, SignInButton,
  // Controls
  ThemeToggle, TextSizeToggle,
  // Friends
  AddFriendButton, FriendRequestBadge, FriendsList,
  // Voice
  VoiceButton, VoiceTextArea,
  // Feedback
  Spinner, Badge, ProgressBar, EmptyState, ErrorBoundary,
  // Data display
  Card, ListRow, Tabs,
  // Overlays
  Modal, ConfirmDialog,
  // Input
  SearchInput,
  // API keys
  KeyPrompt,
  // Info
  BuildInfo, Footer,
} from '@freeappstore/sdk/ui';
```

## FasShell

Zero-config app shell with auth, theme toggle, and profile menu built in.

```tsx
<FasShell app={fas} appName="My App">
  <MyApp />
</FasShell>
```

## Auth & Identity

| Component | Props | Description |
|-----------|-------|-------------|
| `Avatar` | `user`, `size` | GitHub avatar with fallback |
| `SignInButton` | `app` | Sign in with GitHub button |

## Controls

| Component | Props | Description |
|-----------|-------|-------------|
| `ThemeToggle` | -- | Light/dark mode toggle |
| `TextSizeToggle` | -- | Text size accessibility toggle |

## Layout & Navigation

| Component | Props | Description |
|-----------|-------|-------------|
| `ProfileMenu` | `app`, `user` | Dropdown with profile, settings, sign out |
| `ProfilePage` | `app` | Full profile page with account management |
| `Tabs` | `tabs`, `active`, `onChange` | Tab navigation |

## Friends

| Component | Props | Description |
|-----------|-------|-------------|
| `AddFriendButton` | `app`, `userId` | Send friend request button |
| `FriendRequestBadge` | `app` | Badge showing pending friend request count |
| `FriendsList` | `app` | Full friends list with status |

## Voice

| Component | Props | Description |
|-----------|-------|-------------|
| `VoiceButton` | `onResult` | Push-to-talk voice input button |
| `VoiceTextArea` | `value`, `onChange`, `onVoiceResult` | Text area with integrated voice input |

## Feedback

| Component | Props | Description |
|-----------|-------|-------------|
| `Spinner` | `size` | Loading spinner |
| `Badge` | `variant` (`success`, `warning`, `danger`, `info`) | Status badge |
| `ProgressBar` | `value`, `label` | Progress indicator |
| `EmptyState` | `message` | Placeholder for empty lists |
| `ErrorBoundary` | `children` | React error boundary with fallback UI |

## Data Display

| Component | Props | Description |
|-----------|-------|-------------|
| `Card` | `onClick` | Clickable card container |
| `ListRow` | `title`, `subtitle`, `onClick` | List item row |

## Overlays

| Component | Props | Description |
|-----------|-------|-------------|
| `Modal` | `open`, `onClose`, `title` | Modal dialog |
| `ConfirmDialog` | `open`, `onConfirm`, `onCancel`, `title`, `message`, `variant` | Confirmation dialog |

## Input

| Component | Props | Description |
|-----------|-------|-------------|
| `SearchInput` | `value`, `onChange` | Search field with icon |

## API Keys

| Component | Props | Description |
|-----------|-------|-------------|
| `KeyPrompt` | `app`, `provider`, `providerName` | Prompts user to configure an API key |

## Info

| Component | Props | Description |
|-----------|-------|-------------|
| `BuildInfo` | -- | Shows SDK version and build metadata |
| `Footer` | -- | Standard platform footer |

## Hooks (from `@freeappstore/sdk/ui`)

| Hook | Returns | Description |
|------|---------|-------------|
| `useTextSize` | `{ size, setSize }` | Text size preference |
| `useStandalone` | `boolean` | Detects PWA standalone mode |

## Theming

All components respect the platform design system tokens. Override accent color:

```css
:root {
  --accent: #10b981;
}
```

Brand fonts (Manrope + Fraunces) and the full token set are loaded by `FasShell`. If you're not using `FasShell`, include the platform stylesheet manually.
