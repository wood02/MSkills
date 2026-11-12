import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye } from "lucide-react";
import { type AppId } from "@/lib/api";
import { useDarkMode } from "@/hooks/useDarkMode";
import { usePromptActions } from "@/hooks/usePromptActions";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { useViewState } from "@/hooks/useViewState";
import MarkdownEditor from "@/components/MarkdownEditor";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import PiPromptPanel, { type PromptPrimaryAction } from "./PiPromptPanel";
import PromptFormPanel from "./PromptFormPanel";
import { PromptLibrary } from "./PromptLibrary";
import { ConfirmDialog } from "../ConfirmDialog";

const PROMPT_FILENAME_MAP: Record<AppId, string> = {
  claude: "CLAUDE.md",
  "claude-desktop": "CLAUDE.md",
  codex: "AGENTS.md",
  gemini: "GEMINI.md",
  antigravity: "GEMINI.md",
  grokbuild: "AGENTS.md",
  opencode: "AGENTS.md",
  openclaw: "AGENTS.md",
  hermes: "SOUL.md",
  pi: "AGENTS.md",
  mcode: "AGENTS.md",
  dsh: "AGENTS.md",
};

const PROMPT_BYTE_LIMIT_MAP: Partial<Record<AppId, number>> = {
  antigravity: 24_000,
  mcode: 32 * 1024,
};

interface PromptPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appId: AppId;
  onInteractionBlockedChange?: (blocked: boolean) => void;
  onNavigationBlockedChange?: (blocked: boolean) => void;
  onPrimaryActionChange?: (action: PromptPrimaryAction) => void;
}

export interface PromptPanelHandle {
  openAdd: () => void;
}

export type { PromptPrimaryAction } from "./PiPromptPanel";

const StandardPromptPanel = React.forwardRef<
  PromptPanelHandle,
  PromptPanelProps
