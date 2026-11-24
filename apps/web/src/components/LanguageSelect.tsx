import { EDIT_ONLY, RUNNABLE, type LanguageInfo } from "../lib/languages";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "./ui/overlay";

function Item({ l }: { l: LanguageInfo }) {
  return (
    <SelectItem value={l.id}>
      <span className="inline-flex items-center gap-2">
        <span className="size-2 rounded-[2px]" style={{ background: l.color }} aria-hidden="true" />
        {l.label}
      </span>
    </SelectItem>
  );
}

/** Every room language, grouped by what works: run + AI fix, or edit only. */
export function LanguageSelect({ value, onChange, id, testId = "language-select" }: { value: string; onChange: (v: string) => void; id?: string; testId?: string }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} data-testid={testId} aria-label="Language">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Run, edit &amp; AI fix</SelectLabel>
          {RUNNABLE.map((l) => <Item key={l.id} l={l} />)}
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Edit only</SelectLabel>
          {EDIT_ONLY.map((l) => <Item key={l.id} l={l} />)}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
