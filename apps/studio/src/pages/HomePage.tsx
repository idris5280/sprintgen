import { Button, Card, Text, Title2 } from "@fluentui/react-components";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { StudioShell } from "../components/StudioShell";

function firstName(value = "") {
  if (!value || /local developer/i.test(value)) return "";
  const identity = value.includes("@") ? value.split("@")[0] : value;
  return identity.split(/[\s._-]+/).find(Boolean) || "";
}

export function HomePage() {
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 5 * 60 * 1000 });
  const greetingName = firstName(me.data?.user.name);
  return (
    <StudioShell>
      <section className="home-intro">
        {greetingName && <Text className="home-greeting">Hi {greetingName}</Text>}
        <h1>Choose an app</h1>
        <Text size={400}>Enter the workspace you need.</Text>
      </section>
      <div className="tool-grid">
        <Card className="tool-card" tabIndex={0} role="link" onClick={() => navigate("/lobby")} onKeyDown={(event) => event.key === "Enter" && navigate("/lobby")}>
          <Text className="eyebrow">TEAM WAITING ROOM</Text>
          <Title2 className="app-title">Lobby</Title2>
          <Text size={400}>Prepare a screen-shared countdown for the team.</Text>
          <Link to="/lobby" onClick={(event) => event.stopPropagation()}><Button appearance="primary">Enter</Button></Link>
        </Card>
        <Card className="tool-card" tabIndex={0} role="link" onClick={() => navigate("/ado-admin")} onKeyDown={(event) => event.key === "Enter" && navigate("/ado-admin")}>
          <Text className="eyebrow">SPRINT SPOTLIGHTS</Text>
          <Title2 className="app-title">Spotlight</Title2>
          <Text size={400}>Build a stakeholder-ready sprint review.</Text>
          <Link to="/ado-admin" onClick={(event) => event.stopPropagation()}><Button appearance="primary">Enter</Button></Link>
        </Card>
      </div>
    </StudioShell>
  );
}