>(
  (
    {
      open,
      appId,
      onInteractionBlockedChange,
      onNavigationBlockedChange,
      onPrimaryActionChange,
    },
    ref,
  ) => {
    const { t } = useTranslation();
    const isDarkMode = useDarkMode();
    const [isFormOpen, setIsFormOpen] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [isPreviewOpen, setIsPreviewOpen] = useState(false);
    const [draftFileContent, setDraftFileContent] = useState("");
    const [savingFile, setSavingFile] = useState(false);
    const [searchQuery, setSearchQuery] = useViewState("prompts.search", "");
    const [confirmDialog, setConfirmDialog] = useState<{
      isOpen: boolean;
      titleKey: string;
      messageKey: string;
      messageParams?: Record<string, unknown>;
      onConfirm: () => void;
    } | null>(null);
    const [writePending, setWritePending] = useState(false);
    const [reloadPending, setReloadPending] = useState(false);
    const writeLockRef = React.useRef(false);
    const reloadLockRef = React.useRef(false);
    const reloadRunGenerationRef = React.useRef(0);
    const overlayOpenRef = React.useRef(false);
    const externalReloadQueuedRef = React.useRef(false);

    const {
      prompts,
      loading,
      currentFileContent,
      reload,
      savePrompt,
      deletePrompt,
      toggleEnabled,
      reorderPrompts,
      saveCurrentFileContent,
    } = usePromptActions(appId);
    const reloadRef = React.useRef(reload);
    reloadRef.current = reload;

    const dialogOpen = confirmDialog !== null || isPreviewOpen;
    const interactionBlocked =
      loading ||
      reloadPending ||
      writePending ||
      savingFile ||
      isFormOpen ||
      dialogOpen;
    const navigationBlocked =
      writePending || savingFile || isFormOpen || dialogOpen;

    useEffect(() => {
      onInteractionBlockedChange?.(interactionBlocked);
    }, [interactionBlocked, onInteractionBlockedChange]);

    useEffect(() => {
      onNavigationBlockedChange?.(navigationBlocked);
    }, [navigationBlocked, onNavigationBlockedChange]);

    useEffect(() => {
      onPrimaryActionChange?.("prompt");
    }, [onPrimaryActionChange]);

    useEffect(
      () => () => {
        onInteractionBlockedChange?.(false);
        onNavigationBlockedChange?.(false);
      },
      [onInteractionBlockedChange, onNavigationBlockedChange],
    );

    const runExternalReload = React.useCallback(async () => {
      if (writeLockRef.current || overlayOpenRef.current) {
        externalReloadQueuedRef.current = true;
        return;
      }

      const runGeneration = ++reloadRunGenerationRef.current;
      externalReloadQueuedRef.current = false;
      reloadLockRef.current = true;
      setReloadPending(true);
      try {
        await reloadRef.current();
      } finally {
        if (reloadRunGenerationRef.current === runGeneration) {
          reloadLockRef.current = false;
          setReloadPending(false);
        }
      }
    }, []);

    const beginWrite = () => {
      if (loading || reloadLockRef.current || writeLockRef.current)
        return false;
      writeLockRef.current = true;
      setWritePending(true);
      return true;
    };

    const endWrite = () => {
      writeLockRef.current = false;
      setWritePending(false);
      if (externalReloadQueuedRef.current) {
        void runExternalReload();
      }
    };

    useEffect(() => {
      if (open) void runExternalReload();
    }, [appId, open, runExternalReload]);

    useEffect(() => {
      if (!open) return;
      const handleFocus = () => void runExternalReload();
      window.addEventListener("focus", handleFocus);
      return () => window.removeEventListener("focus", handleFocus);
    }, [open, runExternalReload]);

    useEffect(() => {
      setSearchQuery("");
      overlayOpenRef.current = false;
      setIsFormOpen(false);
      setIsPreviewOpen(false);
      setDraftFileContent("");
      setEditingId(null);
      setConfirmDialog(null);
      if (externalReloadQueuedRef.current) {
        void runExternalReload();
      }
    }, [appId, runExternalReload]);

    useEffect(() => {
      const handlePromptImported = (event: Event) => {
        const customEvent = event as CustomEvent;
        if (customEvent.detail?.app === appId) {
          void runExternalReload();
        }
      };

      window.addEventListener("prompt-imported", handlePromptImported);
      return () => {
        window.removeEventListener("prompt-imported", handlePromptImported);
      };
    }, [appId, runExternalReload]);

    useTauriEvent("profile-applied", runExternalReload);

    const handleAdd = () => {
      if (reloadLockRef.current || writeLockRef.current || interactionBlocked) {
        return;
      }
      overlayOpenRef.current = true;
      setEditingId(null);
      setIsFormOpen(true);
    };

    React.useImperativeHandle(ref, () => ({
      openAdd: handleAdd,
    }));

    const handleEdit = (id: string) => {
      if (reloadLockRef.current || writeLockRef.current || interactionBlocked) {
        return;
      }
      overlayOpenRef.current = true;
      setEditingId(id);
      setIsFormOpen(true);
    };

    const handleDelete = (id: string) => {
      if (reloadLockRef.current || writeLockRef.current || interactionBlocked) {
        return;
      }
      const prompt = prompts[id];
      overlayOpenRef.current = true;
      setConfirmDialog({
        isOpen: true,
        titleKey: "prompts.confirm.deleteTitle",
        messageKey: "prompts.confirm.deleteMessage",
        messageParams: { name: prompt?.name },
        onConfirm: async () => {
          if (!beginWrite()) return;
          try {
            const refreshed = await deletePrompt(id);
            if (refreshed === false) {
              externalReloadQueuedRef.current = true;
            }
            overlayOpenRef.current = false;
            setConfirmDialog(null);
          } catch {
            // Error handled by hook
          } finally {
            endWrite();
          }
        },
      });
    };

    const handleToggle = async (id: string, enabled: boolean) => {
      if (!beginWrite()) return;
      try {
        const refreshed = await toggleEnabled(id, enabled);
        if (refreshed === false) {
          externalReloadQueuedRef.current = true;
        }
      } catch {
        // Error handled by hook
      } finally {
        endWrite();
      }
    };

    const handleReorder = async (ids: string[]) => {
      if (!reorderPrompts || !beginWrite()) return;
      try {
        const refreshed = await reorderPrompts(ids);
        if (refreshed === false) {
          externalReloadQueuedRef.current = true;
        }
      } catch {
        // Error handled by hook
      } finally {
        endWrite();
      }
    };

    const handleSave = async (
      id: string,
      prompt: Parameters<typeof savePrompt>[1],
    ) => {
      if (!beginWrite()) return false;
      try {
        const refreshed = await savePrompt(id, prompt);
        if (refreshed === false) {
          externalReloadQueuedRef.current = true;
        }
        return true;
      } catch {
        // Error handled by hook
        return false;
      } finally {
        endWrite();
      }
    };

    const handleCloseForm = () => {
      if (writeLockRef.current) return;
      overlayOpenRef.current = false;
      setIsFormOpen(false);
      setEditingId(null);
      if (externalReloadQueuedRef.current) {
        void runExternalReload();
      }
    };

    const openPreviewEditor = () => {
      if (reloadLockRef.current || writeLockRef.current || interactionBlocked) {
        return;
      }
      overlayOpenRef.current = true;
      setDraftFileContent(currentFileContent ?? "");
      setIsPreviewOpen(true);
    };

    const handlePreviewOpenChange = (nextOpen: boolean) => {
      if (!nextOpen && savingFile) return;
      overlayOpenRef.current = nextOpen;
      setIsPreviewOpen(nextOpen);
      if (!nextOpen && externalReloadQueuedRef.current) {
        void runExternalReload();
      }
    };

    const handleSaveLiveFile = async () => {
      if (
        !saveCurrentFileContent ||
        overByteLimit ||
        !hasUnsavedFileChanges ||
        !beginWrite()
      ) {
        return;
      }
      setSavingFile(true);
      try {
        const refreshed = await saveCurrentFileContent(draftFileContent);
        if (refreshed === false) {
          externalReloadQueuedRef.current = true;
        }
        overlayOpenRef.current = false;
        setIsPreviewOpen(false);
      } catch {
        // Error handled by hook
      } finally {
        setSavingFile(false);
        endWrite();
      }
    };

    const promptEntries = Object.entries(prompts);
    const enabledPrompts = promptEntries.filter(([, prompt]) => prompt.enabled);
    const statusText =
      enabledPrompts.length === 0
        ? t("prompts.noneEnabled")
        : enabledPrompts.length === 1
          ? t("prompts.enabledName", { name: enabledPrompts[0][1].name })
          : t("prompts.enabledMultiple", {
              count: enabledPrompts.length,
              names: enabledPrompts.map(([, p]) => p.name).join(" + "),
            });
    const draftByteCount = new TextEncoder().encode(draftFileContent).length;
    const byteLimit = PROMPT_BYTE_LIMIT_MAP[appId];
    const overByteLimit = Boolean(byteLimit && draftByteCount > byteLimit);
    const hasUnsavedFileChanges =
      draftFileContent !== (currentFileContent ?? "");
    const targetFilename = PROMPT_FILENAME_MAP[appId];

    return (
      <div className="flex flex-col flex-1 min-h-0 px-6">
        <PromptLibrary
          prompts={prompts}
          loading={loading}
          searchQuery={searchQuery}
          statusText={statusText}
          headerAction={
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={interactionBlocked}
              onClick={openPreviewEditor}
              className="h-7 gap-1.5 text-xs"
            >
              <Eye size={13} />
              {t("prompts.viewEditFile")}
            </Button>
          }
          disabled={interactionBlocked}
          onSearchQueryChange={setSearchQuery}
          onToggle={handleToggle}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onReorder={
            typeof reorderPrompts === "function" ? handleReorder : undefined
          }
          showOrderBadges={enabledPrompts.length > 0}
        />

        <Dialog open={isPreviewOpen} onOpenChange={handlePreviewOpenChange}>
          <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
            <DialogHeader className="px-6 pt-6 pb-3 border-b border-border-default">
              <DialogTitle>
                {t("prompts.currentFile", { filename: targetFilename })}
              </DialogTitle>
              <DialogDescription
                className={
                  overByteLimit ? "text-destructive font-medium" : undefined
                }
              >
                {byteLimit
                  ? `${draftByteCount.toLocaleString()} / ${byteLimit.toLocaleString()} bytes${overByteLimit ? ` · ${t("prompts.fileOverLimit")}` : ""}`
                  : `${draftByteCount.toLocaleString()} bytes`}
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
              <MarkdownEditor
                ariaLabel={t("prompts.currentFile", {
                  filename: targetFilename,
                })}
                value={draftFileContent}
                onChange={setDraftFileContent}
                placeholder={t("prompts.contentPlaceholder", {
                  filename: targetFilename,
                })}
                darkMode={isDarkMode}
                readOnly={savingFile}
                minHeight="320px"
                maxHeight="52vh"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handlePreviewOpenChange(false)}
                disabled={savingFile}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="button"
                onClick={handleSaveLiveFile}
                disabled={
                  !saveCurrentFileContent ||
                  !hasUnsavedFileChanges ||
                  overByteLimit ||
                  savingFile
                }
              >
                {savingFile ? t("common.saving") : t("common.save")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {isFormOpen && (
          <PromptFormPanel
            appId={appId}
            editingId={editingId || undefined}
            initialData={editingId ? prompts[editingId] : undefined}
            onSave={handleSave}
            onClose={handleCloseForm}
          />
        )}

        {confirmDialog && (
          <ConfirmDialog
            isOpen={confirmDialog.isOpen}
            title={t(confirmDialog.titleKey)}
            message={t(confirmDialog.messageKey, confirmDialog.messageParams)}
            pending={writePending}
            onConfirm={confirmDialog.onConfirm}
            onCancel={() => {
              if (!writeLockRef.current) {
                overlayOpenRef.current = false;
                setConfirmDialog(null);
                if (externalReloadQueuedRef.current) {
                  void runExternalReload();
                }
              }
            }}
          />
        )}
      </div>
    );
  },
);

StandardPromptPanel.displayName = "StandardPromptPanel";

const PromptPanel = React.forwardRef<PromptPanelHandle, PromptPanelProps>(
  (props, ref) => {
    if (props.appId === "pi") {
      return (
        <PiPromptPanel
          ref={ref}
          open={props.open}
          onInteractionBlockedChange={props.onInteractionBlockedChange}
          onNavigationBlockedChange={props.onNavigationBlockedChange}
          onPrimaryActionChange={props.onPrimaryActionChange}
        />
      );
    }

    return <StandardPromptPanel ref={ref} {...props} />;
  },
);

PromptPanel.displayName = "PromptPanel";

export default PromptPanel;
