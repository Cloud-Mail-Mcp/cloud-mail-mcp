import "./styles.css";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Redirect, Route, Router, Switch, useLocation } from "wouter";
import { Shell } from "./components/Shell";
import { Spinner } from "./components/ui";
import { ApiError, api, type Me } from "./lib/api";
import { AccountDetailPage, AccountsPage, AddAccountPage } from "./pages/Accounts";
import { ApprovalsPage, AuditPage } from "./pages/Activity";
import { AgentDetailPage, AgentsPage, PermissionsPage } from "./pages/Agents";
import { LoginPage } from "./pages/Auth";
import { ChatPage } from "./pages/Chat";
import { ConnectPage } from "./pages/Connect";
import { ImportPage } from "./pages/Import";
import { MailPage } from "./pages/Mail";
import { MigrationsPage } from "./pages/Migrations";
import { SettingsPage } from "./pages/Settings";
import { SetupWizard } from "./pages/Setup";
import { SortingPage } from "./pages/Sorting";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
      refetchOnWindowFocus: false,
    },
  },
});

function App() {
  const [location] = useLocation();
  const setup = useQuery({
    queryKey: ["setup"],
    queryFn: () => api<{ needsSetup: boolean; hasUsers: boolean }>("/setup/status"),
  });
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api<{ user: Me }>("/auth/me"),
    enabled: setup.data?.hasUsers === true,
  });

  if (setup.isLoading || (setup.data?.hasUsers && me.isLoading)) return <Spinner />;
  if (setup.error) return <p className="p-8 text-red-600">Can't reach the MailMCP server.</p>;
  // Brand-new server: setup wizard starts by creating the owner account.
  if (setup.data && !setup.data.hasUsers) return <SetupWizard key="owner" hasUsers={false} />;
  // Not signed in, or the session expired/was revoked.
  if (me.isError || !me.data) return <LoginPage />;
  // Owner exists but setup isn't finished: continue the wizard.
  if (setup.data?.needsSetup) return <SetupWizard key="settings" hasUsers />;
  // An AI app is asking to connect (OAuth): full-page consent, no admin chrome.
  if (location === "/connect") return <ConnectPage />;

  return (
    <Shell me={me.data.user}>
      <Switch>
        <Route path="/accounts" component={AccountsPage} />
        <Route path="/accounts/new" component={AddAccountPage} />
        <Route path="/accounts/import" component={ImportPage} />
        <Route path="/accounts/:id">{(p) => <AccountDetailPage key={p.id} id={p.id} />}</Route>
        <Route path="/settings" component={SettingsPage} />
        <Route path="/mail" component={MailPage} />
        <Route path="/chat" component={ChatPage} />
        <Route path="/agents" component={AgentsPage} />
        <Route path="/agents/:id">{(p) => <AgentDetailPage key={p.id} id={p.id} />}</Route>
        <Route path="/permissions" component={PermissionsPage} />
        <Route path="/approvals" component={ApprovalsPage} />
        <Route path="/sorting" component={SortingPage} />
        <Route path="/audit" component={AuditPage} />
        <Route path="/migrations" component={MigrationsPage} />
        <Route>
          <Redirect to="/accounts" />
        </Route>
      </Switch>
    </Shell>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Router base="/admin">
        <App />
      </Router>
    </QueryClientProvider>
  </StrictMode>,
);
