/**
 * SoC enforcement for Pi.
 *
 * This extension is intentionally separate from pi-auto-reviewer. It runs the
 * pinned shared checker for enrolled repositories and blocks unrelated source
 * mutations until an active violation is repaired. Documentation and operational
 * tools remain available so the policy cannot deadlock its own repair workflow.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { canonicalPathWithin } from "./path-safety.js";

const execFileAsync = promisify(execFile);
const DEFAULT_HOOK = "/home/sarah-taylor/Dev/soc-check/bin/soc-check-hook";
const CHECKER_HOOK = process.env.SOC_CHECK_HOOK ?? DEFAULT_HOOK;
const ENROLLED_ROOTS = new Set([
  "/home/sarah-taylor/Dev/Agents/Codie/local-agent-orchestrator",
  "/home/sarah-taylor/Dev/Chronicle",
  "/home/sarah-taylor/Dev/agent-messenger",
  "/home/sarah-taylor/Dev/mail-agent-gateway",
  "/home/sarah-taylor/Dev/tailnet-hub",
  "/home/sarah-taylor/Dev/Whisper-Agent-Web",
  "/home/sarah-taylor/Dev/Zoom Meeting Scheduler",
  "/home/sarah-taylor/Dev/Atlas v2",
  "/home/sarah-taylor/Dev/Atlas v3",
  "/home/sarah-taylor/Dev/Multi-AI-Session-Management-System",
  "/home/sarah-taylor/Dev/flex-planner",
  "/home/sarah-taylor/Dev/Tools/printing-press/library/reddit-pp-cli",
  "/home/sarah-taylor/Dev/Tools/cli-printing-press-pr",
]);
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const SOURCE_MUTATION_TOOLS = new Set(["edit", "write", "apply_patch", "ast_grep_replace"]);
const DOCUMENT_PATH = /(?:\.(?:md|mdx|rst|adoc|txt)|(?:^|\/)(?:README|CHANGELOG|LICENSE|AGENTS))$/i;
const SHELL_CONTROL = /[;&|<>\n`$]/;
const READ_ONLY_BASH = /^(?:git(?:\s+-C\s+(?:"[^"]*"|'[^']*'|[^\s]+))?\s+(?:ls-files|rev-parse)|(?:cat|head|tail|grep|ls|pwd|wc))(?:\s|$)/;
const WORKTREE_ADMIN_BASH = /^git(?:\s+-C\s+(?:"[^"]*"|'[^']*'|[^\s]+))?\s+wt\s+(?:add|audit|list|prune|remove)(?:\s+\S+)*$/;

export interface Violation {
  path?: string;
  violation?: string;
}

export interface CheckerReport {
  ok: boolean;
  error?: string;
  violations?: Violation[];
}

interface CheckResult {
  report: CheckerReport;
  output: string;
}

interface EnforcementState {
  root?: string;
  blocked: boolean;
  reason: string;
  violations: Violation[];
}

let state: EnforcementState = {
  blocked: false,
  reason: "",
  violations: [],
};

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isViolation(value: unknown): value is Violation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return isOptionalString(item.path) && isOptionalString(item.violation);
}

function isViolationList(value: unknown): value is Violation[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every(isViolation));
}

function asCheckerReport(value: unknown): CheckerReport | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const report = value as Record<string, unknown>;
  const { error, violations } = report;
  if (typeof report.ok !== "boolean") return null;
  if (!isOptionalString(error) || !isViolationList(violations)) return null;
  if (report.ok && (error !== undefined || (violations?.length ?? 0) > 0)) return null;
  const valid: CheckerReport = { ok: report.ok };
  if (error !== undefined) valid.error = error;
  if (violations !== undefined) valid.violations = violations;
  return valid;
}

export function parseCheckerOutput(output: string): CheckerReport | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  try {
    return asCheckerReport(JSON.parse(trimmed));
  } catch {
    const start = trimmed.indexOf("{");
    if (start < 0) return null;
    try {
      return asCheckerReport(JSON.parse(trimmed.slice(start, trimmed.lastIndexOf("}") + 1)));
    } catch {
      return null;
    }
  }
}

async function rootFor(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function isEnrolled(root: string): boolean {
  return ENROLLED_ROOTS.has(root) || existsSync(join(root, ".soc-enrolled"));
}

async function checkRepository(root: string, mode: "changed" | "all"): Promise<CheckResult> {
  try {
    const { stdout } = await execFileAsync(CHECKER_HOOK, ["--mode", mode], {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
    });
    return { report: parseCheckerOutput(stdout) ?? { ok: false, error: "checker returned invalid JSON" }, output: stdout };
  } catch (error) {
    const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const output = [failure.stdout, failure.stderr, failure.message]
      .filter(Boolean)
      .map((value) => value instanceof Buffer ? value.toString("utf8") : String(value))
      .join("\n");
    const report = parseCheckerOutput(output);
    if (report?.ok === true) {
      return { report: { ok: false, error: "checker exited unsuccessfully despite reporting success" }, output };
    }
    return { report: report ?? { ok: false, error: output.trim() || "checker failed" }, output };
  }
}

function reportReason(result: CheckResult): string {
  if (result.report.error) return result.report.error;
  const details = (result.report.violations ?? [])
    .map((item) => `${item.path ?? "unknown file"}: ${item.violation ?? "policy violation"}`)
    .slice(0, 8);
  return details.join("; ") || "source-file policy failed";
}

async function inspect(ctx: ExtensionContext, mode: "changed" | "all"): Promise<EnforcementState> {
  const root = await rootFor(ctx.cwd);
  if (!root || !isEnrolled(root)) {
    state = { blocked: false, reason: "", violations: [] };
    return state;
  }
  const result = await checkRepository(root, mode);
  const violations = result.report.violations ?? [];
  state = {
    root,
    blocked: result.report.ok !== true,
    reason: result.report.ok === true ? "" : reportReason(result),
    violations,
  };
  return state;
}

function normalizedToolName(event: ToolCallEvent): string {
  return event.toolName.split(/[./]/).pop() ?? event.toolName;
}

function inputFor(event: ToolCallEvent): Record<string, unknown> | undefined {
  const input: unknown = event.input;
  return input !== null && typeof input === "object" ? input as Record<string, unknown> : undefined;
}

function commandFor(event: ToolCallEvent): string {
  const input = inputFor(event);
  return typeof input?.command === "string" ? input.command : "";
}

function violationPaths(): string[] {
  return state.violations
    .map((item) => item.path)
    .filter((path): path is string => Boolean(path));
}

function mutationPaths(event: ToolCallEvent): string[] {
  const input = inputFor(event);
  if (!input) return [];
  const paths: string[] = [];
  if (typeof input.path === "string") paths.push(input.path);
  if (Array.isArray(input.paths)) {
    paths.push(...input.paths.filter((path): path is string => typeof path === "string"));
  }
  if (Array.isArray(input.changes)) {
    for (const change of input.changes) {
      if (!change || typeof change !== "object") continue;
      const value = change as Record<string, unknown>;
      if (typeof value.path === "string") paths.push(value.path);
      if (typeof value.movePath === "string") paths.push(value.movePath);
    }
  }
  return paths;
}

function normalizedPath(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

function resolvedMutationPath(cwd: string, path: string): string {
  return resolve(cwd, normalizedPath(path));
}

function targetsOnlyViolations(event: ToolCallEvent, cwd = state.root): boolean {
  const root = state.root;
  if (!root || !cwd) return false;
  const paths = mutationPaths(event);
  if (paths.length === 0) return false;
  const violations = new Set(violationPaths().map((path) => resolve(root, path)));
  return paths.every((path) => violations.has(resolvedMutationPath(cwd, path)));
}

export function isDocumentationMutation(event: ToolCallEvent, cwd: string, root: string): boolean {
  const name = normalizedToolName(event);
  if (!["edit", "write", "apply_patch"].includes(name)) return false;
  const paths = mutationPaths(event);
  return paths.length > 0 && paths.every((path) => {
    const target = canonicalPathWithin(root, resolvedMutationPath(cwd, path));
    return DOCUMENT_PATH.test(normalizedPath(path)) && Boolean(target && DOCUMENT_PATH.test(target));
  });
}

export function isReadOnlyBash(command: string): boolean {
  const trimmed = command.trim();
  return Boolean(trimmed)
    && !SHELL_CONTROL.test(trimmed)
    && READ_ONLY_BASH.test(trimmed);
}

export function isWorktreeAdminBash(command: string): boolean {
  const trimmed = command.trim();
  return !SHELL_CONTROL.test(trimmed) && WORKTREE_ADMIN_BASH.test(trimmed);
}

function isRepairCall(event: ToolCallEvent, cwd = state.root): boolean {
  return SOURCE_MUTATION_TOOLS.has(normalizedToolName(event)) && targetsOnlyViolations(event, cwd);
}

function mayMutateSource(event: ToolCallEvent, cwd: string): boolean {
  const name = normalizedToolName(event);
  if (SOURCE_MUTATION_TOOLS.has(name)) {
    const root = state.root;
    return !root || !isDocumentationMutation(event, cwd, root);
  }
  if (name !== "bash") return false;
  const command = commandFor(event);
  return !isReadOnlyBash(command) && !isWorktreeAdminBash(command);
}

function blockedReason(): string {
  if (state.violations.length === 0) {
    return `SoC enforcement error: ${state.reason}. Restore checker and policy health before continuing source changes.`;
  }
  return `SoC policy violation: ${state.reason}. Repair the listed file(s) before continuing unrelated source changes.`;
}

export function toolAllowedWhileBlocked(event: ToolCallEvent, cwd = state.root): boolean {
  const name = normalizedToolName(event);
  if (READ_TOOLS.has(name)) return true;
  if (name === "bash") {
    const command = commandFor(event);
    return isReadOnlyBash(command) || isWorktreeAdminBash(command) || isRepairCall(event, cwd);
  }
  if (SOURCE_MUTATION_TOOLS.has(name)) {
    const root = state.root;
    return Boolean(root && cwd && isDocumentationMutation(event, cwd, root)) || isRepairCall(event, cwd);
  }
  return true;
}

export function blockingResponse(reason: string): { block: true; reason: string } {
  return { block: true, reason };
}

const recheckToolCalls = new Set<string>();

function reset(): void {
  state = { blocked: false, reason: "", violations: [] };
  recheckToolCalls.clear();
}

export default async function (pi: ExtensionAPI): Promise<void> {
  pi.on("tool_call", async (event, ctx) => {
    const current = await inspect(ctx, "changed");
    if (!current.blocked) {
      if (mayMutateSource(event, ctx.cwd)) recheckToolCalls.add(event.toolCallId);
      return;
    }
    if (toolAllowedWhileBlocked(event, ctx.cwd)) {
      if (isRepairCall(event, ctx.cwd)) recheckToolCalls.add(event.toolCallId);
      return;
    }
    return blockingResponse(blockedReason());
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!recheckToolCalls.delete(event.toolCallId)) return;
    const current = await inspect(ctx, "changed");
    if (!current.blocked) return;
    return {
      content: [
        ...event.content,
        { type: "text", text: `\n[SoC enforcement] ${blockedReason()}` },
      ],
    };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await inspect(ctx, "all");
  });

  pi.on("session_shutdown", () => {
    reset();
  });
}
