/**
 * SoC enforcement for Pi.
 *
 * This extension is intentionally separate from pi-auto-reviewer. It runs the
 * pinned shared checker for enrolled repositories and blocks unrelated source
 * mutations until an active violation is repaired. Documentation and operational
 * tools remain available so the policy cannot deadlock its own repair workflow.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

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
const SHELL_CONTROL = /[;&|<>\n`]|\$\(/;
const GIT_WRITING_OPTION = /(?:^|\s)(?:--output(?:=|\s)|--ext-diff(?:\s|$)|--textconv(?:\s|$))/;
const READ_ONLY_BASH = /^(?:git(?:\s+-C\s+(?:"[^"]*"|'[^']*'|[^\s]+))?\s+(?:status|diff|log|show|ls-files|rev-parse)|(?:cat|head|tail|grep|ls|pwd|wc))(?:\s|$)/;
const WORKTREE_ADMIN_BASH = /^git(?:\s+-C\s+(?:"[^"]*"|'[^']*'|[^\s]+))?\s+wt\s+(?:add|audit|list|prune|remove)(?:\s+\S+)*$/;

export interface Violation {
  path?: string;
  violation?: string;
}

export interface CheckerReport {
  ok?: boolean;
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

export function parseCheckerOutput(output: string): CheckerReport | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return value && typeof value === "object" ? value as CheckerReport : null;
  } catch {
    const start = trimmed.indexOf("{");
    if (start < 0) return null;
    try {
      const value: unknown = JSON.parse(trimmed.slice(start, trimmed.lastIndexOf("}") + 1));
      return value && typeof value === "object" ? value as CheckerReport : null;
    } catch {
      return null;
    }
  }
}

function rootFor(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function isEnrolled(root: string): boolean {
  return ENROLLED_ROOTS.has(root) || existsSync(join(root, ".soc-enrolled"));
}

function checkRepository(root: string, mode: "changed" | "all"): CheckResult {
  try {
    const output = execFileSync(CHECKER_HOOK, ["--mode", mode], {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { report: parseCheckerOutput(output) ?? { ok: false, error: "checker returned invalid JSON" }, output };
  } catch (error) {
    const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const output = [failure.stdout, failure.stderr, failure.message]
      .filter(Boolean)
      .map((value) => value instanceof Buffer ? value.toString("utf8") : String(value))
      .join("\n");
    return { report: parseCheckerOutput(output) ?? { ok: false, error: output.trim() || "checker failed" }, output };
  }
}

function reportReason(result: CheckResult): string {
  if (result.report.error) return result.report.error;
  const details = (result.report.violations ?? [])
    .map((item) => `${item.path ?? "unknown file"}: ${item.violation ?? "policy violation"}`)
    .slice(0, 8);
  return details.join("; ") || "source-file policy failed";
}

function inspect(ctx: ExtensionContext, mode: "changed" | "all"): EnforcementState {
  const root = rootFor(ctx.cwd);
  if (!root || !isEnrolled(root)) {
    state = { blocked: false, reason: "", violations: [] };
    return state;
  }
  const result = checkRepository(root, mode);
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

function commandFor(event: ToolCallEvent): string {
  const input = event.input as Record<string, unknown>;
  return typeof input.command === "string" ? input.command : "";
}

function violationPaths(): string[] {
  return state.violations
    .map((item) => item.path)
    .filter((path): path is string => Boolean(path));
}

function mutationPaths(event: ToolCallEvent): string[] {
  const input = event.input as Record<string, unknown>;
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

function targetsOnlyViolations(event: ToolCallEvent): boolean {
  if (!state.root) return false;
  const paths = mutationPaths(event);
  if (paths.length === 0) return false;
  const violations = new Set(violationPaths().map((path) => resolve(state.root!, path)));
  return paths.every((path) => violations.has(resolve(state.root!, path)));
}

export function isDocumentationMutation(event: ToolCallEvent): boolean {
  const name = normalizedToolName(event);
  if (!["edit", "write", "apply_patch"].includes(name)) return false;
  const paths = mutationPaths(event);
  return paths.length > 0 && paths.every((path) => DOCUMENT_PATH.test(path));
}

export function isReadOnlyBash(command: string): boolean {
  const trimmed = command.trim();
  return Boolean(trimmed)
    && !SHELL_CONTROL.test(trimmed)
    && !GIT_WRITING_OPTION.test(trimmed)
    && READ_ONLY_BASH.test(trimmed);
}

export function isWorktreeAdminBash(command: string): boolean {
  const trimmed = command.trim();
  return !SHELL_CONTROL.test(trimmed) && WORKTREE_ADMIN_BASH.test(trimmed);
}

function isRepairCall(event: ToolCallEvent): boolean {
  return SOURCE_MUTATION_TOOLS.has(normalizedToolName(event)) && targetsOnlyViolations(event);
}

function mayMutateSource(event: ToolCallEvent): boolean {
  const name = normalizedToolName(event);
  if (SOURCE_MUTATION_TOOLS.has(name)) return !isDocumentationMutation(event);
  if (name !== "bash") return false;
  const command = commandFor(event);
  return !isReadOnlyBash(command) && !isWorktreeAdminBash(command);
}

function blockedReason(): string {
  return `SoC policy violation: ${state.reason}. Repair the listed file(s) before continuing unrelated source changes.`;
}

export function toolAllowedWhileBlocked(event: ToolCallEvent): boolean {
  const name = normalizedToolName(event);
  if (READ_TOOLS.has(name)) return true;
  if (name === "bash") {
    const command = commandFor(event);
    return isReadOnlyBash(command) || isWorktreeAdminBash(command) || isRepairCall(event);
  }
  if (SOURCE_MUTATION_TOOLS.has(name)) return isDocumentationMutation(event) || isRepairCall(event);
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
  pi.on("tool_call", (event, ctx) => {
    const current = inspect(ctx, "changed");
    if (!current.blocked) {
      if (mayMutateSource(event)) recheckToolCalls.add(event.toolCallId);
      return;
    }
    if (toolAllowedWhileBlocked(event)) {
      if (isRepairCall(event)) recheckToolCalls.add(event.toolCallId);
      return;
    }
    return blockingResponse(blockedReason());
  });

  pi.on("tool_result", (event, ctx) => {
    if (!recheckToolCalls.delete(event.toolCallId)) return;
    const current = inspect(ctx, "changed");
    if (!current.blocked) return;
    return {
      content: [
        ...event.content,
        { type: "text", text: `\n[SoC enforcement] ${blockedReason()}` },
      ],
    };
  });

  pi.on("agent_settled", (_event, ctx) => {
    inspect(ctx, "all");
  });

  pi.on("session_shutdown", () => {
    reset();
  });
}
