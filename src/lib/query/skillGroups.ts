import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { skillGroupsApi } from "@/lib/api";
import type { AppId } from "@/lib/api/types";
import { extractErrorMessage } from "@/utils/errorUtils";

const SKILL_GROUPS_KEY = ["skillGroups"];

export const useCurrentSkillGroupQuery = (app: AppId) =>
  useQuery({
    queryKey: [...SKILL_GROUPS_KEY, "current", app],
    queryFn: () => skillGroupsApi.getCurrent(app),
  });

export const useSkillGroupsQuery = () =>
  useQuery({
    queryKey: SKILL_GROUPS_KEY,
    queryFn: () => skillGroupsApi.list(),
  });

export const useCreateSkillGroupMutation = () => {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationKey: ["skills", "write"],
    mutationFn: ({ name, app }: { name: string; app: AppId }) =>
      skillGroupsApi.create(name, app),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SKILL_GROUPS_KEY });
      toast.success(t("skills.group.createSuccess"), { closeButton: true });
    },
    onError: (error: Error) => {
      const detail = extractErrorMessage(error) || t("common.unknown");
      toast.error(t("skills.group.createFailed", { detail }), {
        closeButton: true,
      });
    },
  });
};

export const useRenameSkillGroupMutation = () => {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationKey: ["skills", "write"],
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      skillGroupsApi.rename(id, name),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SKILL_GROUPS_KEY });
    },
    onError: (error: Error) => {
      const detail = extractErrorMessage(error) || t("common.unknown");
      toast.error(t("skills.group.updateFailed", { detail }), {
        closeButton: true,
      });
    },
  });
};

export const useDeleteSkillGroupMutation = () => {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationKey: ["skills", "write"],
    mutationFn: (id: string) => skillGroupsApi.delete(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SKILL_GROUPS_KEY });
    },
    onError: (error: Error) => {
      const detail = extractErrorMessage(error) || t("common.unknown");
      toast.error(t("skills.group.updateFailed", { detail }), {
        closeButton: true,
      });
    },
  });
};

export const useApplySkillGroupMutation = () => {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationKey: ["skills", "write"],
    mutationFn: ({ id, app }: { id: string; app: AppId; name: string }) =>
      skillGroupsApi.apply(id, app),
    onSuccess: async (warnings, { name }) => {
      if (warnings.length > 0) {
        toast.warning(
          t("profiles.applyWarnings", {
            warningCount: warnings.length,
            details: warnings.join("\n"),
          }),
          { closeButton: true, duration: 10000 },
        );
      } else {
        toast.success(t("skills.group.applySuccess", { name }), {
          closeButton: true,
        });
      }
    },
    onError: (error: Error) => {
      const detail = extractErrorMessage(error) || t("common.unknown");
      toast.error(t("skills.group.applyFailed", { detail }), {
        closeButton: true,
      });
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: SKILL_GROUPS_KEY }),
        queryClient.invalidateQueries({ queryKey: ["skills"] }),
      ]),
  });
};
