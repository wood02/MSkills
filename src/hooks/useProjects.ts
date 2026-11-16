import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { projectsApi } from "@/lib/api/projects";
import type {
  AddProjectInput,
  ImportProjectSkillRequest,
  ProjectDeployMode,
  ProjectDeploymentMode,
  ProjectListItem,
  ProjectRuleRelativePath,
  ProjectScanResult,
  ProjectSkillDeploymentRecord,
  ProjectSkillTarget,
  RemoveProjectOptions,
  ScannedProjectSkill,
  TargetSkillRef,
  UpdateProjectInput,
} from "@/lib/api/projects";
import type { InstalledSkill } from "@/lib/api/skills";

export const projectKeys = {
  all: ["projects"] as const,
  listAll: ["projects", "list"] as const,
  list: (includeArchived = false) =>
    ["projects", "list", { includeArchived }] as const,
  suggestions: ["projects", "suggestions"] as const,
  scan: (projectId: string) => ["projects", "scan", projectId] as const,
  rules: (projectId: string) => ["projects", "rules", projectId] as const,
  snapshots: (projectId: string, relativePath?: string) =>
    ["projects", "rule-snapshots", projectId, relativePath ?? "all"] as const,
};

function buildOptimisticEntry(params: {
  projectId: string;
  target: ProjectSkillTarget;
  directory: string;
  displayName: string;
  description?: string;
  skillId?: string | null;
  mode: ProjectDeploymentMode;
  existing?: ScannedProjectSkill;
}): ScannedProjectSkill {
  const { existing } = params;
  const isSymlink =
    params.mode === "symlink" || params.mode === "relative_alias";
  return {
    projectId: params.projectId,
    target: params.target,
    directory: params.directory,
    displayName:
      params.displayName || existing?.displayName || params.directory,
    description: params.description ?? existing?.description,
    status: "synced",
    unknownBaseline: false,
    missingOnDisk: false,
    generationMismatch: false,
    canRebindSkillId: null,
    canAutoDeleteCleanCopy: params.mode === "copy",
    mode: params.mode,
    managedLinkTarget: existing?.managedLinkTarget ?? null,
    actualLinkTarget: existing?.actualLinkTarget ?? null,
    diskPath: existing?.diskPath ?? "",
    diskExists: true,
    isSymlink,
    skillId: params.skillId ?? existing?.skillId ?? null,
    skillInstallationId: existing?.skillInstallationId ?? null,
    deployedHash: existing?.deployedHash ?? null,
    lastMaterializedHash: existing?.lastMaterializedHash ?? null,
    diskHash: existing?.diskHash ?? null,
    ssotHash: existing?.ssotHash ?? null,
    baselineSource: "deploy",
    detachedAt: null,
    structureError: null,
    diagnostics: {
      frontmatterName:
        existing?.diagnostics.frontmatterName ?? params.displayName,
      frontmatterDescription:
        existing?.diagnostics.frontmatterDescription ??
        params.description ??
        null,
      writtenToDisk: true,
      duplicateNameConflicts:
        existing?.diagnostics.duplicateNameConflicts ?? [],
      precedenceWarnings: existing?.diagnostics.precedenceWarnings ?? [],
    },
  };
}

function mergeScanEntries(
  scan: ProjectScanResult | undefined,
  upserts: ScannedProjectSkill[],
): ProjectScanResult | undefined {
  if (!scan || upserts.length === 0) return scan;
  const byKey = new Map<string, ScannedProjectSkill>();
  for (const entry of scan.entries) {
    byKey.set(`${entry.target}:${entry.directory}`, entry);
  }
  for (const next of upserts) {
    byKey.set(`${next.target}:${next.directory}`, next);
  }
  return { ...scan, entries: Array.from(byKey.values()) };
}

