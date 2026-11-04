import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useAuth, useTheme } from '../hooks.js';
import type { FreeAppStore } from '../index.js';
import { Modal } from './components.js';
import { Avatar, SignInButton, ThemeToggle, useTextSize } from './core.js';
import { FriendRequestBadge, FriendsList } from './friends.js';
import { PageHeader } from './page.js';

/** Shared by both public profile surfaces so failures and duplicate clicks behave alike. */
function useAccountDeletion(deleteAccount: () => Promise<void>, onDeleted?: () => void) {
  const deleting = useRef(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const remove = async () => {
    if (deleting.current) return;
    if (
      !confirm(
        'Delete your account? This permanently removes ALL your data across ALL apps. This cannot be undone.',
      )
    )
      return;
    if (!confirm('Are you absolutely sure? Last chance.')) return;
    deleting.current = true;
    setDeletePending(true);
    setDeleteError('');
    try {
      await deleteAccount();
      onDeleted?.();
    } catch {
      setDeleteError('Unable to delete your account. Please try again.');
    } finally {
      deleting.current = false;
      setDeletePending(false);
    }
  };
  return { pending: deletePending, error: deleteError, remove };
}

// ---------------------------------------------------------------------------
// ProfileMenu
// ---------------------------------------------------------------------------

export interface ProfileMenuProps {
  app: FreeAppStore;
  showThemeToggle?: boolean;
  children?: ReactNode;
}

/** Avatar button that opens dropdown: username, theme toggle, sign out, delete account. */
export function ProfileMenu({ app, showThemeToggle = true, children }: ProfileMenuProps) {
  const { user, signOut, deleteAccount } = useAuth(app);
  const [open, setOpen] = useState(false);
  const [friendsOpen, setFriendsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const {
    pending: deletePending,
    error: deleteError,
    remove: handleDelete,
  } = useAccountDeletion(deleteAccount, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const handler = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', handler);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', handler);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;

  const handleSignOut = () => {
    signOut();
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        ref={toggleRef}
        aria-label="Profile menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="bg-transparent border-2 border-line rounded-full p-0 cursor-pointer w-11 h-11 overflow-hidden flex items-center justify-center"
      >
        <Avatar user={user} size={28} />
      </button>
      {open && (
        <div className="absolute top-10 right-0 bg-popover border border-line rounded shadow-sm w-64 max-w-[calc(100vw-2rem)] p-[0.5rem_0] z-[100]">
          <div className="p-[0.5rem_1rem] border-b border-line text-[0.85rem] font-bold text-ink [overflow-wrap:anywhere]">
            {user.login}
          </div>
          {showThemeToggle && (
            <div className="p-[0.5rem_1rem] border-b border-line flex items-center justify-between">
              <span className="text-[0.85rem] text-muted">Theme</span>
              <ThemeToggle />
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              app.keys.manage();
              setOpen(false);
            }}
            className="block w-full p-[0.5rem_1rem] bg-transparent border-0 text-left text-[0.85rem] cursor-pointer text-ink font-[inherit]"
          >
            API Keys
          </button>
          <button
            type="button"
            onClick={() => {
              setFriendsOpen(true);
              setOpen(false);
            }}
            className="flex w-full p-[0.5rem_1rem] bg-transparent border-0 text-left text-[0.85rem] cursor-pointer text-ink font-[inherit] items-center justify-between"
          >
            Friends <FriendRequestBadge app={app} />
          </button>
          {children}
          <button
            type="button"
            onClick={handleSignOut}
            className="block w-full p-[0.5rem_1rem] bg-transparent border-0 text-left text-[0.85rem] cursor-pointer text-ink font-[inherit]"
          >
            Sign out
          </button>
          <button
            type="button"
            disabled={deletePending}
            onClick={handleDelete}
            className="block w-full p-[0.5rem_1rem] bg-transparent border-0 text-left text-[0.85rem] cursor-pointer text-danger font-[inherit]"
          >
            {deletePending ? 'Deleting...' : 'Delete account'}
          </button>
          {deleteError && (
            <p role="alert" className="px-4 py-2 text-sm text-danger">
              {deleteError}
            </p>
          )}
        </div>
      )}
      <Modal
        open={friendsOpen}
        onClose={() => setFriendsOpen(false)}
        title="Friends"
        maxWidth={420}
      >
        <FriendsList app={app} />
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProfilePage
// ---------------------------------------------------------------------------

export interface ProfilePageProps {
  app: FreeAppStore;
  showThemeToggle?: boolean;
}

/** Full-page profile & preferences: avatar, theme, text size, friends, sign out, delete. */
export function ProfilePage({ app, showThemeToggle = true }: ProfilePageProps) {
  const { user, loading, signOut, deleteAccount } = useAuth(app);
  const { preference, setPreference } = useTheme();
  const { size: textSize, setSize: setTextSize } = useTextSize();
  const [friendsOpen, setFriendsOpen] = useState(false);
  const {
    pending: deletePending,
    error: deleteError,
    remove: handleDelete,
  } = useAccountDeletion(deleteAccount);

  if (loading) {
    return <div className="p-8 text-center text-muted">Loading...</div>;
  }

  if (!user) {
    return (
      <div className="mx-auto w-full max-w-120 px-4 py-8">
        <PageHeader title="Profile" />
        <p className="text-muted mb-6">Sign in to manage your profile and account.</p>
        <div className="flex flex-col gap-3">
          <SignInButton app={app} provider="github" />
          <SignInButton app={app} provider="google" />
        </div>
      </div>
    );
  }

  const themeOptions: Array<{ value: 'light' | 'dark' | 'system'; label: string }> = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];

  const textSizeOptions: Array<{ value: 'default' | 'lg' | 'sm'; label: string }> = [
    { value: 'sm', label: 'Small' },
    { value: 'default', label: 'Default' },
    { value: 'lg', label: 'Large' },
  ];

  return (
    <div className="w-full max-w-120 m-[0_auto] p-[2rem_1rem]">
      <PageHeader title="Profile" />
      {/* Identity */}
      <div className="flex items-center gap-4 mb-8">
        <div className="shrink-0">
          <Avatar user={user} size={64} />
        </div>
        <div className="min-w-0">
          <div className="[overflow-wrap:anywhere] text-[1.25rem] font-bold text-ink-strong">
            {user.login}
          </div>
          <div className="text-[0.85rem] text-muted">FreeAppStore account</div>
        </div>
      </div>

      {/* Appearance */}
      <ProfileSection title="Appearance">
        {showThemeToggle && (
          <>
            <ProfileLabel>Theme</ProfileLabel>
            <div className="flex gap-2 mb-4">
              {themeOptions.map((opt) => (
                <ToggleButton
                  key={opt.value}
                  active={preference === opt.value}
                  onClick={() => setPreference(opt.value)}
                >
                  {opt.label}
                </ToggleButton>
              ))}
            </div>
          </>
        )}
        <ProfileLabel>Text Size</ProfileLabel>
        <div className="flex gap-2">
          {textSizeOptions.map((opt) => (
            <ToggleButton
              key={opt.value}
              active={textSize === opt.value}
              onClick={() => setTextSize(opt.value)}
            >
              {opt.label}
            </ToggleButton>
          ))}
        </div>
      </ProfileSection>

      {/* Friends */}
      <ProfileSection title="Friends">
        <button
          type="button"
          onClick={() => setFriendsOpen(true)}
          className="w-full p-3 rounded border border-line bg-panel text-ink text-[0.9rem] font-semibold cursor-pointer font-[inherit] flex items-center justify-between"
        >
          Manage Friends <FriendRequestBadge app={app} />
        </button>
      </ProfileSection>

      {/* API Keys */}
      <ProfileSection title="API Keys">
        <button
          type="button"
          onClick={() => app.keys.manage()}
          className="w-full p-3 rounded border border-line bg-panel text-ink text-[0.9rem] font-semibold cursor-pointer font-[inherit]"
        >
          Manage API Keys
        </button>
      </ProfileSection>

      {/* Account */}
      <button
        type="button"
        onClick={signOut}
        className="w-full p-3 rounded border border-line bg-panel text-ink text-[0.9rem] font-semibold cursor-pointer font-[inherit] mb-6"
      >
        Sign out
      </button>

      <div className="border border-danger rounded p-5">
        <div className="text-[0.9rem] font-bold text-danger mb-2">Danger zone</div>
        <p className="text-[0.85rem] text-muted mb-3">
          Permanently delete your account and all data across all apps.
        </p>
        <button
          type="button"
          disabled={deletePending}
          onClick={handleDelete}
          className="p-[0.5rem_1rem] rounded-sm border border-danger bg-transparent text-danger text-[0.85rem] font-semibold cursor-pointer font-[inherit]"
        >
          {deletePending ? 'Deleting...' : 'Delete account'}
        </button>
        {deleteError && (
          <p role="alert" className="mt-3 text-danger">
            {deleteError}
          </p>
        )}
      </div>

      <Modal
        open={friendsOpen}
        onClose={() => setFriendsOpen(false)}
        title="Friends"
        maxWidth={420}
      >
        <FriendsList app={app} />
      </Modal>
    </div>
  );
}

function ProfileSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bg-panel border border-line rounded p-5 mb-4">
      <div className="text-[0.9rem] font-bold mb-3 text-ink">{title}</div>
      {children}
    </div>
  );
}

function ProfileLabel({ children }: { children: ReactNode }) {
  return <div className="text-[0.75rem] font-semibold text-muted mb-[0.35rem]">{children}</div>;
}

function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'flex-1',
        'p-2',
        'rounded-sm',
        active ? 'border-2 border-accent' : 'border border-line',
        active ? 'bg-accent-soft' : 'bg-transparent',
        active ? 'text-accent' : 'text-muted',
        active ? 'font-bold' : 'font-medium',
        'text-[0.85rem]',
        'cursor-pointer',
        'font-[inherit]',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </button>
  );
}
