/** Runs one dream agent as a nested, in-memory pi session with only the tools it's handed. */
import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  type ExtensionContext,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentRunner } from "./runner.ts";

const loaderWith = (system: string): ResourceLoader => ({
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => system,
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
});

/** "" is the session's model; otherwise `provider/model-id` (the id may contain slashes). */
export function resolveModel(spec: string, ctx: Pick<ExtensionContext, "model" | "modelRegistry">): Model<any> {
  if (!spec) {
    if (!ctx.model) throw new Error("no model selected; choose one in pi or set dream.model in the root schema");
    return ctx.model;
  }
  const slash = spec.indexOf("/");
  if (slash <= 0) throw new Error(`dream model \`${spec}\` must be provider/model-id`);
  const provider = spec.slice(0, slash);
  const id = spec.slice(slash + 1);
  const found = ctx.modelRegistry.find(provider, id);
  if (found) return found;
  // Like `pi --model`: an id missing from the catalog still works on a provider already in use.
  if (ctx.model?.provider === provider) return { ...ctx.model, id, name: id };
  throw new Error(`dream model \`${spec}\` was not found`);
}

export function sdkAgent(ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "cwd">, sessionThinking: string): AgentRunner {
  return async ({ system, prompt, tools, model, thinking, signal }) => {
    const { session } = await createAgentSession({
      cwd: ctx.cwd,
      model: resolveModel(model, ctx),
      thinkingLevel: (thinking || sessionThinking) as never,
      noTools: "builtin",
      customTools: tools,
      resourceLoader: loaderWith(system),
      sessionManager: SessionManager.inMemory(ctx.cwd),
      settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2 } }),
    });
    const abort = () => void session.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await session.prompt(prompt);
      const stats = session.getSessionStats();
      return { text: session.getLastAssistantText() ?? "", cost: stats.cost, tokens: stats.tokens.total };
    } finally {
      signal?.removeEventListener("abort", abort);
      session.dispose();
    }
  };
}
