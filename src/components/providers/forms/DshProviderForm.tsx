import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import JsonEditor from "@/components/JsonEditor";
import { useDarkMode } from "@/hooks/useDarkMode";
import type { ProviderFormData } from "@/lib/schemas/provider";
import { BasicFormFields } from "./BasicFormFields";
import type { ProviderFormProps } from "./ProviderForm";

export function DshProviderForm({
  providerId,
  initialData,
  onSubmit,
  onCancel,
  submitLabel,
  showButtons = true,
  onSubmittingChange,
  onSubmitReadyChange,
}: ProviderFormProps) {
  const { t } = useTranslation();
  const dark = useDarkMode();
  const form = useForm<ProviderFormData>({
    defaultValues: {
      name: initialData?.name ?? "",
      notes: initialData?.notes ?? "",
      websiteUrl: initialData?.websiteUrl ?? "",
      icon: initialData?.icon ?? "deepseek",
      iconColor: initialData?.iconColor ?? "",
    },
  });
  const [id, setId] = useState(providerId ?? "");
  const [text, setText] = useState(
    JSON.stringify(
      initialData?.settingsConfig ?? {
        api: "openai-completions",
        baseURL: "",
        apiKeyEnv: "DSH_GATEWAY_API_KEY",
        models: [{ id: "" }],
      },
      null,
      2,
    ),
  );
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const name = form.watch("name");
  let config: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value))
      config = value;
  } catch {
    /* The editor displays syntax diagnostics. */
  }
  const ready = Boolean(
    name?.trim() && /^[a-z][a-z0-9-]*$/.test(id) && id !== "deepseek" && config,
  );
  useEffect(() => {
    onSubmitReadyChange?.(ready);
  }, [ready, onSubmitReadyChange]);
  return (
    <Form {...form}>
      <form
        id="provider-form"
        className="space-y-6 glass rounded-xl p-6 border border-white/10"
        onSubmit={form.handleSubmit(async (identity) => {
          if (!ready || busy || !config) return;
          setBusy(true);
          onSubmittingChange?.(true);
          setError("");
          try {
            await onSubmit({
              ...identity,
              name: identity.name.trim(),
              providerKey: id,
              presetCategory: initialData?.category ?? "custom",
              meta: initialData?.meta,
              settingsConfig: JSON.stringify({
                ...config,
                displayName: identity.name.trim(),
                ...(key ? { apiKey: key } : {}),
              }),
            });
          } catch (error) {
            setError(String(error));
          } finally {
            setBusy(false);
            onSubmittingChange?.(false);
          }
        })}
      >
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <fieldset disabled={busy} className="space-y-4 min-w-0">
          <BasicFormFields form={form} />
          <div className="space-y-2">
            <Label htmlFor="dsh-provider-id">{t("dsh.providerId")}</Label>
            <Input
              id="dsh-provider-id"
              value={id}
              onChange={(e) => setId(e.target.value)}
              disabled={Boolean(initialData)}
              placeholder="my-gateway"
            />
            <p className="text-xs text-muted-foreground">
              {t("dsh.providerIdHint")}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="dsh-api-key">{t("provider.apiKey")}</Label>
            <Input
              id="dsh-api-key"
              type="password"
              autoComplete="new-password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={t("dsh.keyPlaceholder")}
            />
            <p className="text-xs text-muted-foreground">{t("dsh.keyHint")}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="dsh-config">{t("provider.configJson")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("dsh.configHint")}
            </p>
            <JsonEditor
              id="dsh-config"
              ariaLabel={t("provider.configJson")}
              value={text}
              onChange={setText}
              darkMode={dark}
              language="json"
              showValidation
              height={320}
            />
          </div>
        </fieldset>
        {showButtons && (
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={busy}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy || !ready}>
              {submitLabel}
            </Button>
          </div>
        )}
      </form>
    </Form>
  );
}
