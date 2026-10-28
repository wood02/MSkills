import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  skillsApi,
  type InstalledSkill,
  type SkillDocument,
} from "@/lib/api/skills";
import MarkdownEditor from "@/components/MarkdownEditor";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { useDarkMode } from "@/hooks/useDarkMode";
import { SkillMarkdownPreview } from "./SkillMarkdownPreview";

export function SkillDocumentPanel({
  skill,
  onClose,
  startEditing = false,
}: {
  skill: InstalledSkill;
  onClose: () => void;
  startEditing?: boolean;
}) {
  const { t } = useTranslation();
  const darkMode = useDarkMode();
  const queryClient = useQueryClient();
  const [document, setDocument] = useState<SkillDocument | null>(null);
  const queryKey = ["skills", "document", skill.id];
  const {
    data: fetchedDocument,
    isFetching,
    error,
    refetch,
  } = useQuery({
    queryKey,
    queryFn: () => skillsApi.readDocument(skill.id),
    enabled: document === null,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState(startEditing);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const savingRef = useRef(false);
  const dirty = document !== null && content !== document.content;

  useEffect(() => {
    if (fetchedDocument && !error && !isFetching && document === null) {
      setDocument(fetchedDocument);
      setContent(fetchedDocument.content);
    }
  }, [fetchedDocument, error, isFetching, document]);

  const handleClose = () => {
    if (savingRef.current) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const handleSave = async () => {
    if (!document || !dirty || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await skillsApi.saveDocument(
        skill.id,
        content,
        document.revision,
      );
      setDocument(result.document);
      setContent(result.document.content);
      queryClient.setQueryData<SkillDocument>(queryKey, result.document);
      queryClient.setQueryData<InstalledSkill[]>(
        ["skills", "installed"],
        (skills) =>
          skills?.map((entry) =>
            entry.id === skill.id ? result.skill : entry,
          ),
      );
      await queryClient.invalidateQueries({ queryKey: ["skills", "backups"] });
      setEditing(false);
      if (result.syncErrors.length) {
        toast.warning(t("skills.document.syncPartial"), {
          description: result.syncErrors.join("\n"),
          closeButton: true,
        });
      } else {
        toast.success(t("skills.document.saved"), {
          description: t("skills.backup.location", { path: result.backupPath }),
          closeButton: true,
        });
      }
    } catch (error) {
      toast.error(t("skills.document.saveFailed"), {
        description: String(error),
        closeButton: true,
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <>
      <FullScreenPanel
        isOpen
        title={t("skills.document.title", { name: skill.name })}
        onClose={handleClose}
        footer={
          document && !error ? (
            <Button
              onClick={handleSave}
              disabled={!dirty || !content.trim() || saving}
            >
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          ) : undefined
        }
      >
        {!document && !error ? (
          <p role="status">{t("skills.loading")}</p>
        ) : error ? (
          <div role="alert" className="space-y-3">
            <p>{t("skills.document.loadFailed")}</p>
            <p className="break-words text-sm text-muted-foreground">
              {String(error)}
            </p>
            <Button onClick={() => void refetch()}>
              {t("skills.document.retry")}
            </Button>
          </div>
        ) : document ? (
          <div className="glass rounded-xl border border-white/10 p-6 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div
                role="group"
                aria-label={t("skills.document.mode")}
                className="flex gap-2"
              >
                <Button
                  variant={editing ? "outline" : "default"}
                  aria-pressed={!editing}
                  disabled={saving}
                  onClick={() => setEditing(false)}
                >
                  {t("skills.document.preview")}
                </Button>
                <Button
                  variant={editing ? "default" : "outline"}
                  aria-pressed={editing}
                  disabled={saving}
                  onClick={() => setEditing(true)}
                >
                  {t("skills.document.edit")}
                </Button>
              </div>
              {dirty && (
                <span className="text-sm text-muted-foreground">
                  {t("skills.document.unsaved")}
                </span>
              )}
            </div>
            <p className="break-all text-xs text-muted-foreground">
              {document.path}
            </p>
            {skill.repoOwner && (
              <p className="text-xs text-muted-foreground">
                {t("skills.document.updateWarning")}
              </p>
            )}
            {editing ? (
              <MarkdownEditor
                ariaLabel="SKILL.md"
                value={content}
                onChange={setContent}
                darkMode={darkMode}
                readOnly={saving}
                minHeight="360px"
              />
            ) : (
              <SkillMarkdownPreview content={content} />
            )}
          </div>
        ) : null}
      </FullScreenPanel>
      <ConfirmDialog
        isOpen={confirmDiscard}
        title={t("skills.document.discardTitle")}
        message={t("skills.document.discardMessage")}
        confirmText={t("skills.document.discard")}
        onConfirm={onClose}
        onCancel={() => setConfirmDiscard(false)}
      />
    </>
  );
}
