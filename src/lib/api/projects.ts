import { invoke } from "@tauri-apps/api/core";
import type { InstalledSkill, SkillUninstallResult } from "./skills";

export type ProjectDeployMode = "copy" | "symlink";
export type ProjectSkillTarget = "agents" | "claude";
export type ProjectDeploymentMode = "copy" | "symlink" | "relative_alias";

export type ProjectSkillStatus =
  | "synced"
  | "outdated"
  | "modified"
  | "conflict"
  | "broken"
  | "invalid_structure"
  | "source_missing"
  | "unmanaged"
  | "same_content_unmanaged";

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  rootIdentity?: string | null;
  defaultMode: ProjectDeployMode;
  enabledTargets: ProjectSkillTarget[];
  autoGitExclude: boolean;
  archivedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectListItem {
  project: ProjectRecord;
  rootExists: boolean;
  identityMatched: boolean;
  isGitRepo: boolean;
  isWorktree: boolean;
  deployedCount: number;
  syncedCount: number;
  outdatedCount: number;
  modifiedCount: number;
  conflictCount: number;
  unmanagedCount: number;
  brokenCount: number;
}

export interface SuggestedProject {
  rootPath: string;
  name: string;
  sessionCount: number;
  lastActiveAt?: number | null;
  providers: string[];
  hasExistingSkills: boolean;
}

export interface AddProjectInput {
  rootPath: string;
  name?: string;
  defaultMode?: ProjectDeployMode;
  enabledTargets?: ProjectSkillTarget[];
  autoGitExclude?: boolean;
  reactivateIfArchived?: boolean;
}

export interface UpdateProjectInput {
  id: string;
  name?: string;
  defaultMode?: ProjectDeployMode;
  enabledTargets?: ProjectSkillTarget[];
  autoGitExclude?: boolean;
  archived?: boolean;
}

export interface RemoveProjectOptions {
  cleanupLinks?: boolean;
  deleteUnmodifiedCopies?: boolean;
}

export interface RemoveProjectPreview {
  projectId: string;
  managedLinksCount: number;
  cleanCopiesCount: number;
  modifiedOrAdoptedCopiesCount: number;
  ruleSnapshotsCount: number;
  hasGitExcludeEntries: boolean;
}

export interface RemoveProjectResult {
  removedProjectId: string;
  removedLinksCount: number;
  deletedCleanCopiesCount: number;
  preservedCopiesCount: number;
}

