import { Button, Spinner, Text, makeStyles, shorthands, tokens } from "@fluentui/react-components";
import { Home20Regular, Library20Regular } from "@fluentui/react-icons";
import { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";

const useStyles = makeStyles({
  shell: { minHeight: "100vh", backgroundColor: "#071B33", color: "#F7FBFF" },
  header: {
    height: "64px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    ...shorthands.padding("0", "32px"),
    borderBottom: "1px solid rgba(137, 193, 235, .18)",
    backgroundColor: "#09223D"
  },
  brand: { fontSize: "20px", fontWeight: tokens.fontWeightSemibold, color: "#FFFFFF" },
  nav: { display: "flex", ...shorthands.gap("8px") },
  navLink: { textDecorationLine: "none" },
  main: { width: "min(1180px, calc(100% - 48px))", margin: "0 auto", ...shorthands.padding("40px", "0", "64px") },
  active: { backgroundColor: "rgba(71, 165, 232, .18)" }
});

export function StudioShell({ children, title, description, actions }: { children: ReactNode; title?: string; description?: string; actions?: ReactNode }) {
  const styles = useStyles();
  const location = useLocation();
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link className={`${styles.brand} studio-brand`} to="/">Scrum Studio</Link>
        <nav className={styles.nav} aria-label="Primary navigation">
          <Link className={styles.navLink} to="/"><Button appearance="subtle" icon={<Home20Regular />} className={location.pathname === "/" ? styles.active : ""}>Home</Button></Link>
          <Link className={styles.navLink} to="/reviews"><Button appearance="subtle" icon={<Library20Regular />} className={location.pathname.startsWith("/reviews") ? styles.active : ""}>Saved reviews</Button></Link>
        </nav>
      </header>
      <main className={styles.main}>
        {(title || description || actions) && (
          <div className="page-heading">
            <div>{title && <h1>{title}</h1>}{description && <Text size={400}>{description}</Text>}</div>
            {actions && <div className="page-actions">{actions}</div>}
          </div>
        )}
        {children}
      </main>
    </div>
  );
}

export function LoadingState({ label = "Loading Scrum Studio" }: { label?: string }) {
  return <div className="state-panel"><Spinner label={label} /></div>;
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : "Scrum Studio could not load this view.";
  return <div className="state-panel error-state"><strong>Needs attention</strong><Text>{message}</Text>{onRetry && <Button onClick={onRetry}>Try again</Button>}</div>;
}
