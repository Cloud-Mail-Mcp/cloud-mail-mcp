import type { JsonSchema, ModuleInfo } from "../lib/api";
import { getPath, humanize, type Obj } from "../lib/config";
import { Checkbox, Field, Input } from "./ui";

/**
 * Renders form fields from a module's JSON Schema, so new modules (Microsoft, Zoho, ...)
 * get a connection form without admin-panel changes.
 */
export function SchemaFields({
  module,
  paths,
  value,
  onChange,
  errors,
  secretPlaceholder,
}: {
  module: ModuleInfo;
  /** Top-level property names (or dotted paths) to render. */
  paths: string[];
  value: Obj;
  onChange: (path: string, v: unknown) => void;
  errors?: Record<string, string>;
  /** Shown in secret inputs when a value is already stored (edit mode). */
  secretPlaceholder?: string;
}) {
  const labels = module.ui.labels ?? {};
  const secrets = new Set(module.ui.secretFields);

  const render = (path: string, schema: JsonSchema): React.ReactNode => {
    const id = `f-${path}`;
    const label = labels[path] ?? humanize(path);
    const v = getPath(value, path);

    if (schema.type === "object" && schema.properties) {
      return (
        <fieldset
          key={path}
          className="space-y-3 rounded-md border border-zinc-200 p-4 dark:border-zinc-800"
        >
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            {humanize(path)}
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {Object.entries(schema.properties).map(([k, s]) => render(`${path}.${k}`, s))}
          </div>
        </fieldset>
      );
    }
    if (schema.type === "boolean") {
      return (
        <div key={path} className="sm:col-span-2">
          <Checkbox
            id={id}
            label={label}
            checked={Boolean(v)}
            onChange={(c) => onChange(path, c)}
          />
        </div>
      );
    }
    if (schema.type === "integer" || schema.type === "number") {
      return (
        <Field key={path} label={label} htmlFor={id} error={errors?.[path]}>
          <Input
            id={id}
            type="number"
            min={schema.minimum}
            max={schema.maximum}
            value={v === undefined || v === null ? "" : String(v)}
            invalid={!!errors?.[path]}
            onChange={(e) =>
              onChange(path, e.target.value === "" ? undefined : Number(e.target.value))
            }
          />
        </Field>
      );
    }
    const isSecret = secrets.has(path);
    return (
      <Field key={path} label={label} htmlFor={id} error={errors?.[path]}>
        <Input
          id={id}
          type={isSecret ? "password" : "text"}
          autoComplete={isSecret ? "new-password" : "off"}
          placeholder={isSecret ? secretPlaceholder : undefined}
          value={typeof v === "string" ? v : ""}
          invalid={!!errors?.[path]}
          onChange={(e) => onChange(path, e.target.value)}
        />
      </Field>
    );
  };

  return (
    <div className="space-y-4">
      {paths.map((p) => {
        const s = p
          .split(".")
          .reduce<JsonSchema | undefined>((sch, k) => sch?.properties?.[k], module.configSchema);
        return s ? render(p, s) : null;
      })}
    </div>
  );
}
