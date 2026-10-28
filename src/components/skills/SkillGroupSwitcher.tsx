import { useState } from "react";
import { useIsMutating } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Check, ChevronsUpDown, Layers, Plus, Settings2 } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { AppId } from "@/lib/api/types";
import type { SkillGroup } from "@/lib/api/skillGroups";
import { useInstalledSkills } from "@/hooks/useSkills";
import {
  useApplySkillGroupMutation,
  useCreateSkillGroupMutation,
  useCurrentSkillGroupQuery,
  useSkillGroupsQuery,
} from "@/lib/query/skillGroups";
import { SkillGroupManageDialog } from "./SkillGroupManageDialog";

interface SkillGroupSwitcherProps {
  /** 技能组应用到哪个应用（Skills 页当前查看的应用） */
  app: AppId;
}

/**
 * Skills 页「技能组」切换器：一键把当前应用的 Skill 启用状态切成某个组。
 * 当前组由后端按应用记录，不根据技能集合推断。
 */
export function SkillGroupSwitcher({ app }: SkillGroupSwitcherProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isManageOpen, setIsManageOpen] = useState(false);
  const [newName, setNewName] = useState("");

  const { data: groups = [] } = useSkillGroupsQuery();
  const { data: currentId, isPending: currentPending } =
    useCurrentSkillGroupQuery(app);
  const writePending = useIsMutating({ mutationKey: ["skills", "write"] }) > 0;
  const { data: installedSkills = [] } = useInstalledSkills();
  const applyMutation = useApplySkillGroupMutation();
  const createMutation = useCreateSkillGroupMutation();

  // 已卸载的 Skill 不参与计数
  const installedIds = new Set(installedSkills.map((s) => s.id));
  const groupSkillIds = (group: SkillGroup) =>
    group.skills.filter((id) => installedIds.has(id));
  const currentGroup = groups.find((group) => group.id === currentId);
  const currentName = currentGroup?.name ?? t("skills.group.none");

  const handleApply = (group: SkillGroup) => {
    if (writePending || currentPending) return;
    setOpen(false);
    applyMutation.mutate({ id: group.id, app, name: group.name });
  };

  const closeCreateDialog = () => {
    setIsCreateOpen(false);
    setNewName("");
  };

  const handleCreate = () => {
    const name = newName.trim();
    if (!name) return;
    createMutation.mutate({ name, app }, { onSuccess: closeCreateDialog });
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            role="combobox"
            disabled={writePending || currentPending}
            aria-busy={writePending || currentPending}
            aria-expanded={open}
            aria-label={t("skills.group.ariaLabel", { name: currentName })}
            title={t("skills.group.tooltip")}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium transition-colors",
              "hover:bg-black/5 dark:hover:bg-white/5",
              currentGroup ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <Layers className="h-4 w-4 shrink-0 opacity-70" />
            <span className="max-w-[9rem] truncate">{currentName}</span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={6}
          aria-label={t("skills.group.tooltip")}
          className="z-[100] w-64 p-0"
        >
          <Command label={t("skills.group.search")}>
            <CommandInput placeholder={t("skills.group.search")} />
            <CommandList>
              <CommandEmpty>{t("skills.group.empty")}</CommandEmpty>
              {groups.length > 0 && (
                <CommandGroup>
                  {groups.map((group) => (
                    <CommandItem
                      key={group.id}
                      disabled={writePending || currentPending}
                      value={group.id}
                      keywords={[group.name]}
                      onSelect={() => handleApply(group)}
                    >
                      <Check
                        className={cn(
                          "mr-2 h-4 w-4 shrink-0",
                          currentGroup?.id === group.id
                            ? "opacity-100"
                            : "opacity-0",
                        )}
                      />
                      <span className="truncate">{group.name}</span>
                      <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">
                        {t("skills.group.count", {
                          count: groupSkillIds(group).length,
                        })}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              <div className="mx-1 my-1 h-px bg-border" />
              <CommandGroup>
                <CommandItem
                  value="__create__"
                  disabled={writePending || currentPending}
                  keywords={[t("skills.group.create")]}
                  onSelect={() => {
                    setOpen(false);
                    setIsCreateOpen(true);
                  }}
                >
                  <Plus className="mr-2 h-4 w-4 shrink-0" />
                  {t("skills.group.create")}
                </CommandItem>
                {groups.length > 0 && (
                  <CommandItem
                    value="__manage__"
                    disabled={writePending || currentPending}
                    keywords={[t("skills.group.manage")]}
                    onSelect={() => {
                      setOpen(false);
                      setIsManageOpen(true);
                    }}
                  >
                    <Settings2 className="mr-2 h-4 w-4 shrink-0" />
                    {t("skills.group.manage")}
                  </CommandItem>
                )}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <Dialog
        open={isCreateOpen}
        onOpenChange={(open) => {
          if (!open) closeCreateDialog();
        }}
      >
        <DialogContent className="max-w-sm" zIndex="alert">
          <DialogHeader className="space-y-3 border-b-0 bg-transparent pb-0">
            <DialogTitle>{t("skills.group.create")}</DialogTitle>
            <DialogDescription>
              {t("skills.group.createDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="px-6 pt-3">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t("skills.group.namePlaceholder")}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
              }}
            />
          </div>
          <DialogFooter className="flex gap-2 border-t-0 bg-transparent pt-2 sm:justify-end">
            <Button variant="outline" onClick={closeCreateDialog}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!newName.trim() || createMutation.isPending}
            >
              {t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SkillGroupManageDialog
        isOpen={isManageOpen}
        onClose={() => setIsManageOpen(false)}
      />
    </>
  );
}
