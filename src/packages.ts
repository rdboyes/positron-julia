/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from "crypto";
import * as fs from "fs";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import * as positron from "positron";

import { LOGGER } from "./extension";

const QUERY_TIMEOUT_MS = 2 * 60 * 1000;
const MUTATION_TIMEOUT_MS = 30 * 60 * 1000;

interface JuliaPackageSession {
  execute(
    code: string,
    id: string,
    mode: positron.RuntimeCodeExecutionMode,
    errorBehavior: positron.RuntimeErrorBehavior,
  ): void;
  interrupt(): Promise<void>;
  onDidReceiveRuntimeMessageRaw: vscode.Event<positron.LanguageRuntimeMessage>;
  suppressRuntimeMessages(executionId: string): vscode.Disposable;
}

export class JuliaPackageManager
  implements positron.LanguageRuntimePackageManager
{
  private readonly _session: JuliaPackageSession;
  private readonly _scriptPath: string;
  private _scriptSourced = false;
  private _scriptSourcing: Promise<void> | undefined;

  // Tracks in-flight Interactive (mutation) commands; Silent commands are
  // already excluded via the suppressed-message stream.
  private _mutationCount = 0;

  private readonly _juliaPackagesDescriptionCache = new Map<
    string,
    Promise<string | undefined>
  >();

  private readonly _onDidChangePackages = new vscode.EventEmitter<void>();
  readonly onDidChangePackages: vscode.Event<void> =
    this._onDidChangePackages.event;

  private _notifyThrottleHandle: NodeJS.Timeout | undefined;
  private _notifyPending = false;
  private static readonly _NOTIFY_THROTTLE_MS = 10_000;

  constructor(session: JuliaPackageSession, extensionPath: string) {
    this._session = session;
    this._scriptPath = path.join(
      extensionPath,
      "scripts",
      "packages",
      "packages.jl",
    );
  }

  // Called when the runtime is restarting or starting (before Ready). Clears
  // _scriptSourced so that any startup Idle messages from the new kernel
  // don't cause getPackages() to skip re-sourcing the script and call
  // _positron_list_packages() before the include has run.
  notifyRuntimeRestarting(): void {
    this._scriptSourced = false;
  }

  async onRuntimeReady(): Promise<void> {
    this._scriptSourced = false;
    await this.sourcePackagesScript();
  }

  // Called from JuliaSession when an unsuppressed Idle message arrives
  // (i.e. user-executed code finished, not one of our Silent package calls).
  // Throttled to fire at most once per _NOTIFY_THROTTLE_MS, with a trailing
  // fire if any idles arrived during the cooldown.
  notifyRuntimeIdle(): void {
    if (this._mutationCount === 0 && this._scriptSourced) {
      if (this._notifyThrottleHandle) {
        this._notifyPending = true;
        return;
      }
      this._firePackagesChanged();
      this._notifyThrottleHandle = setTimeout(() => {
        this._notifyThrottleHandle = undefined;
        if (this._notifyPending) {
          this._notifyPending = false;
          this._firePackagesChanged();
        }
      }, JuliaPackageManager._NOTIFY_THROTTLE_MS);
    }
  }

  private _firePackagesChanged(): void {
    this._onDidChangePackages.fire();

    // Trigger the packages pane refresh directly via command. This is
    // needed because Positron's packages pane only auto-refreshes on
    // RuntimeState.Ready (startup), not after ordinary console executions.
    vscode.commands
      .executeCommand("positronPackages.refreshPackages")
      .then(undefined, () => {
        /* command unavailable in this Positron version, ignore */
      });
  }

  async sourcePackagesScript(): Promise<void> {
    if (this._scriptSourced) {
      return;
    }
    if (this._scriptSourcing) {
      return this._scriptSourcing;
    }

    this._scriptSourcing = (async () => {
      const escapedScriptPath = this._escapeJuliaStringLiteral(
        this._scriptPath,
      );
      await this._executeAndCapture(
        `include("${escapedScriptPath}")`,
        positron.RuntimeCodeExecutionMode.Silent,
        QUERY_TIMEOUT_MS,
      );
      this._scriptSourced = true;
      LOGGER.debug(`Sourced Julia package helper script: ${this._scriptPath}`);
    })()
      .catch((error) => {
        this._scriptSourced = false;
        throw error;
      })
      .finally(() => {
        this._scriptSourcing = undefined;
      });

    return this._scriptSourcing;
  }

  async getPackages(
    token?: vscode.CancellationToken,
  ): Promise<positron.LanguageRuntimePackage[]> {
    await this.sourcePackagesScript();

    const raw = await this._executeAndCapture(
      "_positron_list_packages()",
      positron.RuntimeCodeExecutionMode.Silent,
      QUERY_TIMEOUT_MS,
      token,
    );

    const packages = this._parsePackages(raw);

    // Important: the packages pane uses this method, not only getPackageMetadata().
    // Therefore, fetch and replace descriptions here too.
    await this._replaceDescriptionsFromJuliaPackages(packages);

    return packages;
  }

  async installPackages(
    packages: positron.PackageSpec[],
    token?: vscode.CancellationToken,
  ): Promise<void> {
    await this.sourcePackagesScript();
    const specs = packages
      .filter((pkg) => pkg?.name && pkg.name.trim().length > 0)
      .map((pkg) =>
        pkg.version && pkg.version.trim().length > 0
          ? `${pkg.name.trim()}@${pkg.version.trim()}`
          : pkg.name.trim(),
      );

    if (specs.length === 0) {
      return;
    }

    const code = `_positron_install_packages(${this._toJuliaStringVector(specs)})`;
    await this._executeAndWait(code, MUTATION_TIMEOUT_MS, token);
  }

  async uninstallPackages(
    packageNames: string[],
    token?: vscode.CancellationToken,
  ): Promise<void> {
    await this.sourcePackagesScript();

    const names = packageNames
      .map((name) => name.trim())
      .filter((name) => name.length > 0);

    if (names.length === 0) {
      return;
    }

    await this._executeAndWait(
      `_positron_uninstall_packages(${this._toJuliaStringVector(names)})`,
      MUTATION_TIMEOUT_MS,
      token,
    );
  }

  async updatePackages(
    packages: positron.PackageSpec[],
    token?: vscode.CancellationToken,
  ): Promise<void> {
    await this.sourcePackagesScript();

    const names = packages
      .filter((pkg) => pkg?.name && pkg.name.trim().length > 0)
      .map((pkg) => pkg.name.trim());

    if (names.length === 0) {
      return;
    }

    await this._executeAndWait(
      `_positron_update_packages(${this._toJuliaStringVector(names)})`,
      MUTATION_TIMEOUT_MS,
      token,
    );
  }

  async updateAllPackages(token?: vscode.CancellationToken): Promise<void> {
    await this.sourcePackagesScript();
    await this._executeAndWait(
      "_positron_update_all_packages()",
      MUTATION_TIMEOUT_MS,
      token,
    );
  }

  async searchPackages(
    query: string,
    token?: vscode.CancellationToken,
  ): Promise<positron.LanguageRuntimePackage[]> {
    await this.sourcePackagesScript();

    const escaped = this._escapeJuliaStringLiteral(query);

    const raw = await this._executeAndCapture(
      `_positron_search_packages("${escaped}")`,
      positron.RuntimeCodeExecutionMode.Silent,
      QUERY_TIMEOUT_MS,
      token,
    );

    const packages = this._parsePackages(raw);

    // Also improve descriptions for package search results.
    await this._replaceDescriptionsFromJuliaPackages(packages);

    return packages;
  }

  async searchPackageVersions(
    name: string,
    token?: vscode.CancellationToken,
  ): Promise<string[]> {
    await this.sourcePackagesScript();

    const escaped = this._escapeJuliaStringLiteral(name);

    const raw = await this._executeAndCapture(
      `_positron_search_package_versions("${escaped}")`,
      positron.RuntimeCodeExecutionMode.Silent,
      QUERY_TIMEOUT_MS,
      token,
    );

    return this._parseStringArray(raw);
  }

  async getPackageMetadata(
    packageNames: string[],
    token?: vscode.CancellationToken,
  ): Promise<Map<string, Partial<positron.LanguageRuntimePackage>>> {
    const cleaned = packageNames
      .map((name) => name.trim())
      .filter((name) => name.length > 0);

    if (cleaned.length === 0) {
      return new Map();
    }

    await this.sourcePackagesScript();

    const raw = await this._executeAndCapture(
      `_positron_package_metadata(${this._toJuliaStringVector(cleaned)})`,
      positron.RuntimeCodeExecutionMode.Silent,
      QUERY_TIMEOUT_MS,
      token,
    );

    const metadataMap = this._parseMetadata(raw);

    // Always try JuliaPackages descriptions.
    // Do not only fetch when description is empty, because the raw package
    // description may be a README fragment like "DataFrames.jl".
    await Promise.allSettled(
      cleaned.map(async (name) => {
        const lowerName = normalizeJuliaPackageName(name);
        const entry = metadataMap.get(lowerName) || {};

        const desc = await this._getJuliaPackagesDescriptionCached(name);
        if (desc) {
          entry.description = desc;
          metadataMap.set(lowerName, entry);
        }
      }),
    );

    return metadataMap;
  }

  private _getJuliaPackagesDescriptionCached(
    packageName: string,
  ): Promise<string | undefined> {
    const key = normalizeJuliaPackageName(packageName);
    if (!key) {
      return Promise.resolve(undefined);
    }

    let cached = this._juliaPackagesDescriptionCache.get(key);
    if (!cached) {
      cached = fetchDescriptionFromJuliaPackages(key).catch(() => undefined);
      this._juliaPackagesDescriptionCache.set(key, cached);
    }

    return cached;
  }

  private async _replaceDescriptionsFromJuliaPackages(
    packages: positron.LanguageRuntimePackage[],
  ): Promise<void> {
    await Promise.allSettled(
      packages.map(async (pkg) => {
        const description = await this._getJuliaPackagesDescriptionCached(
          pkg.name,
        );
        if (description) {
          pkg.description = description;
        }
      }),
    );
  }

  private _parsePackages(raw: string): positron.LanguageRuntimePackage[] {
    const parsed = this._parseJsonValue(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const record = item as Record<string, unknown>;
        const name = typeof record.name === "string" ? record.name : "";
        const version =
          typeof record.version === "string" ? record.version : "";

        return {
          id: typeof record.id === "string" ? record.id : `${name}-${version}`,
          name,
          displayName:
            typeof record.displayName === "string" ? record.displayName : name,
          version,
          attached:
            typeof record.attached === "boolean" ? record.attached : undefined,
          description:
            typeof record.description === "string" &&
            record.description.length > 0
              ? record.description
              : undefined,
        };
      })
      .filter((pkg) => pkg.name.length > 0);
  }

  private _parseStringArray(raw: string): string[] {
    const parsed = this._parseJsonValue(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((item): item is string => typeof item === "string");
  }

  private _parseMetadata(
    raw: string,
  ): Map<string, Partial<positron.LanguageRuntimePackage>> {
    const result = new Map<string, Partial<positron.LanguageRuntimePackage>>();
    const parsed = this._parseJsonValue(raw);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return result;
    }

    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (!value || typeof value !== "object") {
        continue;
      }

      const record = value as Record<string, unknown>;
      const partial: Partial<positron.LanguageRuntimePackage> = {};

      if (
        typeof record.latestVersion === "string" &&
        record.latestVersion.length > 0
      ) {
        partial.latestVersion = record.latestVersion;
      }
      if (typeof record.license === "string" && record.license.length > 0) {
        partial.license = record.license;
      }
      if (
        typeof record.publishedDate === "string" &&
        record.publishedDate.length > 0
      ) {
        partial.publishedDate = record.publishedDate;
      }
      if (
        typeof record.description === "string" &&
        record.description.length > 0
      ) {
        partial.description = record.description;
      }

      result.set(normalizeJuliaPackageName(key), partial);
    }

    return result;
  }

  private _parseJsonValue(raw: string): unknown {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return [];
    }

    try {
      return JSON.parse(trimmed);
    } catch {
      // In rare cases, extra stream output can surround the JSON payload.
      const candidate = this._extractLikelyJson(trimmed);
      if (candidate) {
        return JSON.parse(candidate);
      }

      throw new Error(
        `Failed to parse JSON payload from Julia package command: ${trimmed.slice(0, 500)}`,
      );
    }
  }

  private _extractLikelyJson(value: string): string | undefined {
    const arrayStart = value.indexOf("[");
    const arrayEnd = value.lastIndexOf("]");

    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      return value.slice(arrayStart, arrayEnd + 1);
    }

    const objectStart = value.indexOf("{");
    const objectEnd = value.lastIndexOf("}");

    if (objectStart >= 0 && objectEnd > objectStart) {
      return value.slice(objectStart, objectEnd + 1);
    }

    return undefined;
  }

  private _toJuliaStringVector(values: string[]): string {
    return `[${values.map((value) => `"${this._escapeJuliaStringLiteral(value)}"`).join(", ")}]`;
  }

  private _escapeJuliaStringLiteral(value: string): string {
    return value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\$/g, "\\$")
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n");
  }

  private async _executeAndCapture(
    code: string,
    mode: positron.RuntimeCodeExecutionMode = positron.RuntimeCodeExecutionMode
      .Silent,
    timeoutMs: number = QUERY_TIMEOUT_MS,
    token?: vscode.CancellationToken,
  ): Promise<string> {
    // Capture stdout via a temp file rather than the kernel's stream messages.
    // Positron's runtime supervisor surfaces stream output to the console even
    // for Silent executions, which leaked the raw packages JSON to the user.
    // Redirecting stdout into a file inside Julia means the kernel emits no
    // stream messages for these queries at all.
    const tempFile = path.join(
      os.tmpdir(),
      `positron-julia-${crypto.randomUUID()}.txt`,
    );
    const tempFileErr = path.join(
      os.tmpdir(),
      `positron-julia-err-${crypto.randomUUID()}.txt`,
    );
    const escapedPath = this._escapeJuliaStringLiteral(tempFile);
    const escapedPathErr = this._escapeJuliaStringLiteral(tempFileErr);

    const wrappedCode =
      `let __positron_io = open("${escapedPath}", "w"), __positron_err = open("${escapedPathErr}", "w")\n` +
      `try\n` +
      `redirect_stdout(__positron_io) do\n` +
      `redirect_stderr(__positron_err) do\n` +
      `${code}\n` +
      `end\n` +
      `end\n` +
      `finally\n` +
      `close(__positron_io)\n` +
      `flush(__positron_err)\n` +
      `end\n` +
      `end`;

    try {
      await this._execute(wrappedCode, mode, timeoutMs, token);

      const [stdout, stderr] = await Promise.all([
        fs.promises.readFile(tempFile, "utf-8"),
        fs.promises.readFile(tempFileErr, "utf-8").catch(() => ""),
      ]);

      if (stderr.trim()) {
        LOGGER.debug(`Julia package command stderr:\n${stderr.trim()}`);
      }

      return stdout;
    } finally {
      fs.promises.unlink(tempFile).catch(() => {
        /* ignore cleanup errors */
      });
      fs.promises.unlink(tempFileErr).catch(() => {
        /* ignore cleanup errors */
      });
    }
  }

  private async _executeAndWait(
    code: string,
    timeoutMs: number = MUTATION_TIMEOUT_MS,
    token?: vscode.CancellationToken,
  ): Promise<void> {
    // Increment so notifyRuntimeIdle() doesn't fire the change event for
    // the Idle that ends this mutation — the packages instance already
    // refreshes explicitly after each install/uninstall/update.
    this._mutationCount++;

    try {
      await this._execute(
        code,
        positron.RuntimeCodeExecutionMode.Interactive,
        timeoutMs,
        token,
      );
    } finally {
      this._mutationCount--;
    }
  }

  private _execute(
    code: string,
    mode: positron.RuntimeCodeExecutionMode,
    timeoutMs: number,
    token?: vscode.CancellationToken,
  ): Promise<{ stdout: string; stderr: string }> {
    const executionId = crypto.randomUUID();
    let stdout = "";
    let stderr = "";

    return new Promise((resolve, reject) => {
      let settled = false;
      let listenersDisposed = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let listenerForceCleanupHandle: NodeJS.Timeout | undefined;
      let messageDisposable: vscode.Disposable | undefined;
      let suppressDisposable: vscode.Disposable | undefined;
      let cancelDisposable: vscode.Disposable | undefined;

      // Kernel listeners and suppression are torn down only when the
      // kernel reports Idle (or after a hard timeout safety net). This
      // matters because Silent queries that are cancelled mid-flight are
      // not interrupted on the kernel side — keeping the suppression
      // listener alive ensures any output the kernel still produces is
      // silently discarded.
      const disposeListeners = () => {
        if (listenersDisposed) {
          return;
        }

        listenersDisposed = true;

        if (listenerForceCleanupHandle) {
          clearTimeout(listenerForceCleanupHandle);
          listenerForceCleanupHandle = undefined;
        }

        suppressDisposable?.dispose();
        messageDisposable?.dispose();
      };

      const settle = (action: () => void) => {
        if (settled) {
          return;
        }

        settled = true;

        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }

        cancelDisposable?.dispose();
        cancelDisposable = undefined;

        action();
      };

      if (token?.isCancellationRequested) {
        reject(new vscode.CancellationError());
        return;
      }

      // Safety net used after cancellation and timeout: if the kernel
      // never reports Idle, we still need to tear down the suppression
      // listener so it doesn't survive indefinitely.
      const scheduleForceListenerCleanup = () => {
        if (listenersDisposed || listenerForceCleanupHandle) {
          return;
        }

        listenerForceCleanupHandle = setTimeout(disposeListeners, 30_000);
      };

      cancelDisposable = token?.onCancellationRequested(() => {
        // For Silent (background) queries, do NOT interrupt the kernel.
        // Interrupt is kernel-wide in Jupyter and raises an
        // InterruptException whose error message Positron's supervisor
        // surfaces to the console regardless of our session-level
        // message suppression. Just abandon the awaited result; the
        // listener stays alive until the kernel finishes the query on
        // its own and reports Idle.
        if (mode !== positron.RuntimeCodeExecutionMode.Silent) {
          this._session.interrupt().catch(() => {
            /* best-effort */
          });
        }

        settle(() => reject(new vscode.CancellationError()));

        // settle() has cleared the timeout, so without scheduling
        // another forced cleanup the suppression listener could leak
        // if the kernel never returns to Idle (e.g. a hung registry).
        scheduleForceListenerCleanup();
      });

      timeoutHandle = setTimeout(() => {
        settle(() =>
          reject(
            new Error(
              `Timed out waiting for Julia package command to finish (${timeoutMs}ms)`,
            ),
          ),
        );
        scheduleForceListenerCleanup();
      }, timeoutMs);

      if (mode === positron.RuntimeCodeExecutionMode.Silent) {
        suppressDisposable = this._session.suppressRuntimeMessages(executionId);
      }

      messageDisposable = this._session.onDidReceiveRuntimeMessageRaw(
        (message) => {
          if (message.parent_id !== executionId) {
            return;
          }

          switch (message.type) {
            case positron.LanguageRuntimeMessageType.Stream: {
              const streamMessage = message as positron.LanguageRuntimeStream;

              if (
                streamMessage.name === positron.LanguageRuntimeStreamName.Stdout
              ) {
                stdout += streamMessage.text;
              } else {
                stderr += streamMessage.text;
              }

              break;
            }

            case positron.LanguageRuntimeMessageType.Error: {
              const errorMessage = message as positron.LanguageRuntimeError;
              const traceback = errorMessage.traceback?.join("\n") ?? "";

              settle(() =>
                reject(
                  new Error(
                    `Julia package command failed: ${errorMessage.name}: ${errorMessage.message}` +
                      (traceback ? `\n${traceback}` : ""),
                  ),
                ),
              );

              break;
            }

            case positron.LanguageRuntimeMessageType.State: {
              const stateMessage = message as positron.LanguageRuntimeState;

              if (stateMessage.state === positron.RuntimeOnlineState.Idle) {
                settle(() => resolve({ stdout, stderr }));
                disposeListeners();
              }

              break;
            }

            default:
              break;
          }
        },
      );

      try {
        this._session.execute(
          code,
          executionId,
          mode,
          positron.RuntimeErrorBehavior.Continue,
        );
      } catch (error) {
        settle(() =>
          reject(error instanceof Error ? error : new Error(String(error))),
        );
        disposeListeners();
      }
    });
  }
}

