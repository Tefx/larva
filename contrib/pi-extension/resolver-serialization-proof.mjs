// Exercises exported Pi 0.85.1 API serializers. onPayload is the supported
// pre-transport seam; deliberately stop there after observing Larva's hook.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function targetSystemText(api, payload) {
  if (api === "openai-codex-responses") return payload.instructions;
  if (api === "pi-messages") return payload.context.systemPrompt;
  if (api.startsWith("google-")) return payload.config.systemInstruction;
  if (api === "anthropic-messages" || api === "bedrock-converse-stream") {
    return typeof payload.system === "string" ? payload.system : payload.system.findLast(b => b.text && !b.text.startsWith("You are Claude Code,"))?.text;
  }
  const first = (payload.messages ?? payload.input)[0];
  return typeof first.content === "string" ? first.content : first.content.find(p => typeof p.text === "string")?.text;
}

export async function proveSerializers(runtime, piRoot, prompt) {
  const apiRoot = join(piRoot, "node_modules/@earendil-works/pi-ai/dist/api");
  const apis = ["openai-completions", "mistral-conversations", "openai-responses", "azure-openai-responses", "openai-codex-responses", "anthropic-messages", "bedrock-converse-stream", "google-generative-ai", "google-vertex", "pi-messages"];
  for (const api of apis) {
    const adapter = await import(pathToFileURL(join(apiRoot, `${api}.js`)).href);
    const model = { id: "proof-model", name: "proof-model", api, provider: "loopback", baseUrl: "http://127.0.0.1:1/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 256 };
    const context = { systemPrompt: prompt, messages: [{ role: "user", content: "foreign user content", timestamp: 1 }], tools: [{ name: "proof_tool", description: "tool preserved", parameters: { type: "object", properties: { value: { type: "string" } } } }] };
    const originalContext = structuredClone(context);
    let observed = 0;
    let assertionError;
    const key = api === "openai-codex-responses" ? `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64")}.test` : "loopback-only";
    const result = await adapter.stream(model, context, {
      apiKey: key, region: "us-east-1", env: { AWS_BEDROCK_SKIP_AUTH: "1", AWS_EC2_METADATA_DISABLED: "true" },
      maxTokens: 128, temperature: 0.2, cacheRetention: "short",
      onPayload: async payload => {
        observed++;
        try {
          const before = structuredClone(payload);
          assert.equal(targetSystemText(api, payload), prompt, `${api}: real serialized target`);
          assert.equal(runtime.mod.projectLarvaIdentityIntoProviderPayload(payload, runtime.mod.getActiveEnvelope(), api).status, "unchanged", api);
          const replacement = await runtime.handlers.before_provider_request({ payload }, { model, abort: () => { throw new Error("unexpected cancellation"); } });
          assert.equal(replacement, undefined, `${api}: hook must not replace payload`);
          assert.deepEqual(payload, before, `${api}: all fields/cache/tools/messages immutable`);
          assert.ok(JSON.stringify(payload).includes("foreign user content"), `${api}: serializer retains user input`);
          assert.ok(JSON.stringify(payload).includes("proof_tool"), `${api}: serializer retains tools`);
        } catch (error) { assertionError = error; }
        throw new Error("SERIALIZATION_OBSERVED_STOP_BEFORE_TRANSPORT");
      },
    }).result();
    if (assertionError) throw assertionError;
    assert.equal(observed, 1, `${api}: serializer seam not reached: ${result.errorMessage}`);
    assert.match(result.errorMessage, /SERIALIZATION_OBSERVED_STOP_BEFORE_TRANSPORT/);
    assert.deepEqual(context, originalContext, `${api}: original Context remains immutable`);
  }
}
