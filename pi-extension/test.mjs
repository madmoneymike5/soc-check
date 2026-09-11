import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "soc-check-extension-"));
const repository = join(temporaryDirectory, "repository");
const scriptsDirectory = join(repository, "scripts");
const contextDirectory = join(repository, "context");
const externalDirectory = join(temporaryDirectory, "external");
const policyOnlyRepository = join(temporaryDirectory, "policy-only-repository");
const checker = join(temporaryDirectory, "checker");
execFileSync("git", ["init", "-q", repository]);
mkdirSync(scriptsDirectory);
mkdirSync(contextDirectory);
mkdirSync(externalDirectory);
writeFileSync(join(repository, ".soc-enrolled"), "");
writeFileSync(join(scriptsDirectory, "source.js"), "source\n");
writeFileSync(join(externalDirectory, "outside.md"), "outside\n");
symlinkSync(join(scriptsDirectory, "source.js"), join(contextDirectory, "source.md"));
symlinkSync(join(externalDirectory, "outside.md"), join(contextDirectory, "escape.md"));
symlinkSync(externalDirectory, join(repository, "linked-docs"));
mkdirSync(policyOnlyRepository);
writeFileSync(join(policyOnlyRepository, "soc-policy.toml"), "limit = 300\n");
writeFileSync(checker, `#!/bin/sh
printf '%s\\n' '{"ok":false,"violations":[{"path":"scripts/research-library.js","violation":"335 effective lines exceeds limit 300"}]}'
exit 1
`);
chmodSync(checker, 0o700);
process.env.SOC_CHECK_HOOK = checker;

