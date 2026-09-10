import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "soc-check-extension-"));
const repository = join(temporaryDirectory, "repository");
const scriptsDirectory = join(repository, "scripts");
const policyOnlyRepository = join(temporaryDirectory, "policy-only-repository");
const checker = join(temporaryDirectory, "checker");
execFileSync("git", ["init", "-q", repository]);
mkdirSync(scriptsDirectory);
writeFileSync(join(repository, ".soc-enrolled"), "");
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

  assert.equal(module.isDocumentationMutation(event("write", { path: "context/plan.md" }), repository, repository), true);
  assert.equal(module.isDocumentationMutation(event("functions.edit", { path: "README" }), repository, repository), true);
  assert.equal(module.isDocumentationMutation(event("write", { path: "src/app.js" }), repository, repository), false);
  assert.equal(module.isDocumentationMutation(event("apply_patch", { changes: [{ path: "a.md" }, { path: "b.txt" }] }), repository, repository), true);
  assert.equal(module.isDocumentationMutation(event("apply_patch", { changes: [{ path: "a.md" }, { path: "b.ts" }] }), repository, repository), false);

  assert.equal(module.isReadOnlyBash("git status --short"), true);
  assert.equal(module.isReadOnlyBash(`git -C "${repository}" diff`), true);
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
  const commentBypass = await toolCall(event("bash", { command: `# ${violation}\npython3 -c 'open(\"src/unrelated.js\", \"w\").close()'` }, "comment"), context);
  assert.equal(commentBypass.block, true);

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