function mapDeployRecordsToScanEntries(
  records: ProjectSkillDeploymentRecord[],
  installedSkills: InstalledSkill[],
  existingScan?: ProjectScanResult,
): ScannedProjectSkill[] {
  const skillById = new Map(installedSkills.map((s) => [s.id, s]));
  const skillByDir = new Map(installedSkills.map((s) => [s.directory, s]));
  const existingByKey = new Map(
    (existingScan?.entries ?? []).map((e) => [`${e.target}:${e.directory}`, e]),
  );
  return records.map((rec) => {
    const skill =
      (rec.skillId ? skillById.get(rec.skillId) : undefined) ??
      skillByDir.get(rec.directory);
    return buildOptimisticEntry({
      projectId: rec.projectId,
      target: rec.target,
      directory: rec.directory,
      displayName: skill?.name ?? rec.directory,
      description: skill?.description,
      skillId: rec.skillId ?? skill?.id ?? null,
      mode: rec.mode,
      existing: existingByKey.get(`${rec.target}:${rec.directory}`),
    });
  });
}

export function useProjectsQuery(includeArchived = false) {
  return useQuery({
    queryKey: projectKeys.list(includeArchived),
    queryFn: () => projectsApi.list(includeArchived),
    staleTime: 3_000,
  });
}

export function useSuggestedProjectsQuery(enabled = true) {
  return useQuery({
    queryKey: projectKeys.suggestions,
    queryFn: () => projectsApi.suggestFromSessions(),
    enabled,
  });
}

export function useProjectScanQuery(projectId: string | null) {
  return useQuery({
    queryKey: projectId
      ? projectKeys.scan(projectId)
      : ["projects", "scan", "none"],
    queryFn: () => projectsApi.scanSkills(projectId!),
    enabled: !!projectId,
    staleTime: 3_000,
  });
}

export function useProjectRulesQuery(projectId: string | null) {
  return useQuery({
    queryKey: projectId
      ? projectKeys.rules(projectId)
      : ["projects", "rules", "none"],
    queryFn: () => projectsApi.listRules(projectId!),
    enabled: !!projectId,
  });
}

export function useProjectRuleSnapshotsQuery(
  projectId: string | null,
  relativePath?: ProjectRuleRelativePath,
) {
  return useQuery({
    queryKey: projectId
      ? projectKeys.snapshots(projectId, relativePath)
      : ["projects", "rule-snapshots", "none"],
    queryFn: () =>
      projectsApi.listRuleSnapshots({
        projectId: projectId!,
        relativePath,
      }),
    enabled: !!projectId,
  });
}

export function useAddProjectMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AddProjectInput) => projectsApi.add(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.all });
    },
  });
}

export function useUpdateProjectMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateProjectInput) => projectsApi.update(input),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: projectKeys.listAll });
      const prevLists = queryClient.getQueriesData<ProjectListItem[]>({
        queryKey: projectKeys.listAll,
      });
      queryClient.setQueriesData<ProjectListItem[]>(
        { queryKey: projectKeys.listAll },
        (items) =>
          items?.map((item) =>
            item.project.id === vars.id
              ? {
                  ...item,
                  project: {
                    ...item.project,
                    name: vars.name ?? item.project.name,
                    defaultMode: vars.defaultMode ?? item.project.defaultMode,
                    enabledTargets:
                      vars.enabledTargets ?? item.project.enabledTargets,
                    autoGitExclude:
                      vars.autoGitExclude ?? item.project.autoGitExclude,
                  },
                }
              : item,
          ),
      );
      const prevScan = queryClient.getQueryData<ProjectScanResult>(
        projectKeys.scan(vars.id),
      );
      if (prevScan) {
        queryClient.setQueryData<ProjectScanResult>(projectKeys.scan(vars.id), {
          ...prevScan,
          project: {
            ...prevScan.project,
            name: vars.name ?? prevScan.project.name,
            defaultMode: vars.defaultMode ?? prevScan.project.defaultMode,
            enabledTargets:
              vars.enabledTargets ?? prevScan.project.enabledTargets,
            autoGitExclude:
              vars.autoGitExclude ?? prevScan.project.autoGitExclude,
          },
        });
      }
      return { prevLists, prevScan };
    },
    onError: (_err, vars, ctx) => {
      ctx?.prevLists.forEach(([key, data]) => {
        queryClient.setQueryData(key, data);
      });
      if (ctx?.prevScan) {
        queryClient.setQueryData(projectKeys.scan(vars.id), ctx.prevScan);
      }
    },
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.listAll });
      void queryClient.invalidateQueries({
        queryKey: projectKeys.scan(vars.id),
      });
    },
  });
}

