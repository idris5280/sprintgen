import { Button, Checkbox, Dropdown, Field, MessageBar, MessageBarBody, Option, Spinner, Text } from "@fluentui/react-components";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";

function areaValue(area: { name?: string; path?: string; value?: string }) {
  return area.path || area.value || area.name || "";
}

export function AdoScopePicker({ reviewId = "", etag = "" }: { reviewId?: string; etag?: string }) {
  const navigate = useNavigate();
  const [team, setTeam] = useState("");
  const [sprint, setSprint] = useState("");
  const [areas, setAreas] = useState<string[]>([]);
  const teams = useQuery({ queryKey: ["ado", "teams"], queryFn: api.teams });
  const iterations = useQuery({ queryKey: ["ado", "iterations", team], queryFn: () => api.iterations(team), enabled: Boolean(team) });
  const workAreas = useQuery({ queryKey: ["ado", "work-areas", team], queryFn: () => api.workAreas(team), enabled: Boolean(team) });
  const create = useMutation({
    mutationFn: () => api.createAdo({ team, sprint, areaPaths: areas, reviewId: reviewId || undefined }, etag),
    onSuccess: ({ review }) => navigate(`/reviews/${review.id}/edit`, { replace: Boolean(reviewId) })
  });

  useEffect(() => { setSprint(""); setAreas([]); }, [team]);
  const teamOptions = teams.data?.teams || [];
  const iterationOptions = iterations.data?.iterations || [];
  const areaOptions = useMemo(() => (workAreas.data?.areas || []).map(areaValue).filter(Boolean), [workAreas.data]);
  const busy = teams.isLoading || iterations.isFetching || workAreas.isFetching || create.isPending;
  const error = teams.error || iterations.error || workAreas.error || create.error;

  return (
    <section className="workspace-card ado-scope">
      <div className="ado-intro panel-heading">
        <Text className="eyebrow">AZURE DEVOPS</Text>
        <h2>Choose the sprint scope</h2>
        <Text>Selections unlock in order. Your personal credentials are never requested.</Text>
      </div>
      <div className="scope-step">
        <div className="step-header"><span>1</span><div><strong>Team</strong><Text>Select the Azure DevOps team.</Text></div></div>
        <Field label="Azure DevOps team" validationMessage={teams.error instanceof Error ? teams.error.message : undefined}>
          <Dropdown value={team} selectedOptions={team ? [team] : []} placeholder={teams.isLoading ? "Loading teams..." : "Choose a team"} onOptionSelect={(_, data) => setTeam(String(data.optionValue || ""))}>
            {teamOptions.map((item) => <Option key={item.id || item.name} value={item.name}>{item.name}</Option>)}
          </Dropdown>
        </Field>
        {!teams.isLoading && !teams.error && !teamOptions.length && <MessageBar intent="warning"><MessageBarBody>No teams are available. Ask the Scrum Studio administrator to verify the ADO project and managed-identity permissions.</MessageBarBody></MessageBar>}
      </div>
      <div className={`scope-step ${!team ? "disabled-step" : ""}`}>
        <div className="step-header"><span>2</span><div><strong>Work areas</strong><Text>Select one or more value areas.</Text></div></div>
        <div className="area-options" aria-label="Work areas">
          {areaOptions.map((area) => <Checkbox key={area} disabled={!team} checked={areas.includes(area)} label={area} onChange={(_, data) => setAreas((current) => data.checked ? [...current, area] : current.filter((item) => item !== area))} />)}
          {team && workAreas.isLoading && <Text>Loading work areas...</Text>}
          {team && !workAreas.isLoading && !workAreas.error && !areaOptions.length && <Text>No work areas were returned for {team}. Verify its area-path configuration in Azure DevOps.</Text>}
          {workAreas.error instanceof Error && <Text>{workAreas.error.message}</Text>}
        </div>
      </div>
      <div className={`scope-step ${!areas.length ? "disabled-step" : ""}`}>
        <div className="step-header"><span>3</span><div><strong>Sprint</strong><Text>Choose the iteration to review.</Text></div></div>
        <Field label="Sprint" validationMessage={iterations.error instanceof Error ? iterations.error.message : undefined}>
          <Dropdown disabled={!areas.length || iterations.isLoading} value={iterationOptions.find((item) => item.path === sprint)?.name || ""} selectedOptions={sprint ? [sprint] : []} placeholder={!team ? "Choose a team first" : !areas.length ? "Choose a work area first" : iterations.isLoading ? "Loading sprints..." : "Choose a sprint"} onOptionSelect={(_, data) => setSprint(String(data.optionValue || ""))}>
            {iterationOptions.map((item) => <Option key={item.id || item.path} value={item.path}>{item.name}</Option>)}
          </Dropdown>
        </Field>
        {team && !iterations.isLoading && !iterations.error && !iterationOptions.length && <Text>No sprints were returned for {team}. Verify its iteration configuration in Azure DevOps.</Text>}
      </div>
      {error && <MessageBar intent="error"><MessageBarBody>{error instanceof Error ? error.message : "ADO data could not be loaded."}</MessageBarBody></MessageBar>}
      <div className="scope-submit">
        <Button appearance="primary" size="large" disabled={!team || !sprint || !areas.length || busy} onClick={() => create.mutate()}>{create.isPending ? "Loading workspace..." : reviewId ? "Load ADO into review" : "Load review workspace"}</Button>
        {create.isPending && <Spinner size="tiny" label="Loading stories and metrics" />}
      </div>
    </section>
  );
}
