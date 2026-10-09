/** Host roots repos live under, e.g. ["/Users/.../SourceRoot", "/Users/.../IuRoot"]. */
export const WORKSPACE_ROOTS = [
  process.env.PERSONAL_REPOS_PATH,
  process.env.WORK_REPOS_PATH,
].filter((p): p is string => !!p);
