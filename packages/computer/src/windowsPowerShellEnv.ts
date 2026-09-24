export function createWindowsPowerShellChildEnv(
  env: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const childEnv = { ...(env ?? process.env) };
  // PowerShell 7 exports a module path that can break Windows PowerShell 5.1.
  // Omitting it lets the child initialize the module path for its own edition.
  for (const key of Object.keys(childEnv)) {
    if (key.toLowerCase() === "psmodulepath") delete childEnv[key];
  }
  return childEnv;
}
