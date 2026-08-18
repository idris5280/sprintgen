import { Button, Checkbox, Dropdown, Field, Input, Option, Text, Textarea } from "@fluentui/react-components";
import { Delete20Regular } from "@fluentui/react-icons";
import { Control, Controller, UseFormSetValue } from "react-hook-form";
import { api } from "../api";
import type { ReviewFormValues, ReviewSection, SectionType, Story } from "../types";

const labels: Record<SectionType, string> = {
  delivery: "Delivery update",
  screenshot: "Screenshot",
  challenge: "Challenge",
  risk: "Risk",
  next_steps: "Next steps",
  live_demo: "Live demo",
  agile_metrics: "Agile metrics",
  burndown: "Burndown",
  velocity: "Velocity"
};

const descriptions: Record<SectionType, string> = {
  delivery: "Tell the delivery story",
  screenshot: "Show a visual with supporting context",
  challenge: "Explain a challenge and response",
  risk: "Capture impact, likelihood, and ROAM status",
  next_steps: "Preview what comes next",
  live_demo: "Create a clear handoff for presenters",
  agile_metrics: "Sprint health numbers from Azure DevOps",
  burndown: "Remaining work across the sprint",
  velocity: "Completed work across recent sprints"
};

const isMetric = (type: SectionType) => ["agile_metrics", "burndown", "velocity"].includes(type);

function BodyField({ control, name, label, placeholder }: { control: Control<ReviewFormValues>; name: `narrative.sections.${number}.${"bodyText" | "businessValue" | "description" | "notes" | "note"}`; label: string; placeholder: string }) {
  return <Controller control={control} name={name} render={({ field }) => <Field label={label}><Textarea {...field} value={String(field.value || "")} resize="vertical" placeholder={placeholder} /></Field>} />;
}

function ImagePicker({ reviewId, index, setValue, section }: { reviewId: string; index: number; setValue: UseFormSetValue<ReviewFormValues>; section: ReviewSection }) {
  const readFile = (file?: File) => {
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) {
      window.alert("That image is larger than 12 MB. Choose a smaller image.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setValue(`narrative.sections.${index}.imageData`, String(reader.result || ""), { shouldDirty: true });
      setValue(`narrative.sections.${index}.imageName`, file.name, { shouldDirty: true });
      setValue(`narrative.sections.${index}.mediaRef`, "", { shouldDirty: true });
      api.uploadMedia(reviewId, file)
        .then(({ mediaRef }) => setValue(`narrative.sections.${index}.mediaRef`, mediaRef, { shouldDirty: true }))
        .catch((error) => window.alert(error instanceof Error ? error.message : "The screenshot could not be uploaded. Your browser recovery draft still has it."));
    };
    reader.readAsDataURL(file);
  };
  return (
    <div className="image-field" onPaste={(event) => readFile(Array.from(event.clipboardData.files).find((file) => file.type.startsWith("image/")))} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); readFile(Array.from(event.dataTransfer.files).find((file) => file.type.startsWith("image/"))); }}>
      {section.imageData ? <img src={section.imageData} alt="Screenshot preview" /> : <div className="image-placeholder">No screenshot selected</div>}
      <input className="file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => readFile(event.target.files?.[0])} />
      {(section.imageData || section.mediaRef) && <Button size="small" onClick={() => { setValue(`narrative.sections.${index}.imageData`, "", { shouldDirty: true }); setValue(`narrative.sections.${index}.mediaRef`, "", { shouldDirty: true }); }}>Remove image</Button>}
    </div>
  );
}

function StoryPicker({ index, section, stories, setValue }: { index: number; section: ReviewSection; stories: Story[]; setValue: UseFormSetValue<ReviewFormValues> }) {
  const selected = new Set((section.stories || []).map((story) => String(story.id)));
  return (
    <div className="story-picker">
      <div className="story-picker-heading"><strong>Attach ADO stories</strong></div>
      <div className="story-list">
        {stories.map((story) => <Checkbox key={String(story.id)} checked={selected.has(String(story.id))} label={`${story.type || "Item"} ${story.id}: ${story.title}`} onChange={(_, data) => {
          const next = data.checked ? [...(section.stories || []), story] : (section.stories || []).filter((item) => String(item.id) !== String(story.id));
          setValue(`narrative.sections.${index}.stories`, next, { shouldDirty: true });
        }} />)}
        {!stories.length && <Text>No stories were loaded for this sprint.</Text>}
      </div>
    </div>
  );
}

