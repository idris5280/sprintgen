import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Checkbox, Dropdown, Field, Input, Option, Text, Textarea, Title2 } from "@fluentui/react-components";
import { Add20Regular, Delete20Regular, Play20Regular } from "@fluentui/react-icons";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import { api } from "../api";
import { lobbyBackgroundOptions } from "../components/LobbyBackground";
import { StudioShell } from "../components/StudioShell";
import { defaultLobbySettings, normalizeLobbySettings } from "../lobbySettings";
import { triviaCategoryOptions } from "../triviaCategories";
import { lobbyBackgroundValues, triviaCategoryValues, type LobbySettings } from "../types";

const schema = z.object({
  meetingType: z.enum(["daily-standup", "sprint-planning", "sprint-review", "retrospective", "backlog-refinement", "knowledge-share"]),
  title: z.string(), team: z.string(), prompt: z.string(), startTime: z.string(), showTrivia: z.boolean(),
  triviaCategories: z.array(z.enum(triviaCategoryValues)),
  locations: z.array(z.object({ id: z.string(), city: z.string() })).max(4),
  background: z.enum(lobbyBackgroundValues)
}).superRefine((value, context) => {
  if (value.showTrivia && value.triviaCategories.length === 0) context.addIssue({ code: "custom", path: ["triviaCategories"], message: "Choose at least one trivia topic." });
});

const meetingTypes: Array<[LobbySettings["meetingType"], string]> = [
  ["daily-standup", "Daily Standup"], ["sprint-planning", "Sprint Planning"], ["sprint-review", "Sprint Review"],
  ["retrospective", "Retrospective"], ["backlog-refinement", "Backlog Refinement"], ["knowledge-share", "Knowledge Share"]
];

export function LobbyPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const saved = useQuery({ queryKey: ["lobby-settings"], queryFn: api.lobbySettings });
  const form = useForm<LobbySettings>({ resolver: zodResolver(schema), defaultValues: defaultLobbySettings, values: saved.data?.settings ? normalizeLobbySettings(saved.data.settings) : undefined });
  const locations = useFieldArray({ control: form.control, name: "locations", keyName: "fieldKey" });
  const showTrivia = form.watch("showTrivia");
  const save = useMutation({ mutationFn: (settings: LobbySettings) => api.saveLobbySettings(settings, saved.data?.etag), onSuccess: (result) => { localStorage.setItem("scrum-studio-lobby-config-v2", JSON.stringify(result.settings)); queryClient.setQueryData(["lobby-settings"], result); navigate("/lobby/run"); } });
  const launch = form.handleSubmit((value) => save.mutate({ ...value, locations: value.locations.filter((item) => item.city.trim()) }));
  return (
    <StudioShell title="Lobby" description="Set up the waiting room, then share the countdown screen with your team.">
      <form className="lobby-form" onSubmit={launch}>
        <section className="workspace-card">
          <div className="panel-heading"><Text className="eyebrow">CEREMONY</Text><Title2>Meeting setup</Title2></div>
          <div className="two-fields"><Controller control={form.control} name="meetingType" render={({ field }) => <Field label="Meeting type"><Dropdown value={meetingTypes.find(([value]) => value === field.value)?.[1] || ""} selectedOptions={[field.value]} onOptionSelect={(_, data) => field.onChange(data.optionValue)}>{meetingTypes.map(([value, label]) => <Option key={value} value={value}>{label}</Option>)}</Dropdown></Field>} /><Controller control={form.control} name="team" render={({ field }) => <Field label="Team name"><Input {...field} placeholder="Your team" /></Field>} /></div>
          <Controller control={form.control} name="title" render={({ field }) => <Field label="Meeting title"><Input {...field} placeholder="Uses the meeting type when left blank" /></Field>} />
          <Controller control={form.control} name="prompt" render={({ field }) => <Field label="Facilitation prompt"><Textarea {...field} resize="vertical" placeholder="Optional question or welcome prompt" /></Field>} />
          <Controller control={form.control} name="showTrivia" render={({ field }) => <Checkbox checked={field.value} label="Show light trivia while people arrive" onChange={(_, data) => field.onChange(Boolean(data.checked))} />} />
          {showTrivia && <Controller control={form.control} name="triviaCategories" render={({ field, fieldState }) => <Field label="Trivia topics" hint="Choose one or more topics for the countdown." validationMessage={fieldState.error?.message}><div className="trivia-topic-field"><div className="trivia-topic-actions"><Button type="button" size="small" appearance="subtle" onClick={() => field.onChange(triviaCategoryOptions.map((option) => option.value))}>Select all</Button><Button type="button" size="small" appearance="subtle" onClick={() => field.onChange([])}>Clear</Button></div><div className="trivia-topic-grid">{triviaCategoryOptions.map((option) => { const selected = field.value.includes(option.value); return <div className={`trivia-topic-option ${selected ? "selected" : ""}`} key={option.value}><Checkbox checked={selected} label={option.label} onChange={(_, data) => field.onChange(data.checked ? [...field.value, option.value] : field.value.filter((value) => value !== option.value))} /></div>; })}</div></div></Field>} />}
        </section>
        <section className="workspace-card">
          <div className="panel-heading"><Text className="eyebrow">TIMING</Text><Title2>Countdown</Title2></div>
          <Controller control={form.control} name="startTime" render={({ field }) => <Field label="Meeting start time" hint="Leave blank to start with a five-minute countdown."><Input {...field} type="time" /></Field>} />
        </section>
        <section className="workspace-card">
          <div className="section-heading"><div className="panel-heading"><Text className="eyebrow">TEAM WEATHER</Text><Title2>Locations</Title2><Text>Blank locations stay hidden from the countdown screen.</Text></div><Button icon={<Add20Regular />} disabled={locations.fields.length >= 4} onClick={() => locations.append({ id: crypto.randomUUID(), city: "" })}>Add location</Button></div>
          <div className="location-list">{locations.fields.map((location, index) => <div className="location-row" key={location.fieldKey}><Controller control={form.control} name={`locations.${index}.city`} render={({ field }) => <Field label={`Location ${index + 1}`}><Input {...field} placeholder={index === 0 ? "Nashville, TN" : index === 1 ? "Detroit, MI" : index === 2 ? "Las Vegas, NV" : "Oklahoma City, OK"} /></Field>} /><Button icon={<Delete20Regular />} aria-label="Remove location" onClick={() => locations.remove(index)} /></div>)}</div>
        </section>
        <section className="workspace-card">
          <div className="panel-heading"><Text className="eyebrow">ATMOSPHERE</Text><Title2>Background</Title2><Text>Choose the motion backdrop your team sees during the countdown.</Text></div>
          <Controller control={form.control} name="background" render={({ field }) => <div className="background-picker" role="radiogroup" aria-label="Lobby background">{lobbyBackgroundOptions.map((option) => <button key={option.value} type="button" className={`background-choice ${field.value === option.value ? "selected" : ""}`} aria-pressed={field.value === option.value} onClick={() => field.onChange(option.value)}><span className={`background-preview background-preview-${option.value}`} aria-hidden="true" /><strong>{option.label}</strong>{field.value === option.value && <span className="background-selected">Selected</span>}</button>)}</div>} />
        </section>
        {save.error && <div className="inline-error">{save.error.message}</div>}
        <div className="form-actions"><Button type="submit" appearance="primary" size="large" icon={<Play20Regular />} disabled={save.isPending}>{save.isPending ? "Saving lobby..." : "Launch Lobby"}</Button></div>
      </form>
    </StudioShell>
  );
}