try {
  const piAgentRoot = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const jitiUrl = pathToFileURL(join(piAgentRoot, "npm", "node_modules", "jiti", "lib", "jiti.mjs"));
  const { createJiti } = await import(jitiUrl.href);
  const jiti = createJiti(import.meta.url);
  const module = await jiti.import(fileURLToPath(new URL("./index.ts", import.meta.url)));
  const event = (toolName, input, toolCallId = "call") => ({ toolName, input, toolCallId });
  const violation = "scripts/research-library.js";
  const absoluteViolation = join(repository, violation);

  assert.equal(module.isEnrolled(policyOnlyRepository), false);
  assert.equal(module.isEnrolled(repository), true);
  assert.equal(module.parseCheckerOutput("{}"), null);
  assert.equal(module.parseCheckerOutput('{"ok":true,"error":"checker failed"}'), null);
  assert.equal(module.parseCheckerOutput('{"ok":true,"violations":[{"path":"src/app.js"}]}'), null);

  assert.equal(module.isDocumentationMutation(event("write", { path: "context/plan.md" }), repository, repository), true);
  assert.equal(module.isDocumentationMutation(event("functions.edit", { path: "README" }), repository, repository), true);
  assert.equal(module.isDocumentationMutation(event("write", { path: "src/app.js" }), repository, repository), false);
  assert.equal(module.isDocumentationMutation(event("apply_patch", { changes: [{ path: "a.md" }, { path: "b.txt" }] }), repository, repository), true);
  assert.equal(module.isDocumentationMutation(event("apply_patch", { changes: [{ path: "a.md" }, { path: "b.ts" }] }), repository, repository), false);

  assert.equal(module.isReadOnlyBash("git status --short"), false);
  assert.equal(module.isReadOnlyBash(`git -C "${repository}" diff`), false);
  assert.equal(module.isReadOnlyBash("git log -p"), false);
  assert.equal(module.isReadOnlyBash("git show HEAD"), false);
  assert.equal(module.isReadOnlyBash("git ls-files"), true);
  assert.equal(module.isReadOnlyBash("git rev-parse --show-toplevel"), true);
  assert.equal(module.isReadOnlyBash("git status $GIT_STATUS_ARGS"), false);
  assert.equal(module.isReadOnlyBash("git status > src/app.js"), false);
  assert.equal(module.isReadOnlyBash("git diff --output=src/app.js"), false);
  assert.equal(module.isReadOnlyBash("cat input > src/app.js"), false);
  assert.equal(module.isReadOnlyBash("find . -delete"), false);
  assert.equal(module.isReadOnlyBash("python3 checker.py soc_check"), false);

  assert.equal(module.isWorktreeAdminBash("git wt add workspace fix/soc"), true);
  assert.equal(module.isWorktreeAdminBash(`git -C "${repository}" wt remove workspace`), true);
  assert.equal(module.isWorktreeAdminBash("git wt audit; touch src/app.js"), false);
  assert.equal(module.isWorktreeAdminBash("git wt audit | tee src/app.js"), false);
  assert.equal(module.isWorktreeAdminBash("git wt audit > src/app.js"), false);
  assert.equal(module.isWorktreeAdminBash("git wt audit $(touch src/app.js)"), false);
  assert.equal(module.isWorktreeAdminBash("git wt audit `touch src/app.js`"), false);

  const handlers = new Map();
  await module.default({ on(name, handler) { handlers.set(name, handler); } });
  const context = { cwd: repository };
  const subdirectoryContext = { cwd: scriptsDirectory };
  const toolCall = handlers.get("tool_call");
  const toolResult = handlers.get("tool_result");

  assert.equal(await toolCall(event("write", { path: join(repository, "context/plan.md") }, "doc"), context), undefined);
  assert.equal(await toolResult({ toolCallId: "doc", toolName: "write", input: {}, content: [{ type: "text", text: "saved" }] }, context), undefined);
  const outsideDoc = await toolCall(event("write", { path: join(temporaryDirectory, "outside.md") }, "outside-doc"), context);
  assert.equal(outsideDoc?.block, true);
  const symlinkedDoc = await toolCall(event("write", { path: "context/escape.md" }, "symlinked-doc"), context);
  assert.equal(symlinkedDoc?.block, true);
  const sourceAlias = await toolCall(event("write", { path: "context/source.md" }, "source-alias"), context);
  assert.equal(sourceAlias?.block, true);
  const symlinkedParent = await toolCall(event("write", { path: "linked-docs/new.md" }, "symlinked-parent"), context);
  assert.equal(symlinkedParent?.block, true);
  const nullWrite = await toolCall(event("write", null, "null-write"), context);
  assert.equal(nullWrite?.block, true);
  const nullBash = await toolCall(event("bash", null, "null-bash"), context);
  assert.equal(nullBash?.block, true);
  assert.equal(await toolCall(event("todo", { action: "list" }, "todo"), context), undefined);
  assert.equal(await toolResult({ toolCallId: "todo", toolName: "todo", input: {}, content: [{ type: "text", text: "listed" }] }, context), undefined);
  assert.equal(await toolCall(event("bash", { command: "git wt audit" }, "wt"), context), undefined);
  assert.equal(await toolResult({ toolCallId: "wt", toolName: "bash", input: {}, content: [{ type: "text", text: "ok" }] }, context), undefined);

  assert.equal(await toolCall(event("edit", { path: absoluteViolation, oldText: "x", newText: "y" }, "repair"), context), undefined);
  assert.equal(await toolCall(event("edit", { path: "research-library.js", oldText: "x", newText: "y" }, "subdir-repair"), subdirectoryContext), undefined);
  const falselyRootRelative = await toolCall(event("edit", { path: violation, oldText: "x", newText: "y" }, "wrong-subdir-path"), subdirectoryContext);
  assert.equal(falselyRootRelative?.block, true);
  const repairResult = await toolResult({ toolCallId: "repair", toolName: "edit", input: {}, content: [{ type: "text", text: "edited" }] }, context);
  assert.match(repairResult.content.at(-1).text, /SoC enforcement/);
  assert.equal(module.toolAllowedWhileBlocked(event("ast_grep_replace", { paths: [violation] })), true);
  assert.equal(module.toolAllowedWhileBlocked(event("ast_grep_replace", { paths: [violation, "src/unrelated.ts"] })), false);

  const mentionOnly = await toolCall(event("write", { path: "src/unrelated.js", content: `see ${violation}` }, "mention"), context);
  assert.equal(mentionOnly.block, true);
  assert.equal("terminate" in mentionOnly, false);
  const mixedPatch = await toolCall(event("apply_patch", { changes: [{ path: violation }, { path: "src/unrelated.js" }] }, "mixed"), context);
  assert.equal(mixedPatch.block, true);
  const prefixedPath = await toolCall(event("edit", { path: `${violation}.bak`, oldText: "x", newText: "y" }, "prefix"), context);
  assert.equal(prefixedPath.block, true);
  const commentBypass = await toolCall(event("bash", { command: `# ${violation}\npython3 -c 'open("src/unrelated.js", "w").close()'` }, "comment"), context);
  assert.equal(commentBypass.block, true);

  writeFileSync(checker, `#!/bin/sh
printf '%s\\n' '{"ok":true}'
exit 1
`);
  const falseSuccess = await toolCall(event("write", { path: "src/unrelated.js" }, "false-success"), context);
  assert.equal(falseSuccess?.block, true);
  assert.match(falseSuccess.reason, /^SoC enforcement error:/);

  writeFileSync(checker, `#!/bin/sh
printf '%s\\n' '{"ok":false,"error":"checker unavailable"}'
exit 1
`);
  const checkerFailure = await toolCall(event("write", { path: "src/unrelated.js" }, "checker-failure"), context);
  assert.match(checkerFailure.reason, /^SoC enforcement error:/);
  assert.deepEqual(module.blockingResponse("blocked"), { block: true, reason: "blocked" });

  console.log("soc-check Pi extension regression checks: passed");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