function fetchDescriptionFromJuliaPackages(
  packageName: string,
): Promise<string | undefined> {
  const slug = normalizeJuliaPackageName(packageName);

  if (!slug) {
    return Promise.resolve(undefined);
  }

  const url = `https://juliapackages.com/p/${encodeURIComponent(slug)}`;

  return fetchJuliaPackagesHtml(url)
    .then((html) =>
      html ? extractJuliaPackagesDescription(html, slug) : undefined,
    )
    .catch(() => undefined);
}

function normalizeJuliaPackageName(packageName: string): string {
  let name = packageName.trim();

  if (name.toLowerCase().endsWith(".jl")) {
    name = name.slice(0, -3);
  }

  return name.toLowerCase();
}

function fetchJuliaPackagesHtml(
  url: string,
  redirectCount = 0,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;

    const done = (value: string | undefined) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(value);
    };

    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "Positron-Julia",
          Accept: "text/html,application/xhtml+xml",
        },
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;

        if (
          statusCode >= 300 &&
          statusCode < 400 &&
          res.headers.location &&
          redirectCount < 5
        ) {
          res.resume();

          const location = Array.isArray(res.headers.location)
            ? res.headers.location[0]
            : res.headers.location;

          const redirectedUrl = new URL(location, url).toString();

          fetchJuliaPackagesHtml(redirectedUrl, redirectCount + 1)
            .then(done)
            .catch(() => done(undefined));

          return;
        }

        if (statusCode !== 200) {
          res.resume();
          done(undefined);
          return;
        }

        res.setEncoding("utf8");

        let data = "";

        res.on("data", (chunk: string) => {
          data += chunk;
        });

        res.on("end", () => {
          done(data);
        });

        res.on("error", () => {
          done(undefined);
        });
      },
    );

    request.on("error", () => {
      done(undefined);
    });

    request.setTimeout(5000, () => {
      done(undefined);
      request.destroy();
    });
  });
}