export function SectionEditor({ reviewId, index, section, control, setValue, stories, nextStories, onRemove }: {
  reviewId: string;
  index: number;
  section: ReviewSection;
  control: Control<ReviewFormValues>;
  setValue: UseFormSetValue<ReviewFormValues>;
  stories: Story[];
  nextStories: Story[];
  onRemove: () => void;
}) {
  return (
    <article id={`review-section-${section.id}`} className={`section-editor section-${section.type}`}>
      <header className="section-editor-header">
        <div><Text className="eyebrow">{labels[section.type]}</Text><strong>{descriptions[section.type]}</strong></div>
        <div className="section-actions"><Button icon={<Delete20Regular />} aria-label="Remove section" onClick={onRemove}>Remove</Button></div>
      </header>
      {isMetric(section.type) ? null : <Controller control={control} name={`narrative.sections.${index}.title`} render={({ field }) => <Field label="Title"><Input {...field} value={String(field.value || "")} placeholder={section.type === "live_demo" ? "Demo" : "Section title"} /></Field>} />}
      {section.type === "delivery" && <>
        <BodyField control={control} name={`narrative.sections.${index}.bodyText`} label="Body" placeholder="Use one line for a paragraph. Press Enter for bullets; leave a blank line between paragraphs." />
        <BodyField control={control} name={`narrative.sections.${index}.businessValue`} label="Business value" placeholder="Why this matters to users, stakeholders, or operations." />
        <Controller control={control} name={`narrative.sections.${index}.priority`} render={({ field }) => <Checkbox checked={Boolean(field.value)} label="#1 priority" onChange={(_, data) => field.onChange(Boolean(data.checked))} />} />
        <StoryPicker index={index} section={section} stories={stories} setValue={setValue} />
      </>}
      {section.type === "screenshot" && <div className="screenshot-fields"><ImagePicker reviewId={reviewId} index={index} setValue={setValue} section={section} /><div><BodyField control={control} name={`narrative.sections.${index}.bodyText`} label="Side text" placeholder="Explain what stakeholders should notice." /><BodyField control={control} name={`narrative.sections.${index}.businessValue`} label="Business value" placeholder="Why this visual matters." /></div></div>}
      {section.type === "challenge" && <><BodyField control={control} name={`narrative.sections.${index}.bodyText`} label="Challenge" placeholder="What happened and what the team learned." /><BodyField control={control} name={`narrative.sections.${index}.businessValue`} label="Response or impact" placeholder="How the team responded." /></>}
      {section.type === "next_steps" && <><BodyField control={control} name={`narrative.sections.${index}.bodyText`} label="Next steps" placeholder="What comes next." /><StoryPicker index={index} section={section} stories={nextStories} setValue={setValue} /></>}
      {section.type === "live_demo" && <>
        <Controller control={control} name={`narrative.sections.${index}.presenters`} render={({ field }) => <Field label="Presenters"><Input value={(field.value || []).join(", ")} onChange={(_, data) => field.onChange(data.value.split(",").map((value) => value.trim()).filter(Boolean))} placeholder="Names separated by commas" /></Field>} />
        <BodyField control={control} name={`narrative.sections.${index}.note`} label="Demo note" placeholder="Optional internal handoff note." />
      </>}
      {section.type === "risk" && <>
        <BodyField control={control} name={`narrative.sections.${index}.description`} label="Description" placeholder="What could happen?" />
        <div className="three-fields">
          {(["impact", "likelihood"] as const).map((fieldName) => <Controller key={fieldName} control={control} name={`narrative.sections.${index}.${fieldName}`} render={({ field }) => <Field label={fieldName[0].toUpperCase() + fieldName.slice(1)}><Dropdown value={String(field.value || "medium")} selectedOptions={[String(field.value || "medium")]} onOptionSelect={(_, data) => field.onChange(data.optionValue)}><Option value="low">Low</Option><Option value="medium">Medium</Option><Option value="high">High</Option></Dropdown></Field>} />)}
          <Controller control={control} name={`narrative.sections.${index}.roam`} render={({ field }) => <Field label="ROAM"><Dropdown value={String(field.value || "owned")} selectedOptions={[String(field.value || "owned")]} onOptionSelect={(_, data) => field.onChange(data.optionValue)}><Option value="resolved">Resolved</Option><Option value="owned">Owned</Option><Option value="accepted">Accepted</Option><Option value="mitigated">Mitigated</Option></Dropdown></Field>} />
        </div>
        <Controller control={control} name={`narrative.sections.${index}.owner`} render={({ field }) => <Field label="Owner"><Input {...field} value={String(field.value || "")} /></Field>} />
        <BodyField control={control} name={`narrative.sections.${index}.notes`} label="Notes" placeholder="Mitigation or follow-up." />
      </>}
    </article>
  );
}
