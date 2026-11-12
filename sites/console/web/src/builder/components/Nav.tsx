import { useAuth } from "../hooks/useAuth";
import { BASE, SiteNav } from "../../SiteNav";

/** The builder shows the same header as the rest of the console (#587). */
export function Nav() {
  const { user, signIn, signOut } = useAuth();
  // Full reload to the console root, so the console's own session state drops too.
  return <SiteNav user={user} onSignIn={signIn} onSignOut={() => { signOut(); window.location.assign(`${BASE}/`); }} />;
}