export function useRelocateProjectMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      newRootPath,
    }: {
      projectId: string;
      newRootPath: string;
    }) => projectsApi.relocate(projectId, newRootPath),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.all });
      void queryClient.invalidateQueries({
        queryKey: projectKeys.scan(vars.projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: projectKeys.rules(vars.projectId),
      });
    },
  });
}

export function useRemoveProjectMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      options,
    }: {
      projectId: string;
      options: RemoveProjectOptions;
    }) => projectsApi.remove(projectId, options),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.all });
    },
  });
}

export function useDeploySkillsToProjectMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      projectId: string;
      skillIds: string[];
      targets: ProjectSkillTarget[];
      modeOverride?: ProjectDeployMode;
      overwriteConflicts?: boolean;
    }) => projectsApi.deploySkills(params),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({
        queryKey: projectKeys.scan(vars.projectId),
      });
      const prevScan = queryClient.getQueryData<ProjectScanResult>(
        projectKeys.scan(vars.projectId),
      );
      const installedSkills =
        queryClient.getQueryData<InstalledSkill[]>(["skills", "installed"]) ??
        [];
      const skillMap = new Map(installedSkills.map((s) => [s.id, s]));
      const existingByKey = new Map(
        (prevScan?.entries ?? []).map((e) => [`${e.target}:${e.directory}`, e]),
      );
      const mode: ProjectDeploymentMode =
        vars.modeOverride ?? prevScan?.project.defaultMode ?? "symlink";

      const optimisticEntries: ScannedProjectSkill[] = [];
      for (const skillId of vars.skillIds) {
        const skill = skillMap.get(skillId);
        if (!skill) continue;
        for (const target of vars.targets) {
          const entryMode: ProjectDeploymentMode =
            mode === "copy" &&
            target === "claude" &&
            vars.targets.includes("agents")
              ? "relative_alias"
              : mode;
          optimisticEntries.push(
            buildOptimisticEntry({
              projectId: vars.projectId,
              target,
              directory: skill.directory,
              displayName: skill.name,
              description: skill.description,
              skillId: skill.id,
              mode: entryMode,
              existing: existingByKey.get(`${target}:${skill.directory}`),
            }),
          );
        }
      }

      if (prevScan && optimisticEntries.length > 0) {
        queryClient.setQueryData<ProjectScanResult>(
          projectKeys.scan(vars.projectId),
          mergeScanEntries(prevScan, optimisticEntries),
        );
      }

      return { prevScan };
    },
    onError: (_err, vars, ctx) => {
      if (ctx?.prevScan) {
        queryClient.setQueryData(
          projectKeys.scan(vars.projectId),
          ctx.prevScan,
        );
      }
    },
    onSuccess: (data, vars) => {
      const currentScan = queryClient.getQueryData<ProjectScanResult>(
        projectKeys.scan(vars.projectId),
      );
      const installedSkills =
        queryClient.getQueryData<InstalledSkill[]>(["skills", "installed"]) ??
        [];
      if (currentScan && data.deployed.length > 0) {
        queryClient.setQueryData<ProjectScanResult>(
          projectKeys.scan(vars.projectId),
          mergeScanEntries(
            currentScan,
            mapDeployRecordsToScanEntries(
              data.deployed,
              installedSkills,
              currentScan,
            ),
          ),
        );
      }
      void queryClient.invalidateQueries({
        queryKey: projectKeys.scan(vars.projectId),
      });
      void queryClient.invalidateQueries({ queryKey: projectKeys.listAll });
    },
  });
}

export function useDeploySkillGroupToProjectMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      projectId: string;
      groupId: string;
      targets: ProjectSkillTarget[];
      modeOverride?: ProjectDeployMode;
      overwriteConflicts?: boolean;
    }) => projectsApi.deploySkillGroup(params),
    onSuccess: (data, vars) => {
      const currentScan = queryClient.getQueryData<ProjectScanResult>(
        projectKeys.scan(vars.projectId),
      );
      const installedSkills =
        queryClient.getQueryData<InstalledSkill[]>(["skills", "installed"]) ??
        [];
      if (currentScan && data.deployed.length > 0) {
        queryClient.setQueryData<ProjectScanResult>(
          projectKeys.scan(vars.projectId),
          mergeScanEntries(
            currentScan,
            mapDeployRecordsToScanEntries(
              data.deployed,
              installedSkills,
              currentScan,
            ),
          ),
        );
      }
      void queryClient.invalidateQueries({
        queryKey: projectKeys.scan(vars.projectId),
      });
      void queryClient.invalidateQueries({ queryKey: projectKeys.listAll });
    },
  });
}

export function useUpdateProjectDeploymentsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      projectId: string;
      items: TargetSkillRef[];
      allowOverwriteModified?: boolean;
    }) => projectsApi.updateDeployments(params),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: projectKeys.scan(vars.projectId),
      });
      void queryClient.invalidateQueries({ queryKey: projectKeys.listAll });
    },
  });
}

export function usePromoteClaudeDeploymentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      projectId: string;
      directory: string;
      overwriteAgents?: boolean;
    }) => projectsApi.promoteClaudeDeployment(params),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: projectKeys.scan(vars.projectId),
      });
      void queryClient.invalidateQueries({ queryKey: projectKeys.listAll });
    },
  });
}

export function useUndeployProjectSkillMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      projectId: string;
      target: ProjectSkillTarget;
      directory: string;
      action: "delete_link" | "delete_copy" | "detach_only";
    }) => projectsApi.undeploySkill(params),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({
        queryKey: projectKeys.scan(vars.projectId),
      });
      const prevScan = queryClient.getQueryData<ProjectScanResult>(
        projectKeys.scan(vars.projectId),
      );
      if (prevScan && vars.action !== "detach_only") {
        queryClient.setQueryData<ProjectScanResult>(
          projectKeys.scan(vars.projectId),
          {
            ...prevScan,
            entries: prevScan.entries.filter(
              (entry) =>
                !(
                  entry.target === vars.target &&
                  entry.directory === vars.directory
                ),
            ),
          },
        );
      }
      return { prevScan };
    },
    onError: (_err, vars, ctx) => {
      if (ctx?.prevScan) {
        queryClient.setQueryData(
          projectKeys.scan(vars.projectId),
          ctx.prevScan,
        );
      }
    },
    onSettled: (_data, _err, vars) => {
      void queryClient.invalidateQueries({
        queryKey: projectKeys.scan(vars.projectId),
      });
      void queryClient.invalidateQueries({ queryKey: projectKeys.listAll });
    },
  });
}

export function useBatchUndeployProjectSkillsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      projectId: string;
      items: Array<{
        target: ProjectSkillTarget;
        directory: string;
        action: "delete_link" | "delete_copy";
      }>;
    }) => {
      for (const item of params.items) {
        await projectsApi.undeploySkill({
          projectId: params.projectId,
          target: item.target,
          directory: item.directory,
          action: item.action,
        });
      }
      return { removedCount: params.items.length };
    },
    onMutate: async (vars) => {
      await queryClient.cancelQueries({
        queryKey: projectKeys.scan(vars.projectId),
      });
      const prevScan = queryClient.getQueryData<ProjectScanResult>(
        projectKeys.scan(vars.projectId),
      );
      if (prevScan && vars.items.length > 0) {
        const removeKeys = new Set(
          vars.items.map((item) => `${item.target}:${item.directory}`),
        );
        queryClient.setQueryData<ProjectScanResult>(
          projectKeys.scan(vars.projectId),
          {
            ...prevScan,
            entries: prevScan.entries.filter(
              (entry) => !removeKeys.has(`${entry.target}:${entry.directory}`),
            ),
          },
        );
      }
      return { prevScan };
    },
    onError: (_err, vars, ctx) => {
      if (ctx?.prevScan) {
        queryClient.setQueryData(
          projectKeys.scan(vars.projectId),
          ctx.prevScan,
        );
      }
    },
    onSettled: (_data, _err, vars) => {
      void queryClient.invalidateQueries({
        queryKey: projectKeys.scan(vars.projectId),
      });
      void queryClient.invalidateQueries({ queryKey: projectKeys.listAll });
    },
  });
}

export function useAdoptProjectSkillMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      projectId: string;
      target: ProjectSkillTarget;
      directory: string;
      skillId?: string;
    }) => projectsApi.adoptSkill(params),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: projectKeys.scan(vars.projectId),
      });
      void queryClient.invalidateQueries({ queryKey: projectKeys.listAll });
    },
  });
}

export function useRebindProjectDeploymentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      projectId: string;
      target: ProjectSkillTarget;
      directory: string;
      skillId: string;
    }) => projectsApi.rebindDeployment(params),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: projectKeys.scan(vars.projectId),
      });
      void queryClient.invalidateQueries({ queryKey: projectKeys.listAll });
    },
  });
}

export function useSettleMissingProjectLinkMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      projectId: string;
      target: ProjectSkillTarget;
      directory: string;
    }) => projectsApi.settleMissingLink(params),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: projectKeys.scan(vars.projectId),
      });
      void queryClient.invalidateQueries({ queryKey: projectKeys.listAll });
    },
  });
}

export function usePushSkillToGlobalMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      projectId: string;
      target: ProjectSkillTarget;
      directory: string;
      overwriteExisting?: boolean;
    }) => projectsApi.pushToGlobal(params),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: projectKeys.scan(vars.projectId),
      });
      void queryClient.invalidateQueries({ queryKey: projectKeys.listAll });
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
}

export function useImportProjectSkillsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      projectId: string;
      items: ImportProjectSkillRequest[];
    }) => projectsApi.importToGlobal(params),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: projectKeys.scan(vars.projectId),
      });
      void queryClient.invalidateQueries({ queryKey: projectKeys.listAll });
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
}

export function useSaveProjectRuleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      projectId: string;
      relativePath: ProjectRuleRelativePath;
      content: string;
      expectedRevision?: string | null;
    }) => projectsApi.saveRuleFile(params),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: projectKeys.rules(vars.projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: ["projects", "rule-snapshots", vars.projectId],
      });
    },
  });
}

export function useApplyPromptToRuleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      projectId: string;
      relativePath: ProjectRuleRelativePath;
      promptId: string;
      applyMode: "managed_block" | "append" | "overwrite";
      expectedRevision?: string | null;
    }) => projectsApi.applyPromptToRule(params),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: projectKeys.rules(vars.projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: ["projects", "rule-snapshots", vars.projectId],
      });
    },
  });
}

export function useInsertAgentsReferenceMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      projectId: string;
      expectedRevision?: string | null;
    }) => projectsApi.insertAgentsReference(params),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: projectKeys.rules(vars.projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: ["projects", "rule-snapshots", vars.projectId],
      });
    },
  });
}

export function useRestoreRuleSnapshotMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      projectId: string;
      snapshotId: string;
      expectedCurrentRevision?: string | null;
      confirmDelete?: boolean;
    }) => projectsApi.restoreRuleSnapshot(params),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: projectKeys.rules(vars.projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: ["projects", "rule-snapshots", vars.projectId],
      });
    },
  });
}
