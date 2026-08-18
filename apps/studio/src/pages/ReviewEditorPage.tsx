import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Checkbox, Field, Input, MessageBar, MessageBarBody, Spinner, Text, Textarea, Title2 } from "@fluentui/react-components";
import { Add20Regular, ArrowDown20Regular, ArrowSync20Regular, ArrowUp20Regular, CloudArrowDown20Regular, Save20Regular } from "@fluentui/react-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import { useNavigate, useParams } from "react-router-dom";
import { z } from "zod";
import { api } from "../api";
import { ErrorState, LoadingState, StudioShell } from "../components/StudioShell";
import { SectionEditor } from "../components/SectionEditor";
import { deleteLocalDraft, readLocalDraft, saveLocalDraft } from "../drafts";
import type { Narrative, ReviewFormValues, ReviewSection, SectionType, Story } from "../types";

const sectionSchema = z.custom<ReviewSection>((value) => Boolean(value && typeof value === "object" && "id" in value && "type" in value && "title" in value));
const storySchema = z.custom<Story>((value) => Boolean(value && typeof value === "object" && "id" in value && "title" in value));
const formSchema: z.ZodType<ReviewFormValues> = z.object({
  identity: z.object({ team: z.string(), sprint: z.string(), startDate: z.string(), finishDate: z.string() }),
  narrative: z.object({
    summary: z.string(), openingTitle: z.string(), openingSubtitle: z.string(), sections: z.array(sectionSchema),
    teamLogo: z.object({ imageData: z.string().optional(), imageName: z.string().optional(), mediaRef: z.string().optional() }),
    metricSectionsConfigured: z.boolean(),
    environmentReadiness: z.object({
      training: z.object({ enabled: z.boolean(), message: z.string(), stories: z.array(storySchema) }),
      uat: z.object({ enabled: z.boolean(), message: z.string(), stories: z.array(storySchema) })
    })
  })
});

const metricTypes: SectionType[] = ["agile_metrics", "burndown", "velocity"];
const contentTypes: SectionType[] = ["delivery", "screenshot", "challenge", "risk", "next_steps", "live_demo"];
const sectionLabels: Record<SectionType, string> = {
  delivery: "Delivery update", screenshot: "Screenshot", challenge: "Challenge", risk: "Risk", next_steps: "Next steps", live_demo: "Live demo",
  agile_metrics: "Agile metrics", burndown: "Burndown", velocity: "Velocity"
};
const isMetricType = (type: SectionType) => metricTypes.includes(type);

function section(type: SectionType): ReviewSection {
  return {
    id: crypto.randomUUID(), type, title: type === "live_demo" ? "Demo" : "", bodyText: "", businessValue: "", stories: [],
    impact: "medium", likelihood: "medium", roam: "owned", presenters: [], enabled: type === "live_demo"
  };
}

function dateInputValue(value: string | undefined) {
  const match = String(value || "").match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : "";
}

function initialValues(record: { review: { team: string; sprintName: string; dateRange: { startDate: string; finishDate: string }; narrative: Narrative } }): ReviewFormValues {
  const narrative = structuredClone(record.review.narrative);
  if (!narrative.sections?.length) narrative.sections = [section("delivery"), section("next_steps"), section("live_demo")];
  return { identity: { team: record.review.team || "", sprint: record.review.sprintName || "Sprint Spotlight", startDate: dateInputValue(record.review.dateRange?.startDate), finishDate: dateInputValue(record.review.dateRange?.finishDate) }, narrative };
}