export interface ProjectSkillDeploymentRecord {
  id: string;
  projectId: string;
  skillId?: string | null;
  skillInstallationId?: string | null;
  target: ProjectSkillTarget;
  directory: string;
  mode: ProjectDeploymentMode;
  deployedHash?: string | null;
  lastMaterializedHash?: string | null;
  baselineSource?: string | null;
  gitExcludeRef?: string | null;
  detachedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface FsIdentityUnix {
  kind: "unix";
  dev: string;
  ino: string;
}

export interface FsIdentityWindows {
  kind: "windows";
  volume_serial: string;
  file_index: string;
}

export type FsIdentity = FsIdentityUnix | FsIdentityWindows;

export interface ClientDiagnostics {
  frontmatterName?: string | null;
  frontmatterDescription?: string | null;
  writtenToDisk: boolean;
  duplicateNameConflicts: string[];
  precedenceWarnings: string[];
}

export interface ScannedProjectSkill {
  projectId: string;
  target: ProjectSkillTarget;
  directory: string;
  displayName: string;
  description?: string | null;
  status: ProjectSkillStatus;
  unknownBaseline: boolean;
  missingOnDisk: boolean;
  generationMismatch: boolean;
  canRebindSkillId?: string | null;
  canAutoDeleteCleanCopy: boolean;
  mode?: ProjectDeploymentMode | null;
  managedLinkTarget?: string | null;
  actualLinkTarget?: string | null;
  diskPath: string;
  diskExists: boolean;
  isSymlink: boolean;
  skillId?: string | null;
  skillInstallationId?: string | null;
  deployedHash?: string | null;
  lastMaterializedHash?: string | null;
  diskHash?: string | null;
  ssotHash?: string | null;
  baselineSource?: string | null;
  detachedAt?: number | null;
  structureError?: string | null;
  diagnostics: ClientDiagnostics;
}

export interface ProjectScanResult {
  project: ProjectRecord;
  rootExists: boolean;
  identityMatched: boolean;
  currentFsIdentity?: FsIdentity | null;
  entries: ScannedProjectSkill[];
}

export interface TargetSkillRef {
  target: ProjectSkillTarget;
  directory: string;
}

export interface DeployToProjectResult {
  deployed: ProjectSkillDeploymentRecord[];
  skipped: string[];
  warnings: string[];
}

export interface DeployGroupToProjectResult {
  deployed: ProjectSkillDeploymentRecord[];
  skipped: string[];
  warnings: string[];
  missingFromLibrary: string[];
}

export interface ImportProjectSkillRequest {
  target: ProjectSkillTarget;
  directory: string;
  overwriteExisting: boolean;
}

export interface PushOrImportResult {
  skill: InstalledSkill;
  deployment: ProjectSkillDeploymentRecord;
}

export interface SkillFileDiff {
  relativePath: string;
  changeType: "added" | "removed" | "modified" | "unchanged";
  isBinary: boolean;
  projectContent?: string | null;
  globalContent?: string | null;
}

export interface ProjectSkillDiffResult {
  target: ProjectSkillTarget;
  directory: string;
  projectPath: string;
  globalPath?: string | null;
  files: SkillFileDiff[];
}

export type ProjectRuleRelativePath =
  | "CLAUDE.md"
  | ".claude/CLAUDE.md"
  | "CLAUDE.local.md"
  | "AGENTS.md";

export interface ProjectRuleFile {
  projectId: string;
  relativePath: ProjectRuleRelativePath;
  exists: boolean;
  content: string;
  revisionHash?: string | null;
  sizeBytes: number;
  hasAgentsReference: boolean;
  isSymlinkBlocked: boolean;
}

export interface ProjectRuleSnapshotRecord {
  id: string;
  projectId: string;
  relativePath: string;
  fileExisted: boolean;
  content: string;
  contentHash?: string | null;
  promptId?: string | null;
  action: string;
  createdAt: number;
}

export interface InsertAgentsReferenceResult {
  alreadyPresent: boolean;
  file: ProjectRuleFile;
}

export interface RestoreRuleSnapshotResult {
  deletedFile: boolean;
  file: ProjectRuleFile;
}

export const projectsApi = {
  async pickDirectory(defaultPath?: string): Promise<string | null> {
    return await invoke("pick_project_directory", { defaultPath });
  },

  async list(includeArchived = false): Promise<ProjectListItem[]> {
    return await invoke("list_projects", { includeArchived });
  },

  async suggestFromSessions(): Promise<SuggestedProject[]> {
    return await invoke("suggest_projects_from_sessions");
  },

  async add(input: AddProjectInput): Promise<ProjectRecord> {
    return await invoke("add_project", { input });
  },

  async update(input: UpdateProjectInput): Promise<ProjectRecord> {
    return await invoke("update_project", { input });
  },

  async relocate(
    projectId: string,
    newRootPath: string,
  ): Promise<ProjectRecord> {
    return await invoke("relocate_project", {
      projectId,
      newRootPath,
    });
  },

  async previewRemove(projectId: string): Promise<RemoveProjectPreview> {
    return await invoke("preview_remove_project", { projectId });
  },

  async remove(
    projectId: string,
    options: RemoveProjectOptions,
  ): Promise<RemoveProjectResult> {
    return await invoke("remove_project", { projectId, options });
  },

  async scanSkills(projectId: string): Promise<ProjectScanResult> {
    return await invoke("scan_project_skills", { projectId });
  },

  async deploySkills(params: {
    projectId: string;
    skillIds: string[];
    targets: ProjectSkillTarget[];
    modeOverride?: ProjectDeployMode;
    overwriteConflicts?: boolean;
  }): Promise<DeployToProjectResult> {
    return await invoke("deploy_skills_to_project", params);
  },

  async deploySkillGroup(params: {
    projectId: string;
    groupId: string;
    targets: ProjectSkillTarget[];
    modeOverride?: ProjectDeployMode;
    overwriteConflicts?: boolean;
  }): Promise<DeployGroupToProjectResult> {
    return await invoke("deploy_skill_group_to_project", params);
  },

  async updateDeployments(params: {
    projectId: string;
    items: TargetSkillRef[];
    allowOverwriteModified?: boolean;
  }): Promise<ProjectSkillDeploymentRecord[]> {
    return await invoke("update_project_deployments", params);
  },

  async promoteClaudeDeployment(params: {
    projectId: string;
    directory: string;
    overwriteAgents?: boolean;
  }): Promise<[ProjectSkillDeploymentRecord, ProjectSkillDeploymentRecord]> {
    return await invoke("promote_claude_deployment", params);
  },

  async undeploySkill(params: {
    projectId: string;
    target: ProjectSkillTarget;
    directory: string;
    action: "delete_link" | "delete_copy" | "detach_only";
  }): Promise<void> {
    return await invoke("undeploy_project_skill", params);
  },

  async adoptSkill(params: {
    projectId: string;
    target: ProjectSkillTarget;
    directory: string;
    skillId?: string;
  }): Promise<ProjectSkillDeploymentRecord> {
    return await invoke("adopt_project_skill", params);
  },

  async rebindDeployment(params: {
    projectId: string;
    target: ProjectSkillTarget;
    directory: string;
    skillId: string;
  }): Promise<ProjectSkillDeploymentRecord> {
    return await invoke("rebind_project_deployment", params);
  },

  async settleMissingLink(params: {
    projectId: string;
    target: ProjectSkillTarget;
    directory: string;
  }): Promise<void> {
    return await invoke("settle_missing_project_link", params);
  },

  async pushToGlobal(params: {
    projectId: string;
    target: ProjectSkillTarget;
    directory: string;
    overwriteExisting?: boolean;
  }): Promise<PushOrImportResult> {
    return await invoke("push_skill_to_global", params);
  },

  async importToGlobal(params: {
    projectId: string;
    items: ImportProjectSkillRequest[];
  }): Promise<PushOrImportResult[]> {
    return await invoke("import_project_skills", params);
  },

  async diffSkill(params: {
    projectId: string;
    target: ProjectSkillTarget;
    directory: string;
  }): Promise<ProjectSkillDiffResult> {
    return await invoke("diff_project_skill", params);
  },

  async listRules(projectId: string): Promise<ProjectRuleFile[]> {
    return await invoke("list_project_rules", { projectId });
  },

  async saveRuleFile(params: {
    projectId: string;
    relativePath: ProjectRuleRelativePath;
    content: string;
    expectedRevision?: string | null;
  }): Promise<ProjectRuleFile> {
    return await invoke("save_project_rule_file", params);
  },

  async applyPromptToRule(params: {
    projectId: string;
    relativePath: ProjectRuleRelativePath;
    promptId: string;
    applyMode: "managed_block" | "append" | "overwrite";
    expectedRevision?: string | null;
  }): Promise<ProjectRuleFile> {
    return await invoke("apply_prompt_to_project_rule", params);
  },

  async insertAgentsReference(params: {
    projectId: string;
    expectedRevision?: string | null;
  }): Promise<InsertAgentsReferenceResult> {
    return await invoke("insert_agents_reference_in_claude_md", params);
  },

  async listRuleSnapshots(params: {
    projectId: string;
    relativePath?: ProjectRuleRelativePath;
  }): Promise<ProjectRuleSnapshotRecord[]> {
    return await invoke("list_rule_snapshots", params);
  },

  async restoreRuleSnapshot(params: {
    projectId: string;
    snapshotId: string;
    expectedCurrentRevision?: string | null;
    confirmDelete?: boolean;
  }): Promise<RestoreRuleSnapshotResult> {
    return await invoke("restore_rule_snapshot", params);
  },
};

export type { SkillUninstallResult };