function extractJuliaPackagesDescription(
  html: string,
  slug: string,
): string | undefined {
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const sourceHtml = bodyMatch ? bodyMatch[1] : html;

  const lines = htmlToTextLines(sourceHtml);

  const expectedTitles = new Set([
    slug.toLowerCase(),
    `${slug}.jl`.toLowerCase(),
  ]);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().toLowerCase();

    if (!expectedTitles.has(line)) {
      continue;
    }

    for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
      const candidate = cleanText(lines[j]);

      if (isUsefulPackageDescription(candidate)) {
        return candidate;
      }
    }
  }

  // Fallback: some pages may expose useful metadata instead.
  const metaDescription =
    getMetaContent(html, "name", "description") ||
    getMetaContent(html, "property", "og:description");

  if (metaDescription && isUsefulPackageDescription(metaDescription)) {
    return metaDescription;
  }

  return undefined;
}

function htmlToTextLines(html: string): string[] {
  const text = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/(?:h1|h2|h3|h4|h5|h6|p|div|section|article|li|dt|dd|header|main)>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, " ");

  return decodeHtmlEntities(text)
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
}

function isUsefulPackageDescription(value: string): boolean {
  const text = value.trim();
  const lower = text.toLowerCase();

  if (text.length === 0 || text.length > 240) {
    return false;
  }

  if (
    lower === "search" ||
    lower === "learn more" ||
    lower === "visit github" ||
    lower === "file issue" ||
    lower === "email request" ||
    lower === "sponsor project" ||
    lower === "popularity" ||
    lower === "updated last" ||
    lower === "started in" ||
    lower.startsWith("author ") ||
    lower.startsWith("sub category ") ||
    lower.startsWith("category ") ||
    /^\d+\s+stars$/i.test(text) ||
    /^\d+\s+(day|days|month|months|year|years)\s+ago$/i.test(text)
  ) {
    return false;
  }

  return true;
}

function getMetaContent(
  html: string,
  attrName: "name" | "property",
  attrValue: string,
): string | undefined {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];

    const currentAttrValue = getHtmlAttribute(tag, attrName);
    if (
      !currentAttrValue ||
      currentAttrValue.toLowerCase() !== attrValue.toLowerCase()
    ) {
      continue;
    }

    const content = getHtmlAttribute(tag, "content");
    if (!content) {
      continue;
    }

    return cleanText(content);
  }

  return undefined;
}

function getHtmlAttribute(tag: string, attr: string): string | undefined {
  const escapedAttr = attr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const regex = new RegExp(
    `\\b${escapedAttr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );

  const match = tag.match(regex);

  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function cleanText(value: string): string {
  return decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _;
    })
    .replace(/&#(\d+);/g, (_, decimal: string) => {
      const codePoint = Number.parseInt(decimal, 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _;
    })
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
