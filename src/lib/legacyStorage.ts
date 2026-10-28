/** Copy old preferences once; an existing MSkills preference always wins. */
export function migrateLegacyStorage(storage: Storage): void {
  const migrationKey = "mskills:legacy-storage-migrated";
  if (storage.getItem(migrationKey) === "1") return;
  for (const key of Object.keys(storage)) {
    const currentKey = key
      .replace(/^cc-switch(?=[-.:])/, "mskills")
      .replace(/^ccswitch(?=:)/, "mskills");
    if (currentKey !== key && storage.getItem(currentKey) === null) {
      const value = storage.getItem(key);
      if (value !== null) storage.setItem(currentKey, value);
    }
  }
  storage.setItem(migrationKey, "1");
}