export function ReviewEditorPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const reviewQuery = useQuery({ queryKey: ["review", id], queryFn: () => api.getReview(id), enabled: Boolean(id) });
  const [etag, setEtag] = useState("");
  const [draftNotice, setDraftNotice] = useState<ReviewFormValues | null>(null);
  const [saveState, setSaveState] = useState("Cloud draft ready");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const initialized = useRef(false);
  const form = useForm<ReviewFormValues>({ resolver: zodResolver(formSchema), defaultValues: undefined });
  const fields = useFieldArray({ control: form.control, name: "narrative.sections", keyName: "fieldKey" });
  const values = form.watch();
  const review = reviewQuery.data?.review;

  useEffect(() => {
    if (!reviewQuery.data || initialized.current) return;
    const next = initialValues(reviewQuery.data);
    form.reset(next);
    setEtag(reviewQuery.data.etag);
    initialized.current = true;
    readLocalDraft<ReviewFormValues>(id).then((local) => {
      const isNewer = local && new Date(local.savedAt) > new Date(reviewQuery.data!.review.updatedAt);
      const hasDifferentContent = local && JSON.stringify(local.value) !== JSON.stringify(next);
      if (isNewer && hasDifferentContent) setDraftNotice(local.value);
    }).catch(() => undefined);
  }, [form, id, reviewQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (payload: ReviewFormValues) => api.saveReview(id, payload, etag),
    onMutate: () => setSaveState("Saving to cloud..."),
    onSuccess: (record) => {
      setEtag(record.etag);
      setSaveState(`Cloud draft saved ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
      const current = form.getValues();
      const savedSections = new Map(record.review.narrative.sections.map((item) => [item.id, item]));
      current.narrative.teamLogo.mediaRef = record.review.narrative.teamLogo.mediaRef || current.narrative.teamLogo.mediaRef;
      current.narrative.sections = current.narrative.sections.map((item) => ({ ...item, mediaRef: savedSections.get(item.id)?.mediaRef || item.mediaRef }));
      form.reset(current);
      deleteLocalDraft(id).catch(() => undefined);
      queryClient.setQueryData(["review", id], record);
    },
    onError: () => setSaveState("Cloud save needs attention")
  });

  useEffect(() => {
    if (!initialized.current || !values?.narrative || !form.formState.isDirty) return;
    const localTimer = window.setTimeout(() => saveLocalDraft(id, values).catch(() => undefined), 350);
    const cloudTimer = window.setTimeout(() => { if (!saveMutation.isPending) saveMutation.mutate(form.getValues()); }, 3500);
    return () => { window.clearTimeout(localTimer); window.clearTimeout(cloudTimer); };
  }, [values, id]);

  const generate = useMutation({
    mutationFn: async () => { const saved = await api.saveReview(id, form.getValues(), etag); setEtag(saved.etag); await deleteLocalDraft(id).catch(() => undefined); return api.generateReview(id, saved.etag); },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["review", id], refetchType: "all" }); navigate(`/reviews/${id}`); }
  });
  const refresh = useMutation({ mutationFn: () => api.refreshReview(id, etag), onSuccess: (record) => { setEtag(record.etag); form.reset(initialValues(record)); queryClient.setQueryData(["review", id], record); } });
  const currentStories = useMemo(() => review?.result?.workItems?.items || [], [review]);
  const nextStories = useMemo(() => review?.nextWorkItems?.items || [], [review]);

  if (reviewQuery.isLoading || !initialized.current && !reviewQuery.error) return <StudioShell><LoadingState label="Opening your review workspace" /></StudioShell>;
  if (reviewQuery.error || !review) return <StudioShell><ErrorState error={reviewQuery.error} onRetry={() => reviewQuery.refetch()} /></StudioShell>;

  const isAdo = review.source === "ado";
  const entries = fields.fields.map((field, index) => ({ field, index, value: values.narrative.sections[index] as ReviewSection })).filter((entry) => entry.value);
  const metricEntries = entries.filter((entry) => isMetricType(entry.value.type));
  const contentEntries = entries.filter((entry) => !isMetricType(entry.value.type));
  const activeTypes = new Set(entries.map((entry) => entry.value.type));
  const add = (type: SectionType) => {
    if (isMetricType(type)) {
      const insertAt = metricEntries.length ? metricEntries[metricEntries.length - 1].index + 1 : 0;
      fields.insert(insertAt, section(type) as never);
      return;
    }
    fields.append(section(type) as never);
  };
  const moveWithin = (entryIndex: number, direction: -1 | 1, group: typeof entries) => {
    const position = group.findIndex((entry) => entry.index === entryIndex);
    const target = group[position + direction];
    if (target) fields.move(entryIndex, target.index);
  };
  const dropOn = (targetIndex: number, targetType: SectionType) => {
    if (dragIndex === null || dragIndex === targetIndex) return setDragIndex(null);
    const sourceType = values.narrative.sections[dragIndex]?.type;
    if (sourceType && isMetricType(sourceType) === isMetricType(targetType)) fields.move(dragIndex, targetIndex);
    setDragIndex(null);
  };
  const scrollTo = (anchor: string) => document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });

  const logo = values?.narrative?.teamLogo;
  const readLogo = (file?: File) => {
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) return window.alert("That logo is larger than 12 MB.");
    const reader = new FileReader();
    reader.onload = () => {
      form.setValue("narrative.teamLogo.imageData", String(reader.result || ""), { shouldDirty: true });
      form.setValue("narrative.teamLogo.imageName", file.name, { shouldDirty: true });
      form.setValue("narrative.teamLogo.mediaRef", "", { shouldDirty: true });
      api.uploadMedia(id, file).then(({ mediaRef }) => form.setValue("narrative.teamLogo.mediaRef", mediaRef, { shouldDirty: true })).catch((error) => window.alert(error instanceof Error ? error.message : "The logo could not be uploaded. Your browser recovery draft still has it."));
    };
    reader.readAsDataURL(file);
  };

  const outlineGroup = (title: string, group: typeof entries) => (
    <div className="outline-group">
      <Text className="outline-label">{title}</Text>
      <div className="outline-list">
        {group.map((entry, position) => (
          <div
            className="outline-item"
            draggable
            key={entry.field.fieldKey}
            onDragStart={() => setDragIndex(entry.index)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => dropOn(entry.index, entry.value.type)}
          >
            <button type="button" className="outline-item-main" onClick={() => scrollTo(`review-section-${entry.value.id}`)}>
              <span className="drag-handle" aria-hidden="true">⋮⋮</span>
              <span>{entry.value.title || sectionLabels[entry.value.type]}</span>
            </button>
            <div className="outline-order-actions">
              <Button size="small" appearance="subtle" icon={<ArrowUp20Regular />} aria-label={`Move ${sectionLabels[entry.value.type]} up`} disabled={position === 0} onClick={() => moveWithin(entry.index, -1, group)} />
              <Button size="small" appearance="subtle" icon={<ArrowDown20Regular />} aria-label={`Move ${sectionLabels[entry.value.type]} down`} disabled={position === group.length - 1} onClick={() => moveWithin(entry.index, 1, group)} />
            </div>
          </div>
        ))}
        {!group.length && <Text className="outline-empty">No sections added</Text>}
      </div>
    </div>
  );

  return (
    <StudioShell title="Build the review" description={isAdo ? `${review.team} | ${review.sprintName}` : "Manual review workspace"} actions={<><Button appearance="outline" icon={<Save20Regular />} onClick={() => saveMutation.mutate(form.getValues())}>Save now</Button>{isAdo && <Button appearance="outline" icon={<ArrowSync20Regular />} disabled={refresh.isPending} onClick={() => refresh.mutate()}>Refresh ADO data</Button>}<Button className="generate-button" appearance="primary" disabled={generate.isPending} onClick={() => generate.mutate()}>{generate.isPending ? "Generating review..." : "Generate review"}</Button></>}>
      <div className={`draft-status ${saveMutation.isError ? "error" : ""}`}><span className="status-dot" /><div><strong>Draft protection is on</strong><Text>{saveState}</Text></div></div>
      {draftNotice && <MessageBar intent="warning"><MessageBarBody>A newer browser recovery draft is available.</MessageBarBody><Button size="small" onClick={() => { form.reset(draftNotice); setDraftNotice(null); }}>Restore it</Button><Button size="small" appearance="subtle" onClick={() => { deleteLocalDraft(id).catch(() => undefined); setDraftNotice(null); }}>Dismiss</Button></MessageBar>}
      {(saveMutation.error || generate.error || refresh.error) && <MessageBar intent="error"><MessageBarBody>{String((saveMutation.error || generate.error || refresh.error)?.message)}</MessageBarBody></MessageBar>}

      <div className="builder-workspace">
        <aside className="builder-outline" aria-label="Review outline">
          <div className="outline-heading"><Text className="eyebrow">REVIEW OUTLINE</Text><strong>Sections</strong><Text>Drag or use the arrows to reorder.</Text></div>
          <nav className="outline-anchors" aria-label="Review details">
            <button type="button" onClick={() => scrollTo("review-identity")}>Review details</button>
            <button type="button" onClick={() => scrollTo("opening-remarks")}>Opening remarks</button>
          </nav>
          {outlineGroup("METRICS", metricEntries)}
          {outlineGroup("REVIEW", contentEntries)}
          <nav className="outline-anchors" aria-label="Stakeholder readiness"><button type="button" onClick={() => scrollTo("stakeholder-readiness")}>Stakeholder readiness</button></nav>
        </aside>

        <form className="builder-form builder-canvas" onSubmit={(event) => event.preventDefault()}>
          <section id="review-identity" className="workspace-card identity-editor">
            <div className="logo-column"><Text className="eyebrow">TEAM LOGO</Text><div className="logo-preview">{logo?.imageData ? <img src={logo.imageData} alt="Team logo preview" /> : <span>Optional team logo</span>}</div><input className="file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => readLogo(event.target.files?.[0])} />{(logo?.imageData || logo?.mediaRef) && <Button size="small" onClick={() => { form.setValue("narrative.teamLogo.imageData", "", { shouldDirty: true }); form.setValue("narrative.teamLogo.mediaRef", "", { shouldDirty: true }); }}>Remove logo</Button>}</div>
            <div className="identity-fields"><div className="panel-heading"><Text className="eyebrow">REVIEW DETAILS</Text><Title2>{values?.identity?.sprint || "Sprint Spotlight"}</Title2></div><Controller control={form.control} name="identity.team" render={({ field }) => <Field label="Team"><Input {...field} disabled={isAdo} /></Field>} /><Controller control={form.control} name="identity.sprint" render={({ field }) => <Field label="Sprint or review name"><Input {...field} disabled={isAdo} /></Field>} /><div className="two-fields"><Controller control={form.control} name="identity.startDate" render={({ field }) => <Field label="Start date"><Input {...field} type="date" disabled={isAdo} /></Field>} /><Controller control={form.control} name="identity.finishDate" render={({ field }) => <Field label="Finish date"><Input {...field} type="date" disabled={isAdo} /></Field>} /></div></div>
          </section>

          <section id="opening-remarks" className="workspace-card"><div className="panel-heading"><Text className="eyebrow">EXECUTIVE SUMMARY</Text><Title2>Opening remarks</Title2></div><div className="two-fields"><Controller control={form.control} name="narrative.openingTitle" render={({ field }) => <Field label="Opening slide title"><Input {...field} /></Field>} /><Controller control={form.control} name="narrative.openingSubtitle" render={({ field }) => <Field label="Opening slide subtitle"><Input {...field} /></Field>} /></div><Controller control={form.control} name="narrative.summary" render={({ field }) => <Field label="Sprint summary"><Textarea {...field} resize="vertical" /></Field>} /></section>

          <section className="builder-zone metrics-zone">
            <div className="zone-heading"><div className="panel-heading"><Text className="eyebrow">ADO-POWERED METRICS</Text><Title2>Sprint signals</Title2><Text>{isAdo ? "Choose the signals stakeholders need." : "Connect ADO data to unlock sprint metrics."}</Text></div><div className="metric-actions">{metricTypes.map((type) => <Button key={type} disabled={!isAdo || activeTypes.has(type)} onClick={() => add(type)}>{sectionLabels[type]}</Button>)}</div></div>
            {!isAdo && <div className="metrics-locked"><CloudArrowDown20Regular /><div><strong>ADO data is not connected</strong><Text>Agile metrics, burndown, and velocity will become available after you select a team, work area, and sprint.</Text></div><Button appearance="primary" onClick={() => navigate(`/ado-admin?reviewId=${encodeURIComponent(id)}`, { state: { mode: "ado", reviewId: id, etag } })}>Add ADO data</Button></div>}
            <div className="section-list">{metricEntries.map((entry) => <SectionEditor key={entry.field.fieldKey} reviewId={id} index={entry.index} section={entry.value} control={form.control} setValue={form.setValue} stories={currentStories} nextStories={nextStories} onRemove={() => fields.remove(entry.index)} />)}</div>
          </section>

          <section className="builder-zone review-zone">
            <div className="zone-heading"><div className="panel-heading"><Text className="eyebrow">REVIEW CONTENT</Text><Title2>Shape the story</Title2><Text>Add only the sections this review needs.</Text></div><div className="add-sections">{contentTypes.map((type) => <Button key={type} icon={<Add20Regular />} onClick={() => add(type)}>{sectionLabels[type]}</Button>)}</div></div>
            <div className="section-list">{contentEntries.map((entry) => <SectionEditor key={entry.field.fieldKey} reviewId={id} index={entry.index} section={entry.value} control={form.control} setValue={form.setValue} stories={currentStories} nextStories={nextStories} onRemove={() => fields.remove(entry.index)} />)}</div>
          </section>

          <section id="stakeholder-readiness" className="workspace-card readiness-editor"><div className="panel-heading"><Text className="eyebrow">STAKEHOLDER READINESS</Text><Title2>What this means for you</Title2></div>{(["training", "uat"] as const).map((audience) => { const selected = values.narrative.environmentReadiness[audience].stories || []; const selectedIds = new Set(selected.map((story) => String(story.id))); return <div className="readiness-row" key={audience}><Controller control={form.control} name={`narrative.environmentReadiness.${audience}.enabled`} render={({ field }) => <Checkbox checked={field.value} onChange={(_, data) => field.onChange(Boolean(data.checked))} label={audience === "training" ? "Items expected in Training Environment" : "Items expected in UAT"} />} /><Controller control={form.control} name={`narrative.environmentReadiness.${audience}.message`} render={({ field }) => <Field label="Message when no stories are selected"><Input {...field} /></Field>} />{isAdo && <div className="story-picker"><div className="story-picker-heading"><strong>Select stories</strong></div><div className="story-list">{currentStories.map((story) => <Checkbox key={`${audience}-${story.id}`} checked={selectedIds.has(String(story.id))} label={`${story.type || "Item"} ${story.id}: ${story.title}`} onChange={(_, data) => { const next = data.checked ? [...selected, story] : selected.filter((item) => String(item.id) !== String(story.id)); form.setValue(`narrative.environmentReadiness.${audience}.stories`, next, { shouldDirty: true }); }} />)}</div></div>}</div>; })}</section>
        </form>
      </div>
      {(saveMutation.isPending || generate.isPending) && <div className="saving-overlay"><Spinner label={generate.isPending ? "Generating review" : "Protecting your review"} /></div>}
    </StudioShell>
  );
}
